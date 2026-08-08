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
