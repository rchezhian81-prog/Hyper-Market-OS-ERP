import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { floorPriceMinor, readTillControls, overrideReductionMinor, judgeTillOverride, floorRefusal, type TillControls } from '../../packages/price-guard/src/till-override';
import { checkPrice } from '../../packages/price-guard/src/price-guard';
import { money } from '../../packages/contracts/src/money';
import { authorityFrom, DECIDED_AUTHORITY_LIMITS, readAuthorityLimits, readEscalationWaits, ESCALATING_SUBJECTS, LIMITED_SUBJECTS } from '../../packages/approvals/src/authority-rules';
import { acceptSale, type IncomingSale, type IntakeContext } from '../../services/pos/src/index';
import type { CatalogueProduct } from '../../packages/catalogue/src/catalogue';
import { TillApprovals } from '../../edge/store-edge/src/till-approvals';
import { limitsFromForm, LIMIT_KINDS, KINDS, approvalRulesWords } from '../../apps/web-erp/src/approval-rules-session';

// OB-500 (R7-A · M02-FR-02 value limits · M05-FR-02 "the check also holds offline"): the till's floor price and each
// manager's price-cut limit — the pure rules, the store computer's approval, and head office's re-check.

const CONTROLS: TillControls = {
  floors: { 'p-ghee': 50_000 }, floorsNotKnown: ['p-new'],
  overrideLimits: { 'u-mgr': { state: 'limit', limitMinor: 10_000 }, 'u-owner': { state: 'unlimited', limitMinor: null }, 'u-mgr2': { state: 'not_set', limitMinor: null } },
  limitsVersion: 1, ownerApprovers: ['u-owner'],
};

describe('OB-500 — the floor price is the price guard\'s own margin-floor rule, rounded up', () => {
  it('cost ₹400 at a 20% floor is ₹500; it never goes below the cost; and it agrees with checkPrice at the boundary', () => {
    expect(floorPriceMinor(40_000, 2_000)).toBe(50_000);
    expect(floorPriceMinor(40_000, 0)).toBe(40_000);
    expect(floorPriceMinor(33_333, 1_500)).toBe(39_216); // 33333 / 0.85 = 39215.29… → up
    for (const [cost, bps] of [[40_000, 2_000], [33_333, 1_500], [1, 9_999], [12_345, 777]] as const) {
      const floor = floorPriceMinor(cost, bps);
      const judge = (p: number) => checkPrice({ id: 'x', proposedPrice: money(p, 'INR'), mrp: money(10_000_000, 'INR'), cost: money(cost, 'INR'), marginFloorBps: bps, setBy: 'a' }).verdict;
      expect(judge(floor)).toBe('ok');
      expect(judge(floor - 1)).not.toBe('ok');
    }
    expect(() => floorPriceMinor(-1, 0)).toThrow(RangeError);
    expect(() => floorPriceMinor(100, 10_000)).toThrow(RangeError);
  });

  it('reads the pack section defensively; a section that is not one reads as "not told"', () => {
    expect(readTillControls(undefined)).toBeUndefined();
    expect(readTillControls({ floors: [] })).toBeUndefined();
    expect(readTillControls({ floors: { a: 100, b: -1, c: 'x' }, overrideLimits: { m: { state: 'limit', limitMinor: 5 }, n: { state: 'limit' }, o: { state: 'unlimited' } } }))
      .toEqual({ floors: { a: 100 }, floorsNotKnown: [], overrideLimits: { m: { state: 'limit', limitMinor: 5 }, n: { state: 'not_set', limitMinor: null }, o: { state: 'unlimited', limitMinor: null } }, limitsVersion: 0, ownerApprovers: [] });
  });

  it('what a cut takes off a line is priced as the till prices it (a weighed line rounded down)', () => {
    expect(overrideReductionMinor(64_000, 55_000, 1, 'ea')).toBe(9_000);
    expect(overrideReductionMinor(64_000, 55_000, 3, 'each')).toBe(27_000);
    // 1.234 kg: 1234 × 30000 / 1000 = 37020; × 25001 / 1000 = 30851.234 → 30851
    expect(overrideReductionMinor(30_000, 25_001, 1_234, 'kg')).toBe(37_020 - 30_851);
  });
});

describe('OB-500 — the judgement, in English and Tamil', () => {
  it('below the floor is refused whoever approves; within the manager\'s limit passes; above it, or with no limit set, needs the owner', () => {
    const j = (approverId: string, toUnitMinor: number, reductionMinor: number) => judgeTillOverride({ controls: CONTROLS, productId: 'p-ghee', toUnitMinor, reductionMinor, approverId, approverName: 'Ravi' });
    const below = j('u-owner', 49_999, 14_001);
    expect(below).toMatchObject({ ok: false, refusedBecause: 'below_floor', floorMinor: 50_000 });
    expect(below.ok ? '' : below.words.en).toContain('₹500.00');
    expect(below.ok ? '' : below.words.ta).toContain('குறைந்தபட்ச விலை');
    expect(j('u-mgr', 55_000, 9_000)).toMatchObject({ ok: true, floorMinor: 50_000 });
    expect(j('u-mgr', 54_000, 10_000)).toMatchObject({ ok: true });
    const over = j('u-mgr', 53_999, 10_001);
    expect(over).toMatchObject({ ok: false, refusedBecause: 'above_limit' });
    expect(over.ok ? '' : over.words.en).toMatch(/₹100\.01.*Ravi's limit of ₹100\.00/);
    expect(over.ok ? '' : over.words.ta).toContain('வரம்பை');
    const notSet = j('u-mgr2', 55_000, 9_000);
    expect(notSet).toMatchObject({ ok: false, refusedBecause: 'limit_not_set' });
    expect(notSet.ok ? '' : notSet.words.en).toContain('only the owner');
    // Someone the pack does not name has no limit: the same as "not set".
    expect(j('u-stranger', 55_000, 9_000)).toMatchObject({ ok: false, refusedBecause: 'limit_not_set' });
    expect(j('u-owner', 50_000, 14_000)).toMatchObject({ ok: true });
    // A product with no known floor (never received at a cost): OB-520 (R8-A) — only the owner may approve its cut.
    expect(judgeTillOverride({ controls: CONTROLS, productId: 'p-new', toUnitMinor: 1, reductionMinor: 5_000, approverId: 'u-mgr' })).toMatchObject({ ok: false, refusedBecause: 'floor_not_known_owner_only', floorMinor: null });
    expect(judgeTillOverride({ controls: CONTROLS, productId: 'p-new', toUnitMinor: 1, reductionMinor: 5_000, approverId: 'u-owner' })).toMatchObject({ ok: true, floorMinor: null });
    // A box that was never told the rules approves no cut at all.
    const untold = judgeTillOverride({ controls: undefined, productId: 'p-ghee', toUnitMinor: 60_000, reductionMinor: 1, approverId: 'u-owner' });
    expect(untold).toMatchObject({ ok: false, refusedBecause: 'limits_not_known' });
    expect(untold.ok ? '' : untold.words.ta).toContain('தலைமை அலுவலகம்');
    expect(floorRefusal({ toUnitMinor: 50_000, floorMinor: 50_000 })).toBeUndefined();
    expect(floorRefusal({ toUnitMinor: 1, floorMinor: undefined })).toBeUndefined();
  });
});

describe('OB-500 — the owner\'s money limits carry a price cut at the till, "not set" until he sets one', () => {
  it('the decided ladder gives the owner unlimited and (OB-519) a store manager ₹100; a figure is accepted and read back; waits stay three', () => {
    expect(LIMITED_SUBJECTS).toContain('price_override');
    expect(ESCALATING_SUBJECTS).not.toContain('price_override');
    const of = (roleIds: string[]) => authorityFrom({ limits: DECIDED_AUTHORITY_LIMITS, rulesVersion: 0, userId: 'x', roleIds, subjectType: 'price_override' });
    expect(of(['owner'])).toMatchObject({ state: 'unlimited', limitedAs: 'price_override' });
    // OB-519 (R8-A): the store manager's figure is ₹100 a line.
    expect(of(['store_manager'])).toMatchObject({ state: 'limit', limitMinor: 10_000 });
    expect(of(['cashier'])).toMatchObject({ state: 'not_set' });
    const set = readAuthorityLimits({ byRole: { ...DECIDED_AUTHORITY_LIMITS.byRole, store_manager: { ...DECIDED_AUTHORITY_LIMITS.byRole['store_manager'], price_override: 10_000 } } });
    expect(set.ok).toBe(true);
    expect(authorityFrom({ limits: set.ok ? set.value : DECIDED_AUTHORITY_LIMITS, rulesVersion: 1, userId: 'x', roleIds: ['store_manager'], subjectType: 'price_override' })).toMatchObject({ state: 'limit', limitMinor: 10_000 });
    // The owner's row stays unlimited for a price cut too.
    expect(readAuthorityLimits({ byRole: { owner: { price_override: 5 } } }).ok).toBe(false);
    // A till price cut never waits in an inbox, so it has no escalation wait (and a stored wait for one is not a wait).
    expect(readEscalationWaits({ refund: 60, purchase_order: 60, stock_adjustment: 60 }).ok).toBe(true);
    expect(readEscalationWaits({ refund: 60, purchase_order: 60, stock_adjustment: 60, price_override: 5 }).ok).toBe(false);
  });

  it('the Approval rules page offers the price-cut column in English and Tamil, and reads a figure typed into it', () => {
    expect(LIMIT_KINDS).toEqual([...KINDS, 'price_override']);
    expect(approvalRulesWords('en', 'k_price_override')).toBe('Price cut at the till');
    expect(approvalRulesWords('ta', 'k_price_override')).toBe('கல்லாவில் விலைக் குறைப்பு');
    const v = limitsFromForm({ byRole: { store_manager: { refund: 500_000 } } }, { store_manager: { price_override: '100' } });
    expect(v).toEqual({ byRole: { store_manager: { refund: 500_000, price_override: 10_000 } } });
  });
});

describe('OB-500 — the store computer\'s approval holds the floor and the limit, offline', () => {
  const people: Record<string, { pin: string; name: string }> = { 'u-mgr': { pin: '111111', name: 'Ravi' }, 'u-mgr2': { pin: '222222', name: 'Selvi' }, 'u-owner': { pin: '333333', name: 'Owner' } };
  const open = async (controls: unknown) => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-r7a-approvals-'));
    let pinsLookedAt = 0;
    const approvals = await TillApprovals.open({
      dataDir: dir, capacityBytes: 1_000_000, approvalThresholdMinor: () => 0, tillControls: () => controls, now: () => '2026-10-28T10:00:00.000Z',
      operators: {
        check: () => ({ ok: true, userId: 'u-cash', via: 'pin' }) as never,
        verifyPerson: async ({ staffId, pin }) => {
          pinsLookedAt += 1;
          const p = people[staffId];
          return p !== undefined && p.pin === pin ? { ok: true, userId: staffId, displayName: p.name } : { ok: false, refusedBecause: 'wrong_pin' as never, laneMessage: 'Wrong PIN.' };
        },
      },
    });
    return { approvals, dir, pinsLooked: () => pinsLookedAt };
  };
  const ask = (managerId: string, toUnitMinor: number | undefined, valueMinor: number) => ({
    token: 't', laneId: 'lane-1', managerId, pin: people[managerId]?.pin ?? '', kind: 'price_override', billRef: 'B-1', valueMinor, reason: 'damaged_pack',
    // OB-500: the line, its first price, its quantity and unit — the box works the cut out itself.
    ...(toUnitMinor === undefined ? {} : { productId: 'p-ghee', toUnitMinor, lineId: 'L1', fromUnitMinor: 64_000, quantityMinor: 1, uom: 'each' }),
  });

  it('refuses below the floor before any PIN is looked at; above the limit after; with no rules at all; and binds the approval to the product and price', async () => {
    const { approvals, dir, pinsLooked } = await open(CONTROLS);
    try {
      expect(await approvals.grant(ask('u-mgr', 45_000, 19_000))).toMatchObject({ approved: false, refusedBecause: 'below_floor' });
      expect(pinsLooked()).toBe(0);
      const over = await approvals.grant(ask('u-mgr', 52_000, 12_000));
      expect(over).toMatchObject({ approved: false, refusedBecause: 'above_limit' });
      expect((over as { laneMessageTa?: string }).laneMessageTa).toContain('Ravi');
      expect(await approvals.grant(ask('u-mgr2', 55_000, 9_000))).toMatchObject({ approved: false, refusedBecause: 'limit_not_set' });
      expect(await approvals.grant(ask('u-mgr', undefined, 9_000))).toMatchObject({ approved: false, refusedBecause: 'approval_not_readable' });
      const fine = await approvals.grant(ask('u-mgr', 55_000, 9_000));
      expect(fine).toMatchObject({ approved: true, approvedBy: 'u-mgr' });
      const id = (fine as { approvalId: string }).approvalId;
      const spend = (productId: string, toUnitMinor: number, activityId: string) => approvals.spendOverride({ approvalId: id, kind: 'price_override', billRef: 'B-1', valueMinor: 9_000, requestedBy: 'u-cash', laneId: 'lane-1', activityId, productId, toUnitMinor, lineId: 'L1', fromUnitMinor: 64_000, quantityMinor: 1 });
      expect(await spend('p-other', 55_000, 'O-1')).toMatchObject({ ok: false, refusedBecause: 'approval_does_not_match' });
      expect(await spend('p-ghee', 54_000, 'O-1')).toMatchObject({ ok: false, refusedBecause: 'approval_does_not_match' });
      expect(await spend('p-ghee', 55_000, 'O-1')).toMatchObject({ ok: true });
      expect(await approvals.grant(ask('u-owner', 50_000, 14_000))).toMatchObject({ approved: true });
    } finally { await rm(dir, { recursive: true, force: true }); }
    const untold = await open(undefined);
    try {
      expect(await untold.approvals.grant(ask('u-owner', 60_000, 4_000))).toMatchObject({ approved: false, refusedBecause: 'limits_not_known' });
      // A no-sale is not a price cut: unchanged.
      expect(await untold.approvals.grant({ ...ask('u-mgr', undefined, 0), kind: 'no_sale' })).toMatchObject({ approved: true });
    } finally { await rm(untold.dir, { recursive: true, force: true }); }
  });

  it('a restart keeps the binding: an approval read back from the disk still names its product and price', async () => {
    const first = await open(CONTROLS);
    try {
      const fine = await first.approvals.grant(ask('u-mgr', 55_000, 9_000));
      const again = await TillApprovals.open({ dataDir: first.dir, capacityBytes: 1_000_000, approvalThresholdMinor: () => 0, tillControls: () => CONTROLS, now: () => '2026-10-28T10:01:00.000Z', operators: { check: () => ({ ok: true }) as never, verifyPerson: async () => ({ ok: false, refusedBecause: 'wrong_pin' as never, laneMessage: '' }) } });
      expect(await again.spendOverride({ approvalId: (fine as { approvalId: string }).approvalId, kind: 'price_override', billRef: 'B-1', valueMinor: 9_000, requestedBy: 'u-cash', laneId: 'lane-1', activityId: 'O-9', productId: 'p-ghee', toUnitMinor: 50_000, lineId: 'L1', fromUnitMinor: 64_000, quantityMinor: 1 }))
        .toMatchObject({ ok: false, refusedBecause: 'approval_does_not_match' });
    } finally { await rm(first.dir, { recursive: true, force: true }); }
  });
});

describe('OB-500 — head office re-checks every lowered line (the sale stands)', () => {
  const CATALOGUE = new Map<string, CatalogueProduct>([['p-ghee', { productId: 'p-ghee', sku: 'GHEE', name: 'Ghee', baseUom: 'each', unitPriceMinor: 64_000, taxBps: 1200, mrpMinor: 64_000, status: 'active' }]]);
  const sale = (unitPriceMinor: number, approvedBy = 'u-mgr', quantityMinor = 1): IncomingSale => ({
    saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-cash', tradingDay: '2026-10-28', committedAt: '2026-10-28T10:00:00Z',
    totalMinor: unitPriceMinor * quantityMinor, currency: 'INR', packVersion: 3, tenders: [{ kind: 'cash', amountMinor: unitPriceMinor * quantityMinor }],
    lines: [{ productId: 'p-ghee', quantityMinor, uom: 'each', unitPriceMinor, lineTotalMinor: unitPriceMinor * quantityMinor, priceOverride: { fromUnitPriceMinor: 64_000, approvedBy, activityId: 'O-1' } }],
  });
  const ctx = (over: Partial<IntakeContext> = {}): IntakeContext => ({
    catalogue: CATALOGUE, currentPackVersion: 3, saleHoldingThisReceipt: undefined, alreadyBanked: false, now: '2026-10-28T12:00:00Z',
    tillOverrideRules: { floors: new Map([['p-ghee', 50_000]]), limits: new Map([['u-mgr', { state: 'limit', limitMinor: 10_000 }], ['u-owner', { state: 'unlimited', limitMinor: null }]]) },
    ...over,
  });
  const cuts = (r: ReturnType<typeof acceptSale>) => r.exceptions.filter((e) => e.kind.startsWith('price_cut')).map((e) => [e.kind, e.severity, e.differenceMinor]);

  it('below the floor and above the approver\'s limit are each raised, valued; within both, nothing; never re-check means no finding', () => {
    const r = acceptSale(sale(48_000), ctx());
    expect(r.banked).toBe(true);
    expect(cuts(r)).toEqual([['price_cut_above_approver_limit', 'material', 6_000], ['price_cut_below_floor', 'material', -2_000]]);
    expect(cuts(acceptSale(sale(55_000), ctx()))).toEqual([]);
    // The cut is what came off the WHOLE line: 3 × ₹40 = ₹120 is over ₹100.
    expect(cuts(acceptSale(sale(60_000, 'u-mgr', 3), ctx()))).toEqual([['price_cut_above_approver_limit', 'material', 2_000]]);
    expect(cuts(acceptSale(sale(50_000, 'u-owner'), ctx()))).toEqual([]);
    // An approver head office holds no limit for: "not set" → only the owner may approve.
    const unknown = acceptSale(sale(60_000, 'u-someone'), ctx());
    expect(cuts(unknown)).toEqual([['price_cut_above_approver_limit', 'material', 4_000]]);
    expect(unknown.exceptions.find((e) => e.kind === 'price_cut_above_approver_limit')!.detail).toContain('not set');
    expect(cuts(acceptSale(sale(48_000), ctx({ tillOverrideRules: undefined })))).toEqual([]);
  });
});
