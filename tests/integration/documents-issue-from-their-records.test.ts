import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers } from '../support/approved-supplier';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { auditTrailAdapter, b2bCollectionsAdapter } from '../../services/api/src/adapters';

/**
 * **A business document is issued from its record, and frozen with what the record said (audit PA-09 · M31-FR-02).**
 *
 * The caller names the source — a purchase order, a goods receipt, a sale, a supplier's or customer's account — and head
 * office reads it: a missing record is refused, a draft (a proposed order, a receipt still waiting on a decision) is
 * refused, and any number, money, tax or free words sent with it are refused. The document carries the record's own
 * number, or one allocated from the shop's gap-free series for a record that has none (a statement). Frozen on it: the
 * record's version, the money and tax read from it, and the template version — so a later change to the order or the
 * template is a different document and never rewrites the one already sent. A reprint is the same bytes, numbered, and on
 * the audit trail. Run in memory and on real PostgreSQL.
 */

type Body = Record<string, unknown>;
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const cost = { minor: 2_000, currency: 'INR' };
interface Doc {
  documentId: string; content: string; templateVersion: number; kind: string;
  source: { type: string; id: string; version: string; number: string; numberAllocated: boolean };
  figures: { currency: string; totalMinor: number; taxMinor: number | null; lines: { productId: string; quantityMinor: number; lineTotalMinor: number; taxMinor?: number }[]; amounts?: Record<string, number> };
}

async function shop(h: ApiHarness, t: string) {
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string, branchId?: string) =>
    h.request({ method, path, userId, tenantId: t, ...(branchId === undefined ? {} : { branchId }), ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }) });
  await h.seedOwner(t, 'u-owner');
  await h.provisionRole(t, 'u-buyer', 'store_manager');
  await h.provisionRole(t, 'u-checker', 'store_manager');
  await h.provisionRole(t, 'u-mgr-b', 'store_manager', ['S-B']); // runs store B only
  await approvedSuppliers(h, t, 'sup-1');
  await approvedSuppliers(h, t, 'sup-2');
  for (const [id, body] of [['C1', { kind: 'company', name: 'SRE Retail' }], ['S-A', { kind: 'branch', name: 'Store A', parentId: 'C1', companyId: 'C1' }], ['S-B', { kind: 'branch', name: 'Store B', parentId: 'C1', companyId: 'C1' }]] as const) {
    expect((await call('POST', `/v1/org/nodes/${id}`, 'u-owner', body, `org-${id}`)).status).toBe(201);
  }
  expect((await call('POST', '/v1/inventory/receipt-policy', 'u-owner', { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 }, 'pol')).status).toBe(201);

  // A template per kind: drafted by the owner, approved by another person (Wave 2b · PA-03).
  const template = async (templateId: string, kind: string, body: string, key: string) => {
    const drafted = await call('POST', `/v1/documents/templates/${templateId}/versions`, 'u-owner', { kind, body, changeNote: 'layout' }, `${key}-d`);
    expect(drafted.status).toBe(201);
    const v = (drafted.body as { version: number }).version;
    expect((await call('POST', `/v1/documents/templates/${templateId}/versions/${v}/approve`, 'u-checker', {}, `${key}-a`)).status).toBeLessThan(300);
  };
  await template('po', 'purchase_order', 'PURCHASE ORDER {{documentNumber}} to {{supplierId}} for {{deliverTo}}: {{lines}} — total {{total}}', 't-po');
  await template('grn', 'goods_receipt', 'GOODS RECEIVED {{documentNumber}} against {{purchaseOrder}}: {{lines}} — {{total}}', 't-grn');
  await template('inv', 'tax_invoice', 'TAX INVOICE {{documentNumber}}: {{lines}} — taxable {{taxable}}, GST {{tax}}, total {{total}}', 't-inv');
  await template('stm', 'statement', 'STATEMENT {{documentNumber}} as at {{asAt}} — owed {{owed}}{{outstanding}}', 't-stm');

  const order = (poId: string, store = 'S-A', qty = 10) => call('POST', `/v1/purchase/orders/${poId}`, 'u-buyer', { supplierId: 'sup-1', deliverToLocationId: store, lines: [{ productId: 'p1', orderedQty: qty, unitCost: cost }] }, `po-${poId}`);
  const approve = async (poId: string) => expect((await call('POST', `/v1/purchase/orders/${poId}/approval`, 'u-owner', { reason: 'ok' }, `po-${poId}-ok`)).status).toBe(200);
  const receive = (grnId: string, poId: string, warehouseId: string, counted: number) => call('POST', `/v1/inventory/goods-receipt/${grnId}`, 'u-buyer', {
    warehouseId, receivedOnDate: '2026-10-10', currency: 'INR', poId,
    lines: [{ lineId: 'L1', productId: 'p1', orderedMinor: 10, countedMinor: counted, uom: 'ea', unitCost: cost, condition: 'good' }],
  }, grnId);
  const sell = (saleId: string, rated = true) => call('POST', '/v1/sales', 'u-owner', {
    saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', locationId: 'S-A', cashierId: 'u-owner', tradingDay: '2026-10-09', committedAt: '2026-10-09T10:00:00.000Z',
    totalMinor: 11800, currency: 'INR', packVersion: 1,
    lines: [{ productId: 'p1', quantityMinor: 1, uom: 'each', unitPriceMinor: 11800, lineTotalMinor: 11800, ...(rated ? { taxRateBps: 1800 } : {}) }],
    tenders: [{ kind: 'cash', amountMinor: 11800 }],
  }, `sale-${saleId}`);
  const issue = (templateId: string, body: Body, key: string, userId = 'u-owner', branchId?: string) =>
    call('POST', `/v1/documents/templates/${templateId}/issue`, userId, body, key, branchId);
  return { call, order, approve, receive, sell, issue, template };
}

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

describe.each(backings)('PA-09 — documents are issued from their records — on $name', ({ harness }) => {
  it('a purchase order: a draft is refused; an approved one is issued under its own number at cost; nothing the caller sends is believed', async () => {
    const h = harness(); const t = randomUUID(); const s = await shop(h, t);
    const proposed = await s.order('po-1');
    expect(proposed.status).toBe(201);
    const number = (proposed.body as { order: { number: string } }).order.number;

    const draft = await s.issue('po', { source: { type: 'purchase_order', id: 'po-1' } }, 'i-draft');
    expect(draft.status).toBe(409);
    expect(codeOf(draft)).toBe('document_source_not_final');
    expect(codeOf(await s.issue('po', { source: { type: 'purchase_order', id: 'po-nope' } }, 'i-missing'))).toBe('document_source_not_found');

    await s.approve('po-1');
    // The caller's own figures, number, words or document id are refused by name.
    for (const [k, extra] of [['data', { data: { total: 'Rs 1' } }], ['totalMinor', { totalMinor: 1 }], ['number', { number: 'PO-FAKE' }], ['documentId', { documentId: 'mine' }]] as const) {
      const r = await s.issue('po', { source: { type: 'purchase_order', id: 'po-1' }, ...extra }, `i-${k}`);
      expect(r.status, k).toBe(400);
      expect(codeOf(r), k).toBe('figures_come_from_the_source');
    }
    expect(codeOf(await s.issue('po', { source: { type: 'purchase_order', id: 'po-1' }, kind: 'tax_invoice' }, 'i-kind'))).toBe('kind_follows_the_source');
    expect(codeOf(await s.issue('inv', { source: { type: 'purchase_order', id: 'po-1' } }, 'i-wrong-tmpl'))).toBe('template_is_for_another_kind');

    const res = await s.issue('po', { source: { type: 'purchase_order', id: 'po-1' } }, 'i-po');
    expect(res.status).toBe(201);
    const doc = res.body as Doc;
    expect(doc.kind).toBe('purchase_order');
    expect(doc.source).toMatchObject({ type: 'purchase_order', id: 'po-1', number, numberAllocated: false });
    expect(doc.figures).toMatchObject({ currency: 'INR', totalMinor: 20000, taxMinor: null, lines: [{ productId: 'p1', quantityMinor: 10, lineTotalMinor: 20000 }] });
    expect(doc.templateVersion).toBe(1);
    expect(doc.content).toBe(`PURCHASE ORDER ${number} to sup-1 for S-A: p1 10 ea @ Rs 20.00 = Rs 200.00 — total Rs 200.00`);

    // The same order in the same state is the same document — issued once.
    const again = await s.issue('po', { source: { type: 'purchase_order', id: 'po-1' } }, 'i-po-2');
    expect(again.status).toBe(200);
    expect((again.body as Doc).documentId).toBe(doc.documentId);

    // A new layout does not touch what was sent: the document reproduces under v1, with v1's words and figures.
    await s.template('po', 'purchase_order', 'NEW LAYOUT {{documentNumber}} {{total}}', 't-po-2');
    const kept = (await s.call('GET', `/v1/documents/issued/${encodeURIComponent(doc.documentId)}`, 'u-owner')).body as Doc;
    expect(kept).toMatchObject({ content: doc.content, templateVersion: 1, figures: { totalMinor: 20000 } });
  });

  it('a goods receipt is issued under its own number with what arrived at cost, and only by someone who holds its store', async () => {
    const h = harness(); const t = randomUUID(); const s = await shop(h, t);
    expect((await s.order('po-1')).status).toBe(201);
    await s.approve('po-1');
    const grn = await s.receive('grn-1', 'po-1', 'S-A', 10);
    expect(grn.status).toBe(201);
    const grnNumber = (grn.body as { grn?: { number: string }; number?: string }).grn?.number ?? (grn.body as { number: string }).number;

    // A manager who runs store B cannot issue store A's paperwork.
    const outside = await s.issue('grn', { source: { type: 'goods_receipt', id: 'grn-1' } }, 'i-grn-b', 'u-mgr-b', 'S-B');
    expect(outside.status).toBe(403);
    expect(codeOf(outside)).toBe('outside_your_branch_scope');

    const res = await s.issue('grn', { source: { type: 'goods_receipt', id: 'grn-1' } }, 'i-grn');
    expect(res.status).toBe(201);
    const doc = res.body as Doc;
    expect(doc.source).toMatchObject({ type: 'goods_receipt', id: 'grn-1', number: grnNumber, numberAllocated: false });
    expect(doc.figures).toMatchObject({ totalMinor: 20000, taxMinor: null, lines: [{ productId: 'p1', quantityMinor: 10 }] });
    expect(doc.content).toContain(`GOODS RECEIVED ${grnNumber} against po-1`);
  });

  it('a sale becomes a tax invoice with the GST its line was sold at — a sale that never said its rate is refused, not guessed', async () => {
    const h = harness(); const t = randomUUID(); const s = await shop(h, t);
    expect((await s.sell('sale-1')).status).toBe(202);
    const res = await s.issue('inv', { source: { type: 'sale', id: 'sale-1' } }, 'i-inv');
    expect(res.status).toBe(201);
    const doc = res.body as Doc;
    expect(doc.kind).toBe('tax_invoice');
    expect(doc.source).toMatchObject({ type: 'sale', number: 'R-sale-1', numberAllocated: false });
    expect(doc.figures).toMatchObject({ totalMinor: 11800, taxMinor: 1800, lines: [{ lineTotalMinor: 11800, taxMinor: 1800 }] });
    expect(doc.content).toBe('TAX INVOICE R-sale-1: p1 1 each @ Rs 118.00 = Rs 118.00 (GST 18%: Rs 18.00) — taxable Rs 100.00, GST Rs 18.00, total Rs 118.00');

    expect((await s.sell('sale-2', false)).status).toBe(202);
    const unrated = await s.issue('inv', { source: { type: 'sale', id: 'sale-2' } }, 'i-inv-2');
    expect(unrated.status).toBe(422);
    expect(codeOf(unrated)).toBe('document_source_incomplete');
    expect(codeOf(await s.issue('inv', { source: { type: 'sale', id: 'sale-none' } }, 'i-inv-3'))).toBe('document_source_not_found');
  });

  it('a statement has no number of its own: one is allocated from the gap-free series, once — and only company-wide staff may issue it', async () => {
    const h = harness(); const t = randomUUID(); const s = await shop(h, t);
    expect((await s.order('po-1')).status).toBe(201);
    await s.approve('po-1');
    expect((await s.call('POST', '/v1/purchase/orders/po-2', 'u-buyer', { supplierId: 'sup-2', deliverToLocationId: 'S-A', lines: [{ productId: 'p1', orderedQty: 1, unitCost: cost }] }, 'po-po-2')).status).toBe(201);

    const first = await s.issue('stm', { source: { type: 'supplier_statement', id: 'sup-1' } }, 'i-stm-1');
    expect(first.status).toBe(201);
    expect((first.body as Doc).source).toMatchObject({ number: 'SST-000001', numberAllocated: true });
    expect((first.body as Doc).figures.amounts).toMatchObject({ owedMinor: 0 });
    // The same statement again today: the same document, and no number used up.
    const again = await s.issue('stm', { source: { type: 'supplier_statement', id: 'sup-1' } }, 'i-stm-1b');
    expect(again.status).toBe(200);
    expect((again.body as Doc).source.number).toBe('SST-000001');
    expect(((await s.issue('stm', { source: { type: 'supplier_statement', id: 'sup-2' } }, 'i-stm-2')).body as Doc).source.number).toBe('SST-000002');
    expect(codeOf(await s.issue('stm', { source: { type: 'supplier_statement', id: 'sup-unknown' } }, 'i-stm-x'))).toBe('document_source_not_found');
    // A statement belongs to no single store: a branch-limited manager cannot issue it.
    expect(codeOf(await s.issue('stm', { source: { type: 'supplier_statement', id: 'sup-1' } }, 'i-stm-b', 'u-mgr-b', 'S-B'))).toBe('shop_wide_record_needs_company_scope');

    // A B2B customer's statement, aged as at the date asked, from the receivables on record.
    await b2bCollectionsAdapter({ store: h.store, now: () => new Date().toISOString() }).recordInvoice(t, 'cust-1', {
      invoiceId: 'b2b-inv-1', number: 'B2B-0001', customerId: 'cust-1', issuedOn: '2026-09-01', dueOn: '2026-09-30', grossMinor: 50000, settledMinor: 0,
    });
    const cst = await s.issue('stm', { source: { type: 'customer_statement', id: 'cust-1' }, asAt: '2026-10-10' }, 'i-cst');
    expect(cst.status).toBe(201);
    expect((cst.body as Doc).source).toMatchObject({ number: 'CST-000001', numberAllocated: true });
    expect((cst.body as Doc).figures).toMatchObject({ totalMinor: 50000, amounts: { outstandingMinor: 50000, overdueMinor: 50000 } });
    expect(codeOf(await s.issue('stm', { source: { type: 'customer_statement', id: 'cust-none' } }, 'i-cst-x'))).toBe('document_source_not_found');
  });

  it('a reprint is the same frozen document, numbered as a duplicate, and on the audit trail with who and why', async () => {
    const h = harness(); const t = randomUUID(); const s = await shop(h, t);
    expect((await s.sell('sale-1')).status).toBe(202);
    const doc = (await s.issue('inv', { source: { type: 'sale', id: 'sale-1' } }, 'i-inv')).body as Doc;
    const path = `/v1/documents/issued/${encodeURIComponent(doc.documentId)}/reprint`;

    expect(codeOf(await s.call('POST', path, 'u-owner', {}, 'rp-0'))).toBe('reprint_needs_a_reason');
    const one = await s.call('POST', path, 'u-owner', { reason: 'customer lost the original' }, 'rp-1');
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ copyNumber: 1, marking: 'DUPLICATE — copy 1 of R-sale-1', content: doc.content, templateVersion: doc.templateVersion, figures: { taxMinor: 1800 } });
    const two = await s.call('POST', path, 'u-owner', { reason: 'printer jammed' }, 'rp-2');
    expect(two.body).toMatchObject({ copyNumber: 2, content: doc.content });

    const read = (await s.call('GET', `/v1/documents/issued/${encodeURIComponent(doc.documentId)}`, 'u-owner')).body as { reprints: { copyNumber: number; reprintedBy: string; reason: string }[] };
    expect(read.reprints.map((r) => [r.copyNumber, r.reprintedBy, r.reason])).toEqual([[1, 'u-owner', 'customer lost the original'], [2, 'u-owner', 'printer jammed']]);
    const audited = (await auditTrailAdapter({ store: h.store }).records(t)).filter((r) => r.action === 'document.reprint');
    expect(audited.map((r) => [r.objectId, r.actorId, r.reason])).toEqual([[doc.documentId, 'u-owner', 'customer lost the original'], [doc.documentId, 'u-owner', 'printer jammed']]);
  });
});
