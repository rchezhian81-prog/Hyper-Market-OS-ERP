import { describe, it, expect } from 'vitest';
import {
  navigationFor,
  canOpen,
  landingPath,
  buildQueue,
  actionableCount,
  submitDecision,
  ReasonRequiredError,
  ERP_NAVIGATION,
} from '../../apps/web-erp/src/index';
import { AccessControl, type Role, type RoleAssignment } from '../../packages/rbac/src/index';
import { requestApproval, type Approver } from '../../packages/approvals/src/index';
import { money } from '../../packages/contracts/src/money';

// The ERP shows each role only its own work (P-07 / P-04) and makes separation of
// duties visible in the approvals queue rather than a surprise at submit (§28).

const ROLES: Role[] = [
  { id: 'cashoffice', name: 'Cash office', permissions: ['erp.dashboard.view', 'cash.view', 'sales.view'] },
  {
    id: 'manager',
    name: 'Store manager',
    permissions: ['erp.dashboard.view', 'approval.decide', 'exception.view', 'stock.view', 'sales.view', 'cash.view'],
  },
  { id: 'admin', name: 'Administrator', permissions: ['admin.users.manage', 'admin.settings.manage', 'audit.view'] },
];

const ASSIGNMENTS: RoleAssignment[] = [
  { userId: 'cash-1', roleId: 'cashoffice', branchScope: ['b1'] },
  { userId: 'mgr-1', roleId: 'manager', branchScope: ['b1'] },
  { userId: 'admin-1', roleId: 'admin', branchScope: 'all' },
];

const access = new AccessControl(ROLES, ASSIGNMENTS);

describe('role-scoped navigation', () => {
  it('shows a role only the sections it holds permissions for', () => {
    const nav = navigationFor(access, { userId: 'cash-1', branchId: 'b1' });
    const labels = nav.flatMap((g) => g.items.map((i) => i.label));
    expect(labels).toEqual(['Dashboard', 'Sales', 'Cash & day close']);
    expect(labels).not.toContain('Users & roles'); // not their job
    expect(labels).not.toContain('Approvals');
  });

  it('gives a manager their wider menu, grouped for the sidebar', () => {
    const nav = navigationFor(access, { userId: 'mgr-1', branchId: 'b1' });
    expect(nav.map((g) => g.group)).toEqual(['Overview', 'Inventory', 'Trading']);
    expect(nav[0]?.items.map((i) => i.id)).toEqual(['dashboard', 'approvals', 'exceptions']);
  });

  it('shows nothing to an unknown user (default-deny)', () => {
    expect(navigationFor(access, { userId: 'nobody', branchId: 'b1' })).toEqual([]);
    expect(landingPath(access, { userId: 'nobody', branchId: 'b1' })).toBeNull();
  });

  it('respects branch scope — the same user sees nothing in another branch', () => {
    expect(navigationFor(access, { userId: 'mgr-1', branchId: 'b2' })).toEqual([]);
    expect(navigationFor(access, { userId: 'admin-1', branchId: 'b2' }).length).toBeGreaterThan(0); // 'all' scope
  });

  it('agrees with the server on what may be opened, and denies unknown paths', () => {
    expect(canOpen(access, { userId: 'cash-1', branchId: 'b1' }, '/cash')).toBe(true);
    expect(canOpen(access, { userId: 'cash-1', branchId: 'b1' }, '/admin/users')).toBe(false);
    expect(canOpen(access, { userId: 'admin-1', branchId: 'b1' }, '/nope')).toBe(false); // never a blank allow
  });

  it('lands each user on their first permitted page', () => {
    expect(landingPath(access, { userId: 'cash-1', branchId: 'b1' })).toBe('/');
    expect(landingPath(access, { userId: 'admin-1', branchId: null })).toBe('/admin/users');
  });

  it('every navigation item declares the permission it needs', () => {
    for (const item of ERP_NAVIGATION) {
      expect(item.requires.length).toBeGreaterThan(0);
    }
  });
});

describe('approvals workbench', () => {
  const approver: Approver = {
    userId: 'mgr-1',
    branchScope: ['b1'],
    authorityLimit: money(10_000_00, 'INR'),
  };

  function req(id: string, over: Partial<Parameters<typeof requestApproval>[0]> = {}) {
    return requestApproval({
      id,
      subjectType: 'stock_adjustment',
      subjectRef: id,
      requestedBy: 'clerk-1',
      branchId: 'b1',
      value: money(1_000_00, 'INR'),
      ...over,
    });
  }

  it('orders the queue by value so the biggest exposure is cleared first', () => {
    const rows = buildQueue(
      [req('small', { value: money(500_00, 'INR') }), req('big', { value: money(9_000_00, 'INR') })],
      approver,
    );
    expect(rows.map((r) => r.request.id)).toEqual(['big', 'small']);
    expect(actionableCount(rows)).toBe(2);
  });

  it("never offers the approver a button on their own request (§28)", () => {
    const rows = buildQueue([req('mine', { requestedBy: 'mgr-1' })], approver);
    expect(rows[0]?.actionable).toBe(false);
    expect(rows[0]?.blockedReason).toBe('own_request');
    expect(rows[0]?.sentence).toContain('your own request');
  });

  it('marks a request above the limit as escalate, rather than a button that fails', () => {
    const rows = buildQueue([req('huge', { value: money(50_000_00, 'INR') })], approver);
    expect(rows[0]?.actionable).toBe(false);
    expect(rows[0]?.blockedReason).toBe('exceeds_authority');
    expect(rows[0]?.sentence).toContain('escalate');
  });

  it('marks an out-of-branch request as out of scope but still shows it', () => {
    const rows = buildQueue([req('other', { branchId: 'b2' })], approver);
    expect(rows[0]?.actionable).toBe(false);
    expect(rows[0]?.blockedReason).toBe('out_of_scope');
    expect(rows).toHaveLength(1); // visible, so they can chase the right person
  });

  it('requires a reason before the engine is even called', () => {
    expect(() => submitDecision(req('a'), approver, 'approved', '   ', '2026-08-02T12:00:00Z')).toThrow(
      ReasonRequiredError,
    );
  });

  it('delegates a valid decision to the approval engine', () => {
    const outcome = submitDecision(req('a'), approver, 'approved', 'variance verified', '2026-08-02T12:00:00Z');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.request.decidedBy).toBe('mgr-1');
      expect(outcome.request.reason).toBe('variance verified');
    }
  });

  it('the engine still refuses a self-approval even if the screen were bypassed', () => {
    const outcome = submitDecision(req('mine', { requestedBy: 'mgr-1' }), approver, 'approved', 'ok', '2026-08-02T12:00:00Z');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal).toBe('self_approval_forbidden');
  });
});
