import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { useRestartableBackings, dayFromToday } from '../support/p3-backings';
import { P3, p3Shop, caller, issuedOrder, received, type Call } from '../support/p3-purchase';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';

// M07-FR-01 "ASN/direct-store-delivery, dock scheduling and receiving" · WF-04 "ASN/PO → dock/count → … → discrepancy"
// (OB-288 P3). (1) The DOCK DIARY is head office's own record: an overlap on a door is refused against the bookings it
// holds, statuses move booked → arrived → completed (or no-show / cancelled, with a reason), a late booking is listed.
// (2) The supplier's ASN accepted on the portal is STORED, offered with the open delivery the store's phone caches, and
// every goods receipt against the order — booked at head office, or assembled from the handheld's offline scans — is
// compared with it, each difference valued on the record and flagged for the review list. In memory and — with
// DATABASE_URL — on real PostgreSQL, with a cold restart.

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const AT = '2026-10-22T09:00:00.000Z';
const DAY = dayFromToday(1); // tomorrow: the bookings are in the future, so none is late
const at = (h: number, m = 0) => `${DAY}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

/** The supplier submits its ASN on the portal; a buyer accepts it — the ASN is then on head office's register. */
async function acceptedAsn(h: ApiHarness, T: string, call: Call, asn: Record<string, unknown>): Promise<void> {
  await h.provisionRole(T, 'u-sup', 'supplier');
  expect((await call('POST', '/v1/supplier-portal/partners/sup-1', P3.BUYER, { grants: ['view_orders', 'submit_asn'], documents: [], requiredDocuments: [], logins: ['u-sup'] })).status).toBe(201);
  expect((await call('POST', '/v1/supplier-portal/me/submissions', 'u-sup', { submissionId: `sub-${String(asn['asnId'])}`, kind: 'asn', document: asn })).status).toBe(201);
  expect((await call('POST', `/v1/supplier-portal/partners/sup-1/submissions/sub-${String(asn['asnId'])}/review`, P3.OWNER, { decision: 'accept', reason: 'booked for dock 2' })).body).toMatchObject({ review: { fed: { asnId: asn['asnId'] } } });
}

describe.each(backings)('the dock diary and the ASN (M07-FR-01 · WF-04) — on $name', ({ harness }) => {
  it('the dock diary refuses an overlap from the bookings it holds, moves statuses with reasons, lists the late, and reads back after a restart', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    const book = (slotId: string, body: Record<string, unknown>, user: string = P3.RECEIVER) => call('POST', `/v1/inventory/dock-diary/${slotId}`, user, { storeId: P3.STORE, dockId: 'D1', ...body });
    const status = (slotId: string, body: Record<string, unknown>) => call('POST', `/v1/inventory/dock-diary/${slotId}/status`, P3.RECEIVER, body);

    expect((await book('s-a', { startsAt: at(10), endsAt: at(11), supplierId: 'sup-1', poIds: ['po-x'] })).status).toBe(201);
    const clash = await book('s-b', { startsAt: at(10, 30), endsAt: at(11, 30) });
    expect([clash.status, codeOf(clash)]).toEqual([409, 'dock_conflict']);
    expect((clash.body as { error: { whatHappened: string } }).error.whatHappened).toContain('s-a');
    expect((await book('s-c', { dockId: 'D2', startsAt: at(10, 30), endsAt: at(11, 30) })).status).toBe(201); // another door
    expect(((await book('s-a', { startsAt: at(10), endsAt: at(11), supplierId: 'sup-1', poIds: ['po-x'] })).body as { alreadyBooked: boolean }).alreadyBooked).toBe(true);
    expect(codeOf(await book('s-a', { startsAt: at(12), endsAt: at(13) }))).toBe('slot_id_already_used');
    expect(codeOf(await book('s-z', { startsAt: at(13), endsAt: at(12) }))).toBe('dock_window_invalid');
    expect((await book('s-q', { startsAt: at(14), endsAt: at(15) }, P3.CASHIER)).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/inventory/dock-diary/s-y', P3.RECEIVER, { storeId: P3.STORE }))).toBe('not_readable_as_a_dock_booking');

    // Statuses: booked → arrived → completed; never backwards; a cancellation says why — and frees the door.
    expect(codeOf(await status('s-a', { status: 'completed' }))).toBe('dock_status_not_allowed');
    expect((await status('s-a', { status: 'arrived' })).status).toBe(200);
    expect((await status('s-a', { status: 'completed' })).status).toBe(200);
    expect(codeOf(await status('s-c', { status: 'cancelled' }))).toBe('reason_required');
    expect((await status('s-c', { status: 'cancelled', reason: 'supplier rang to postpone' })).status).toBe(200);
    expect((await book('s-d', { dockId: 'D2', startsAt: at(10, 30), endsAt: at(11, 30) })).status).toBe(201); // the freed slot
    expect((await status('nope', { status: 'arrived' })).status).toBe(404);

    // A booking in the past that nobody marked: listed as late, never silently dropped.
    expect((await book('s-old', { dockId: 'D3', startsAt: '2026-01-05T08:00:00.000Z', endsAt: '2026-01-05T09:00:00.000Z' })).status).toBe(201);
    const day = (hh: ApiHarness, date?: string) => hh.request({ method: 'GET', path: '/v1/inventory/dock-diary', userId: P3.OWNER, tenantId: T, query: { storeId: P3.STORE, ...(date === undefined ? {} : { date }) } });
    const all = (await day(h)).body as { bookings: { slotId: string; status: string; history: { status: string }[] }[]; late: { slotId: string }[] };
    expect(all.late.map((l) => l.slotId)).toEqual(['s-old']);
    expect(all.bookings.find((b) => b.slotId === 's-a')).toMatchObject({ status: 'completed', history: [{ status: 'booked' }, { status: 'arrived' }, { status: 'completed' }] });
    expect(((await day(h, DAY)).body as { count: number }).count).toBe(3);

    const again = (await day(harness(h), DAY)).body as { bookings: { slotId: string; status: string }[] };
    expect(again.bookings.map((b) => [b.slotId, b.status])).toEqual([['s-a', 'completed'], ['s-c', 'cancelled'], ['s-d', 'booked']]);
  });

  it('a stored ASN rides with the open delivery, and a receipt booked at head office is compared with it — every difference valued and flagged', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    await issuedOrder(call, 'po-1', [{ productId: 'oil', qty: 12, unitMinor: 1_800 }, { productId: 'dal', qty: 5, unitMinor: 1_000 }]);
    // The supplier advises 10 oil and 5 dal for po-1.
    await acceptedAsn(h, T, call, { asnId: 'ASN-7', poId: 'po-1', expectedAt: AT, lines: [{ lineId: 'A1', productId: 'oil', quantityMinor: 10, uom: 'ea' }, { lineId: 'A2', productId: 'dal', quantityMinor: 5, uom: 'ea' }] });

    // Offered with the open delivery (what the store computer caches for the phone).
    const open = (await h.request({ method: 'GET', path: '/v1/purchase/deliveries/open', userId: P3.OWNER, tenantId: T, query: { storeId: P3.STORE } })).body as { deliveries: { poId: string; asn?: { asnId: string; lines: unknown[] } }[] };
    expect(open.deliveries.find((d) => d.poId === 'po-1')?.asn).toMatchObject({ asnId: 'ASN-7', lines: [{ productId: 'oil', quantityMinor: 10, uom: 'ea' }, { productId: 'dal', quantityMinor: 5, uom: 'ea' }] });

    // Booked at head office: 12 oil arrived (2 more than advised), 4 dal (1 fewer) — each difference valued, the receipt flagged.
    const grn = await received(call, 'grn-1', 'po-1', [{ productId: 'oil', qty: 12, unitMinor: 1_800 }, { productId: 'dal', qty: 4, unitMinor: 1_000 }]);
    const g = (grn.body as { grn: { governanceFlags: string[]; asnCheck: { asnId: string; matched: boolean; differences: { productId: string; advisedMinor: number; receivedMinor: number; differenceMinor: number; valueMinor: number }[] } } }).grn;
    expect(g.governanceFlags).toContain('asn_differs');
    expect(g.asnCheck).toMatchObject({ asnId: 'ASN-7', matched: false });
    expect(g.asnCheck.differences).toEqual([
      expect.objectContaining({ productId: 'dal', advisedMinor: 5, receivedMinor: 4, differenceMinor: -1, valueMinor: 1_000 }),
      expect.objectContaining({ productId: 'oil', advisedMinor: 10, receivedMinor: 12, differenceMinor: 2, valueMinor: 3_600 }),
    ]);
  });

  it('the phone\'s offline scans, completed against the cached ASN, are assembled into a receipt compared with head office\'s copy', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    await h.provisionRole(T, 'u-box', 'store_computer', [P3.STORE]);
    await h.store.append(T, STREAM.catalogue, makeEvent({
      id: `pack-${T}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${T}-v1`, source: 'test/catalogue',
      payload: { snapshot: { tenantId: T, version: 1, builtAt: AT, scope: { tenantId: T, storeId: P3.STORE }, products: [
        { productId: 'oil', sku: 'oil', name: 'Oil 1L', unitPriceMinor: 2_000, taxBps: 0, status: 'active', uom: 'ea', batchTracked: false, handling: 'ambient' },
      ] } },
    }));
    await issuedOrder(call, 'po-2', [{ productId: 'oil', qty: 12, unitMinor: 1_800 }]);
    await acceptedAsn(h, T, call, { asnId: 'ASN-9', poId: 'po-2', expectedAt: AT, lines: [{ lineId: 'A1', productId: 'oil', quantityMinor: 12, uom: 'ea' }] });
    // What the phone queued offline — scanned by the receiver — relayed by the box once it reconnected.
    for (const [i, q] of [6, 4].entries()) {
      expect((await call('POST', `/v1/inventory/receiving-scans/c${i}/synced`, 'u-box', {
        commandId: `c${i}`, grnId: 'grn-2', productId: 'oil', batchId: null, quantityMinor: q, uom: 'EA', source: 'po', poId: 'po-2', state: 'on_hand', expiry: null,
        receivedBy: P3.RECEIVER, storeId: P3.STORE, at: AT,
      })).status).toBe(202);
    }
    const done = await call('POST', '/v1/inventory/goods-receipt/grn-2/assembled', 'u-box', { grnId: 'grn-2', poId: 'po-2', completedBy: P3.RECEIVER, storeId: P3.STORE, at: AT, scanCount: 2, commandIds: ['c0', 'c1'], source: 'warehouse-handheld', asnId: 'ASN-9' });
    expect(done.status, JSON.stringify(done.body)).toBe(202);
    const g = (done.body as { grn: { governanceFlags: string[]; asnCheck: { asnId: string; matched: boolean; differences: { productId: string; differenceMinor: number }[] } } }).grn;
    expect(g.asnCheck).toMatchObject({ asnId: 'ASN-9', matched: false, differences: [{ productId: 'oil', differenceMinor: -2 }] });
    expect(g.governanceFlags).toContain('asn_differs');
    // A cold restart reads the comparison back from the receipt.
    expect(((await harness(h).request({ method: 'GET', path: '/v1/inventory/goods-receipt/grn-2', userId: P3.OWNER, tenantId: T })).body as { grn: { asnCheck: unknown } }).grn.asnCheck).toEqual(g.asnCheck);
  });
});
