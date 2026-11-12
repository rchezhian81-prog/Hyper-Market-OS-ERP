import { describe, it, expect } from 'vitest';
import { useRestartableBackings } from '../support/p3-backings';
import { fulfilmentShop, dayFigures, codeOf, OWNER, DISPATCHER, MANAGER2, PICKER, DRIVER, DRIVER2, CASHIER, STORE_ID, DOORS, type Shop } from '../support/fulfilment-shop';

/**
 * **U6 · OB-700 (owner, 7 Nov 2026, decision 3 = B) · M19 · §31 — a driver's request that the STORE call a stop's customer,
 * relayed by the store computer, lands at head office once and is put in front of the store.** Through the real API, in
 * memory and on real PostgreSQL:
 *   • the thin payload (route, driver, stop, order reference, area) is recorded once per stop; a re-sent one is the same record;
 *   • the store's managers are told through the operational-alert lifecycle the Ops alerts page reads — owned by one, the
 *     others also told — with the order and the driver named and NO customer detail;
 *   • the route register names the stops asked about, so the dispatcher sees them; a payload with no driver is 400; a
 *     cashier cannot relay it (403); a driver without the delivery word is recorded AND flagged, never dropped.
 */
const backings = useRestartableBackings();

interface PlanBody { plan: { routes: { routeId: string; driverId: string; stops: { stopId: string; orderId: string }[] }[] } }

describe.each(backings)('the store is asked to call a stop\'s customer (OB-700) — on $name', ({ harness }) => {
  it('one request per stop, the store told once, the route register names it, refusals by name', async () => {
    const shop: Shop = await fulfilmentShop(harness());
    await shop.placeConfirmed('c-1', 'ORD-1', [['RICE', 1]], 1, DOORS.near);
    await shop.placeConfirmed('c-2', 'ORD-2', [['DAL', 2]], 1, DOORS.mid);
    const p = (await shop.ok('POST', `/v1/delivery/dispatch/${shop.runDate}/plan-from-orders`, DISPATCHER, dayFigures(shop))) as unknown as PlanBody;
    const r1 = p.plan.routes.find((r) => r.stops.some((s) => s.orderId === 'ORD-1'))!;
    expect((await shop.call('POST', `/v1/delivery/dispatch/${shop.runDate}/routes/${encodeURIComponent(r1.routeId)}/assign`, DISPATCHER, { storeId: STORE_ID })).status).toBe(201);
    const stop = r1.stops.find((s) => s.orderId === 'ORD-1')!;
    const path = `/v1/delivery/routes/${encodeURIComponent(r1.routeId)}/stops/${encodeURIComponent(stop.stopId)}/call-request/synced`;
    const ask = (body: unknown, who = OWNER) => shop.call('POST', path, who, body);
    const body = { routeId: r1.routeId, stopId: stop.stopId, driverId: DRIVER, orderRef: 'ORD-1', area: 'Near the market', occurredAt: new Date().toISOString() };

    // A customer is not the store computer; a payload with no driver cannot be read.
    expect((await ask(body, 'c-3')).status).toBe(403);
    expect(codeOf(await ask({ ...body, driverId: '' }))).toBe('not_readable_as_a_call_request');

    // Recorded once; the store's managers told — one owns it, the others are also told; never the customer.
    const first = await ask(body);
    expect(first.status).toBe(201);
    const managers = [DISPATCHER, MANAGER2, PICKER, DRIVER, DRIVER2].sort();
    expect(first.body).toMatchObject({ recorded: true, alreadyRecorded: false, toldUserIds: managers, flags: [] });
    const again = await ask({ ...body, occurredAt: new Date(Date.now() + 60_000).toISOString() });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ recorded: true, alreadyRecorded: true, toldUserIds: managers });

    const alerts = (await shop.ok('GET', '/v1/platform/alerts', OWNER))['alerts'] as { alert: { alertId: string; component: string; detail: string; ownerUserId: string; alsoToUserIds?: string[] }; state: string }[];
    const mine = alerts.filter((a) => a.alert.alertId === `delivery-call:${r1.routeId}:${stop.stopId}`);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ state: 'open', alert: { component: 'delivery', ownerUserId: managers[0], alsoToUserIds: managers.slice(1) } });
    expect(mine[0]!.alert.detail).toContain('ORD-1');
    expect(mine[0]!.alert.detail).toContain(DRIVER);
    expect(mine[0]!.alert.detail).not.toMatch(/c-1|11\.0|76\.9/);

    // The dispatcher's route register names the stop asked about.
    const route = await shop.ok('GET', `/v1/delivery/routes/${encodeURIComponent(r1.routeId)}`, DISPATCHER);
    expect(route['callRequests']).toEqual([expect.objectContaining({ stopId: stop.stopId, orderRef: 'ORD-1', driverId: DRIVER, area: 'Near the market', toldUserIds: managers })]);

    // A person without the delivery word asked: recorded and FLAGGED (hard rule #6 — kept, never dropped), the store still told.
    const stop2 = p.plan.routes.flatMap((r) => r.stops).find((s) => s.orderId === 'ORD-2')!;
    const r2 = p.plan.routes.find((r) => r.stops.some((s) => s.orderId === 'ORD-2'))!;
    const flagged = await shop.call('POST', `/v1/delivery/routes/${encodeURIComponent(r2.routeId)}/stops/${encodeURIComponent(stop2.stopId)}/call-request/synced`, OWNER, { ...body, routeId: r2.routeId, stopId: stop2.stopId, driverId: CASHIER, orderRef: 'ORD-2' });
    expect(flagged.status).toBe(201);
    expect(flagged.body).toMatchObject({ flags: ['driver_lacks_authority'], toldUserIds: managers });
  });
});
