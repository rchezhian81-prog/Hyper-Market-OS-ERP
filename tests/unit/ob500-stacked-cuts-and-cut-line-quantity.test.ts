import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { money } from '../../packages/contracts/src/money';
import { rate } from '../../packages/contracts/src/rate';
import { PosSession, CutLineQuantityRefusedError } from '../../apps/pos/src/session';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/ledger';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { TillApprovals } from '../../edge/store-edge/src/till-approvals';
import type { TillControls } from '../../packages/price-guard/src/till-override';

// OB-500 (owner decision): "the till AND the store computer refuse a cut beyond either [the floor or the manager's limit],
// even offline". Three holes this closes:
//   1 · a second cut on a line was measured from the price ALREADY cut, so two ₹90 cuts each passed a ₹100 limit (₹180 off);
//   2 · a line's quantity could change after an approved cut, so ₹90 off one became ₹900 off ten with no new approval;
//   3 · the store computer took the cut's amount as the till said it, instead of working it out itself.

const session = (): PosSession => new PosSession(
  { laneId: 'lane-1', cashierId: 'u-cash', currency: 'INR', defaultTaxRate: rate(0) },
  new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
  async () => ({ committed: true, durable: true, detail: 'double', laneMessage: 'Sale complete.' }),
);
const ghee = { productId: 'p-ghee', description: 'Ghee 1L', unitPrice: money(64_000, 'INR'), quantityMinor: 1, uom: 'ea' as const };
const evidence = { approvedBy: 'u-mgr', activityId: 'O-1' };

describe('OB-500 — the till measures every cut on a line from the line\'s FIRST price', () => {
  it('a second cut is valued as everything taken off the line (₹640 → ₹550 → ₹460 is ₹180, not ₹90)', () => {
    const s = session();
    const line = s.scan(ghee).lineId;
    expect(s.overrideValue(line, 55_000)).toEqual({ fromUnitMinor: 64_000, reductionMinor: 9_000 });
    s.overridePrice(line, 55_000, evidence);
    // The second step alone is ₹90 — but the line has lost ₹180 from its first price, and that is what a manager approves.
    expect(s.overrideValue(line, 46_000)).toEqual({ fromUnitMinor: 64_000, reductionMinor: 18_000 });
    s.overridePrice(line, 46_000, { approvedBy: 'u-owner', activityId: 'O-2' });
    expect(s.basket()[0]!.priceOverride).toEqual({ fromUnitMinor: 64_000, approvedBy: 'u-owner', activityId: 'O-2' });
    // A cut still only lowers the price on the bill now.
    expect(() => s.overrideValue(line, 50_000)).toThrow(RangeError);
  });

  it('the till asks the store computer for the whole cut, with the line, its first price, quantity and unit', async () => {
    const asked: Record<string, unknown>[] = [];
    const sent: Record<string, unknown>[] = [];
    const till = bootPos({
      laneId: 'lane-1', taxPercent: 0,
      approvalPort: { grant: async (r) => { asked.push({ ...r }); return { approved: true, approvalId: `apr-${asked.length}`, approvedBy: 'u-mgr', displayName: 'Ravi', expiresAt: '2099-01-01T00:00:00Z' }; } },
      tillActivityPost: async (b) => { sent.push(b); return { recorded: true, approvedBy: 'u-mgr' }; },
    });
    till.signIn('u-cash');
    till.scan({ productId: 'p-ghee', description: 'Ghee 1L', unitPriceMinor: 64_000, qty: 1 });
    const line = till.basket()[0]!.lineId;
    const first = till.priceChangeValue(line, 55_000);
    expect(first).toMatchObject({ ok: true, reductionMinor: 9_000, fromUnitMinor: 64_000, lineId: line, quantityMinor: 1, uom: 'ea' });
    expect(await till.priceChangeAtTill(line, 55_000, 'damaged_pack', { approvalId: 'apr-1' })).toMatchObject({ ok: true });
    const second = till.priceChangeValue(line, 46_000);
    expect(second).toMatchObject({ ok: true, reductionMinor: 18_000, fromUnitMinor: 64_000 });
    expect(await till.priceChangeAtTill(line, 46_000, 'damaged_pack', { approvalId: 'apr-2' })).toMatchObject({ ok: true });
    expect(sent.map((b) => [b['fromUnitMinor'], b['toUnitMinor'], b['quantityMinor'], b['uom'], b['valueMinor']])).toEqual([[64_000, 55_000, 1, 'ea', 9_000], [64_000, 46_000, 1, 'ea', 18_000]]);
  });
});

describe('OB-500 — a line whose price a manager cut cannot change quantity', () => {
  it('a new quantity is refused in English and Tamil; the line keeps its quantity; an uncut line still changes', () => {
    const s = session();
    const cut = s.scan(ghee).lineId;
    const plain = s.scan({ ...ghee, productId: 'p-oil', description: 'Oil 1L' }).lineId;
    s.overridePrice(cut, 55_000, evidence);
    let refused: unknown;
    try { s.setQuantity(cut, 10); } catch (e) { refused = e; }
    expect(refused).toBeInstanceOf(CutLineQuantityRefusedError);
    expect((refused as CutLineQuantityRefusedError).laneMessage).toMatch(/Ghee 1L.*cannot be changed.*void the line and ring it again/);
    expect((refused as CutLineQuantityRefusedError).laneMessageTa).toContain('எண்ணிக்கையை மாற்ற முடியாது');
    expect(s.basket().find((l) => l.lineId === cut)!.quantityMinor).toBe(1);
    expect(s.totals().payable.minor).toBe(55_000 + 64_000);
    expect(s.setQuantity(plain, 3).quantityMinor).toBe(3);
  });

  it('the till screen\'s quantity button is refused the same way (through the till view)', () => {
    const till = bootPos({ laneId: 'lane-1', taxPercent: 0, approvalPort: { grant: async () => ({ approved: false, laneMessage: '' }) }, tillActivityPost: async () => ({ recorded: true }) });
    till.signIn('u-cash');
    till.scan({ productId: 'p-ghee', description: 'Ghee 1L', unitPriceMinor: 64_000, qty: 1 });
    const line = till.basket()[0]!.lineId;
    return till.priceChangeAtTill(line, 55_000, 'damaged_pack', { approvalId: 'apr-1' }).then((r) => {
      expect(r).toMatchObject({ ok: true });
      expect(() => till.setQuantity(line, 10)).toThrow(CutLineQuantityRefusedError);
      expect(till.basket()[0]!.qty).toBe(1);
    });
  });

  it('a held cut line comes back as a cut line: quantity still locked, a further cut still measured from the first price', () => {
    const s = session();
    const line = s.scan(ghee).lineId;
    s.overridePrice(line, 55_000, evidence);
    const held = s.basketToHold();
    expect(held.lines[0]!.priceOverride).toEqual({ fromUnitMinor: 64_000, approvedBy: 'u-mgr', activityId: 'O-1' });
    const back = session();
    back.restoreHeld(held.lines, held.ageAnswers);
    const again = back.basket()[0]!;
    expect(again.priceOverride).toEqual({ fromUnitMinor: 64_000, approvedBy: 'u-mgr', activityId: 'O-1' });
    expect(() => back.setQuantity(again.lineId, 10)).toThrow(CutLineQuantityRefusedError);
    expect(back.overrideValue(again.lineId, 46_000)).toEqual({ fromUnitMinor: 64_000, reductionMinor: 18_000 });
  });
});

describe('OB-500 — the store computer works the cut out itself and judges its own figure', () => {
  const CONTROLS: TillControls = {
    floors: { 'p-ghee': 40_000, 'p-dal': 1_000 }, floorsNotKnown: [],
    overrideLimits: { 'u-mgr': { state: 'limit', limitMinor: 10_000 }, 'u-owner': { state: 'unlimited', limitMinor: null } },
    limitsVersion: 1, ownerApprovers: ['u-owner'],
  };
  const pins: Record<string, string> = { 'u-mgr': '111111', 'u-owner': '333333' };
  const open = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-ob500-stack-'));
    const approvals = await TillApprovals.open({
      dataDir: dir, capacityBytes: 1_000_000, approvalThresholdMinor: () => 0, tillControls: () => CONTROLS, now: () => '2026-10-28T10:00:00.000Z',
      // The box's own catalogue: dal is sold by the kilo.
      uomOf: (productId) => (productId === 'p-dal' ? 'kg' : productId === 'p-ghee' ? 'ea' : undefined),
      operators: {
        check: () => ({ ok: true, userId: 'u-cash', via: 'pin' }) as never,
        verifyPerson: async ({ staffId, pin }) => (pins[staffId] === pin ? { ok: true, userId: staffId, displayName: staffId === 'u-mgr' ? 'Ravi' : 'Owner' } : { ok: false, refusedBecause: 'wrong_pin' as never, laneMessage: 'Wrong PIN.' }),
      },
    });
    return { approvals, dir };
  };
  const ask = (over: Record<string, unknown>) => ({
    token: 't', laneId: 'lane-1', managerId: 'u-mgr', pin: pins['u-mgr']!, kind: 'price_override', billRef: 'B-1', reason: 'damaged_pack',
    valueMinor: undefined as unknown, productId: 'p-ghee', lineId: 'L1', fromUnitMinor: 64_000, quantityMinor: 1, uom: 'ea', ...over,
  });

  it('two stacked cuts that together pass the manager\'s ₹100 are refused — whether the till says the whole cut or only the step', async () => {
    const { approvals, dir } = await open();
    try {
      expect(await approvals.grant(ask({ toUnitMinor: 55_000, valueMinor: 9_000 }))).toMatchObject({ approved: true });
      // The honest till says ₹180 off from ₹640: above Ravi's ₹100, in English and Tamil.
      const whole = await approvals.grant(ask({ toUnitMinor: 46_000, valueMinor: 18_000 }));
      expect(whole).toMatchObject({ approved: false, refusedBecause: 'above_limit' });
      expect((whole as { laneMessage: string }).laneMessage).toContain('₹180.00');
      expect((whole as { laneMessageTa?: string }).laneMessageTa).toContain('வரம்பை');
      // A till that measures from the price already cut (₹550 → ₹460, "₹90") is not believed: the line's first price was ₹640.
      const step = await approvals.grant(ask({ toUnitMinor: 46_000, valueMinor: 9_000, fromUnitMinor: 55_000 }));
      expect(step).toMatchObject({ approved: false, refusedBecause: 'cut_does_not_match' });
      expect((step as { laneMessageTa?: string }).laneMessageTa).toContain('பொருந்தவில்லை');
      // The owner has no limit: the whole ₹180 is his to approve.
      expect(await approvals.grant(ask({ managerId: 'u-owner', pin: pins['u-owner'], toUnitMinor: 46_000, valueMinor: 18_000 }))).toMatchObject({ approved: true });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('an understated amount is judged on the box\'s own figure: refused above the limit, and refused when it merely disagrees', async () => {
    const { approvals, dir } = await open();
    try {
      // ₹640 → ₹520 is ₹120 off, whatever the till says ("₹10").
      expect(await approvals.grant(ask({ toUnitMinor: 52_000, valueMinor: 1_000 }))).toMatchObject({ approved: false, refusedBecause: 'above_limit' });
      // ₹90 off each of ten is ₹900 off the line, though the till says ₹90: the box multiplies by the quantity itself.
      expect(await approvals.grant(ask({ lineId: 'L2', toUnitMinor: 55_000, quantityMinor: 10, valueMinor: 9_000 }))).toMatchObject({ approved: false, refusedBecause: 'above_limit' });
      // Within the limit on the box's own figure (₹90) — but the till said ₹80: no approval for a figure the box did not reach.
      expect(await approvals.grant(ask({ toUnitMinor: 55_000, valueMinor: 8_000 }))).toMatchObject({ approved: false, refusedBecause: 'cut_does_not_match' });
      // A weighed line is priced by the box's own catalogue unit (kg), not the unit the till names: 2.5 kg × ₹40 = ₹100.
      expect(await approvals.grant(ask({ productId: 'p-dal', lineId: 'L3', fromUnitMinor: 12_000, toUnitMinor: 8_000, quantityMinor: 2_500, uom: 'ea', valueMinor: 10_000 }))).toMatchObject({ approved: true });
      // Without the line, its first price and quantity, the box cannot work the cut out: not approved.
      expect(await approvals.grant(ask({ toUnitMinor: 55_000, valueMinor: 9_000, fromUnitMinor: undefined }))).toMatchObject({ approved: false, refusedBecause: 'approval_not_readable' });
      expect(await approvals.grant(ask({ toUnitMinor: 55_000, valueMinor: 9_000, quantityMinor: undefined }))).toMatchObject({ approved: false, refusedBecause: 'approval_not_readable' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('an approval is spent only on the line, first price and quantity it was judged on', async () => {
    const { approvals, dir } = await open();
    try {
      const g = await approvals.grant(ask({ toUnitMinor: 55_000, valueMinor: 9_000 }));
      const approvalId = (g as { approvalId: string }).approvalId;
      const spend = (over: Record<string, unknown>) => approvals.spendOverride({
        approvalId, kind: 'price_override', billRef: 'B-1', valueMinor: 9_000, requestedBy: 'u-cash', laneId: 'lane-1', activityId: 'O-1',
        productId: 'p-ghee', toUnitMinor: 55_000, lineId: 'L1', fromUnitMinor: 64_000, quantityMinor: 1, ...over,
      });
      expect(await spend({ quantityMinor: 10 })).toMatchObject({ ok: false, refusedBecause: 'approval_does_not_match' });
      expect(await spend({ fromUnitMinor: 60_000 })).toMatchObject({ ok: false, refusedBecause: 'approval_does_not_match' });
      expect(await spend({ lineId: 'L9' })).toMatchObject({ ok: false, refusedBecause: 'approval_does_not_match' });
      expect(await spend({})).toMatchObject({ ok: true });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
