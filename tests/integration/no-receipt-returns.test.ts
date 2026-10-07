import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { giveRefundApproval, withApprovals } from '../support/refund-approval';
import { sealedReturn } from '../support/store-seal';

/**
 * **Controlled no-receipt returns through the real API (M13-FR-01, §28, M15, M08-FR-01) — CH-01 un-parked.**
 *
 * The roadmap's acceptance: "a no-receipt return above policy is blocked without supervisor approval". Through
 * the real router, token auth, per-tenant RBAC and the append-only store: the owner alone sets the cap; the desk
 * path is unavailable until then; a cashier's return needs a genuine approver and stays within the cap; the
 * resold unit re-enters on-hand at the named location; the return counts against NO bill; the lane's synced
 * return reconciles and its breach is a visible exception on the same screen as receipted breaches; the report
 * shows who gave and who approved.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const publishProduct = (h: ApiHarness, tenantId: string, productId: string) =>
  h.request({
    method: 'POST', path: `/v1/catalogue/products/${productId}/publish`, userId: 'u-owner', tenantId, idempotencyKey: `k-${productId}`,
    body: {
      product: { sku: `SKU-${productId}`, name: `Product ${productId}`, baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'draft' },
      categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
    },
  });
const setCap = (h: ApiHarness, userId: string, capMinor: number, key: string, tenantId = A) =>
  h.request({ method: 'POST', path: '/v1/pos/no-receipt-cap', userId, tenantId, idempotencyKey: key, body: { capMinor } });
const readCap = (h: ApiHarness, userId: string, tenantId = A) =>
  h.request({ method: 'GET', path: '/v1/pos/no-receipt-cap', userId, tenantId });
const line = (over: Record<string, unknown> = {}) => ({ productId: 'P1', uom: 'each', quantityMinor: 1, disposition: 'resell', ...over });
const req = (over: Record<string, unknown> = {}) => ({
  returnId: 'NR-1', reasonCode: 'no_receipt_wrong_item', lines: [line()], refundMinor: 5000, refundTender: 'cash',
  approvedBy: 'u-mgr', locationId: 'store-main', ...over,
});
// A named approver approves in their own session (ADR-0022) and the return names that approval; `takeNamed` sends the
// name as written — the audit's PF-02 reproduction.
const takeNamed = (h: ApiHarness, userId: string, body: Record<string, unknown>, tenantId = A) =>
  h.request({ method: 'POST', path: '/v1/returns/no-receipt', userId, tenantId, idempotencyKey: `nr-${body['returnId']}`, body });
const take = async (h: ApiHarness, userId: string, body: Record<string, unknown>, tenantId = A) =>
  takeNamed(h, userId, await withApprovals(h, tenantId, userId, null, body, { refundKind: 'no_receipt_return' }), tenantId);
// Relayed as a current store computer sends it — who gave it and any approval it spent, sealed (ADR-0023).
const sync = (h: ApiHarness, userId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: '/v1/returns/no-receipt/synced', userId, tenantId: A, idempotencyKey: `nrs-${body['returnId']}`, body: sealedReturn(A, body) });
const report = (h: ApiHarness, userId: string, tenantId = A) =>
  h.request({ method: 'GET', path: '/v1/pos/no-receipt-returns', userId, tenantId });
const exceptions = (h: ApiHarness, userId: string) =>
  h.request({ method: 'GET', path: '/v1/pos/return-governance-exceptions', userId, tenantId: A });
const availability = async (h: ApiHarness, productId: string) =>
  ((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: 'u-owner', tenantId: A, query: { productId } })).body as
    { rows: { locationId: string; onHandMinor: number }[] }).rows;

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // holds pos.return.approve, NOT the cap permission
  await h.provisionRole(A, 'u-cash', 'cashier');      // pos.return.record + pos.return.sync; no approve, no lp.case.read
  expect((await publishProduct(h, A, 'P1')).status).toBe(201);
  return h;
}

describe('controlled no-receipt returns (M13-FR-01) — real API, real RBAC, append-only store', () => {
  it('the cap is owner-only; the desk path is unavailable until it is set', async () => {
    const h = await cast();
    expect((await readCap(h, 'u-cash')).body).toEqual({ capMinor: null, isSet: false });
    expect((await setCap(h, 'u-mgr', 100000, 'cap-mgr')).status).toBe(403);
    expect((await setCap(h, 'u-cash', 100000, 'cap-cash')).status).toBe(403);
    const refused = await take(h, 'u-cash', req());
    expect(refused.status).toBe(422);
    expect(codeOf(refused)).toBe('no_receipt_returns_unavailable');
    expect((await setCap(h, 'u-owner', 100000, 'cap-1')).status).toBe(200);
    expect((await readCap(h, 'u-cash')).body).toEqual({ capMinor: 100000, isSet: true });
  });

  it('a cashier\'s no-receipt return needs a genuine approver and stays within the cap; it counts against no bill', async () => {
    const h = await cast();
    await setCap(h, 'u-owner', 6000, 'cap-1');
    expect(codeOf(await take(h, 'u-cash', req({ approvedBy: undefined })))).toBe('needs_a_second_person');
    // A genuine manager NAMED in the body who never approved (the audit's PF-02 reproduction) — refused.
    expect(codeOf(await takeNamed(h, 'u-cash', req({ returnId: 'NR-NAMED' })))).toBe('approver_named_without_approval');
    // A person without the authority cannot approve at all — the cashier (even their own return), or a made-up name;
    // and a manager cannot approve a return they will process themselves (§28).
    const ask = { kind: 'no_receipt_return' as const, valueMinor: 5000, requestedBy: 'u-cash' };
    expect((await giveRefundApproval(h, A, 'u-cash', ask)).status).toBe(403);
    expect((await giveRefundApproval(h, A, 'u-nobody', ask)).status).toBe(403);
    expect(codeOf(await giveRefundApproval(h, A, 'u-mgr', { ...ask, requestedBy: 'u-mgr' }))).toBe('self_approval');
    expect(codeOf(await take(h, 'u-cash', req({ refundMinor: 6001 })))).toBe('no_receipt_over_cap');
    expect(codeOf(await take(h, 'u-cash', req({ lines: [line({ productId: 'P-NOT-SOLD' })] })))).toBe('product_not_in_catalogue');

    const ok = await take(h, 'u-cash', req());
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ returnId: 'NR-1', noReceipt: true, refundStatus: 'settled', restockedLines: 1, capMinor: 6000 });

    // Idempotent on the return id: the same return sent again lands once.
    expect((await take(h, 'u-cash', req())).status).toBe(201);
    const rep = (await report(h, 'u-owner')).body as { count: number; totalRefundedMinor: number; returns: { originalSaleId: string | null; noReceipt?: boolean; processedBy: string; approvedBy?: string }[] };
    expect(rep.count).toBe(1);
    expect(rep.totalRefundedMinor).toBe(5000);
    expect(rep.returns[0]).toMatchObject({ originalSaleId: null, noReceipt: true, processedBy: 'u-cash', approvedBy: 'u-mgr' });
    // The report is a loss surface one rung above the desk.
    expect((await report(h, 'u-cash')).status).toBe(403);
  });

  it('a resold unit re-enters on-hand at the named location (M08-FR-01); quarantine does not', async () => {
    const h = await cast();
    await setCap(h, 'u-owner', 100000, 'cap-1');
    expect((await availability(h, 'P1')).find((r) => r.locationId === 'store-main')).toBeUndefined();
    expect((await take(h, 'u-cash', req({ returnId: 'NR-RESELL', lines: [line({ quantityMinor: 2 })] }))).status).toBe(201);
    expect((await availability(h, 'P1')).find((r) => r.locationId === 'store-main')?.onHandMinor).toBe(2);
    expect((await take(h, 'u-cash', req({ returnId: 'NR-Q', lines: [line({ disposition: 'quarantine' })], locationId: undefined }))).status).toBe(201);
    expect((await availability(h, 'P1')).find((r) => r.locationId === 'store-main')?.onHandMinor).toBe(2);
    expect(codeOf(await take(h, 'u-cash', req({ returnId: 'NR-NOLOC', locationId: undefined })))).toBe('resell_needs_a_location');
  });

  it('the lane\'s synced no-receipt return reconciles, and a breach is a visible exception beside the receipted ones', async () => {
    const h = await cast();
    const laneReturn = (over: Record<string, unknown> = {}) => ({
      returnId: 'NR-L1', processedBy: 'u-cash', reasonCode: 'no_receipt', lines: [line()], refundMinor: 5000, refundTender: 'cash',
      refundStatus: 'settled', laneId: 'lane-1', processedAt: '2026-10-06T09:00:00.000Z', ...over,
    });
    // No cap set on the cloud, no approver at the lane: recorded (the money moved), BOTH breaches flagged, 202 never 4xx.
    const flagged = await sync(h, 'u-cash', laneReturn());
    expect(flagged.status).toBe(202);
    expect(flagged.body).toMatchObject({ reconciled: true, noReceipt: true, flags: ['given_without_approval', 'no_receipt_over_cap'] });
    const exc = (await exceptions(h, 'u-owner')).body as { count: number; exceptions: { returnId: string; originalSaleId: string | null; noReceipt?: boolean; governanceFlags: string[] }[] };
    expect(exc.count).toBe(1);
    expect(exc.exceptions[0]).toMatchObject({ returnId: 'NR-L1', originalSaleId: null, noReceipt: true, governanceFlags: ['given_without_approval', 'no_receipt_over_cap'] });
    // Its resold unit re-entered at the lane (assumed, stated on the movement) — the shelf is not silently short.
    expect((await availability(h, 'P1')).find((r) => r.locationId === 'lane-1')?.onHandMinor).toBe(1);

    // Once the owner sets the cap, a clean lane return reconciles with no flags.
    await setCap(h, 'u-owner', 100000, 'cap-1');
    const clean = await sync(h, 'u-cash', laneReturn({ returnId: 'NR-L2', approvedBy: 'u-mgr' }));
    expect(clean.body).toMatchObject({ flags: [] });
    expect(((await exceptions(h, 'u-owner')).body as { count: number }).count).toBe(1);
    expect(((await report(h, 'u-owner')).body as { count: number; flaggedCount: number }).flaggedCount).toBe(1);
    // A sync identity that lacks pos.return.sync cannot relay.
    await h.provisionRole(A, 'u-acct', 'accountant');
    expect((await sync(h, 'u-acct', laneReturn({ returnId: 'NR-L3' }))).status).toBe(403);
  });

  it('is isolated per tenant — one shop\'s cap and register are invisible to another', async () => {
    const h = await cast();
    await h.seedOwner(B, 'u-owner-b');
    await setCap(h, 'u-owner', 100000, 'cap-a');
    expect((await readCap(h, 'u-owner-b', B)).body).toEqual({ capMinor: null, isSet: false });
    expect((await take(h, 'u-cash', req())).status).toBe(201);
    expect(((await report(h, 'u-owner-b', B)).body as { count: number }).count).toBe(0);
  });
});
