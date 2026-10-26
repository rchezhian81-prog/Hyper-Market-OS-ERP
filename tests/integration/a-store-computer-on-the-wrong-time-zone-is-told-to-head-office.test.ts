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
import { boxHealthReportOf } from '../../edge/sync-agent/src/box-health-report';
import { zoneCheck } from '../../edge/store-edge/src/shop-zone';

/**
 * **R3 · P-08 — a store computer whose machine keeps another time zone than the shop's is told to HEAD OFFICE, not only on
 * its own screens.** The box puts its own check (`zoneCheck`, edge/store-edge/src/shop-zone.ts) on the health report it
 * sends after each sync pass; head office keeps it on the report (append-only) and shows it in its observed health — the
 * store's `box_time_zone:<store>` line `degraded` with words, and each box's `zoneCheck` for the Store computers page. On the
 * real head-office API, in memory and (with DATABASE_URL) on real PostgreSQL, across a cold restart:
 *
 *   • the box made its report on a UTC machine for an Asia/Kolkata shop: head office says so, by name, `degraded`;
 *   • a later report from a box set right reads `ok`;
 *   • a report whose zoneCheck is not readable is refused by name (400), nothing kept;
 *   • an older box that says nothing about its zone is kept as before, with no zone line (never "fine").
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

type Factory = (same?: ApiHarness) => ApiHarness;
const backings: { name: string; harness: Factory }[] = [{ name: 'the in-memory event store', harness: (same) => apiHarness(same === undefined ? {} : { store: same.store }) }];
if (DATABASE_URL !== undefined) {
  backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });
}

const MB = 1_048_576;
const pack = { policies: { known: true, value: { tradingDayCutoff: '00:00', timeZone: 'Asia/Kolkata' } } };
interface Component { name: string; status: string; detail: string; evidence?: Record<string, string | number> }
interface Observed { observed: { boxes: { storeId: string; zoneCheck?: { verdict: string; machineTimeZone: string; shopTimeZone: string } | null }[] }; health: { components: Component[] } }

const reportFrom = (machineZone: string, observedAt: string) => boxHealthReportOf({
  now: () => observedAt,
  disk: async () => ({ freeBytes: 900 * MB, totalBytes: 1000 * MB, salesLogUsedBytes: 10 * MB, salesLogCapacityBytes: 500 * MB, reserveBytes: 5 * MB }),
  queues: () => [{ unsentCount: 0, deadLetterCount: 0 }],
  tills: () => [],
  zone: () => zoneCheck(pack, machineZone),
});

describe.each(backings)('R3 · P-08 — a store computer on the wrong time zone is told to head office — on $name', ({ harness }) => {
  it('kept on the report, said by name in head office health and on each box, refused when unreadable, the same after a restart', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box1', 'store_computer', ['S1']);
    let n = 0;
    const call = (hh: ApiHarness, method: 'GET' | 'POST', path: string, userId: string, body?: unknown) =>
      hh.request({ method, path, userId, tenantId: T, ...(userId === 'u-box1' ? { branchId: 'S1' } : {}), ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `k-${n += 1}` }) });
    const observed = async (hh: ApiHarness) => (await call(hh, 'GET', '/v1/platform/operational-health/observed', 'u-owner')).body as Observed;
    const zoneLine = (o: Observed) => o.health.components.find((c) => c.name === 'box_time_zone:S1');
    const now = new Date().toISOString();

    // ── 1 · An older box says nothing about its zone: kept as before, and no zone line is invented.
    const old = await reportFrom('UTC', now);
    const withoutZone = Object.fromEntries(Object.entries(old).filter(([k]) => k !== 'zoneCheck'));
    expect((await call(h, 'POST', '/v1/store-computers/health-reports', 'u-box1', withoutZone)).status).toBe(200);
    expect(zoneLine(await observed(h))).toBeUndefined();

    // ── 2 · Unreadable zoneCheck: refused by name, nothing kept.
    const bad = await call(h, 'POST', '/v1/store-computers/health-reports', 'u-box1', { ...old, zoneCheck: { verdict: 'perhaps', shopTimeZone: 'Asia/Kolkata' } });
    expect([bad.status, (bad.body as { error: { code: string; whatHappened: string } }).error.code]).toEqual([400, 'not_readable_as_box_health']);
    expect((bad.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/zoneCheck needs verdict/);

    // ── 3 · A UTC machine for an Asia/Kolkata shop: said at head office, degraded, by name; on the box's own line too.
    const wrong = await reportFrom('UTC', new Date(Date.now() + 1_000).toISOString());
    expect(wrong.zoneCheck).toEqual({ verdict: 'differs', shopTimeZone: 'Asia/Kolkata', shopTimeZoneFrom: 'store_pack', machineTimeZone: 'UTC' });
    const kept = await call(h, 'POST', '/v1/store-computers/health-reports', 'u-box1', wrong);
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect((kept.body as { recorded: { zoneCheck?: unknown } }).recorded.zoneCheck).toEqual(wrong.zoneCheck);
    let o = await observed(h);
    expect(zoneLine(o)).toMatchObject({ status: 'degraded', evidence: { verdict: 'differs', machineTimeZone: 'UTC', shopTimeZone: 'Asia/Kolkata', computer: 'u-box1' } });
    expect(zoneLine(o)!.detail).toMatch(/keeps the time zone UTC, not the shop's \(Asia\/Kolkata\)/);
    expect(zoneLine(o)!.detail).toMatch(/still dated by the shop's zone/);
    expect(o.observed.boxes.find((b) => b.storeId === 'S1')?.zoneCheck).toMatchObject({ verdict: 'differs', machineTimeZone: 'UTC' });

    // ── 4 · A cold restart reads the same from the kept report.
    const h2 = harness(h);
    o = await observed(h2);
    expect(zoneLine(o)?.status).toBe('degraded');
    expect(o.observed.boxes.find((b) => b.storeId === 'S1')?.zoneCheck).toMatchObject({ verdict: 'differs', machineTimeZone: 'UTC' });

    // ── 5 · IT sets the machine right: the next report reads ok.
    const right = await reportFrom('Asia/Kolkata', new Date(Date.now() + 2_000).toISOString());
    expect((await call(h2, 'POST', '/v1/store-computers/health-reports', 'u-box1', right)).status).toBe(200);
    expect(zoneLine(await observed(h2))).toMatchObject({ status: 'ok' });
  }, 60_000);
});
