import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { tradingDayIn } from '../../packages/calendar/src/index';

/**
 * **OB-288 P2 · M29-FR-04 — the owner schedules any report or export, and it is prepared with nobody pressing anything.**
 *
 * Through the production route table (in memory, and on PostgreSQL across a cold restart): the owner schedules "Sales by
 * day" and the sales export for 00:00 (so today's is due); one pass prepares each ONCE (a second pass prepares nothing);
 * the report run keeps its figures with their freshness, the export run keeps the file — made through the governed export
 * under the owner's own authority and logged on the export ledger like one he took by hand. Sending is switched off
 * (OB-222) and every run says so. A manager cannot schedule; a report head office cannot produce is refused; a stopped
 * schedule prepares nothing more.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASHIER = 'u-cash';
const today = (): string => tradingDayIn(new Date().toISOString(), { timeZone: 'Asia/Kolkata', tradingDayCutoff: '00:00' });
const post = (h: ApiHarness, T: string, path: string, userId: string, body: unknown = {}) => h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: `k-${randomUUID()}`, body });
const get = (h: ApiHarness, T: string, path: string, userId: string, query?: Record<string, string>) => h.request({ method: 'GET', path, userId, tenantId: T, ...(query === undefined ? {} : { query }) });

type Run = { scheduleId: string; tradingDay: string; outcome: string; sending: string; detail: string; lines: string[]; figures?: { name: string; valueMinor?: number; asAt: string | null }[]; csv?: string; rowCount?: number };

async function seed(h: ApiHarness, T: string): Promise<void> {
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, MGR, 'store_manager');
  await h.provisionRole(T, CASHIER, 'cashier');
  const at = new Date(Date.now() - 60_000).toISOString();
  for (const [saleId, total] of [['B-1', 30_000], ['B-2', 12_000], ['B-3', 9_000]] as const) {
    const r = await post(h, T, '/v1/sales', CASHIER, {
      saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', locationId: 'S1', cashierId: CASHIER, tradingDay: today(), committedAt: at,
      totalMinor: total, currency: 'INR', packVersion: 1, lines: [{ productId: 'P-X', quantityMinor: 1, uom: 'ea', unitPriceMinor: total, lineTotalMinor: total }],
      tenders: [{ kind: 'cash', amountMinor: total }],
    });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  }
}

async function scheduleAndRun(h: ApiHarness, T: string): Promise<void> {
  expect((await post(h, T, '/v1/reporting/report-schedules/s-sales', MGR, { kind: 'report', target: 'sales_by_day', dueAt: [0, 0] })).status).toBe(403);
  expect((await post(h, T, '/v1/reporting/report-schedules/s-bad', OWNER, { kind: 'report', target: 'no_such_report', dueAt: [0, 0] })).status).toBe(422);
  expect((await post(h, T, '/v1/reporting/report-schedules/s-bad', OWNER, { kind: 'export', target: 'no-such-domain', dueAt: [0, 0] })).status).toBe(422);
  expect((await post(h, T, '/v1/reporting/report-schedules/s-bad', OWNER, { kind: 'report', target: 'sales_by_day', dueAt: [25, 0] })).status).toBe(400);
  expect((await post(h, T, '/v1/reporting/report-schedules/s-sales', OWNER, { kind: 'report', target: 'sales_by_day', dueAt: [0, 0], language: 'ta' })).status).toBe(201);
  expect((await post(h, T, '/v1/reporting/report-schedules/s-export', OWNER, { kind: 'export', target: 'sales', dueAt: [0, 0] })).status).toBe(201);

  const first = (await post(h, T, '/v1/reporting/report-schedules/run', OWNER)).body as { prepared: number; runs: Run[] };
  expect(first.prepared, JSON.stringify(first).slice(0, 800)).toBe(2);
  expect(first.runs.every((r) => r.outcome === 'prepared' && r.sending === 'switched_off' && r.detail.includes('NOT sent'))).toBe(true);
  expect(((await post(h, T, '/v1/reporting/report-schedules/run', OWNER)).body as { prepared: number }).prepared).toBe(0);

  const report = ((await get(h, T, '/v1/reporting/report-schedules/s-sales/runs', OWNER, { day: today() })).body as { run: Run }).run;
  expect(report.figures!.find((f) => f.name === 'Taken')!.valueMinor).toBe(51_000);
  expect(report.figures!.find((f) => f.name === 'Taken')!.asAt).not.toBeNull();
  expect(report.lines[0]).toContain('Sales by day');
  const exported = ((await get(h, T, '/v1/reporting/report-schedules/s-export/runs', OWNER, { day: today() })).body as { run: Run }).run;
  expect(exported.rowCount).toBe(3);
  expect(exported.csv!.split('\n')[0]).toContain('saleId');
  // Logged on the export ledger as the owner's own export.
  const log = ((await get(h, T, '/v1/exports', OWNER)).body as { exports: { userId: string; domain: string; rowCount: number }[] }).exports;
  expect(log.filter((e) => e.domain === 'sales' && e.userId === OWNER)).toEqual([expect.objectContaining({ rowCount: 3 })]);
  // The list shows each schedule's latest run (without the file).
  const list = (await get(h, T, '/v1/reporting/report-schedules', OWNER)).body as { schedules: { schedule: { scheduleId: string; language: string }; runs: number; lastRun: { hasFile: boolean } }[]; sending: string };
  expect(list.sending).toBe('switched_off');
  expect(list.schedules.map((s) => [s.schedule.scheduleId, s.runs, s.lastRun.hasFile])).toEqual([['s-export', 1, true], ['s-sales', 1, false]]);
  // A cashier reads nothing of it.
  expect((await get(h, T, '/v1/reporting/report-schedules', CASHIER)).status).toBe(403);
}

async function stopping(h: ApiHarness, T: string): Promise<void> {
  expect((await post(h, T, '/v1/reporting/report-schedules/s-sales/stop', OWNER, {})).status).toBe(400);
  expect((await post(h, T, '/v1/reporting/report-schedules/s-sales/stop', OWNER, { reason: 'the brief covers it' })).status).toBe(200);
  expect((await post(h, T, '/v1/reporting/report-schedules/nope/stop', OWNER, { reason: 'x' })).status).toBe(404);
  expect(((await post(h, T, '/v1/reporting/report-schedules/run', OWNER)).body as { prepared: number }).prepared).toBe(0);
}

describe('M29-FR-04 — scheduled reports and exports prepare themselves (OB-288 P2, in memory)', () => {
  it('each due run is prepared once, kept, and the export is the owner\'s own, logged', async () => {
    const T = 'ab000000-0000-4000-8000-00000000529f';
    const h = apiHarness();
    await seed(h, T);
    await scheduleAndRun(h, T);
    await stopping(h, T);
  }, 120_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(!DATABASE_URL)('M29-FR-04 — scheduled reports on PostgreSQL, through a cold restart', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(`${dir}/${name}`, 'utf8') })));
  }, 120_000);
  afterAll(async () => { await pool.end(); });

  it('the runs are kept; after a restart nothing is prepared twice', async () => {
    const sql = pgPoolClient(pool);
    const T = randomUUID();
    const h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    await seed(h, T);
    await scheduleAndRun(h, T);
    const again = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    expect(((await post(again, T, '/v1/reporting/report-schedules/run', OWNER)).body as { prepared: number }).prepared).toBe(0);
    expect(((await get(again, T, '/v1/reporting/report-schedules/s-export/runs', OWNER)).body as { runs: Run[] }).runs).toHaveLength(1);
    await stopping(again, T);
  }, 120_000);
});
