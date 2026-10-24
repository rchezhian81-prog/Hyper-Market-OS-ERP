import { describe, it, expect } from 'vitest';
import { useRestartableBackings } from '../support/p3-backings';
import { fulfilmentShop, codeOf, OWNER, DISPATCHER, PICKER, CASHIER, STORE_ID, DOORS } from '../support/fulfilment-shop';

// M19-FR-01 · WF-14 · OB-300 — the dispatcher builds a picker's wave from CONFIRMED orders: the bin from the store's bin
// register, the name and price from the store's pack (never typed); an order with any line that has no bin stays out WHOLE
// with its reason (never split); an order already on an open wave is not offered or picked twice; the picker is
// re-verified; the wave lands on the SAME register the box pulls for the picker's phone; the board says how far each wave
// has got. 403 for a cashier. In memory and — with DATABASE_URL — on real PostgreSQL, with a cold restart. Synthetic data.

const backings = useRestartableBackings();

describe.each(backings)('the dispatcher builds a wave from confirmed orders (M19-FR-01 · WF-14) — on $name', ({ harness }) => {
  it('candidates → build (bins from the register, prices from the pack, an unbinned order kept out whole) → the box pulls it → the board → a restart reads the same', async () => {
    const h = harness();
    const shop = await fulfilmentShop(h, { oilUnbinned: true });
    await shop.placeConfirmed('c-1', 'ORD-1', [['RICE', 2], ['DAL', 1]], 1, DOORS.near);
    await shop.placeConfirmed('c-2', 'ORD-2', [['RICE', 1], ['OIL', 1]], 1, DOORS.mid); // OIL is only in a holding bin
    // Placed but not confirmed: not offered.
    await shop.ok('POST', '/v1/storefront/orders/ORD-3', 'c-3', { lines: [{ productId: 'DAL', quantityMinor: 1 }], locationId: STORE_ID, fulfilment: 'delivery', deliverySlot: { startsAt: shop.slots[2]!.startsAt }, deliveryLocation: DOORS.far });

    const cand = await shop.ok('GET', '/v1/fulfilment/wave-candidates', DISPATCHER, undefined, { storeId: STORE_ID });
    expect((cand['ready'] as { orderId: string }[]).map((o) => o.orderId)).toEqual(['ORD-1', 'ORD-2']);
    expect((cand['ready'] as { slot: { startsAt: string } }[])[0]!.slot.startsAt).toBe(shop.slots[1]!.startsAt);
    // Nobody but a wave builder; a cashier is refused.
    expect((await shop.call('GET', '/v1/fulfilment/wave-candidates', CASHIER, undefined, { storeId: STORE_ID })).status).toBe(403);
    expect((await shop.call('POST', '/v1/fulfilment/waves/W-1/build', CASHIER, { storeId: STORE_ID, pickerId: PICKER, orderIds: ['ORD-1'] })).status).toBe(403);
    // A picker nobody knows, and a cashier as the picker, are refused by name — nothing assigned.
    expect(codeOf(await shop.call('POST', '/v1/fulfilment/waves/W-1/build', DISPATCHER, { storeId: STORE_ID, pickerId: 'u-nobody', orderIds: ['ORD-1'] }))).toBe('picker_unknown');
    expect(codeOf(await shop.call('POST', '/v1/fulfilment/waves/W-1/build', DISPATCHER, { storeId: STORE_ID, pickerId: CASHIER, orderIds: ['ORD-1'] }))).toBe('picker_lacks_authority');
    expect(codeOf(await shop.call('POST', '/v1/fulfilment/waves/W-1/build', DISPATCHER, { storeId: STORE_ID, pickerId: PICKER, orderIds: [] }))).toBe('not_readable_as_a_wave_build');

    // Build: ORD-1 goes on whole; ORD-2 stays out WHOLE (OIL has no pickable bin) — never half-picked; ORD-3 is not confirmed.
    const built = await shop.call('POST', '/v1/fulfilment/waves/W-1/build', DISPATCHER, { storeId: STORE_ID, pickerId: PICKER, orderIds: ['ORD-1', 'ORD-2', 'ORD-3', 'ORD-404'] });
    expect(built.status, JSON.stringify(built.body)).toBe(201);
    const b = built.body as { orderIds: string[]; lines: { lineId: string; bin: string; unitPriceMinor: number; description: string; requiredQty: number }[]; refused: { orderId: string; reason: string }[] };
    expect(b.orderIds).toEqual(['ORD-1']);
    expect(b.lines).toEqual([
      expect.objectContaining({ lineId: 'ORD-1:RICE', bin: 'A-01', unitPriceMinor: 80_00, description: 'Synthetic RICE', requiredQty: 2 }),
      expect.objectContaining({ lineId: 'ORD-1:DAL', bin: 'A-02', unitPriceMinor: 75_00, description: 'Synthetic DAL', requiredQty: 1 }),
    ]);
    expect(b.refused.map((r) => [r.orderId, r.reason])).toEqual([['ORD-3', 'not_confirmed'], ['ORD-404', 'not_at_this_store'], ['ORD-2', 'no_bin']]);

    // The same build again is the same record; a second wave cannot take ORD-1 while W-1 is open.
    expect((await shop.call('POST', '/v1/fulfilment/waves/W-1/build', DISPATCHER, { storeId: STORE_ID, pickerId: PICKER, orderIds: ['ORD-1'] })).body).toMatchObject({ alreadyAssigned: true });
    const twice = await shop.call('POST', '/v1/fulfilment/waves/W-2/build', DISPATCHER, { storeId: STORE_ID, pickerId: PICKER, orderIds: ['ORD-1'] });
    expect(twice.status).toBe(422);
    expect((twice.body as { error: { refused: { reason: string }[] } }).error.refused[0]!.reason).toBe('on_another_wave');

    // ORD-1 is no longer offered; it is "already on a wave".
    const after = await shop.ok('GET', '/v1/fulfilment/wave-candidates', DISPATCHER, undefined, { storeId: STORE_ID });
    expect((after['ready'] as { orderId: string }[]).map((o) => o.orderId)).toEqual(['ORD-2']);
    expect(after['onWave']).toEqual([expect.objectContaining({ orderId: 'ORD-1', waveId: 'W-1' })]);

    // The box pulls it for the picker's phone — the same register the assignment route writes.
    const pulled = await shop.ok('GET', '/v1/fulfilment/assignments', OWNER, undefined, { storeId: STORE_ID });
    expect(pulled['waves']).toEqual([expect.objectContaining({ waveId: 'W-1', pickerId: PICKER, assignedBy: DISPATCHER })]);

    // The picker's phone relays a picked line and a short line; the board says so.
    for (const [lineId, state, qty] of [['ORD-1:RICE', 'picked', 2], ['ORD-1:DAL', 'short', 0]] as const) {
      await shop.ok('POST', `/v1/fulfilment/waves/W-1/lines/${lineId}/synced`, OWNER, { waveId: 'W-1', lineId, orderRef: 'ORD-1', productId: lineId.split(':')[1], state, pickedQty: qty, uom: 'each', finalPriceMinor: state === 'picked' ? 160_00 : 0, currency: 'INR', substituted: false, note: state === 'short' ? 'none on the shelf' : null, pickedBy: PICKER, occurredAt: new Date().toISOString() });
    }
    const board = await shop.ok('GET', '/v1/fulfilment/wave-board', DISPATCHER, undefined, { storeId: STORE_ID });
    expect(board['waves']).toEqual([expect.objectContaining({ waveId: 'W-1', stage: 'picking', picked: 1, short: 1, notYet: 0, packed: false })]);

    // A cold restart: a fresh head office over the same store reads the same wave and the same board.
    const again = harness(h);
    const board2 = (await again.request({ method: 'GET', path: '/v1/fulfilment/wave-board', userId: DISPATCHER, tenantId: shop.t, query: { storeId: STORE_ID } })).body as { waves: unknown[] };
    expect(board2.waves).toEqual(board['waves']);
  }, 60_000);
});
