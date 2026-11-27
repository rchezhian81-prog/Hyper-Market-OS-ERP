import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { useBackings } from '../support/backings';
import { approvedSuppliers, SUPPLIER_MAKER } from '../support/approved-supplier';
import { askForApproval, decide } from '../support/approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';
import { printLayout, type PrintView } from '../../packages/documents/src/print-view';

/**
 * **Pending list 27 Nov — item 5: the RETURN-TO-SUPPLIER NOTE, head office's side — on the in-memory event store and, with
 * DATABASE_URL, on real PostgreSQL** (S1 of batch 18c · M10-FR-01 · M31-FR-02 · OB-874 C · OB-879).
 *
 * `GET /v1/documents/print/supplier-returns/:returnId` gives the A4 page everything it prints for a REAL return made through
 * `POST /v1/inventory/shelf-returns/:returnId`: its RTS number and date, the shop and supplier with GSTINs, the SDN debit
 * note's number, the line with its batch and the batch's expiry, the rate and value at the stock's own cost, the item's
 * GST rate, why, who returned it, who approved it, the e-way bill number when one applies, and where the debit note stands
 * (waiting, then "supplier accepted, credit note …" once the accountant records it). It is a READ: printing changes no
 * stock and nothing on the supplier's account. A return that does not exist is 404; a person who cannot read a supplier's
 * account (a cashier) is refused; a manager of another store is refused.
 */

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const TN_SHOP = '33AAACS1111A1ZH';
const TN_SUPPLIER = '33AAACS1111A2ZG';

describe.each(useBackings())('pending 5: a return-to-supplier note prints from head office — on $name', ({ harness }) => {
  it('reads a real return: numbers, parties, batch and expiry, why, who, approval, e-way bill, status — and changes nothing', async () => {
    const h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-acct', 'accountant');
    await h.provisionRole(T, 'u-cash', 'cashier');
    await h.provisionRole(T, 'u-mgr-b', 'store_manager', ['S-B']);
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-mgr', query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, label: string): Promise<Res> => { const r = await p; expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    // The shop: its company, GST registration, and store-1 under it with that GSTIN and its address; a second store S-B.
    await ok(req('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Hyper Market Private Limited' }, 'u-owner'), 'company');
    await ok(req('POST', `/v1/org/gst-registrations/${TN_SHOP}`, { companyId: 'C1', legalName: 'SRE Hyper Market Private Limited' }, 'u-owner'), 'registration');
    await ok(req('POST', '/v1/org/nodes/store-1', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1', gstin: TN_SHOP, placeOfBusiness: '12 Main Road, Tiruppur 641601, Tamil Nadu' }, 'u-owner'), 'store-1');
    await ok(req('POST', '/v1/org/nodes/S-B', { kind: 'branch', name: 'Store B', parentId: 'C1', companyId: 'C1' }, 'u-owner'), 'S-B');
    await approvedSuppliers(h, T, 'sup-1');
    // The supplier's GSTIN on its record (the e-way bill's route is between the two GST states).
    await ok(req('POST', '/v1/purchase/suppliers/sup-1', { name: 'Kaveri Traders', gstin: TN_SUPPLIER }, SUPPLIER_MAKER), 'supplier GSTIN');
    await ok(req('POST', '/v1/catalogue/tax-classes/1512/rates/2017-07-01', { rateBps: 500 }, 'u-owner'), 'tax rate');
    for (const [id, name] of [['OIL', 'Sunflower oil 1L'], ['GHEE', 'Ghee 1L']] as const) {
      await ok(req('POST', `/v1/catalogue/products/${id}/publish`, { product: { sku: `SKU-${id}`, name, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1512', lifecycle: 'active' }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }, 'u-owner'), `publish ${id}`);
    }
    // Oil in batch B-OLD (expiring 15 Nov 2026) at ₹150; ghee at ₹150.
    await ok(req('POST', '/v1/inventory/movements', { movementId: 'rx-oil', productId: 'OIL', locationId: 'store-1', kind: 'received', quantityMinor: 120, uom: 'ea', occurredAt: '2026-11-01T09:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 15_000, batchId: 'B-OLD', expiry: '2026-11-15' }, 'u-owner'), 'oil');
    await ok(req('POST', '/v1/inventory/movements', { movementId: 'rx-ghee', productId: 'GHEE', locationId: 'store-1', kind: 'received', quantityMinor: 500, uom: 'ea', occurredAt: '2026-11-01T09:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 15_000 }, 'u-owner'), 'ghee');

    // A ₹900 return, approved by a second person (the owner) — the same approval as a write-off of that value.
    const big = { productId: 'OIL', locationId: 'store-1', qty: 6, uom: 'ea', supplierId: 'sup-1', reason: 'damaged', batchId: 'B-OLD', note: 'pouches torn' };
    const asked = await askForApproval(h, T, 'u-mgr', { kind: 'stock_write_off', subjectRef: 'rts-d', details: actionDetails(big, { returnId: 'rts-d' }), valueMinor: 90_000, summary: 'Return 6 torn pouches' });
    const requestId = (asked.body as { requestId: string }).requestId;
    expect((await decide(h, T, 'u-owner', requestId, 'approved', 'torn, supplier agreed')).status).toBe(201);
    const made = await ok(req('POST', '/v1/inventory/shelf-returns/rts-d', { ...big, approvalId: requestId }), 'return');
    const rts = (made.body as { shelfReturn: { documentNumber: string; at: string; debitNote: { number: string } } }).shelfReturn;
    expect(rts.documentNumber).toMatch(/^RTS1\/\d\d-\d\d\/00001$/);

    const stockBefore = (await req('GET', '/v1/inventory/availability', undefined, 'u-owner', { productId: 'OIL' })).body;
    const accountBefore = (await req('GET', '/v1/purchase/suppliers/sup-1/account', undefined, 'u-acct')).body as { totals: unknown };

    // The store manager prints it.
    const got = await req('GET', '/v1/documents/print/supplier-returns/rts-d');
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    const view = (got.body as { view: PrintView }).view;
    expect(view).toMatchObject({
      kind: 'supplier_return', documentNumber: rts.documentNumber,
      shop: { name: 'SRE Hyper Market', legalName: 'SRE Hyper Market Private Limited', gstin: TN_SHOP, address: ['12 Main Road, Tiruppur 641601, Tamil Nadu'] },
      supplier: { id: 'sup-1', name: 'Kaveri Traders', gstin: TN_SUPPLIER },
      lines: [{ productId: 'OIL', name: 'Sunflower oil 1L', quantityMinor: 6, uom: 'ea', rateMinor: 15_000, ratePer: 1, gstRateBps: 500, valueMinor: 90_000, batchId: 'B-OLD', expiry: '2026-11-15' }],
      totalMinor: 90_000,
      supplierReturn: { debitNoteNumber: rts.debitNote.number, reason: 'damaged', note: 'pouches torn', returnedFrom: 'store-1', raisedBy: 'u-mgr', approvedBy: 'u-owner', ewbNo: null, valueSource: 'stock_cost', acceptance: null },
    });
    expect(view.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const page = printLayout(view, 'en');
    expect(page.title).toBe('Return to supplier');
    expect(page.facts.find((f) => f.label === 'Status')!.value).toMatch(/^Waiting for the supplier to accept/);
    expect(page.table.rows[0]![3]).toBe('B-OLD · expires 15/11/2026');

    // The accountant reads it too (who reads a supplier's account); a cashier cannot; another store's manager cannot.
    expect((await req('GET', '/v1/documents/print/supplier-returns/rts-d', undefined, 'u-acct')).status).toBe(200);
    expect((await req('GET', '/v1/documents/print/supplier-returns/rts-d', undefined, 'u-cash')).status).toBe(403);
    expect((await req('GET', '/v1/documents/print/supplier-returns/rts-d', undefined, 'u-mgr-b')).status).toBe(403);
    const none = await req('GET', '/v1/documents/print/supplier-returns/rts-nothing');
    expect([none.status, codeOf(none)]).toEqual([404, 'print_source_not_found']);

    // Printing changed nothing: the stock and the supplier's account read the same.
    expect((await req('GET', '/v1/inventory/availability', undefined, 'u-owner', { productId: 'OIL' })).body).toEqual(stockBefore);
    expect(((await req('GET', '/v1/purchase/suppliers/sup-1/account', undefined, 'u-acct')).body as { totals: unknown }).totals).toEqual(accountBefore.totals);

    // The supplier accepts it: the note now says so, with the credit note, what came off, what did not and why, and the GST.
    await ok(req('POST', '/v1/purchase/suppliers/sup-1/shelf-return-debit-notes/DN-RTS-rts-d/accept', { supplierCreditNoteNo: 'CN-77', supplierCreditNoteDate: '2026-11-18', acceptedMinor: 75_000, reason: 'one pouch was not his', cgstMinor: 1_875, sgstMinor: 1_875 }, 'u-acct'), 'accepted');
    const after = (await req('GET', '/v1/documents/print/supplier-returns/rts-d')).body as { view: PrintView };
    expect(after.view.supplierReturn!.acceptance).toEqual({ creditNoteNo: 'CN-77', creditNoteDate: '2026-11-18', acceptedMinor: 75_000, differenceMinor: 15_000, reason: 'one pouch was not his', gst: { cgstMinor: 1_875, sgstMinor: 1_875, igstMinor: 0 } });
    expect(printLayout(after.view, 'en').facts.find((f) => f.label === 'Status')!.value).toBe(
      'Supplier accepted, credit note CN-77 dated 18/11/2026 — ₹750.00 taken off what is owed; ₹150.00 not accepted (one pouch was not his); GST on the supplier\'s credit note ₹37.50',
    );

    // Above the e-way-bill limit: the return leaves under a generated e-way bill, and the note prints its number.
    const ghee = { productId: 'GHEE', locationId: 'store-1', qty: 400, uom: 'ea', supplierId: 'sup-1', reason: 'near_expiry' };
    const gheeAsk = await askForApproval(h, T, 'u-mgr', { kind: 'stock_write_off', subjectRef: 'rts-e', details: actionDetails(ghee, { returnId: 'rts-e' }), valueMinor: 6_000_000 });
    const gheeId = (gheeAsk.body as { requestId: string }).requestId;
    expect((await decide(h, T, 'u-owner', gheeId)).status).toBe(201);
    const movement = 'shelf-return-rts-e';
    await ok(req('POST', `/v1/finance/e-way-bill/movements/${movement}/submit`, { request: { supplierGstin: TN_SHOP, recipientGstin: TN_SUPPLIER, documentType: 'CHL', documentNumber: 'RTS-rts-e', documentDate: '2026-11-20', hsnCode: '1512', consignmentValueMinor: 6_000_000, supplyRoute: 'intra_state', movementReason: 'supplier_return', fromPincode: '641601', toPincode: '641001' } }, 'u-owner'), 'ewb submit');
    await ok(req('POST', `/v1/finance/e-way-bill/movements/${movement}/record-response`, { result: { status: 'generated', ewbNo: '391000654321', ewbDate: '2026-11-20', validUpto: '2026-11-21' } }, 'u-owner'), 'ewb generated');
    await ok(req('POST', '/v1/inventory/shelf-returns/rts-e', { ...ghee, approvalId: gheeId }), 'ghee return');
    const gheeView = ((await req('GET', '/v1/documents/print/supplier-returns/rts-e')).body as { view: PrintView }).view;
    expect(gheeView.supplierReturn).toMatchObject({ ewbNo: '391000654321', approvedBy: 'u-owner', reason: 'near_expiry' });
    expect(gheeView.lines[0]).toMatchObject({ batchId: null, expiry: null, valueMinor: 6_000_000 });
    expect(printLayout(gheeView, 'en').facts).toContainEqual({ label: 'E-way bill', value: '391000654321' });
  }, 120_000);
});
