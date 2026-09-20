import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Purchase-order per-tenant isolation, end to end through the real API (M06-FR-01/02/04, API-03, P-04,
// OB-01 tenant isolation). purchase-orders.test.ts proves the lifecycle, §28 second-person approval,
// blocked-supplier refusal, idempotency, RBAC and restart-rebuild — but only ever within ONE tenant. This
// proves the property a multi-tenant money path must never get wrong: one shop can neither SEE nor ACT on
// another shop's purchase orders and open commitments. A leak here would show one shop what it has on order
// with a supplier, or let it move another shop's money — the worst kind of cross-tenant failure.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const cost = (minor: number) => ({ minor, currency: 'INR' });
const poBody = () => ({ supplierId: 'sup-1', lines: [
  { productId: 'p1', orderedQty: 10, unitCost: cost(5000) },
  { productId: 'p2', orderedQty: 4, unitCost: cost(2500) },
] }); // total 60000

const propose = (h: ApiHarness, u: string, t: string, poId: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/purchase/orders/${poId}`, userId: u, tenantId: t, idempotencyKey: key, body: poBody() });
const approve = (h: ApiHarness, u: string, t: string, poId: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/purchase/orders/${poId}/approval`, userId: u, tenantId: t, idempotencyKey: key, body: { reason: 'budgeted' } });
const amend = (h: ApiHarness, u: string, t: string, poId: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/purchase/orders/${poId}/amendments`, userId: u, tenantId: t, idempotencyKey: key, body: { amendmentId: 'x', reason: 'r', lines: [{ productId: 'p1', orderedQty: 99, unitCost: cost(5000) }] } });
const readPo = (h: ApiHarness, u: string, t: string, poId: string) =>
  h.request({ method: 'GET', path: `/v1/purchase/orders/${poId}`, userId: u, tenantId: t });
const listPos = (h: ApiHarness, u: string, t: string) =>
  h.request({ method: 'GET', path: '/v1/purchase/orders', userId: u, tenantId: t });
const commitments = (h: ApiHarness, u: string, t: string) =>
  h.request({ method: 'GET', path: '/v1/purchase/commitments', userId: u, tenantId: t });

const orderStatus = (res: { body: unknown }): string | undefined => (res.body as { order?: { status?: string } }).order?.status;
const commit = (res: { body: unknown }) => res.body as { known: boolean; valueMinor?: number; count?: number };

describe('purchase orders are per-tenant isolated: one shop never sees or moves another shop’s money (M06)', () => {
  it('an issued PO + open commitment in tenant A is invisible and untouchable from tenant B', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager'); // proposes; the owner approves (§28)
    await h.seedOwner(B, 'u-owner-b');

    // Tenant A issues a ₹600 PO under two people.
    expect((await propose(h, 'u-mgr', A, 'po-1', 'a-k1')).status).toBe(201);
    expect((await approve(h, 'u-owner', A, 'po-1', 'a-k2')).status).toBe(200);
    // Positive control: A sees its own PO + commitment.
    expect(orderStatus(await readPo(h, 'u-owner', A, 'po-1'))).toBe('issued');
    expect(commit(await commitments(h, 'u-owner', A))).toMatchObject({ known: true, valueMinor: 60000, count: 1 });

    // Tenant B — a legitimate owner of a DIFFERENT shop — sees none of it.
    const bList = (await listPos(h, 'u-owner-b', B)).body as { orders: unknown[]; awaitingApprovalCount: number };
    expect(bList.orders, 'tenant B saw tenant A’s purchase orders').toEqual([]);
    expect(bList.awaitingApprovalCount).toBe(0);
    expect((await readPo(h, 'u-owner-b', B, 'po-1')).status, 'tenant B could read tenant A’s PO').toBe(404);
    expect(commit(await commitments(h, 'u-owner-b', B)), 'tenant A’s commitment leaked into tenant B').toMatchObject({ known: false });

    // Tenant B cannot ACT on tenant A's PO — an amendment against that id in B does not touch A.
    expect((await amend(h, 'u-owner-b', B, 'po-1', 'b-k1')).status).toBeGreaterThanOrEqual(400);

    // Tenant A is entirely unaffected by B's attempts.
    expect(orderStatus(await readPo(h, 'u-owner', A, 'po-1'))).toBe('issued');
    expect(commit(await commitments(h, 'u-owner', A))).toMatchObject({ known: true, valueMinor: 60000, count: 1 });
  });
});
