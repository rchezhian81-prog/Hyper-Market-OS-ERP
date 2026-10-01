// M23-FR-01 through the real authenticated API: the accountant defines the ledger mapping, the tills'
// synced sales and the desk's returns post as balanced day-book vouchers, the period fold sees them, a
// re-run is safe, a receipt nobody can split is a visible exception until it can be, and a closed month
// takes nothing (the day posts to the next open period carrying its real date).
import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa23';
const OWNER = 'u-owner'; const ACCT = 'u-acct'; const CASHIER = 'u-cash';
const DAY = '2026-08-05'; // a day in August 2026; no month is closed unless a case closes one, so its period is open
/** The month the surface's REAL clock stands in: a late day posts to the next period open from today, not from the day. */
const THIS_MONTH = new Date().toISOString().slice(0, 7);

const seedCatalogue = (h: ApiHarness, products: { productId: string; hsnCode: string; taxBps: number }[], version = 1) =>
  h.store.append(A, STREAM.catalogue, makeEvent({
    id: `pack-v${version}`, type: 'CataloguePublished', occurredAt: `2026-08-0${version}T00:00:00Z`,
    idempotencyKey: `catalogue-${A}-v${version}`, source: 'test/catalogue',
    payload: { snapshot: { tenantId: A, version, builtAt: `2026-08-0${version}T00:00:00Z`, products, barcodes: [] } },
  }));
const PRODUCTS = [{ productId: 'RICE', hsnCode: '1006', taxBps: 500 }, { productId: 'SOAP', hsnCode: '3401', taxBps: 1800 }];

const bankSale = (h: ApiHarness, saleId: string, productId: string, lineTotalMinor: number, tender: string, tradingDay = DAY) =>
  h.request({
    method: 'POST', path: '/v1/sales', userId: OWNER, tenantId: A, idempotencyKey: `db-${saleId}`,
    body: {
      saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: OWNER,
      tradingDay, committedAt: `${tradingDay}T09:00:00Z`, totalMinor: lineTotalMinor, currency: 'INR', packVersion: 1,
      lines: [{ productId, quantityMinor: 1, uom: 'each', unitPriceMinor: lineTotalMinor, lineTotalMinor }],
      tenders: [{ kind: tender, amountMinor: lineTotalMinor }],
    },
  });
const recordReturn = (h: ApiHarness, saleId: string, returnId: string, productId: string, refundMinor: number, processedAt = `${DAY}T12:00:00Z`) =>
  h.request({
    method: 'POST', path: `/v1/sales/${saleId}/returns`, userId: OWNER, tenantId: A, idempotencyKey: `ret-${returnId}`,
    body: {
      returnId, number: returnId, reasonCode: 'changed_mind', refundMinor, refundTender: 'cash', approvedBy: 'u-mgr', processedAt,
      lines: [{ productId, quantityMinor: 1, uom: 'each', disposition: 'resell' }],
    },
  });
const put = (h: ApiHarness, path: string, u: string, key: string, body: unknown) =>
  h.request({ method: 'PUT', path, userId: u, tenantId: A, idempotencyKey: key, body });
const post = (h: ApiHarness, path: string, u: string, key: string) =>
  h.request({ method: 'POST', path, userId: u, tenantId: A, idempotencyKey: key });
const get = (h: ApiHarness, path: string, u: string) => h.request({ method: 'GET', path, userId: u, tenantId: A });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface Journal { entryId: string; kind: string; period: string; documentDate: string; belongsTo?: string; sources: number; lines: { accountCode: string; debitMinor: number; creditMinor: number }[]; postedBy: string }
interface PostBody { postedTo: string; postedLate?: { belongsTo: string }; journals: Journal[]; exceptions: { exceptionId: string; reason: string; sourceIds: string[]; kind?: string }[]; skipped: number }
interface ReadBody { journals: Journal[]; accounts: { accountCode: string; debitMinor: number; creditMinor: number; balanceMinor: number }[]; covered: number; exceptions: { exceptionId: string; state: string }[]; open: number }

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, OWNER);
  await h.provisionRole(A, ACCT, 'accountant');
  await h.provisionRole(A, CASHIER, 'cashier');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // the refund approver (pos.return.approve)
  await seedCatalogue(h, PRODUCTS);
  return h;
}

describe('the day book posts the day (M23-FR-01, API-09)', () => {
  it('the accountant defines the suggested mapping, the day posts as balanced vouchers the period fold sees, and a re-run posts nothing twice', async () => {
    const h = await cast();
    // Nothing defined yet: the read offers the suggestion; posting refuses honestly.
    expect((await get(h, '/v1/finance/posting-map', ACCT)).body).toMatchObject({ map: null, suggested: DEFAULT_RETAIL_POSTING_MAP });
    await bankSale(h, 's1', 'RICE', 10_500, 'cash');
    const refused = await post(h, `/v1/finance/day-book/${DAY}/post`, ACCT, 'db-post-0');
    expect(refused.status).toBe(409);
    expect(codeOf(refused)).toBe('posting_map_not_defined');

    const defined = await put(h, '/v1/finance/posting-map', ACCT, 'map-1', DEFAULT_RETAIL_POSTING_MAP);
    expect(defined.status).toBe(200);
    expect(defined.body).toMatchObject({ version: 1 });
    expect((await get(h, '/v1/finance/posting-map', OWNER)).body).toMatchObject({ map: { version: 1, definedBy: ACCT } });

    await bankSale(h, 's2', 'SOAP', 11_800, 'upi');
    expect((await recordReturn(h, 's1', 'r1', 'RICE', 10_500)).status).toBe(201);

    const posted = await post(h, `/v1/finance/day-book/${DAY}/post`, ACCT, 'db-post-1');
    expect(posted.status).toBe(201);
    const body = posted.body as PostBody;
    expect(body.postedTo).toBe('2026-08');
    expect(body.journals.map((j) => [j.kind, j.sources, j.postedBy])).toEqual([
      ['refund:cash', 1, ACCT], ['sale', 2, ACCT], ['sale_return', 1, ACCT], ['tender:cash', 1, ACCT], ['tender:upi', 1, ACCT],
    ]);
    expect(body.journals[1]!.lines).toEqual([
      { accountCode: 'sales_clearing', debitMinor: 22_300, creditMinor: 0 },
      { accountCode: 'sales_revenue', debitMinor: 0, creditMinor: 20_000 },
      { accountCode: 'gst_output_cgst', debitMinor: 0, creditMinor: 1_150 },
      { accountCode: 'gst_output_sgst', debitMinor: 0, creditMinor: 1_150 },
    ]);
    expect(body.exceptions).toEqual([]);

    // The day, read back — and after a cold restart over the same ledger.
    for (const hh of [h, apiHarness({ store: h.store })]) {
      const day = (await get(hh, `/v1/finance/day-book/${DAY}`, OWNER)).body as ReadBody;
      expect(day.journals).toHaveLength(5);
      expect(day.covered).toBe(3);
      expect(day.accounts.find((a) => a.accountCode === 'sales_clearing')).toMatchObject({ balanceMinor: 0 });
      expect(day.accounts.find((a) => a.accountCode === 'gst_output_sgst')).toMatchObject({ creditMinor: 1_150, debitMinor: 250 });
      expect(day.open).toBe(0);
    }
    // The period fold sees the vouchers as journals like any other: the month is open with postings in it.
    const periods = (await get(h, '/v1/finance/periods', ACCT)).body as { periods: { period: string; state: string }[] };
    expect(periods.periods).toEqual(expect.arrayContaining([{ period: '2026-08', state: 'open' }]));

    // Re-run: nothing twice. A late-synced receipt: a supplementary voucher covering only itself.
    const again = await post(h, `/v1/finance/day-book/${DAY}/post`, ACCT, 'db-post-2');
    expect(again.status).toBe(200);
    expect((again.body as PostBody).journals).toEqual([]);
    expect((again.body as PostBody).skipped).toBe(3);
    await bankSale(h, 's3', 'RICE', 10_500, 'card');
    const late = (await post(h, `/v1/finance/day-book/${DAY}/post`, ACCT, 'db-post-3')).body as PostBody;
    expect(late.journals.map((j) => [j.entryId, j.sources])).toEqual([[`daybook:${DAY}:sale:2`, 1], [`daybook:${DAY}:tender:card:1`, 1]]);
    expect(((await get(h, `/v1/finance/day-book/${DAY}`, ACCT)).body as ReadBody).journals).toHaveLength(7);
  });

  it('a receipt for a product the catalogue cannot rate is a visible exception — open until a pack knows it and the day is re-posted', async () => {
    const h = await cast();
    await put(h, '/v1/finance/posting-map', ACCT, 'map-1', DEFAULT_RETAIL_POSTING_MAP);
    await bankSale(h, 's1', 'RICE', 10_500, 'cash');
    await bankSale(h, 'sx', 'MYSTERY', 9_900, 'cash');
    const first = (await post(h, `/v1/finance/day-book/${DAY}/post`, ACCT, 'db-post-1')).body as PostBody;
    expect(first.journals.map((j) => j.kind)).toEqual(['sale', 'tender:cash']);
    expect(first.exceptions).toEqual([expect.objectContaining({ reason: 'tax_rate_unknown', sourceIds: ['sx'] })]);
    let day = (await get(h, `/v1/finance/day-book/${DAY}`, OWNER)).body as ReadBody;
    expect(day.exceptions.map((e) => e.state)).toEqual(['open']);
    expect(day.open).toBe(1);
    await seedCatalogue(h, [...PRODUCTS, { productId: 'MYSTERY', hsnCode: '2106', taxBps: 1800 }], 2);
    const fixed = (await post(h, `/v1/finance/day-book/${DAY}/post`, ACCT, 'db-post-2')).body as PostBody;
    expect(fixed.journals.map((j) => [j.entryId, j.sources])).toEqual([[`daybook:${DAY}:sale:2`, 1], [`daybook:${DAY}:tender:cash:2`, 1]]);
    day = (await get(h, `/v1/finance/day-book/${DAY}`, OWNER)).body as ReadBody;
    expect(day.exceptions.map((e) => e.state)).toEqual(['resolved']);
    expect(day.open).toBe(0);
  });

  it('a closed month takes nothing: the day posts to the next open period carrying its real trading date, and the voucher says so', async () => {
    const h = await cast();
    await put(h, '/v1/finance/posting-map', ACCT, 'map-1', DEFAULT_RETAIL_POSTING_MAP);
    await h.store.append(A, STREAM.periods, makeEvent({
      id: 'close-2026-08-0', type: 'PeriodClosed', occurredAt: '2026-08-07T09:00:00Z', idempotencyKey: `close-${A}-2026-08-0`,
      source: 'test/finance', payload: { period: '2026-08', signedBy: OWNER, closedAt: '2026-08-07T09:00:00Z', seq: 0 },
    }));
    await bankSale(h, 's1', 'RICE', 10_500, 'cash');
    const body = (await post(h, `/v1/finance/day-book/${DAY}/post`, ACCT, 'db-post-1')).body as PostBody;
    // The next open period is counted from the clock the surface runs on (today's month), not from the day's own month,
    // so the expectation is tied to that clock: pinning it to one month turned this case red the day the month rolled.
    expect(THIS_MONTH > '2026-08').toBe(true);
    expect(body.postedTo).toBe(THIS_MONTH);
    expect(body.postedLate).toEqual({ belongsTo: '2026-08' });
    expect(body.journals[0]).toMatchObject({ period: THIS_MONTH, documentDate: DAY, belongsTo: '2026-08' });
  });

  it('who may: a cashier neither defines the mapping nor posts the day; the owner and accountant do; a bad day is refused', async () => {
    const h = await cast();
    expect((await put(h, '/v1/finance/posting-map', CASHIER, 'map-x', DEFAULT_RETAIL_POSTING_MAP)).status).toBe(403);
    expect((await post(h, `/v1/finance/day-book/${DAY}/post`, CASHIER, 'db-x')).status).toBe(403);
    expect((await get(h, `/v1/finance/day-book/${DAY}`, CASHIER)).status).toBe(403);
    expect((await put(h, '/v1/finance/posting-map', OWNER, 'map-1', DEFAULT_RETAIL_POSTING_MAP)).status).toBe(200);
    expect((await post(h, `/v1/finance/day-book/${DAY}/post`, OWNER, 'db-1')).status).toBe(200); // nothing sold: nothing to post, honestly
    const bad = await post(h, '/v1/finance/day-book/yesterday/post', ACCT, 'db-bad');
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('bad_trading_day');
    const invalid = await put(h, '/v1/finance/posting-map', ACCT, 'map-bad', { rules: [] });
    expect(invalid.status).toBe(422);
    expect(codeOf(invalid)).toBe('posting_map_invalid');
  });
});
