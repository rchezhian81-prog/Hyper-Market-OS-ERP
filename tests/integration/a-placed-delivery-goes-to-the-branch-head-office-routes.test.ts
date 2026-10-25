import { describe, it, expect } from 'vitest';
import { useRestartableBackings } from '../support/p3-backings';
import { fulfilmentShop, codeOf, OWNER, DISPATCHER, STORE, STORE_ID, DOORS } from '../support/fulfilment-shop';

// D09-FR-01 · OB-300 (owner, 23 Oct 2026: an online order is NEVER split across branches) — enforced where it matters: when
// the customer PLACES the order (`POST /v1/storefront/orders/:orderId`), not only when the app asks first. Head office runs
// the tested `routeOrder` on its own facts and places the order at the nearest branch that holds the WHOLE order with room
// in the slot — whatever store the app named. When no single branch holds every line, the nearest branch in range takes it
// and the as-built shortage path applies there (the customer decides) — one branch, never two parcels. An address no
// branch reaches is refused before anything is reserved; a dark store takes no collection. The decision the order was
// placed on is kept and counts against that branch's slot. In memory and on real PostgreSQL, with a cold restart.
//
// OB-355 (owner, 24 Oct 2026, in writing: "an online order no single branch can fill — the nearest branch in range takes
// it; the existing shortage path lets the customer decide", as built) is PINNED here: ORD-C below — dal and sixty oil,
// which no one branch holds — goes to the nearest branch in range with `needsCustomerDecision` and its shortage listed,
// and nothing is held at the other branch.

const backings = useRestartableBackings();
const DARK = { lat: 11.0400, lon: 76.9800 }; // a dark store ~3.5 km from the shop
const TOO_FAR = { lat: 11.5000, lon: 77.5000 }; // ~80 km — no branch reaches it

describe.each(backings)('a placed delivery goes to the branch head office routes it to (D09-FR-01 · OB-300 · OB-355) — on $name', ({ harness }) => {
  it('the app\'s store is a request; the nearest whole-order branch with room takes it; a full slot falls through; never split; refused out of range', async () => {
    const h = harness();
    const shop = await fulfilmentShop(h);
    const now = new Date().toISOString();
    for (const [id, productId, qty] of [['d-rice', 'RICE', 10], ['d-oil', 'OIL', 100]] as const) {
      await shop.ok('POST', '/v1/inventory/movements', OWNER, { movementId: id, productId, locationId: 'D1', kind: 'received', quantityMinor: qty, uom: 'each', unitCostMinor: 1, occurredAt: now, enteredBy: OWNER });
    }
    await shop.ok('POST', `/v1/delivery/locations/${STORE_ID}`, DISPATCHER, { kind: 'store', ...STORE, acceptsPickup: true, acceptsDelivery: true, deliveryRadiusMetres: 10_000, capacityPerSlot: 1 });
    await shop.ok('POST', '/v1/delivery/locations/D1', DISPATCHER, { kind: 'dark_store', ...DARK, acceptsPickup: false, acceptsDelivery: true, deliveryRadiusMetres: 8_000 });
    const slot = shop.slots[2]!.startsAt;
    const place = (customer: string, orderId: string, lines: [string, number][], locationId: string, door: { lat: number; lon: number } = DOORS.near) =>
      shop.call('POST', `/v1/storefront/orders/${orderId}`, customer, { lines: lines.map(([productId, quantityMinor]) => ({ productId, quantityMinor })), locationId, fulfilment: 'delivery', deliverySlot: { startsAt: slot }, deliveryLocation: door });

    // The app named the dark store; the shop is nearer, holds it and has room — the order is placed THERE, said so.
    const a = await place('c-1', 'ORD-A', [['RICE', 1]], 'D1');
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ locationId: STORE_ID, routing: { locationId: STORE_ID, requestedLocationId: 'D1', outcome: 'routed', splitAcrossBranches: false } });
    // The shop's one place in that slot is now taken by ORD-A's kept decision: the next falls through to the dark store.
    const b = await place('c-2', 'ORD-B', [['RICE', 1]], STORE_ID);
    expect(b.body).toMatchObject({ locationId: 'D1', routing: { locationId: 'D1', requestedLocationId: STORE_ID, outcome: 'routed' } });
    // OB-355 — Dal and sixty oil: no one branch holds both — the nearest in range takes it and the customer decides on the
    // shortage (the as-built path). Never two parcels: nothing is held at the dark store.
    const c = await shop.call('POST', '/v1/storefront/orders/ORD-C', 'c-3', { lines: [{ productId: 'DAL', quantityMinor: 1 }, { productId: 'OIL', quantityMinor: 60 }], locationId: 'D1', fulfilment: 'delivery', deliverySlot: { startsAt: shop.slots[3]!.startsAt }, deliveryLocation: DOORS.near });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ locationId: STORE_ID, needsCustomerDecision: true, routing: { locationId: STORE_ID, outcome: 'no_location_with_stock', splitAcrossBranches: false } });
    expect((c.body as { shortages: unknown[] }).shortages).toEqual([{ productId: 'OIL', requestedMinor: 60, promisedMinor: 50 }]);

    // An address no branch reaches: refused before anything is reserved or charged — the order does not exist.
    const far = await place('c-1', 'ORD-F', [['RICE', 1]], STORE_ID, TOO_FAR);
    expect([far.status, codeOf(far)]).toEqual([409, 'no_location_in_range']);
    expect((await shop.call('GET', '/v1/storefront/orders/ORD-F', 'c-1')).status).toBe(404);
    // A dark store has no shop floor: a collection there is refused; at the shop it is placed as the customer chose.
    const pick = (orderId: string, locationId: string) => shop.call('POST', `/v1/storefront/orders/${orderId}`, 'c-2', { lines: [{ productId: 'OIL', quantityMinor: 1 }], locationId, fulfilment: 'pickup' });
    expect(codeOf(await pick('ORD-P1', 'D1'))).toBe('pickup_not_available_here');
    expect(((await pick('ORD-P2', STORE_ID)).body as { locationId: string }).locationId).toBe(STORE_ID);

    // Staff read the decision each order was placed on, with its reason; a restart reads the same.
    const hist = await shop.ok('GET', '/v1/fulfilment/orders/ORD-B/routing', DISPATCHER);
    expect(hist['latest']).toMatchObject({ customerRef: 'c-2', method: 'scheduled_delivery', slotStartsAt: slot, result: { locationId: 'D1', outcome: 'routed' } });
    const again = harness(h);
    const hist2 = (await again.request({ method: 'GET', path: '/v1/fulfilment/orders/ORD-B/routing', userId: DISPATCHER, tenantId: shop.t })).body as { decisions: unknown };
    expect(hist2.decisions).toEqual(hist['decisions']);
    const order = (await again.request({ method: 'GET', path: '/v1/storefront/orders/ORD-A', userId: 'c-1', tenantId: shop.t })).body as { locationId: string };
    expect(order.locationId).toBe(STORE_ID);
  }, 90_000);
});
