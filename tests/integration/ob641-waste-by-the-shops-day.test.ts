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
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **OB-641 (owner, 1 Nov 2026): head office reads waste by the SHOP's day, for the trend on the Waste analytics page.**
 *
 * `GET /v1/waste/analytics/by-day?from&to` — beside the reason / department / product breakdown, permission-checked like
 * it (`waste.view`), scoped like it (the caller's branches). On the real API, in memory and — with DATABASE_URL — on real
 * PostgreSQL:
 *   • every shop day of the window is listed, write-offs and waste records side by side and never added together;
 *   • an event lands on the SHOP's day (20:00 UTC is 01:30 the next morning in the shop), and its value and count are the
 *     same events the breakdown reads (the two reconcile);
 *   • a cashier (no `waste.view`) is refused 403; a missing, back-to-front or over-92-day window is refused 400 in words.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

type Res = { status: number; body: unknown };
interface Day { day: string; writeOffs: { events: number; valueMinor: number }; wasteRecords: { events: number; valueMinor: number } }

describe.each(backings)('OB-641 — waste by the shop\'s day — on $name', ({ harness }) => {
  it('lists every shop day of the window, on the shop\'s clock, reconciling to the breakdown; refuses a cashier and a bad window', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body, idempotencyKey: `${path}-${Math.random()}` }), ...(query === undefined ? {} : { query }) });

    // Waste records with their own moments: 10 Oct morning, and 11 Oct 20:00 UTC — which is 01:30 on 12 Oct in the shop.
    const record = (id: string, at: string, valueMinor: number) => call('POST', `/v1/waste/records/${id}`, 'u-mgr', { branchId: 'store-1', departmentId: 'bakery', productId: 'BREAD', at, valueMinor, disposal: 'composted', source: 'expiry' });
    expect((await record('r1', '2026-10-10T03:00:00.000Z', 2_500)).status).toBeLessThan(300);
    expect((await record('r2', '2026-10-10T09:00:00.000Z', 1_000)).status).toBeLessThan(300);
    expect((await record('r3', '2026-10-11T20:00:00.000Z', 4_000)).status).toBeLessThan(300);
    // A write-off now (its moment is when head office took it).
    expect((await call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'rcv-MILK', productId: 'MILK', locationId: 'store-1', kind: 'received', quantityMinor: 100, uom: 'ea', occurredAt: '2026-10-01T09:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 5_000 })).status).toBe(202);
    expect((await call('POST', '/v1/inventory/write-off/w1', 'u-mgr', { locationId: 'store-1', uom: 'ea', productId: 'MILK', qty: 2, lossType: 'expiry', reasonCode: 'expiry' })).status).toBe(201);

    const trend = await call('GET', '/v1/waste/analytics/by-day', 'u-owner', undefined, { from: '2026-10-09', to: '2026-10-12' });
    expect(trend.status).toBe(200);
    const days = (trend.body as { days: Day[] }).days;
    expect(days.map((d) => d.day)).toEqual(['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']);
    expect(days.map((d) => [d.wasteRecords.events, d.wasteRecords.valueMinor])).toEqual([[0, 0], [2, 3_500], [0, 0], [1, 4_000]]);
    // reconciles to the breakdown over the same window
    const breakdown = (await call('GET', '/v1/waste/analytics', 'u-owner', undefined, { from: '2026-10-09', to: '2026-10-12' })).body as { wasteRecords: { events: number; totalValueMinor: number } };
    expect(days.reduce((t, d) => t + d.wasteRecords.valueMinor, 0)).toBe(breakdown.wasteRecords.totalValueMinor);
    expect(days.reduce((t, d) => t + d.wasteRecords.events, 0)).toBe(breakdown.wasteRecords.events);

    // the write-off is on today's shop day, never added to the records
    const today = shopDateIn(new Date().toISOString());
    const now = (await call('GET', '/v1/waste/analytics/by-day', 'u-mgr', undefined, { from: today, to: today })).body as { days: Day[] };
    expect(now.days).toEqual([{ day: today, writeOffs: { events: 1, valueMinor: 10_000 }, wasteRecords: { events: 0, valueMinor: 0 } }]);

    // the same permission as the breakdown: a cashier is refused
    expect((await call('GET', '/v1/waste/analytics/by-day', 'u-cash', undefined, { from: today, to: today })).status).toBe(403);
    // a bad window, in words
    for (const q of [{}, { from: '2026-10-12', to: '2026-10-09' }, { from: '2026-01-01', to: '2026-10-01' }]) {
      const r = await call('GET', '/v1/waste/analytics/by-day', 'u-owner', undefined, q as Record<string, string>);
      expect(r.status, JSON.stringify(q)).toBe(400);
      expect((r.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/\?from=YYYY-MM-DD|at most 92 days/);
    }
  });
});
