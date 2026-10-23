import { describe, it, expect } from 'vitest';
import { purchaseOrderRoutes, type PurchaseOrderDeps, type StoredPurchaseOrder } from '../../services/purchase/src/purchase-orders';
import { authorityFrom, DECIDED_AUTHORITY_LIMITS } from '../../packages/approvals/src/authority-rules';
import { ApiError, type RequestContext } from '../../services/kernel/src/index';
import { money } from '../../packages/contracts/src/money';

// OB-290 · M02-FR-02: the APPROVER's purchase-order limit is the owner's server-held rule. A person holding the approve
// right but limited to ₹25,000 (a store manager's ladder) cannot issue a ₹30,000 order — it goes to the owner, recorded on
// the trail; the owner (unlimited) issues it. The limit in a request body is never read. Route-level, over a stub register.

const rolesOf: Record<string, string[]> = { 'u-mgr': ['store_manager'], 'u-owner': ['owner'], 'u-acc': ['accountant'] };
const po = (totalMinor: number): StoredPurchaseOrder => ({
  poId: 'po-1', number: 'po-1', supplierId: 'sup-1', deliverToLocationId: 'store-1', requisitionedBy: 'u-buyer', at: '2026-10-23T05:00:00.000Z',
  lines: [{ productId: 'rice', orderedQty: totalMinor / 100, unitCost: money(100, 'INR') }], totalMinor, currency: 'INR', status: 'proposed',
  approvedBy: null, issuedAt: null, receivedByProduct: {}, cancelledByProduct: {}, amendmentCount: 0,
});

function routes(order: StoredPurchaseOrder) {
  const audit: { action: string; actorId: string }[] = [];
  const issued: string[] = [];
  const deps: PurchaseOrderDeps = {
    order: () => order, all: () => [order], supplierBlocked: () => false, propose: () => {}, setSupplierBlocked: () => {},
    issue: (_t, poId, by) => { issued.push(`${poId}:${by}`); }, amend: () => {}, cancel: () => {}, postReceipt: () => {},
    now: () => '2026-10-23T06:00:00.000Z',
    authorityOf: (_t, userId, subjectType) => authorityFrom({ limits: DECIDED_AUTHORITY_LIMITS, rulesVersion: 0, userId, roleIds: rolesOf[userId] ?? [], subjectType }),
    recordAudit: (_t, e) => { audit.push({ action: e.action, actorId: e.actorId }); },
  };
  const approve = purchaseOrderRoutes(deps).find((r) => r.method === 'POST' && r.path === '/v1/purchase/orders/:poId/approval')!;
  const call = (userId: string, body: Record<string, unknown> = { reason: 'checked' }) => approve.handler({
    tenantId: 'T', userId, branchId: null, scope: 'all', params: { poId: 'po-1' }, query: {}, body, idempotencyKey: `k-${userId}`, traceId: 't',
  } as RequestContext);
  return { call, audit, issued };
}

const refusal = async (p: unknown): Promise<{ status: number; code: string; what: string }> => {
  try { await p; } catch (e) { if (e instanceof ApiError) return { status: e.status, code: e.body.code, what: e.body.whatHappened }; throw e; }
  throw new Error('not refused');
};

describe('a purchase order above the approver\'s limit goes to the owner (OB-290)', () => {
  it('a ₹30,000 order is refused for a ₹25,000 approver by name, recorded, and issued by the owner', async () => {
    const r = routes(po(3_000_000));
    const refused = await refusal(r.call('u-mgr', { reason: 'checked', authorityLimit: null, limitMinor: 99_999_999 }));
    expect(refused).toMatchObject({ status: 422, code: 'above_your_limit_goes_to_owner' });
    expect(refused.what).toContain('₹30,000.00');
    expect(refused.what).toContain('up to ₹25,000.00 (store_manager)');
    expect(r.audit).toEqual([{ action: 'purchase.order.routed_to_owner', actorId: 'u-mgr' }]);
    expect(r.issued).toEqual([]);
    expect((await r.call('u-owner')).status).toBe(200);
    expect(r.issued).toEqual(['po-1:u-owner']);
  });

  it('within the limit the approver issues it; a person with no PO limit set issues nothing', async () => {
    expect((await routes(po(2_500_000)).call('u-mgr')).status).toBe(200);
    expect(await refusal(routes(po(100)).call('u-acc'))).toMatchObject({ status: 422, code: 'above_your_limit_goes_to_owner' });
  });
});
