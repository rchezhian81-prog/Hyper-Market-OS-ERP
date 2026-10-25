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
 * **OB-288 commercial desks — M24-FR-01/02: the buyer decides every supplier's submissions from ONE queue, and sees each
 * order's delivery status.**
 *
 * On the real API (in memory and, with DATABASE_URL, real PostgreSQL with a cold restart):
 *   • two suppliers submit — an invoice with its document, a catalogue / cost proposal, a claim — and one queue lists every
 *     one still waiting for a buyer, oldest first;
 *   • a proposal and a claim are ACCEPTED or REJECTED with a reason (kept beside them; they feed nothing on their own); the
 *     submitter never reviews their own; a decided one leaves the queue;
 *   • a supplier tells the buyer an order is DELAYED with a new date (M24-FR-02 "delivery status"): it needs the order to be
 *     its own and a date; it waits for nobody; the buyer reads the latest per order; no word yet is said as such;
 *   • a cashier (no review authority) reads nothing.
 * Synthetic data only.
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

const INVOICE = { invoiceId: 'SUP-INV-9', poId: 'po-a', declaredTotalMinor: 21_600, lines: [{ productId: 'p-oil', quantity: 12, unitPriceMinor: 1_800, lineTotalMinor: 21_600 }] };
const inDays = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe.each(backings)('M24-FR-01/02 — one review queue and delivery status — on $name', ({ name, harness }) => {
  it('decides proposals and claims with a reason, never the submitter\'s own; delivery updates per order; scope refused', async () => {
    let h = harness();
    const t = randomUUID();
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Readonly<Record<string, string>>) =>
      h.request({ method, path, userId, tenantId: t, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `${path}-${userId}-${randomUUID()}` }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: ReturnType<typeof call>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await h.seedOwner(t, 'u-owner');
    await h.provisionRole(t, 'u-buyer', 'store_manager');
    await h.provisionRole(t, 'u-cash', 'cashier');
    await h.provisionRole(t, 'u-sup', 'supplier');
    await h.provisionRole(t, 'u-supb', 'supplier');
    await approvedSuppliers(h, t, 'sup-a', 'sup-b');
    await deliveryPlaces(h, t, 'S1', 'S1-BACK');
    await ok(call('POST', '/v1/catalogue/products/p-oil/publish', 'u-owner', {
      product: { sku: 'p-oil', name: 'Oil 1L', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1507', lifecycle: 'active', handling: 'ambient' },
      categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
    }), 'publish');
    for (const [po, supplier] of [['po-a', 'sup-a'], ['po-b', 'sup-b']] as const) {
      await ok(call('POST', `/v1/purchase/orders/${po}`, 'u-buyer', { supplierId: supplier, deliverToLocationId: 'S1', lines: [{ productId: 'p-oil', orderedQty: 12, unitCost: { minor: 1_800, currency: 'INR' } }] }), po);
      await ok(call('POST', `/v1/purchase/orders/${po}/approval`, 'u-owner', { reason: 'ok' }), `${po} approval`);
    }
    for (const [partner, login] of [['sup-a', 'u-sup'], ['sup-b', 'u-supb']] as const) {
      await ok(call('POST', `/v1/supplier-portal/partners/${partner}`, 'u-buyer', { grants: ['view_orders', 'submit_invoice', 'submit_catalogue', 'raise_claim', 'acknowledge_orders'], documents: [], requiredDocuments: [], logins: [login] }), `cfg ${partner}`);
    }
    const submit = (u: string, body: Record<string, unknown>) => call('POST', '/v1/supplier-portal/me/submissions', u, body);

    // ── 1 · Three submissions from two suppliers wait for a buyer, in ONE queue, oldest first.
    await ok(submit('u-sup', { submissionId: 'sub-inv', kind: 'invoice', document: INVOICE }), 'invoice');
    await ok(submit('u-sup', { submissionId: 'sub-cat', kind: 'catalogue', document: { products: [{ productId: 'p-oil', newCostMinor: 1_750 }] } }), 'cost proposal');
    await ok(submit('u-supb', { submissionId: 'sub-claim', kind: 'claim', document: { poId: 'po-b', claimMinor: 3_600, why: 'two short' } }), 'claim');
    const queue = (await ok(call('GET', '/v1/supplier-portal/review-queue', 'u-buyer'), 'queue')).body as { waiting: { submissionId: string; partnerId: string; kind: string }[]; suppliers: number };
    expect(queue.waiting.map((w) => `${w.partnerId}:${w.submissionId}`)).toEqual(['sup-a:sub-inv', 'sup-a:sub-cat', 'sup-b:sub-claim']);
    expect(queue.suppliers).toBe(2);

    // ── 2 · The cost proposal is ACCEPTED, the claim REJECTED — each with a reason; neither feeds anything by itself.
    const accepted = await ok(call('POST', '/v1/supplier-portal/partners/sup-a/submissions/sub-cat/review', 'u-buyer', { decision: 'accept', reason: 'matches the new price letter' }), 'accept proposal');
    expect(accepted.body).toMatchObject({ review: { decision: 'accepted', reviewedBy: 'u-buyer', fed: null } });
    expect(codeOf(await call('POST', '/v1/supplier-portal/partners/sup-b/submissions/sub-claim/review', 'u-buyer', { decision: 'reject' }))).toBe('not_readable_as_a_review');
    await ok(call('POST', '/v1/supplier-portal/partners/sup-b/submissions/sub-claim/review', 'u-owner', { decision: 'reject', reason: 'the receipt shows all twelve' }), 'reject claim');
    // A second, different decision would be a second truth.
    expect(codeOf(await call('POST', '/v1/supplier-portal/partners/sup-b/submissions/sub-claim/review', 'u-buyer', { decision: 'accept', reason: 'x' }))).toBe('already_reviewed');
    const after = (await ok(call('GET', '/v1/supplier-portal/review-queue', 'u-buyer'), 'queue after')).body as { waiting: { submissionId: string }[]; decided: { submissionId: string; review: { decision: string; reason: string } }[] };
    expect(after.waiting.map((w) => w.submissionId)).toEqual(['sub-inv']);
    expect(after.decided.map((d) => `${d.submissionId}:${d.review.decision}`).sort()).toEqual(['sub-cat:accepted', 'sub-claim:rejected']);
    // The supplier sees the buyer's decision and its reason.
    const mine = (await ok(call('GET', '/v1/supplier-portal/me/submissions', 'u-supb'), 'supplier reads')).body as { submissions: { submissionId: string; review: { reason: string } }[] };
    expect(mine.submissions.find((s) => s.submissionId === 'sub-claim')?.review.reason).toBe('the receipt shows all twelve');

    // ── 3 · Delivery status (M24-FR-02): a supplier says po-a is delayed to a new date; its own order only; a date needed.
    expect((await ok(call('GET', '/v1/supplier-portal/orders/po-a/delivery-status', 'u-buyer'), 'no word yet')).body).toMatchObject({ latest: null, updates: [] });
    await ok(submit('u-sup', { submissionId: 'ds-1', kind: 'delivery_status', document: { poId: 'po-a', status: 'dispatched', expectedOn: inDays(2) } }), 'dispatched');
    const delayed = await ok(submit('u-sup', { submissionId: 'ds-2', kind: 'delivery_status', document: { poId: 'po-a', status: 'delayed', expectedOn: inDays(5), note: 'lorry broke down at Salem' } }), 'delayed');
    expect(delayed.body).toMatchObject({ kind: 'delivery_status', requiresReview: false });
    expect(codeOf(await submit('u-sup', { submissionId: 'ds-x', kind: 'delivery_status', document: { poId: 'po-b', status: 'delayed', expectedOn: inDays(5) } }))).toBe('not_your_order');
    expect(codeOf(await submit('u-sup', { submissionId: 'ds-y', kind: 'delivery_status', document: { poId: 'po-a', status: 'delayed' } }))).toBe('not_readable_as_a_document');
    expect(codeOf(await submit('u-sup', { submissionId: 'ds-z', kind: 'delivery_status' }))).toBe('not_readable_as_a_document');
    const status = (await ok(call('GET', '/v1/supplier-portal/orders/po-a/delivery-status', 'u-buyer'), 'po-a status')).body as { latest: { status: string; expectedOn: string; note: string }; updates: unknown[] };
    expect(status.latest).toMatchObject({ status: 'delayed', expectedOn: inDays(5), note: 'lorry broke down at Salem' });
    expect(status.updates).toHaveLength(2);
    const q3 = (await ok(call('GET', '/v1/supplier-portal/review-queue', 'u-buyer'), 'queue deliveries')).body as { waiting: { submissionId: string }[]; deliveries: { poId: string; status: string }[] };
    expect(q3.deliveries).toEqual([expect.objectContaining({ poId: 'po-a', status: 'delayed' })]);
    expect(q3.waiting.map((w) => w.submissionId)).toEqual(['sub-inv']); // a delivery status waits for nobody
    // Nothing to decide on a delivery status.
    expect(codeOf(await call('POST', '/v1/supplier-portal/partners/sup-a/submissions/ds-2/review', 'u-buyer', { decision: 'accept', reason: 'x' }))).toBe('nothing_to_feed');

    // ── 4 · A cashier holds no review authority.
    expect((await call('GET', '/v1/supplier-portal/review-queue', 'u-cash')).status).toBe(403);
    expect((await call('GET', '/v1/supplier-portal/orders/po-a/delivery-status', 'u-cash')).status).toBe(403);

    // ── 5 · Cold restart (PostgreSQL): the queue, the decisions and the delivery status are all still there.
    if (name === 'real PostgreSQL') {
      const sql = pgPoolClient(pool!);
      h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
      const again = (await ok(call('GET', '/v1/supplier-portal/review-queue', 'u-buyer'), 'after restart')).body as { waiting: { submissionId: string }[]; decided: unknown[]; deliveries: { status: string }[] };
      expect(again.waiting.map((w) => w.submissionId)).toEqual(['sub-inv']);
      expect(again.decided).toHaveLength(2);
      expect(again.deliveries.map((d) => d.status)).toEqual(['delayed']);
    }
  }, 120_000);
});
