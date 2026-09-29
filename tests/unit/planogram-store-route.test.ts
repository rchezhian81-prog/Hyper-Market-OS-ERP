import { describe, it, expect } from 'vitest';
import { planogramRoutes, inForcePlanogram, latestPlanograms, type PlanogramStoreDeps, type StoredShelfMap, type StoredPlanogram } from '../../services/inventory/src/planograms';
import { planogramComplianceRoutes } from '../../services/inventory/src/planogram-compliance';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import type { ShelfCount } from '../../services/inventory/src/shelf-count';

/**
 * **M04-FR-02/03 — the shelf map and the planogram the cloud KEEPS (un-parks CH-02).**
 *
 * Route-level with stubbed stores: a shelf map publishes as versions; a planogram is validated against the
 * STORED map by the engine and refused when inconsistent; a change is a new version, never an edit; the plan
 * in force is derived from effective dates; and the compliance run reads the stored plan when the caller
 * sends none — while the plan-in-body path keeps working exactly as before.
 */

const NOW = '2026-10-05T09:00:00.000Z';
interface Rec { maps: StoredShelfMap[]; plans: StoredPlanogram[] }
const stub = (counts: readonly ShelfCount[] = []) => {
  const rec: Rec = { maps: [], plans: [] };
  const deps: PlanogramStoreDeps = {
    shelfMap: (_t, storeId) => rec.maps.filter((m) => m.storeId === storeId).sort((a, b) => b.version - a.version)[0],
    planograms: (_t, storeId) => rec.plans.filter((p) => p.storeId === storeId),
    recordShelfMap: (_t, m) => { rec.maps.push(m); },
    recordPlanogram: (_t, p) => { rec.plans.push(p); },
    now: () => NOW,
  };
  return { rec, deps, routes: [...planogramRoutes(deps), ...planogramComplianceRoutes({ counts: () => counts, shelfMap: deps.shelfMap, planograms: deps.planograms, now: () => NOW })] };
};
const ctx = (over: Partial<RequestContext>): RequestContext =>
  ({ tenantId: 't-sre', userId: 'u-merch', branchId: null, params: {}, query: {}, body: undefined, traceId: 't', ...over });
const routeFor = (routes: readonly Route[], method: string, path: string): Route => {
  const r = routes.find((x) => x.method === method && x.path === path);
  if (r === undefined) throw new Error(`no route ${method} ${path}`);
  return r;
};
interface Thrown { readonly status: number; readonly body: { readonly code: string } }
async function thrown(fn: () => unknown): Promise<Thrown> {
  try { await fn(); } catch (e) { return e as Thrown; }
  throw new Error('expected the handler to throw');
}

const LOCS = [
  { locationId: 'A1-R1-B1-S1-P1', aisle: 1, rack: 1, bay: 1, shelf: 1, position: 1, zone: 'ambient', label: 'A1' },
  { locationId: 'A1-R1-B1-S1-P2', aisle: 1, rack: 1, bay: 1, shelf: 1, position: 2, zone: 'ambient' },
  { locationId: 'A2-R1-B1-S2-P1', aisle: 2, rack: 1, bay: 1, shelf: 2, position: 1, zone: 'chilled' },
];
const ASSIGN = [
  { productId: 'P-RICE', locationId: 'A1-R1-B1-S1-P1', capacityMinor: 40, primary: true },
  { productId: 'P-SOAP', locationId: 'A1-R1-B1-S1-P2', capacityMinor: 60, primary: true },
];
const publishMap = (routes: readonly Route[], storeId = 'S1') => routeFor(routes, 'PUT', '/v1/merchandising/stores/:storeId/shelf-map').handler(ctx({ params: { storeId }, body: { locations: LOCS } }));
const publishPlan = (routes: readonly Route[], planogramId: string, body: Record<string, unknown>, storeId = 'S1') =>
  routeFor(routes, 'PUT', '/v1/merchandising/stores/:storeId/planograms/:planogramId').handler(ctx({ params: { storeId, planogramId }, body }));

describe('the shelf map', () => {
  it('publishes as version 1, then 2 — a change is a new version, never an edit', async () => {
    const { routes, rec } = stub();
    expect((await publishMap(routes)).status).toBe(201);
    expect((await publishMap(routes)).status).toBe(201);
    expect(rec.maps.map((m) => [m.version, m.publishedBy, m.locations.length])).toEqual([[1, 'u-merch', 3], [2, 'u-merch', 3]]);
    const read = await routeFor(routes, 'GET', '/v1/merchandising/stores/:storeId/shelf-map').handler(ctx({ params: { storeId: 'S1' } }));
    expect((read.body as { shelfMap: StoredShelfMap }).shelfMap.version).toBe(2);
  });
  it('refuses an unreadable map and a duplicated location id; 404 when a store has none', async () => {
    const { routes, rec } = stub();
    const put = routeFor(routes, 'PUT', '/v1/merchandising/stores/:storeId/shelf-map');
    expect((await thrown(() => put.handler(ctx({ params: { storeId: 'S1' }, body: { locations: [{ locationId: 'x' }] } })))).status).toBe(400);
    expect(await thrown(() => put.handler(ctx({ params: { storeId: 'S1' }, body: { locations: [LOCS[0], LOCS[0]] } })))).toMatchObject({ status: 422, body: { code: 'duplicate_shelf_location' } });
    expect(rec.maps).toEqual([]);
    expect((await thrown(() => routeFor(routes, 'GET', '/v1/merchandising/stores/:storeId/shelf-map').handler(ctx({ params: { storeId: 'S9' } })))).status).toBe(404);
  });
});

describe('the planogram', () => {
  it('needs a shelf map first, is validated against it by the engine, and versions per plan id', async () => {
    const { routes, rec } = stub();
    expect(await thrown(() => publishPlan(routes, 'PG-1', { effectiveFrom: '2026-10-01', assignments: ASSIGN }))).toMatchObject({ status: 409, body: { code: 'this_store_has_no_shelf_map' } });
    await publishMap(routes);
    // An assignment to a shelf the store never mapped: inconsistent, refused, nothing stored.
    expect(await thrown(() => publishPlan(routes, 'PG-1', { effectiveFrom: '2026-10-01', assignments: [{ productId: 'P-X', locationId: 'NOWHERE', capacityMinor: 10, primary: true }] }))).toMatchObject({ status: 422, body: { code: 'the_plan_is_inconsistent' } });
    expect(rec.plans).toEqual([]);
    const v1 = await publishPlan(routes, 'PG-1', { effectiveFrom: '2026-10-01', assignments: ASSIGN });
    expect(v1.status).toBe(201);
    const v2 = await publishPlan(routes, 'PG-1', { effectiveFrom: '2026-10-03', assignments: [...ASSIGN, { productId: 'P-MILK', locationId: 'A2-R1-B1-S2-P1', capacityMinor: 24, primary: true }] });
    expect((v2.body as { planogram: StoredPlanogram; previousVersions: number })).toMatchObject({ planogram: { version: 2, createdBy: 'u-merch', shelfMapVersion: 1 }, previousVersions: 1 });
    const history = await routeFor(routes, 'GET', '/v1/merchandising/stores/:storeId/planograms/:planogramId').handler(ctx({ params: { storeId: 'S1', planogramId: 'PG-1' } }));
    expect((history.body as { versions: StoredPlanogram[] }).versions.map((p) => p.version)).toEqual([1, 2]);
    expect((await thrown(() => routeFor(routes, 'GET', '/v1/merchandising/stores/:storeId/planograms/:planogramId').handler(ctx({ params: { storeId: 'S1', planogramId: 'PG-9' } })))).status).toBe(404);
  });
  it('the plan in force is the newest version of the latest plan whose date has arrived; a future plan is coming, not in force', () => {
    const base = { storeId: 'S1', assignments: [], createdBy: 'u', shelfMapVersion: 1 };
    const all: StoredPlanogram[] = [
      { ...base, planogramId: 'PG-1', version: 1, effectiveFrom: '2026-09-01', publishedAt: '2026-08-20T00:00:00Z' },
      { ...base, planogramId: 'PG-1', version: 2, effectiveFrom: '2026-09-15', publishedAt: '2026-09-10T00:00:00Z' },
      { ...base, planogramId: 'PG-DIWALI', version: 1, effectiveFrom: '2026-10-20', publishedAt: '2026-09-30T00:00:00Z' },
    ];
    expect(latestPlanograms(all).map((p) => [p.planogramId, p.version])).toEqual([['PG-1', 2], ['PG-DIWALI', 1]]);
    expect(inForcePlanogram(all, '2026-10-05T09:00:00Z')).toMatchObject({ planogramId: 'PG-1', version: 2 });
    expect(inForcePlanogram(all, '2026-10-21T09:00:00Z')).toMatchObject({ planogramId: 'PG-DIWALI' });
    expect(inForcePlanogram(all, '2026-08-01T09:00:00Z')).toBeUndefined();
  });
  it('the store listing shows the plan in force, every plan\'s newest version, and which plans predate the current shelf map', async () => {
    const { routes } = stub();
    await publishMap(routes);
    await publishPlan(routes, 'PG-1', { effectiveFrom: '2026-10-01', assignments: ASSIGN });
    await publishMap(routes); // shelf map v2 — PG-1 was validated against v1
    const list = (await routeFor(routes, 'GET', '/v1/merchandising/stores/:storeId/planograms').handler(ctx({ params: { storeId: 'S1' } }))).body as { inForce: StoredPlanogram | null; plans: { planogramId: string; versions: number }[]; shelfMapVersion: number; staleAgainstShelfMap: string[] };
    expect(list.inForce?.planogramId).toBe('PG-1');
    expect(list.plans).toEqual([expect.objectContaining({ planogramId: 'PG-1', versions: 1 })]);
    expect(list.shelfMapVersion).toBe(2);
    expect(list.staleAgainstShelfMap).toEqual(['PG-1']);
  });
});

describe('the compliance run reads the stored plan when none is sent', () => {
  const counts: ShelfCount[] = [
    { countId: 'c1', storeId: 'S1', productId: 'P-RICE', locationId: 'A1-R1-B1-S1-P1', countedMinor: 5, countedBy: 'u-staff', at: '2026-10-05T08:30:00.000Z' } as unknown as ShelfCount,
  ];
  it('uses the plan in force and reports which plan and version it judged against', async () => {
    const { routes } = stub(counts);
    await publishMap(routes);
    await publishPlan(routes, 'PG-1', { effectiveFrom: '2026-10-01', assignments: ASSIGN });
    const run = await routeFor(routes, 'POST', '/v1/merchandising/planogram-compliance').handler(ctx({ body: { storeId: 'S1', backstock: { 'P-RICE': 100, 'P-SOAP': 0 }, assignedRole: 'store_manager' } }));
    expect(run.status).toBe(200);
    const body = run.body as { planogramId: string; planogramVersion: number; planSource: string; tasks: { productId: string }[] };
    expect(body).toMatchObject({ planogramId: 'PG-1', planogramVersion: 1, planSource: 'stored' });
    expect(body.tasks.map((t) => t.productId)).toContain('P-RICE');
  });
  it('a store with no shelf map or no plan in force is told so, and the plan-in-body path still works', async () => {
    const { routes } = stub(counts);
    const run = routeFor(routes, 'POST', '/v1/merchandising/planogram-compliance');
    expect(await thrown(() => run.handler(ctx({ body: { storeId: 'S1', backstock: {}, assignedRole: 'store_manager' } })))).toMatchObject({ status: 409, body: { code: 'this_store_has_no_shelf_map' } });
    await publishMap(routes);
    expect(await thrown(() => run.handler(ctx({ body: { storeId: 'S1', backstock: {}, assignedRole: 'store_manager' } })))).toMatchObject({ status: 409, body: { code: 'this_store_has_never_published_a_planogram' } });
    await publishPlan(routes, 'PG-FUTURE', { effectiveFrom: '2027-01-01', assignments: ASSIGN });
    expect(await thrown(() => run.handler(ctx({ body: { storeId: 'S1', backstock: {}, assignedRole: 'store_manager' } })))).toMatchObject({ status: 409, body: { code: 'this_store_has_never_published_a_planogram' } });
    // Named explicitly, a future plan can still be run against (a dry run before its date).
    const named = await run.handler(ctx({ body: { storeId: 'S1', planogramId: 'PG-FUTURE', backstock: {}, assignedRole: 'store_manager' } }));
    expect((named.body as { planSource: string }).planSource).toBe('stored');
    const inBody = await run.handler(ctx({ body: {
      planogram: { planogramId: 'PG-BODY', storeId: 'S1', version: 7, effectiveFrom: '2026-10-01', createdBy: 'u-merch', assignments: ASSIGN },
      locations: LOCS, backstock: {}, assignedRole: 'store_manager',
    } }));
    expect((inBody.body as { planSource: string; planogramVersion: number }).planSource).toBe('request_body');
    expect((inBody.body as { planogramVersion: number }).planogramVersion).toBe(7);
    expect((await thrown(() => run.handler(ctx({ body: { backstock: {}, assignedRole: 'store_manager' } })))).status).toBe(400);
  });
});
