import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Dispatch planning & run assignment, end to end (M19-FR-03/04, API-08). Turning confirmed orders into
// routes: every order is routed or on the unplanned list with a named reason (never silently dropped),
// straight-line distances are labelled as such, a driver dropping out is a FULL re-plan. The point of this
// increment is the gap it closes: the plan is PERSISTED and feeds `reconcileRun` the order ids each run is
// answerable for — before, that list was empty, so every delivery a driver actually made came back as one
// nobody dispatched. Plan/reassign gated delivery.dispatch.manage; reading the plan reads delivery.run.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN = '2026-09-03';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const POLICY = { storeLocation: { lat: 13.0, lon: 80.0 }, radiusMetres: 50000, averageSpeedKmh: 30, serviceMinutesPerStop: 10 };
const order = (over: Record<string, unknown> = {}) =>
  ({ orderId: 'o1', slotId: 's1', slotStartsAt: '2026-09-03T09:00:00Z', slotEndsAt: '2026-09-03T12:00:00Z', area: 'North', codMinor: 0, location: { lat: 13.01, lon: 80.01 }, ...over });
const driver = (over: Record<string, unknown> = {}) =>
  ({ driverId: 'd1', maxStops: 5, availableFrom: '2026-09-03T08:00:00Z', availableUntil: '2026-09-03T18:00:00Z', ...over });

const plan = (h: ApiHarness, u: string, body: Record<string, unknown>, key = 'p-1') =>
  h.request({ method: 'POST', path: `/v1/delivery/dispatch/${RUN}/plan`, userId: u, tenantId: A, idempotencyKey: key, body });
const reassign = (h: ApiHarness, u: string, body: Record<string, unknown>, key = 'ra-1') =>
  h.request({ method: 'POST', path: `/v1/delivery/dispatch/${RUN}/reassign`, userId: u, tenantId: A, idempotencyKey: key, body });
const getPlan = (h: ApiHarness, u: string, runDate = RUN) =>
  h.request({ method: 'GET', path: `/v1/delivery/dispatch/${runDate}`, userId: u, tenantId: A });
const attempt = (h: ApiHarness, u: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: '/v1/delivery/attempts', userId: u, tenantId: A, idempotencyKey: key, body });
const reconcile = (h: ApiHarness, u: string, driverId: string) =>
  h.request({ method: 'GET', path: `/v1/delivery/runs/${driverId}`, userId: u, tenantId: A, query: { runDate: RUN } });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                    // delivery.dispatch.manage + delivery.run.read + attempt.record
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // same delivery perms
  await h.provisionRole(A, 'u-cash', 'cashier');      // none
  return h;
}

describe('dispatch: plan today’s routes, and feed reconcileRun the run it was blind to (M19-FR-03/04)', () => {
  it('plans routes, lists every order routed-or-unplanned-with-a-reason, and survives a restart', async () => {
    const h = await cast();
    const res = await plan(h, 'u-mgr', {
      orders: [
        order({ orderId: 'o1', location: { lat: 13.01, lon: 80.01 } }),
        order({ orderId: 'o-far', location: { lat: 14.5, lon: 81.5 } }),   // ~200 km → out of area
        order({ orderId: 'o-noloc', location: undefined }),                 // no coordinates
      ],
      drivers: [driver()],
      policy: POLICY,
    });
    expect(res.status).toBe(200);
    const p = (res.body as { plan: { routes: { driverId: string; stops: { orderId: string }[] }[]; unplanned: { orderId: string; reason: string }[]; accountedFor: number; distancesAre: string } }).plan;
    expect(p.distancesAre).toBe('straight_line');
    expect(p.routes[0]!.stops.map((s) => s.orderId)).toEqual(['o1']);
    expect(p.unplanned.find((u) => u.orderId === 'o-far')).toMatchObject({ reason: 'out_of_area' });
    expect(p.unplanned.find((u) => u.orderId === 'o-noloc')).toMatchObject({ reason: 'no_location' });
    expect(p.accountedFor).toBe(3); // every order goes somewhere

    // Durable across a restart.
    const h2 = apiHarness({ store: h.store });
    expect((await getPlan(h2, 'u-owner')).status).toBe(200);
  });

  it('feeds reconcileRun the assigned orders — a delivery on the run is NOT flagged, one off it IS', async () => {
    const h = await cast();
    // d1 is assigned o1 and o2.
    await plan(h, 'u-mgr', {
      orders: [order({ orderId: 'o1' }), order({ orderId: 'o2', location: { lat: 13.02, lon: 80.02 } })],
      drivers: [driver()],
      policy: POLICY,
    });
    // The driver delivers o1 (on the run) and o-rogue (NOT on the run).
    await attempt(h, 'u-mgr', { attemptId: 'a1', orderId: 'o1', driverId: 'd1', attemptedAt: '2026-09-03T10:00:00Z', outcome: 'delivered', proofRef: 'sig-1' }, 'att-1');
    await attempt(h, 'u-mgr', { attemptId: 'a2', orderId: 'o-rogue', driverId: 'd1', attemptedAt: '2026-09-03T10:30:00Z', outcome: 'delivered', proofRef: 'sig-2' }, 'att-2');

    const rec = (await reconcile(h, 'u-owner', 'd1')).body as { unassigned: string[]; outstanding: string[] };
    // The gap closed: o1 is recognised as ON the run (not flagged); o-rogue is the real "nobody dispatched it".
    expect(rec.unassigned).toEqual(['o-rogue']);
    expect(rec.unassigned).not.toContain('o1');
    // o2 was assigned but never attempted — an order nobody can account for.
    expect(rec.outstanding).toContain('o2');
  });

  it('reassigns a full re-plan without a driver who dropped out', async () => {
    const h = await cast();
    const drivers = [driver({ driverId: 'd1', maxStops: 5 }), driver({ driverId: 'd2', maxStops: 5 })];
    const orders = [order({ orderId: 'o1' }), order({ orderId: 'o2', location: { lat: 13.02, lon: 80.02 } })];
    await plan(h, 'u-mgr', { orders, drivers, policy: POLICY });

    const res = await reassign(h, 'u-mgr', { orders, drivers, policy: POLICY, withoutDriverId: 'd1' });
    expect(res.status).toBe(200);
    const p = (res.body as { plan: { routes: { driverId: string; stops: { orderId: string }[] }[] } }).plan;
    // Nothing is left on d1; the stops moved to d2 (re-planned, not patched).
    expect(p.routes.some((r) => r.driverId === 'd1')).toBe(false);
    expect(p.routes.find((r) => r.driverId === 'd2')!.stops.length).toBe(2);

    // The stored plan reflects the reassignment.
    const stored = (await getPlan(h, 'u-owner')).body as { plan: { routes: { driverId: string }[] } };
    expect(stored.plan.routes.every((r) => r.driverId === 'd2')).toBe(true);
  });

  it('rejects a malformed body / a reassign without a driver (400), 404s an unplanned date, and gates the routes', async () => {
    const h = await cast();
    expect(codeOf(await plan(h, 'u-owner', { orders: 'nope', drivers: [], policy: POLICY }, 'p-bad'))).toBe('not_readable_as_a_dispatch');
    expect((await reassign(h, 'u-owner', { orders: [order()], drivers: [driver()], policy: POLICY }, 'ra-bad')).status).toBe(400);
    expect((await getPlan(h, 'u-owner', '2020-01-01')).status).toBe(404);

    // A cashier holds no delivery permission → refused on plan and read.
    expect((await plan(h, 'u-cash', { orders: [order()], drivers: [driver()], policy: POLICY }, 'p-cash')).status).toBe(403);
    expect((await getPlan(h, 'u-cash')).status).toBe(403);
  });
});
