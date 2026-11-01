import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import { readInvoiceSubmission, readAsnSubmission, type SupplierOrdersFeed } from '../../apps/supplier-app/src/supplier-portal-session';

/**
 * **OB-624 (owner, 1 Nov 2026, in writing: "allow both"): the supplier portal's Invoice and Delivery note (ASN) forms, on
 * the real head office.** The documents the forms' tested readers build are exactly what head office takes on the
 * supplier's own submissions route; NOTHING counts until a buyer accepts it — the invoice is not on the supplier-invoice
 * register, the ASN not on the register the receiving compare reads — and once a buyer accepts each, it is, as sent.
 * A supplier never reviews its own; a buyer's rejection feeds nothing.
 */

const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

describe('the portal\'s invoice and delivery note reach head office and wait for a buyer', () => {
  it('sent as the forms build them; nothing counts until a buyer accepts; then the match and the compare read them', async () => {
    const h = apiHarness();
    const t = randomUUID();
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) =>
      h.request({ method, path, userId, tenantId: t, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }) });
    await h.seedOwner(t, 'u-owner');
    for (const u of ['u-buyer', 'u-recv']) await h.provisionRole(t, u, 'store_manager');
    await h.provisionRole(t, 'u-sup', 'supplier');
    await approvedSuppliers(h, t, 'sup-a');
    await deliveryPlaces(h, t, 'S1', 'S1-BACK');
    expect((await call('POST', '/v1/inventory/receipt-policy', 'u-owner', { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 })).status).toBe(201);
    expect((await call('POST', '/v1/catalogue/products/p-rice/publish', 'u-owner', {
      product: { sku: 'p-rice', name: 'Rice loose', baseUom: 'kg', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active', handling: 'ambient' },
      categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
    })).status).toBe(201);
    // 25 kg of loose rice at ₹48.00 a kg (OB-31: ordered in grams, priced per whole kg).
    expect((await call('POST', '/v1/purchase/orders/po-a', 'u-buyer', { supplierId: 'sup-a', deliverToLocationId: 'S1', lines: [{ productId: 'p-rice', orderedQty: 25_000, unitCost: { minor: 4_800, currency: 'INR' } }] })).status).toBe(201);
    expect((await call('POST', '/v1/purchase/orders/po-a/approval', 'u-owner', { reason: 'ok' })).status).toBe(200);
    expect((await call('POST', '/v1/supplier-portal/partners/sup-a', 'u-buyer', { grants: ['view_orders', 'submit_invoice', 'submit_asn'], documents: [], requiredDocuments: [], logins: ['u-sup'] })).status).toBe(201);

    // What the portal shows the supplier: its own open orders (scoped on the server).
    const ordersBody = (await call('GET', '/v1/supplier-portal/me/orders', 'u-sup')).body as { ordersKnown: boolean; mayUpdate: boolean; orders: { poId: string; number: string }[] };
    const feed: SupplierOrdersFeed = { ordersKnown: ordersBody.ordersKnown, mayUpdate: ordersBody.mayUpdate, orders: ordersBody.orders.map((o) => ({ poId: o.poId, number: o.number, issuedAt: null, deliverToLocationId: null })) };
    expect(feed.orders.map((o) => o.poId)).toEqual(['po-a']);

    // The forms, as the supplier types them.
    const invoice = readInvoiceSubmission({ poId: 'po-a', invoiceId: 'SUP-RICE-1', total: '1200.00', lines: [{ productId: 'p-rice', quantity: '25', uom: 'kg', unitPrice: '48' }] }, feed, true);
    expect(invoice.ok).toBe(true);
    const asn = readAsnSubmission({ poId: 'po-a', asnId: 'ASN-RICE-1', expectedAt: '2026-11-03T10:30', lines: [{ productId: 'p-rice', quantity: '25', uom: 'kg', batchId: 'B-11', expiry: '2027-05-01', manufacturedOn: '2026-10' }] }, feed, true, () => '2026-11-03T05:00:00.000Z');
    expect(asn.ok).toBe(true);
    if (!invoice.ok || !asn.ok) return;

    const sentInvoice = await call('POST', '/v1/supplier-portal/me/submissions', 'u-sup', { submissionId: 'inv-1', kind: 'invoice', document: invoice.document });
    expect(sentInvoice.status, JSON.stringify(sentInvoice.body)).toBe(201);
    expect(sentInvoice.body).toMatchObject({ partnerId: 'sup-a', requiresReview: true, awaiting: 'buyer_review' });
    const sentAsn = await call('POST', '/v1/supplier-portal/me/submissions', 'u-sup', { submissionId: 'asn-1', kind: 'asn', document: asn.document });
    expect(sentAsn.status, JSON.stringify(sentAsn.body)).toBe(201);

    // Nothing counts yet: no bill on the register, no ASN for the compare.
    expect((await call('GET', '/v1/purchase/invoices/SUP-RICE-1', 'u-buyer')).status).toBe(404);
    expect(codeOf(await call('POST', '/v1/inventory/asn/compare', 'u-recv', { asnId: 'ASN-RICE-1', received: { 'p-rice': 25_000 } }))).toBe('asn_unknown');
    // The supplier cannot accept its own.
    expect((await call('POST', '/v1/supplier-portal/partners/sup-a/submissions/inv-1/review', 'u-sup', { decision: 'accept', reason: 'mine' })).status).toBe(403);
    // Both wait on the buyer's queue (the Supplier submissions page reads it), exactly as sent.
    const queue = (await call('GET', '/v1/supplier-portal/review-queue', 'u-buyer')).body as { waiting: { submissionId: string; document: unknown }[] };
    expect(queue.waiting.map((q) => q.submissionId).sort()).toEqual(['asn-1', 'inv-1']);
    expect(queue.waiting.find((q) => q.submissionId === 'inv-1')?.document).toEqual(invoice.document);

    // The delivery arrives; the buyer accepts the ASN and the invoice — now the compare and the match read them.
    expect((await call('POST', '/v1/supplier-portal/partners/sup-a/submissions/asn-1/review', 'u-buyer', { decision: 'accept', reason: 'booked for dock 1' })).body).toMatchObject({ review: { fed: { asnId: 'ASN-RICE-1' } } });
    const compared = await call('POST', '/v1/inventory/asn/compare', 'u-recv', { asnId: 'ASN-RICE-1', received: { 'p-rice': 25_000 } });
    expect(compared.status, JSON.stringify(compared.body)).toBe(200);
    expect(compared.body).toMatchObject({ asnId: 'ASN-RICE-1', supplierId: 'sup-a', matched: true });
    expect((await call('POST', '/v1/inventory/goods-receipt/g-a', 'u-recv', {
      warehouseId: 'S1-BACK', receivedOnDate: '2026-11-03', currency: 'INR', poId: 'po-a',
      lines: [{ lineId: 'L1', productId: 'p-rice', orderedMinor: 25_000, countedMinor: 25_000, uom: 'kg', unitCost: { minor: 4_800, currency: 'INR' }, condition: 'good' }],
    })).status).toBe(201);
    const accepted = await call('POST', '/v1/supplier-portal/partners/sup-a/submissions/inv-1/review', 'u-buyer', { decision: 'accept', reason: 'matches the delivery' });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    const bill = (await call('GET', '/v1/purchase/invoices/SUP-RICE-1', 'u-buyer')).body as { invoice?: Record<string, unknown> } & Record<string, unknown>;
    expect((bill['invoice'] ?? bill)).toMatchObject({ invoiceId: 'SUP-RICE-1', supplierId: 'sup-a', poId: 'po-a', capturedBy: 'u-sup', totalMinor: 120_000 });
  }, 90_000);

  it('the form refuses another supplier\'s order and a login without the grant before anything is sent', () => {
    const feed: SupplierOrdersFeed = { ordersKnown: true, mayUpdate: false, orders: [{ poId: 'po-a', number: 'PO-1', issuedAt: null, deliverToLocationId: null }] };
    expect(readInvoiceSubmission({ poId: 'po-b', invoiceId: 'X', total: '1', lines: [{ productId: 'p', quantity: '1', uom: 'ea', unitPrice: '1' }] }, feed, true)).toEqual({ ok: false, why: 'notYourOrder' });
    expect(readInvoiceSubmission({ poId: 'po-a', invoiceId: 'X', total: '1', lines: [{ productId: 'p', quantity: '1', uom: 'ea', unitPrice: '1' }] }, feed, false)).toEqual({ ok: false, why: 'cannotSubmit' });
  });
});
