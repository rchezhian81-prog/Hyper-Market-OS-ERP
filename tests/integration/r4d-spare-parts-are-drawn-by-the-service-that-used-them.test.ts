import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **Round 4d · M26-FR-01 "asset, warranty, AMC, service AND SPARE tracking".** A spare part is registered with the assets it
 * fits and the level below which the shop wants more; stock received is a movement; a service that used spares draws them
 * from the register — refused, by name, when the part does not fit the asset or is not on hand; a re-sent service draws
 * nothing twice; on hand is the sum of the movements (never an overwritten number); the facilities office read warns of a
 * low spare; and a restarted head office (a new process on the same database) reads the same. Also: the facilities set-up's
 * schedule list, and an asset or schedule renamed is a change (never a silent no-op). In memory and, with DATABASE_URL, on
 * real PostgreSQL.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness; restart?: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) {
  const onPg = () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: onPg, restart: onPg });
}

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASH = 'u-cash';
const S = 'store-1';

describe.each(backings)('M26-FR-01 — spare parts are drawn by the service that used them — on $name', ({ harness, restart }) => {
  const A = randomUUID();
  let h: ApiHarness;
  const send = (hh: ApiHarness, method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>, key?: string) =>
    hh.request({ method, path, userId, tenantId: A, branchId: S, ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
  const codeOf = (r: { body: unknown }) => (r.body as { error?: { code?: string } }).error?.code;
  const spares = async (hh: ApiHarness) => ((await send(hh, 'GET', '/v1/facilities/spares', MGR, undefined, { branchId: S })).body as { spares: { sparePartId: string; onHand: number; low: boolean; movements: { kind: string; qty: number; serviceId?: string }[] }[]; low: number }).spares;

  beforeAll(async () => {
    h = harness();
    await h.seedOwner(A, OWNER);
    await h.provisionRole(A, MGR, 'store_manager', [S]);
    await h.provisionRole(A, CASH, 'cashier', [S]);
    for (const [id, name] of [['chiller-1', 'Dairy chiller'], ['dg-1', 'Generator']]) {
      const r = await send(h, 'POST', `/v1/facilities/assets/${id}`, MGR, { branchId: S, name, kind: id === 'dg-1' ? 'power_dg' : 'refrigeration', criticality: 'critical', installedOn: '2025-01-10' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
  });

  it('a part is registered with the assets it fits; one naming a stranger asset is refused', async () => {
    const bad = await send(h, 'POST', '/v1/facilities/spares/fan-motor', MGR, { branchId: S, name: 'Condenser fan motor', compatibleAssetIds: ['chiller-9'], minimumLevel: 2 });
    expect(bad.status).toBe(422);
    expect(codeOf(bad)).toBe('spare_fits_unknown_asset');
    const ok = await send(h, 'POST', '/v1/facilities/spares/fan-motor', MGR, { branchId: S, name: 'Condenser fan motor', compatibleAssetIds: ['chiller-1'], minimumLevel: 2, unit: 'each' });
    expect(ok.status).toBe(201);
    expect((await send(h, 'POST', '/v1/facilities/spares/fan-motor', CASH, { branchId: S, name: 'x', compatibleAssetIds: [], minimumLevel: 0 })).status).toBe(403);
  });

  it('stock received is a movement; a correction below nought is refused', async () => {
    expect((await send(h, 'POST', '/v1/facilities/spares/fan-motor/movements/rcv-1', MGR, { kind: 'received', qty: 2, on: '2026-10-30' })).status).toBe(201);
    const under = await send(h, 'POST', '/v1/facilities/spares/fan-motor/movements/cnt-1', MGR, { kind: 'correction', qty: -3, on: '2026-10-31', reason: 'counted' });
    expect(under.status).toBe(409);
    expect(codeOf(under)).toBe('spare_not_enough');
    expect((await spares(h)).find((p) => p.sparePartId === 'fan-motor')!.onHand).toBe(2);
  });

  it('a service draws its spares; more than on hand, or a part that does not fit, is refused and nothing is logged', async () => {
    const svc = (assetId: string, serviceId: string, qty: number, key?: string) => send(h, 'POST', `/v1/facilities/assets/${assetId}/services/${serviceId}`, MGR, { performedOn: '2026-10-31', performedBy: 'Cool Air AMC', kind: 'breakdown', sparesUsed: [{ sparePartId: 'fan-motor', qty }] }, undefined, key);
    const first = await svc('chiller-1', 'svc-1', 1, 'svc-1-key');
    expect(first.status).toBe(201);
    expect((first.body as { sparesUsed: unknown[] }).sparesUsed).toEqual([{ sparePartId: 'fan-motor', qty: 1 }]);
    // the same service sent again (a new key — a person pressed again) draws nothing twice
    expect((await svc('chiller-1', 'svc-1', 1)).status).toBe(201);
    const tooMany = await svc('chiller-1', 'svc-2', 2);
    expect(tooMany.status).toBe(409);
    expect(codeOf(tooMany)).toBe('spare_not_enough');
    const wrongAsset = await svc('dg-1', 'svc-3', 1);
    expect(wrongAsset.status).toBe(409);
    expect(codeOf(wrongAsset)).toBe('spare_not_compatible');
    const part = (await spares(h)).find((p) => p.sparePartId === 'fan-motor')!;
    expect(part.onHand).toBe(1);
    expect(part.low).toBe(true);
    expect(part.movements.map((m) => [m.kind, m.qty, m.serviceId])).toEqual([['used', -1, 'svc-1'], ['received', 2, undefined]]);
  });

  it('the facilities office read warns of the low spare', async () => {
    const office = (await send(h, 'GET', '/v1/facilities/office', MGR, undefined, { branchId: S })).body as { spares: { kept: boolean; low: { sparePartId: string; onHand: number; minimumLevel: number }[] } };
    expect(office.spares.kept).toBe(true);
    expect(office.spares.low).toEqual([{ sparePartId: 'fan-motor', name: 'Condenser fan motor', onHand: 1, minimumLevel: 2, unit: 'each' }]);
  });

  it.runIf(restart !== undefined)('a restarted head office reads the same on hand', async () => {
    const again = restart!();
    expect((await spares(again)).find((p) => p.sparePartId === 'fan-motor')!.onHand).toBe(1);
  });

  it('a renamed asset and a renamed schedule are saved as changes, and the schedule list shows them', async () => {
    await send(h, 'POST', '/v1/facilities/assets/chiller-1', MGR, { branchId: S, name: 'Dairy chiller (aisle 3)', kind: 'refrigeration', criticality: 'critical', installedOn: '2025-01-10' });
    const office = (await send(h, 'GET', '/v1/facilities/office', MGR, undefined, { branchId: S })).body as { assets: { assetId: string; name: string }[] };
    expect(office.assets.find((a) => a.assetId === 'chiller-1')?.name).toBe('Dairy chiller (aisle 3)');
    const sched = { branchId: S, title: 'Pest control', category: 'pest_control', frequency: 'monthly', assignedRole: 'store_manager', escalatesTo: 'u-owner', evidenceRequired: true, verificationRequired: false };
    expect((await send(h, 'POST', '/v1/facilities/schedules/pest', MGR, sched)).status).toBe(201);
    expect((await send(h, 'POST', '/v1/facilities/schedules/pest', MGR, { ...sched, title: 'Pest control (licensed vendor)' })).status).toBe(201);
    expect((await send(h, 'POST', '/v1/facilities/schedules/pest/tasks/pest-2026-11', MGR, { dueOn: '2026-11-05' })).status).toBe(201);
    const list = (await send(h, 'GET', '/v1/facilities/schedules', MGR, undefined, { branchId: S })).body as { schedules: { scheduleId: string; title: string; tasksRaised: number; lastDueOn: string; open: number }[] };
    expect(list.schedules).toEqual([expect.objectContaining({ scheduleId: 'pest', title: 'Pest control (licensed vendor)', tasksRaised: 1, lastDueOn: '2026-11-05', open: 1 })]);
  });
});
