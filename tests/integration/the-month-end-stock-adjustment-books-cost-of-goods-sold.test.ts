import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedBody } from '../support/approval-request';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/day-book';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **OB-56 "A" (owner, 11 Oct 2026) · M23 · WF-18 · D10-FR-03 — the month-end stock adjustment: ONE journal brings the
 * books' inventory to head office's own closing stock value (on hand at the OB-39 average buying cost) and books cost of
 * goods sold; the P&L then shows gross margin; the close reconciles stock value to the inventory account.**
 *
 * On the real head-office API (in memory and, with DATABASE_URL, on real PostgreSQL), one month: oil received 10 @ ₹50 and
 * sugar 4 @ ₹20 (₹580 of purchases); rice received 5 with no cost; one oil sold for ₹105 (₹100 + 5% GST); a blind count
 * finds one oil short (₹50) and one oil is written off (₹50). Then:
 *   • the adjustment is refused while the count and the write-off are not in the books (posting them afterwards would book
 *     them twice), refused while the accountant's map has no rule (`not_mapped`), refused while rice has no cost (never
 *     valued at zero) — and the close holds on the stock check;
 *   • once they post and rice has a cost, ONE journal: cost of goods sold = stock in the books (−₹100: the loss and the
 *     write-off already took it out) + purchases ₹580 + rice ₹50 − closing ₹580 = ₹50 — exactly the oil that was sold. The
 *     shortage and the write-off each appear ONCE in the P&L (their own lines), never again inside cost of goods sold;
 *   • a re-run posts nothing; only finance posts; the P&L shows gross margin ₹50 on ₹100 (50%); the close's stock check
 *     agrees and the month closes on the accountant's signature.
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

const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const PERIOD = new Date().toISOString().slice(0, 7);
const TODAY = new Date().toISOString().slice(0, 10);

interface Line { accountCode: string; debitMinor: number; creditMinor: number }
interface Evidence { agrees: boolean; checks: { name: string; leftMinor: number; rightMinor: number }[] }

describe.each(backings)('OB-56 — the month-end stock adjustment books cost of goods sold once — on $name', ({ harness }) => {
  it('adjusts the books to closing stock at average cost; each loss appears once; the P&L shows gross margin; the close agrees', async () => {
    const h = harness();
    const t = randomUUID();
    await h.seedOwner(t, 'u-owner');
    await h.provisionRole(t, 'u-acct', 'accountant');
    await h.provisionRole(t, 'u-mgr', 'store_manager');
    let n = 0;
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown) =>
      h.request({ method, path, userId, tenantId: t, ...(method === 'GET' ? {} : { idempotencyKey: `k-${n += 1}-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<{ status: number; body: unknown }>, label: string) => { const r = await p; expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const receive = (id: string, productId: string, qty: number, unitCostMinor?: number) => ok(call('POST', '/v1/inventory/movements', 'u-owner', {
      movementId: id, productId, locationId: 'store-1', kind: 'received', quantityMinor: qty, uom: 'each', occurredAt: `${TODAY}T03:00:00.000Z`, enteredBy: 'u-owner', ...(unitCostMinor === undefined ? {} : { unitCostMinor }),
    }), id);
    await receive('rcv-oil', 'OIL', 10, 5_000);
    await receive('rcv-sugar', 'SUGAR', 4, 2_000);
    await receive('rcv-rice', 'RICE', 5);
    await ok(call('POST', '/v1/sales', 'u-owner', {
      saleId: 'S1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-owner', locationId: 'store-1', tradingDay: TODAY, committedAt: `${TODAY}T04:00:00.000Z`,
      totalMinor: 10_500, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'OIL', quantityMinor: 1, uom: 'each', unitPriceMinor: 10_500, lineTotalMinor: 10_500, taxRateBps: 500 }],
      tenders: [{ kind: 'cash', amountMinor: 10_500 }],
    }), 'sale');
    const r = await ok(call('POST', '/v1/inventory/counts/C1', 'u-owner', { productId: 'OIL', locationId: 'store-1', uom: 'each', countedMinor: 8, reasonCode: 'cycle_count' }), 'count');
    if ((r.body as { pendingApproval: boolean }).pendingApproval) await ok(call('POST', '/v1/inventory/counts/C1/decide', 'u-mgr', { decision: 'approved', reason: 'recounted' }), 'decide');
    await ok(call('POST', '/v1/inventory/write-off/W1', 'u-mgr', { productId: 'OIL', locationId: 'store-1', qty: 1, uom: 'each', lossType: 'damage', reasonCode: 'damage' }), 'write-off');
    const adjust = () => call('POST', `/v1/finance/periods/${PERIOD}/stock-adjustment`, 'u-owner', {});
    const evidence = async () => (await call('GET', `/v1/finance/periods/${PERIOD}/independent-evidence`, 'u-acct')).body as Evidence;
    const stockCheck = (e: Evidence) => e.checks.find((c) => c.name === `Stock value at the close of ${PERIOD}`);

    // ── The accountant's map without the month-end rule: not mapped, nothing posted.
    await ok(call('PUT', '/v1/finance/posting-map', 'u-owner', { rules: DEFAULT_RETAIL_POSTING_MAP.rules.filter((x) => x.kind !== 'stock_period_adjustment') }), 'map without the rule');
    expect(codeOf(await adjust())).toBe('not_mapped');
    await ok(call('PUT', '/v1/finance/posting-map', 'u-owner', DEFAULT_RETAIL_POSTING_MAP), 'map');
    await ok(call('POST', `/v1/finance/day-book/${TODAY}/post`, 'u-owner', undefined), 'day book');

    // ── The count and the write-off are not in the books yet: refused, naming them (else they would be booked twice).
    const early = await adjust();
    expect(early.status).toBe(409);
    expect(codeOf(early)).toBe('stock_postings_outstanding');
    expect((early.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/count:C1.*write_off:W1|write_off:W1.*count:C1/);
    await ok(call('POST', '/v1/finance/stock-adjustments/post', 'u-owner', {}), 'post count and write-off');

    // ── Rice is on hand with no cost: refused, rice named — never valued at zero. The close holds on the stock check.
    const unvalued = await adjust();
    expect(codeOf(unvalued)).toBe('stock_not_valued');
    expect((unvalued.body as { error: { whatHappened: string } }).error.whatHappened).toContain('RICE at store-1 (5 each on hand)');
    const e0 = await evidence();
    expect(stockCheck(e0)).toMatchObject({ leftMinor: 35_000 + 8_000, rightMinor: -10_000 });
    expect(e0.agrees).toBe(false);
    await receive('rcv-rice-2', 'RICE', 5, 1_000); // head office now holds rice's cost (₹10)

    // ── Only finance posts.
    expect((await call('POST', `/v1/finance/periods/${PERIOD}/stock-adjustment`, 'u-mgr', {})).status).toBe(403);
    // What it will post, read first.
    const preview = (await call('GET', `/v1/finance/periods/${PERIOD}/stock-valuation`, 'u-acct')).body as { figures: Record<string, number>; valuation: { closingValueMinor: number; purchases: { purchasesMinor: number } }; outstandingStockPostings: string[] };
    expect(preview.outstandingStockPostings).toEqual([]);
    expect(preview.valuation.closingValueMinor).toBe(35_000 + 8_000 + 10_000); // oil 7 @ ₹50, sugar 4 @ ₹20, rice 10 @ ₹10
    expect(preview.valuation.purchases.purchasesMinor).toBe(50_000 + 8_000 + 5_000 + 5_000); // the cost-less rice receipt at the average
    expect(preview.figures).toMatchObject({ booksInventoryBeforeMinor: -10_000, costOfSalesMinor: 5_000 });

    // ── ONE journal: cost of goods sold ₹50 — the oil that was sold, and nothing else.
    const posted = await adjust();
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    const j = (posted.body as { posted: { entryId: string; period: string; lines: Line[]; stockPeriod: Record<string, number> } }).posted;
    expect(j).toMatchObject({ entryId: `stock-period:${PERIOD}`, period: PERIOD });
    expect(j.stockPeriod).toMatchObject({ booksInventoryBeforeMinor: -10_000, purchasesMinor: 68_000, closingValueMinor: 53_000, costOfSalesMinor: 5_000, inventoryChangeMinor: 63_000 });
    expect(j.lines).toEqual([
      { accountCode: 'cost_of_goods_sold', debitMinor: 5_000, creditMinor: 0 },
      { accountCode: 'inventory', debitMinor: 63_000, creditMinor: 0 },
      { accountCode: 'purchases_grni', debitMinor: 0, creditMinor: 68_000 },
    ]);
    // Once per month: a re-run returns the same journal; exactly one is in the ledger.
    expect(await adjust()).toMatchObject({ status: 200, body: { alreadyPosted: true } });
    const ledger = (await h.store.readStream(t, 'finance', { type: 'JournalPosted' })).map((e) => e.event.payload as { entryId: string });
    expect(ledger.filter((x) => x.entryId === `stock-period:${PERIOD}`)).toHaveLength(1);

    // ── The P&L: the shortage and the write-off once each, cost of goods sold ₹50, gross margin ₹50 on ₹100.
    const suggested = ((await call('GET', '/v1/finance/account-classes', 'u-acct')).body as { suggested: Record<string, string> }).suggested;
    await ok(call('PUT', '/v1/finance/account-classes', 'u-owner', { classes: suggested }), 'classes');
    const pl = (await call('GET', `/v1/finance/periods/${PERIOD}/profit-and-loss`, 'u-acct')).body as {
      income: { account: string; amountMinor: number }[]; expenses: { account: string; amountMinor: number }[]; netMinor: number;
      grossMargin: { revenueMinor: number; costOfSalesMinor: number; grossMarginMinor: number; marginBps: number }; notInTheBooks: string[];
    };
    expect(pl.expenses.filter((x) => x.account === 'inventory_loss')).toEqual([{ account: 'inventory_loss', amountMinor: 5_000 }]);
    expect(pl.expenses.filter((x) => x.account === 'inventory_write_off')).toEqual([{ account: 'inventory_write_off', amountMinor: 5_000 }]);
    expect(pl.expenses.filter((x) => x.account === 'cost_of_goods_sold')).toEqual([{ account: 'cost_of_goods_sold', amountMinor: 5_000 }]);
    // The total expense the two losses carry is ₹100 — once — and the net is sales less the oil sold less the two losses.
    expect(pl.expenses.reduce((s, x) => s + x.amountMinor, 0)).toBe(15_000);
    expect(pl.netMinor).toBe(10_000 - 15_000);
    expect(pl.grossMargin).toEqual({ revenueMinor: 10_000, costOfSalesMinor: 5_000, grossMarginMinor: 5_000, marginBps: 5_000 });
    expect(pl.notInTheBooks).toEqual([]);

    // ── The close: stock value agrees with the inventory account; the month closes on the accountant's signature.
    const e1 = await evidence();
    expect(stockCheck(e1)).toMatchObject({ leftMinor: 53_000, rightMinor: 53_000 });
    const closed = await call('POST', `/v1/finance/periods/${PERIOD}/close`, 'u-owner', await approvedBody(h, t, 'u-owner', 'u-acct', 'period_close', PERIOD, {}, { period: PERIOD }));
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  }, 90_000);

  it('a month with more stock than the books and the purchases explain is refused, not posted with a negative cost', async () => {
    const h = harness();
    const t = randomUUID();
    await h.seedOwner(t, 'u-owner');
    await h.provisionRole(t, 'u-acct', 'accountant');
    const call = (method: 'POST' | 'PUT', path: string, body: unknown) => h.request({ method, path, userId: 'u-owner', tenantId: t, idempotencyKey: randomUUID(), body });
    // Stock loaded as an opening load (not a purchase), with no opening trial balance in the books.
    expect((await call('POST', '/v1/inventory/movements', { movementId: 'opening-L1-1', productId: 'OIL', locationId: 'store-1', kind: 'received', quantityMinor: 10, uom: 'each', occurredAt: `${TODAY}T03:00:00.000Z`, enteredBy: 'u-owner', unitCostMinor: 5_000 })).status).toBeLessThan(300);
    expect((await call('PUT', '/v1/finance/posting-map', DEFAULT_RETAIL_POSTING_MAP)).status).toBe(200);
    const r = await call('POST', `/v1/finance/periods/${PERIOD}/stock-adjustment`, {});
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe('cost_of_sales_negative');
  }, 60_000);

  it('months post in order: a month is refused while an earlier month with stock movements has no adjustment (named); a month with none is not asked for', async () => {
    const h = harness();
    const t = randomUUID();
    await h.seedOwner(t, 'u-owner');
    await h.provisionRole(t, 'u-acct', 'accountant');
    const call = (method: 'POST' | 'PUT', path: string, body: unknown, userId = 'u-owner') => h.request({ method, path, userId, tenantId: t, idempotencyKey: randomUUID(), body });
    const monthsBack = (k: number): string => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - k); return d.toISOString().slice(0, 7); };
    const [twoBack, oneBack] = [monthsBack(2), monthsBack(1)];
    const receive = async (id: string, month: string) => expect((await call('POST', '/v1/inventory/movements', {
      movementId: id, productId: 'OIL', locationId: 'store-1', kind: 'received', quantityMinor: 10, uom: 'each', occurredAt: `${month}-10T03:00:00.000Z`, enteredBy: 'u-owner', unitCostMinor: 5_000,
    })).status).toBeLessThan(300);
    // Stock moved two months back and this month; NOTHING moved last month.
    await receive('rcv-old', twoBack);
    await receive('rcv-now', PERIOD);
    expect((await call('PUT', '/v1/finance/posting-map', DEFAULT_RETAIL_POSTING_MAP)).status).toBe(200);
    // This month first: refused by name — the earlier month with stock activity is named; last month (no activity) is not.
    const early = await call('POST', `/v1/finance/periods/${PERIOD}/stock-adjustment`, {}, 'u-acct');
    expect(early.status).toBe(409);
    expect(codeOf(early)).toBe('earlier_month_not_adjusted');
    const said = (early.body as { error: { whatHappened: string; nextSafeAction: string } }).error;
    expect(said.whatHappened).toContain(`${twoBack} had stock movements but no month-end stock adjustment`);
    expect(said.whatHappened).not.toContain(oneBack);
    expect(said.nextSafeAction).toContain(`Post the stock adjustment for ${twoBack} first`);
    const journals = async () => (await h.store.readStream(t, 'finance', { type: 'JournalPosted' })).map((e) => (e.event.payload as { entryId: string }).entryId).filter((id) => id.startsWith('stock-period:'));
    expect(await journals()).toEqual([]);
    // The earlier month posts; then this month does; a re-send is the same journal.
    const first = await call('POST', `/v1/finance/periods/${twoBack}/stock-adjustment`, {}, 'u-acct');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const now = await call('POST', `/v1/finance/periods/${PERIOD}/stock-adjustment`, {}, 'u-acct');
    expect(now.status, JSON.stringify(now.body)).toBe(201);
    expect((await call('POST', `/v1/finance/periods/${PERIOD}/stock-adjustment`, {}, 'u-acct')).body).toMatchObject({ alreadyPosted: true });
    // This month's adjustment started from the earlier month's closing stock (₹500 of oil), not from nothing.
    expect((now.body as { posted: { stockPeriod: Record<string, number> } }).posted.stockPeriod).toMatchObject({ booksInventoryBeforeMinor: 50_000, purchasesMinor: 50_000, closingValueMinor: 100_000, costOfSalesMinor: 0 });
    expect((await journals()).sort()).toEqual([`stock-period:${PERIOD}`, `stock-period:${twoBack}`].sort());
  }, 60_000);
});
