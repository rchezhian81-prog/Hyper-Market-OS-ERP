import { describe, it, expect } from 'vitest';
import { useRestartableBackings } from '../support/p3-backings';
import { fulfilmentShop, dayFigures, codeOf, OWNER, DISPATCHER, CASHIER, STORE_ID, DOORS } from '../support/fulfilment-shop';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

// M12-FR-02 · OB-299 · OB-352 (owner, 24 Oct 2026, in writing: "the customer app's saved address and slot when the customer
// has the app; otherwise the delivery desk enters them against the till job — the till prints a delivery slip"). Through
// the production routes, in memory and — with DATABASE_URL — on real PostgreSQL, with a cold restart:
//
//   • two bills the till marked for delivery reach head office: one with no member, one naming a member whose membership
//     the service desk tied to an app account. Each is one delivery job; the first waits for the DESK, the second for the
//     CUSTOMER in the app — and the store computer's wallet feed says which member has the app (so the till knows whether
//     to print the slip);
//   • the desk cannot type the app customer's; it enters the other from the slip — refused outside the radius, booked once;
//   • the customer saves an address, then chooses it and a slot for their own job (never another's, never an address
//     they did not save); a second entry is refused;
//   • after a restart both are booked, and the dispatch board plans both like any other delivery. 403s for the till.

const backings = useRestartableBackings();
const TOO_FAR = { lat: 11.5000, lon: 77.5000 };
type Res = { status: number; body: unknown };

describe.each(backings)('a till delivery gets its address and slot from the app or the desk (OB-352) — on $name', ({ harness }) => {
  it('no member → the desk enters it from the slip; a member with the app → they choose in the app; booked once; the board plans both; a restart', async () => {
    const h = harness();
    const shop = await fulfilmentShop(h);
    const today = shopDateIn(new Date().toISOString());
    const slot = shop.slots[2]!;

    // The service desk enrols a member and ties the membership to c-1's app account (seen on the phone).
    const MOBILE = '98400' + '55555';
    const enrolled = await shop.ok('POST', '/v1/loyalty/members', OWNER, { mobile: MOBILE, consent: true, verifiedHow: 'seen_on_phone' });
    const memberRef = enrolled['memberRef'] as string;
    await shop.ok('POST', '/v1/loyalty/members/app-link', OWNER, { mobile: MOBILE, appCustomerRef: 'c-1', verifiedHow: 'seen_on_phone' });

    // Two bills the till marked for delivery, paid in full there, relayed by the store computer.
    const bill = (saleId: string, extra: Record<string, unknown> = {}) => ({
      saleId, receiptNumber: `L1-${saleId}`, laneId: 'lane-1', locationId: STORE_ID, cashierId: CASHIER, tradingDay: today, committedAt: new Date().toISOString(),
      totalMinor: 80_00, currency: 'INR', packVersion: 1, lines: [{ productId: 'RICE', quantityMinor: 1, uom: 'ea', unitPriceMinor: 80_00, lineTotalMinor: 80_00 }],
      tenders: [{ kind: 'cash', amountMinor: 80_00 }], delivery: { requested: true, feeMinor: 0 }, ...extra,
    });
    for (const [id, extra] of [['S-A', {}], ['S-B', { customerRef: memberRef }]] as const) {
      const sold = await shop.call('POST', '/v1/sales', CASHIER, bill(id, extra));
      expect(sold.status, JSON.stringify(sold.body)).toBe(202);
      expect(sold.body).toMatchObject({ delivery: { outcome: 'booked', orderId: `till-${id}` } });
    }

    // The store computer's copy of the members says who has the app — so the till prints the slip only for the other.
    const wallets = await shop.ok('GET', '/v1/loyalty/wallets', OWNER);
    expect((wallets['members'] as { memberRef: string; appLinked?: boolean }[]).find((m) => m.memberRef === memberRef)).toMatchObject({ appLinked: true });

    // The desk's list: one waiting for the desk, one for the customer; the day's open slots offered.
    expect((await shop.call('GET', '/v1/delivery/till-jobs', CASHIER)).status).toBe(403);
    expect((await shop.call('GET', '/v1/delivery/till-jobs', 'c-1')).status).toBe(403);
    const list = await shop.ok('GET', '/v1/delivery/till-jobs', DISPATCHER, undefined, { storeId: STORE_ID, day: shop.runDate });
    expect((list['jobs'] as { orderId: string; status: string; path: string }[]).map((j) => [j.orderId, j.path, j.status])).toEqual([
      ['till-S-A', 'delivery_desk', 'waiting_for_delivery_desk'], ['till-S-B', 'customer_app', 'waiting_for_customer_app'],
    ]);
    expect(list).toMatchObject({ waitingForDesk: 1, waitingForCustomer: 1, days: [shop.runDate] });
    expect((list['openSlots'] as { startsAt: string }[]).map((s) => s.startsAt)).toContain(slot.startsAt);

    // The desk: not the app customer's; the other from the slip — outside the radius refused, then booked, once.
    const desk = (orderId: string, body: unknown, who = DISPATCHER): Promise<Res> => shop.call('POST', `/v1/delivery/till-jobs/${orderId}/delivery`, who, body);
    expect(codeOf(await desk('till-S-B', { slotStartsAt: slot.startsAt, deliveryLocation: DOORS.near }))).toBe('customer_chooses_in_the_app');
    expect((await desk('till-S-A', { slotStartsAt: slot.startsAt, deliveryLocation: DOORS.near }, CASHIER)).status).toBe(403);
    expect(codeOf(await desk('till-S-A', { slotStartsAt: slot.startsAt }))).toBe('not_readable_as_a_till_delivery');
    expect((await desk('till-NOPE', { slotStartsAt: slot.startsAt, deliveryLocation: DOORS.near })).status).toBe(404);
    expect(codeOf(await desk('till-S-A', { slotStartsAt: slot.startsAt, deliveryLocation: TOO_FAR }))).toBe('address_outside_service_area');
    const booked = await desk('till-S-A', { slotStartsAt: slot.startsAt, deliveryLocation: DOORS.mid, landmark: 'opposite the temple' });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect(booked.body).toMatchObject({ job: { orderId: 'till-S-A', status: 'booked', given: { by: 'delivery_desk', personId: DISPATCHER, landmark: 'opposite the temple' } }, slot: { startsAt: slot.startsAt } });
    expect(codeOf(await desk('till-S-A', { slotStartsAt: slot.startsAt, deliveryLocation: DOORS.mid }))).toBe('till_job_already_has_its_address');

    // The customer: their job waits; they save an address, then choose it and a slot. Never another's, never an unsaved one.
    const mine0 = await shop.ok('GET', '/v1/me/till-deliveries', 'c-1');
    expect(mine0).toMatchObject({ linked: true, addresses: [], deliveries: [{ orderId: 'till-S-B', status: 'waiting_for_customer_app', given: null }] });
    expect(await shop.ok('GET', '/v1/me/till-deliveries', 'c-2')).toMatchObject({ linked: false, deliveries: [] });
    await shop.ok('POST', '/v1/me/addresses/home', 'c-1', { label: 'Home', location: DOORS.far, landmark: 'blue gate' });
    const choose = (who: string, body: unknown): Promise<Res> => shop.call('POST', '/v1/me/till-deliveries/till-S-B/delivery', who, body);
    expect(codeOf(await choose('c-2', { addressId: 'home', slotStartsAt: slot.startsAt }))).toBe('not_your_delivery');
    expect(codeOf(await choose('c-1', { addressId: 'office', slotStartsAt: slot.startsAt }))).toBe('address_not_saved');
    expect(codeOf(await choose('c-1', { addressId: 'home' }))).toBe('not_readable_as_a_till_delivery_choice');
    expect((await choose('c-1', { addressId: 'home', slotStartsAt: slot.startsAt })).status).toBe(201);
    expect(codeOf(await choose('c-1', { addressId: 'home', slotStartsAt: slot.startsAt }))).toBe('till_job_already_has_its_address');

    // ── COLD RESTART ── both booked; the dispatch board plans both like any delivery.
    const again = harness(h);
    const read = async (path: string, userId: string, query?: Record<string, string>) => (await again.request({ method: 'GET', path, userId, tenantId: shop.t, ...(query === undefined ? {} : { query }) })).body as Record<string, unknown>;
    const after = await read('/v1/delivery/till-jobs', DISPATCHER, { storeId: STORE_ID });
    expect((after['jobs'] as { orderId: string; status: string; given: { by: string } }[]).map((j) => [j.orderId, j.status, j.given.by])).toEqual([
      ['till-S-A', 'booked', 'delivery_desk'], ['till-S-B', 'booked', 'customer_app'],
    ]);
    expect(await read('/v1/me/till-deliveries', 'c-1')).toMatchObject({ deliveries: [{ orderId: 'till-S-B', status: 'booked', given: { addressId: 'home', slotStartsAt: slot.startsAt } }] });
    const planned = await again.request({ method: 'POST', path: `/v1/delivery/dispatch/${shop.runDate}/plan-from-orders`, userId: DISPATCHER, tenantId: shop.t, idempotencyKey: 'plan-till-jobs', body: dayFigures(shop) });
    expect(planned.status, JSON.stringify(planned.body)).toBeLessThan(300);
    const stops = ((planned.body as { plan: { routes: { stops: { orderId: string }[] }[] } }).plan.routes).flatMap((r) => r.stops.map((s) => s.orderId)).sort();
    expect(stops).toEqual(['till-S-A', 'till-S-B']);
  }, 120_000);
});
