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
import { printLayout, type PrintView } from '../../packages/documents/src/print-view';
import type { ExportAudit } from '../../packages/export/src/export';

/**
 * **Batch 18b — head office's side of the Print buttons and the list download, in memory and on real PostgreSQL.**
 *
 *   • R1 / P1 / B2 (M31-FR-02 · WF-03): `GET /v1/documents/print/...` gives the A4 page everything it prints for an issued
 *     purchase order, a goods receipt and a supplier's statement — the shop's name and GSTIN (its branch and GST
 *     registration), the document's own number (format A), the date, the supplier's name and GSTIN, each line's item name,
 *     quantity, rate and GST rate (the rate in force for the item's tax class on the document's date), and the total. A
 *     proposed order is refused (a draft is never printed as the order); a missing record is 404; a manager of another
 *     store is refused; a person who cannot read orders is refused.
 *   • B1 (M30-FR-02 · hard rule #6): `POST /v1/exports/screen-lists` writes each list download to the SAME append-only
 *     export ledger every export writes (`GET /v1/exports`): who (always the caller), which list, how many rows, which
 *     columns were redacted, when it was downloaded; a replay is one record; a body in the wrong shape records nothing.
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

const SHOP_GSTIN = '33AABCS1429B1Z1';
const SUPPLIER_GSTIN = '33ZZZZZ9999Z1ZF';
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

async function shop(h: ApiHarness, t: string) {
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string, branchId?: string) =>
    h.request({ method, path, userId, tenantId: t, ...(branchId === undefined ? {} : { branchId }), ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }) });
  const ok = async (p: Promise<{ status: number; body: unknown }>, label: string) => { const r = await p; expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
  await h.seedOwner(t, 'u-owner');
  await h.provisionRole(t, 'u-po-buyer', 'store_manager');
  await h.provisionRole(t, 'u-buyer', 'store_manager');
  await h.provisionRole(t, 'u-acct', 'accountant');
  await h.provisionRole(t, 'u-cash', 'cashier');
  await h.provisionRole(t, 'u-mgr-b', 'store_manager', ['S-B']);
  await ok(call('POST', '/v1/org/nodes/C1', 'u-owner', { kind: 'company', name: 'SRE Hyper Market Private Limited' }, 'org-c1'), 'company');
  await ok(call('POST', `/v1/org/gst-registrations/${SHOP_GSTIN}`, 'u-owner', { companyId: 'C1', legalName: 'SRE Hyper Market Private Limited' }, 'gst'), 'GST registration');
  await ok(call('POST', '/v1/org/nodes/S-A', 'u-owner', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1', gstin: SHOP_GSTIN, placeOfBusiness: '12 Main Road, Tiruppur 641601, Tamil Nadu' }, 'org-sa'), 'store A');
  await ok(call('POST', '/v1/org/nodes/S-B', 'u-owner', { kind: 'branch', name: 'Store B', parentId: 'C1', companyId: 'C1' }, 'org-sb'), 'store B');
  await ok(call('POST', '/v1/purchase/suppliers/sup-1', 'u-buyer', { name: 'Kaveri Traders', gstin: SUPPLIER_GSTIN }, 'sup-1'), 'supplier');
  await ok(call('POST', '/v1/purchase/suppliers/sup-1/approval', 'u-acct', { reason: 'documents checked' }, 'sup-1-ok'), 'supplier approved');
  await ok(call('POST', '/v1/catalogue/tax-classes/1006/rates/2017-07-01', 'u-owner', { rateBps: 500 }, 'tax'), 'tax rate');
  for (const [id, name, uom] of [['p-rice', 'Ponni rice', 'kg'], ['p-soap', 'Bath soap 100g', 'ea']] as const) {
    await ok(call('POST', `/v1/catalogue/products/${id}/publish`, 'u-owner', { product: { sku: `SKU-${id}`, name, baseUom: uom, primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active' }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }, `pub-${id}`), `publish ${id}`);
  }
  await ok(call('POST', '/v1/inventory/receipt-policy', 'u-owner', { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 }, 'pol'), 'receipt policy');
  return { call, ok };
}

describe.each(backings)('batch 18b — print views and list-download records — on $name', ({ harness }) => {
  it('P1: an issued purchase order prints with the shop and supplier GSTINs, its PO number, each item named with its rate and GST rate, and the total; a draft is refused', async () => {
    const h = harness(); const t = randomUUID(); const s = await shop(h, t);
    const proposed = await s.ok(s.call('POST', '/v1/purchase/orders/po-1', 'u-po-buyer', { supplierId: 'sup-1', deliverToLocationId: 'S-A', lines: [
      { productId: 'p-rice', orderedQty: 25_000, uom: 'kg', unitCost: { minor: 6_000, currency: 'INR' } },
      { productId: 'p-soap', orderedQty: 12, unitCost: { minor: 4_000, currency: 'INR' } },
    ] }, 'po-1', 'S-A'), 'propose');
    const number = (proposed.body as { order: { documentNumber?: string; number: string } }).order;

    const draft = await s.call('GET', '/v1/documents/print/purchase-orders/po-1', 'u-owner');
    expect(draft.status).toBe(409);
    expect(codeOf(draft)).toBe('print_source_not_final');
    expect((await s.call('GET', '/v1/documents/print/purchase-orders/po-nope', 'u-owner')).status).toBe(404);

    await s.ok(s.call('POST', '/v1/purchase/orders/po-1/approval', 'u-owner', { reason: 'weekly order' }, 'po-1-ok'), 'issue');
    const got = await s.call('GET', '/v1/documents/print/purchase-orders/po-1', 'u-owner');
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    const view = (got.body as { view: PrintView }).view;
    expect(view.kind).toBe('purchase_order');
    expect(view.documentNumber).toMatch(/^PO\/\d{2}-\d{2}\/\d{5}$/);
    expect(view.documentNumber).toBe(number.documentNumber ?? number.number);
    expect(view.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(view.shop).toMatchObject({ name: 'SRE Hyper Market', legalName: 'SRE Hyper Market Private Limited', gstin: SHOP_GSTIN });
    expect(view.supplier).toMatchObject({ id: 'sup-1', name: 'Kaveri Traders', gstin: SUPPLIER_GSTIN });
    expect(view.lines).toEqual([
      { productId: 'p-rice', name: 'Ponni rice', hsn: '1006', quantityMinor: 25_000, uom: 'kg', rateMinor: 6_000, ratePer: 1, gstRateBps: 500, valueMinor: 150_000 },
      { productId: 'p-soap', name: 'Bath soap 100g', hsn: '1006', quantityMinor: 12, uom: 'ea', rateMinor: 4_000, ratePer: 1, gstRateBps: 500, valueMinor: 48_000 },
    ]);
    expect(view.totalMinor).toBe(198_000);

    // The page's words: the number, both GSTINs, the item with its quantity, rate and GST, the total, the three signatures.
    const page = printLayout(view, 'en');
    expect(page.title).toBe('Purchase order');
    expect(page.head[0]).toEqual({ label: 'Number', value: view.documentNumber });
    expect(page.parties.map((p) => p.lines.at(-1))).toEqual([`GSTIN: ${SHOP_GSTIN}`, `GSTIN: ${SUPPLIER_GSTIN}`]);
    expect(page.table.rows[0]).toEqual(['1', 'Ponni rice (p-rice)', '1006', '25.000 kg', '60.00 per kg', '5%', '1,500.00']);
    expect(page.totals.at(-1)).toEqual({ label: 'Total value at these rates', value: '₹1,980.00', strong: true });
    expect(page.signatures).toEqual(['Prepared by', 'Approved by', 'Supplier\'s acknowledgement']);

    // Who may read it: a cashier does not read orders; a manager of another store does not hold store A.
    expect((await s.call('GET', '/v1/documents/print/purchase-orders/po-1', 'u-cash')).status).toBe(403);
    expect((await s.call('GET', '/v1/documents/print/purchase-orders/po-1', 'u-mgr-b', undefined, undefined, 'S-B')).status).toBe(403);
  });

  it('R1: a goods receipt prints with its GRN number, the order it was against, what arrived at its rate and GST rate; B2: the supplier statement prints its account', async () => {
    const h = harness(); const t = randomUUID(); const s = await shop(h, t);
    await s.ok(s.call('POST', '/v1/purchase/orders/po-2', 'u-po-buyer', { supplierId: 'sup-1', deliverToLocationId: 'S-A', lines: [{ productId: 'p-soap', orderedQty: 10, unitCost: { minor: 2_000, currency: 'INR' } }] }, 'po-2', 'S-A'), 'propose');
    await s.ok(s.call('POST', '/v1/purchase/orders/po-2/approval', 'u-owner', { reason: 'ok' }, 'po-2-ok'), 'issue');
    const grn = await s.ok(s.call('POST', '/v1/inventory/goods-receipt/grn-1', 'u-buyer', {
      warehouseId: 'S-A', receivedOnDate: '2026-11-10', currency: 'INR', poId: 'po-2',
      lines: [{ lineId: 'L1', productId: 'p-soap', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: { minor: 2_000, currency: 'INR' }, condition: 'good' }],
    }, 'grn-1'), 'receive');
    void grn;
    const got = await s.call('GET', '/v1/documents/print/goods-receipts/grn-1', 'u-owner');
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    const view = (got.body as { view: PrintView }).view;
    expect(view.kind).toBe('goods_receipt');
    expect(view.documentNumber).toMatch(/^GRN1\/\d{2}-\d{2}\/\d{5}$/);
    expect(view.shop.gstin).toBe(SHOP_GSTIN);
    expect(view.supplier).toMatchObject({ name: 'Kaveri Traders', gstin: SUPPLIER_GSTIN });
    expect(view.facts.find((f) => f.key === 'purchaseOrder')?.value).toMatch(/^PO\/\d{2}-\d{2}\/\d{5}$/);
    expect(view.lines).toEqual([{ productId: 'p-soap', name: 'Bath soap 100g', hsn: '1006', quantityMinor: 10, uom: 'ea', rateMinor: 2_000, ratePer: 1, gstRateBps: 500, valueMinor: 20_000 }]);
    expect(view.totalMinor).toBe(20_000);
    const page = printLayout(view, 'ta');
    expect(page.title).toBe('சரக்கு பெறுதல் குறிப்பு (GRN)');
    expect(page.signatures).toHaveLength(3);
    expect((await s.call('GET', '/v1/documents/print/goods-receipts/grn-nope', 'u-owner')).status).toBe(404);
    expect((await s.call('GET', '/v1/documents/print/goods-receipts/grn-1', 'u-cash')).status).toBe(403);

    const stmt = await s.call('GET', '/v1/documents/print/supplier-statements/sup-1', 'u-owner');
    expect(stmt.status, JSON.stringify(stmt.body)).toBe(200);
    const sv = (stmt.body as { view: PrintView }).view;
    expect(sv).toMatchObject({ kind: 'supplier_statement', documentNumber: null, supplier: { name: 'Kaveri Traders', gstin: SUPPLIER_GSTIN } });
    expect(sv.statement).toBeDefined();
    expect(printLayout(sv, 'en').totals.at(-1)?.label).toBe('Owed to the supplier');
    expect((await s.call('GET', '/v1/documents/print/supplier-statements/sup-nobody', 'u-owner')).status).toBe(404);
  });

  it('B1: a list download is one record in the export ledger, under the caller\'s own name, with what was redacted; a replay is the same record; a bad body records nothing', async () => {
    const h = harness(); const t = randomUUID(); const s = await shop(h, t);
    const body = { screen: '/customers/', list: 'customers', label: 'Customers', rowCount: 42, columns: ['Customer', 'Name', 'Segment'], redactedColumns: ['Customer', 'Name'], downloadedAt: '2026-11-19T06:30:00.000Z' };
    // A name in the body is not who downloaded: the record is always the caller's own.
    const first = await s.call('POST', '/v1/exports/screen-lists', 'u-cash', { ...body, userId: 'u-owner' }, 'dl-1');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const again = await s.call('POST', '/v1/exports/screen-lists', 'u-cash', { ...body, userId: 'u-owner' }, 'dl-1');
    expect(again.status).toBe(201);
    expect((await s.call('POST', '/v1/exports/screen-lists', 'u-cash', { ...body, rowCount: -1 }, 'dl-bad')).status).toBe(400);
    expect((await s.call('POST', '/v1/exports/screen-lists', 'u-cash', { screen: '/x/' }, 'dl-bad-2')).status).toBe(400);
    const ledger = await s.call('GET', '/v1/exports', 'u-owner');
    expect(ledger.status).toBe(200);
    const mine = (ledger.body as { exports: ExportAudit[] }).exports.filter((e) => e.domain.startsWith('screen-list:'));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      userId: 'u-cash', domain: 'screen-list:/customers/#customers', rowCount: 42, redactedColumns: ['Customer', 'Name'],
      screenList: { screen: '/customers/', list: 'customers', label: 'Customers', columns: ['Customer', 'Name', 'Segment'], downloadedAt: '2026-11-19T06:30:00.000Z' },
    });
  });
});
