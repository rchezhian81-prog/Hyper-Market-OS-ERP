import { describe, it, expect } from 'vitest';
import { WarehouseSession, RECEIVING_SCANNED, RECEIVING_COMPLETED, type WarehouseAssignment } from '../../apps/warehouse-app/src/warehouse-session';
import { openDeviceOutbox, type DeviceStore } from '../../packages/sync/src/device-outbox';
import { makeEvent } from '../../packages/contracts/src/event';

/**
 * **D-031 (pending list 27 Nov, item 3): the warehouse handheld HOLDS its receiving scans until "Delivery complete — send the
 * receipt" (P-01 · P-08 · M07-FR-01 · hard rules #2 #6 #10).**
 *
 * Until now every receiving scan was its own record on the phone's queue: it went to the store computer at once and head
 * office put the goods in its stock on arrival — before the person pressed "send". Now:
 *
 *   • a scan is HELD on the phone, in the phone's own storage (it survives a reload, the phone sleeping, the browser being
 *     closed), and nothing is queued for the store computer;
 *   • the person sees what is held and can REMOVE a wrong scan before sending — the removal is kept (who, when) and goes
 *     with the receipt, never silently dropped;
 *   • "send" queues ONE record — the receipt with all its lines — keyed on the delivery, so a retry sends nothing twice;
 *   • a scan of a delivery already sent is refused (its receipt is gone; nothing is received twice);
 *   • scans queued the OLD way (a phone updated mid-delivery) still travel as they are and are named in the receipt.
 */

const AT = '2026-11-27T09:00:00.000Z';
const ASSIGNMENT: WarehouseAssignment = {
  assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1',
  bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' }],
  grnId: 'grn-1', poId: 'po-1',
  ordered: [{ productId: 'p-rice', quantityMinor: 10, unitCost: { minor: 4000, currency: 'INR' } }],
  barcodes: [{ barcode: '890RICE', productId: 'p-rice', level: 'unit' }],
  packs: [{ productId: 'p-rice', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890RICE' }] }],
};

/** A phone's storage: two keys that outlive any one page (a reload builds a new session over the same storage). */
function phoneStorage() {
  const keys = new Map<string, string>();
  const store = (key: string): DeviceStore => ({ read: () => keys.get(key) ?? null, write: (v) => { keys.set(key, v); } });
  return { keys, outbox: store('outbox'), held: store('held') };
}
/** Open the handheld page on that storage — what a reload, or the browser opened again, does. */
function openPage(phone: ReturnType<typeof phoneStorage>, assignment: WarehouseAssignment = ASSIGNMENT) {
  const outbox = openDeviceOutbox(phone.outbox, () => {});
  const s = new WarehouseSession(assignment, outbox, { now: () => AT, held: phone.held } as ConstructorParameters<typeof WarehouseSession>[2]);
  return { outbox, s, held: s as unknown as HeldApi };
}
interface HeldApi {
  heldReceipt(grnId: string): { grnId: string; scans: { commandId: string; productId: string; quantityMinor: number; state: string }[]; removed: { commandId: string; removedBy: string; removedAt: string }[] };
  removeHeldScan(input: { grnId: string; commandId: string; at?: string }): { removed: boolean; signal: { feedback: string; code: string } };
}
const scan = (s: WarehouseSession, commandId: string, qty = 1, extra: Record<string, unknown> = {}) =>
  s.receive({ commandId, grnId: 'grn-1', barcode: '890RICE', scannedQuantity: qty, source: 'po', ...extra });

describe('D-031: receiving scans wait on the phone until "Delivery complete — send"', () => {
  it('a scan is held on the phone: nothing is queued for the store computer, and the held list shows it', () => {
    const phone = phoneStorage();
    const { s, outbox, held } = openPage(phone);
    expect(scan(s, 'recv-1', 4).signal.code).toBe('received');
    expect(outbox.all().filter((i) => i.event.type === RECEIVING_SCANNED)).toHaveLength(0);
    expect(outbox.unsentCount()).toBe(0);
    expect(held.heldReceipt('grn-1').scans).toEqual([expect.objectContaining({ commandId: 'recv-1', productId: 'p-rice', quantityMinor: 4, state: 'on_hand' })]);
    expect(s.receivingOpen('grn-1')).toBe(true);
    // Not on the put-away list yet: it is not stock until the receipt is sent.
    expect(s.goodsIn().find((g) => g.productId === 'p-rice')).toBeUndefined();
  });

  it('held scans survive a reload (the browser closed and opened again): the same list, the send button still offered, the order still counted', () => {
    const phone = phoneStorage();
    const first = openPage(phone);
    scan(first.s, 'recv-1', 6);
    scan(first.s, 'recv-2', 3);
    const again = openPage(phone);
    expect(again.held.heldReceipt('grn-1').scans.map((x) => [x.commandId, x.quantityMinor])).toEqual([['recv-1', 6], ['recv-2', 3]]);
    expect(again.s.receivingOpen('grn-1')).toBe(true);
    // 9 of the order's 10 are held: 2 more is an over-delivery — the held scans count after the reload too.
    expect(scan(again.s, 'recv-3', 2).signal.code).toBe('over_delivery_needs_approval');
    // The same scan id again (a double tap before the reload) is not a second scan.
    expect(scan(again.s, 'recv-1', 6).result.accepted).toBe(false);
  });

  it('a wrong scan is removed before sending — the removal is kept (who, when), survives a reload, and the order count drops back', () => {
    const phone = phoneStorage();
    const { s, held } = openPage(phone);
    scan(s, 'recv-1', 9);
    scan(s, 'recv-2', 1);
    const out = held.removeHeldScan({ grnId: 'grn-1', commandId: 'recv-1', at: '2026-11-27T09:05:00.000Z' });
    expect(out).toMatchObject({ removed: true, signal: { feedback: 'accept', code: 'scan_removed' } });
    expect(held.removeHeldScan({ grnId: 'grn-1', commandId: 'recv-1' })).toMatchObject({ removed: false, signal: { code: 'scan_not_held' } });
    const again = openPage(phone);
    expect(again.held.heldReceipt('grn-1').scans.map((x) => x.commandId)).toEqual(['recv-2']);
    expect(again.held.heldReceipt('grn-1').removed).toEqual([expect.objectContaining({ commandId: 'recv-1', removedBy: 'u-worker', removedAt: '2026-11-27T09:05:00.000Z' })]);
    // 1 held of 10 ordered: 9 more is no longer an over-delivery.
    expect(scan(again.s, 'recv-3', 9).signal.code).toBe('received');
  });

  it('"send" queues ONE receipt with every held line and every removal, keyed on the delivery; a second send and a later scan change nothing', () => {
    const phone = phoneStorage();
    const { s, outbox, held } = openPage(phone);
    scan(s, 'recv-1', 2);
    scan(s, 'recv-2', 1, { qcFailed: true, mrpMinor: 4500 });
    scan(s, 'recv-x', 1);
    held.removeHeldScan({ grnId: 'grn-1', commandId: 'recv-x', at: AT });
    const done = s.completeReceiving({ grnId: 'grn-1', at: AT });
    expect(done).toMatchObject({ accepted: true, scanCount: 2, signal: { code: 'receiving_done' } });
    expect(outbox.all().map((i) => [i.key, i.event.type])).toEqual([['recv-done:grn-1', RECEIVING_COMPLETED]]);
    const p = outbox.find('recv-done:grn-1')!.event.payload as Record<string, unknown>;
    expect(p).toMatchObject({ grnId: 'grn-1', poId: 'po-1', completedBy: 'u-worker', storeId: 'store-1', scanCount: 2, commandIds: ['recv-1', 'recv-2'] });
    expect(p['scans']).toEqual([
      expect.objectContaining({ commandId: 'recv-1', productId: 'p-rice', quantityMinor: 2, state: 'on_hand', receivedBy: 'u-worker' }),
      expect.objectContaining({ commandId: 'recv-2', productId: 'p-rice', quantityMinor: 1, state: 'quarantine', qcFailed: true, mrpMinor: 4500 }),
    ]);
    expect(p['removed']).toEqual([expect.objectContaining({ commandId: 'recv-x', quantityMinor: 1, removedBy: 'u-worker', removedAt: AT })]);
    // Sent: nothing is held any more, the put-away list now has the good units, the button goes away.
    expect(held.heldReceipt('grn-1').scans).toEqual([]);
    expect(s.receivingOpen('grn-1')).toBe(false);
    expect(s.goodsIn().find((g) => g.productId === 'p-rice' && g.state === 'on_hand')?.quantityMinor).toBe(2);
    // Again: harmless; a later scan of the same delivery is refused, nothing queued or held.
    expect(s.completeReceiving({ grnId: 'grn-1', at: AT }).signal.code).toBe('duplicate_ignored');
    expect(scan(s, 'recv-9', 1).signal.code).toBe('receipt_already_sent');
    expect(outbox.all()).toHaveLength(1);
    expect(held.heldReceipt('grn-1').scans).toEqual([]);
    // After a reload the delivery is still sent (the queue remembers), and nothing is held.
    const again = openPage(phone);
    expect(again.s.receivingOpen('grn-1')).toBe(false);
    expect(again.held.heldReceipt('grn-1').scans).toEqual([]);
  });

  it('a phone that stopped between queuing the receipt and clearing its held list holds nothing twice after a reload', () => {
    const phone = phoneStorage();
    const { s } = openPage(phone);
    scan(s, 'recv-1', 2);
    const heldBefore = phone.keys.get('held')!;
    s.completeReceiving({ grnId: 'grn-1', at: AT });
    phone.keys.set('held', heldBefore); // the held list was not yet cleared when the phone died
    const again = openPage(phone);
    expect(again.held.heldReceipt('grn-1').scans).toEqual([]);
    expect(again.s.receivingOpen('grn-1')).toBe(false);
    expect(again.outbox.all()).toHaveLength(1);
  });

  it('scans queued the OLD way before the update still travel as they are; the receipt names them and carries only the held ones', () => {
    const phone = phoneStorage();
    const old = openDeviceOutbox(phone.outbox, () => {});
    old.enqueue(makeEvent({
      id: 'recv-grn-1-old-1', type: RECEIVING_SCANNED, occurredAt: AT, idempotencyKey: 'recv:grn-1:old-1', source: 'A-1',
      payload: { grnId: 'grn-1', commandId: 'old-1', productId: 'p-rice', batchId: null, quantityMinor: 3, uom: 'EA', source: 'po', poId: 'po-1', state: 'on_hand', expiry: null, receivedBy: 'u-worker', storeId: 'store-1', at: AT },
    }));
    const { s, outbox } = openPage(phone);
    expect(s.receivingOpen('grn-1')).toBe(true);
    scan(s, 'recv-1', 2);
    const done = s.completeReceiving({ grnId: 'grn-1', at: AT });
    expect(done).toMatchObject({ accepted: true, scanCount: 2 });
    expect(outbox.all().map((i) => i.key)).toEqual(['recv:grn-1:old-1', 'recv-done:grn-1']);
    const p = outbox.find('recv-done:grn-1')!.event.payload as { commandIds: string[]; scans: { commandId: string }[] };
    expect(p.commandIds).toEqual(['old-1', 'recv-1']);
    expect(p.scans.map((x) => x.commandId)).toEqual(['recv-1']);
  });

  it('nothing is overwritten when the held list cannot be read: a scan is refused and the saved value is left as it was', () => {
    const phone = phoneStorage();
    phone.keys.set('held', '{not json');
    const { s, outbox } = openPage(phone);
    expect(scan(s, 'recv-1', 1).signal.code).toBe('held_scans_unreadable');
    expect(phone.keys.get('held')).toBe('{not json');
    expect(outbox.all()).toHaveLength(0);
  });
});
