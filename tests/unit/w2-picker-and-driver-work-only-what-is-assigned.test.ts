import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness } from '../support/api-harness';
import { ApiError, buildRouter, type Route, type RequestContext } from '../../services/kernel/src/index';
import { buildSurface } from '../../services/api/src/main';
import { assignmentsAdapter } from '../../services/api/src/adapters';
import { assignedWorkSurface, ASSIGNED_WORK_ROUTES, PICK_WORD, DRIVE_WORD } from '../../services/api/src/w2-assigned-work';

/**
 * **OB-571 (owner, 31 Oct 2026, "A") · §28 "Picker/Delivery — SCOPE: Assigned orders"**: a person who holds the phone's job
 * word only as a Picker or a Delivery driver records work only on the wave or route head office assigned to THEM — on the
 * head-office routes and on every record the store computer relays naming them. The store manager keeps the whole store.
 */

describe('every route the two job words open is held to assigned work', () => {
  it('the table names every route asking for either word, and every relayed pick or stop record', () => {
    const built = buildRouter(buildSurface({ signingKey: 'x'.repeat(32), migrationTargetKind: 'rehearsal' }));
    const routes = built.router!.list();
    const asking = routes.filter((r) => r.permission === PICK_WORD || r.permission === DRIVE_WORD).map((r) => `${r.method} ${r.path}`);
    const relayed = routes.filter((r) => r.permission === 'fulfilment.pick.sync' || r.permission === 'delivery.stop.sync').map((r) => `${r.method} ${r.path}`);
    expect(Object.keys(ASSIGNED_WORK_ROUTES).sort()).toEqual([...asking, ...relayed].sort());
  });
});

describe('on head office\'s own assignment register', () => {
  async function shop() {
    const h = apiHarness();
    const T = randomUUID();
    await h.provisionRole(T, 'u-pick', 'picker', ['store-1']);
    await h.provisionRole(T, 'u-pick2', 'picker', ['store-1']);
    await h.provisionRole(T, 'u-drive', 'delivery_driver', ['store-1']);
    await h.provisionRole(T, 'u-mgr', 'store_manager', ['store-1']);
    const reg = assignmentsAdapter({ store: h.store, now: () => '2026-11-01T05:00:00.000Z' });
    await reg.recordWaveAssignment(T, { waveId: 'W1', storeId: 'store-1', pickerId: 'u-pick', assignedBy: 'u-mgr', at: '2026-11-01T05:00:00.000Z', digest: 'd1',
      lines: [{ lineId: 'L1', orderRef: 'ORD-1', productId: 'rice', description: 'Rice', bin: 'A1', requiredQty: 1, uom: 'each', unitPriceMinor: 100 }] });
    await reg.recordRouteAssignment(T, { routeId: 'R1', storeId: 'store-1', driverId: 'u-drive', assignedBy: 'u-mgr', at: '2026-11-01T05:00:00.000Z', digest: 'r1',
      stops: [{ stopId: 'S1', orderRef: 'ORD-1', area: 'North', codMinor: 0 }] });
    // A route taken back from the driver is assigned to nobody.
    await reg.recordRouteAssignment(T, { routeId: 'R2', storeId: 'store-1', driverId: 'u-drive', assignedBy: 'u-mgr', at: '2026-11-01T05:00:00.000Z', digest: 'r2',
      stops: [{ stopId: 'S9', orderRef: 'ORD-9', area: 'South', codMinor: 0 }] });
    await reg.recordRouteAssignment(T, { routeId: 'R2', storeId: 'store-1', driverId: 'u-drive', assignedBy: 'u-mgr', at: '2026-11-01T06:00:00.000Z', digest: 'r2w',
      stops: [{ stopId: 'S9', orderRef: 'ORD-9', area: 'South', codMinor: 0 }], withdrawn: { by: 'u-mgr', at: '2026-11-01T06:00:00.000Z', reason: 'reassigned' } });
    const surface: Route[] = Object.keys(ASSIGNED_WORK_ROUTES).map((key) => {
      const [method, path] = key.split(' ') as [Route['method'], string];
      return { api: 'API-08', method, path, permission: 'x.y', idempotent: true, handler: () => ({ status: 201, body: {} }) } as Route;
    });
    assignedWorkSurface(surface, { store: h.store });
    const send = async (key: string, as: string, params: Record<string, string>, body: Record<string, unknown> = {}, branchId: string | null = 'store-1') => {
      const route = surface.find((r) => `${r.method} ${r.path}` === key)!;
      try {
        return (await route.handler({ tenantId: T, userId: as, branchId, scope: ['store-1'], params, query: {}, body, idempotencyKey: 'k', traceId: 't' } as RequestContext)).status;
      } catch (e) { if (e instanceof ApiError) return `${e.status} ${e.body.code} ${e.body.whatHappened}`; throw e; }
    };
    return { send };
  }

  it('a picker packs an order on their own wave, and is refused another order, another wave and another picker\'s relayed pick', async () => {
    const { send } = await shop();
    expect(await send('POST /v1/fulfilment/orders/:orderId/pack', 'u-pick', { orderId: 'ORD-1' })).toBe(201);
    expect(await send('POST /v1/fulfilment/orders/:orderId/dispatch', 'u-pick', { orderId: 'ORD-1' })).toBe(201);
    expect(await send('POST /v1/fulfilment/orders/:orderId/pack', 'u-pick', { orderId: 'ORD-2' })).toMatch(/^403 not_assigned_to_you u-pick works as a Picker only on a wave assigned to them; order ORD-2 at store-1 is not \(§28 "assigned orders", owner decision OB-571\)\.$/);
    expect(await send('POST /v1/fulfilment/orders/:orderId/pack', 'u-pick2', { orderId: 'ORD-1' })).toMatch(/^403 not_assigned_to_you/);
    // Relayed from the box: judged on the person the record names, not on the box.
    expect(await send('POST /v1/fulfilment/waves/:waveId/lines/:lineId/synced', 'u-box', { waveId: 'W1', lineId: 'L1' }, { pickedBy: 'u-pick' })).toBe(201);
    expect(await send('POST /v1/fulfilment/waves/:waveId/packed/synced', 'u-box', { waveId: 'W1' }, { packedBy: 'u-pick' })).toBe(201);
    expect(await send('POST /v1/fulfilment/waves/:waveId/lines/:lineId/synced', 'u-box', { waveId: 'W1', lineId: 'L1' }, { pickedBy: 'u-pick2' })).toMatch(/^403 not_assigned_to_you .*Do not|^403 not_assigned_to_you/);
    expect(await send('POST /v1/fulfilment/waves/:waveId/packed/synced', 'u-box', { waveId: 'W2' }, { packedBy: 'u-pick' })).toMatch(/^403 not_assigned_to_you/);
    // With no store named, what is assigned cannot be read: refused, never guessed.
    expect(await send('POST /v1/fulfilment/orders/:orderId/pack', 'u-pick', { orderId: 'ORD-1' }, {}, null)).toMatch(/^403 not_assigned_to_you .*names no store/);
  });

  it('a driver records stops, proof, settlement, cash and attempts on their own route only; a withdrawn route is nobody\'s', async () => {
    const { send } = await shop();
    for (const key of ['POST /v1/delivery/routes/:routeId/stops/:stopId/synced', 'POST /v1/delivery/routes/:routeId/stops/:stopId/proof/synced', 'POST /v1/delivery/routes/:routeId/settled/synced', 'POST /v1/delivery/routes/:routeId/handover/synced']) {
      expect(await send(key, 'u-box', { routeId: 'R1', stopId: 'S1' }, { driverId: 'u-drive' }), key).toBe(201);
      expect(await send(key, 'u-box', { routeId: 'R2', stopId: 'S9' }, { driverId: 'u-drive' }), key).toMatch(/^403 not_assigned_to_you/);
      expect(await send(key, 'u-box', { routeId: 'R1', stopId: 'S1' }, { driverId: 'u-pick' }), key).toBe(201); // a picker does not hold the driver's word: left to the route
    }
    expect(await send('POST /v1/delivery/attempts', 'u-drive', {}, { orderId: 'ORD-1' })).toBe(201);
    expect(await send('POST /v1/delivery/attempts', 'u-drive', {}, { orderId: 'ORD-9' })).toMatch(/^403 not_assigned_to_you u-drive works as a Delivery driver only on a route assigned to them/);
    expect(await send('POST /v1/delivery/orders/:orderId/transition', 'u-drive', { orderId: 'ORD-1' })).toBe(201);
    expect(await send('POST /v1/delivery/orders/:orderId/transition', 'u-drive', { orderId: 'ORD-3' })).toMatch(/^403 not_assigned_to_you/);
  });

  it('the store manager keeps the whole store', async () => {
    const { send } = await shop();
    expect(await send('POST /v1/fulfilment/orders/:orderId/pack', 'u-mgr', { orderId: 'ORD-2' })).toBe(201);
    expect(await send('POST /v1/delivery/attempts', 'u-mgr', {}, { orderId: 'ORD-9' })).toBe(201);
    expect(await send('POST /v1/delivery/routes/:routeId/settled/synced', 'u-box', { routeId: 'R7' }, { driverId: 'u-mgr' })).toBe(201);
  });
});
