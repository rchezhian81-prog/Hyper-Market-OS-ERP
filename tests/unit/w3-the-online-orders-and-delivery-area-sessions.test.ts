import { describe, it, expect } from 'vitest';
import { createOnlineOrdersSession, readOrderList, NEXT_STEPS, ONLINE_ORDERS_COPY } from '../../apps/web-erp/src/online-orders-session';
import { createDeliveryAreaSession, areaShown, DELIVERY_AREA_COPY } from '../../apps/web-erp/src/delivery-area-session';
import { canTransition, type OrderEvent, type OrderState } from '../../packages/orders/src/lifecycle';

// W3 · M18-FR-01 / FR-02 / FR-03 / FR-04 · D05-FR-03: the Online orders desk and the Delivery area page are thin clients over
// head office's own routes. These prove the requests they make, the cheap refusals made before any request, the lifecycle
// buttons matching head office's own state machine, a channel list never silently shortened, and "not set" for any figure
// the owner has not typed (the standard 10 km is never shown as his).

type Seen = { method: string; path: string; body: Record<string, unknown> | undefined };
const recorder = (answer: (path: string) => unknown = () => ({})) => {
  const seen: Seen[] = [];
  const fetch = (async (path: string, init?: { method?: string; body?: string }) => {
    seen.push({ method: init?.method ?? 'GET', path: String(path), body: init?.body === undefined ? undefined : JSON.parse(init.body) as Record<string, unknown> });
    return new Response(JSON.stringify(answer(String(path))), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { seen, fetch };
};
const DESK = ['order.read', 'order.lifecycle.manage', 'order.backorder.manage', 'order.payment.record', 'order.reservation.read', 'inventory.availability.read', 'inventory.online.buffer.set'];

describe('the Online orders session (M18-FR-01/02/04 · D05-FR-03)', () => {
  it('offers exactly the steps head office\'s lifecycle allows from each state', () => {
    const states: OrderState[] = ['placed', 'confirmed', 'picking', 'packed', 'dispatched', 'delivered', 'collected', 'returned', 'cancelled'];
    const events: OrderEvent[] = ['confirm', 'pick', 'pack', 'dispatch', 'deliver', 'collect', 'return', 'cancel'];
    for (const s of states) expect([...NEXT_STEPS[s]!].sort(), s).toEqual(events.filter((e) => canTransition(s, e)).sort());
  });

  it('reads an order with its backorders and payment; moves, backorders and settles through head office\'s own routes', async () => {
    const { seen, fetch } = recorder((p) => (p.endsWith('/backorders') ? { backorders: [] } : p.endsWith('/refunds') ? { payment: { state: 'pending' } } : { orderId: 'o-1', state: 'placed', locationId: 'br-1', lines: [], reservations: [] }));
    const s = createOnlineOrdersSession({ viewer: { userId: 'u-mgr', permissions: DESK }, fetch, newKey: () => 'k' });
    const o = await s.order(' o-1 ');
    expect(o).toEqual({ result: 'ok', value: { orderId: 'o-1', state: 'placed', locationId: 'br-1', lines: [], reservations: [], backorders: [], payment: { state: 'pending' } } });
    await s.move('o-1', 'cancel');
    await s.backorder('o-1');
    await s.settle('o-1', 'authorised', ' STMT-1 ');
    await s.reservations(' br-1 ');
    await s.availability('br-1');
    await s.setBuffer({ locationId: 'br-1', productId: ' ', units: '3', reason: ' keep for walk-ins ' });
    await s.setBuffer({ locationId: 'br-1', productId: 'MILK', units: '0', reason: 'none for milk' });
    expect(seen.map((x) => `${x.method} ${x.path}`)).toEqual([
      'GET /v1/orders/o-1', 'GET /v1/orders/o-1/backorders', 'GET /v1/orders/o-1/refunds',
      'POST /v1/orders/o-1/transition', 'POST /v1/orders/o-1/backorder', 'POST /v1/orders/o-1/payment/resolution',
      'GET /v1/orders/reservations?locationId=br-1', 'GET /v1/inventory/online-availability?locationId=br-1',
      'POST /v1/inventory/online-buffer', 'POST /v1/inventory/online-buffer',
    ]);
    expect(seen[3]!.body).toEqual({ event: 'cancel' });
    expect(seen[5]!.body).toEqual({ result: 'authorised', evidenceRef: 'STMT-1' });
    // Blank product = one figure for every product at the store (head office's own `productId: null`).
    expect(seen[8]!.body).toEqual({ locationId: 'br-1', productId: null, bufferMinor: 3, reason: 'keep for walk-ins' });
    expect(seen[9]!.body).toEqual({ locationId: 'br-1', productId: 'MILK', bufferMinor: 0, reason: 'none for milk' });
  });

  it('an answer head office would not give (another permission) is left out — never shown as "none"', async () => {
    const fetch = (async (path: string) => (String(path).endsWith('/backorders')
      ? new Response(JSON.stringify({ error: { code: 'forbidden', whatHappened: 'no' } }), { status: 403 })
      : new Response(JSON.stringify({ orderId: 'o-1', state: 'placed', locationId: 'br-1', lines: [], reservations: [] }), { status: 200 }))) as unknown as typeof globalThis.fetch;
    const s = createOnlineOrdersSession({ viewer: { userId: 'u-mgr', permissions: DESK }, fetch });
    const o = await s.order('o-1');
    expect(o.result === 'ok' && 'backorders' in o.value).toBe(false);
  });

  it('compares two lists both ways; a line it cannot read is named, never dropped', async () => {
    expect(readOrderList('o-1, 1,250.50, delivered\n\n o-2\t60\tPlaced ')).toEqual({ ok: true, orders: [{ orderId: 'o-1', valueMinor: 125_050, state: 'delivered' }, { orderId: 'o-2', valueMinor: 6_000, state: 'placed' }] });
    expect(readOrderList('o-1, sixty, delivered')).toEqual({ ok: false, line: 'o-1, sixty, delivered' });
    expect(readOrderList('o-1, 60')).toEqual({ ok: false, line: 'o-1, 60' });
    const { seen, fetch } = recorder();
    const s = createOnlineOrdersSession({ viewer: { userId: 'u-mgr', permissions: DESK }, fetch });
    expect(await s.reconcile({ channel: 'App', channelList: 'o-1, 60, delivered\no-2, x, placed', ledgerList: 'o-1, 60, delivered' })).toEqual({ result: 'invalid', why: 'badLine', badLine: 'o-2, x, placed' });
    expect(seen).toEqual([]);
    await s.reconcile({ channel: ' App ', channelList: 'o-1, 60, delivered', ledgerList: 'o-1, 60, delivered\no-9, 10, placed' });
    expect(seen[0]).toEqual({ method: 'POST', path: '/v1/orders/channel-reconcile', body: { channel: 'App', channelOrders: [{ orderId: 'o-1', valueMinor: 6_000, state: 'delivered' }], ledgerOrders: [{ orderId: 'o-1', valueMinor: 6_000, state: 'delivered' }, { orderId: 'o-9', valueMinor: 1_000, state: 'placed' }] } });
  });

  it('refuses before any request: nobody, no permission, no order, no statement line, no store, a bad count, no reason', async () => {
    const { seen, fetch } = recorder();
    const s = createOnlineOrdersSession({ viewer: { userId: 'u-mgr', permissions: DESK }, fetch });
    expect(await s.order(' ')).toEqual({ result: 'invalid', why: 'needOrder' });
    expect(await s.settle('o-1', 'declined', ' ')).toEqual({ result: 'invalid', why: 'needStatement' });
    expect(await s.reservations(' ')).toEqual({ result: 'invalid', why: 'needStore' });
    expect(await s.setBuffer({ locationId: 'br-1', productId: '', units: '-1', reason: 'x' })).toEqual({ result: 'invalid', why: 'needUnits' });
    expect(await s.setBuffer({ locationId: 'br-1', productId: '', units: '2.5', reason: 'x' })).toEqual({ result: 'invalid', why: 'needUnits' });
    expect(await s.setBuffer({ locationId: 'br-1', productId: '', units: '2', reason: ' ' })).toEqual({ result: 'invalid', why: 'needReason' });
    expect(await s.reconcile({ channel: '', channelList: 'x', ledgerList: 'y' })).toEqual({ result: 'invalid', why: 'needChannel' });
    const cashier = createOnlineOrdersSession({ viewer: { userId: 'u-cash', permissions: ['order.read'] }, fetch });
    expect(cashier.may).toMatchObject({ read: true, move: false, backorder: false, settle: false, buffer: false });
    expect(await cashier.move('o-1', 'cancel')).toEqual({ result: 'invalid', why: 'cannotMove' });
    expect(await cashier.backorder('o-1')).toEqual({ result: 'invalid', why: 'cannotBackorder' });
    expect(await cashier.settle('o-1', 'authorised', 'S')).toEqual({ result: 'invalid', why: 'cannotSettle' });
    expect(await cashier.setBuffer({ locationId: 'br-1', productId: '', units: '1', reason: 'x' })).toEqual({ result: 'invalid', why: 'cannotBuffer' });
    const nobody = createOnlineOrdersSession({ viewer: undefined, fetch });
    expect(await nobody.order('o-1')).toEqual({ result: 'invalid', why: 'nobody' });
    expect(seen).toEqual([]);
  });

  it('every English word has a Tamil twin', () => {
    expect(Object.keys(ONLINE_ORDERS_COPY.ta).sort()).toEqual(Object.keys(ONLINE_ORDERS_COPY.en).sort());
  });
});

describe('the Delivery area session (M18-FR-01/03 · D08 · AVR-13)', () => {
  it('the standard 10 km head office uses until the owner sets his own reads "not set" — never as his figure', () => {
    expect(areaShown('en', { policy: { radiusMetres: 10_000 }, source: 'default', effectiveFrom: null, on: '2026-11-02' }))
      .toEqual({ radius: 'not set', minimum: 'not set', fee: 'not set', freeAbove: 'not set', from: 'not set', isDefault: true });
    expect(areaShown('en', { policy: { radiusMetres: 7_500, deliveryFeeMinor: 30_00 }, source: 'scheduled', effectiveFrom: '2026-11-01', on: '2026-11-02' }))
      .toEqual({ radius: '7.5 km', minimum: 'not set', fee: '₹30.00', freeAbove: 'not set', from: '2026-11-01', isDefault: false });
    expect(areaShown('ta', { policy: {}, source: 'default', effectiveFrom: null, on: '2026-11-02' }).radius).toBe('அமைக்கப்படவில்லை');
  });

  it('sends only the figures typed, in metres and paise, from the start date; the slots as head office reads them', async () => {
    const { seen, fetch } = recorder();
    const s = createDeliveryAreaSession({ viewer: { userId: 'u-owner', permissions: ['delivery.serviceability.read', 'delivery.serviceability.manage'] }, fetch });
    await s.area('2026-11-02');
    await s.history();
    await s.setArea({ from: '2026-11-03', radiusKm: '7.5', minimum: '', fee: '30', freeAbove: '1,000' });
    await s.slots('2026-11-03');
    await s.setSlots({ lat: '11.0168', lon: '76.9558', slotsPerDay: '6', open: '09:00', close: '21:00', capacity: '10', leadMinutes: '' });
    expect(seen.map((x) => `${x.method} ${x.path}`)).toEqual([
      'GET /v1/serviceability?on=2026-11-02', 'GET /v1/serviceability/periods', 'POST /v1/serviceability/periods/2026-11-03',
      'GET /v1/serviceability/delivery-service?day=2026-11-03', 'PUT /v1/serviceability/delivery-service',
    ]);
    expect(seen[2]!.body).toEqual({ radiusMetres: 7_500, deliveryFeeMinor: 3_000, freeDeliveryAboveMinor: 100_000 });
    expect(seen[4]!.body).toEqual({ storeLocation: { lat: 11.0168, lon: 76.9558 }, slotsPerDay: 6, windowOpen: '09:00', windowClose: '21:00', capacityPerSlot: 10 });
  });

  it('refuses before any request: no date, nothing typed, a bad figure, bad slots, no permission', async () => {
    const { seen, fetch } = recorder();
    const s = createDeliveryAreaSession({ viewer: { userId: 'u-owner', permissions: ['delivery.serviceability.read', 'delivery.serviceability.manage'] }, fetch });
    expect(await s.area('02/11/2026')).toEqual({ result: 'invalid', why: 'needDay' });
    expect(await s.setArea({ from: '', radiusKm: '5', minimum: '', fee: '', freeAbove: '' })).toEqual({ result: 'invalid', why: 'needFrom' });
    expect(await s.setArea({ from: '2026-11-03', radiusKm: '', minimum: '', fee: '', freeAbove: '' })).toEqual({ result: 'invalid', why: 'needSome' });
    expect(await s.setArea({ from: '2026-11-03', radiusKm: 'ten', minimum: '', fee: '', freeAbove: '' })).toEqual({ result: 'invalid', why: 'needSome' });
    const slot = { lat: '11', lon: '76', slotsPerDay: '6', open: '09:00', close: '21:00', capacity: '10', leadMinutes: '60' };
    expect(await s.setSlots({ ...slot, close: '08:00' })).toEqual({ result: 'invalid', why: 'needSlots' });
    expect(await s.setSlots({ ...slot, capacity: '0' })).toEqual({ result: 'invalid', why: 'needSlots' });
    expect(await s.setSlots({ ...slot, lat: '95' })).toEqual({ result: 'invalid', why: 'needSlots' });
    expect(await s.setSlots({ ...slot, leadMinutes: 'soon' })).toEqual({ result: 'invalid', why: 'needSlots' });
    const reader = createDeliveryAreaSession({ viewer: { userId: 'u-mgr', permissions: ['delivery.serviceability.read'] }, fetch });
    expect(await reader.setArea({ from: '2026-11-03', radiusKm: '5', minimum: '', fee: '', freeAbove: '' })).toEqual({ result: 'invalid', why: 'cannotSet' });
    expect(await reader.setSlots(slot)).toEqual({ result: 'invalid', why: 'cannotSet' });
    expect(seen).toEqual([]);
  });

  it('a place that fulfils online orders: a branch with express minutes, a dark store that never takes pickup (M18-FR-03)', async () => {
    const { seen, fetch } = recorder();
    const s = createDeliveryAreaSession({ viewer: { userId: 'u-owner', permissions: ['delivery.serviceability.read', 'delivery.serviceability.manage'] }, fetch });
    const branch = { locationId: ' br-1 ', kind: 'store' as const, lat: '11.0168', lon: '76.9558', pickup: true, delivery: true, radiusKm: '8', expressMinutes: '45', perSlot: '' };
    await s.places();
    await s.setPlace(branch);
    await s.setPlace({ ...branch, locationId: 'DS-1', kind: 'dark_store', pickup: false, expressMinutes: '', perSlot: '12' });
    expect(seen.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /v1/delivery/locations', 'POST /v1/delivery/locations/br-1', 'POST /v1/delivery/locations/DS-1']);
    expect(seen[1]!.body).toEqual({ kind: 'store', lat: 11.0168, lon: 76.9558, acceptsPickup: true, acceptsDelivery: true, deliveryRadiusMetres: 8_000, expressMinutes: 45 });
    expect(seen[2]!.body).toEqual({ kind: 'dark_store', lat: 11.0168, lon: 76.9558, acceptsPickup: false, acceptsDelivery: true, deliveryRadiusMetres: 8_000, capacityPerSlot: 12 });
    const before = seen.length;
    expect(await s.setPlace({ ...branch, kind: 'dark_store', pickup: true })).toEqual({ result: 'invalid', why: 'needPlace' });
    expect(await s.setPlace({ ...branch, expressMinutes: '0' })).toEqual({ result: 'invalid', why: 'needPlace' });
    expect(await s.setPlace({ ...branch, radiusKm: '0' })).toEqual({ result: 'invalid', why: 'needPlace' });
    expect(await s.setPlace({ ...branch, locationId: 'a b' })).toEqual({ result: 'invalid', why: 'needPlace' });
    expect(seen.length).toBe(before);
  });

  it('every English word has a Tamil twin', () => {
    expect(Object.keys(DELIVERY_AREA_COPY.ta).sort()).toEqual(Object.keys(DELIVERY_AREA_COPY.en).sort());
  });
});
