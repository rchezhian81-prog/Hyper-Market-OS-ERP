import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **SF-09 (Batch 2 · M24-FR-01/02/04) — the supplier portal FEEDS purchasing, connected, on the real API.**
 *
 * The audit's finding: the portal's demonstrated flow was read-only, and an accepted submission carried no invoice or ASN to
 * feed purchasing. Now a SUPPLIER, signed in on its own portal login, submits its invoice and its ASN with their documents;
 * the order named is looked up on head office's register and must be that supplier's; the documents are kept exactly as
 * sent; a BUYER (never the submitter) reviews each — accepted, the invoice is on the supplier-invoice register the three-way
 * match reads and the ASN on the register the ASN compare reads; rejected, it feeds nothing and the supplier sees why.
 * In memory and, with DATABASE_URL, on real PostgreSQL. Synthetic data only.
 */

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

const INVOICE = { invoiceId: 'SUP-INV-7', poId: 'po-a', declaredTotalMinor: 21_600, lines: [{ productId: 'p-oil', quantity: 12, unitPriceMinor: 1_800, lineTotalMinor: 21_600 }] };
const ASN = { asnId: 'ASN-7', poId: 'po-a', expectedAt: '2026-10-11T06:00:00.000Z', lines: [{ lineId: 'A1', productId: 'p-oil', quantityMinor: 12, uom: 'ea' }] };

describe.each(backings)('SF-09 — the supplier portal feeds purchasing — on $name', ({ harness }) => {
  it('a supplier submits its own invoice and ASN; a buyer accepts them onto the registers the match and the ASN compare read; scope, self-review and rejection are refused or said', async () => {
    const h = harness();
    const t = randomUUID();
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string, query?: Readonly<Record<string, string>>) =>
      h.request({ method, path, userId, tenantId: t, ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }), ...(query === undefined ? {} : { query }) });
    await h.seedOwner(t, 'u-owner');
    for (const u of ['u-buyer', 'u-buyer2', 'u-recv']) await h.provisionRole(t, u, 'store_manager');
    await h.provisionRole(t, 'u-sup', 'supplier');
    await h.provisionRole(t, 'u-supb', 'supplier');
    await approvedSuppliers(h, t, 'sup-a', 'sup-b');
    await deliveryPlaces(h, t, 'S1', 'S1-BACK');
    expect((await call('POST', '/v1/inventory/receipt-policy', 'u-owner', { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 }, 'pol')).status).toBe(201);
    expect((await call('POST', '/v1/catalogue/products/p-oil/publish', 'u-owner', {
      product: { sku: 'p-oil', name: 'Oil 1L', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1507', lifecycle: 'active', handling: 'ambient' },
      categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
    }, 'pub-oil')).status).toBe(201);
    for (const [po, supplier] of [['po-a', 'sup-a'], ['po-b', 'sup-b']] as const) {
      expect((await call('POST', `/v1/purchase/orders/${po}`, 'u-buyer', { supplierId: supplier, deliverToLocationId: 'S1', lines: [{ productId: 'p-oil', orderedQty: 12, unitCost: { minor: 1_800, currency: 'INR' } }] }, po)).status).toBe(201);
      expect((await call('POST', `/v1/purchase/orders/${po}/approval`, 'u-owner', { reason: 'ok' }, `${po}-ok`)).status).toBe(200);
    }
    for (const [partner, login] of [['sup-a', 'u-sup'], ['sup-b', 'u-supb']] as const) {
      expect((await call('POST', `/v1/supplier-portal/partners/${partner}`, 'u-buyer', { grants: ['view_orders', 'submit_invoice', 'submit_asn'], documents: [], requiredDocuments: [], logins: [login] }, `cfg-${partner}`)).status).toBe(201);
    }
    const submit = (u: string, body: Record<string, unknown>, key: string) => call('POST', '/v1/supplier-portal/me/submissions', u, body, key);

    // 1. The supplier submits ITS OWN invoice (the partner is its login's binding — there is none in the request).
    const sub = await submit('u-sup', { submissionId: 'sub-inv', kind: 'invoice', document: INVOICE }, 'k-inv');
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    expect(sub.body).toMatchObject({ partnerId: 'sup-a', accepted: true, requiresReview: true, awaiting: 'buyer_review' });
    // Scope: another supplier's order is refused by name (head office's register says whose po-b is); a document naming a
    // supplier is refused; the supplier cannot use the buyer's partner-keyed route; an order head office does not hold is refused.
    expect(codeOf(await submit('u-sup', { submissionId: 'sub-x', kind: 'invoice', document: { ...INVOICE, invoiceId: 'X', poId: 'po-b' } }, 'k-x'))).toBe('not_your_order');
    expect(codeOf(await submit('u-sup', { submissionId: 'sub-y', kind: 'invoice', document: { ...INVOICE, invoiceId: 'Y', supplierId: 'sup-b' } }, 'k-y'))).toBe('not_readable_as_a_document');
    expect((await call('POST', '/v1/supplier-portal/partners/sup-b/submissions', 'u-sup', { submissionId: 'sub-z', kind: 'invoice', document: INVOICE }, 'k-z')).status).toBe(403);
    expect(codeOf(await submit('u-sup', { submissionId: 'sub-w', kind: 'invoice', document: { ...INVOICE, invoiceId: 'W', poId: 'po-none' } }, 'k-w'))).toBe('order_unknown');
    expect(codeOf(await submit('u-sup', { submissionId: 'sub-v', kind: 'invoice' }, 'k-v'))).toBe('not_readable_as_a_document');
    // Nothing reached purchasing yet: a supplier's submission never takes effect on its own.
    expect((await call('GET', '/v1/purchase/invoices/SUP-INV-7', 'u-buyer')).status).toBe(404);

    // 2. The buyer's queue shows the document EXACTLY as sent, waiting for a person.
    const queue = (await call('GET', '/v1/supplier-portal/partners/sup-a/submissions', 'u-buyer', undefined, undefined, { review: 'true' })).body as { submissions: { submissionId: string; document: unknown; submittedBy: string; review: unknown }[] };
    expect(queue.submissions).toEqual([expect.objectContaining({ submissionId: 'sub-inv', document: INVOICE, submittedBy: 'u-sup', review: 'awaiting_buyer' })]);

    // 3. The delivery arrives against po-a; the buyer ACCEPTS the invoice — it is captured onto the supplier-invoice register.
    expect((await call('POST', '/v1/inventory/goods-receipt/g-a', 'u-recv', {
      warehouseId: 'S1-BACK', receivedOnDate: '2026-10-11', currency: 'INR', poId: 'po-a',
      lines: [{ lineId: 'L1', productId: 'p-oil', orderedMinor: 12, countedMinor: 12, uom: 'ea', unitCost: { minor: 1_800, currency: 'INR' }, condition: 'good' }],
    }, 'g-a')).status).toBe(201);
    const accepted = await call('POST', '/v1/supplier-portal/partners/sup-a/submissions/sub-inv/review', 'u-buyer', { decision: 'accept', reason: 'matches the delivery note' }, 'rv-inv');
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect(accepted.body).toMatchObject({ review: { decision: 'accepted', reviewedBy: 'u-buyer', fed: { invoiceId: 'SUP-INV-7' } } });
    expect((await call('POST', '/v1/supplier-portal/partners/sup-a/submissions/sub-inv/review', 'u-buyer', { decision: 'accept', reason: 'again' }, 'rv-inv2')).body).toMatchObject({ alreadyReviewed: true });
    expect(codeOf(await call('POST', '/v1/supplier-portal/partners/sup-a/submissions/sub-inv/review', 'u-buyer2', { decision: 'reject', reason: 'changed my mind' }, 'rv-inv3'))).toBe('already_reviewed');
    const invoice = (await call('GET', '/v1/purchase/invoices/SUP-INV-7', 'u-buyer')).body as { invoice?: Record<string, unknown> } & Record<string, unknown>;
    const rec = (invoice['invoice'] ?? invoice) as Record<string, unknown>;
    expect(rec).toMatchObject({ invoiceId: 'SUP-INV-7', supplierId: 'sup-a', poId: 'po-a', capturedBy: 'u-sup', approvedBy: null, source: 'supplier-portal/sub-inv', totalMinor: 21_600 });
    expect(rec['lines']).toEqual([expect.objectContaining({ productId: 'p-oil', quantity: 12, unitPriceMinor: 1_800, lineTotalMinor: 21_600 })]);
    // …and the three-way match reads it: order, delivery and the supplier's own bill agree.
    const match = await call('POST', '/v1/purchase/invoices/SUP-INV-7/match', 'u-buyer2', {}, 'm-7');
    expect(match.status, JSON.stringify(match.body)).toBeLessThan(300);
    expect(match.body).toMatchObject({ payableMinor: 21_600, lines: [expect.objectContaining({ status: 'matched' })] });

    // 4. ASNs: one rejected (it feeds nothing; the supplier sees why), one accepted onto the register the compare reads.
    expect((await submit('u-sup', { submissionId: 'sub-asn-bad', kind: 'asn', document: { ...ASN, asnId: 'ASN-6' } }, 'k-asn-bad')).status).toBe(201);
    expect((await submit('u-sup', { submissionId: 'sub-asn', kind: 'asn', document: ASN }, 'k-asn')).status).toBe(201);
    expect((await call('POST', '/v1/supplier-portal/partners/sup-a/submissions/sub-asn-bad/review', 'u-buyer2', { decision: 'reject', reason: 'wrong delivery date' }, 'rv-asn-bad')).body).toMatchObject({ review: { decision: 'rejected', fed: null } });
    expect((await call('POST', '/v1/supplier-portal/partners/sup-a/submissions/sub-asn/review', 'u-buyer2', { decision: 'accept', reason: 'booked for dock 2' }, 'rv-asn')).body).toMatchObject({ review: { fed: { asnId: 'ASN-7' } } });
    const compared = await call('POST', '/v1/inventory/asn/compare', 'u-recv', { asnId: 'ASN-7', received: { 'p-oil': 10 } }, 'cmp-7');
    expect(compared.status, JSON.stringify(compared.body)).toBe(200);
    expect(compared.body).toMatchObject({ asnId: 'ASN-7', supplierId: 'sup-a', matched: false, count: 1 });
    expect(codeOf(await call('POST', '/v1/inventory/asn/compare', 'u-recv', { asnId: 'ASN-6', received: { 'p-oil': 10 } }, 'cmp-6'))).toBe('asn_unknown');

    // 5. A buyer who keyed a submission in cannot also review it (§28).
    expect((await call('POST', '/v1/supplier-portal/partners/sup-a/submissions', 'u-buyer', { submissionId: 'sub-keyed', kind: 'invoice', document: { ...INVOICE, invoiceId: 'SUP-INV-8' } }, 'k-keyed')).status).toBe(201);
    expect(codeOf(await call('POST', '/v1/supplier-portal/partners/sup-a/submissions/sub-keyed/review', 'u-buyer', { decision: 'accept', reason: 'mine' }, 'rv-keyed'))).toBe('self_review');

    // 6. The supplier sees its own submissions, where each review got to and why — and nothing of sup-b's.
    const mine = (await call('GET', '/v1/supplier-portal/me/submissions', 'u-sup')).body as { partnerId: string; submissions: { submissionId: string; review: unknown }[] };
    expect(mine.partnerId).toBe('sup-a');
    expect(mine.submissions.find((s) => s.submissionId === 'sub-asn-bad')?.review).toMatchObject({ decision: 'rejected', reason: 'wrong delivery date' });
    expect(((await call('GET', '/v1/supplier-portal/me/submissions', 'u-supb')).body as { submissions: unknown[] }).submissions).toEqual([]);
  }, 90_000);
});
