import { describe, it, expect } from 'vitest';
import { captureReceipt, type CapturedLine } from '../../packages/receiving/src/index';
import {
  costFromOrder, discrepancyOwners, DISCREPANCY_OWNER_ROLE, stillCostNotKnown, bookedUnitCostMinor,
  type GrnRecord, type OrderForReceipt, type ReceiptFlag,
} from '../../services/inventory/src/goods-receipt';
import { weightedAverageValuation } from '../../packages/stock/src/valuation';
import { withLandedCost, type StockCostAdjustment } from '../../services/inventory/src/landed-cost';
import { createGoodsReceiptSession, ownerWords, type GrnRecordView } from '../../apps/web-erp/src/goods-receipt-session';
import { receivedCostWords } from '../../apps/web-erp/src/supplier-scorecard-session';

/**
 * **OB-508 · OB-509 · OB-517 (owner, 28 Oct 2026) — the pure rules.**
 *   • costFromOrder: an issued order's product → the order's cost; no issued order, or a product not on it → cost NOT KNOWN
 *     (placeholder, flagged, the typed figure kept beside — never booked); the relayed paths keep no typed figure;
 *   • the capture engine marks a not-known line's differences "value not known" — never a fake ₹0;
 *   • the valuation brings unvalued units into value when their bill's cost becomes known (still-on-hand into stock, the
 *     rest to cost of goods sold) — once;
 *   • every discrepancy's owner by kind; nobody invented (OB-528, round 8: near expiry and MRP mismatch are the buyer's);
 *   • the review screen and the price-variance page say all of it in English and Tamil.
 */

const inr = (minor: number) => ({ minor, currency: 'INR' as const });
const line = (over: Partial<CapturedLine> = {}): CapturedLine => ({ lineId: 'L1', productId: 'p1', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: inr(5_000), condition: 'good', ...over });
const issued: OrderForReceipt = { poId: 'po-1', ordered: { p1: 10 }, folds: true };

describe('OB-509 — what each line is booked at', () => {
  it('the issued order\'s product at the order\'s cost; no order and not-on-order → NOT KNOWN, typed figure kept, flagged', async () => {
    const flags: ReceiptFlag[] = [];
    const orderCost = (_t: string, _po: string, productId: string) => (productId === 'p1' ? { minor: 6_000, currency: 'INR' } : undefined);
    const out = await costFromOrder({ orderLineCost: orderCost }, 't', issued, [line(), line({ lineId: 'L2', productId: 'p2', unitCost: inr(4_000) })], flags);
    expect(out.lines.map((l) => [l.lineId, l.unitCost.minor, l.costNotKnown ?? false])).toEqual([['L1', 6_000, false], ['L2', 0, true]]);
    expect(out.costNotKnown).toEqual([expect.objectContaining({ lineId: 'L2', because: 'not_on_order', typedUnitCost: { minor: 4_000, currency: 'INR' } })]);
    expect(out.costDiscrepancies).toEqual([expect.objectContaining({ lineId: 'L1', valueMinor: 10 * 1_000 })]);
    expect(flags).toEqual(['cost_differs_from_order', 'cost_unknown']);

    for (const order of [{ poId: null, ordered: undefined, folds: false }, { poId: 'po-x', ordered: undefined, folds: false }] as OrderForReceipt[]) {
      const f: ReceiptFlag[] = [];
      const none = await costFromOrder({ orderLineCost: orderCost }, 't', order, [line()], f);
      expect(none.costNotKnown).toEqual([expect.objectContaining({ because: 'no_issued_order' })]);
      expect(f).toEqual(['cost_unknown']);
    }
    // A path with no typed figure (the manager's screen, the handheld) keeps nothing typed and raises no cost difference.
    const relayed = await costFromOrder({ orderLineCost: orderCost }, 't', issued, [line({ unitCost: inr(0) }), line({ lineId: 'L2', productId: 'p2', unitCost: inr(0) })], [], { typed: false });
    expect(relayed.costDiscrepancies).toEqual([]);
    expect(relayed.costNotKnown[0]!.typedUnitCost).toBeUndefined();
    expect(relayed.lines[0]!.unitCost.minor).toBe(6_000);
  });

  it('a not-known line\'s differences have no value yet (said), its stock goes in unvalued; a known one is valued', () => {
    const c = captureReceipt({ receiptId: 'g', lines: [line({ countedMinor: 8, unitCost: inr(0), costNotKnown: true }), line({ lineId: 'L2', productId: 'p2', countedMinor: 7 })], rules: [{ productId: 'p1', batchTracked: false }, { productId: 'p2', batchTracked: false }], policy: { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 }, receivedOnDate: '2026-10-20', currency: 'INR' });
    expect(c.discrepancies.find((d) => d.lineId === 'L1')).toMatchObject({ kind: 'short', valueNotKnown: true, value: inr(0) });
    expect(c.discrepancies.find((d) => d.lineId === 'L2')).toMatchObject({ kind: 'short', value: inr(3 * 5_000) });
    expect(c.discrepancies.find((d) => d.lineId === 'L2')?.valueNotKnown).toBeUndefined();
    expect(c.discrepancyValueIncomplete).toBe(true);
    expect(c.lines.map(bookedUnitCostMinor)).toEqual([undefined, 5_000]);
  });

  it('the valuation: the bill\'s cost brings the unvalued units into value — what is still on hand into stock, the sold share to COGS', () => {
    const moves = [
      { productId: 'p1', locationId: 'wh', effect: 1 as const, quantityMinor: 10, isPurchaseReceipt: true },
      { productId: 'p1', locationId: 'wh', effect: -1 as const, quantityMinor: 4, isPurchaseReceipt: false },
    ];
    const before = weightedAverageValuation(moves, 'INR')[0]!;
    expect(before).toMatchObject({ onHandMinor: 6, unvaluedMinor: 6, value: inr(0), unitCostMinor: 'not_known' });
    const known: StockCostAdjustment = { adjustmentId: 'a', invoiceId: 'INV', poId: null, productId: 'p1', locationId: 'wh', quantityMinor: 10, valueMinor: 42_000, occurredAt: '2026-10-21T00:00:00Z', postedBy: 'u', matchedAt: '2026-10-21T00:00:00Z', costKnown: true };
    // The posting as every valuation reader folds it in (`withLandedCost`): a value-only entry that makes the cost KNOWN.
    const folded = withLandedCost([], [known], () => { throw new Error('no movements'); });
    expect(folded).toEqual([expect.objectContaining({ isCostAdjustment: true, isCostKnown: true, adjustmentMinor: 42_000, quantityMinor: 10 })]);
    const after = weightedAverageValuation([...moves, ...folded], 'INR')[0]!;
    expect(after).toMatchObject({ onHandMinor: 6, unvaluedMinor: 0, value: inr(6 * 4_200), cogs: inr(4 * 4_200), unitCostMinor: 4_200 });
  });

  it('a line matched to its bill is no longer waiting for one', () => {
    const g = { costNotKnown: [{ lineId: 'L1' }, { lineId: 'L2' }], billCosts: [{ lineId: 'L1' }] } as unknown as GrnRecord;
    expect(stillCostNotKnown(g).map((l) => l.lineId)).toEqual(['L2']);
  });
});

describe('OB-508 — every discrepancy\'s named owner', () => {
  const rec = (poId: string | null, kinds: string[], costDiff = false) => ({
    grnId: 'g', poId, warehouseId: 'wh-1',
    captured: { discrepancies: kinds.map((kind, i) => ({ lineId: `L${i}`, productId: `p${i}`, kind })) },
    ...(costDiff ? { costDiscrepancies: [{ lineId: 'LC', productId: 'pc' }] } : {}),
  }) as unknown as GrnRecord;

  it('short / excess / cost difference → the buyer who raised the order; damaged / QC / expired / temperature → the store\'s managers', () => {
    const o = discrepancyOwners(rec('po-1', ['short', 'excess', 'damaged', 'qc_failed', 'expired', 'temperature_breach', 'temperature_not_recorded'], true), { buyer: 'u-buyer', storeManagers: ['u-sm-1', 'u-sm-2'] });
    expect(o.map((x) => [x.kind, x.role, x.owners])).toEqual([
      ['short', 'buyer', ['u-buyer']], ['excess', 'buyer', ['u-buyer']],
      ['damaged', 'store_manager', ['u-sm-1', 'u-sm-2']], ['qc_failed', 'store_manager', ['u-sm-1', 'u-sm-2']], ['expired', 'store_manager', ['u-sm-1', 'u-sm-2']],
      ['temperature_breach', 'store_manager', ['u-sm-1', 'u-sm-2']], ['temperature_not_recorded', 'store_manager', ['u-sm-1', 'u-sm-2']],
      ['cost_difference', 'buyer', ['u-buyer']],
    ]);
  });

  it('nobody is ever invented: no order, an order not held, no store manager, a kind the decision names nobody for', () => {
    expect(discrepancyOwners(rec(null, ['short']), { buyer: null, storeManagers: [] })[0]).toMatchObject({ owners: [], missing: 'no_purchase_order' });
    expect(discrepancyOwners(rec('po-gone', ['excess']), { buyer: undefined, storeManagers: [] })[0]).toMatchObject({ owners: [], missing: 'order_not_held' });
    expect(discrepancyOwners(rec('po-1', ['damaged']), { buyer: 'u-buyer', storeManagers: [] })[0]).toMatchObject({ role: 'store_manager', owners: [], missing: 'no_store_manager_named', detail: expect.stringContaining('no store manager named') });
    // OB-528 (owner, 28 Oct 2026, round 8): near expiry and MRP mismatch are the buyer's now — no kind is left undecided.
    expect(discrepancyOwners(rec('po-1', ['near_expiry', 'mrp_mismatch']), { buyer: 'u-buyer', storeManagers: ['u-sm'] }).map((x) => [x.role, x.owners])).toEqual([['buyer', ['u-buyer']], ['buyer', ['u-buyer']]]);
    expect(Object.entries(DISCREPANCY_OWNER_ROLE).filter(([, r]) => r === null).map(([k]) => k).sort()).toEqual([]);
  });
});

describe('the screens say it — English and Tamil', () => {
  const view: GrnRecordView = {
    grnId: 'g', number: 'GRN-1', poId: 'po-1', warehouseId: 'wh-1', receivedBy: 'u-recv', receivedAt: '2026-10-20T06:00:00Z',
    requiresApproval: true, discrepancyValueMinor: 0, currency: 'INR', sellableMinor: 10, quarantinedMinor: 10, rejectedMinor: 0,
    discrepancies: [
      { kind: 'damaged', lineId: 'L2', productId: 'p2', quantityMinor: 10, valueMinor: 0, currency: 'INR', requiresApproval: true, detail: 'd', valueNotKnown: true, owner: { role: 'store_manager', owners: [], missing: 'no_store_manager_named' } },
      { kind: 'cost_difference', lineId: 'L1', productId: 'p1', quantityMinor: 10, valueMinor: 1_000, currency: 'INR', requiresApproval: false, detail: 'c', owner: { role: 'buyer', owners: ['u-buyer'] } },
    ],
    costNotKnown: [{ lineId: 'L2', productId: 'p2', because: 'not_on_order' }], discrepancyValueIncomplete: true,
  };
  const session = createGoodsReceiptSession({ userId: 'u-owner' }, { snapshot: () => ({ receipts: [view], asAt: '2026-10-20T07:00:00Z' }), mayRead: () => true });

  it('owners, "value not known" and "cost not known until the bill" in both languages', () => {
    for (const lang of ['en', 'ta'] as const) {
      const r = session.view(lang).receipts[0]!;
      const damaged = r.discrepancies.find((d) => d.kind === 'damaged')!;
      expect(damaged.valueNotKnown).toBe(true);
      expect(damaged.ownerLabel).toBe(lang === 'en' ? 'Owner: No store manager named' : 'பொறுப்பாளர்: கடை மேலாளர் பெயரிடப்படவில்லை');
      const cost = r.discrepancies.find((d) => d.kind === 'cost_difference')!;
      expect(cost.ownerLabel).toBe(lang === 'en' ? 'Owner: u-buyer (the buyer who raised the order)' : 'பொறுப்பாளர்: u-buyer (ஆர்டர் செய்த வாங்குநர்)');
      expect(cost.label).not.toBe('');
      expect(r.costNotKnown[0]!.label).toContain(lang === 'en' ? 'Cost not known until the supplier bill is matched' : 'சப்ளையர் பில் பொருத்தப்படும் வரை விலை தெரியாது');
      expect(r.valueIncomplete).toBe(true);
    }
    expect(ownerWords('en', undefined)).toBeNull();
  });

  it('the price-variance page: the bill\'s price with its number, or "not yet billed" — never ₹0', () => {
    expect(receivedCostWords('en', { receivedUnitCost: { minor: 6_300 }, invoiceId: 'INV-1' })).toBe('₹63.00 (bill INV-1)');
    expect(receivedCostWords('en', { receivedUnitCost: null, invoiceId: null })).toBe('not yet billed');
    expect(receivedCostWords('ta', { receivedUnitCost: null, invoiceId: null })).toBe('இன்னும் பில் வரவில்லை');
  });
});
