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

/**
 * **FUL-09 (rest) — a B2B order holds and moves the ORDINARY stock; the business customer orders on its own login; a
 * recurring order runs on its date through the same checks; commission is derived from the invoice by an approved rule
 * (M22-FR-01..04 · M08 · P-02 · §28 · hard rules #2 #10).**
 *
 * The money leg was already proven (`a-b2b-invoice-and-its-collection-reach-the-books`). Here, on the real API:
 *   • the customer asks for a quote on its portal login; staff price it from the store; the customer PLACES the order by
 *     accepting its own quotation — and the store's rice is HELD for it: another order for more than is left is refused;
 *   • a challan takes what left the building off the ordinary shelf ONCE (on hand drops by the dispatched quantity, a
 *     re-sent challan moves nothing) and the order keeps holding only what is still to go;
 *   • a salesperson's rate is proposed by one person and approved by ANOTHER; the invoice of an order attributed to them
 *     accrues commission exactly (base = the invoice's taxable value);
 *   • a recurring order made from a quotation runs only once approved by a second person, makes its order once on its due
 *     day, and a run the shelf cannot supply is a visible exception;
 *   • the customer sees its own orders (with delivered / billed) and nobody else's; a reach for another account is refused
 *     and recorded.
 *
 * In memory and, with DATABASE_URL, on real PostgreSQL. Synthetic data only.
 */

const OWNER = 'u-owner'; const ACCT = 'u-acct'; const MGR = 'u-mgr'; const CUST_LOGIN = 'u-caterer'; const OTHER_LOGIN = 'u-canteen';
const RICE = { lineId: 'l1', productId: 'rice', description: 'Ponni rice 25kg', unitPriceMinor: 10_000, taxRateBps: 500 };
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

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

describe.each(backings)('FUL-09 — B2B ordering on ordinary stock, self-service, recurring and commission — on $name', ({ harness }) => {
  it('portal quote → portal order holds stock → partial dispatch moves stock once → invoice → commission by an approved rule; recurring runs once approved, exceptions visible; customer sees only its own', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.enableFeature(T, 'b2b');
    await h.provisionRole(T, ACCT, 'accountant');
    await h.provisionRole(T, MGR, 'store_manager');
    await h.provisionRole(T, CUST_LOGIN, 'b2b_customer');
    await h.provisionRole(T, OTHER_LOGIN, 'b2b_customer');
    const call = (method: 'GET' | 'POST', path: string, user: string, body?: unknown, key?: string, query?: Record<string, string>) =>
      h.request({ method, path, userId: user, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: key ?? `${path}-${user}-${randomUUID()}` }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: ReturnType<typeof call>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const onHand = async (): Promise<number> => ((await call('GET', '/v1/inventory/availability', OWNER, undefined, undefined, { productId: 'rice' })).body as { rows: { locationId: string; onHandMinor: number }[] }).rows.find((r) => r.locationId === 'S1')?.onHandMinor ?? 0;

    // The store has 20 bags; the caterer has 30-day credit; the logins are bound by staff.
    await ok(call('POST', '/v1/inventory/movements', OWNER, { movementId: 'rice-in', productId: 'rice', locationId: 'S1', kind: 'received', quantityMinor: 20, uom: 'ea', occurredAt: new Date().toISOString(), enteredBy: OWNER }), 'stock');
    await ok(call('POST', '/v1/b2b/accounts/CATERER', OWNER, { creditLimitMinor: 10_000_000, paymentTermsDays: 30 }), 'terms');
    await ok(call('POST', `/v1/b2b-portal/customers/CATERER/logins/${CUST_LOGIN}`, OWNER, { grants: ['place_order', 'view_invoices', 'view_statement'] }), 'bind');
    await ok(call('POST', `/v1/b2b-portal/customers/CANTEEN/logins/${OTHER_LOGIN}`, OWNER, { grants: ['place_order', 'view_invoices'] }), 'bind 2');

    // ── 1 · The caterer ASKS for a quote on its own login; staff see it, and price it from the store.
    await ok(call('POST', '/v1/b2b-portal/me/quote-requests/qr-1', CUST_LOGIN, { lines: [{ productId: 'rice', qty: 10 }], note: 'weekly canteen rice' }), 'quote request');
    expect(((await call('GET', '/v1/b2b/quote-requests', MGR)).body as { requests: { requestId: string; customerId: string }[] }).requests).toEqual([expect.objectContaining({ requestId: 'qr-1', customerId: 'CATERER' })]);
    await ok(call('POST', '/v1/b2b/documents/CATERER/quotations/q1', MGR, { lines: [{ ...RICE, qty: 10 }], locationId: 'S1' }), 'quotation');

    // ── 2 · Another business cannot accept it; the caterer cannot reach another account (refused and recorded).
    expect((await call('POST', '/v1/b2b-portal/me/orders/so-x', OTHER_LOGIN, { fromQuotationId: 'q1' })).status).toBe(404);
    const probe = await call('GET', '/v1/b2b-portal/me/orders', CUST_LOGIN, undefined, undefined, { customerId: 'CANTEEN' });
    expect(probe.status).toBe(403);
    expect(codeOf(probe)).toBe('not_your_data');

    // ── 3 · The caterer PLACES the order — and the store's rice is held for it (10 of 20).
    const placed = await ok(call('POST', '/v1/b2b-portal/me/orders/so1', CUST_LOGIN, { fromQuotationId: 'q1' }), 'portal order');
    expect(placed.body).toMatchObject({ orderId: 'so1', locationId: 'S1', placedBy: CUST_LOGIN });
    await ok(call('POST', '/v1/b2b/documents/CATERER/quotations/q2', MGR, { lines: [{ ...RICE, qty: 15 }], locationId: 'S1' }), 'q2');
    const tooMuch = await call('POST', '/v1/b2b/documents/CATERER/orders/so2', MGR, { fromQuotationId: 'q2' });
    expect(tooMuch.status).toBe(409);
    expect(codeOf(tooMuch)).toBe('order_cannot_be_supplied');
    expect(await onHand()).toBe(20); // held, not moved

    // ── 4 · Six bags leave on a challan: on hand drops by six, ONCE; the order now holds only the four still to go.
    await ok(call('POST', '/v1/b2b/documents/CATERER/challans/dc1', MGR, { fromOrderId: 'so1', dispatched: { l1: 6 } }, 'dc1-a'), 'challan');
    expect(await onHand()).toBe(14);
    await call('POST', '/v1/b2b/documents/CATERER/challans/dc1', MGR, { fromOrderId: 'so1', dispatched: { l1: 6 } }, 'dc1-b'); // re-sent
    expect(await onHand()).toBe(14);
    // 14 on hand, 4 still held for so1 → 10 free: a 10-bag order goes, an 11-bag one would not.
    await ok(call('POST', '/v1/b2b/documents/CATERER/quotations/q3', MGR, { lines: [{ ...RICE, qty: 11 }], locationId: 'S1' }), 'q3');
    expect(codeOf(await call('POST', '/v1/b2b/documents/CATERER/orders/so3', MGR, { fromQuotationId: 'q3' }))).toBe('order_cannot_be_supplied');

    // ── 5 · Commission: proposed by one, approved by another (never the proposer), then DERIVED from the invoice.
    await ok(call('POST', '/v1/b2b/commissions/sp-1/rules/r1', ACCT, { rateBps: 250 }), 'propose rule');
    await ok(call('POST', '/v1/b2b/commissions/sp-1/rules/r-self', OWNER, { rateBps: 900 }), 'owner proposes');
    expect(codeOf(await call('POST', '/v1/b2b/commissions/sp-1/rules/r-self/approve', OWNER, {}))).toBe('self_approval');
    expect((await call('POST', '/v1/b2b/commissions/sp-1/rules/r1/approve', ACCT, {})).status).toBe(403); // no approval authority
    await ok(call('POST', '/v1/b2b/commissions/sp-1/rules/r1/approve', OWNER, {}), 'approve rule');
    await ok(call('POST', '/v1/b2b/documents/CATERER/quotations/q4', MGR, { lines: [{ ...RICE, lineId: 'l1', qty: 5 }], locationId: 'S1' }), 'q4');
    await ok(call('POST', '/v1/b2b/documents/CATERER/orders/so4', MGR, { fromQuotationId: 'q4', salespersonId: 'sp-1' }), 'so4');
    await ok(call('POST', '/v1/b2b/documents/CATERER/challans/dc4', MGR, { fromOrderId: 'so4', dispatched: { l1: 5 } }), 'dc4');
    const inv4 = await ok(call('POST', '/v1/b2b/documents/CATERER/invoices/inv4', MGR, { fromOrderId: 'so4' }), 'inv4');
    // 5 × ₹100 taxable = ₹500 at 2.5% = ₹12.50 exactly.
    expect(inv4.body).toMatchObject({ commission: { accrued: true, commissionMinor: 1_250, rateBps: 250 } });
    expect((await call('GET', '/v1/b2b/commissions/sp-1', OWNER)).body).toMatchObject({ totalCommissionMinor: 1_250, count: 1 });
    expect(await onHand()).toBe(9);
    // The portal order is billed too (no salesperson, so no commission).
    await ok(call('POST', '/v1/b2b/documents/CATERER/invoices/inv1', MGR, { fromOrderId: 'so1' }), 'inv1');

    // ── 6 · The caterer sees ITS orders with what was delivered and billed; the canteen sees none of them.
    const mine = (await call('GET', '/v1/b2b-portal/me/orders', CUST_LOGIN)).body as { orders: { orderId: string; chain: { orderedMinor: number; deliveredMinor: number; invoicedMinor: number } }[]; quoteRequests: unknown[] };
    expect(mine.orders.map((o) => o.orderId).sort()).toEqual(['so1', 'so4']);
    // 10 ordered, 6 delivered and billed (₹100 + 5% a bag).
    expect(mine.orders.find((o) => o.orderId === 'so1')!.chain).toMatchObject({ orderedMinor: 105_000, deliveredMinor: 63_000, invoicedMinor: 63_000 });
    expect(mine.quoteRequests).toHaveLength(1);
    expect(((await call('GET', '/v1/b2b-portal/me/orders', OTHER_LOGIN)).body as { orders: unknown[] }).orders).toHaveLength(0);
    expect(((await call('GET', '/v1/b2b-portal/me/statement', CUST_LOGIN)).body as { ageing: { totalOutstandingMinor: number } }).ageing.totalOutstandingMinor).toBe(63_000 + 52_500);

    // ── 7 · A recurring order: made from a quotation, runs only once a SECOND person approves it, once a day it is due.
    const D = '2026-11-02'; // a Monday
    await ok(call('POST', '/v1/b2b/documents/CATERER/quotations/q-tpl', MGR, { lines: [{ ...RICE, qty: 2 }], locationId: 'S1', validForDays: 365 }), 'template');
    await ok(call('POST', '/v1/b2b/recurring/rec-1', MGR, { customerId: 'CATERER', fromQuotationId: 'q-tpl', cadence: 'weekly', dayOf: 1, startsOn: D, salespersonId: 'sp-1' }), 'propose recurring');
    expect(((await ok(call('POST', '/v1/b2b/recurring-runs', MGR, { on: D }), 'run before approval')).body as { generated: number }).generated).toBe(0);
    expect((await call('POST', '/v1/b2b/recurring/rec-1/approve', MGR, {})).status).toBe(403);
    await ok(call('POST', '/v1/b2b/recurring/rec-1/approve', OWNER, {}), 'approve recurring');
    const run1 = (await ok(call('POST', '/v1/b2b/recurring-runs', MGR, { on: D }), 'run')).body as { generated: number; runs: { orderId?: string }[] };
    expect(run1.generated).toBe(1);
    expect(run1.runs[0]!.orderId).toBe(`RSO-rec-1-${D}`);
    expect(((await ok(call('POST', '/v1/b2b/recurring-runs', MGR, { on: D }), 'run again')).body as { generated: number }).generated).toBe(0);
    expect(((await ok(call('POST', '/v1/b2b/recurring-runs', MGR, { on: '2026-11-03' }), 'not due')).body as { runs: unknown[] }).runs).toHaveLength(0);
    // The generated order holds its 2 bags: 9 on hand, 4 (so1) + 2 held → 3 free.
    // A recurring order the shelf cannot supply is an EXCEPTION on record, not a quiet skip.
    await ok(call('POST', '/v1/b2b/documents/CATERER/quotations/q-big', MGR, { lines: [{ ...RICE, qty: 50 }], locationId: 'S1', validForDays: 365 }), 'big template');
    await ok(call('POST', '/v1/b2b/recurring/rec-2', MGR, { customerId: 'CATERER', fromQuotationId: 'q-big', cadence: 'monthly', dayOf: 2, startsOn: D }), 'propose big');
    await ok(call('POST', '/v1/b2b/recurring/rec-2/approve', OWNER, {}), 'approve big');
    const run2 = (await ok(call('POST', '/v1/b2b/recurring-runs', MGR, { on: D }), 'run big')).body as { exceptions: number };
    expect(run2.exceptions).toBe(1);
    const book = (await call('GET', '/v1/b2b/recurring', OWNER)).body as { exceptions: { scheduleId: string; code: string }[] };
    expect(book.exceptions).toEqual([expect.objectContaining({ scheduleId: 'rec-2', code: 'order_cannot_be_supplied' })]);
  }, 60_000);
});
