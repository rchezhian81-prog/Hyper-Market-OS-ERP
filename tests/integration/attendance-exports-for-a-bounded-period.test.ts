import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore, MemoryIdempotencyStore } from '../../services/kernel/src/index';
import { REDACTED } from '../../packages/export/src/export';

/**
 * **Attendance leaves through the governed export for a bounded period (audit SF-10 round 5b · M30-FR-02 · M25/M26 · P-04 ·
 * hard rule #6).** The last domain the coverage register named as "not yet". Through the real API, in memory and on
 * PostgreSQL:
 *   • a period is REQUIRED and bounded (from ≤ to, at most 92 days (OB-51)) — anything else is refused before anything is read,
 *     and nothing is logged;
 *   • each day's rows EQUAL the attendance store's own read for that day (`GET /v1/hr/workforce/attendance?date=`) — the
 *     latest record wins, a day outside the period is not included — with the branch and rate from the staff register;
 *   • SCOPE — a manager of S2, signed in at S2, exports only S2's staff; signed in at a branch not held is refused;
 *   • REDACTION — hours, rate and cost are pay-relevant: shown to the owner (export.sensitive), [redacted] for the manager;
 *   • 403 — a cashier and an accountant export nothing;
 *   • the EXPORT LOG keeps each export with its period, row count and redactions, read back after a restart.
 */

const OWNER = 'u-owner'; const MGR_S2 = 'u-mgr-s2'; const CASHIER = 'u-cash'; const BOOKS = 'u-books';
const PERIOD = { from: '2026-09-01', to: '2026-09-03' };
type Csv = string[][];
const parse = (csv: string): Csv => csv.trim().split('\n').map((l) => l.split(','));
const col = (rows: Csv, name: string): string[] => { const i = rows[0]!.indexOf(name); expect(i, name).toBeGreaterThanOrEqual(0); return rows.slice(1).map((r) => r[i]!); };

async function seed(h: ApiHarness, T: string): Promise<void> {
  let n = 0;
  const ok = async (path: string, body: unknown) => {
    const r = await h.request({ method: 'POST', path, userId: OWNER, tenantId: T, idempotencyKey: `seed-${++n}`, body });
    expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  };
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, MGR_S2, 'store_manager', ['S2']);
  await h.provisionRole(T, CASHIER, 'cashier');
  await h.provisionRole(T, BOOKS, 'accountant');
  await ok('/v1/hr/workforce/employees/E-1', { name: 'Asha', branchId: 'S1', roles: ['cashier'], active: true, hourlyRateMinor: 12_000 });
  await ok('/v1/hr/workforce/employees/E-2', { name: 'Bala', branchId: 'S2', roles: ['cashier'], active: true, hourlyRateMinor: 15_000 });
  await ok('/v1/hr/workforce/employees/E-3', { name: 'Chitra', branchId: 'S2', roles: ['cashier'], active: true });
  await ok('/v1/hr/workforce/attendance/E-1/2026-09-01', { hours: 8 });
  await ok('/v1/hr/workforce/attendance/E-1/2026-09-01', { hours: 7.5 }); // a correction — the latest record wins
  await ok('/v1/hr/workforce/attendance/E-2/2026-09-01', { hours: 6 });
  await ok('/v1/hr/workforce/attendance/E-2/2026-09-02', { hours: 9 });
  await ok('/v1/hr/workforce/attendance/E-3/2026-09-02', { hours: 5 });
  await ok('/v1/hr/workforce/attendance/E-1/2026-09-03', { hours: 4 });
  await ok('/v1/hr/workforce/attendance/E-2/2026-09-10', { hours: 8 }); // outside the period
}

async function checks(h: ApiHarness, T: string, again: () => ApiHarness): Promise<void> {
  let k = 0;
  const exp = (userId: string, body: unknown, branchId?: string) =>
    h.request({ method: 'POST', path: '/v1/export/attendance', userId, tenantId: T, idempotencyKey: `att-${userId}-${++k}`, body, ...(branchId === undefined ? {} : { branchId }) });
  const dayRead = async (date: string, userId = OWNER, branchId?: string) =>
    ((await h.request({ method: 'GET', path: '/v1/hr/workforce/attendance', userId, tenantId: T, query: { date }, ...(branchId === undefined ? {} : { branchId }) })).body as { attendance: { employeeId: string; date: string; hours: number }[] }).attendance;
  const logBefore = ((await h.request({ method: 'GET', path: '/v1/exports', userId: OWNER, tenantId: T })).body as { total: number }).total;

  // OB-51 (owner, 11 Oct 2026): at most 92 days — a quarter per export — as head office states it to the console.
  const domains = (await h.request({ method: 'GET', path: '/v1/export', userId: OWNER, tenantId: T })).body as { domains: { domain: string; period?: { maxDays: number } }[] };
  expect(domains.domains.find((d) => d.domain === 'attendance')?.period?.maxDays).toBe(92);

  // ── A bounded period is required: none, reversed, or longer than 92 days (OB-51) is refused before anything is read.
  for (const body of [{}, { from: '2026-09-03', to: '2026-09-01' }, { from: '2026-06-01', to: '2026-09-01' }, { from: '2026-09-31', to: '2026-10-01' }]) {
    const r = await exp(OWNER, body);
    expect(r.status, JSON.stringify(body)).toBe(400);
    expect((r.body as { error: { code: string } }).error.code).toBe('export_period_not_bounded');
  }
  expect(((await h.request({ method: 'GET', path: '/v1/exports', userId: OWNER, tenantId: T })).body as { total: number }).total).toBe(logBefore);

  // ── The owner: every staff member's day, equal to the attendance read for each day, with rate and cost.
  const own = await exp(OWNER, PERIOD);
  expect(own.status, JSON.stringify(own.body)).toBe(200);
  const rows = parse((own.body as { csv: string }).csv);
  const fromExport = col(rows, 'date').map((d, i) => `${d}|${col(rows, 'employeeId')[i]}|${col(rows, 'hours')[i]}`).sort();
  const fromReads: string[] = [];
  for (const date of ['2026-09-01', '2026-09-02', '2026-09-03']) for (const r of await dayRead(date)) fromReads.push(`${r.date}|${r.employeeId}|${r.hours}`);
  expect(fromExport).toEqual(fromReads.sort());
  expect(fromExport).toEqual(['2026-09-01|E-1|7.5', '2026-09-01|E-2|6', '2026-09-02|E-2|9', '2026-09-02|E-3|5', '2026-09-03|E-1|4']);
  const at = (date: string, emp: string): number => col(rows, 'date').findIndex((d, i) => d === date && col(rows, 'employeeId')[i] === emp);
  expect(col(rows, 'branch')[at('2026-09-01', 'E-1')]).toBe('S1');
  expect(col(rows, 'costMinor')[at('2026-09-01', 'E-1')]).toBe('90000'); // 7.5 h × ₹120.00
  expect(col(rows, 'costMinor')[at('2026-09-02', 'E-3')]).toBe('');      // no rate on the register — blank, never invented
  expect((own.body as { audit: { period: unknown; redactedColumns: string[] } }).audit).toMatchObject({ period: PERIOD, redactedColumns: [] });

  // ── A manager of S2, signed in at S2: S2's staff only — the same people the manager's own day read shows — and the
  // pay-relevant columns REDACTED (no export.sensitive).
  const mine = await exp(MGR_S2, PERIOD, 'S2');
  expect(mine.status, JSON.stringify(mine.body)).toBe(200);
  const s2 = parse((mine.body as { csv: string }).csv);
  const managerReads: string[] = [];
  for (const date of ['2026-09-01', '2026-09-02', '2026-09-03']) for (const r of await dayRead(date, MGR_S2, 'S2')) managerReads.push(`${r.date}|${r.employeeId}`);
  expect(col(s2, 'date').map((d, i) => `${d}|${col(s2, 'employeeId')[i]}`).sort()).toEqual(managerReads.sort());
  expect(new Set(col(s2, 'branch'))).toEqual(new Set(['S2']));
  for (const c of ['hours', 'hourlyRateMinor', 'costMinor']) expect(new Set(col(s2, c)), c).toEqual(new Set([REDACTED]));
  // Signed in at a branch not held; a cashier; an accountant — refused, and nothing taken.
  expect((await exp(MGR_S2, PERIOD, 'S1')).status).toBe(403);
  expect((await exp(CASHIER, PERIOD)).status).toBe(403);
  expect((await exp(BOOKS, PERIOD)).status).toBe(403);

  // ── The export log, read after a restart: each export with its period, rows and redactions; no refused one.
  const log = ((await again().request({ method: 'GET', path: '/v1/exports', userId: OWNER, tenantId: T })).body as { exports: { userId: string; domain: string; rowCount: number; branchId: string | null; period?: unknown; redactedColumns: string[] }[] }).exports.filter((e) => e.domain === 'attendance');
  expect(log.map((e) => [e.userId, e.rowCount, e.branchId]).sort()).toEqual([[MGR_S2, 3, 'S2'], [OWNER, 5, null]]);
  for (const e of log) expect(e.period).toEqual(PERIOD);
  expect(log.find((e) => e.userId === MGR_S2)!.redactedColumns.sort()).toEqual(['costMinor', 'hourlyRateMinor', 'hours']);
  // The coverage register now names nothing as "not yet".
  const cov = (await h.request({ method: 'GET', path: '/v1/export/coverage', userId: OWNER, tenantId: T })).body as { notYet: number; coverage: { exportDomain?: string; offeredHere: boolean }[] };
  expect(cov.notYet).toBe(0);
  expect(cov.coverage.find((c) => c.exportDomain === 'attendance')!.offeredHere).toBe(true);
}

describe('attendance exports for a bounded period (SF-10 round 5b)', () => {
  it('own read per day, scope, redaction, 400/403 and the log (in memory)', async () => {
    const T = 'ab000000-0000-4000-8000-0000005f010a';
    const idem = new MemoryIdempotencyStore();
    const h = apiHarness({ idempotency: idem });
    await seed(h, T);
    await checks(h, T, () => apiHarness({ store: h.store, idempotency: idem }));
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(!DATABASE_URL)('attendance exports for a bounded period — real PostgreSQL (SF-10 round 5b)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(`${dir}/${name}`, 'utf8') })));
  });
  afterAll(async () => { await pool.end(); });

  it('the same on PostgreSQL, the log read back after a restart', async () => {
    const sql = pgPoolClient(pool);
    const make = () => apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    const T = randomUUID();
    const h = make();
    await seed(h, T);
    await checks(h, T, make);
  });
});
