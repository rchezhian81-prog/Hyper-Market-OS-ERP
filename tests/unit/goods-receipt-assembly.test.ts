import { describe, it, expect } from 'vitest';
import { captureReceipt } from '../../packages/receiving/src/index';
import { linesFromScans, postureOf } from '../../services/inventory/src/goods-receipt-assembled';
import { decideReceiptExcess, decideLineDisposition, returnRejectedExcess, type GoodsReceiptDeps, type GrnRecord, type ReceiptFlag } from '../../services/inventory/src/goods-receipt';
import type { ReceivingScanRecord } from '../../services/inventory/src/warehouse-synced';
import type { Movement } from '../../services/inventory/src/index';

/**
 * SP-6b (W06 remainder · M07-FR-01 · hard rule #2): the pure pieces that turn a delivery's handheld SCANS into ONE goods
 * receipt — how scans become lines, how the order's quantity is spread across them so an excess or shortage shows on one
 * line, how each scan posture reaches the capture engine — and how the two second-person decisions on such a receipt
 * release only what the scans did NOT post. The routes are covered in integration.
 */

const AT = '2026-09-30T09:00:00.000Z';
const scan = (commandId: string, productId: string, quantityMinor: number, over: Partial<ReceivingScanRecord> = {}): ReceivingScanRecord => ({
  commandId, grnId: 'g', productId, batchId: null, quantityMinor, uom: 'EA', source: 'po', poId: 'po-1', state: 'on_hand', expiry: null,
  receivedBy: 'u-worker', relayedBy: 'u-box', storeId: 'store-1', at: AT, onHandMovementId: `recv:g:${commandId}`, governanceFlags: [], ...over,
});
const heldOut = (commandId: string, productId: string, quantityMinor: number, state: string, over: Partial<ReceivingScanRecord> = {}) =>
  scan(commandId, productId, quantityMinor, { state, onHandMovementId: null, governanceFlags: ['held_out_of_stock'], ...over });
const lines = (scans: ReceivingScanRecord[], ordered: Record<string, number> | undefined, flags: ReceiptFlag[] = []) =>
  linesFromScans({ grnId: 'g', scans, ordered, receivedOnDate: '2026-09-30', unitCostMinorOf: (p) => (p === 'p-nocost' ? undefined : 100), flags });

describe('postureOf — what the scan said, as the capture engine can express it', () => {
  it('on_hand and good are good; damaged and expired are themselves; anything else is held (quarantine, reserved, in_transit, unknown)', () => {
    expect(['on_hand', 'good', 'damaged', 'expired', 'quarantine', 'reserved', 'in_transit', 'whatever'].map(postureOf))
      .toEqual(['good', 'good', 'damaged', 'expired', 'held', 'held', 'held', 'held']);
  });
});

describe('linesFromScans — one line per product + batch + posture, the order spread across them', () => {
  it('groups scans of one product into one line and sums them; the order\'s figure is the ordered quantity', () => {
    const out = lines([scan('c1', 'p1', 1), scan('c2', 'p1', 1), scan('c3', 'p1', 2)], { p1: 10 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ posture: 'good', scannedOnHandMinor: 4, commandIds: ['c1', 'c2', 'c3'], onHandMovementIds: ['recv:g:c1', 'recv:g:c2', 'recv:g:c3'] });
    expect(out[0]!.line).toMatchObject({ lineId: 'g:1', productId: 'p1', orderedMinor: 10, countedMinor: 4, uom: 'EA', batchId: null, condition: 'good', unitCost: { minor: 100, currency: 'INR' } });
  });

  it('a product\'s GOOD line comes first and takes the order up to what it counted; the last line takes the remainder — so an excess lands on ONE line', () => {
    // Order 10 · good 8 + damaged 4 = 12 arrived: the good line claims 8, the damaged line the remaining 2 (an excess of 2 shows there).
    const out = lines([heldOut('d1', 'p1', 4, 'damaged'), scan('c1', 'p1', 8)], { p1: 10 });
    expect(out.map((a) => [a.line.lineId, a.posture, a.line.orderedMinor, a.line.countedMinor, a.scannedOnHandMinor]))
      .toEqual([['g:1', 'good', 8, 8, 8], ['g:2', 'damaged', 2, 4, 0]]);
    expect(out[1]!.line.condition).toBe('damaged');
    // Order 10 · good 12: the one line is ordered 10, counted 12 → the capture holds 2.
    const one = lines([scan('c1', 'p1', 12)], { p1: 10 });
    expect(one[0]!.line).toMatchObject({ orderedMinor: 10, countedMinor: 12 });
    // Order 10 · good 4: short 6 on the one line.
    expect(lines([scan('c1', 'p1', 4)], { p1: 10 })[0]!.line).toMatchObject({ orderedMinor: 10, countedMinor: 4 });
    // Two batches of good stock: the first claims what it counted, the second the rest — together exactly the order.
    const batches = lines([scan('c1', 'p1', 6, { batchId: 'b1' }), scan('c2', 'p1', 6, { batchId: 'b2' })], { p1: 10 });
    expect(batches.map((a) => [a.line.batchId, a.line.orderedMinor, a.line.countedMinor])).toEqual([['b1', 6, 6], ['b2', 4, 6]]);
  });

  it('a product the order never named, or a delivery with no order, is received as-is (ordered = counted); products keep their first-seen order', () => {
    const out = lines([scan('c1', 'p2', 3), scan('c2', 'p1', 5)], { p1: 5 });
    expect(out.map((a) => [a.line.productId, a.line.orderedMinor, a.line.countedMinor])).toEqual([['p2', 3, 3], ['p1', 5, 5]]);
    expect(lines([scan('c1', 'p1', 7)], undefined)[0]!.line).toMatchObject({ orderedMinor: 7, countedMinor: 7 });
  });

  it('held-out postures reach the engine as it understands them: damaged → damaged, quarantine → QC failed, expired → an expiry the engine refuses (assumed when the scan carried none, and SAID)', () => {
    const flags: ReceiptFlag[] = [];
    const out = lines([
      heldOut('d1', 'p1', 2, 'damaged'), heldOut('q1', 'p1', 3, 'quarantine'), heldOut('e1', 'p1', 4, 'expired'), heldOut('e2', 'p2', 1, 'expired', { expiry: '2026-09-01' }),
    ], undefined, flags);
    expect(out.map((a) => [a.posture, a.line.condition, a.line.qc ?? null, a.line.expiry])).toEqual([
      ['damaged', 'damaged', null, null], ['expired', 'good', null, '2026-09-30'], ['held', 'good', 'failed', null], ['expired', 'good', null, '2026-09-01'],
    ]);
    expect(flags).toEqual(['expiry_date_assumed']);
    // Through the real engine: nothing sellable, the damaged and QC-failed quarantined, both expired lines refused.
    const c = captureReceipt({ receiptId: 'g', lines: out.map((a) => a.line), rules: [{ productId: 'p1', batchTracked: false }, { productId: 'p2', batchTracked: false }], policy: { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 }, receivedOnDate: '2026-09-30', currency: 'INR' });
    expect(c.lines.map((l) => [l.disposition, l.sellableMinor, l.quarantinedMinor, l.rejectedMinor])).toEqual([
      ['quarantine', 0, 2, 0], ['rejected', 0, 0, 4], ['quarantine', 0, 3, 0], ['rejected', 0, 0, 1],
    ]);
  });

  it('a product with no cost at head office is captured at ₹0 (the route says cost_unknown); a batch and its expiry ride onto the line', () => {
    const out = lines([scan('c1', 'p-nocost', 2, { batchId: 'B7', expiry: '2027-01-01' })], undefined);
    expect(out[0]!.line).toMatchObject({ unitCost: { minor: 0 }, batchId: 'B7', expiry: '2027-01-01' });
  });
});

/** A GRN as the assembly records it: the stock ALREADY on-hand from the scans, the excess held, one damaged line. */
const assembled = (): GrnRecord => ({
  grnId: 'g', number: 'g', poId: 'po-1', warehouseId: 'store-1', receivedBy: 'u-worker', receivedAt: AT,
  captured: {
    receiptId: 'g', requiresApproval: true, discrepancyValue: { minor: 600, currency: 'INR' },
    discrepancies: [],
    lines: [
      { lineId: 'g:1', productId: 'p1', sellableMinor: 10, quarantinedMinor: 0, rejectedMinor: 0, heldMinor: 2, disposition: 'sellable', uom: 'EA', batchId: null, expiry: null, unitCost: { minor: 100, currency: 'INR' } },
      { lineId: 'g:2', productId: 'p1', sellableMinor: 0, quarantinedMinor: 4, rejectedMinor: 0, heldMinor: 0, disposition: 'quarantine', uom: 'EA', batchId: null, expiry: null, unitCost: { minor: 100, currency: 'INR' } },
    ],
  },
  availableMinor: 10, heldMinor: 2, governanceFlags: ['excess_already_on_hand'],
  poReceipt: { receiptId: 'g', receivedByProduct: { p1: 14 } },
  assembledFrom: { scanCount: 3, commandIds: ['c1', 'c2', 'd1'], scannedBy: ['u-worker'], completedBy: 'u-worker', completedAt: AT, onHandByLine: { 'g:1': 12, 'g:2': 0 }, onHandMovementIds: ['recv:g:c1', 'recv:g:c2'], disagreements: [] },
});

/** Deps over one record, capturing what each decision appends. */
function depsOver(record: GrnRecord) {
  let current = record;
  const appended: { kind: string; movements: Movement[]; poReceipt: unknown }[] = [];
  const deps: GoodsReceiptDeps = {
    grn: (_t, id) => (id === current.grnId ? current : undefined), all: () => [current], now: () => '2026-09-30T12:00:00.000Z',
    commit: () => {}, purchaseOrder: () => undefined, productRule: () => undefined, receiptPolicy: () => undefined, recordReceiptPolicy: () => {},
    commitExcessDecision: (_t, rec, movements, _k, poReceipt) => { current = rec; appended.push({ kind: 'excess', movements: [...movements], poReceipt }); },
    commitDisposition: (_t, rec, movements) => { current = rec; appended.push({ kind: 'disposition', movements: [...movements], poReceipt: undefined }); },
    commitExcessReturn: (_t, rec, movements) => { current = rec; appended.push({ kind: 'excess-return', movements: [...movements], poReceipt: undefined }); },
    commitLineReturn: (_t, rec) => { current = rec; },
  };
  return { deps, appended, current: () => current };
}

describe('the two decisions on an ASSEMBLED receipt release only what the scans did not post (hard rule #2)', () => {
  it('approving the held excess accepts it where it is: no movement, the quantity counted as released, and the order told', async () => {
    const { deps, appended, current } = depsOver(assembled());
    const out = await decideReceiptExcess(deps, { tenantId: 't', grnId: 'g', decidedBy: 'u-boss', decision: 'approved', reason: 'supplier confirmed', branchId: null, via: 'direct' });
    expect(out.ok).toBe(true);
    expect(appended).toEqual([{ kind: 'excess', movements: [], poReceipt: { poId: 'po-1', receiptId: 'g:excess', receivedByProduct: { p1: 2 }, by: 'u-boss', at: '2026-09-30T12:00:00.000Z' } }]);
    expect(current()).toMatchObject({ availableMinor: 12, excessDecision: { decision: 'approved', releasedMinor: 2, movementIds: [] } });
    expect(current().governanceFlags).toEqual(['excess_already_on_hand']);
  });

  it('rejecting the held excess moves nothing and FLAGS the units for the supplier return — never a silent withdrawal, never an invented movement', async () => {
    const { deps, appended, current } = depsOver(assembled());
    const out = await decideReceiptExcess(deps, { tenantId: 't', grnId: 'g', decidedBy: 'u-boss', decision: 'rejected', reason: 'not ordered, going back', branchId: null, via: 'direct' });
    expect(out.ok).toBe(true);
    expect(appended).toEqual([{ kind: 'excess', movements: [], poReceipt: undefined }]);
    expect(current()).toMatchObject({ availableMinor: 10, excessDecision: { decision: 'rejected', releasedMinor: 0, movementIds: [] } });
    expect(current().governanceFlags).toEqual(['excess_already_on_hand', 'excess_on_hand_pending_return']);
  });

  it('SP-7b: a REJECTED excess goes back to the supplier — on an assembled receipt the on-hand units come off as one returned_to_supplier movement per held line, once; undecided or approved is refused; an ordinary receipt moves nothing', async () => {
    const { deps, appended, current } = depsOver(assembled());
    // Nothing decided yet → the supplier's goods are not ours to send back.
    const early = await returnRejectedExcess(deps, { tenantId: 't', grnId: 'g', returnedBy: 'u-worker', reason: 'sent back', branchId: null });
    expect(early).toMatchObject({ ok: false, refusedBecause: 'excess_not_rejected' });
    await decideReceiptExcess(deps, { tenantId: 't', grnId: 'g', decidedBy: 'u-boss', decision: 'rejected', reason: 'not ordered, going back', branchId: null, via: 'direct' });
    const out = await returnRejectedExcess(deps, { tenantId: 't', grnId: 'g', returnedBy: 'u-worker', reason: 'collected by the supplier van', branchId: null });
    expect(out).toMatchObject({ ok: true, alreadyReturned: false });
    expect(appended.at(-1)!.kind).toBe('excess-return');
    expect(appended.at(-1)!.movements.map((m) => [m.movementId, m.kind, m.quantityMinor, m.reason])).toEqual([['g:g:1:returned', 'returned_to_supplier', 2, 'collected by the supplier van']]);
    expect(current().excessReturn).toMatchObject({ returnedBy: 'u-worker', quantityMinor: 2, valueMinor: 200, movementIds: ['g:g:1:returned'] });
    expect(current().governanceFlags).toEqual(['excess_already_on_hand', 'excess_returned_to_supplier']);
    // Once: the same return again appends nothing.
    const again = await returnRejectedExcess(deps, { tenantId: 't', grnId: 'g', returnedBy: 'u-worker', reason: 'again', branchId: null });
    expect(again).toMatchObject({ ok: true, alreadyReturned: true });
    expect(appended.filter((a) => a.kind === 'excess-return')).toHaveLength(1);
    // An APPROVED excess is not returnable; a receipt captured the ordinary way (held never on-hand) records the return with no movement.
    const approved = depsOver(assembled());
    await decideReceiptExcess(approved.deps, { tenantId: 't', grnId: 'g', decidedBy: 'u-boss', decision: 'approved', reason: 'keep it', branchId: null, via: 'direct' });
    expect(await returnRejectedExcess(approved.deps, { tenantId: 't', grnId: 'g', returnedBy: 'u-worker', reason: 'x', branchId: null })).toMatchObject({ ok: false, refusedBecause: 'excess_not_rejected' });
    const { assembledFrom, ...ordinary } = assembled();
    void assembledFrom;
    const plain = depsOver({ ...ordinary, governanceFlags: [] });
    await decideReceiptExcess(plain.deps, { tenantId: 't', grnId: 'g', decidedBy: 'u-boss', decision: 'rejected', reason: 'no', branchId: null, via: 'direct' });
    const plainOut = await returnRejectedExcess(plain.deps, { tenantId: 't', grnId: 'g', returnedBy: 'u-worker', reason: 'van', branchId: null });
    expect(plainOut).toMatchObject({ ok: true, alreadyReturned: false });
    expect(plain.appended.at(-1)!.movements).toEqual([]);
    expect(plain.current().excessReturn).toMatchObject({ quantityMinor: 2, valueMinor: 200, movementIds: [] });
    expect(plain.current().governanceFlags).toEqual(['excess_returned_to_supplier']);
  });

  it('a receipt captured the ordinary way still releases its approved excess as a movement (the SP-4 behaviour is untouched)', async () => {
    const { assembledFrom, ...ordinary } = assembled();
    void assembledFrom;
    const { deps, appended } = depsOver({ ...ordinary, governanceFlags: [] });
    await decideReceiptExcess(deps, { tenantId: 't', grnId: 'g', decidedBy: 'u-boss', decision: 'approved', reason: 'ok', branchId: null, via: 'direct' });
    expect(appended[0]!.movements.map((m) => [m.movementId, m.kind, m.quantityMinor, m.approvedBy])).toEqual([['g:g:1:excess', 'received', 2, 'u-boss']]);
  });

  it('accepting a quarantined line releases what the scans held out (damaged scans posted nothing → the whole line); a line the scans had posted releases nothing again', async () => {
    const { deps, appended } = depsOver(assembled());
    const damaged = await decideLineDisposition(deps, { tenantId: 't', grnId: 'g', lineId: 'g:2', decidedBy: 'u-boss', disposition: 'accept', reason: 'only the boxes were dented', branchId: null, via: 'direct' });
    expect(damaged.ok).toBe(true);
    expect(appended[0]!.movements.map((m) => [m.movementId, m.quantityMinor])).toEqual([['g:g:2:accepted', 4]]);
    // A line whose scans HAD posted on-hand but the capture quarantined (a disagreement) — accepting it must not post the units twice.
    const rec = assembled();
    const twisted: GrnRecord = {
      ...rec,
      captured: { ...rec.captured, lines: [{ ...rec.captured.lines[0]!, sellableMinor: 0, heldMinor: 0, quarantinedMinor: 12, disposition: 'quarantine' }, rec.captured.lines[1]!] },
      assembledFrom: { ...rec.assembledFrom!, disagreements: [{ lineId: 'g:1', scannedOnHandMinor: 12, sellableMinor: 0, heldMinor: 0 }] },
    };
    const d2 = depsOver(twisted);
    const posted = await decideLineDisposition(d2.deps, { tenantId: 't', grnId: 'g', lineId: 'g:1', decidedBy: 'u-boss', disposition: 'accept', reason: 'checked, fine', branchId: null, via: 'direct' });
    expect(posted.ok).toBe(true);
    expect(d2.appended[0]!.movements).toEqual([]);
    expect(d2.current().dispositions?.[0]).toMatchObject({ lineId: 'g:1', disposition: 'accept', quantityMinor: 12, movementIds: [] });
  });
});
