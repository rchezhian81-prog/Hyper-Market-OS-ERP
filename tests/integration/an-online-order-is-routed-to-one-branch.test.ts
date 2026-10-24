import { describe, it, expect } from 'vitest';
import { useRestartableBackings } from '../support/p3-backings';
import { fulfilmentShop, codeOf, OWNER, DISPATCHER, CASHIER, STORE, STORE_ID, DOORS } from '../support/fulfilment-shop';

// D09-FR-01 · M18-FR-03 · R8-1 · OB-300 (owner, 23 Oct 2026: an online order is NEVER split across branches) — the tested
// `routeOrder` wired to head office's own facts: the branches and dark stores the manager recorded, what each can promise
// now (on hand less what is held for other orders), and each one's room in a slot. The nearest branch that holds the WHOLE
// order and has room is chosen and the reason recorded; a full slot falls through to the next; a basket no single branch
// holds is "not routed" with the branches listed — never two parcels. A customer routes only their own basket. In memory
// and on real PostgreSQL, with a cold restart. Synthetic data.

const backings = useRestartableBackings();
const DARK = { lat: 11.0400, lon: 76.9800 }; // a dark store ~3.5 km from the shop

describe.each(backings)('an online order is routed to ONE branch (D09-FR-01 · OB-300) — on $name', ({ harness }) => {
  it('records the branches; chooses the nearest that holds all of it with room; a full slot falls through; never split; a restart', async () => {
    const h = harness();
    const shop = await fulfilmentShop(h);
    const now = new Date().toISOString();
    // The dark store holds rice and plenty of oil; the shop holds 50 of each product (the fixture).
    for (const [id, productId, qty] of [['d-rice', 'RICE', 10], ['d-oil', 'OIL', 100]] as const) {
      await shop.ok('POST', '/v1/inventory/movements', OWNER, { movementId: id, productId, locationId: 'D1', kind: 'received', quantityMinor: qty, uom: 'each', unitCostMinor: 1, occurredAt: now, enteredBy: OWNER });
    }
    // The register: only a manager or the owner; a dark store takes no collection.
    expect((await shop.call('POST', '/v1/delivery/locations/L1', CASHIER, { kind: 'store', ...STORE, acceptsPickup: true, acceptsDelivery: true, deliveryRadiusMetres: 10_000 })).status).toBe(403);
    expect(codeOf(await shop.call('POST', '/v1/delivery/locations/D1', DISPATCHER, { kind: 'dark_store', ...DARK, acceptsPickup: true, acceptsDelivery: true, deliveryRadiusMetres: 8_000 }))).toBe('not_readable_as_a_location');
    await shop.ok('POST', `/v1/delivery/locations/${STORE_ID}`, DISPATCHER, { kind: 'store', ...STORE, acceptsPickup: true, acceptsDelivery: true, deliveryRadiusMetres: 10_000, capacityPerSlot: 1 });
    await shop.ok('POST', '/v1/delivery/locations/D1', DISPATCHER, { kind: 'dark_store', ...DARK, acceptsPickup: false, acceptsDelivery: true, deliveryRadiusMetres: 8_000, expressMinutes: 30 });
    expect(((await shop.ok('GET', '/v1/delivery/locations', DISPATCHER))['locations'] as { locationId: string }[]).map((l) => l.locationId)).toEqual(['D1', STORE_ID]);

    const slot = shop.slots[2]!.startsAt;
    const route = (customer: string, orderId: string, body: Record<string, unknown>) => shop.call('POST', `/v1/storefront/route-order/${orderId}`, customer, body);
    const del = (lines: [string, number][]) => ({ method: 'scheduled_delivery', deliverTo: DOORS.near, slotStartsAt: slot, lines: lines.map(([productId, quantityMinor]) => ({ productId, quantityMinor })) });

    // The nearest with the whole order and room: the shop, with the reason recorded.
    const a = await route('c-1', 'ORD-A', del([['RICE', 1]]));
    expect(a.body).toMatchObject({ routed: true, outcome: 'routed', locationId: STORE_ID, splitAcrossBranches: false });
    expect((a.body as { detail: string }).detail).toMatch(/nearest with the whole order in stock and room in the slot/);
    // The shop's one place in that slot is taken: the next customer falls through to the dark store.
    expect((await route('c-2', 'ORD-B', del([['RICE', 1]]))).body).toMatchObject({ routed: true, locationId: 'D1' });
    // Sixty oil: only the dark store holds that many — and it holds rice too: the whole order goes there.
    expect((await route('c-3', 'ORD-C', { ...del([['RICE', 1], ['OIL', 60]]), slotStartsAt: shop.slots[3]!.startsAt })).body).toMatchObject({ routed: true, locationId: 'D1' });
    // Dal and sixty oil: no one branch holds both — NOT routed, the branches named, never two parcels (OB-300).
    const split = await route('c-3', 'ORD-D', { ...del([['DAL', 1], ['OIL', 60]]), slotStartsAt: shop.slots[3]!.startsAt });
    expect(split.body).toMatchObject({ routed: false, outcome: 'no_location_with_stock', splitAcrossBranches: false });
    expect((split.body as { alternatives: { locationId: string }[] }).alternatives.map((x) => x.locationId).sort()).toEqual(['D1', STORE_ID]);
    // A collection never goes to the dark store.
    expect((await route('c-1', 'ORD-E', { method: 'pickup', lines: [{ productId: 'OIL', quantityMinor: 1 }] })).body).toMatchObject({ routed: true, locationId: STORE_ID });

    // Placing at the chosen branch; then the order is not re-routed, and nobody else may route it.
    await shop.ok('POST', '/v1/storefront/orders/ORD-A', 'c-1', { lines: [{ productId: 'RICE', quantityMinor: 1 }], locationId: STORE_ID, fulfilment: 'delivery', deliverySlot: { startsAt: slot }, deliveryLocation: DOORS.near });
    expect(codeOf(await route('c-1', 'ORD-A', del([['RICE', 1]])))).toBe('already_placed');
    expect([(await route('c-2', 'ORD-A', del([['RICE', 1]]))).status, codeOf(await route('c-2', 'ORD-A', del([['RICE', 1]])))]).toEqual([403, 'not_your_order']);
    expect(codeOf(await route('c-1', 'ORD-X', { method: 'scheduled_delivery', lines: [{ productId: 'RICE', quantityMinor: 1 }] }))).toBe('not_readable_as_a_routing_request');
    expect((await route(CASHIER, 'ORD-Y', del([['RICE', 1]]))).status).toBe(403);

    // Staff read every decision with its reason; a restart reads the same.
    const hist = await shop.ok('GET', '/v1/fulfilment/orders/ORD-B/routing', DISPATCHER);
    expect(hist['latest']).toMatchObject({ customerRef: 'c-2', result: { locationId: 'D1', outcome: 'routed' } });
    const again = harness(h);
    const hist2 = (await again.request({ method: 'GET', path: '/v1/fulfilment/orders/ORD-B/routing', userId: DISPATCHER, tenantId: shop.t })).body as { decisions: unknown };
    expect(hist2.decisions).toEqual(hist['decisions']);
  }, 90_000);
});
