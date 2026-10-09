import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedRequestId } from '../support/approval-request';
import { productMasterAdapter, supplierMasterAdapter, STREAM_FOR } from '../../services/api/src/adapters';
import type { SupplierInvoiceRecord } from '../../services/purchase/src/index';
import type { ProductRecord } from '../../packages/product/src/index';

/**
 * **SF-06-a — an approved invoice file becomes REAL supplier invoices, in one save with its job record, and can be undone
 * (Wave 4 · OB-23 "C" · M30-FR-01/03/04 · M07 · §28 · hard rules #2 #6 #10).**
 *
 * The audit reproduced it: a manager loaded one product row, the import answered "committed, 1 row applied", and the
 * product master held nothing — the import kept a job record and changed no real record, with its template, its reference
 * lists and its "already exists" list all supplied by the caller. Real API, real per-tenant permissions, head office's
 * maker-checker engine:
 *   • a template head office does not support is refused by name, and a body bringing its own reference lists is refused;
 *   • an 85-line invoice and a 2-line invoice in one file are checked against head office's OWN products, suppliers and
 *     invoices, approved by a second person, and land as captured supplier invoices — read back on the invoice register,
 *     matched against the stored order — in the same atomic save as the job's record;
 *   • every target rule is a row error by line, and a file with any error writes nothing;
 *   • a rollback approved by a second person withdraws the invoices (compensating records — the capture stays as evidence),
 *     is refused once anything downstream uses them, and a withdrawn invoice id is never reused.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const post = (h: ApiHarness, path: string, userId: string, body: unknown, key = `k-${Math.random()}`) => h.request({ method: 'POST', path, userId, tenantId: A, idempotencyKey: key, body });
const get = (h: ApiHarness, path: string, userId = 'u-owner') => h.request({ method: 'GET', path, userId, tenantId: A });

const HEADER = 'invoiceId,supplierId,poId,line,productId,quantity,unitPriceMinor,lineTotalMinor,invoiceTotalMinor';
interface Line { readonly line: number; readonly productId: string; readonly quantity: number; readonly unitPriceMinor: number; readonly lineTotalMinor?: number }
/** One invoice as a billing program exports it: the header repeated on every line. */
function invoiceRows(invoiceId: string, supplierId: string, poId: string, lines: readonly Line[], invoiceTotalMinor?: number): string[] {
  const total = invoiceTotalMinor ?? lines.reduce((s, l) => s + (l.lineTotalMinor ?? l.quantity * l.unitPriceMinor), 0);
  return lines.map((l) => [invoiceId, supplierId, poId, l.line, l.productId, l.quantity, l.unitPriceMinor, l.lineTotalMinor ?? l.quantity * l.unitPriceMinor, total].join(','));
}
const file = (...invoices: string[][]): string => [HEADER, ...invoices.flat()].join('\n');
const totalOf = (text: string): number => text.split('\n').slice(1).reduce((s, r) => s + Number(r.split(',')[7]), 0);

/** 85 lines of synthetic stock (P-001 … P-085), 2 of each at ₹1.00 × line number. */
const BIG: Line[] = Array.from({ length: 85 }, (_, i) => ({ line: i + 1, productId: `P-${String(i + 1).padStart(3, '0')}`, quantity: 2, unitPriceMinor: 100 * (i + 1) }));
const SMALL: Line[] = [{ line: 1, productId: 'P-001', quantity: 10, unitPriceMinor: 500 }, { line: 2, productId: 'P-002', quantity: 4, unitPriceMinor: 1000 }];

async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager');  // uploads
  await h.provisionRole(A, 'u-mgr2', 'store_manager'); // the second person
  await h.provisionRole(A, 'u-book', 'accountant');    // reads only
  const now = () => '2026-10-09T09:00:00.000Z';
  const products = productMasterAdapter({ store: h.store, now });
  for (const l of BIG) {
    await products.publish(A, { productId: l.productId, tenantId: A, sku: l.productId, name: `Item ${l.line}`, baseUom: 'ea', primaryCategoryId: 'c-1', taxClass: 'GST5', lifecycle: 'active' } as ProductRecord, `seed-${l.productId}`);
  }
  await supplierMasterAdapter({ store: h.store, now }).recordSupplier(A, {
    supplierId: 'S-1', name: 'Synthetic Wholesale', gstin: null, phone: null, email: null, address: null, paymentTermsDays: 30, documents: [],
    status: 'active', createdBy: 'u-owner', createdAt: now(), updatedBy: 'u-owner', updatedAt: now(), approvedBy: 'u-mgr', approvedAt: now(), possibleDuplicates: [], version: 1,
  });
  // An issued order for the small invoice, so it can be matched.
  expect((await post(h, '/v1/purchase/orders/PO-7', 'u-mgr', { supplierId: 'S-1', lines: [{ productId: 'P-001', orderedQty: 10, unitCost: { minor: 500, currency: 'INR' } }, { productId: 'P-002', orderedQty: 4, unitCost: { minor: 1000, currency: 'INR' } }] }, 'po-7')).status).toBe(201);
  expect((await post(h, '/v1/purchase/orders/PO-7/approval', 'u-owner', { reason: 'fixture' }, 'po-7-ok')).status).toBe(200);
  return h;
}

const validate = (h: ApiHarness, text: string, declaredTotalMinor?: number, extra: Record<string, unknown> = {}, userId = 'u-mgr') =>
  post(h, '/v1/import/validate', userId, { templateId: 'supplier-invoice-v1', text, ...(declaredTotalMinor === undefined ? {} : { declaredTotalMinor }), ...extra });

/** Uploader checks, asks, the second person approves in their own session, the uploader loads it. */
async function load(h: ApiHarness, jobId: string, text: string, declaredTotalMinor: number) {
  const v = await validate(h, text, declaredTotalMinor);
  expect(v.status).toBe(200);
  const contentFingerprint = (v.body as { contentFingerprint: string }).contentFingerprint;
  const approvalId = await approvedRequestId(h, A, 'u-mgr', 'u-mgr2', { kind: 'data_import_commit', subjectRef: jobId, details: { jobId, contentFingerprint } });
  return post(h, '/v1/import/commit', 'u-mgr', { jobId, templateId: 'supplier-invoice-v1', text, declaredTotalMinor, approvalId });
}
const invoiceOnRecord = async (h: ApiHarness, invoiceId: string) => {
  const res = await get(h, `/v1/purchase/invoices/${invoiceId}`);
  return res.status === 200 ? (res.body as { invoice: SupplierInvoiceRecord }).invoice : undefined;
};

describe('SF-06-a — an invoice file is loaded into the real invoice register, and can be undone', () => {
  it('THE AUDIT\'S CASE: a template head office does not support is refused — nothing is "applied" that has no target', async () => {
    const h = await seeded();
    const product = { id: 'product-v1', domain: 'product', columns: [{ name: 'sku', type: 'text', required: true }], keyColumns: ['sku'] };
    const v = await post(h, '/v1/import/validate', 'u-mgr', { template: product, text: 'sku\nGHOST-1' });
    expect(v.status).toBe(422);
    expect(codeOf(v)).toBe('import_template_not_supported');
    const c = await post(h, '/v1/import/commit', 'u-mgr', { jobId: 'J-ghost', template: product, text: 'sku\nGHOST-1', approvalId: 'whatever' });
    expect(codeOf(c)).toBe('import_template_not_supported');
    expect((await get(h, '/v1/import/commits')).body).toMatchObject({ total: 0 });
    // The caller's own "what exists" lists are refused by name — head office checks against its own registers.
    expect(codeOf(await validate(h, file(invoiceRows('INV-1', 'S-1', 'PO-7', SMALL)), 9000, { references: { product: ['ANY'] } }))).toBe('import_carries_caller_claims');
    // What head office supports is listed.
    expect(((await get(h, '/v1/import/templates', 'u-book')).body as { templates: { id: string }[] }).templates.map((t) => t.id)).toEqual(['supplier-invoice-v1']);
  });

  it('an 85-line invoice and a 2-line invoice in one file → approved by a second person → two REAL captured invoices, matched against the stored order, in one save with the job', async () => {
    const h = await seeded();
    const text = file(invoiceRows('INV-BIG', 'S-1', '', BIG), invoiceRows('INV-7', 'S-1', 'PO-7', SMALL));
    const declared = totalOf(text);
    const v = (await validate(h, text, declared)).body as { preview: { validCount: number; errors: unknown[]; reconciles: boolean; commitReady: boolean } };
    expect(v.preview).toMatchObject({ validCount: 87, errors: [], reconciles: true, commitReady: true });

    const batches: number[] = [];
    const appendBatch = h.store.appendBatch.bind(h.store);
    h.store.appendBatch = (async (t, entries, o) => { batches.push(entries.length); return appendBatch(t, entries, o); }) as typeof h.store.appendBatch;
    const res = await load(h, 'J-1', text, declared);
    h.store.appendBatch = appendBatch;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ committed: true, rowsApplied: 87, effects: [{ kind: 'supplier_invoice', ref: 'INV-BIG' }, { kind: 'supplier_invoice', ref: 'INV-7', valueMinor: 9000 }] });
    expect(batches).toContain(3); // two invoices and the job's record — one atomic save

    const big = await invoiceOnRecord(h, 'INV-BIG');
    expect(big?.lines).toHaveLength(85);
    expect(big).toMatchObject({ supplierId: 'S-1', poId: null, capturedBy: 'u-mgr', approvedBy: 'u-mgr2', source: 'import/J-1', governanceFlags: ['no_purchase_order'] });
    const small = await invoiceOnRecord(h, 'INV-7');
    expect(small).toMatchObject({ poId: 'PO-7', totalMinor: 9000, declaredTotalMinor: 9000, governanceFlags: [] });
    // It goes on to the three-way match like any captured invoice.
    expect((await post(h, '/v1/purchase/invoices/INV-7/match', 'u-mgr2', {})).status).toBeLessThan(300);
    // And the job's record says what it wrote.
    expect(((await get(h, '/v1/import/commits/J-1')).body as { job: { effects: unknown[] } }).job.effects).toHaveLength(2);
  });

  it('every rule of the invoice register is a row error by line — and a file with any error writes NOTHING', async () => {
    const h = await seeded();
    const text = file(
      invoiceRows('INV-A', 'S-1', '', [{ line: 1, productId: 'P-001', quantity: 2, unitPriceMinor: 100 }, { line: 2, productId: 'NOT-A-PRODUCT', quantity: 1, unitPriceMinor: 100 }]),
      invoiceRows('INV-B', 'S-NOBODY', '', [{ line: 1, productId: 'P-002', quantity: 3, unitPriceMinor: 100, lineTotalMinor: 301 }]),
      invoiceRows('INV-C', 'S-1', '', [{ line: 1, productId: 'P-003', quantity: 1, unitPriceMinor: 100 }], 999),
    );
    const v = (await validate(h, text)).body as { preview: { errors: { line: number; column: string; message: string }[]; commitReady: boolean } };
    const said = v.preview.errors.map((e) => `${e.line}:${e.column}`);
    expect(said).toEqual(expect.arrayContaining([
      '1:declared total',          // a financial file needs its declared total
      '3:productId',               // not in head office's product master
      '4:supplierId',              // not in head office's supplier master
      '4:lineTotalMinor',          // 3 × 100 is not 301
      '5:invoiceTotalMinor',       // the lines do not add up to what the invoice says
    ]));
    expect(v.preview.commitReady).toBe(false);
    const res = await post(h, '/v1/import/commit', 'u-mgr', { jobId: 'J-bad', templateId: 'supplier-invoice-v1', text, declaredTotalMinor: 1, approvalId: 'x' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await invoiceOnRecord(h, 'INV-A')).toBeUndefined();
    expect((await get(h, '/v1/import/commits')).body).toMatchObject({ total: 0 });
  });

  it('the same bill is never loaded twice — not by a second file, and not by the capture screen', async () => {
    const h = await seeded();
    const text = file(invoiceRows('INV-7', 'S-1', 'PO-7', SMALL));
    expect((await load(h, 'J-1', text, 9000)).status).toBe(200);
    const again = (await validate(h, text, 9000)).body as { preview: { errors: { column: string; message: string }[] } };
    expect(again.preview.errors.map((e) => e.column)).toEqual(['invoiceId', 'invoiceId']);
    expect(again.preview.errors[0]!.message).toMatch(/already at head office/);
  });

  it('ROLLBACK: a second person approves it → the invoices are withdrawn (kept as evidence), the job says so, the id is never reused; refused once an invoice is matched', async () => {
    const h = await seeded();
    expect((await load(h, 'J-1', file(invoiceRows('INV-BIG', 'S-1', '', BIG.slice(0, 3))), 1200)).status).toBe(200);
    expect((await load(h, 'J-2', file(invoiceRows('INV-7', 'S-1', 'PO-7', SMALL)), 9000)).status).toBe(200);

    // No approval, no rollback; a reason is needed.
    expect(codeOf(await post(h, '/v1/import/commits/J-1/rollback', 'u-mgr', { reason: 'wrong file' }))).toBe('no_approval');
    const approvalId = await approvedRequestId(h, A, 'u-mgr', 'u-mgr2', { kind: 'data_import_rollback', subjectRef: 'J-1', details: { jobId: 'J-1' } });
    const undo = await post(h, '/v1/import/commits/J-1/rollback', 'u-mgr', { reason: 'wrong file', approvalId });
    expect(undo.status).toBe(200);
    expect(await invoiceOnRecord(h, 'INV-BIG')).toBeUndefined();
    const listed = JSON.stringify((await get(h, '/v1/purchase/invoices')).body);
    expect(listed).toContain('INV-7');
    expect(listed).not.toContain('INV-BIG');
    // The capture is still on the register's stream — withdrawn, never deleted (hard rule #6).
    expect((await h.store.readStream(A, STREAM_FOR.supplierInvoices, {})).map((e) => e.event.type)).toEqual(expect.arrayContaining(['SupplierInvoiceCaptured', 'SupplierInvoiceWithdrawn']));
    expect(((await get(h, '/v1/import/commits')).body as { jobs: { jobId: string; rolledBack?: { approvedBy: string } }[] }).jobs.find((j) => j.jobId === 'J-1')).toMatchObject({ rolledBack: { approvedBy: 'u-mgr2' } });
    expect(codeOf(await post(h, '/v1/import/commits/J-1/rollback', 'u-mgr', { reason: 'again', approvalId }))).toBe('import_already_rolled_back');
    // A withdrawn invoice id is not used again — by a file, or by the capture screen.
    expect(((await validate(h, file(invoiceRows('INV-BIG', 'S-1', '', BIG.slice(0, 3))), 1200)).body as { preview: { commitReady: boolean } }).preview.commitReady).toBe(false);
    expect(codeOf(await post(h, '/v1/purchase/invoices/INV-BIG/capture', 'u-mgr', { supplierId: 'S-1', declaredTotalMinor: 200, lines: [{ productId: 'P-001', quantity: 2, unitPriceMinor: 100, lineTotalMinor: 200 }] }))).toBe('invoice_id_withdrawn');

    // Once matched, an invoice is in use: the load cannot be undone, and nothing changes.
    expect((await post(h, '/v1/purchase/invoices/INV-7/match', 'u-mgr2', {})).status).toBeLessThan(300);
    const approval2 = await approvedRequestId(h, A, 'u-mgr', 'u-mgr2', { kind: 'data_import_rollback', subjectRef: 'J-2', details: { jobId: 'J-2' } });
    const blocked = await post(h, '/v1/import/commits/J-2/rollback', 'u-mgr', { reason: 'late', approvalId: approval2 });
    expect(blocked.status).toBe(409);
    expect(codeOf(blocked)).toBe('import_effect_in_use');
    expect(await invoiceOnRecord(h, 'INV-7')).toBeDefined();
  });

  it('the uploader may not approve their own rollback (§28)', async () => {
    const h = await seeded();
    expect((await load(h, 'J-1', file(invoiceRows('INV-7', 'S-1', 'PO-7', SMALL)), 9000)).status).toBe(200);
    await expect(approvedRequestId(h, A, 'u-mgr', 'u-mgr', { kind: 'data_import_rollback', subjectRef: 'J-1', details: { jobId: 'J-1' } })).rejects.toThrow();
    expect(await invoiceOnRecord(h, 'INV-7')).toBeDefined();
  });
});
