import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';
import { createBuyingSession } from '../../apps/web-erp/src/buying-session';
import { bootBuying } from '../../apps/web-erp/src/browser-entry';

// Temporary audit observations. Passing means the defect was reproduced; these are NOT acceptance tests.
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const policy = { excessToleranceBp: 500, shortageToleranceBp: 200, nearExpiryDays: 7 };
const receipt = (ordered: number, counted: number) => ({
  warehouseId: 'wh-audit', receivedOnDate: '2026-09-30', currency: 'INR',
  rules: [{ productId: 'p-audit', batchTracked: false }], policy,
  lines: [{ lineId: 'L1', productId: 'p-audit', orderedMinor: ordered, countedMinor: counted,
    uom: 'each', unitCost: { minor: 100, currency: 'INR' }, condition: 'good' }],
});

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

  it('an excess needing approval is immediately made fully sellable without an approval', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'owner');
    await h.provisionRole(TENANT, 'receiver', 'store_manager');
    const grn = await h.request({ method: 'POST', path: '/v1/inventory/goods-receipt/GRN-EXCESS',
      tenantId: TENANT, userId: 'receiver', idempotencyKey: 'excess', body: receipt(100, 110) });
    expect(grn.status).toBe(201);
    // OBSERVED DEFECT: approval flag is true but no quantity is held pending approval.
    expect(grn.body).toMatchObject({ grn: { availableMinor: 110, captured: { requiresApproval: true,
      lines: [{ sellableMinor: 110, quarantinedMinor: 0 }] } } });
    const available = await h.request({ method: 'GET', path: '/v1/inventory/availability',
      tenantId: TENANT, userId: 'owner', query: { productId: 'p-audit' } });
    expect(available.body).toMatchObject({ rows: [{ onHandMinor: 110 }] });
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
