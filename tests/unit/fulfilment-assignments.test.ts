import { describe, it, expect } from 'vitest';
import {
  assignmentRoutes, latestWaves, latestRoutes, assignmentDigest, openAssignments, PICK_PERMISSION, DRIVE_PERMISSION,
  type AssignmentsDeps, type WaveAssignment, type RouteAssignment,
} from '../../services/fulfilment/src/assignments';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import type { AuditEntry } from '../../packages/audit/src/index';

/**
 * **Head office assigns the handhelds their work — a wave to a picker, a route to a driver, per store — append-only, idempotent
 * on content, the person re-verified and REFUSED by name when they may not do it, finished work never reassigned, and only OPEN
 * work handed to the box (HA-1 · M19-FR-01 · M19-FR-03 · §31 · hard rules #4/#6).**
 */

const NOW = '2026-10-03T06:00:00.000Z';
const A = 'tenant-a';

interface World {
  readonly waves: WaveAssignment[];
  readonly routes: RouteAssignment[];
  readonly packed: Set<string>;
  readonly settled: Set<string>;
  readonly audit: AuditEntry[];
  readonly routesOf: readonly Route[];
}

function world(grants: Record<string, readonly string[] | undefined> = { 'u-picker': [PICK_PERMISSION], 'u-driver': [DRIVE_PERMISSION], 'u-floor': ['pos.sale.record'] }): World {
  const waves: WaveAssignment[] = [];
  const routes: RouteAssignment[] = [];
  const packed = new Set<string>();
  const settled = new Set<string>();
  const audit: AuditEntry[] = [];
  const deps: AssignmentsDeps = {
    permissionsOfUser: (_t, userId) => grants[userId],
    waveAssignments: (_t, storeId) => waves.filter((w) => w.storeId === storeId),
    recordWaveAssignment: (_t, a) => { waves.push(a); },
    routeAssignments: (_t, storeId) => routes.filter((r) => r.storeId === storeId),
    recordRouteAssignment: (_t, a) => { routes.push(a); },
    wavePacked: (_t, waveId) => packed.has(waveId),
    routeSettled: (_t, routeId) => settled.has(routeId),
    recordAudit: (_t, e) => { audit.push(e); },
    now: () => NOW,
  };
  return { waves, routes, packed, settled, audit, routesOf: assignmentRoutes(deps) };
}
const route = (w: World, method: string, path: string): Route => {
  const r = w.routesOf.find((x) => x.method === method && x.path === path);
  if (r === undefined) throw new Error(`no ${method} ${path}`);
  return r;
};
const ctx = (params: Record<string, string>, body: unknown = undefined, query: Record<string, string> = {}): RequestContext => ({
  tenantId: A, userId: 'u-dispatcher', branchId: null, params, query, body, traceId: 't', idempotencyKey: 'k',
});
const WAVE = '/v1/fulfilment/waves/:waveId/assignment';
const ROUTE = '/v1/delivery/routes/:routeId/assignment';
const OPEN = '/v1/fulfilment/assignments';
const line = (over: Record<string, unknown> = {}) => ({ lineId: 'l1', orderRef: 'ORD-1', productId: 'p-rice', description: 'Rice 5kg', bin: 'A-01', requiredQty: 2, uom: 'ea', unitPriceMinor: 100_00, ...over });
const stop = (over: Record<string, unknown> = {}) => ({ stopId: 's1', orderRef: 'ORD-1', area: 'Anna Nagar', codMinor: 250_00, ...over });
const assignWave = (w: World, waveId: string, body: unknown) => route(w, 'POST', WAVE).handler(ctx({ waveId }, body));
const assignRoute = (w: World, routeId: string, body: unknown) => route(w, 'POST', ROUTE).handler(ctx({ routeId }, body));
const open = (w: World, storeId = 'store-1') => route(w, 'GET', OPEN).handler(ctx({}, undefined, { storeId }));

describe('the routes and their gates', () => {
  it('a wave is assigned by fulfilment.wave.assign (core), a route by delivery.dispatch.manage on the delivery feature, the open ones read by fulfilment.assignment.read (the box)', () => {
    const w = world();
    expect(route(w, 'POST', WAVE)).toMatchObject({ api: 'API-08', permission: 'fulfilment.wave.assign', idempotent: true });
    expect(route(w, 'POST', WAVE).entitlement).toBeUndefined();
    expect(route(w, 'POST', ROUTE)).toMatchObject({ api: 'API-08', permission: 'delivery.dispatch.manage', entitlement: 'delivery', idempotent: true });
    expect(route(w, 'GET', OPEN)).toMatchObject({ permission: 'fulfilment.assignment.read' });
  });

  it('folds the register to the latest per wave / route, and a digest is the content with the clock and the author off', () => {
    const a = (waveId: string, pickerId: string, at: string): WaveAssignment => ({ waveId, storeId: 's', pickerId, lines: [line()], assignedBy: 'u', at, digest: assignmentDigest({ pickerId, lines: [line()] }) });
    expect(latestWaves([a('W-1', 'p1', '1'), a('W-2', 'p1', '2'), a('W-1', 'p2', '3')]).map((x) => [x.waveId, x.pickerId])).toEqual([['W-1', 'p2'], ['W-2', 'p1']]);
    const r = (routeId: string, driverId: string): RouteAssignment => ({ routeId, storeId: 's', driverId, stops: [stop()], assignedBy: 'u', at: NOW, digest: 'd' });
    expect(latestRoutes([r('R-1', 'd1'), r('R-1', 'd2')]).map((x) => x.driverId)).toEqual(['d2']);
    expect(assignmentDigest({ pickerId: 'p', lines: [line()] })).toBe(assignmentDigest({ pickerId: 'p', lines: [line()] }));
    expect(assignmentDigest({ pickerId: 'p', lines: [line()] })).not.toBe(assignmentDigest({ pickerId: 'p', lines: [line({ requiredQty: 3 })] }));
  });
});

describe('assigning a wave to a picker', () => {
  it('records it once in the dispatcher\'s name (201), says "already assigned" for the same content again (200, one record), and REPLACES it with a new record when the content changes — history kept', async () => {
    const w = world();
    const first = await assignWave(w, 'W-1', { storeId: 'store-1', pickerId: 'u-picker', lines: [line()] });
    expect(first).toMatchObject({ status: 201, body: { waveId: 'W-1', storeId: 'store-1', pickerId: 'u-picker', lineCount: 1, assigned: true, replaced: false } });
    expect(w.waves).toHaveLength(1);
    expect(w.waves[0]).toMatchObject({ assignedBy: 'u-dispatcher', at: NOW, lines: [line()] });
    expect(w.audit.at(-1)).toMatchObject({ actorId: 'u-dispatcher', action: 'fulfilment.wave.assign', objectId: 'W-1', before: null, after: { pickerId: 'u-picker', lineCount: '1', orderRefs: 'ORD-1', replaced: 'false' } });
    const again = await assignWave(w, 'W-1', { storeId: 'store-1', pickerId: 'u-picker', lines: [line()] });
    expect(again).toMatchObject({ status: 200, body: { alreadyAssigned: true } });
    expect(w.waves).toHaveLength(1);
    const changed = await assignWave(w, 'W-1', { storeId: 'store-1', pickerId: 'u-picker', lines: [line(), line({ lineId: 'l2', productId: 'p-milk', description: 'Milk 1L' })] });
    expect(changed).toMatchObject({ status: 201, body: { lineCount: 2, replaced: true } });
    expect(w.waves).toHaveLength(2);
    expect(w.audit.at(-1)).toMatchObject({ before: { pickerId: 'u-picker', lineCount: '1' }, after: { lineCount: '2', replaced: 'true' } });
    expect(latestWaves(w.waves).map((x) => x.lines.length)).toEqual([2]);
  });

  it('REFUSES by name a picker head office does not know and one who may not pick (422) — nothing assigned; the relay routes flag, this is a person\'s act', async () => {
    const w = world();
    await expect(assignWave(w, 'W-1', { storeId: 'store-1', pickerId: 'u-stranger', lines: [line()] })).rejects.toMatchObject({ status: 422, body: { code: 'picker_unknown' } });
    await expect(assignWave(w, 'W-1', { storeId: 'store-1', pickerId: 'u-floor', lines: [line()] })).rejects.toMatchObject({ status: 422, body: { code: 'picker_lacks_authority' } });
    expect(w.waves).toEqual([]);
  });

  it.each([
    ['no store', { pickerId: 'u-picker', lines: [line()] }],
    ['no picker', { storeId: 'store-1', lines: [line()] }],
    ['no lines', { storeId: 'store-1', pickerId: 'u-picker', lines: [] }],
    ['a line with no bin', { storeId: 'store-1', pickerId: 'u-picker', lines: [line({ bin: '' })] }],
    ['a required quantity of zero', { storeId: 'store-1', pickerId: 'u-picker', lines: [line({ requiredQty: 0 })] }],
    ['two lines with one id', { storeId: 'store-1', pickerId: 'u-picker', lines: [line(), line({ productId: 'p-milk' })] }],
    ['not an object', null],
  ])('refuses %s as unreadable (400), nothing recorded', async (_why, body) => {
    const w = world();
    await expect(assignWave(w, 'W-1', body)).rejects.toMatchObject({ status: 400, body: { code: 'not_readable_as_a_wave_assignment' } });
    expect(w.waves).toEqual([]);
  });

  it('refuses to reassign a wave the wave register already holds a pack for (409) — finished work is finished', async () => {
    const w = world();
    w.packed.add('W-done');
    await expect(assignWave(w, 'W-done', { storeId: 'store-1', pickerId: 'u-picker', lines: [line()] })).rejects.toMatchObject({ status: 409, body: { code: 'wave_already_packed' } });
    expect(w.waves).toEqual([]);
  });
});

describe('assigning a route to a driver', () => {
  it('records it once (201), the same content again is one record (200), a changed content replaces it; the contribution rule is part of the content', async () => {
    const w = world();
    const body = { storeId: 'store-1', driverId: 'u-driver', stops: [stop(), stop({ stopId: 's2', orderRef: 'ORD-2', codMinor: 0, costMinor: 1200 })], contributionRule: { maxCostShareBps: 1500 } };
    expect(await assignRoute(w, 'R-1', body)).toMatchObject({ status: 201, body: { routeId: 'R-1', driverId: 'u-driver', stopCount: 2, replaced: false } });
    expect(w.routes[0]).toMatchObject({ contributionRule: { maxCostShareBps: 1500 }, stops: [{ stopId: 's1' }, { stopId: 's2', costMinor: 1200 }], assignedBy: 'u-dispatcher' });
    expect(w.audit.at(-1)).toMatchObject({ action: 'delivery.route.assign', objectId: 'R-1', after: { stopCount: '2', codMinor: '25000' } });
    expect(await assignRoute(w, 'R-1', body)).toMatchObject({ status: 200, body: { alreadyAssigned: true } });
    expect(await assignRoute(w, 'R-1', { ...body, contributionRule: { maxCostShareBps: 2000 } })).toMatchObject({ status: 201, body: { replaced: true } });
    expect(w.routes).toHaveLength(2);
  });

  it('REFUSES an unknown or unauthorised driver (422), an unreadable body (400) and a route already settled (409) — nothing assigned', async () => {
    const w = world();
    w.settled.add('R-done');
    await expect(assignRoute(w, 'R-1', { storeId: 'store-1', driverId: 'u-nobody', stops: [stop()] })).rejects.toMatchObject({ status: 422, body: { code: 'driver_unknown' } });
    await expect(assignRoute(w, 'R-1', { storeId: 'store-1', driverId: 'u-floor', stops: [stop()] })).rejects.toMatchObject({ status: 422, body: { code: 'driver_lacks_authority' } });
    await expect(assignRoute(w, 'R-1', { storeId: 'store-1', driverId: 'u-driver', stops: [stop({ codMinor: -1 })] })).rejects.toMatchObject({ status: 400, body: { code: 'not_readable_as_a_route_assignment' } });
    await expect(assignRoute(w, 'R-1', { storeId: 'store-1', driverId: 'u-driver', stops: [stop()], contributionRule: { maxCostShareBps: 'lots' } })).rejects.toMatchObject({ status: 400 });
    await expect(assignRoute(w, 'R-done', { storeId: 'store-1', driverId: 'u-driver', stops: [stop()] })).rejects.toMatchObject({ status: 409, body: { code: 'route_already_settled' } });
    expect(w.routes).toEqual([]);
  });
});

describe('what the box pulls', () => {
  it('lists only OPEN work for the store asked — the latest per wave / route, with who assigned it and when; a packed wave and a settled route drop off by themselves; another store\'s work is not listed; no store is a 400', async () => {
    const w = world();
    await assignWave(w, 'W-1', { storeId: 'store-1', pickerId: 'u-picker', lines: [line()] });
    await assignWave(w, 'W-2', { storeId: 'store-1', pickerId: 'u-picker', lines: [line({ lineId: 'l9', orderRef: 'ORD-9' })] });
    await assignWave(w, 'W-other', { storeId: 'store-2', pickerId: 'u-picker', lines: [line()] });
    await assignRoute(w, 'R-1', { storeId: 'store-1', driverId: 'u-driver', stops: [stop()] });
    await assignRoute(w, 'R-2', { storeId: 'store-1', driverId: 'u-driver', stops: [stop({ stopId: 's9' })] });
    const before = await open(w);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ asAt: NOW, storeId: 'store-1' });
    const b = before.body as { waves: { waveId: string; assignedBy: string; assignedAt: string; lines: unknown[] }[]; routes: { routeId: string }[] };
    expect(b.waves.map((x) => x.waveId)).toEqual(['W-1', 'W-2']);
    expect(b.waves[0]).toMatchObject({ pickerId: 'u-picker', assignedBy: 'u-dispatcher', assignedAt: NOW, lines: [line()] });
    expect(b.routes.map((x) => x.routeId)).toEqual(['R-1', 'R-2']);
    w.packed.add('W-1');
    w.settled.add('R-2');
    const after = await open(w);
    const a = after.body as { waves: { waveId: string }[]; routes: { routeId: string }[] };
    expect(a.waves.map((x) => x.waveId)).toEqual(['W-2']);
    expect(a.routes.map((x) => x.routeId)).toEqual(['R-1']);
    // The pure helper gives the same answer the route serves.
    const deps: AssignmentsDeps = {
      permissionsOfUser: () => undefined, waveAssignments: (_t, sid) => w.waves.filter((x) => x.storeId === sid), recordWaveAssignment: () => {},
      routeAssignments: (_t, sid) => w.routes.filter((x) => x.storeId === sid), recordRouteAssignment: () => {},
      wavePacked: (_t, id) => w.packed.has(id), routeSettled: (_t, id) => w.settled.has(id), now: () => NOW,
    };
    expect((await openAssignments(deps, A, 'store-1')).waves.map((x) => x.waveId)).toEqual(['W-2']);
    expect((await openAssignments(deps, A, 'store-2')).waves.map((x) => x.waveId)).toEqual(['W-other']);
    await expect(open(w, '')).rejects.toMatchObject({ status: 400, body: { code: 'not_readable_as_an_assignments_query' } });
  });
});
