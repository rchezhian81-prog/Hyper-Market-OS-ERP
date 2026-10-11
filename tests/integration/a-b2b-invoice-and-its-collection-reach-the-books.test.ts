import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **FUL-09 — a B2B invoice and its collection carry their money (M22-FR-01/02/04 → M23-FR-01 · P-02 · P-08).** A business
 * customer on 30-day terms is invoiced for what the challan says left; that invoice becomes — at once — the receivable
 * collections ages (due 30 days after issue), the customer's AR balance, and a fact for the books. A part payment is
 * allocated to it and moves the AR balance down; the collections ageing and the AR ledger agree. The accountant's posting run
 * books the invoice (receivables against revenue and output tax) and the receipt (money against receivables) once each.
 * In memory and, with DATABASE_URL, on real PostgreSQL.
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

// 10 × ₹100 @ 5% → net ₹1,000, tax ₹50, gross ₹1,050.
const LINES = [{ lineId: 'l1', productId: 'p1', description: 'Rice 25kg', qty: 10, unitPriceMinor: 10_000, taxRateBps: 500 }];

describe.each(backings)('FUL-09 — a B2B invoice and its collection move AR and reach the books, once — on $name', ({ harness }) => {
  it('invoice → receivable on terms + AR + journal; part payment → AR down, ageing settled, journal; a re-run posts nothing', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.enableFeature(T, 'b2b');
    await h.provisionRole(T, 'u-acct', 'accountant');
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, user = 'u-owner', key?: string) =>
      h.request({ method, path, userId: user, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: key ?? `${path}-${user}` }) });
    const ok = async (p: ReturnType<typeof call>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const asOf = async (path: string) => (await h.request({ method: 'GET', path, userId: 'u-owner', tenantId: T, query: { asOf: new Date().toISOString().slice(0, 10) } })).body;

    await ok(call('POST', '/v1/b2b/accounts/CUST1', { creditLimitMinor: 1_000_000, paymentTermsDays: 30 }), 'terms');
    await ok(call('POST', '/v1/b2b/documents/CUST1/quotations/q1', { lines: LINES }), 'quote');
    // FUL-09: the order holds its rice at the store it is supplied from.
    await ok(call('POST', '/v1/inventory/movements', { movementId: 'rice-in', productId: 'p1', locationId: 'S1', kind: 'received', quantityMinor: 50, uom: 'ea', occurredAt: new Date().toISOString(), enteredBy: 'u-owner' }), 'stock');
    await ok(call('POST', '/v1/b2b/documents/CUST1/orders/so1', { fromQuotationId: 'q1', locationId: 'S1' }), 'order');
    await ok(call('POST', '/v1/b2b/documents/CUST1/challans/dc1', { fromOrderId: 'so1', dispatched: { l1: 10 } }), 'challan');
    const inv = await ok(call('POST', '/v1/b2b/documents/CUST1/invoices/inv1', { fromOrderId: 'so1' }), 'invoice');
    const today = new Date().toISOString().slice(0, 10);
    const due = new Date(Date.parse(`${today}T00:00:00.000Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
    expect(inv.body).toMatchObject({ grossMinor: 105_000, dueOn: due });

    // The invoice is money owed: the customer's AR balance and the receivable collections ages, on 30-day terms.
    expect((await call('GET', '/v1/b2b/accounts/CUST1')).body).toMatchObject({ outstandingMinor: 105_000 });
    expect(await asOf('/v1/b2b/collections/CUST1/ageing')).toMatchObject({ totalOutstandingMinor: 105_000, overdueMinor: 0, items: [expect.objectContaining({ invoiceId: 'inv1' })] });

    // ₹600 is received against it.
    const paid = await ok(call('POST', '/v1/b2b/collections/CUST1/payments/r1', { receivedMinor: 60_000 }), 'payment');
    expect(paid.body).toMatchObject({ allocatedMinor: 60_000, unappliedMinor: 0, allocations: [{ invoiceId: 'inv1', appliedMinor: 60_000 }] });
    expect((await call('GET', '/v1/b2b/accounts/CUST1')).body).toMatchObject({ outstandingMinor: 45_000 });
    expect(await asOf('/v1/b2b/collections/CUST1/ageing')).toMatchObject({ totalOutstandingMinor: 45_000 });
    // The two figures — the collections sub-ledger and the AR ledger — agree.
    expect(await asOf('/v1/b2b/collections/CUST1/reconciliation')).toMatchObject({ portalOutstandingMinor: 45_000, financeOutstandingMinor: 45_000, agrees: true });

    // The books: one journal for the invoice, one for the receipt, through the accountant's mapping.
    await ok(call('PUT', '/v1/finance/posting-map', DEFAULT_RETAIL_POSTING_MAP, 'u-acct', 'map'), 'mapping');
    const run = await call('POST', '/v1/finance/b2b/post', {}, 'u-acct', 'post-1');
    expect(run.status).toBe(201);
    const posted = (run.body as { posted: { entryId: string; lines: { accountCode: string; debitMinor: number; creditMinor: number }[] }[] }).posted;
    expect(posted.map((j) => [j.entryId, j.lines])).toEqual([
      ['b2b:invoice:CUST1:inv1', [
        { accountCode: 'trade_receivables', debitMinor: 105_000, creditMinor: 0 },
        { accountCode: 'sales_revenue', debitMinor: 0, creditMinor: 100_000 },
        { accountCode: 'gst_output', debitMinor: 0, creditMinor: 5_000 },
      ]],
      ['b2b:receipt:CUST1:r1', [
        { accountCode: 'bank_receipts_clearing', debitMinor: 60_000, creditMinor: 0 },
        { accountCode: 'trade_receivables', debitMinor: 0, creditMinor: 60_000 },
      ]],
    ]);
    expect((await call('POST', '/v1/finance/b2b/post', {}, 'u-acct', 'post-2')).body).toMatchObject({ posted: [] });
    expect((await call('GET', '/v1/finance/b2b/postings', undefined, 'u-acct')).body).toMatchObject({ unposted: [] });
  });
});
