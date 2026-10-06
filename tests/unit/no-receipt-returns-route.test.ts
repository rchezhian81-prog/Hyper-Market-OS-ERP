import { describe, it, expect } from 'vitest';
import { noReceiptReturnRoutes, noReceiptReport, type NoReceiptReturnsDeps } from '../../services/pos/src/no-receipt-returns';
import type { ReturnRecord, StoreCreditIssue } from '../../services/pos/src/returns';
import type { SaleStockLocation } from '../../services/pos/src/sale-stock';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import type { AuditEntry } from '../../packages/audit/src/index';
import type { ApprovalUse, RefundApproval, RefundApprovalState } from '../../services/pos/src/refund-approvals';

/**
 * **M13-FR-01 — controlled no-receipt returns on the cloud (un-parks the no-receipt half of CH-01).**
 *
 * Route-level with stubbed stores. The roadmap's two controls stand in for the missing bill: a no-receipt
 * return ALWAYS needs a §28 approver who genuinely holds the authority, and it is CAPPED by a per-tenant limit
 * the owner sets (no cap = the path is off). At the desk every breach is refused before money moves; on the
 * synced path a return that already happened is recorded and its breach becomes a visible exception.
 */

const NOW = '2026-10-06T10:00:00.000Z';
const T = 't-sre';

interface Rec {
  cap: number | undefined;
  scCap: number | undefined;
  known: Set<string>;
  approvers: Set<string>;
  recorded: { record: ReturnRecord; storeCredit: StoreCreditIssue | undefined; location: SaleStockLocation | undefined; use?: ApprovalUse }[];
  audits: AuditEntry[];
  /** Approvals head office gave (ADR-0022), by id — and the return that spent each. */
  approvals: Map<string, RefundApprovalState>;
}
/** Each stub's approval register, reachable from its routes so `desk` can have the named approver give one. */
const approvalsOf = new WeakMap<readonly Route[], Map<string, RefundApprovalState>>();
function stub(over: Partial<Rec> = {}) {
  const rec: Rec = { cap: undefined, scCap: undefined, known: new Set(['P1', 'P2']), approvers: new Set(['u-mgr']), recorded: [], audits: [], approvals: new Map(), ...over };
  const deps: NoReceiptReturnsDeps = {
    noReceiptCap: () => rec.cap,
    recordNoReceiptCap: (_t, capMinor) => { rec.cap = capMinor; },
    knownProduct: (_t, productId) => rec.known.has(productId),
    canApproveRefund: (_t, userId) => rec.approvers.has(userId),
    storeCreditCap: () => rec.scCap,
    recordNoReceiptReturn: (_t, record, storeCredit, location, approvalUse) => {
      rec.recorded.push({ record, storeCredit, location, ...(approvalUse === undefined ? {} : { use: approvalUse.use }) });
      if (approvalUse !== undefined) {
        const state = rec.approvals.get(approvalUse.use.approvalId)!;
        rec.approvals.set(approvalUse.use.approvalId, { ...state, usedBy: approvalUse.use.usedBy });
      }
    },
    refundApproval: (_t, approvalId) => rec.approvals.get(approvalId),
    approvalVersion: () => 0,
    noReceiptReturns: () => rec.recorded.map((r) => r.record),
    recordAudit: (_t, entry) => { rec.audits.push(entry); },
    now: () => NOW,
  };
  const routes = noReceiptReturnRoutes(deps);
  approvalsOf.set(routes, rec.approvals);
  return { rec, routes };
}
const ctx = (over: Partial<RequestContext>): RequestContext =>
  ({ tenantId: T, userId: 'u-cash', branchId: null, params: {}, query: {}, body: undefined, traceId: 't', ...over });
const routeFor = (routes: readonly Route[], method: string, path: string): Route => {
  const r = routes.find((x) => x.method === method && x.path === path);
  if (r === undefined) throw new Error(`no route ${method} ${path}`);
  return r;
};
interface Thrown { readonly status: number; readonly body: { readonly code: string } }
async function thrown(fn: () => unknown): Promise<Thrown> {
  try { await fn(); } catch (e) { return e as Thrown; }
  throw new Error('expected the handler to throw');
}

const line = (over: Record<string, unknown> = {}) => ({ productId: 'P1', uom: 'each', quantityMinor: 1, disposition: 'resell', ...over });
const body = (over: Record<string, unknown> = {}) => ({
  returnId: 'NR-1', reasonCode: 'no_receipt_damaged_pack', lines: [line()], refundMinor: 5000, refundTender: 'cash',
  approvedBy: 'u-mgr', locationId: 'store-main', ...over,
});
/** An approval as head office would hold it after `approvedBy` gave it in their own session (the route that gives it
 *  is proven in refund-approvals.test.ts). */
const approval = (over: Partial<RefundApproval> & { approvalId: string; approvedBy: string; requestedBy: string; valueMinor: number }): RefundApproval => ({
  kind: 'no_receipt_return', saleId: null, reason: 'test', givenAt: NOW, expiresAt: '2026-10-06T10:15:00.000Z', ...over,
});
/** The desk route as it is called — the body's `approvedBy` having approved in their own session first, so the body
 *  names that approval (ADR-0022). `deskNamed` sends the body as written — the audit's PF-02 reproduction. */
const deskNamed = (routes: readonly Route[], b: unknown, userId = 'u-cash') =>
  routeFor(routes, 'POST', '/v1/returns/no-receipt').handler(ctx({ body: b, userId }));
const desk = (routes: readonly Route[], b: Record<string, unknown>, userId = 'u-cash') => {
  const { approvedBy, ...rest } = b;
  if (typeof approvedBy !== 'string') return deskNamed(routes, b, userId);
  const approvalId = `rap-${String(b['returnId'])}-${approvedBy}`;
  approvalsOf.get(routes)!.set(approvalId, { approval: approval({ approvalId, approvedBy, requestedBy: userId, valueMinor: b['refundMinor'] as number }) });
  return deskNamed(routes, { ...rest, approvalId }, userId);
};
const synced = (routes: readonly Route[], b: unknown) =>
  routeFor(routes, 'POST', '/v1/returns/no-receipt/synced').handler(ctx({ body: b, userId: 'u-sync' }));
const setCap = (routes: readonly Route[], capMinor: unknown) =>
  routeFor(routes, 'POST', '/v1/pos/no-receipt-cap').handler(ctx({ body: { capMinor }, userId: 'u-owner' }));

describe('the no-receipt cap is the owner\'s policy, read server-side (M13-FR-01)', () => {
  it('reads as not set until the owner sets it, then as the latest value', async () => {
    const { routes } = stub();
    const read = routeFor(routes, 'GET', '/v1/pos/no-receipt-cap');
    expect((await read.handler(ctx({}))).body).toEqual({ capMinor: null, isSet: false });
    expect((await setCap(routes, 20000)).status).toBe(200);
    expect((await read.handler(ctx({}))).body).toEqual({ capMinor: 20000, isSet: true });
  });
  it('refuses a cap that is not a whole non-negative amount', async () => {
    const { routes } = stub();
    expect((await thrown(() => setCap(routes, -1))).body.code).toBe('not_readable_as_a_no_receipt_cap');
    expect((await thrown(() => setCap(routes, 12.5))).body.code).toBe('not_readable_as_a_no_receipt_cap');
    expect((await thrown(() => setCap(routes, '500'))).body.code).toBe('not_readable_as_a_no_receipt_cap');
  });
});

describe('the desk no-receipt return refuses before money moves (M13-FR-01, §28, P-08)', () => {
  it('is UNAVAILABLE until the owner sets a cap — fail-safe, never a guessed default', async () => {
    const { routes, rec } = stub();
    const e = await thrown(() => desk(routes, body()));
    expect(e.status).toBe(422);
    expect(e.body.code).toBe('no_receipt_returns_unavailable');
    expect(rec.recorded).toHaveLength(0);
  });
  it('refuses a refund above the cap', async () => {
    const { routes } = stub({ cap: 4999 });
    expect((await thrown(() => desk(routes, body()))).body.code).toBe('no_receipt_over_cap');
  });
  it('refuses a product the shop does not sell — identify the item first', async () => {
    const { routes } = stub({ cap: 100000 });
    expect((await thrown(() => desk(routes, body({ lines: [line({ productId: 'P-UNKNOWN' })] })))).body.code).toBe('product_not_in_catalogue');
  });
  it('ALWAYS needs a second, genuinely-authorised person — whatever the amount', async () => {
    const { routes, rec } = stub({ cap: 100000 });
    expect((await thrown(() => desk(routes, body({ approvedBy: undefined, refundMinor: 100 })))).body.code).toBe('needs_a_second_person');
    // The audit's PF-02 reproduction: a genuine manager NAMED in the body, who never approved — refused.
    expect((await thrown(() => deskNamed(routes, body()))).body.code).toBe('approver_named_without_approval');
    // An approval from someone who does not (or no longer) hold the authority does not count.
    expect((await thrown(() => desk(routes, body({ approvedBy: 'u-nobody' })))).body.code).toBe('approver_may_not_approve');
    expect(rec.recorded).toHaveLength(0);
  });
  it('an approval pays one return: this kind, this amount, this processor, unexpired, unspent (ADR-0022)', async () => {
    const { routes, rec } = stub({ cap: 100000 });
    const give = (approvalId: string, over: Partial<RefundApproval> = {}) =>
      rec.approvals.set(approvalId, { approval: approval({ approvalId, approvedBy: 'u-mgr', requestedBy: 'u-cash', valueMinor: 5000, ...over }) });
    const named = (approvalId: string, over: Record<string, unknown> = {}) => deskNamed(routes, { ...body({ approvedBy: undefined, ...over }), approvalId });

    expect((await thrown(() => named('rap-never'))).body.code).toBe('approval_unknown');
    give('rap-amount', { valueMinor: 4000 });
    expect((await thrown(() => named('rap-amount'))).body.code).toBe('approval_does_not_match');
    give('rap-other-person', { requestedBy: 'u-cash2' });
    expect((await thrown(() => named('rap-other-person'))).body.code).toBe('approval_does_not_match');
    give('rap-bill', { kind: 'refund', saleId: 'S1' });
    expect((await thrown(() => named('rap-bill'))).body.code).toBe('approval_does_not_match');
    give('rap-old', { expiresAt: NOW });
    expect((await thrown(() => named('rap-old'))).body.code).toBe('approval_expired');
    expect(rec.recorded).toHaveLength(0);

    give('rap-ok');
    const ok = await named('rap-ok');
    expect(ok.status).toBe(201);
    expect(rec.recorded[0]?.record).toMatchObject({ approvedBy: 'u-mgr', approvalId: 'rap-ok' });
    expect(rec.recorded[0]?.use).toEqual({ approvalId: 'rap-ok', usedBy: 'NR-1' });
    // Spent: a second return cannot use it again.
    expect((await thrown(() => named('rap-ok', { returnId: 'NR-2' }))).body.code).toBe('approval_already_used');
    expect(rec.recorded).toHaveLength(1);
  });
  it('a resold unit must say where it goes back — there is no bill to take the shelf from', async () => {
    const { routes, rec } = stub({ cap: 100000 });
    expect((await thrown(() => desk(routes, body({ locationId: undefined })))).body.code).toBe('resell_needs_a_location');
    // Quarantine / damaged / scrap re-enter no sellable stock, so no location is needed and none is recorded.
    const held = await desk(routes, body({ locationId: undefined, lines: [line({ disposition: 'damaged', condition: 'torn' })] }));
    expect(held.status).toBe(201);
    expect(rec.recorded[0]?.location).toBeUndefined();
    expect(rec.recorded[0]?.record.lines[0]).toMatchObject({ disposition: 'damaged', condition: 'torn' });
  });
  it('refuses an unreadable body (a negative refund, a bad disposition, a zero quantity) as 400', async () => {
    const { routes } = stub({ cap: 100000 });
    expect((await thrown(() => desk(routes, body({ refundMinor: -1 })))).status).toBe(400);
    expect((await thrown(() => desk(routes, body({ lines: [line({ disposition: 'eat' })] })))).status).toBe(400);
    expect((await thrown(() => desk(routes, body({ lines: [line({ quantityMinor: 0 })] })))).status).toBe(400);
    expect((await thrown(() => desk(routes, body({ reasonCode: '' })))).body.code).toBe('no_reason');
  });
  it('records a clean return against NO bill, under the authenticated processor, at the named location, and seals it', async () => {
    const { routes, rec } = stub({ cap: 100000 });
    const res = await desk(routes, body({ processedBy: 'u-forged' })); // processedBy in the body is ignored
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ returnId: 'NR-1', noReceipt: true, refundStatus: 'settled', restockedLines: 1, capMinor: 100000 });
    const { record, location, storeCredit } = rec.recorded[0]!;
    expect(record).toMatchObject({
      returnId: 'NR-1', originalSaleId: null, noReceipt: true, processedBy: 'u-cash', approvedBy: 'u-mgr',
      refundMinor: 5000, refundTender: 'cash', refundStatus: 'settled', locationId: 'store-main', processedAt: NOW,
    });
    expect(location).toEqual({ locationId: 'store-main', basis: 'declared_by_lane' });
    expect(storeCredit).toBeUndefined();
    // Sealed as a refund fact with no tender instrument (hard rule #3).
    expect(rec.audits[0]).toMatchObject({ actorId: 'u-cash', action: 'refund.accept', objectType: 'no_receipt_return', objectId: 'NR-1', correlationId: 'NR-1' });
    expect(rec.audits[0]?.after).toMatchObject({ noReceipt: 'yes', refundMinor: '5000', capMinor: '100000', approvedBy: 'u-mgr' });
    expect(JSON.stringify(rec.audits[0]?.after)).not.toContain('refundTender');
  });
  it('a card refund is PENDING (a provider reversal is never assumed settled — M13-FR-04)', async () => {
    const { routes } = stub({ cap: 100000 });
    expect((await desk(routes, body({ refundTender: 'card' }))).body).toMatchObject({ refundStatus: 'pending' });
  });
  it('store credit needs a customer and issues a real instrument within the store-credit cap (M13-FR-03)', async () => {
    const { routes, rec } = stub({ cap: 100000, scCap: 100000 });
    expect((await thrown(() => desk(routes, body({ refundTender: 'store_credit' })))).body.code).toBe('store_credit_needs_a_customer');
    const res = await desk(routes, body({ refundTender: 'store_credit', customerRef: 'c-asha' }));
    expect(res.status).toBe(201);
    expect((res.body as { storeCredit?: { balanceMinor: number } }).storeCredit?.balanceMinor).toBe(5000);
    expect(rec.recorded[0]?.storeCredit?.movement.deltaMinor).toBe(5000);
    expect(rec.recorded[0]?.record.customerRef).toBe('c-asha');
  });
  it('store credit is unavailable until the store-credit cap is set (its own fail-safe)', async () => {
    const { routes } = stub({ cap: 100000 });
    expect((await thrown(() => desk(routes, body({ refundTender: 'store_credit', customerRef: 'c-asha' })))).body.code).toBe('store_credit_unavailable');
  });
});

describe('the synced no-receipt return never rejects — record-and-flag (M13-FR-01, §31, hard rule #10)', () => {
  const lane = (over: Record<string, unknown> = {}) => ({
    returnId: 'NR-L1', processedBy: 'u-lanecash', reasonCode: 'no_receipt', lines: [line()], refundMinor: 5000,
    refundTender: 'cash', refundStatus: 'settled', laneId: 'lane-1', processedAt: '2026-10-06T09:00:00.000Z', ...over,
  });
  it('records a return taken with no cap set and no approver, flagging BOTH breaches', async () => {
    const { routes, rec } = stub();
    const res = await synced(routes, lane());
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ returnId: 'NR-L1', noReceipt: true, reconciled: true, flags: ['given_without_approval', 'no_receipt_over_cap'] });
    const { record, location } = rec.recorded[0]!;
    expect(record).toMatchObject({ originalSaleId: null, noReceipt: true, processedBy: 'u-lanecash', governanceFlags: ['given_without_approval', 'no_receipt_over_cap'], locationId: 'lane-1' });
    // No location named by the lane → assumed from the lane, and SAID SO (P-08).
    expect(location).toEqual({ locationId: 'lane-1', basis: 'assumed_from_lane' });
    expect(rec.audits[0]?.origin).toMatchObject({ capturedOffline: true });
    expect(rec.audits[0]?.after).toMatchObject({ flagged: 'yes', capMinor: 'not set' });
  });
  it('reconciles a clean lane return (approved by a genuine approver, within the cap) with no flags', async () => {
    const { routes, rec } = stub({ cap: 100000 });
    const res = await synced(routes, lane({ approvedBy: 'u-mgr', locationId: 'store-main' }));
    expect(res.body).toMatchObject({ flags: [] });
    expect(rec.recorded[0]?.record.governanceFlags).toBeUndefined();
    expect(rec.recorded[0]?.location).toEqual({ locationId: 'store-main', basis: 'declared_by_lane' });
  });
  it('flags a self-approval and an approver without authority, and an over-cap amount', async () => {
    const { routes } = stub({ cap: 4000 });
    expect((await synced(routes, lane({ approvedBy: 'u-lanecash' }))).body).toMatchObject({ flags: ['approved_by_the_processor', 'no_receipt_over_cap'] });
    expect((await synced(routes, lane({ returnId: 'NR-L2', approvedBy: 'u-nobody', refundMinor: 1000 }))).body).toMatchObject({ flags: ['approver_lacks_authority'] });
  });
  it('never trusts a card refund as settled, and flags store credit with no customer', async () => {
    const { routes, rec } = stub({ cap: 100000 });
    await synced(routes, lane({ approvedBy: 'u-mgr', refundTender: 'card', refundStatus: 'whatever' }));
    expect(rec.recorded[0]?.record.refundStatus).toBe('pending');
    const sc = await synced(routes, lane({ returnId: 'NR-L3', approvedBy: 'u-mgr', refundTender: 'store_credit' }));
    expect(sc.body).toMatchObject({ flags: ['store_credit_no_customer'] });
  });
  it('refuses only an unreadable payload (kept in the outbox for a person), as 400', async () => {
    const { routes } = stub({ cap: 100000 });
    expect((await thrown(() => synced(routes, { returnId: 'x' }))).status).toBe(400);
  });
});

describe('the no-receipt report — who gave, who approved, what it cost (M13-FR-01 reporting, M15)', () => {
  it('totals the register by processor and approver and counts the flagged ones', async () => {
    const { routes } = stub({ cap: 100000 });
    await desk(routes, body({ returnId: 'NR-1', refundMinor: 5000 }), 'u-cash');
    await desk(routes, body({ returnId: 'NR-2', refundMinor: 7000, approvedBy: 'u-mgr' }), 'u-cash2');
    await synced(routes, { returnId: 'NR-L1', processedBy: 'u-cash', reasonCode: 'r', lines: [line()], refundMinor: 900000, refundTender: 'cash', laneId: 'lane-1' });
    const res = await routeFor(routes, 'GET', '/v1/pos/no-receipt-returns').handler(ctx({ userId: 'u-owner' }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      count: 3, totalRefundedMinor: 912000, flaggedCount: 1,
      byProcessor: [{ userId: 'u-cash', count: 2, refundedMinor: 905000 }, { userId: 'u-cash2', count: 1, refundedMinor: 7000 }],
      byApprover: [{ userId: '', count: 1, refundedMinor: 900000 }, { userId: 'u-mgr', count: 2, refundedMinor: 12000 }],
      asAt: NOW,
    });
  });
  it('is pure over the register (empty → zeros)', () => {
    expect(noReceiptReport([], NOW)).toMatchObject({ count: 0, totalRefundedMinor: 0, flaggedCount: 0, byProcessor: [], byApprover: [], returns: [] });
  });
});
