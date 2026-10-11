import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedBody } from '../support/approval-request';
import { approvedSuppliers } from '../support/approved-supplier';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/day-book';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **WF-18 / M23-FR-01/04 / D10-FR-03 / WF-08 "→ adjustment/accounting" — the month's books: count differences and
 * write-offs reach the ledger once; the close reconciles the books to the stock and purchase registers; the month has a
 * profit and loss from its journals.**
 *
 * On the real head-office API (in memory and, with DATABASE_URL, on real PostgreSQL): stock is received at a cost, a sale
 * is banked, three blind counts find a shortage, a surplus, and a shortage of a product head office holds no cost for; a
 * unit is written off; a supplier's opening bill is signed. Then:
 *   • the close compares the month's count differences and write-offs on the stock registers with the books, and the
 *     purchase register with the payables control account — both differ (nothing posted) and the signed close is
 *     REFUSED naming the difference;
 *   • the stock-adjustment posting run posts one balanced journal per valued difference, lists the one it cannot value
 *     (never posted at zero), and a re-run posts nothing twice; the payables post; the close then agrees and is signed;
 *   • the P&L needs the accountant's account classes, then shows sales, the count gain, the count loss and the write-off,
 *     with the net, and says in words that cost of goods sold is not in the books yet.
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

interface Evidence { agrees: boolean; checks: { name: string; leftMinor: number; rightMinor: number }[]; notChecked: string[]; books: { stockAdjustmentsUnposted: string[]; stockAdjustmentsUnvalued: string[]; payablesUnposted: number } }
interface Journal { entryId: string; period: string; lines: { accountCode: string; debitMinor: number; creditMinor: number }[]; stockAdjustment?: { sourceId: string; kind: string; valueMinor: number } }

async function shop(h: ApiHarness, t: string) {
  await h.seedOwner(t, 'u-owner');
  await h.provisionRole(t, 'u-acct', 'accountant');
  await h.provisionRole(t, 'u-mgr', 'store_manager');
  await approvedSuppliers(h, t, 'sup-1');
  let n = 0;
  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown) =>
    h.request({ method, path, userId, tenantId: t, ...(method === 'GET' ? {} : { idempotencyKey: `k-${n += 1}-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
  const ok = async (p: Promise<{ status: number; body: unknown }>, label: string) => { const r = await p; expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
  const move = (id: string, productId: string, qty: number, unitCostMinor?: number) => ok(call('POST', '/v1/inventory/movements', 'u-owner', {
    movementId: id, productId, locationId: 'store-1', kind: 'received', quantityMinor: qty, uom: 'each', occurredAt: `${TODAY}T03:00:00.000Z`, enteredBy: 'u-owner', ...(unitCostMinor === undefined ? {} : { unitCostMinor }),
  }), id);
  await move('rcv-oil', 'OIL', 10, 5_000);
  await move('rcv-rice', 'RICE', 5);
  // A cash sale of one oil at ₹105 (5% GST inside), banked to head office.
  await ok(call('POST', '/v1/sales', 'u-owner', {
    saleId: 'S1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-owner', locationId: 'store-1', tradingDay: TODAY, committedAt: `${TODAY}T04:00:00.000Z`,
    totalMinor: 10_500, currency: 'INR', packVersion: 1,
    lines: [{ productId: 'OIL', quantityMinor: 1, uom: 'each', unitPriceMinor: 10_500, lineTotalMinor: 10_500, taxRateBps: 500 }],
    tenders: [{ kind: 'cash', amountMinor: 10_500 }],
  }), 'sale');
  // Blind counts (the expected figure is head office's). A held count is decided by a second person.
  const count = async (countId: string, productId: string, countedMinor: number) => {
    const r = await ok(call('POST', `/v1/inventory/counts/${countId}`, 'u-owner', { productId, locationId: 'store-1', uom: 'each', countedMinor, reasonCode: 'cycle_count' }), countId);
    if ((r.body as { pendingApproval: boolean }).pendingApproval) await ok(call('POST', `/v1/inventory/counts/${countId}/decide`, 'u-mgr', { decision: 'approved', reason: 'recounted, confirmed' }), `${countId} decide`);
  };
  await count('C1', 'OIL', 8); // 9 expected → one missing (₹50)
  await count('C2', 'OIL', 9); // 8 expected → one found (₹50)
  await count('C3', 'RICE', 4); // one missing; head office holds no cost for rice
  // A small write-off at head office's own cost (₹50), on the manager's own.
  await ok(call('POST', '/v1/inventory/write-off/W1', 'u-mgr', { productId: 'OIL', locationId: 'store-1', qty: 1, uom: 'each', lossType: 'damage', reasonCode: 'leaking' }), 'write-off');
  // A supplier's opening bill, signed by finance — on the purchase register, not yet in the books.
  await ok(call('POST', '/v1/purchase/suppliers/sup-1/opening-balances/OB-1', 'u-owner', { billNumber: 'BILL-1', billDate: TODAY, amountMinor: 30_000, openingDate: TODAY, loadId: 'L1' }), 'opening');
  await ok(call('POST', '/v1/purchase/opening-balances/sign-off/L1', 'u-acct', { expectedTotalMinor: 30_000, expectedCount: 1 }), 'opening sign-off');
  // The accountant's mapping (the suggested one, carrying the new stock-adjustment rules).
  await ok(call('PUT', '/v1/finance/posting-map', 'u-owner', DEFAULT_RETAIL_POSTING_MAP), 'map');
  const evidence = async () => (await call('GET', `/v1/finance/periods/${PERIOD}/independent-evidence`, 'u-acct')).body as Evidence;
  const close = async () => call('POST', `/v1/finance/periods/${PERIOD}/close`, 'u-owner', await approvedBody(h, t, 'u-owner', 'u-acct', 'period_close', PERIOD, {}, { period: PERIOD }));
  return { call, ok, evidence, close };
}

describe.each(backings)('WF-18 — the period\'s books reconcile to their registers and show a profit and loss — on $name', ({ harness }) => {
  it('count differences and write-offs post once; the close holds until the books agree; the P&L reads the month', async () => {
    const h = harness();
    const t = randomUUID();
    const s = await shop(h, t);

    // ── What the close will compare, before anything is posted: two differences, each named.
    const before = await s.evidence();
    const stock = before.checks.find((c) => c.name === `Count differences and write-offs for ${PERIOD}`)!;
    expect(stock).toMatchObject({ leftMinor: 15_000, rightMinor: 0 });
    const ap = before.checks.find((c) => c.name === `Supplier payables as at the close of ${PERIOD}`)!;
    expect(ap).toMatchObject({ leftMinor: 30_000, rightMinor: 0 });
    expect(before.books.stockAdjustmentsUnposted.sort()).toEqual(['count:C1', 'count:C2', 'count:C3', 'write_off:W1']);
    expect(before.books.stockAdjustmentsUnvalued).toEqual(['count:C3']);
    expect(before.notChecked.join(' ')).toMatch(/Credit-customer receivables: no credit customer/);
    expect(before.agrees).toBe(false);
    const refused = await s.close();
    expect(refused.status).toBe(422);
    expect(codeOf(refused)).toBe('control_total_does_not_agree');
    expect((refused.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/Count differences and write-offs/);

    // ── Post the stock adjustments: one balanced journal per valued difference; the unvalued one is listed, never at 0.
    const posted = await s.call('POST', '/v1/finance/stock-adjustments/post', 'u-owner', {});
    expect(posted.status).toBe(201);
    const body = posted.body as { posted: Journal[]; exceptions: { sourceId: string; reason: string }[] };
    expect(body.posted.map((j) => [j.stockAdjustment!.sourceId, j.stockAdjustment!.kind, j.stockAdjustment!.valueMinor, j.period]).sort()).toEqual([
      ['count:C1', 'stock_count:shortage', 5_000, PERIOD], ['count:C2', 'stock_count:surplus', 5_000, PERIOD], ['write_off:W1', 'stock_write_off', 5_000, PERIOD],
    ]);
    for (const j of body.posted) expect(j.lines.reduce((n, l) => n + l.debitMinor - l.creditMinor, 0)).toBe(0);
    expect(body.posted.find((j) => j.stockAdjustment!.sourceId === 'count:C1')!.lines).toEqual([
      { accountCode: 'inventory_loss', debitMinor: 5_000, creditMinor: 0 }, { accountCode: 'inventory', debitMinor: 0, creditMinor: 5_000 },
    ]);
    expect(body.exceptions).toEqual([expect.objectContaining({ sourceId: 'count:C3', reason: 'value_not_known' })]);
    // Re-run: nothing twice.
    const again = await s.call('POST', '/v1/finance/stock-adjustments/post', 'u-owner', {});
    expect(again.status).toBe(200);
    expect((again.body as { posted: unknown[] }).posted).toEqual([]);
    const listed = (await s.call('GET', '/v1/finance/stock-adjustments', 'u-acct')).body as { unposted: string[]; valueMinor: number; postedValueMinor: number };
    expect(listed).toMatchObject({ unposted: ['count:C3'], valueMinor: 15_000, postedValueMinor: 15_000 });

    // ── The payables post; the books now agree with both registers and the month closes on the accountant's signature.
    await s.ok(s.call('POST', '/v1/finance/payables/post', 'u-owner', {}), 'payables');
    await s.ok(s.call('POST', `/v1/finance/day-book/${TODAY}/post`, 'u-owner', undefined), 'day book');
    const after = await s.evidence();
    expect(after.checks.find((c) => c.name.startsWith('Count differences'))).toMatchObject({ leftMinor: 15_000, rightMinor: 15_000 });
    expect(after.checks.find((c) => c.name.startsWith('Supplier payables'))).toMatchObject({ leftMinor: 30_000, rightMinor: 30_000 });
    expect(after.agrees).toBe(true);

    // ── The P&L: the accountant's classes first; then the month from its journals.
    expect(codeOf(await s.call('GET', `/v1/finance/periods/${PERIOD}/profit-and-loss`, 'u-acct'))).toBe('account_classes_not_defined');
    const suggested = ((await s.call('GET', '/v1/finance/account-classes', 'u-acct')).body as { suggested: Record<string, string> }).suggested;
    expect(codeOf(await s.call('PUT', '/v1/finance/account-classes', 'u-owner', { classes: { inventory: 'cost' } }))).toBe('not_readable_as_account_classes');
    await s.ok(s.call('PUT', '/v1/finance/account-classes', 'u-owner', { classes: suggested }), 'classes');
    const pl = (await s.call('GET', `/v1/finance/periods/${PERIOD}/profit-and-loss`, 'u-acct')).body as {
      income: { account: string; amountMinor: number }[]; expenses: { account: string; amountMinor: number }[]; netMinor: number; complete: boolean; unclassified: unknown[]; notInTheBooks: string[]; periodState: string;
    };
    // Sales ₹100 net of GST (₹105 inclusive), the count gain ₹50; the count loss ₹50 and the write-off ₹50.
    expect(pl.income).toEqual(expect.arrayContaining([{ account: 'sales_revenue', amountMinor: 10_000 }, { account: 'inventory_gain', amountMinor: 5_000 }]));
    expect(pl.expenses).toEqual(expect.arrayContaining([{ account: 'inventory_loss', amountMinor: 5_000 }, { account: 'inventory_write_off', amountMinor: 5_000 }]));
    expect(pl.netMinor).toBe(10_000 + 5_000 - 5_000 - 5_000);
    expect(pl).toMatchObject({ complete: true, unclassified: [], periodState: 'open' });
    expect(pl.notInTheBooks.join(' ')).toMatch(/Cost of goods sold/);

    const closed = await s.close();
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(((await s.call('GET', `/v1/finance/periods/${PERIOD}/profit-and-loss`, 'u-acct')).body as { periodState: string }).periodState).toBe('closed');
    // A difference found after the close posts to the next open month, carrying its real date — the signed month is untouched.
    const r = await s.call('POST', '/v1/inventory/counts/C4', 'u-owner', { productId: 'OIL', locationId: 'store-1', uom: 'each', countedMinor: 7, reasonCode: 'cycle_count' });
    expect(r.status).toBe(201);
    const late = (await s.call('POST', '/v1/finance/stock-adjustments/post', 'u-owner', {})).body as { posted: (Journal & { documentDate: string })[] };
    expect(late.posted).toHaveLength(1);
    expect(late.posted[0]!.period).not.toBe(PERIOD);
    expect(late.posted[0]!.documentDate).toBe(TODAY);
  }, 60_000);

  it('only finance posts; an account a journal uses with no class makes the P&L say it is incomplete', async () => {
    const h = harness();
    const t = randomUUID();
    const s = await shop(h, t);
    expect((await s.call('POST', '/v1/finance/stock-adjustments/post', 'u-mgr', {})).status).toBe(403);
    await s.ok(s.call('POST', '/v1/finance/stock-adjustments/post', 'u-owner', {}), 'post');
    await s.ok(s.call('PUT', '/v1/finance/account-classes', 'u-owner', { classes: { inventory_loss: 'expense', inventory: 'asset' } }), 'partial classes');
    const pl = (await s.call('GET', `/v1/finance/periods/${PERIOD}/profit-and-loss`, 'u-acct')).body as { complete: boolean; unclassified: { account: string }[] };
    expect(pl.complete).toBe(false);
    expect(pl.unclassified.map((u) => u.account).sort()).toEqual(['inventory_gain', 'inventory_write_off']);
  }, 60_000);
});
