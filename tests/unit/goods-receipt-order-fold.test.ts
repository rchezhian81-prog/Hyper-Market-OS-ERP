import { describe, it, expect } from 'vitest';
import { captureReceipt, type CapturedLine } from '../../packages/receiving/src/index';
import {
  alignToOrder, receivedAgainstOrder, poPostingFor, orderForReceipt, awaitsDecision, linesAwaitingDisposition,
  type GrnRecord, type ReceiptFlag, type OrderForReceipt,
} from '../../services/inventory/src/goods-receipt';

// SP-6 (audit finding F01 · M06-FR-04 · M07-FR-01/03): the pure pieces the goods-receipt routes fold a delivery into its
// order with — what the ORDER says a line ordered, what counts as RECEIVED against it, what posting the receipt makes,
// and which receipts still wait for a person. Tested here without the API; the routes are covered in integration.

const AT = '2026-09-30T09:00:00.000Z';
const INR = { currency: 'INR' as const };
const line = (lineId: string, productId: string, ordered: number, counted: number, extra: Partial<CapturedLine> = {}): CapturedLine =>
  ({ lineId, productId, orderedMinor: ordered, countedMinor: counted, uom: 'ea', unitCost: { minor: 100, ...INR }, condition: 'good', ...extra });
const capture = (lines: readonly CapturedLine[]) => captureReceipt({
  receiptId: 'g', lines, rules: [{ productId: 'p1', batchTracked: false }, { productId: 'p2', batchTracked: false }, { productId: 'p3', batchTracked: false }],
  policy: { excessToleranceBp: 500, shortageToleranceBp: 200, nearExpiryDays: 7 }, receivedOnDate: '2026-09-30', currency: 'INR',
});

describe('alignToOrder — the ordered quantity is the order\'s, never the sender\'s', () => {
  it('a product on one line takes the order\'s figure; a disagreement is said once', () => {
    const flags: ReceiptFlag[] = [];
    const out = alignToOrder([line('L1', 'p1', 60, 60), line('L2', 'p2', 20, 20)], { p1: 100, p2: 20 }, flags);
    expect(out.map((l) => [l.lineId, l.orderedMinor])).toEqual([['L1', 100], ['L2', 20]]);
    expect(flags).toEqual(['ordered_quantity_disagrees']);
  });

  it('a product split across lines keeps the sender\'s split when it adds up; otherwise the ORDER\'s figure is apportioned in line order and the disagreement said', () => {
    const flags: ReceiptFlag[] = [];
    const ok = alignToOrder([line('L1', 'p1', 60, 60, { batchId: 'b1' }), line('L2', 'p1', 40, 40, { batchId: 'b2' })], { p1: 100 }, flags);
    expect(ok.map((l) => l.orderedMinor)).toEqual([60, 40]);
    expect(flags).toEqual([]);
    // 120 delivered as 60 + 60, each claiming 60 of an order of 100: flagged, and apportioned 60 / 40 so the 20 excess shows ONCE.
    const over = alignToOrder([line('L1', 'p1', 60, 60), line('L2', 'p1', 60, 60)], { p1: 100 }, flags);
    expect(over.map((l) => l.orderedMinor)).toEqual([60, 40]);
    expect(flags).toEqual(['ordered_quantity_disagrees']);
  });

  it('F16 FIXED (SP-9-ii): a 10-good + 2-damaged delivery of 12, each line "against the 12 ordered", is complete — not 2 short and 10 short', () => {
    const flags: ReceiptFlag[] = [];
    const lines = [line('L1', 'p1', 12, 10), line('L2', 'p1', 12, 2, { condition: 'damaged' })];
    const aligned = alignToOrder(lines, { p1: 12 }, flags);
    expect(aligned.map((l) => l.orderedMinor)).toEqual([10, 2]); // the order's 12, apportioned as counted
    expect(flags).toEqual([]); // repeating the order's figure on every line is not a disagreement
    const c = capture(aligned);
    expect(c.discrepancies.map((d) => [d.kind, d.lineId, d.quantityMinor])).toEqual([['damaged', 'L2', 2]]); // no 'short' at all
    expect(receivedAgainstOrder(c)).toEqual({ p1: 12 });
    // A delivery that IS short says so once, on the last line: 9 good + 2 damaged of 12 → 1 short.
    const short = capture(alignToOrder([line('L1', 'p1', 12, 9), line('L2', 'p1', 12, 2, { condition: 'damaged' })], { p1: 12 }, []));
    expect(short.discrepancies.filter((d) => d.kind === 'short').map((d) => [d.lineId, d.quantityMinor])).toEqual([['L2', 1]]);
  });

  it('a product the order never named is received as-is and said; with no order the lines are untouched', () => {
    const flags: ReceiptFlag[] = [];
    const out = alignToOrder([line('L1', 'p3', 0, 12)], { p1: 100 }, flags);
    expect(out[0]).toMatchObject({ orderedMinor: 12, countedMinor: 12 });
    expect(flags).toEqual(['product_not_on_order']);
    const lines = [line('L1', 'p1', 60, 60)];
    expect(alignToOrder(lines, undefined, flags)).toBe(lines);
  });
});

describe('receivedAgainstOrder / poPostingFor — what counts as received', () => {
  it('sellable and quarantined stock count; a held excess and refused stock do not; nothing received posts nothing', () => {
    const c = capture([
      line('L1', 'p1', 100, 100),                                   // sellable 100
      line('L2', 'p2', 100, 100, { condition: 'damaged' }),          // quarantined 100 — in the building
      line('L3', 'p3', 100, 110),                                   // 100 sellable + 10 held
      line('L4', 'p1', 50, 50, { batchId: 'x', expiry: '2026-01-01' }), // expired → refused
    ]);
    expect(receivedAgainstOrder(c)).toEqual({ p1: 100, p2: 100, p3: 100 });
    const folds: OrderForReceipt = { poId: 'po-1', ordered: { p1: 150, p2: 100, p3: 100 }, folds: true };
    expect(poPostingFor(folds, 'g', c, 'u-r', AT)).toEqual({ poId: 'po-1', receiptId: 'g', receivedByProduct: { p1: 100, p2: 100, p3: 100 }, by: 'u-r', at: AT });
    expect(poPostingFor({ poId: 'po-1', ordered: { p1: 100 }, folds: false }, 'g', c, 'u-r', AT)).toBeUndefined();
    expect(poPostingFor({ poId: null, ordered: undefined, folds: false }, 'g', c, 'u-r', AT)).toBeUndefined();
    const refusedOnly = capture([line('L4', 'p1', 50, 50, { batchId: 'x', expiry: '2026-01-01' })]);
    expect(poPostingFor(folds, 'g', refusedOnly, 'u-r', AT)).toBeUndefined();
  });
});

describe('orderForReceipt — only an ISSUED order head office holds is folded into; everything else is said', () => {
  const deps = (po: { status: 'proposed' | 'issued'; orderedByProduct: Record<string, number> } | undefined) => ({ purchaseOrder: () => po });
  it('names the four cases', async () => {
    const f1: ReceiptFlag[] = []; expect(await orderForReceipt(deps(undefined), 't', null, f1)).toEqual({ poId: null, ordered: undefined, folds: false }); expect(f1).toEqual(['no_purchase_order']);
    const f2: ReceiptFlag[] = []; expect(await orderForReceipt(deps(undefined), 't', 'po-x', f2)).toEqual({ poId: 'po-x', ordered: undefined, folds: false }); expect(f2).toEqual(['order_unknown']);
    const f3: ReceiptFlag[] = []; expect(await orderForReceipt(deps({ status: 'proposed', orderedByProduct: { p1: 5 } }), 't', 'po-d', f3)).toEqual({ poId: 'po-d', ordered: { p1: 5 }, folds: false }); expect(f3).toEqual(['order_not_issued']);
    const f4: ReceiptFlag[] = []; expect(await orderForReceipt(deps({ status: 'issued', orderedByProduct: { p1: 5 } }), 't', 'po-i', f4)).toEqual({ poId: 'po-i', ordered: { p1: 5 }, folds: true }); expect(f4).toEqual([]);
  });
});

describe('awaitsDecision — a receipt waits while stock is held or undisposed', () => {
  const grn = (lines: readonly CapturedLine[], extra: Partial<GrnRecord> = {}): GrnRecord => {
    const captured = capture(lines);
    return { grnId: 'g', number: 'g', poId: null, warehouseId: 'wh', receivedBy: 'u-r', receivedAt: AT, captured, availableMinor: 0, heldMinor: captured.lines.reduce((s, l) => s + l.heldMinor, 0), ...extra };
  };
  it('quarantined or refused lines wait until each has a disposition; a held excess waits until decided; a clean receipt never waits', () => {
    const clean = grn([line('L1', 'p1', 100, 100)]);
    expect(awaitsDecision(clean)).toBe(false);
    const q = grn([line('L1', 'p1', 100, 100, { condition: 'damaged' }), line('L2', 'p2', 100, 100, { batchId: 'x', expiry: '2026-01-01' })]);
    expect(linesAwaitingDisposition(q).map((l) => l.lineId)).toEqual(['L1', 'L2']);
    expect(awaitsDecision(q)).toBe(true);
    const half = { ...q, dispositions: [{ lineId: 'L1', productId: 'p1', quantityMinor: 100, disposition: 'accept' as const, decidedBy: 'u-b', decidedAt: AT, reason: 'ok', valueMinor: 10_000, currency: 'INR', movementIds: ['g:L1:accepted'], via: 'direct' as const }] };
    expect(linesAwaitingDisposition(half).map((l) => l.lineId)).toEqual(['L2']);
    const held = grn([line('L1', 'p1', 100, 120)]);
    expect(awaitsDecision(held)).toBe(true);
    expect(awaitsDecision({ ...held, excessDecision: { decision: 'rejected', decidedBy: 'u-b', decidedAt: AT, reason: 'no', releasedMinor: 0, movementIds: [], via: 'direct' } })).toBe(false);
  });
});
