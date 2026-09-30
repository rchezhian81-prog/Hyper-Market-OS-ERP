import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';
import { createBuyingSession } from '../../apps/web-erp/src/buying-session';
import { bootBuying } from '../../apps/web-erp/src/browser-entry';

// Audit observations (30 September 2026, pinned at 8f4f6c5) for the procurement flow. Passing an OBSERVED case means the
// defect was reproduced; these are NOT acceptance tests.
//
// F03 — FIXED in SP-4 (ii): case 2 is now the REGRESSION. The direct receipt refuses a body that names its own product
// rules or tolerance policy; the tolerances are the tenant's own; an over-tolerance excess is HELD out of the sellable
// figure and out of stock until a SECOND person approves it.
//
// F01 and F02 — still OBSERVED (SP-6 / SP-7): the assertions marked OBSERVED DEFECT below still pass. When those slices
// land they must be inverted, never restored.
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const policy = { excessToleranceBp: 500, shortageToleranceBp: 200, nearExpiryDays: 7 };
// The counted lines only — since SP-4 (ii) the route refuses a body that carries `rules` or `policy` (F03).
const receipt = (ordered: number, counted: number) => ({
  warehouseId: 'wh-audit', receivedOnDate: '2026-09-30', currency: 'INR',
  lines: [{ lineId: 'L1', productId: 'p-audit', orderedMinor: ordered, countedMinor: counted,
    uom: 'each', unitCost: { minor: 100, currency: 'INR' }, condition: 'good' }],
});
const legacyClaims = { rules: [{ productId: 'p-audit', batchTracked: false }], policy };

describe('audit observations: disconnected procurement flow', () => {
  it('a committed partial GRN changes stock but leaves the approved PO completely outstanding', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'owner');
    await h.provisionRole(TENANT, 'buyer', 'store_manager');
    const proposed = await h.request({ method: 'POST', path: '/v1/purchase/orders/PO-AUDIT',
      tenantId: TENANT, userId: 'buyer', idempotencyKey: 'po-propose',
      body: { supplierId: 'supplier-audit', lines: [{ productId: 'p-audit', orderedQty: 10,
        unitCost: { minor: 100, currency: 'INR' } }] } });
    expect(proposed.status).toBe(201);
    const issued = await h.request({ method: 'POST', path: '/v1/purchase/orders/PO-AUDIT/approval',
      tenantId: TENANT, userId: 'owner', idempotencyKey: 'po-approve', body: { reason: 'audit fixture' } });
    expect(issued.status).toBe(200);
    const grn = await h.request({ method: 'POST', path: '/v1/inventory/goods-receipt/GRN-AUDIT',
      tenantId: TENANT, userId: 'buyer', idempotencyKey: 'grn-receive',
      body: { ...receipt(10, 4), poId: 'PO-AUDIT' } });
    expect(grn.status).toBe(201);
    expect(grn.body).toMatchObject({ grn: { availableMinor: 4, poId: 'PO-AUDIT' } });
    const available = await h.request({ method: 'GET', path: '/v1/inventory/availability',
      tenantId: TENANT, userId: 'owner', query: { productId: 'p-audit' } });
    expect(available.body).toMatchObject({ rows: [{ onHandMinor: 4 }] });
    const po = await h.request({ method: 'GET', path: '/v1/purchase/orders/PO-AUDIT',
      tenantId: TENANT, userId: 'owner' });
    // OBSERVED DEFECT: correct connected remainder is 6 units / 600 minor, not 10 / 1000.
    expect(po.body).toMatchObject({ order: { receivedByProduct: {} },
      openCommitment: { totalOpenValue: { minor: 1000 } } });
  });

  it('F03 FIXED: an over-tolerance excess is HELD — not sellable, not in stock — until a second person approves it; the tolerances and rules are head office\'s', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'owner');
    await h.provisionRole(TENANT, 'receiver', 'store_manager');
    await h.provisionRole(TENANT, 'supervisor', 'store_manager');
    // The tenant's own tolerance (5%) — set by the owner, read by the route; the receiver's body cannot change it.
    expect((await h.request({ method: 'POST', path: '/v1/inventory/receipt-policy', tenantId: TENANT, userId: 'owner',
      idempotencyKey: 'policy', body: policy })).status).toBe(201);
    // The old body — rules and policy chosen by the sender — is refused by name.
    const claims = await h.request({ method: 'POST', path: '/v1/inventory/goods-receipt/GRN-EXCESS',
      tenantId: TENANT, userId: 'receiver', idempotencyKey: 'excess-claims', body: { ...receipt(100, 110), ...legacyClaims } });
    expect(claims.status).toBe(400);
    expect(claims.body).toMatchObject({ error: { code: 'receipt_carries_caller_claims' } });
    // The counted lines alone: 110 against 100 is 10% — beyond the 5% the tenant accepts — so 100 sell and 10 are HELD.
    const grn = await h.request({ method: 'POST', path: '/v1/inventory/goods-receipt/GRN-EXCESS',
      tenantId: TENANT, userId: 'receiver', idempotencyKey: 'excess', body: receipt(100, 110) });
    expect(grn.status).toBe(201);
    expect(grn.body).toMatchObject({ grn: { availableMinor: 100, heldMinor: 10, captured: { requiresApproval: true,
      lines: [{ sellableMinor: 100, heldMinor: 10, quarantinedMinor: 0 }] } } });
    const available = await h.request({ method: 'GET', path: '/v1/inventory/availability',
      tenantId: TENANT, userId: 'owner', query: { productId: 'p-audit' } });
    expect(available.body).toMatchObject({ rows: [{ onHandMinor: 100 }] });
    // The receiver cannot approve their own excess (§28); a second person can — and only then do the 10 reach stock, once.
    const self = await h.request({ method: 'POST', path: '/v1/inventory/goods-receipt/GRN-EXCESS/excess/decide',
      tenantId: TENANT, userId: 'receiver', idempotencyKey: 'decide-self', body: { decision: 'approved', reason: 'my own delivery' } });
    expect(self.status).toBe(422);
    expect(self.body).toMatchObject({ error: { code: 'self_approval' } });
    const approved = await h.request({ method: 'POST', path: '/v1/inventory/goods-receipt/GRN-EXCESS/excess/decide',
      tenantId: TENANT, userId: 'supervisor', idempotencyKey: 'decide', body: { decision: 'approved', reason: 'supplier confirmed the extra 10 are free' } });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ decision: 'approved', releasedMinor: 10, availableMinor: 110, movementIds: ['GRN-EXCESS:L1:excess'] });
    const after = await h.request({ method: 'GET', path: '/v1/inventory/availability',
      tenantId: TENANT, userId: 'owner', query: { productId: 'p-audit' } });
    expect(after.body).toMatchObject({ rows: [{ onHandMinor: 110 }] });
  });

  it('the actual browser boot reports invoice capture success but cannot match the invoice just captured', () => {
    const s = bootBuying({ buyerId: 'buyer', productIds: ['p-audit'], approvers: ['approver'],
      ordered: { 'PO-AUDIT': [{ productId: 'p-audit', qty: 10, unitMinor: 100 }] },
      received: { 'PO-AUDIT': [{ productId: 'p-audit', qty: 10 }] }, captured: {} })!;
    const preview = s.previewInvoice({
      text: 'productId,quantity,unitPriceMinor,lineTotalMinor\np-audit,10,100,1000', declaredTotalMinor: 1000,
    });
    expect(preview.readyToApprove).toBe(true);
    const input: Parameters<ReturnType<typeof createBuyingSession>['captureInvoice']>[0] = {
      invoiceId: 'INV-AUDIT', supplierId: 'supplier-audit', preview,
      approval: { id: 'ap-audit', subjectType: 'supplier_invoice', subjectRef: 'INV-AUDIT',
        requestedBy: 'buyer', branchId: null, value: null, status: 'approved', decidedBy: 'approver',
        reason: 'checked_with_supplier', decidedAt: '2026-09-30T10:00:00Z' },
    };
    expect(s.captureInvoice(input)).toMatchObject({ ok: true, totalMinor: 1000 });
    // OBSERVED DEFECT: unchanged boot-data register contains no saved invoice, even in this same session.
    expect(s.match({ poId: 'PO-AUDIT', invoiceId: 'INV-AUDIT' })).toMatchObject({
      blocked: true, payableMinor: 0, lines: [],
    });
    expect(s.captureInvoice(input)).toMatchObject({ ok: true }); // duplicate detection also misses it
  });
});
