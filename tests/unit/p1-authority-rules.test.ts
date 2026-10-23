import { describe, it, expect } from 'vitest';
import {
  authorityFrom, mayApproveValue, readAuthorityLimits, readEscalationWaits, readPriceCheck, rolesTouched, escalationDue,
  priceChangeSize, limitedSubjectOf, DECIDED_AUTHORITY_LIMITS, DECIDED_ESCALATION_WAITS, DECIDED_PRICE_CHECK,
} from '../../packages/approvals/src/authority-rules';
import { ruleInForce } from '../../services/identity/src/authority-limits';
import { sweepAgedApprovals, type ApprovalEscalation, type PendingApproval } from '../../services/identity/src/approval-escalation';
import { AccessControl } from '../../packages/rbac/src/rbac';
import { departmentOfCategory, categoriesOwnedElsewhere, withinDepartmentScope } from '../../packages/org/src/departments';
import { reviewAccess, permissionMatrixCsv } from '../../packages/identity/src/access-review';
import { isStructuralChange } from '../../services/platform/src/org-structure';
import { isHighImpactFlag, flagHistory, HIGH_IMPACT_SETTINGS } from '../../services/platform/src/governed-config';
import type { ConfigVersionRecord } from '../../packages/persistence/src/config-store';

/**
 * **The owner's approval rules, as pure rules (OB-290 · OB-291 · OB-292 · M02-FR-02/03 · M01-FR-01/03 · §28).**
 * The money ladder he decided, the most generous role wins, "not set" approves nothing; the waits per kind; the price-check
 * size (strictly MORE than 10% or ₹50); department scope from the grants; the access review's flags.
 */

const v = (version: number, value: unknown): ConfigVersionRecord => ({ tenantId: 't', key: 'k', version, value, author: 'u-acc', reason: 'r', effectiveAt: '2026-10-23T00:00:00.000Z', rolledBackFrom: null });

describe('money limits (OB-290)', () => {
  const of = (roleIds: string[], subjectType: string) => authorityFrom({ limits: DECIDED_AUTHORITY_LIMITS, rulesVersion: 0, userId: 'u', roleIds, subjectType });

  it('is the owner\'s ladder: cashier ₹0; store manager ₹5,000 refund / ₹25,000 PO / ₹2,000 adjustment; owner unlimited', () => {
    expect(of(['cashier'], 'refund')).toMatchObject({ state: 'limit', limitMinor: 0 });
    expect(of(['store_manager'], 'refund')).toMatchObject({ state: 'limit', limitMinor: 500_000, fromRole: 'store_manager' });
    expect(of(['store_manager'], 'purchase_order')).toMatchObject({ state: 'limit', limitMinor: 2_500_000 });
    expect(of(['store_manager'], 'stock_adjustment')).toMatchObject({ state: 'limit', limitMinor: 200_000 });
    expect(of(['owner'], 'purchase_order')).toMatchObject({ state: 'unlimited', limitMinor: null });
  });

  it('maps every kind that moves the same money onto its limit, and leaves the rest unlimited by amount', () => {
    expect(['order_refund', 'exchange_refund', 'no_receipt_return', 'tender_exception'].map(limitedSubjectOf)).toEqual(['refund', 'refund', 'refund', 'refund']);
    expect(['stock_write_off', 'stock_adjustment_up', 'stock_count', 'write_off'].map(limitedSubjectOf)).toEqual(Array(4).fill('stock_adjustment'));
    expect(of(['store_manager'], 'price_change')).toMatchObject({ state: 'not_value_limited' });
  });

  it('the most generous of a person\'s roles counts; a role with no figure is "not set" and approves no money', () => {
    expect(of(['cashier', 'store_manager'], 'refund').limitMinor).toBe(500_000);
    expect(of(['store_manager', 'owner'], 'refund').state).toBe('unlimited');
    const acc = of(['accountant'], 'refund');
    expect(acc.state).toBe('not_set');
    expect(mayApproveValue(acc, 1)).toBe(false);
    expect(mayApproveValue(acc, null)).toBe(true);
  });

  it('a limit allows up to and including its figure, never a paisa more', () => {
    const m = of(['store_manager'], 'stock_adjustment');
    expect(mayApproveValue(m, 200_000)).toBe(true);
    expect(mayApproveValue(m, 200_001)).toBe(false);
    expect(mayApproveValue(of(['cashier'], 'refund'), 1)).toBe(false);
  });

  it('reads a limits table strictly: unknown roles and kinds, fractions and an owner figure are refused', () => {
    expect(readAuthorityLimits(DECIDED_AUTHORITY_LIMITS, ['cashier', 'store_manager', 'owner']).ok).toBe(true);
    expect(readAuthorityLimits({ byRole: { ghost: { refund: 1 } } }, ['owner']).ok).toBe(false);
    expect(readAuthorityLimits({ byRole: { cashier: { tip: 1 } } }).ok).toBe(false);
    expect(readAuthorityLimits({ byRole: { cashier: { refund: 1.5 } } }).ok).toBe(false);
    expect(readAuthorityLimits({ byRole: { cashier: { refund: -1 } } }).ok).toBe(false);
    expect(readAuthorityLimits({ byRole: { owner: { refund: 100 } } }).ok).toBe(false);
  });

  it('names the roles a change touches (§28: nobody changes their own limits)', () => {
    const after = { byRole: { ...DECIDED_AUTHORITY_LIMITS.byRole, store_manager: { ...DECIDED_AUTHORITY_LIMITS.byRole['store_manager'], stock_adjustment: 300_000 } } };
    expect(rolesTouched(DECIDED_AUTHORITY_LIMITS, after)).toEqual(['store_manager']);
    expect(rolesTouched(DECIDED_AUTHORITY_LIMITS, DECIDED_AUTHORITY_LIMITS)).toEqual([]);
    expect(rolesTouched(DECIDED_AUTHORITY_LIMITS, { byRole: { ...DECIDED_AUTHORITY_LIMITS.byRole, accountant: { refund: 0 } } })).toEqual(['accountant']);
  });

  it('a rule in force is the newest version that reads as valid — an unreadable one holds at the last known good, and says so', () => {
    expect(ruleInForce('limits', [])).toMatchObject({ version: 0, source: 'owner_decision_23_oct_2026', value: DECIDED_AUTHORITY_LIMITS });
    const good = { byRole: { store_manager: { refund: 100 } } };
    const held = ruleInForce('limits', [v(1, good), v(2, { byRole: { store_manager: { refund: 'lots' } } })]);
    expect(held).toMatchObject({ version: 1, value: good, heldAtLastKnownGood: { unreadableVersion: 2 } });
    expect(ruleInForce('escalation-waits', [v(1, { refund: 0, purchase_order: 1, stock_adjustment: 1 })])).toMatchObject({ version: 0, heldAtLastKnownGood: { unreadableVersion: 1 } });
  });
});

describe('escalation by age (OB-292)', () => {
  it('is the owner\'s waits — refund 1 hour, PO 24 hours, adjustment 48 hours — each between a minute and 30 days', () => {
    expect(DECIDED_ESCALATION_WAITS).toEqual({ refund: 60, purchase_order: 1_440, stock_adjustment: 2_880 });
    expect(readEscalationWaits({ refund: 30, purchase_order: 60, stock_adjustment: 90 }).ok).toBe(true);
    expect(readEscalationWaits({ refund: 0, purchase_order: 60, stock_adjustment: 90 }).ok).toBe(false);
    expect(readEscalationWaits({ refund: 30, purchase_order: 60 }).ok).toBe(false);
    expect(readEscalationWaits({ refund: 30, purchase_order: 60, stock_adjustment: 90, tip: 1 }).ok).toBe(false);
  });

  it('is due at exactly the wait, judged on the injected clock', () => {
    const asked = '2026-10-23T08:00:00.000Z';
    expect(escalationDue({ requestedAt: asked, waitMinutes: 60, now: '2026-10-23T08:59:59.000Z' }).due).toBe(false);
    expect(escalationDue({ requestedAt: asked, waitMinutes: 60, now: '2026-10-23T09:00:00.000Z' })).toMatchObject({ due: true, waitedMinutes: 60, dueAt: '2026-10-23T09:00:00.000Z' });
  });

  it('escalates each aged approval once, to the owner, and says when there is no owner to tell', async () => {
    const recorded: ApprovalEscalation[] = [];
    let told = 0;
    const pending: PendingApproval[] = [
      { requestId: 'r1', source: 'approval_engine', kind: 'order_refund', limitedAs: 'refund', requestedAt: '2026-10-23T08:00:00.000Z', requestedBy: 'u-desk', valueMinor: 80_000, summary: 'refund' },
      { requestId: 'p1', source: 'purchase_order', kind: 'purchase_order', limitedAs: 'purchase_order', requestedAt: '2026-10-23T08:00:00.000Z', requestedBy: 'u-buy', valueMinor: 9_000_000, summary: 'PO' },
    ];
    const deps = {
      pending: async () => pending, waits: async () => ({ value: DECIDED_ESCALATION_WAITS, version: 0 }),
      escalations: async () => recorded, recordEscalation: async (_t: string, e: ApprovalEscalation) => { if (recorded.some((r) => r.requestId === e.requestId)) return false; recorded.push(e); return true; },
      tellOwners: async () => { told += 1; return told > 1; },
    };
    const first = await sweepAgedApprovals(deps, 't', '2026-10-23T09:30:00.000Z');
    expect(first.escalated.map((e) => e.requestId)).toEqual(['r1']); // the refund is past 1 hour; the PO is not past 24
    expect(first.escalated[0]).toMatchObject({ escalatedTo: 'owner', waitMinutes: 60, waitedMinutes: 90, rulesVersion: 0 });
    expect(first.noOwnerToTell).toBe(1);
    expect((await sweepAgedApprovals(deps, 't', '2026-10-23T10:00:00.000Z')).escalated).toEqual([]); // once
    expect((await sweepAgedApprovals(deps, 't', '2026-10-24T08:00:00.000Z')).escalated.map((e) => e.requestId)).toEqual(['p1']);
  });
});

describe('the price-check size (OB-291)', () => {
  it('is more than 10% OR more than ₹50 a unit — exactly either is still one person', () => {
    expect(DECIDED_PRICE_CHECK).toEqual({ percentBps: 1_000, amountMinor: 5_000 });
    expect(priceChangeSize(10_000, 11_000, DECIDED_PRICE_CHECK).needsSecondPerson).toBe(false); // exactly 10%
    expect(priceChangeSize(10_000, 11_001, DECIDED_PRICE_CHECK)).toMatchObject({ needsSecondPerson: true, because: ['percent'] });
    expect(priceChangeSize(100_000, 105_000, DECIDED_PRICE_CHECK).needsSecondPerson).toBe(false); // exactly ₹50 (5%)
    expect(priceChangeSize(100_000, 105_001, DECIDED_PRICE_CHECK)).toMatchObject({ needsSecondPerson: true, because: ['amount'] });
    expect(priceChangeSize(100_000, 80_000, DECIDED_PRICE_CHECK)).toMatchObject({ needsSecondPerson: true, because: ['percent', 'amount'], changeMinor: 20_000, changeBps: 2_000 });
  });

  it('reads the thresholds strictly', () => {
    expect(readPriceCheck({ percentBps: 500, amountMinor: 2_000 }).ok).toBe(true);
    expect(readPriceCheck({ percentBps: 0, amountMinor: 2_000 }).ok).toBe(false);
    expect(readPriceCheck({ percentBps: 500, amountMinor: 0 }).ok).toBe(false);
    expect(readPriceCheck({ percentBps: 500 }).ok).toBe(false);
  });
});

describe('department scope (M02-FR-02 · §28 Department Manager)', () => {
  const roles = [{ id: 'store_manager', name: 'Store manager', permissions: ['inventory.adjustment.approve'] }, { id: 'cashier', name: 'Cashier', permissions: ['pos.sale.create'] }];

  it('is the union of the grants carrying the permission; an unlimited grant reaches every department', () => {
    const ac = new AccessControl(roles, [{ userId: 'u-dm', roleId: 'store_manager', branchScope: 'all', departmentScope: ['dairy'] }]);
    expect(ac.departmentScopeOf('u-dm', 'inventory.adjustment.approve')).toEqual(['dairy']);
    expect(ac.departmentScopeOf('u-dm', 'pos.sale.create')).toEqual([]);
    const wide = new AccessControl(roles, [{ userId: 'u-m', roleId: 'store_manager', branchScope: 'all' }]);
    expect(wide.departmentScopeOf('u-m', 'inventory.adjustment.approve')).toBe('all');
  });

  it('a scope widened after the controller was built does not widen the grant', () => {
    const scope = ['dairy'];
    const ac = new AccessControl(roles, [{ userId: 'u-dm', roleId: 'store_manager', branchScope: 'all', departmentScope: scope }]);
    scope.push('liquor');
    expect(ac.departmentScopeOf('u-dm', 'inventory.adjustment.approve')).toEqual(['dairy']);
  });

  it('a category belongs to the department of its nearest owned ancestor; a category owns one department at most', () => {
    const links = [{ departmentId: 'dairy', categoryIds: ['milk'] }, { departmentId: 'grocery', categoryIds: ['staples'] }];
    const parent = new Map<string, string | null>([['milk', null], ['curd', 'milk'], ['staples', null], ['rice', 'staples'], ['toys', null]]);
    const of = (c: string) => departmentOfCategory(links, (x) => parent.get(x) ?? null, c);
    expect([of('curd'), of('rice'), of('toys')]).toEqual(['dairy', 'grocery', undefined]);
    expect(categoriesOwnedElsewhere(links, 'dairy', ['milk', 'staples'])).toEqual([{ categoryId: 'staples', ownedBy: 'grocery' }]);
    expect(withinDepartmentScope(['dairy'], undefined)).toBe(false);
    expect(withinDepartmentScope('all', undefined)).toBe(true);
  });
});

describe('the access review and the permission matrix (M02-FR-01/02)', () => {
  const roles = [
    { id: 'owner', name: 'Owner', permissions: ['identity.role.grant', 'pos.sale.create'] },
    { id: 'cashier', name: 'Cashier', permissions: ['pos.sale.create'] },
    { id: 'platform_admin', name: 'IT', permissions: ['platform.setup.write'] },
    { id: 'store_computer', name: 'Box', permissions: ['pos.sale.sync'] },
  ];
  it('flags the rows that need a second look — and never prints a blank for the last sign-in', () => {
    const rows = reviewAccess({
      people: [
        { userId: 'u-owner', username: 'owner', displayName: 'Owner', state: 'issued', secondFactor: false },
        { userId: 'u-left', username: 'left', displayName: 'Leaver', state: 'ended', secondFactor: false },
      ],
      grants: [
        { userId: 'u-owner', roleId: 'owner', branchScope: 'all' }, { userId: 'u-left', roleId: 'cashier', branchScope: ['b1'] },
        { userId: 'u-ghost', roleId: 'cashier', branchScope: ['b1'] }, { userId: 'box-1', roleId: 'store_computer', branchScope: ['b1'] },
        { userId: 'u-both', roleId: 'platform_admin', branchScope: 'all' }, { userId: 'u-both', roleId: 'cashier', branchScope: 'all', departmentScope: ['dairy'] },
      ],
      emergency: [{ userId: 'u-left', roleId: 'cashier', expiresAt: '2026-10-24T00:00:00.000Z', approvedBy: 'u-owner' }],
      roles, machineRoleIds: ['store_computer'], isItRole: (r) => r === 'platform_admin',
    });
    const by = new Map(rows.map((r) => [r.userId, r]));
    expect(by.get('u-owner')!.flags).toEqual(['privileged_without_second_factor']);
    expect(by.get('u-left')!.flags).toEqual(['holds_roles_after_sign_in_ended', 'emergency_access_live']);
    expect(by.get('u-ghost')!.flags).toEqual(['holds_roles_with_no_sign_in']);
    expect(by.get('box-1')).toMatchObject({ machine: true, flags: [] });
    expect(by.get('u-both')!.flags).toContain('it_and_business_roles');
    expect(by.get('u-both')!.roles.find((r) => r.roleId === 'cashier')!.departmentScope).toEqual(['dairy']);
    expect(by.get('u-owner')!.lastSignIn).toEqual({ at: null, keptBy: 'identity_server' });
  });

  it('exports the matrix as a CSV, one row per permission, one column per role', () => {
    expect(permissionMatrixCsv(roles).split('\n')).toEqual([
      'permission,owner,cashier,platform_admin,store_computer',
      'identity.role.grant,yes,,,', 'platform.setup.write,,,yes,', 'pos.sale.create,yes,yes,,', 'pos.sale.sync,,,,yes', '',
    ]);
  });
});

describe('structural and high-impact changes (M01-FR-01/02/03)', () => {
  const draft = { nodeId: 'B1', tenantId: 't', kind: 'branch' as const, name: 'Store 1', parentId: 'C1', status: 'draft' as const };
  it('a draft is free; activating, closing or changing a live node is structural', () => {
    expect(isStructuralChange(undefined, draft)).toBe(false);
    expect(isStructuralChange(draft, { ...draft, name: 'Store One' })).toBe(false);
    expect(isStructuralChange(draft, { ...draft, status: 'active' })).toBe(true);
    const live = { ...draft, status: 'active' as const };
    expect(isStructuralChange(live, { ...live })).toBe(false);
    expect(isStructuralChange(live, { ...live, name: 'Renamed' })).toBe(true);
    expect(isStructuralChange(live, { ...live, status: 'closed' })).toBe(true);
    expect(isStructuralChange(live, { ...live, status: 'draft' })).toBe(true);
  });

  it('payments, pricing and offline-limit switches, and the trading-day cut-off and currency, are high-impact', () => {
    expect(['payments.upi', 'pricing.auto_markdown', 'offline.refund_cap'].every(isHighImpactFlag)).toBe(true);
    expect(isHighImpactFlag('screens.dark_mode')).toBe(false);
    expect(Object.keys(HIGH_IMPACT_SETTINGS).sort()).toEqual(['locale.currency', 'trading_day.cutoff']);
    expect(flagHistory([{ key: 'a', enabled: true, changedBy: 'u', changedAt: 'x' }, { key: 'b', enabled: true, changedBy: 'u', changedAt: 'x' }, { key: 'a', enabled: false, changedBy: 'u', changedAt: 'y' }], 'a').map((c) => [c.version, c.enabled])).toEqual([[1, true], [2, false]]);
  });
});
