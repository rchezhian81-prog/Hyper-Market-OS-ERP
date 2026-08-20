import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M06-FR-01/02/04: the purchase-order lifecycle on the live API — buying as a controlled, approved
// commitment. A PO is PROPOSED by a buyer (the requisitioner is the authenticated user), then ISSUED
// only by a SECOND person (§28 — the approver cannot be the requisitioner, enforced by identity even
// when one user holds both codes); a blocked supplier can never be issued a PO (the block is its own
// append-only, latest-wins record); and the OPEN COMMITMENT — what the shop is on the hook to pay for
// — is computed by the tested computeOpenCommitment from the issued POs, flipping the /commitments
// route from "not known" to a real number. Gated purchase.order.propose vs .approve; reads
// purchase.commitment.read. Idempotent on the PO id (a re-sync is one effect).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INR = 'INR';
const cost = (minor: number) => ({ minor, currency: INR });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const orderOf = (res: { body: unknown }): { status?: string; approvedBy?: string | null; requisitionedBy?: string; totalMinor?: number } =>
  (res.body as { order?: Record<string, unknown> }).order ?? {};
const openOf = (res: { body: unknown }): { totalOpenValue?: { minor: number } } | null =>
  (res.body as { openCommitment?: { totalOpenValue?: { minor: number } } | null }).openCommitment ?? null;

const lines = () => [
  { productId: 'p1', orderedQty: 10, unitCost: cost(5000) },
  { productId: 'p2', orderedQty: 4, unitCost: cost(2500) },
]; // total = 10×5000 + 4×2500 = 60000

const propose = (h: ApiHarness, u: string, poId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/purchase/orders/${poId}`, userId: u, tenantId: A, idempotencyKey: key, body });
const approve = (h: ApiHarness, u: string, poId: string, reason: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/purchase/orders/${poId}/approval`, userId: u, tenantId: A, idempotencyKey: key, body: { reason } });
const setBlock = (h: ApiHarness, u: string, supplierId: string, blocked: boolean, reason: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/purchase/suppliers/${supplierId}/block-status`, userId: u, tenantId: A, idempotencyKey: key, body: { blocked, reason } });
const readPo = (h: ApiHarness, u: string, poId: string) =>
  h.request({ method: 'GET', path: `/v1/purchase/orders/${poId}`, userId: u, tenantId: A });
const listPos = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/purchase/orders', userId: u, tenantId: A });
const commitments = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/purchase/commitments', userId: u, tenantId: A });
const cancel = (h: ApiHarness, u: string, poId: string, b: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/purchase/orders/${poId}/cancellations`, userId: u, tenantId: A, idempotencyKey: key, body: b });
const receive = (h: ApiHarness, u: string, poId: string, b: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/purchase/orders/${poId}/receipts`, userId: u, tenantId: A, idempotencyKey: key, body: b });
const amend = (h: ApiHarness, u: string, poId: string, b: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/purchase/orders/${poId}/amendments`, userId: u, tenantId: A, idempotencyKey: key, body: b });
const openMinor = (res: { body: unknown }): number | undefined => openOf(res)?.totalOpenValue?.minor;
const fullyReceived = (res: { body: unknown }): boolean | undefined =>
  (res.body as { openCommitment?: { fullyReceived?: boolean } | null }).openCommitment?.fullyReceived;

const body = (extra: Record<string, unknown> = {}) => ({ supplierId: 'sup-1', lines: lines(), ...extra });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');            // holds propose + approve + supplier.block
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // holds propose + supplier.block, NOT approve
  await h.provisionRole(A, 'u-cash', 'cashier');       // holds neither
  return h;
}

describe('purchase-order lifecycle (M06-FR-01/02/04)', () => {
  it('proposes then issues under two people, and the open commitment reads back', async () => {
    const h = await cast();
    // The buyer proposes; nothing is committed yet.
    const proposed = await propose(h, 'u-mgr', 'po-1', body(), 'k1');
    expect(proposed.status).toBe(201);
    expect(orderOf(proposed).status).toBe('proposed');
    expect(orderOf(proposed).requisitionedBy).toBe('u-mgr');
    expect(orderOf(proposed).totalMinor).toBe(60000);
    expect(openOf(proposed)).toBeNull(); // a proposed PO is not yet a commitment

    // Until a PO is ISSUED, "what is on order" is still not known (not zero).
    expect((commitmentsBody(await commitments(h, 'u-owner'))).known).toBe(false);

    // A second person (the owner) approves and issues it.
    const issued = await approve(h, 'u-owner', 'po-1', 'within the month budget', 'k2');
    expect(issued.status).toBe(200);
    expect(orderOf(issued).status).toBe('issued');
    expect(orderOf(issued).approvedBy).toBe('u-owner');
    expect(openOf(issued)?.totalOpenValue?.minor).toBe(60000);

    // The commitments figure is now a real number.
    const c = commitmentsBody(await commitments(h, 'u-owner'));
    expect(c.known).toBe(true);
    expect(c.valueMinor).toBe(60000);
    expect(c.count).toBe(1);

    // And the PO reads back as issued.
    expect(orderOf(await readPo(h, 'u-owner', 'po-1')).status).toBe('issued');
  });

  it('refuses a self-approval — the proposer cannot approve their own PO, even holding both codes (§28)', async () => {
    const h = await cast();
    await propose(h, 'u-owner', 'po-self', body(), 'k1'); // owner holds BOTH propose and approve
    const selfApprove = await approve(h, 'u-owner', 'po-self', 'I approve my own order', 'k2');
    expect(selfApprove.status).toBe(409);
    expect(codeOf(selfApprove)).toBe('proposer_cannot_approve');
    // It stayed proposed and never became a commitment.
    expect(orderOf(await readPo(h, 'u-owner', 'po-self')).status).toBe('proposed');
    expect(commitmentsBody(await commitments(h, 'u-owner')).known).toBe(false);
  });

  it('never issues a PO to a blocked supplier, and lifts the hold to let it through (M06-FR-01)', async () => {
    const h = await cast();
    expect((await setBlock(h, 'u-owner', 'sup-9', true, 'failed quality audit', 'b1')).status).toBe(200);
    await propose(h, 'u-mgr', 'po-2', body({ supplierId: 'sup-9' }), 'k1');
    const blocked = await approve(h, 'u-owner', 'po-2', 'ok to buy', 'k2');
    expect(blocked.status).toBe(409);
    expect(codeOf(blocked)).toBe('supplier_blocked');

    // Lift the hold (with a reason) and it can now be issued.
    expect((await setBlock(h, 'u-owner', 'sup-9', false, 'audit passed', 'b2')).status).toBe(200);
    expect((await approve(h, 'u-owner', 'po-2', 'ok to buy', 'k3')).status).toBe(200);
    expect(orderOf(await readPo(h, 'u-owner', 'po-2')).status).toBe('issued');
  });

  it('is idempotent: a re-sent proposal is one PO, and a re-issue is one effect (§31.1)', async () => {
    const h = await cast();
    expect((await propose(h, 'u-mgr', 'po-3', body(), 'k1')).status).toBe(201);
    const again = await propose(h, 'u-mgr', 'po-3', body(), 'k2');
    expect(again.status).toBe(200);
    expect((again.body as { alreadyProposed?: boolean }).alreadyProposed).toBe(true);

    expect((await approve(h, 'u-owner', 'po-3', 'go', 'k3')).status).toBe(200);
    const reissue = await approve(h, 'u-owner', 'po-3', 'go again', 'k4');
    expect(reissue.status).toBe(200);
    expect((reissue.body as { alreadyIssued?: boolean }).alreadyIssued).toBe(true);
    // Still exactly one PO, counted once.
    const c = commitmentsBody(await commitments(h, 'u-owner'));
    expect(c.valueMinor).toBe(60000);
    expect(c.count).toBe(1);
  });

  it('gates propose and approve distinctly, needs a reason, and refuses a malformed body', async () => {
    const h = await cast();
    // A cashier can neither propose…
    expect((await propose(h, 'u-cash', 'po-4', body(), 'k1')).status).toBe(403);
    // …and a store manager can propose but NOT approve (the second-person permission is separate).
    await propose(h, 'u-mgr', 'po-5', body(), 'k2');
    expect((await approve(h, 'u-mgr', 'po-5', 'self', 'k3')).status).toBe(403);
    // Approving needs a reason for the audit trail.
    expect(codeOf(await approve(h, 'u-owner', 'po-5', '', 'k4'))).toBe('reason_required');
    // A body with no lines is not readable as a PO.
    expect(codeOf(await propose(h, 'u-mgr', 'po-6', { supplierId: 'sup-1', lines: [] }, 'k5'))).toBe('not_readable_as_a_purchase_order');
    // The review list surfaces the still-awaiting-approval PO first (control by exception).
    const l = await listPos(h, 'u-owner');
    const listed = l.body as { orders: { status: string }[]; awaitingApprovalCount: number };
    expect(listed.orders[0]?.status).toBe('proposed');
    expect(listed.awaitingApprovalCount).toBeGreaterThanOrEqual(1);
  });

  it('survives a restart: the issued PO and the open commitment are rebuilt from the event store', async () => {
    const h = await cast();
    await propose(h, 'u-mgr', 'po-7', body(), 'k1');
    await approve(h, 'u-owner', 'po-7', 'budgeted', 'k2');

    const restarted = apiHarness({ store: h.store });
    expect(orderOf(await readPo(restarted, 'u-owner', 'po-7')).status).toBe('issued');
    expect(commitmentsBody(await commitments(restarted, 'u-owner')).valueMinor).toBe(60000);
  });
});

function commitmentsBody(res: { body: unknown }): { known: boolean; valueMinor?: number; count?: number } {
  return res.body as { known: boolean; valueMinor?: number; count?: number };
}

// M06-FR-04: amendments, cancellations, receipts — the open commitment nets ordered − received −
// cancelled, and reconciles to receipts. Amendments/cancellations are approved; a partial receipt or
// cancellation reduces the open figure correctly; an amended PO keeps its history.
describe('open-commitment netting: amend / cancel / receive (M06-FR-04)', () => {
  async function issued(h: ApiHarness, poId: string): Promise<void> {
    await propose(h, 'u-mgr', poId, body(), `${poId}-p`);
    await approve(h, 'u-owner', poId, 'budgeted', `${poId}-a`);
  }

  it('a partial cancellation reduces the open commitment correctly', async () => {
    const h = await cast();
    await issued(h, 'po-c');
    // Cancel 4 of the 10 units of p1 (4 × 5000 = 20000 off the 60000).
    const res = await cancel(h, 'u-owner', 'po-c', { cancellationId: 'x1', reason: 'supplier short', cancelledByProduct: { p1: 4 } }, 'k1');
    expect(res.status).toBe(200);
    expect(openMinor(res)).toBe(40000);
    // And the aggregate commitments figure follows.
    expect(commitmentsBody(await commitments(h, 'u-owner')).valueMinor).toBe(40000);
  });

  it('posting receipts reconciles the open commitment down to zero when fully received', async () => {
    const h = await cast();
    await issued(h, 'po-r');
    expect(openMinor(await receive(h, 'u-mgr', 'po-r', { receiptId: 'r1', receivedByProduct: { p1: 6 } }, 'k1'))).toBe(30000); // 4×5000 + 4×2500
    const full = await receive(h, 'u-mgr', 'po-r', { receiptId: 'r2', receivedByProduct: { p1: 4, p2: 4 } }, 'k2');
    expect(openMinor(full)).toBe(0);
    expect(fullyReceived(full)).toBe(true);
  });

  it('re-posting the same receipt id does not double-count', async () => {
    const h = await cast();
    await issued(h, 'po-i');
    expect(openMinor(await receive(h, 'u-mgr', 'po-i', { receiptId: 'r1', receivedByProduct: { p1: 5 } }, 'k1'))).toBe(35000);
    // Same receipt id again — collapses, no double-count.
    expect(openMinor(await receive(h, 'u-mgr', 'po-i', { receiptId: 'r1', receivedByProduct: { p1: 5 } }, 'k2'))).toBe(35000);
  });

  it('an amendment re-prices the commitment and keeps a history (amendmentCount)', async () => {
    const h = await cast();
    await issued(h, 'po-am');
    const res = await amend(h, 'u-owner', 'po-am', { amendmentId: 'a1', reason: 'increased order', lines: [{ productId: 'p1', orderedQty: 20, unitCost: cost(5000) }] }, 'k1');
    expect(res.status).toBe(200);
    expect(openMinor(res)).toBe(100000); // 20 × 5000
    expect((res.body as { order: { amendmentCount: number; totalMinor: number } }).order.amendmentCount).toBe(1);
    expect((res.body as { order: { totalMinor: number } }).order.totalMinor).toBe(100000);
  });

  it('refuses amend / cancel / receive on a PO that is only proposed (not an issued commitment)', async () => {
    const h = await cast();
    await propose(h, 'u-mgr', 'po-pp', body(), 'k1'); // proposed, never issued
    expect(codeOf(await cancel(h, 'u-owner', 'po-pp', { cancellationId: 'x', reason: 'r', cancelledByProduct: { p1: 1 } }, 'k2'))).toBe('purchase_order_not_issued');
    expect(codeOf(await receive(h, 'u-mgr', 'po-pp', { receiptId: 'r', receivedByProduct: { p1: 1 } }, 'k3'))).toBe('purchase_order_not_issued');
    expect(codeOf(await amend(h, 'u-owner', 'po-pp', { amendmentId: 'a', reason: 'r', lines: lines() }, 'k4'))).toBe('purchase_order_not_issued');
  });

  it('gates the receipt on its own permission and rebuilds the netted figure after a restart', async () => {
    const h = await cast();
    await issued(h, 'po-g');
    // A cashier cannot post a receipt (needs purchase.order.receive).
    expect((await receive(h, 'u-cash', 'po-g', { receiptId: 'r1', receivedByProduct: { p1: 1 } }, 'k1')).status).toBe(403);
    await cancel(h, 'u-owner', 'po-g', { cancellationId: 'x1', reason: 'r', cancelledByProduct: { p1: 4 } }, 'k2');
    await receive(h, 'u-mgr', 'po-g', { receiptId: 'r1', receivedByProduct: { p2: 4 } }, 'k3');
    // ordered 60000 − cancelled(4×5000=20000) − received(4×2500=10000) = 30000.
    const restarted = apiHarness({ store: h.store });
    expect(openMinor(await readPo(restarted, 'u-owner', 'po-g'))).toBe(30000);
    expect(commitmentsBody(await commitments(restarted, 'u-owner')).valueMinor).toBe(30000);
  });
});
