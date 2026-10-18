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
import { DEFAULT_RETAIL_POSTING_MAP, parseFinancialYear } from '../../packages/finance/src/index';

/**
 * **R3 A18 — GSTR-9 and GSTR-9C fold from the filed year (signed OB-188), in memory AND on real PostgreSQL, with a cold
 * restart.**
 *
 * FY 2025-26: one paneer sale a month at the till. GSTR-1 for each month was filed before cutover (recorded with its
 * acknowledgement as filed outside this system), GSTR-3B is locked to it and recorded filed — except March, at first.
 * GSTR-9 is then INCOMPLETE and names March twice (GSTR-1 not filed and locked; GSTR-3B not recorded filed); its ITC is
 * "not known" (the input-credit reconciliation, A17, has not run) — never zero. Once March is filed, GSTR-9 is complete:
 * Table 4 is the twelve locked months. GSTR-9C puts the day book beside it: the accountant posted every day but 5 March,
 * so March is a named difference ("the day book has not been posted for 2026-03-05"), OPEN until a person records a
 * reason; the other eleven months reconcile. GSTR-9C cannot be recorded filed before GSTR-9. Both are due 31 December.
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
const FY = '2025-26';
const PERIODS = parseFinancialYear(FY).periods;
const dayOf = (period: string): string => `${period.slice(2)}-${period.slice(0, 2)}-05`;
interface G9 { complete: boolean; missing: { period: string; reason: string }[]; table4Outward: { heads: { taxableMinor: number; cgstMinor: number } }; table6Itc: { allOther: { status: string } }; dueDate: string }
interface G9c { differences: { period: string; code: string; turnoverMinor: number; explained: boolean; reason?: string; reasonBy?: string }[]; open: number; books: { turnoverMinor: number }; gstr9: { turnoverMinor: number }; dueDate: string }

describe.each(backings)('GSTR-9 and GSTR-9C fold from the filed year — on $name (A18)', ({ harness, restart }) => {
  it('incomplete until every month is filed → complete from the twelve locked months → 9C names the unposted day', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-acct', 'accountant');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const req = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, userId = 'u-owner'): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method !== 'GET' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };

    await ok(req('PUT', '/v1/finance/posting-map', DEFAULT_RETAIL_POSTING_MAP, 'u-acct'), 'posting map');
    for (const period of PERIODS) {
      const day = dayOf(period);
      await ok(req('POST', '/v1/sales', {
        saleId: `S-${period}`, receiptNumber: `R-${period}`, laneId: 'lane-1', cashierId: 'u-owner', tradingDay: day, committedAt: `${day}T05:30:00Z`, totalMinor: 10_500, currency: 'INR', packVersion: 1,
        lines: [{ productId: 'p-paneer', quantityMinor: 1, uom: 'each', unitPriceMinor: 10_500, lineTotalMinor: 10_500, hsnCode: '040610', taxRateBps: 500 }],
        tenders: [{ kind: 'cash', amountMinor: 10_500 }],
      }), `sale ${period}`);
      if (period !== '032026') await ok(req('POST', `/v1/finance/day-book/${day}/post`, {}, 'u-acct'), `day book ${day}`);
    }
    const fileMonth = async (period: string): Promise<void> => {
      await ok(req('POST', `/v1/finance/returns/GSTR1/${period}/filed`, { arn: `AA33${period}G1`, filedOn: '2026-04-11' }), `GSTR-1 ${period}`);
      await ok(req('POST', `/v1/finance/gstr3b/${period}/lock`, {}, 'u-mgr'), `lock ${period}`);
      await ok(req('POST', `/v1/finance/returns/GSTR3B/${period}/filed`, { arn: `AA33${period}G3`, filedOn: '2026-04-20' }), `GSTR-3B ${period}`);
    };
    for (const period of PERIODS.filter((p) => p !== '032026')) await fileMonth(period);

    let g9 = (await ok(req('GET', `/v1/finance/gstr9/${FY}`), 'GSTR-9')).body as G9;
    expect(g9.complete).toBe(false);
    expect(g9.missing).toEqual([{ period: '032026', reason: 'gstr1_not_filed_and_locked' }, { period: '032026', reason: 'gstr3b_not_recorded_filed' }]);
    expect(g9.table4Outward.heads.taxableMinor).toBe(11 * 10_000);
    expect(g9.table6Itc.allOther.status).toBe('not_known');
    expect(g9.dueDate).toBe('2026-12-31');
    expect((await req('GET', `/v1/finance/gstr9/${FY}`, undefined, 'u-cash')).status).toBe(403);
    expect(codeOf(await req('GET', '/v1/finance/gstr9/2025-27'))).toBe('financial_year_invalid');

    await fileMonth('032026');
    h = restart(h);
    g9 = (await ok(req('GET', `/v1/finance/gstr9/${FY}`), 'GSTR-9 complete')).body as G9;
    expect(g9.complete).toBe(true);
    expect(g9.missing).toEqual([]);
    expect(g9.table4Outward.heads).toMatchObject({ taxableMinor: 12 * 10_000, cgstMinor: 12 * 250 });

    // ── GSTR-9C: books (the day book) vs GSTR-9 — every difference named ─────────────────────────────────────────
    let c = (await ok(req('GET', `/v1/finance/gstr9c/${FY}`), 'GSTR-9C')).body as G9c;
    expect(c.dueDate).toBe('2026-12-31');
    expect(c.gstr9.turnoverMinor).toBe(120_000);
    expect(c.books.turnoverMinor).toBe(110_000);
    expect(c.differences).toEqual([expect.objectContaining({ period: '032026', code: 'books_differ_from_till', turnoverMinor: -10_000, explained: false, reason: 'the day book has not been posted for 2026-03-05' })]);
    expect(c.open).toBe(1);
    expect(codeOf(await req('POST', `/v1/finance/gstr9c/${FY}/reasons`, { period: '022026', code: 'books_differ_from_till', reason: 'x' }, 'u-mgr'))).toBe('no_such_difference');
    expect((await req('POST', `/v1/finance/gstr9c/${FY}/reasons`, { period: '032026', code: 'books_differ_from_till', reason: 'x' }, 'u-cash')).status).toBe(403);
    await ok(req('POST', `/v1/finance/gstr9c/${FY}/reasons`, { period: '032026', code: 'books_differ_from_till', reason: 'the 5 March day book is posted in the audited accounts by journal JV-SYN-17 (synthetic)' }, 'u-mgr'), 'reason');
    c = (await ok(req('GET', `/v1/finance/gstr9c/${FY}`), 'GSTR-9C again')).body as G9c;
    expect(c.differences[0]).toMatchObject({ explained: true, reasonBy: 'u-mgr' });
    expect(c.open).toBe(0);

    // ── recorded filed: GSTR-9C only after GSTR-9 ──────────────────────────────────────────────────────────────────
    expect(codeOf(await req('POST', `/v1/finance/returns/GSTR9C/${FY}/filed`, { arn: 'AA33G9C', filedOn: '2026-10-01' }))).toBe('gstr9_not_filed');
    await ok(req('POST', `/v1/finance/returns/GSTR9/${FY}/filed`, { arn: 'AA33G9', filedOn: '2026-10-01' }), 'GSTR-9 filed');
    await ok(req('POST', `/v1/finance/returns/GSTR9C/${FY}/filed`, { arn: 'AA33G9C', filedOn: '2026-10-01' }), 'GSTR-9C filed');
    const cal = (await ok(req('GET', '/v1/finance/filing-calendar'), 'calendar')).body as { entries: { type: string; period: string; warning: string; dueDate: string }[] };
    expect(cal.entries.find((e) => e.type === 'GSTR9' && e.period === FY)).toMatchObject({ warning: 'filed', dueDate: '2026-12-31' });
    expect(cal.entries.find((e) => e.type === 'GSTR9C' && e.period === FY)).toMatchObject({ warning: 'filed', dueDate: '2026-12-31' });
  }, 120_000);
});
