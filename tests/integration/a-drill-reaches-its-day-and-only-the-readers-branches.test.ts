import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore, MemoryIdempotencyStore } from '../../services/kernel/src/index';

/**
 * **The governed drill reaches the bills of the day asked for, and only the branches the reader's grant covers (audit
 * EA-05 · M29-FR-02 · NFR-15 · §28).**
 *
 * Bills are posted by the till's sync identity on two trading days at two stores. Through `POST
 * /v1/reporting/drill/governed` — head office loads the headline and its source bills itself:
 *   • PERIOD — the cash figure for day 1 opens exactly day 1's cash bills; day 2 opens day 2's; a day with no trade has
 *     no cash bills behind it (nothing invented).
 *   • GRANT SCOPE — a manager whose grant covers S2 only, signed in at S2, sees S2's cash bills and S2's headline;
 *     asking for S1, or for everything, is refused by name; a cashier cannot drill at all.
 *   • NO CALLER ROWS — the old caller-rows drill answers 410 and logs nothing; a forged headline/rows in a governed
 *     drill's body are ignored.
 * Every governed drill is logged with who reached what. In memory and on PostgreSQL, across a restart.
 */

const OWNER = 'u-owner'; const CASHIER = 'u-cash'; const S2_MANAGER = 'u-mgr-s2';
const D1 = '2026-10-08'; const D2 = '2026-10-09'; const EMPTY = '2026-10-07';
const BILLS = [
  { saleId: 'D1-S1-a', day: D1, at: `${D1}T05:00:00.000Z`, loc: 'S1', tenders: [['cash', 30_000]] },
  { saleId: 'D1-S1-b', day: D1, at: `${D1}T06:00:00.000Z`, loc: 'S1', tenders: [['card', 20_000], ['cash', 5_000]] },
  { saleId: 'D1-S2-a', day: D1, at: `${D1}T07:00:00.000Z`, loc: 'S2', tenders: [['cash', 12_000]] },
  { saleId: 'D2-S1-a', day: D2, at: `${D2}T05:00:00.000Z`, loc: 'S1', tenders: [['cash', 7_000]] },
  { saleId: 'D2-S2-a', day: D2, at: `${D2}T06:00:00.000Z`, loc: 'S2', tenders: [['cash', 9_000], ['upi', 1_000]] },
] as const;

async function seed(h: ApiHarness, T: string): Promise<void> {
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, CASHIER, 'cashier');
  await h.provisionRole(T, S2_MANAGER, 'store_manager', ['S2']);
  const ok = async (method: 'POST' | 'PUT', path: string, userId: string, body: unknown, key: string) => {
    const r = await h.request({ method, path, userId, tenantId: T, idempotencyKey: key, body });
    expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  };
  await ok('PUT', '/v1/platform/setup/locale.time_zone', OWNER, { value: 'UTC' }, 'tz');
  for (const b of BILLS) {
    const total = b.tenders.reduce((t, [, a]) => t + a, 0);
    await ok('POST', '/v1/sales', CASHIER, {
      saleId: b.saleId, receiptNumber: `R-${b.saleId}`, laneId: `lane-${b.loc}`, locationId: b.loc, cashierId: CASHIER,
      tradingDay: b.day, committedAt: b.at, totalMinor: total, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'P-X', quantityMinor: 1, uom: 'ea', unitPriceMinor: total, lineTotalMinor: total }],
      tenders: b.tenders.map(([kind, amountMinor]) => ({ kind, amountMinor })),
    }, `sale-${b.saleId}`);
  }
}

interface Drill { status: number; body: { provenance?: string; reconciles?: boolean; kpiValueMinor?: number; shownTotalMinor?: number; withheldCount?: number; transactions?: { transactionId: string; amountMinor: number; branchId: string }[]; tradingDay?: string; error?: { code: string } } }
const drill = async (h: ApiHarness, T: string, userId: string, body: Record<string, unknown>, key: string, branchId?: string): Promise<Drill> =>
  (await h.request({ method: 'POST', path: '/v1/reporting/drill/governed', userId, tenantId: T, idempotencyKey: key, body, ...(branchId === undefined ? {} : { branchId }) })) as Drill;
const ids = (d: Drill) => (d.body.transactions ?? []).map((t) => t.transactionId).sort();

async function checks(h: ApiHarness, T: string, tag: string): Promise<void> {
  // PERIOD — day 1's cash bills, exactly; day 2's, exactly.
  const d1 = await drill(h, T, OWNER, { reportId: 'tender_mix', figure: 'cash', day: D1 }, `${tag}-d1`);
  expect(d1.status, JSON.stringify(d1.body)).toBe(200);
  expect(d1.body).toMatchObject({ provenance: 'governed', reconciles: true, kpiValueMinor: 47_000, shownTotalMinor: 47_000, tradingDay: D1 });
  expect(ids(d1)).toEqual(['D1-S1-a', 'D1-S1-b', 'D1-S2-a']);
  const d2 = await drill(h, T, OWNER, { reportId: 'tender_mix', figure: 'cash', day: D2 }, `${tag}-d2`);
  expect(d2.body).toMatchObject({ reconciles: true, kpiValueMinor: 16_000, tradingDay: D2 });
  expect(ids(d2)).toEqual(['D2-S1-a', 'D2-S2-a']);
  // A day with no trade: no cash bills behind it — nothing invented.
  const none = await drill(h, T, OWNER, { reportId: 'tender_mix', figure: 'cash', day: EMPTY }, `${tag}-d0`);
  expect([404, 409]).toContain(none.status);
  expect(none.body.transactions).toBeUndefined();

  // GRANT SCOPE — the S2 manager, signed in at S2, sees S2's bills and S2's headline only.
  const s2 = await drill(h, T, S2_MANAGER, { reportId: 'tender_mix', figure: 'cash', day: D1 }, `${tag}-s2`, 'S2');
  expect(s2.status, JSON.stringify(s2.body)).toBe(200);
  expect(ids(s2)).toEqual(['D1-S2-a']);
  expect((s2.body.transactions ?? []).every((t) => t.branchId === 'S2')).toBe(true);
  expect(s2.body).toMatchObject({ shownTotalMinor: 12_000, kpiValueMinor: 12_000, withheldCount: 0 }); // the HEADLINE is the grant's too
  // Asking for S1, or for everything, is refused by name — the body cannot widen the grant.
  expect((await drill(h, T, S2_MANAGER, { reportId: 'tender_mix', figure: 'cash', day: D1, branchScope: ['S1'] }, `${tag}-s2-s1`, 'S2')).body.error?.code).toBe('scope_not_held');
  expect((await drill(h, T, S2_MANAGER, { reportId: 'tender_mix', figure: 'cash', day: D1, branchScope: 'all' }, `${tag}-s2-all`, 'S2')).body.error?.code).toBe('scope_not_held');
  // The owner can narrow to one store.
  const own = await drill(h, T, OWNER, { reportId: 'tender_mix', figure: 'cash', day: D2, branchScope: ['S1'] }, `${tag}-own-s1`);
  expect(ids(own)).toEqual(['D2-S1-a']);
  // A cashier cannot drill.
  expect((await drill(h, T, CASHIER, { reportId: 'tender_mix', figure: 'cash', day: D1 }, `${tag}-cash`)).status).toBe(403);

  // NO CALLER ROWS — the old route is retired (410, nothing logged); a forged body is ignored by the governed drill.
  const before = ((await h.request({ method: 'GET', path: '/v1/reporting/drill-audits', userId: OWNER, tenantId: T })).body as { count: number }).count;
  const retired = await h.request({ method: 'POST', path: '/v1/reporting/drill', userId: OWNER, tenantId: T, idempotencyKey: `${tag}-old`, body: { metric: 'cash', kpiValueMinor: 1, transactions: [] } });
  expect(retired.status).toBe(410);
  expect((retired.body as { error: { code: string } }).error.code).toBe('caller_rows_not_accepted');
  const forged = await drill(h, T, OWNER, { reportId: 'tender_mix', figure: 'cash', day: D1, kpiValueMinor: 1, transactions: [{ transactionId: 'FAKE', amountMinor: 1 }] }, `${tag}-forged`);
  expect(forged.body.kpiValueMinor).toBe(47_000);
  expect(ids(forged)).not.toContain('FAKE');
  const audits = ((await h.request({ method: 'GET', path: '/v1/reporting/drill-audits', userId: OWNER, tenantId: T })).body as { audits: { userId: string; metric: string }[]; count: number });
  expect(audits.count).toBe(before + 1); // the forged-body governed drill was logged; the retired route logged nothing
  expect(audits.audits.some((a) => a.userId === S2_MANAGER && a.metric === 'tender_mix:cash')).toBe(true);
}

describe('the governed drill — its day, and only the reader\'s branches (EA-05)', () => {
  it('in memory, and after a restart', async () => {
    const T = 'ab000000-0000-4000-8000-0000000ea005';
    const h = apiHarness();
    await seed(h, T);
    await checks(h, T, 'mem');
    await checks(apiHarness({ store: h.store, idempotency: new MemoryIdempotencyStore() }), T, 'restart');
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(!DATABASE_URL)('the governed drill — its day, and only the reader\'s branches — real PostgreSQL (EA-05)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(`${dir}/${name}`, 'utf8') })));
  });
  afterAll(async () => { await pool.end(); });

  it('the same checks on PostgreSQL, and from a second instance', async () => {
    const sql = pgPoolClient(pool);
    const T = randomUUID();
    const h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    await seed(h, T);
    await checks(h, T, 'pg');
    await checks(apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }), T, 'pg2');
  });
});
