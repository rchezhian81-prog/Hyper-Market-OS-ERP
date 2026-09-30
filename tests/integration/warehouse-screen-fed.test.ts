import { describe, it, expect } from 'vitest';
import { bootWarehouse, type WarehouseAssignment } from '../../apps/warehouse-app/src/index';
import { DeviceOutbox, noDeviceStore } from '../../packages/sync/src/device-outbox';
import { money } from '../../packages/contracts/src/money';

/**
 * **The Warehouse PWA's offline execution engine, fed the assignment the box serves (M09 / OA-9).**
 *
 * This proves the data path of the scanner-first Warehouse handheld: given the assignment a store box
 * would serve (bins, catalogue, what is on order, what is recalled), the real `WarehouseSession`
 * receives at the back door and puts stock away into bins — and every stock rule is the AUTHORITATIVE
 * engine, not a second copy: receiving is `packages/receiving` (over-delivery and DSD need a separate
 * approver §28, unknown barcode to a resolution queue, duplicate-scan a no-op), put-away and bin
 * capacity are `packages/warehouse` (unknown bin queued not invented, full bin and over-draw refused,
 * bad stock kept out of pickable bins), and recall/expiry are `packages/fefo`. Every accepted action
 * queues an event for idempotent sync; a refusal queues nothing (append-only, hard rule #2). It runs
 * synchronously with no network — the handheld works in a dead spot (P-01, §31).
 *
 * The visual shell (bilingual strings, service worker, socket wiring) is the next work package; this
 * is the honest data-path-first half.
 *
 * **Picking an order line (W1, owner Option 1 of 30 Sep · M09-FR-01 · inventory-warehouse.md):** the pick
 * list names the bin; the worker scans that bin, then the item, then confirms. The movement is the
 * authoritative `applyMovement` kind `pick` (out of the bin, to nowhere), so an unknown bin, a draw the bin
 * cannot cover and a repeated command are refused by the ENGINE; the pick list's own two facts — right
 * bin, right item — are the session's, and refused at the scan. One `WarehouseMovementApplied` per pick,
 * keyed on the command id; a refusal queues nothing.
 */

const GRN = 'GRN-1';
const WORKER = 'u-wh';
const NOW = '2026-08-08T10:00:00.000Z';

const baseAssignment = (over: Partial<WarehouseAssignment> = {}): WarehouseAssignment => ({
  assignmentId: 'wa-1', workerId: WORKER, storeId: 'store-1',
  bins: [
    { binId: 'B-PICK', storeId: 'store-1', capacityMinor: 200, pickable: true },
    { binId: 'B-HOLD', storeId: 'store-1', capacityMinor: 200, pickable: false, zone: 'quarantine' },
    { binId: 'B-SMALL', storeId: 'store-1', capacityMinor: 10, pickable: true },
  ],
  barcodes: [
    { barcode: '111', productId: 'P1', level: 'unit' },
    { barcode: '222', productId: 'P2', level: 'unit' },
  ],
  packs: [],
  grnId: GRN,
  ordered: [{ productId: 'P1', quantityMinor: 100, unitCost: money(90_00, 'INR') }],
  ...over,
});

const outbox = () => new DeviceOutbox(noDeviceStore());
const session = (over: Partial<WarehouseAssignment> = {}, box = outbox()) =>
  ({ s: bootWarehouse(baseAssignment(over), box, () => NOW)!, box });

const receiveOne = (grnId = GRN) => (id: string, barcode: string, qty: number, extra: Record<string, unknown> = {}) =>
  ({ commandId: id, grnId, barcode, scannedQuantity: qty, source: 'po' as const, poId: 'PO-1', ...extra });

describe('warehouse PWA is fed its assignment and executes receiving + put-away on the authoritative engines (M09 / OA-9)', () => {
  it('boots on the served assignment, and refuses to boot on nothing', () => {
    expect(bootWarehouse(undefined, outbox())).toBeNull();
    expect(bootWarehouse({ assignmentId: 'x' } as WarehouseAssignment, outbox())).toBeNull();
    const { s } = session();
    expect(s).not.toBeNull();
    expect(s.goodsIn()).toEqual([]);
  });

  it('receives an on-order scan, adds it to the put-away worklist, and queues it for sync', () => {
    const { s, box } = session();
    const r = receiveOne();
    const out = s.receive(r('c1', '111', 100));
    expect(out.result.accepted).toBe(true);
    expect(out.signal).toMatchObject({ feedback: 'accept', sound: 'ok' });
    expect(s.goodsIn()).toHaveLength(1);
    expect(s.goodsIn()[0]).toMatchObject({ productId: 'P1', quantityMinor: 100 });
    // One accepted receipt, queued once for idempotent sync.
    expect(box.pending().map((i) => i.event.type)).toEqual(['GoodsReceived']);
  });

  it('sends an unknown barcode to the resolution queue and banks nothing', () => {
    const { s, box } = session();
    const out = s.receive(receiveOne()('c1', '999', 5));
    expect(out.result.accepted).toBe(false);
    expect(out.signal).toMatchObject({ feedback: 'reject', code: 'unknown_barcode', resolutionRequired: true });
    expect(box.unsentCount()).toBe(0);
    expect(s.goodsIn()).toEqual([]);
  });

  it('needs a SEPARATE approver for an over-delivery, and refuses the worker approving their own (§28)', () => {
    const { s } = session();
    const r = receiveOne();
    expect(s.receive(r('c1', '111', 100)).result.accepted).toBe(true); // to the ordered 100

    // 5 more → 105 exceeds the 2% tolerance (102). No approver → refused.
    const noAppr = s.receive(r('c2', '111', 5));
    expect(noAppr.signal).toMatchObject({ feedback: 'reject', code: 'over_delivery_needs_approval' });

    // The worker cannot approve their own over-delivery.
    const selfAppr = s.receive(r('c3', '111', 5), { subjectRef: GRN, status: 'approved', decidedBy: WORKER });
    expect(selfAppr.result.accepted).toBe(false);

    // A separate approver clears it.
    const ok = s.receive(r('c4', '111', 5), { subjectRef: GRN, status: 'approved', decidedBy: 'u-boss' });
    expect(ok.result.accepted).toBe(true);
    expect(ok.result.quantityMinor).toBe(5);
  });

  it('treats a repeated receiving scan as a harmless no-op (warn, not a second receipt)', () => {
    const { s, box } = session();
    const r = receiveOne();
    s.receive(r('c1', '111', 100));
    const again = s.receive(r('c1', '111', 100));
    expect(again.signal.feedback).toBe('warn');
    expect(again.result.outcome).toBe('duplicate_ignored');
    expect(s.goodsIn()[0]?.quantityMinor).toBe(100); // not doubled
    expect(box.pending()).toHaveLength(1);
  });

  it('suggests a bin, puts stock away into a real bin, updates the projection and queues the move', () => {
    const { s, box } = session();
    s.receive(receiveOne()('c1', '111', 100));

    const suggestion = s.suggestBin({ productId: 'P1', quantityMinor: 50 });
    expect('binId' in suggestion).toBe(true);

    const put = s.putAway({ commandId: 'm1', scannedProductId: 'P1', scannedBinId: 'B-PICK', quantityMinor: 50, uom: 'EA', at: NOW });
    expect(put.result.accepted).toBe(true);
    expect(put.signal).toMatchObject({ feedback: 'accept' });
    expect(s.binContents()['B-PICK|P1|']).toBe(50);
    expect(s.goodsIn()[0]?.quantityMinor).toBe(50); // 100 received − 50 put away
    expect(box.pending().map((i) => i.event.type)).toEqual(['GoodsReceived', 'WarehouseMovementApplied']);
  });

  it('refuses the wrong item, an unknown bin, an over-full bin and more than is in goods-in', () => {
    const { s } = session();
    s.receive(receiveOne()('c1', '111', 100));

    // Wrong SKU — the scanned item is not what is waiting to be put away.
    expect(s.putAway({ commandId: 'mw', scannedProductId: 'P2', scannedBinId: 'B-PICK', quantityMinor: 1, uom: 'EA', at: NOW }).signal.code).toBe('wrong_sku');
    // Unknown bin — queued for resolution, never invented.
    const ghost = s.putAway({ commandId: 'mg', scannedProductId: 'P1', scannedBinId: 'B-GHOST', quantityMinor: 1, uom: 'EA', at: NOW });
    expect(ghost.signal).toMatchObject({ code: 'unknown_bin', resolutionRequired: true });
    // Over-capacity — the overflow ends up on the floor.
    expect(s.putAway({ commandId: 'mf', scannedProductId: 'P1', scannedBinId: 'B-SMALL', quantityMinor: 20, uom: 'EA', at: NOW }).signal.code).toBe('bin_full');
    // More than was received.
    expect(s.putAway({ commandId: 'mi', scannedProductId: 'P1', scannedBinId: 'B-PICK', quantityMinor: 999, uom: 'EA', at: NOW }).signal.code).toBe('insufficient_goods_in');
  });

  it('keeps recalled stock out of a pickable bin, but allows it into a holding bin (M10-FR-04, even offline)', () => {
    const { s, box } = session({
      ordered: undefined,
      goodsIn: [{ productId: 'P1', batchId: 'B-RECALL', quantityMinor: 10, uom: 'EA', state: 'on_hand', expiry: null, recalled: true }],
      recalledBatchIds: ['B-RECALL'],
    });
    // Into a pickable bin → refused with a recall-specific reason.
    const pick = s.putAway({ commandId: 'mr', scannedProductId: 'P1', scannedBinId: 'B-PICK', batchId: 'B-RECALL', quantityMinor: 10, uom: 'EA', at: NOW });
    expect(pick.signal).toMatchObject({ feedback: 'reject', code: 'recalled_into_pickable' });
    expect(box.unsentCount()).toBe(0);
    // Into a holding bin → allowed (the goods are in the building and must go somewhere safe).
    const hold = s.putAway({ commandId: 'mh', scannedProductId: 'P1', scannedBinId: 'B-HOLD', batchId: 'B-RECALL', quantityMinor: 10, uom: 'EA', at: NOW });
    expect(hold.result.accepted).toBe(true);
  });

  it('keeps expired stock out of a pickable bin (FEFO/expiry enforcement)', () => {
    const { s } = session({
      ordered: undefined,
      goodsIn: [{ productId: 'P1', batchId: 'B-OLD', quantityMinor: 10, uom: 'EA', state: 'on_hand', expiry: '2020-01-01', recalled: false }],
    });
    const out = s.putAway({ commandId: 'me', scannedProductId: 'P1', scannedBinId: 'B-PICK', batchId: 'B-OLD', quantityMinor: 10, uom: 'EA', at: NOW });
    expect(out.signal).toMatchObject({ feedback: 'reject', code: 'expired_into_pickable' });
  });

  it('treats a repeated put-away scan as a harmless no-op', () => {
    const { s, box } = session();
    s.receive(receiveOne()('c1', '111', 100));
    s.putAway({ commandId: 'm1', scannedProductId: 'P1', scannedBinId: 'B-PICK', quantityMinor: 50, uom: 'EA', at: NOW });
    const again = s.putAway({ commandId: 'm1', scannedProductId: 'P1', scannedBinId: 'B-PICK', quantityMinor: 50, uom: 'EA', at: NOW });
    expect(again.signal.feedback).toBe('warn');
    expect(again.result.outcome).toBe('duplicate_ignored');
    expect(s.binContents()['B-PICK|P1|']).toBe(50); // not doubled
    expect(box.pending().filter((i) => i.event.type === 'WarehouseMovementApplied')).toHaveLength(1);
  });
});

describe('the warehouse handheld picks an order line from the bin the pick list names (W1 · M09-FR-01 · inventory-warehouse.md)', () => {
  const LINES = [
    { lineId: 'pl-1', orderRef: 'ORD-77', productId: 'P1', batchId: null, binId: 'B-PICK', quantityMinor: 12, uom: 'EA' },
    { lineId: 'pl-2', orderRef: 'ORD-77', productId: 'P2', batchId: 'B-22', binId: 'B-SMALL', quantityMinor: 2, uom: 'EA' },
  ];
  const picking = (contents: Record<string, number> = { 'B-PICK|P1|': 40, 'B-SMALL|P2|B-22': 2 }) =>
    session({ ordered: undefined, pickLines: LINES, contents });
  const at = NOW;

  it('lists the pick work the box sent, with what remains on each line, and nothing when none was sent', () => {
    const { s } = picking();
    expect(s.pickLines().map((l) => [l.lineId, l.binId, l.remainingMinor, l.pickedMinor])).toEqual([['pl-1', 'B-PICK', 12, 0], ['pl-2', 'B-SMALL', 2, 0]]);
    expect(session().s.pickLines()).toEqual([]);
  });

  it('scan the bin → scan the item → confirm: one `pick` movement out of the named bin, queued once, keyed on the command', () => {
    const { s, box } = picking();
    const out = s.pick({ commandId: 'pk-1', lineId: 'pl-1', scannedBinId: 'B-PICK', scannedItem: '111', at });
    expect(out.result.accepted).toBe(true);
    expect(out.signal).toMatchObject({ feedback: 'accept', code: 'picked', sound: 'ok' });
    expect(out.result.detail).toBe('12 picked for ORD-77 from B-PICK');
    // The engine's movement: out of the bin the pick list named, to nowhere — the goods leave the racking for the order.
    expect(out.result.movements).toHaveLength(1);
    expect(out.result.movements[0]).toMatchObject({ movementId: 'pk-1-out', productId: 'P1', locationId: 'B-PICK', quantityMinor: 12, from: 'on_hand', to: null, reason: 'pick by u-wh' });
    // The local projection falls, the line is done and leaves the worklist.
    expect(s.binContents()['B-PICK|P1|']).toBe(28);
    expect(s.pickLines().map((l) => l.lineId)).toEqual(['pl-2']);
    // Queued exactly once, on the command id the cloud keys its ledger on, naming the order and the line.
    const queued = box.pending();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.event).toMatchObject({ type: 'WarehouseMovementApplied', idempotencyKey: 'wh-move:pk-1' });
    expect(queued[0]!.event.payload).toMatchObject({ movedBy: WORKER, orderRef: 'ORD-77', lineId: 'pl-1', command: { kind: 'pick', fromBinId: 'B-PICK', toBinId: null, quantityMinor: 12, reason: 'ORD-77/pl-1' } });
  });

  it('refuses the wrong bin at the racking — a different bin is different stock — and queues nothing', () => {
    const { s, box } = picking();
    // The check the screen makes as soon as the bin is scanned, before the item is asked for.
    const check = s.checkPick({ lineId: 'pl-1', scannedBinId: 'B-HOLD' });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.signal).toMatchObject({ feedback: 'reject', code: 'wrong_bin' });
    // And the commit refuses the same way if the screen were bypassed.
    const out = s.pick({ commandId: 'pk-w', lineId: 'pl-1', scannedBinId: 'B-HOLD', scannedItem: '111', at });
    expect(out.result).toMatchObject({ accepted: false, outcome: 'invalid_command', movements: [] });
    expect(out.signal.code).toBe('wrong_bin');
    expect(box.unsentCount()).toBe(0);
    expect(s.binContents()['B-PICK|P1|']).toBe(40);
  });

  it('refuses the wrong item at the shelf, and an unknown barcode goes to resolution', () => {
    const { s, box } = picking();
    const wrong = s.checkPick({ lineId: 'pl-1', scannedBinId: 'B-PICK', scannedItem: '222' }); // P2's barcode on P1's line
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.signal).toMatchObject({ feedback: 'reject', code: 'wrong_item' });
    const unknown = s.pick({ commandId: 'pk-u', lineId: 'pl-1', scannedBinId: 'B-PICK', scannedItem: '999', at });
    expect(unknown.signal).toMatchObject({ feedback: 'reject', code: 'unknown_barcode', resolutionRequired: true });
    expect(box.unsentCount()).toBe(0);
  });

  it('accepts the product code itself from an internal label, as well as the catalogue barcode', () => {
    const { s } = picking();
    const check = s.checkPick({ lineId: 'pl-1', scannedBinId: 'B-PICK', scannedItem: 'P1' });
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.line).toMatchObject({ lineId: 'pl-1', remainingMinor: 12 });
  });

  it('refuses a line that is not on this pick list, and warns when a line is already picked', () => {
    const { s, box } = picking();
    expect(s.pick({ commandId: 'pk-x', lineId: 'pl-9', scannedBinId: 'B-PICK', scannedItem: '111', at }).signal).toMatchObject({ feedback: 'reject', code: 'not_on_pick_list' });
    s.pick({ commandId: 'pk-1', lineId: 'pl-1', scannedBinId: 'B-PICK', scannedItem: '111', at });
    const again = s.pick({ commandId: 'pk-2', lineId: 'pl-1', scannedBinId: 'B-PICK', scannedItem: '111', at });
    expect(again.signal).toMatchObject({ feedback: 'warn', code: 'line_done' });
    expect(again.result.accepted).toBe(false);
    expect(box.pending()).toHaveLength(1);
  });

  it('never draws a bin negative: a bin holding less than the line wants is refused by the engine, not picked short', () => {
    const { s, box } = picking({ 'B-PICK|P1|': 5 });
    const out = s.pick({ commandId: 'pk-s', lineId: 'pl-1', scannedBinId: 'B-PICK', scannedItem: '111', at });
    expect(out.result.outcome).toBe('insufficient_in_bin');
    expect(out.signal).toMatchObject({ feedback: 'reject', code: 'insufficient_in_bin' });
    expect(box.unsentCount()).toBe(0);
    // A part pick of what IS there is allowed when asked for, and the line stays on the list for the rest.
    const part = s.pick({ commandId: 'pk-p', lineId: 'pl-1', scannedBinId: 'B-PICK', scannedItem: '111', quantityMinor: 5, at });
    expect(part.result.accepted).toBe(true);
    expect(part.result.detail).toBe('5 picked for ORD-77 from B-PICK — 7 still to pick on this line');
    expect(s.pickLines()[0]).toMatchObject({ lineId: 'pl-1', pickedMinor: 5, remainingMinor: 7 });
    expect(s.binContents()['B-PICK|P1|']).toBe(0);
    // More than remains is refused before the engine sees it.
    expect(s.pick({ commandId: 'pk-o', lineId: 'pl-1', scannedBinId: 'B-PICK', scannedItem: '111', quantityMinor: 8, at }).signal.code).toBe('invalid_command');
  });

  it('treats a repeated pick command as a harmless no-op — one movement, one queued event', () => {
    const { s, box } = picking();
    s.pick({ commandId: 'pk-1', lineId: 'pl-2', scannedBinId: 'B-SMALL', scannedItem: '222', at });
    const again = s.pick({ commandId: 'pk-1', lineId: 'pl-2', scannedBinId: 'B-SMALL', scannedItem: '222', at });
    expect(again.signal.feedback).toBe('warn');
    expect(again.result.outcome).toBe('duplicate_ignored');
    expect(s.binContents()['B-SMALL|P2|B-22']).toBe(0); // not drawn twice
    expect(box.pending()).toHaveLength(1);
  });

  it('a pick and a put-away share one command register — the same id cannot move stock twice under two names', () => {
    const { s } = picking();
    s.putAway({ commandId: 'shared', scannedProductId: 'P1', scannedBinId: 'B-PICK', quantityMinor: 1, uom: 'EA', at }); // refused: not in goods-in, still not applied
    s.pick({ commandId: 'shared', lineId: 'pl-1', scannedBinId: 'B-PICK', scannedItem: '111', at });
    expect(s.putAway({ commandId: 'shared', scannedProductId: 'P1', scannedBinId: 'B-PICK', quantityMinor: 1, uom: 'EA', at }).result.outcome).toBe('duplicate_ignored');
  });
});
