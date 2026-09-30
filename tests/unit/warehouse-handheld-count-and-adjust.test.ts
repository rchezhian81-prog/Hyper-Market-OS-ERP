import { describe, it, expect } from 'vitest';
import {
  WarehouseSession, STOCK_COUNTED, ADJUSTMENT_REQUESTED, HANDHELD_COUNT_REASON, SENT_WORK_KINDS, FEEDBACK_CODES,
  type WarehouseAssignment,
} from '../../apps/warehouse-app/src/warehouse-session';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { isRelayable } from '../../packages/sync/src/device-relay';
import { pathFor } from '../../edge/sync-agent/src/http-transport';
import { ADJUSTMENT_REASON_CODES } from '../../packages/adjustment/src/adjustment';

/**
 * **The warehouse handheld counts a bin BLIND and raises an adjustment REQUEST — neither moves stock on the device
 * (SP-3b · W2 · W3 · M09-FR-04 · M08-FR-03 · §28 · hard rules #1/#2/#5).**
 *
 * A count is what the worker SAW: the session queues the counted figure with the bin and never an expected quantity —
 * it has none to give, and its own bin projection does not move on a count. An adjustment is a REQUEST: a signed
 * quantity with a reason from the fixed list, queued for head office where a supervisor who is not this worker decides
 * it; nothing posts here. Both fit the shared route (allow-listed for `warehouse`, resolving to their cloud paths) and
 * both appear in the sent-work list with the shared state words. Refusals queue nothing and say why.
 */

const AT = '2026-09-30T11:00:00.000Z';
const ASSIGNMENT: WarehouseAssignment = {
  assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1',
  bins: [
    { binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' },
    { binId: 'BIN-B', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' },
  ],
  barcodes: [{ barcode: '890RICE', productId: 'p-rice', level: 'unit' }],
  packs: [{ productId: 'p-rice', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890RICE' }] }],
  goodsIn: [{ productId: 'p-good', batchId: null, quantityMinor: 6, uom: 'CS', state: 'on_hand', expiry: null, recalled: false }],
  // The box says BIN-A holds 40 of p-rice — a figure the COUNT must never surface or move.
  contents: { 'BIN-A|p-rice|': 40, 'BIN-B|p-oil|': 7 },
  pickLines: [{ lineId: 'pl-1', orderRef: 'ORD-77', productId: 'p-rice', batchId: null, binId: 'BIN-A', quantityMinor: 12, uom: 'EA' }],
};

const session = () => {
  const outbox = new SyncOutbox();
  return { outbox, s: new WarehouseSession(ASSIGNMENT, outbox, { now: () => AT }) };
};

describe('W2 — a blind bin count', () => {
  it('queues only what was counted — the bin, the product, the figure — under the shared StockCounted type and route, and moves nothing here', () => {
    const { s, outbox } = session();
    const out = s.countBin({ countId: 'cnt-1', scannedBinId: 'BIN-A', scannedItem: '890RICE', countedMinor: 38, at: AT });
    expect(out.accepted).toBe(true);
    expect(out.signal).toMatchObject({ feedback: 'accept', code: 'counted' });
    expect(out.productId).toBe('p-rice');
    // Nothing the counter reads, and nothing queued, is an expected figure or a variance.
    expect(out.signal.detail).not.toContain('40');
    expect(JSON.stringify(out)).not.toMatch(/expected|variance/i);
    expect(JSON.stringify(outbox.find('count-cnt-1')!.event.payload)).not.toMatch(/40|expected|variance/i);

    const item = outbox.find('count-cnt-1')!;
    expect(item.event.type).toBe(STOCK_COUNTED);
    expect(item.event.payload).toEqual({
      countId: 'cnt-1', productId: 'p-rice', locationId: 'store-1', binId: 'BIN-A', uom: 'EA', countedMinor: 38,
      reasonCode: HANDHELD_COUNT_REASON, counterId: 'u-worker', at: AT, storeId: 'store-1', source: 'warehouse-handheld',
    });
    expect(isRelayable(STOCK_COUNTED, 'warehouse')).toBe(true);
    expect(pathFor(item.event)).toBe('/v1/inventory/counts/cnt-1/synced');
    // The local projection is untouched: the correction, if any, is head office's (hard rule #2).
    expect(s.binContents()['BIN-A|p-rice|']).toBe(40);
  });

  it('counts a product the bin holds even when it is not on the catalogue, the order or the pick list — and zero is a real count', () => {
    const { s, outbox } = session();
    const out = s.countBin({ countId: 'cnt-2', scannedBinId: 'BIN-B', scannedItem: 'p-oil', countedMinor: 0, at: AT });
    expect(out.accepted).toBe(true);
    expect(outbox.find('count-cnt-2')!.event.payload).toMatchObject({ productId: 'p-oil', binId: 'BIN-B', countedMinor: 0 });
    // A goods-in product carries its own unit.
    expect(s.countBin({ countId: 'cnt-3', scannedBinId: 'BIN-A', scannedItem: 'p-good', countedMinor: 2, at: AT }).accepted).toBe(true);
    expect(outbox.find('count-cnt-3')!.event.payload).toMatchObject({ uom: 'CS' });
  });

  it('refuses a bin or item this handheld does not know, a quantity that is not whole, and a count id already used — and queues nothing', () => {
    const { s, outbox } = session();
    expect(s.knowsBin('BIN-A')).toBe(true);
    expect(s.knowsBin('BIN-Z')).toBe(false);
    expect(s.countBin({ countId: 'c-a', scannedBinId: 'BIN-Z', scannedItem: '890RICE', countedMinor: 1, at: AT }).signal).toMatchObject({ feedback: 'reject', code: 'unknown_bin', resolutionRequired: true });
    expect(s.countBin({ countId: 'c-b', scannedBinId: 'BIN-A', scannedItem: '000NOPE', countedMinor: 1, at: AT }).signal).toMatchObject({ feedback: 'reject', code: 'unknown_barcode' });
    expect(s.countBin({ countId: 'c-c', scannedBinId: 'BIN-A', scannedItem: '890RICE', countedMinor: 1.5, at: AT }).signal.code).toBe('not_a_quantity');
    expect(s.countBin({ countId: 'c-d', scannedBinId: 'BIN-A', scannedItem: '890RICE', countedMinor: -1, at: AT }).signal.code).toBe('not_a_quantity');
    expect(outbox.all()).toHaveLength(0);
    s.countBin({ countId: 'c-e', scannedBinId: 'BIN-A', scannedItem: '890RICE', countedMinor: 5, at: AT });
    expect(s.countBin({ countId: 'c-e', scannedBinId: 'BIN-A', scannedItem: '890RICE', countedMinor: 6, at: AT }).signal).toMatchObject({ feedback: 'warn', code: 'duplicate_ignored' });
    expect(outbox.all()).toHaveLength(1);
    for (const code of ['counted', 'not_a_quantity', 'unknown_bin', 'unknown_barcode', 'duplicate_ignored']) expect(FEEDBACK_CODES).toContain(code);
  });
});

describe('W3 — an adjustment request', () => {
  it('queues a signed correction with a reason from the list as a REQUEST — nothing posts here — under AdjustmentRequested and its route', () => {
    const { s, outbox } = session();
    const out = s.requestAdjustment({ requestId: 'adj-1', scannedItem: '890RICE', deltaMinor: -2, reasonCode: 'damaged', at: AT });
    expect(out.accepted).toBe(true);
    expect(out.signal).toMatchObject({ feedback: 'accept', code: 'adjustment_requested' });
    expect(out.signal.detail).toContain("supervisor's approval");
    const item = outbox.find('adj-req:adj-1')!;
    expect(item.event.type).toBe(ADJUSTMENT_REQUESTED);
    expect(item.event.payload).toEqual({
      requestId: 'adj-1', productId: 'p-rice', locationId: 'store-1', binId: null, deltaMinor: -2, uom: 'EA', reasonCode: 'damaged', note: null,
      requestedBy: 'u-worker', at: AT, storeId: 'store-1', source: 'warehouse-handheld',
    });
    expect(isRelayable(ADJUSTMENT_REQUESTED, 'warehouse')).toBe(true);
    expect(isRelayable(ADJUSTMENT_REQUESTED, 'manager')).toBe(false);
    expect(pathFor(item.event)).toBe('/v1/inventory/adjustment-requests/adj-1/synced');
    expect(s.binContents()['BIN-A|p-rice|']).toBe(40); // untouched
    // Found more, at a named bin, with a note.
    s.requestAdjustment({ requestId: 'adj-2', scannedItem: 'p-oil', deltaMinor: 3, reasonCode: 'found', binId: 'BIN-B', note: ' behind the pallet ', at: AT });
    expect(outbox.find('adj-req:adj-2')!.event.payload).toMatchObject({ productId: 'p-oil', deltaMinor: 3, binId: 'BIN-B', note: 'behind the pallet' });
  });

  it('refuses an unknown item, a zero or non-whole quantity, a reason off the list, and a request id already used — and queues nothing', () => {
    const { s, outbox } = session();
    expect(s.requestAdjustment({ requestId: 'r-a', scannedItem: '000NOPE', deltaMinor: -1, reasonCode: 'damaged', at: AT }).signal.code).toBe('unknown_barcode');
    expect(s.requestAdjustment({ requestId: 'r-b', scannedItem: '890RICE', deltaMinor: 0, reasonCode: 'damaged', at: AT }).signal.code).toBe('not_a_quantity');
    expect(s.requestAdjustment({ requestId: 'r-c', scannedItem: '890RICE', deltaMinor: 1.5, reasonCode: 'damaged', at: AT }).signal.code).toBe('not_a_quantity');
    expect(s.requestAdjustment({ requestId: 'r-d', scannedItem: '890RICE', deltaMinor: -1, reasonCode: 'because', at: AT }).signal.code).toBe('no_reason');
    expect(s.requestAdjustment({ requestId: 'r-e', scannedItem: '890RICE', deltaMinor: -1, reasonCode: '', at: AT }).signal.code).toBe('no_reason');
    expect(outbox.all()).toHaveLength(0);
    s.requestAdjustment({ requestId: 'r-f', scannedItem: '890RICE', deltaMinor: -1, reasonCode: 'miscount', at: AT });
    expect(s.requestAdjustment({ requestId: 'r-f', scannedItem: '890RICE', deltaMinor: -5, reasonCode: 'miscount', at: AT }).signal).toMatchObject({ feedback: 'warn', code: 'duplicate_ignored' });
    expect(outbox.all()).toHaveLength(1);
    expect([...ADJUSTMENT_REASON_CODES]).toEqual(['damaged', 'expired', 'miscount', 'found', 'theft_suspected', 'other']);
    for (const code of ['adjustment_requested', 'no_reason']) expect(FEEDBACK_CODES).toContain(code);
  });
});

describe('the sent-work list carries counts and requests with the shared state words', () => {
  it('lists a count and an adjustment newest first, with what was counted / requested and never an expected figure', () => {
    const { s, outbox } = session();
    s.countBin({ countId: 'cnt-9', scannedBinId: 'BIN-A', scannedItem: '890RICE', countedMinor: 38, at: AT });
    s.requestAdjustment({ requestId: 'adj-9', scannedItem: 'p-good', deltaMinor: -1, reasonCode: 'damaged', at: AT });
    expect(s.sentWork().map((w) => [w.kind, w.id, w.what, w.detail, w.state])).toEqual([
      ['adjustment', 'adj-9', 'p-good', '-1 CS · damaged', 'saved_here'],
      ['count', 'cnt-9', 'p-rice · BIN-A', '38 EA', 'saved_here'],
    ]);
    for (const w of s.sentWork()) expect(SENT_WORK_KINDS).toContain(w.kind);
    outbox.acknowledge('count-cnt-9');
    s.noteBoxStatus([{ key: 'count-cnt-9', state: 'posted', attempts: 0 }]);
    expect(s.sentWork().find((w) => w.id === 'cnt-9')?.state).toBe('posted');
    expect(JSON.stringify(s.sentWork())).not.toContain('40');
  });
});
