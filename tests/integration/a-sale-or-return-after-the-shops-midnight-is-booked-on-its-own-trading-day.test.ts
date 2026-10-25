// M01-FR-02 · M23-FR-01 · M14-FR-04 · P-08 — the books date a till's sale AND its return by the SHOP's trading day (its time
// zone and its cut-off), never by the UTC calendar date of the moment.
//
// The till stamps each sale with the shop's trading day, so sales were always right. Returns carry no stamp, and the day
// book read them by `processedAt.slice(0, 10)` — the UTC date. In Tamil Nadu (Asia/Kolkata, UTC+05:30) that is the
// PREVIOUS day for the five and a half hours after the shop's midnight, so a refund given at 00:40 IST on the 6th was
// booked in the 5th's day book: the 5th's cash in hand came out short by the refund and the 6th's long by it, while the
// till's own shift close and day close held it on the 6th. The GST return's returned lines carried the same UTC date, and
// GSTR-1-from-sales read its window from 00:00 UTC on the 1st, so a bill rung between the shop's midnight and 05:30 IST on
// the 1st of a month fell inside neither month's return.
//
// On the real API — in memory and, with DATABASE_URL, on real PostgreSQL. Synthetic data only (hard rule #7).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { withApprovals } from '../support/refund-approval';
import { ownerApprovedSetting } from '../support/owner-approved-setting';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { tradingDayIn } from '../../packages/calendar/src/trading-day';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

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

const OWNER = 'u-owner'; const ACCT = 'u-acct'; const MGR = 'u-mgr';
const RICE = { productId: 'RICE', hsnCode: '1006', taxBps: 500, price: 10_500 };
const SOAP = { productId: 'SOAP', hsnCode: '3401', taxBps: 1800, price: 11_800 };
const D = '2026-08-05';
const D1 = '2026-08-06';
/** The instant a wall-clock time in Tamil Nadu (UTC+05:30, no daylight saving) is. */
const ist = (localDateTime: string): string => new Date(Date.parse(`${localDateTime}:00.000+05:30`)).toISOString();

interface Journal { kind: string; documentDate: string; sources: number; lines: { accountCode: string; debitMinor: number; creditMinor: number }[] }
interface DayRead { journals: Journal[]; accounts: { accountCode: string; balanceMinor: number }[]; open: number }

async function shop(h: ApiHarness, tenantId: string): Promise<void> {
  await h.seedOwner(tenantId, OWNER);
  await h.provisionRole(tenantId, ACCT, 'accountant');
  await h.provisionRole(tenantId, MGR, 'store_manager');
  await h.store.append(tenantId, STREAM.catalogue, makeEvent({
    id: 'pack-v1', type: 'CataloguePublished', occurredAt: '2026-08-01T00:00:00Z', idempotencyKey: `catalogue-${tenantId}-v1`, source: 'test/catalogue',
    payload: { snapshot: { tenantId, version: 1, builtAt: '2026-08-01T00:00:00Z', products: [RICE, SOAP].map(({ productId, hsnCode, taxBps }) => ({ productId, hsnCode, taxBps })), barcodes: [] } },
  }));
  expect((await h.request({ method: 'PUT', path: '/v1/finance/posting-map', userId: ACCT, tenantId, idempotencyKey: 'map', body: DEFAULT_RETAIL_POSTING_MAP })).status).toBe(200);
}

/** A till's cash sale of `qty` of a product, stamped with the shop's trading day exactly as the till stamps it. */
async function sell(h: ApiHarness, tenantId: string, saleId: string, product: typeof RICE, qty: number, committedAt: string, tradingDay: string): Promise<void> {
  const total = product.price * qty;
  const res = await h.request({
    method: 'POST', path: '/v1/sales', userId: OWNER, tenantId, idempotencyKey: `sale-${saleId}`,
    body: {
      saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: OWNER, tradingDay, committedAt, totalMinor: total, currency: 'INR', packVersion: 1,
      lines: [{ productId: product.productId, quantityMinor: qty, uom: 'each', unitPriceMinor: product.price, lineTotalMinor: total }],
      tenders: [{ kind: 'cash', amountMinor: total }],
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

/** One unit of the bill comes back for cash at `processedAt`, approved by the manager in their own session. */
async function giveBack(h: ApiHarness, tenantId: string, saleId: string, returnId: string, product: typeof RICE, processedAt: string): Promise<void> {
  const res = await h.request({
    method: 'POST', path: `/v1/sales/${saleId}/returns`, userId: OWNER, tenantId, idempotencyKey: `ret-${returnId}`,
    body: await withApprovals(h, tenantId, OWNER, saleId, {
      returnId, number: returnId, reasonCode: 'changed_mind', refundMinor: product.price, refundTender: 'cash', approvedBy: MGR, processedAt,
      lines: [{ productId: product.productId, quantityMinor: 1, uom: 'each', disposition: 'resell' }],
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

async function postedDay(h: ApiHarness, tenantId: string, day: string): Promise<DayRead> {
  const posted = await h.request({ method: 'POST', path: `/v1/finance/day-book/${day}/post`, userId: ACCT, tenantId, idempotencyKey: `post-${day}` });
  expect(posted.status, JSON.stringify(posted.body)).toBeLessThan(300);
  expect((posted.body as { exceptions: unknown[] }).exceptions).toEqual([]);
  return (await h.request({ method: 'GET', path: `/v1/finance/day-book/${day}`, userId: ACCT, tenantId })).body as DayRead;
}
const balance = (day: DayRead, code: string): number => day.accounts.find((a) => a.accountCode === code)?.balanceMinor ?? 0;
const sourcesOf = (day: DayRead, kind: string): number => day.journals.filter((j) => j.kind === kind).reduce((n, j) => n + j.sources, 0);

describe.each(backings)('a sale or a return after the shop\'s midnight is booked on its own trading day — on $name', ({ harness }) => {
  it('the shop\'s default calendar (Asia/Kolkata, cut-off 00:00): a 23:30 IST bill and refund stay on the 5th, a 00:30 IST bill and refund go to the 6th — and so does the cash', async () => {
    const h = harness();
    const T = randomUUID();
    await shop(h, T);
    const calendar = { timeZone: 'Asia/Kolkata', tradingDayCutoff: '00:00' };
    const late = { sold: ist(`${D}T23:30`), back: ist(`${D}T23:40`) };     // 18:00Z and 18:10Z on the 5th
    const early = { sold: ist(`${D1}T00:30`), back: ist(`${D1}T00:40`) };  // 19:00Z and 19:10Z on the 5th — the UTC date is still the 5th
    expect([late.sold, early.back]).toEqual(['2026-08-05T18:00:00.000Z', '2026-08-05T19:10:00.000Z']);
    // The till's own stamp for each bill (what `tradingDayFor` writes at commit).
    expect([tradingDayIn(late.sold, calendar), tradingDayIn(early.sold, calendar)]).toEqual([D, D1]);

    await sell(h, T, 'S-LATE', RICE, 2, late.sold, D);     // ₹210 cash
    await giveBack(h, T, 'S-LATE', 'R-LATE', RICE, late.back);   // ₹105 cash back
    await sell(h, T, 'S-EARLY', SOAP, 2, early.sold, D1);  // ₹236 cash
    await giveBack(h, T, 'S-EARLY', 'R-EARLY', SOAP, early.back); // ₹118 cash back

    const day = await postedDay(h, T, D);
    const next = await postedDay(h, T, D1);
    // Each trading day holds exactly its own bill and its own refund...
    expect([sourcesOf(day, 'sale'), sourcesOf(day, 'sale_return'), sourcesOf(day, 'refund:cash')]).toEqual([1, 1, 1]);
    expect([sourcesOf(next, 'sale'), sourcesOf(next, 'sale_return'), sourcesOf(next, 'refund:cash')]).toEqual([1, 1, 1]);
    // ...so the cash in hand each day posts is what that day's drawer took less what it paid back.
    expect(balance(day, 'cash_in_hand')).toBe(2 * RICE.price - RICE.price);
    expect(balance(next, 'cash_in_hand')).toBe(2 * SOAP.price - SOAP.price);
    for (const d of [day, next]) {
      expect(balance(d, 'sales_clearing')).toBe(0);
      expect(d.open).toBe(0);
    }
    expect(day.journals.every((j) => j.documentDate === D)).toBe(true);
    expect(next.journals.every((j) => j.documentDate === D1)).toBe(true);
  });

  it('a cut-off of 02:00: a refund at 01:30 IST still belongs to the day before; one at 03:00 IST belongs to the new day', async () => {
    const h = harness();
    const T = randomUUID();
    await shop(h, T);
    expect((await ownerApprovedSetting(h, T, 'trading_day.cutoff', { value: '02:00' }, OWNER)).status).toBe(200);
    const calendar = { timeZone: 'Asia/Kolkata', tradingDayCutoff: '02:00' };
    const sold = ist(`${D}T21:00`);
    const beforeCutoff = ist(`${D1}T01:30`); // 20:00Z on the 5th: trading day the 5th
    const afterCutoff = ist(`${D1}T03:00`);  // 21:30Z on the 5th: trading day the 6th — the UTC date says the 5th
    expect([tradingDayIn(sold, calendar), tradingDayIn(beforeCutoff, calendar), tradingDayIn(afterCutoff, calendar)]).toEqual([D, D, D1]);

    await sell(h, T, 'S-1', RICE, 2, sold, D);
    await sell(h, T, 'S-2', SOAP, 2, sold, D);
    await giveBack(h, T, 'S-1', 'R-BEFORE', RICE, beforeCutoff);
    await giveBack(h, T, 'S-2', 'R-AFTER', SOAP, afterCutoff);

    const day = await postedDay(h, T, D);
    const next = await postedDay(h, T, D1);
    expect([sourcesOf(day, 'sale'), sourcesOf(day, 'refund:cash')]).toEqual([2, 1]);
    expect(balance(day, 'cash_in_hand')).toBe(2 * RICE.price + 2 * SOAP.price - RICE.price);
    expect(sourcesOf(next, 'refund:cash')).toBe(1);
    expect(balance(next, 'cash_in_hand')).toBe(-SOAP.price);
  });

  it('GSTR-1 from sales: a bill and a refund rung at 00:30 IST on the 1st are on that month\'s return, not lost between two months', async () => {
    const h = harness();
    const T = randomUUID();
    await shop(h, T);
    const sold = ist('2026-09-01T00:30');   // 19:00Z on 31 August
    const back = ist('2026-09-01T00:45');
    await sell(h, T, 'S-SEP', RICE, 2, sold, '2026-09-01');
    await giveBack(h, T, 'S-SEP', 'R-SEP', RICE, back);
    const gstr1 = async (from: string, to: string) => (await h.request({
      method: 'POST', path: '/v1/finance/gstr1/from-sales/table-12', userId: ACCT, tenantId: T, idempotencyKey: `g-${from}`,
      body: { from, to, annualTurnoverMinor: 100_000_000 },
    })).body as { soldLineCount: number; returnedLineCount: number };
    expect(await gstr1('2026-09-01', '2026-09-30')).toMatchObject({ soldLineCount: 1, returnedLineCount: 1 });
    expect(await gstr1('2026-08-01', '2026-08-31')).toMatchObject({ soldLineCount: 0, returnedLineCount: 0 });
  });
});
