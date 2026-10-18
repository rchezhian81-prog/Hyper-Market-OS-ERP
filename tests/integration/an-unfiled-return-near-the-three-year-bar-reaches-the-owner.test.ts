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
import { localDateOf } from '../../services/api/src/r3-gst-adapters';

/**
 * **R3 A19 — the filing calendar and the three-year time bar (signed OB-188), in memory AND on real PostgreSQL, with a
 * cold restart.**
 *
 * The shop traded four years ago (every return of that month is now permanently BARRED), three years ago (its returns
 * fall barred within about two months) and this month. The calendar lists every GSTR-1 / GSTR-3B month and every
 * GSTR-9 / GSTR-9C year with its due date (GSTR-9/9C: 31 December after the year) and status, most urgent first. The
 * barred returns are owner exceptions. The owner has not set N, so "near the bar" is not judged — and the calendar says
 * so rather than guess. Only the owner may set N; once he sets it, the three-year-old month is "near the time bar".
 * Raising the exceptions puts each into every owner's alert inbox, once (a second raise finds them open). When a return
 * is recorded filed (here, a GSTR-1 filed outside this system before cutover), its alert is cleared.
 *
 * The months are chosen from today's date, with weeks of slack either side, so the result does not depend on when it runs.
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

const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => apiHarness({ store: h.store }) },
];
if (DATABASE_URL !== undefined) {
  const sqlHarness = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: sqlHarness, restart: sqlHarness });
}

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const pad = (n: number): string => String(n).padStart(2, '0');
const TODAY = localDateOf(new Date().toISOString(), 'Asia/Kolkata');
const Y = Number(TODAY.slice(0, 4));
const M = Number(TODAY.slice(5, 7));
const fp = (y: number, m: number): string => `${pad(m)}${y}`;
const BARRED = fp(Y - 4, M);     // due a month later, four years ago — barred about eleven months ago
const NEAR = fp(Y - 3, M);       // GSTR-3B due on the 20th of next month, three years ago — barred in roughly 3–8 weeks
const NOW = fp(Y, M);
interface Entry { type: string; period: string; warning: string; dueDate: string; ownerException: boolean }
interface Cal { entries: Entry[]; nearBarNotJudged: boolean; ownerExceptions: Entry[]; nearBarDays: number | null }

describe.each(backings)('an unfiled return near the three-year bar reaches the owner — on $name (A19)', ({ harness, restart }) => {
  it('calendar → barred returns are exceptions → N not set is said → owner sets N → near-bar raised to every owner once → cleared when filed', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionOwner(T, 'u-owner-2');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const req = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, userId = 'u-owner'): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method !== 'GET' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const sell = (saleId: string, period: string) => {
      const day = `${period.slice(2)}-${period.slice(0, 2)}-05`;
      return ok(req('POST', '/v1/sales', {
        saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-owner', tradingDay: day, committedAt: `${day}T05:30:00Z`, totalMinor: 10_500, currency: 'INR', packVersion: 1,
        lines: [{ productId: 'p-paneer', quantityMinor: 1, uom: 'each', unitPriceMinor: 10_500, lineTotalMinor: 10_500, hsnCode: '040610', taxRateBps: 500 }],
        tenders: [{ kind: 'cash', amountMinor: 10_500 }],
      }), `sale ${saleId}`);
    };
    await sell('S-OLD', BARRED);
    await sell('S-NEAR', NEAR);
    await sell('S-NOW', NOW);
    const calendar = async (): Promise<Cal> => (await ok(req('GET', '/v1/finance/filing-calendar'), 'calendar')).body as Cal;

    let cal = await calendar();
    const months = (Y - (Y - 4)) * 12 + 1; // every month from four years ago to this one
    expect(cal.entries.filter((e) => e.type === 'GSTR1')).toHaveLength(months);
    expect(cal.entries.filter((e) => e.type === 'GSTR3B')).toHaveLength(months);
    const g9 = cal.entries.filter((e) => e.type === 'GSTR9');
    expect(g9.length).toBeGreaterThanOrEqual(4);
    expect(g9.every((e) => e.dueDate.endsWith('-12-31'))).toBe(true);
    expect(cal.entries.find((e) => e.type === 'GSTR3B' && e.period === BARRED)?.warning).toBe('time_barred');
    expect(cal.entries.find((e) => e.type === 'GSTR3B' && e.period === NEAR)?.warning).toBe('overdue');
    expect(cal.entries.find((e) => e.type === 'GSTR1' && e.period === NOW)?.warning).toBe('period_not_ended');
    expect(cal.entries[0]!.warning).toBe('time_barred'); // the most urgent first
    expect(cal.nearBarDays).toBeNull();
    expect(cal.nearBarNotJudged).toBe(true);
    expect((await req('GET', '/v1/finance/filing-calendar', undefined, 'u-cash')).status).toBe(403);

    // ── only the owner sets N; it must be a whole number of days ───────────────────────────────────────────────────
    expect((await req('PUT', '/v1/finance/gst/controls/time-bar-warning-days', { days: 400, reason: 'x' }, 'u-mgr')).status).toBe(403);
    expect(codeOf(await req('PUT', '/v1/finance/gst/controls/time-bar-warning-days', { days: 0, reason: 'x' }))).toBe('warning_days_need_days_and_reason');
    await ok(req('PUT', '/v1/finance/gst/controls/time-bar-warning-days', { days: 400, reason: 'warn me well before a return is lost (synthetic)' }), 'set N');
    h = restart(h);
    cal = await calendar();
    expect(cal.nearBarDays).toBe(400);
    expect(cal.nearBarNotJudged).toBe(false);
    expect(cal.entries.find((e) => e.type === 'GSTR3B' && e.period === NEAR)).toMatchObject({ warning: 'near_time_bar', ownerException: true });
    const exceptions = cal.ownerExceptions.map((e) => `${e.type}:${e.period}`);
    expect(exceptions).toEqual(expect.arrayContaining([`GSTR1:${BARRED}`, `GSTR3B:${BARRED}`, `GSTR1:${NEAR}`, `GSTR3B:${NEAR}`]));

    // ── raised to EVERY owner's alert inbox, once ──────────────────────────────────────────────────────────────────
    expect((await req('POST', '/v1/finance/filing-calendar/raise-owner-exceptions', {}, 'u-cash')).status).toBe(403);
    const first = (await ok(req('POST', '/v1/finance/filing-calendar/raise-owner-exceptions', {}, 'u-mgr'), 'raise')).body as { raised: number; alreadyOpen: number; owners: number };
    expect(first).toMatchObject({ raised: exceptions.length, alreadyOpen: 0, owners: 2 });
    const again = (await ok(req('POST', '/v1/finance/filing-calendar/raise-owner-exceptions', {}, 'u-mgr'), 'raise again')).body as { raised: number; alreadyOpen: number };
    expect(again).toMatchObject({ raised: 0, alreadyOpen: exceptions.length });
    const board = (await ok(req('GET', '/v1/platform/alerts'), 'board')).body as { alerts: { alert: { alertId: string; ownerUserId: string; alsoToUserIds?: string[]; detail: string }; state: string }[] };
    const mine = board.alerts.filter((a) => a.alert.alertId.startsWith('gst-time-bar:'));
    expect(mine).toHaveLength(exceptions.length);
    const near3b = mine.find((a) => a.alert.alertId === `gst-time-bar:GSTR3B:${NEAR}`)!;
    expect([near3b.alert.ownerUserId, ...(near3b.alert.alsoToUserIds ?? [])].sort()).toEqual(['u-owner', 'u-owner-2']);
    expect(near3b.alert.detail).toMatch(/permanently barred/);

    // ── recorded filed (a GSTR-1 filed before cutover, outside this system): its alert clears ─────────────────────
    await ok(req('POST', `/v1/finance/returns/GSTR1/${NEAR}/filed`, { arn: 'AA33SYN000001', filedOn: `${NEAR.slice(2)}-${pad(Math.min(12, Number(NEAR.slice(0, 2)) + 1))}-10` }), 'record GSTR-1 filed');
    const cleared = (await ok(req('POST', '/v1/finance/filing-calendar/raise-owner-exceptions', {}, 'u-mgr'), 'raise after filing')).body as { cleared: number };
    expect(cleared.cleared).toBe(1);
    cal = await calendar();
    expect(cal.entries.find((e) => e.type === 'GSTR1' && e.period === NEAR)?.warning).toBe('filed');
  }, 90_000);
});
