import { describe, it, expect } from 'vitest';
import { useRestartableBackings } from '../support/p3-backings';
import { fulfilmentShop, dayFigures, OWNER, DISPATCHER, DRIVER, STORE_ID, DOORS, type Shop } from '../support/fulfilment-shop';

/**
 * **U7 (OB-726 · OB-700 · M19 · §31) — the Dispatch board lists the drivers' "please call the customer" requests.**
 * Through the real API, in memory and on real PostgreSQL: the board's route carries each request (the stop, the order
 * reference, the driver, the area, when, who at the store was told) and whether the store has called — "called" is the
 * store ticking the request's operational alert as seen (the append-only acknowledgement every alert rides), so the board
 * and the Ops alerts page never disagree. Still no customer detail anywhere.
 */
const backings = useRestartableBackings();

interface PlanBody { plan: { routes: { routeId: string; driverId: string; stops: { stopId: string; orderId: string }[] }[] } }
interface BoardCall { stopId: string; orderRef: string; driverId: string; area: string | null; at: string; toldUserIds: string[]; called: { by: string; at: string } | null }

describe.each(backings)('the dispatch board lists the drivers\' call requests — on $name', ({ harness }) => {
  it('the request shows on its route, not yet called; once the store ticks it, it reads called, by whom and when', async () => {
    const shop: Shop = await fulfilmentShop(harness());
    await shop.placeConfirmed('c-1', 'ORD-1', [['RICE', 1]], 1, DOORS.near);
    const p = (await shop.ok('POST', `/v1/delivery/dispatch/${shop.runDate}/plan-from-orders`, DISPATCHER, dayFigures(shop))) as unknown as PlanBody;
    const r1 = p.plan.routes.find((r) => r.stops.some((s) => s.orderId === 'ORD-1'))!;
    expect((await shop.call('POST', `/v1/delivery/dispatch/${shop.runDate}/routes/${encodeURIComponent(r1.routeId)}/assign`, DISPATCHER, { storeId: STORE_ID })).status).toBe(201);
    const stop = r1.stops.find((s) => s.orderId === 'ORD-1')!;
    const board = async (): Promise<BoardCall[]> => {
      const b = await shop.ok('GET', `/v1/delivery/dispatch/${shop.runDate}/board`, DISPATCHER, undefined, { storeId: STORE_ID });
      const route = (b['routes'] as { routeId: string; callRequests: BoardCall[] }[]).find((r) => r.routeId === r1.routeId)!;
      return route.callRequests;
    };
    expect(await board()).toEqual([]);

    const at = new Date().toISOString();
    const asked = await shop.call('POST', `/v1/delivery/routes/${encodeURIComponent(r1.routeId)}/stops/${encodeURIComponent(stop.stopId)}/call-request/synced`, OWNER,
      { routeId: r1.routeId, stopId: stop.stopId, driverId: DRIVER, orderRef: 'ORD-1', area: 'Near the market', occurredAt: at });
    expect(asked.status).toBe(201);
    const listed = await board();
    expect(listed).toEqual([expect.objectContaining({ stopId: stop.stopId, orderRef: 'ORD-1', driverId: DRIVER, area: 'Near the market', at, called: null })]);
    expect(listed[0]!.toldUserIds.length).toBeGreaterThan(0);
    expect(JSON.stringify(listed)).not.toMatch(/c-1/);

    // The store calls the customer from the order's own record, then ticks the request: the alert's acknowledgement.
    const alertId = `delivery-call:${r1.routeId}:${stop.stopId}`;
    expect((await shop.call('POST', `/v1/platform/alerts/${encodeURIComponent(alertId)}/acknowledge`, DISPATCHER, {})).status).toBe(200);
    const called = await board();
    expect(called[0]!.called).toEqual({ by: DISPATCHER, at: expect.any(String) });
  });
});
