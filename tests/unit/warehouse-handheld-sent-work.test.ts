import { describe, it, expect } from 'vitest';
import { WarehouseSession, RECEIVING_SCANNED, RECEIVING_COMPLETED, WAREHOUSE_MOVEMENT_APPLIED, SENT_WORK_KINDS, type WarehouseAssignment } from '../../apps/warehouse-app/src/warehouse-session';
import { openWarehouseRelay } from '../../apps/warehouse-app/src/browser-entry';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { openDeviceOutbox, noDeviceStore } from '../../packages/sync/src/device-outbox';
import { isRelayable } from '../../packages/sync/src/device-relay';
import { pathFor } from '../../edge/sync-agent/src/http-transport';

/**
 * **What the warehouse handheld queues is what the store computer and head office can carry (SP-3a · S1 · F11).**
 *
 * Before SP-3a the handheld queued a `GoodsReceived` shaped as one SCAN — the same type name as the manager's whole
 * receipt — with no route on the transport, and a movement whose command id sat only inside `command`, where the route
 * resolver cannot see it. Nothing here could have travelled. This binds the handheld's events to the shared contract:
 * each is allow-listed for the `warehouse` surface, each resolves to its cloud route from its own payload, and the
 * session lists every accepted scan with where it has got to — from the durable queue plus the box's own word.
 */

const AT = '2026-09-30T10:00:00.000Z';
const ASSIGNMENT: WarehouseAssignment = {
  assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1',
  bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' }],
  grnId: 'grn-1', poId: 'po-1',
  ordered: [{ productId: 'p-rice', quantityMinor: 100, unitCost: { minor: 4000, currency: 'INR' } }],
  barcodes: [{ barcode: '890RICE', productId: 'p-rice', level: 'unit' }],
  packs: [{ productId: 'p-rice', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890RICE' }] }],
  goodsIn: [{ productId: 'p-good', batchId: null, quantityMinor: 6, uom: 'EA', state: 'on_hand', expiry: null, recalled: false }],
  contents: { 'BIN-A|p-rice|': 40 },
  pickLines: [{ lineId: 'pl-1', orderRef: 'ORD-77', productId: 'p-rice', batchId: null, binId: 'BIN-A', quantityMinor: 12, uom: 'EA' }],
};

const session = () => {
  const outbox = new SyncOutbox();
  return { outbox, s: new WarehouseSession(ASSIGNMENT, outbox, { now: () => AT }) };
};

describe('the handheld\'s events fit the shared route', () => {
  it('a receiving scan is its own type, carries the store, the unit and the worker, and resolves to the receiving-scan route', () => {
    const { s, outbox } = session();
    const out = s.receive({ commandId: 'recv-1', grnId: 'grn-1', barcode: '890RICE', scannedQuantity: 1, source: 'po' });
    expect(out.signal.code).toBe('received');
    const item = outbox.find('recv:grn-1:recv-1')!;
    expect(item.event.type).toBe(RECEIVING_SCANNED);
    expect(item.event.payload).toMatchObject({ commandId: 'recv-1', grnId: 'grn-1', productId: 'p-rice', quantityMinor: 1, uom: 'EA', receivedBy: 'u-worker', storeId: 'store-1', state: 'on_hand', source: 'po', at: AT });
    expect(isRelayable(RECEIVING_SCANNED, 'warehouse')).toBe(true);
    expect(isRelayable(RECEIVING_SCANNED, 'manager')).toBe(false);
    expect(pathFor(item.event)).toBe('/v1/inventory/receiving-scans/recv-1/synced');
  });

  it('"delivery complete" (SP-6b) queues ONE completion behind the scans, keyed on the GRN, naming the order — and nothing when nothing was received', () => {
    const { s, outbox } = session();
    // Nothing received here yet → refused, nothing queued, the button has no reason to show.
    expect(s.receivingOpen('grn-1')).toBe(false);
    const early = s.completeReceiving({ grnId: 'grn-1', at: AT });
    expect(early).toMatchObject({ accepted: false, scanCount: 0, signal: { feedback: 'reject', code: 'nothing_received' } });
    expect(outbox.all()).toHaveLength(0);

    s.receive({ commandId: 'recv-1', grnId: 'grn-1', barcode: '890RICE', scannedQuantity: 1, source: 'po' });
    s.receive({ commandId: 'recv-2', grnId: 'grn-1', barcode: '890RICE', scannedQuantity: 1, source: 'po' });
    expect(s.receivingOpen('grn-1')).toBe(true);
    const done = s.completeReceiving({ grnId: 'grn-1', at: AT });
    expect(done).toMatchObject({ accepted: true, grnId: 'grn-1', scanCount: 2, signal: { feedback: 'accept', code: 'receiving_done' } });
    const item = outbox.find('recv-done:grn-1')!;
    expect(item.event.type).toBe(RECEIVING_COMPLETED);
    // Behind the scans in the queue — head office has them before it is asked to assemble them. No quantity travels.
    expect(outbox.all().map((i) => i.key)).toEqual(['recv:grn-1:recv-1', 'recv:grn-1:recv-2', 'recv-done:grn-1']);
    expect(item.event.payload).toEqual({ grnId: 'grn-1', poId: 'po-1', completedBy: 'u-worker', storeId: 'store-1', at: AT, scanCount: 2, commandIds: ['recv-1', 'recv-2'], source: 'warehouse-handheld' });
    expect(isRelayable(RECEIVING_COMPLETED, 'warehouse')).toBe(true);
    expect(isRelayable(RECEIVING_COMPLETED, 'manager')).toBe(false);
    expect(pathFor(item.event)).toBe('/v1/inventory/goods-receipt/grn-1/assembled');
    // Once is enough: the same delivery again is a harmless warning, the queue unchanged; the button goes away.
    expect(s.receivingOpen('grn-1')).toBe(false);
    expect(s.completeReceiving({ grnId: 'grn-1', at: AT })).toMatchObject({ accepted: false, signal: { feedback: 'warn', code: 'duplicate_ignored' } });
    expect(outbox.all()).toHaveLength(3);
    // The completion is listed as its own kind of sent work, newest first, with the same state words.
    expect(s.sentWork().map((w) => [w.kind, w.id, w.what, w.detail, w.state])).toEqual([
      ['receipt_done', 'grn-1', 'grn-1', '2 scans · po-1', 'saved_here'],
      ['receipt', 'recv-2', 'p-rice', '1 EA · grn-1', 'saved_here'],
      ['receipt', 'recv-1', 'p-rice', '1 EA · grn-1', 'saved_here'],
    ]);
    for (const w of s.sentWork()) expect(SENT_WORK_KINDS).toContain(w.kind);
  });

  it('a put-away and a pick carry their command id at the top, and resolve to the synced movement route', () => {
    const { s, outbox } = session();
    s.putAway({ commandId: 'mv-1', scannedProductId: 'p-good', scannedBinId: 'BIN-A', batchId: null, quantityMinor: 6, uom: 'EA', at: AT });
    s.pick({ commandId: 'pk-1', lineId: 'pl-1', scannedBinId: 'BIN-A', scannedItem: '890RICE', at: AT });
    const move = outbox.find('wh-move:mv-1')!;
    const pick = outbox.find('wh-move:pk-1')!;
    expect(move.event.type).toBe(WAREHOUSE_MOVEMENT_APPLIED);
    expect(move.event.payload).toMatchObject({ commandId: 'mv-1', movedBy: 'u-worker', command: { kind: 'put_away', toBinId: 'BIN-A', productId: 'p-good', quantityMinor: 6 } });
    expect(pick.event.payload).toMatchObject({ commandId: 'pk-1', orderRef: 'ORD-77', lineId: 'pl-1', command: { kind: 'pick', fromBinId: 'BIN-A', quantityMinor: 12 } });
    expect(isRelayable(WAREHOUSE_MOVEMENT_APPLIED, 'warehouse')).toBe(true);
    expect(pathFor(move.event)).toBe('/v1/warehouse/movements/mv-1/synced');
    expect(pathFor(pick.event)).toBe('/v1/warehouse/movements/pk-1/synced');
  });
});

describe('the handheld says where each accepted scan is', () => {
  it('lists receipts, put-aways and picks newest first with the five state words, from the device item and the box\'s word', () => {
    const { s, outbox } = session();
    s.receive({ commandId: 'recv-1', grnId: 'grn-1', barcode: '890RICE', scannedQuantity: 1, source: 'po' });
    s.putAway({ commandId: 'mv-1', scannedProductId: 'p-good', scannedBinId: 'BIN-A', batchId: null, quantityMinor: 6, uom: 'EA', at: AT });
    s.pick({ commandId: 'pk-1', lineId: 'pl-1', scannedBinId: 'BIN-A', scannedItem: '890RICE', at: AT });
    // A refused scan queues nothing and so is not "sent work" at all.
    expect(s.putAway({ commandId: 'mv-2', scannedProductId: 'p-nope', scannedBinId: 'BIN-A', batchId: null, quantityMinor: 1, uom: 'EA', at: AT }).signal.feedback).toBe('reject');

    expect(s.sentWork().map((w) => [w.kind, w.id, w.what, w.detail, w.state])).toEqual([
      ['pick', 'pk-1', 'p-rice · BIN-A', '12 EA · ORD-77', 'saved_here'],
      ['put_away', 'mv-1', 'p-good · BIN-A', '6 EA', 'saved_here'],
      ['receipt', 'recv-1', 'p-rice', '1 EA · grn-1', 'saved_here'],
    ]);
    for (const w of s.sentWork()) expect(SENT_WORK_KINDS).toContain(w.kind);

    outbox.recordFailure('recv:grn-1:recv-1');
    expect(s.sentWork().find((w) => w.id === 'recv-1')).toMatchObject({ state: 'retrying', attempts: 1 });
    outbox.acknowledge('recv:grn-1:recv-1');
    outbox.acknowledge('wh-move:mv-1');
    expect(s.handedKeys()).toEqual(['recv:grn-1:recv-1', 'wh-move:mv-1']);
    expect(s.sentWork().find((w) => w.id === 'recv-1')?.state).toBe('handed_to_box');
    // Never "posted" on the handheld's say-so: only the box's word makes it so.
    s.noteBoxStatus([{ key: 'recv:grn-1:recv-1', state: 'pending', attempts: 0 }, { key: 'wh-move:mv-1', state: 'posted', attempts: 0 }]);
    expect(s.sentWork().find((w) => w.id === 'recv-1')?.state).toBe('handed_to_box');
    expect(s.sentWork().find((w) => w.id === 'mv-1')?.state).toBe('posted');
    s.noteBoxStatus([{ key: 'recv:grn-1:recv-1', state: 'refused', attempts: 2, reason: 'the cloud answered 422 for ReceivingScanned (receiver_unknown)' }]);
    expect(s.sentWork().find((w) => w.id === 'recv-1')).toMatchObject({ state: 'refused', reason: expect.stringContaining('422') as string });
    outbox.deadLetter('wh-move:pk-1', 'refused by the store computer: WarehouseMovementApplied is not a record this box relays for picker');
    expect(s.sentWork().find((w) => w.id === 'pk-1')).toMatchObject({ state: 'refused', reason: expect.stringContaining('not a record this box relays') as string });
  });

  it('the relay is wired only when the box served the page, drains as the warehouse surface, and folds the box\'s word back', async () => {
    const outbox = openDeviceOutbox(noDeviceStore(), () => {});
    const s = new WarehouseSession(ASSIGNMENT, outbox, { now: () => AT });
    expect(openWarehouseRelay(undefined, s, outbox)).toBeUndefined();
    s.receive({ commandId: 'recv-1', grnId: 'grn-1', barcode: '890RICE', scannedQuantity: 1, source: 'po' });
    const calls: { url: string; body?: unknown }[] = [];
    const saved = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown });
      if (url.endsWith('/lane/outbox')) return new Response(JSON.stringify({ acks: [{ key: 'recv:grn-1:recv-1', status: 'accepted' }] }), { status: 200 });
      return new Response(JSON.stringify({ items: [{ key: 'recv:grn-1:recv-1', state: 'posted', attempts: 0 }] }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const relay = openWarehouseRelay('', s, outbox)!;
      expect(await relay.syncNow()).toEqual({ handed: 1, refused: 0, failed: 0, offline: false });
      // Same origin: relative paths under the device's cookie, speaking as the warehouse.
      expect(calls[0]).toMatchObject({ url: '/lane/outbox', body: { source: 'warehouse' } });
      expect(calls[1]?.url).toBe('/lane/outbox/status?keys=recv%3Agrn-1%3Arecv-1');
      expect(s.sentWork()[0]?.state).toBe('posted');
    } finally {
      globalThis.fetch = saved;
    }
  });
});
