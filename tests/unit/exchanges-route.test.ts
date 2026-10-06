import { describe, it, expect } from 'vitest';
import { exchangeRoutes, EXCHANGE_CREDIT_TENDER, type ExchangeDeps } from '../../services/pos/src/exchanges';
import type { ReturnRecord, StoreCreditIssue } from '../../services/pos/src/returns';
import type { IncomingSale, SaleException } from '../../services/pos/src/sale-intake';
import type { CatalogueProduct } from '../../packages/catalogue/src/catalogue';
import type { OriginalSale, RecordedReturn } from '../../packages/returns/src/return-register';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import type { AuditEntry } from '../../packages/audit/src/index';
import type { ApprovalUse, RefundApprovalKind, RefundApprovalState } from '../../services/pos/src/refund-approvals';

/**
 * **M13-FR-03 — exchanges on the cloud (un-parks the second half of CH-01).** Route-level with stubbed
 * stores: the balance follows the money (even → no approver; top-up → tenders must add up; refund → the
 * refund's own tender/threshold/§28 rules), the replacement is banked as a real sale paid out of the returned
 * value, and both halves are handed to ONE atomic record call.
 */

const NOW = '2026-10-06T10:00:00.000Z';
const AT = '2026-10-05T10:00:00.000Z';
const T = 't-sre';

const banked: IncomingSale = {
  saleId: 'S1', receiptNumber: 'R-1', laneId: 'lane-1', locationId: 'store-main', cashierId: 'u-cash', tradingDay: '2026-10-05', committedAt: AT,
  totalMinor: 23000, currency: 'INR', packVersion: 3,
  lines: [
    { productId: 'P1', quantityMinor: 3, uom: 'each', unitPriceMinor: 5000, lineTotalMinor: 15000 },
    { productId: 'P2', quantityMinor: 1, uom: 'each', unitPriceMinor: 8000, lineTotalMinor: 8000 },
  ],
  tenders: [{ kind: 'cash', amountMinor: 23000 }],
};
const original: OriginalSale = {
  saleId: 'S1', number: 'R-1', tradingDay: '2026-10-05', committedAt: AT, totalMinor: 23000,
  lines: banked.lines.map((l) => ({ productId: l.productId, uom: l.uom, quantityMinor: l.quantityMinor, lineTotalMinor: l.lineTotalMinor })),
  tenders: [{ kind: 'cash', amountMinor: 23000 }],
};

interface Rec {
  threshold: number | undefined; window: number | undefined; scCap: number | undefined;
  approvers: Set<string>; catalogue: Map<string, CatalogueProduct>; bankedIds: Set<string>;
  prior: RecordedReturn[]; refunds: { returnId: string; originalSaleId: string | null; refundMinor: number }[];
  exchanges: { record: ReturnRecord; replacement: IncomingSale; storeCredit: StoreCreditIssue | undefined; uses: readonly ApprovalUse[] }[];
  exceptions: SaleException[]; audits: AuditEntry[];
  /** Approvals head office gave (ADR-0022), by id — and the exchange that spent each. */
  approvals: Map<string, RefundApprovalState>;
}
/** Each stub's approval register, reachable from its routes so `post` can have the named approver give one. */
const approvalsOf = new WeakMap<readonly Route[], Map<string, RefundApprovalState>>();
function stub(over: Partial<Rec> = {}) {
  const rec: Rec = {
    threshold: undefined, window: undefined, scCap: undefined, approvers: new Set(['u-mgr']),
    catalogue: new Map<string, CatalogueProduct>([['P1', { productId: 'P1', sku: 'P1', name: 'P1', unitPriceMinor: 5000, taxBps: 500, status: 'active', uom: 'each' } as unknown as CatalogueProduct], ['P3', { productId: 'P3', sku: 'P3', name: 'P3', unitPriceMinor: 5000, taxBps: 500, status: 'active', uom: 'each' } as unknown as CatalogueProduct]]),
    bankedIds: new Set(['S1']), prior: [], refunds: [], exchanges: [], exceptions: [], audits: [], approvals: new Map(), ...over,
  };
  const deps: ExchangeDeps = {
    originalSale: (_t, saleId) => (saleId === 'S1' ? original : undefined),
    bankedSale: (_t, saleId) => (saleId === 'S1' ? banked : undefined),
    priorReturns: () => rec.prior, priorRefunds: () => rec.refunds,
    refundThreshold: () => rec.threshold, returnWindow: () => rec.window, storeCreditCap: () => rec.scCap,
    canApproveRefund: (_t, u) => rec.approvers.has(u),
    catalogue: () => rec.catalogue, currentPackVersion: () => 7,
    saleHoldingReceipt: () => undefined, isBanked: (_t, id) => rec.bankedIds.has(id),
    recordExceptions: (_t, ex) => { rec.exceptions.push(...ex); },
    recordExchange: (_t, _sale, record, replacement, storeCredit, _version, uses = []) => {
      rec.exchanges.push({ record, replacement, storeCredit, uses });
      for (const u of uses) rec.approvals.set(u.approvalId, { ...rec.approvals.get(u.approvalId)!, usedBy: u.usedBy });
      rec.prior.push({ returnId: record.returnId, originalSaleId: record.originalSaleId, processedAt: record.processedAt, lines: record.lines });
      rec.refunds.push({ returnId: record.returnId, originalSaleId: record.originalSaleId, refundMinor: record.refundMinor });
      rec.bankedIds.add(replacement.saleId);
    },
    recordAudit: (_t, e) => { rec.audits.push(e); },
    refundApproval: (_t, id) => rec.approvals.get(id),
    now: () => NOW,
  };
  const routes = exchangeRoutes(deps);
  approvalsOf.set(routes, rec.approvals);
  return { rec, routes };
}
const ctx = (over: Partial<RequestContext>): RequestContext =>
  ({ tenantId: T, userId: 'u-cash', branchId: null, params: { saleId: 'S1' }, query: {}, body: undefined, traceId: 't', ...over });
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
const back = (productId: string, qty: number, disposition = 'resell') => ({ productId, uom: 'each', quantityMinor: qty, disposition });
const out = (productId: string, qty: number, unitPriceMinor: number) => ({ productId, uom: 'each', quantityMinor: qty, unitPriceMinor, lineTotalMinor: qty * unitPriceMinor });
const body = (over: Record<string, unknown> = {}) => ({
  exchangeId: 'X1', reasonCode: 'wrong_size', returnLines: [back('P1', 1)],
  replacement: { saleId: 'S1-X1', receiptNumber: 'R-1X', lines: [out('P3', 1, 5000)] },
  ...over,
});
/** The route as the desk calls it — the body's `approvedBy` / `outOfWindowApprovedBy` having approved in their own
 *  session first (the route that gives an approval is proven in refund-approvals.test.ts), so the body names those
 *  approvals (ADR-0022): the balance refunded (₹20 for the `cheaper` replacement) and the value coming back (₹50).
 *  `postNamed` sends the body as written — the audit's PF-02 reproduction. */
const postNamed = (routes: readonly Route[], b: unknown, over: Partial<RequestContext> = {}) =>
  routeFor(routes, 'POST', '/v1/sales/:saleId/exchanges').handler(ctx({ body: b, ...over }));
const post = (routes: readonly Route[], b: Record<string, unknown>, over: Partial<RequestContext> = {}, values = { balanceMinor: 2000, returnedMinor: 5000 }) => {
  const { approvedBy, outOfWindowApprovedBy, ...rest } = b;
  const register = approvalsOf.get(routes)!;
  const give = (kind: RefundApprovalKind, approver: string, valueMinor: number): string => {
    const approvalId = `rap-${kind}-${String(b['exchangeId'])}-${approver}`;
    register.set(approvalId, { approval: {
      approvalId, kind, saleId: over.params?.['saleId'] ?? 'S1', valueMinor, requestedBy: over.userId ?? 'u-cash', approvedBy: approver,
      reason: 'test', givenAt: NOW, expiresAt: '2026-10-06T10:15:00.000Z',
    } });
    return approvalId;
  };
  return postNamed(routes, {
    ...rest,
    ...(typeof approvedBy === 'string' ? { approvalId: give('exchange_refund', approvedBy, values.balanceMinor) } : {}),
    ...(typeof outOfWindowApprovedBy === 'string' ? { outOfWindowApprovalId: give('out_of_window', outOfWindowApprovedBy, values.returnedMinor) } : {}),
  }, over);
};

describe('an even exchange — no money moves, no approver needed (M13-FR-03)', () => {
  it('credits the bill at the ORIGINAL price and banks the replacement as a real sale paid by exchange credit, in one call', async () => {
    const { routes, rec } = stub();
    const res = await post(routes, body());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      exchangeId: 'X1', originalSaleId: 'S1', replacementSaleId: 'S1-X1', returnedValueMinor: 5000, replacementTotalMinor: 5000,
      balance: { kind: 'even', amountMinor: 0 }, restockedLines: 1,
      remaining: [{ productId: 'P1', returnableMinor: 2 }, { productId: 'P2', returnableMinor: 1 }],
    });
    expect(rec.exchanges).toHaveLength(1);
    const { record, replacement, storeCredit } = rec.exchanges[0]!;
    expect(record).toMatchObject({
      returnId: 'X1', originalSaleId: 'S1', processedBy: 'u-cash', refundMinor: 5000, refundTender: 'exchange', refundStatus: 'settled',
      exchange: { exchangeId: 'X1', replacementSaleId: 'S1-X1', replacementTotalMinor: 5000, appliedMinor: 5000, balance: 'even', balanceMinor: 0 },
    });
    expect(replacement).toMatchObject({
      saleId: 'S1-X1', receiptNumber: 'R-1X', laneId: 'lane-1', locationId: 'store-main', cashierId: 'u-cash', tradingDay: '2026-10-06', committedAt: NOW,
      totalMinor: 5000, currency: 'INR', packVersion: 7,
      tenders: [{ kind: EXCHANGE_CREDIT_TENDER, amountMinor: 5000 }],
    });
    expect(storeCredit).toBeUndefined();
    expect(rec.audits[0]).toMatchObject({ action: 'exchange.accept', objectType: 'sale', objectId: 'S1', actorId: 'u-cash', correlationId: 'X1' });
    expect(rec.audits[0]?.after).toMatchObject({ balance: 'even', balanceMinor: '0', returnedValueMinor: '5000' });
  });
  it('refuses tenders on an even exchange — nothing is owed', async () => {
    const { routes } = stub();
    expect((await thrown(() => post(routes, body({ settlement: { topUpTenders: [{ kind: 'cash', amountMinor: 100 }] } })))).body.code).toBe('top_up_not_owed');
  });
  it('the replacement\'s intake findings are recorded and shown, never a refusal (a product not in the catalogue)', async () => {
    const { routes, rec } = stub();
    const res = await post(routes, body({ replacement: { saleId: 'S1-X1', receiptNumber: 'R-1X', lines: [out('P-NEW', 1, 5000)] } }));
    expect(res.status).toBe(201);
    expect((res.body as { replacementIntake: { exceptions: { kind: string }[] } }).replacementIntake.exceptions.map((e) => e.kind)).toContain('product_not_in_catalogue');
    expect(rec.exceptions.map((e) => e.kind)).toContain('product_not_in_catalogue');
  });
});

describe('a top-up — the customer pays the difference (M13-FR-03)', () => {
  it('needs tenders that add to exactly the balance, and banks them on the replacement beside the exchange credit', async () => {
    const { routes, rec } = stub();
    const dearer = { saleId: 'S1-X1', receiptNumber: 'R-1X', lines: [out('P3', 1, 7500)] };
    expect((await thrown(() => post(routes, body({ replacement: dearer })))).body.code).toBe('top_up_does_not_match_balance');
    expect((await thrown(() => post(routes, body({ replacement: dearer, settlement: { topUpTenders: [{ kind: 'cash', amountMinor: 2000 }] } })))).body.code).toBe('top_up_does_not_match_balance');
    const res = await post(routes, body({ replacement: dearer, settlement: { topUpTenders: [{ kind: 'upi', amountMinor: 2500, ref: 'upi-txn-77' }] } }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ balance: { kind: 'top_up', amountMinor: 2500, tenders: [{ kind: 'upi', amountMinor: 2500 }] } });
    expect(rec.exchanges[0]?.replacement.tenders).toEqual([{ kind: EXCHANGE_CREDIT_TENDER, amountMinor: 5000 }, { kind: 'upi', amountMinor: 2500, ref: 'upi-txn-77' }]);
    expect(rec.exchanges[0]?.record.exchange).toMatchObject({ balance: 'top_up', balanceMinor: 2500, topUpTenders: [{ kind: 'upi', amountMinor: 2500 }] });
    // No approver was needed: no money left the shop.
    expect(rec.exchanges[0]?.record.approvedBy).toBeUndefined();
  });
  it('refuses a tender reference that looks like a card number (hard rule #3)', async () => {
    const { routes } = stub();
    const dearer = { saleId: 'S1-X1', receiptNumber: 'R-1X', lines: [out('P3', 1, 7500)] };
    expect((await thrown(() => post(routes, body({ replacement: dearer, settlement: { topUpTenders: [{ kind: 'card', amountMinor: 2500, ref: '4111 1111 1111 1111' }] } })))).body.code).toBe('card_data_refused');
  });
});

describe('a refund of the balance — the refund\'s own rules (M13-FR-03, §28)', () => {
  const cheaper = { saleId: 'S1-X1', receiptNumber: 'R-1X', lines: [out('P3', 1, 3000)] };
  it('needs a refund tender, and at the default threshold (0) a genuine second person', async () => {
    const { routes, rec } = stub();
    expect((await thrown(() => post(routes, body({ replacement: cheaper })))).body.code).toBe('refund_tender_required');
    expect((await thrown(() => post(routes, body({ replacement: cheaper, settlement: { refundTender: 'cash' } })))).body.code).toBe('needs_a_second_person');
    // The audit's PF-02 reproduction: a genuine manager NAMED in the body, who never approved — refused.
    expect((await thrown(() => postNamed(routes, body({ replacement: cheaper, settlement: { refundTender: 'cash' }, approvedBy: 'u-mgr' })))).body.code).toBe('approver_named_without_approval');
    expect((await thrown(() => post(routes, body({ replacement: cheaper, settlement: { refundTender: 'cash' }, approvedBy: 'u-nobody' })))).body.code).toBe('approver_may_not_approve');
    // An approval for a different balance does not pay this one.
    expect((await thrown(() => post(routes, body({ replacement: cheaper, settlement: { refundTender: 'cash' }, approvedBy: 'u-mgr' }), {}, { balanceMinor: 2500, returnedMinor: 5000 }))).body.code).toBe('approval_does_not_match');
    expect((await thrown(() => post(routes, body({ replacement: cheaper, settlement: { refundTender: 'cash', topUpTenders: [{ kind: 'cash', amountMinor: 1 }] }, approvedBy: 'u-mgr' })))).body.code).toBe('top_up_not_owed');
    const res = await post(routes, body({ replacement: cheaper, settlement: { refundTender: 'cash' }, approvedBy: 'u-mgr' }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ balance: { kind: 'refund', amountMinor: 2000, tender: 'cash', refundStatus: 'settled' } });
    expect(rec.exchanges[0]?.record).toMatchObject({ refundMinor: 5000, approvedBy: 'u-mgr', approvalId: 'rap-exchange_refund-X1-u-mgr', exchange: { balance: 'refund', balanceMinor: 2000, balanceTender: 'cash', appliedMinor: 3000 } });
    // Spent in the same record call — one approval pays one exchange.
    expect(rec.exchanges[0]?.uses).toEqual([{ approvalId: 'rap-exchange_refund-X1-u-mgr', usedBy: 'X1' }]);
    expect((await thrown(() => postNamed(routes, body({ exchangeId: 'X9', replacement: { ...cheaper, saleId: 'S1-X9' }, settlement: { refundTender: 'cash' }, approvalId: 'rap-exchange_refund-X1-u-mgr' })))).body.code).toBe('approval_already_used');
    expect(rec.exchanges[0]?.replacement.tenders).toEqual([{ kind: EXCHANGE_CREDIT_TENDER, amountMinor: 3000 }]);
  });
  it('below the owner\'s threshold no approver is needed; a card balance is PENDING (M13-FR-04)', async () => {
    const { routes, rec } = stub({ threshold: 5000 });
    const res = await post(routes, body({ replacement: cheaper, settlement: { refundTender: 'card' } }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ balance: { kind: 'refund', amountMinor: 2000, refundStatus: 'pending' } });
    expect(rec.exchanges[0]?.record.refundStatus).toBe('pending');
  });
  it('store credit for the balance needs a customer and the store-credit cap, and is issued in the same batch', async () => {
    const { routes, rec } = stub({ scCap: 100000 });
    expect((await thrown(() => post(routes, body({ replacement: cheaper, settlement: { refundTender: 'store_credit' }, approvedBy: 'u-mgr' })))).body.code).toBe('store_credit_needs_a_customer');
    const res = await post(routes, body({ replacement: cheaper, settlement: { refundTender: 'store_credit', customerRef: 'c-asha' }, approvedBy: 'u-mgr' }));
    expect(res.status).toBe(201);
    expect((res.body as { storeCredit?: { balanceMinor: number } }).storeCredit?.balanceMinor).toBe(2000);
    expect(rec.exchanges[0]?.storeCredit?.movement.deltaMinor).toBe(2000);
    expect(rec.exchanges[0]?.record.customerRef).toBe('c-asha');
    const { routes: noCap } = stub();
    expect((await thrown(() => post(noCap, body({ replacement: cheaper, settlement: { refundTender: 'store_credit', customerRef: 'c-asha' }, approvedBy: 'u-mgr' })))).body.code).toBe('store_credit_unavailable');
  });
});

describe('the bill, the window and the ids', () => {
  it('404 for a bill this system never banked; the replacement must have its own, unused sale id', async () => {
    const { routes } = stub();
    expect((await thrown(() => post(routes, body(), { params: { saleId: 'S-NOPE' } }))).status).toBe(404);
    expect((await thrown(() => post(routes, body({ replacement: { saleId: 'S1', receiptNumber: 'R-1X', lines: [out('P3', 1, 5000)] } })))).body.code).toBe('replacement_is_the_original');
    const { routes: taken } = stub({ bankedIds: new Set(['S1', 'S1-X1']) });
    expect((await thrown(() => post(taken, body()))).status).toBe(409);
  });
  it('the same exchange resent is accepted again (its own ids dedup); a different exchange cannot reuse its sale id', async () => {
    const { routes, rec } = stub();
    expect((await post(routes, body())).status).toBe(201);
    expect((await post(routes, body())).status).toBe(201); // idempotent retry: assessed as new, same ids
    expect(rec.exchanges).toHaveLength(2);
    expect((await thrown(() => post(routes, body({ exchangeId: 'X2' })))).body.code).toBe('replacement_sale_id_in_use');
  });
  it('the register rules hold across the whole history — the second exchange cannot take back what already came back', async () => {
    const { routes } = stub();
    await post(routes, body({ returnLines: [back('P1', 3)], replacement: { saleId: 'S1-X1', receiptNumber: 'R-1X', lines: [out('P3', 3, 5000)] } }));
    expect((await thrown(() => post(routes, body({ exchangeId: 'X2', replacement: { saleId: 'S1-X2', receiptNumber: 'R-2X', lines: [out('P3', 1, 5000)] } })))).body.code).toBe('more_than_was_sold');
  });
  it('honours the owner\'s return window with the supervisor override, exactly like a return (M13-FR-02)', async () => {
    const { routes, rec } = stub({ window: 0 }); // same-day only; the exchange is a day later
    const e = await thrown(() => post(routes, body()));
    expect(e.status).toBe(422);
    expect((await thrown(() => postNamed(routes, body({ outOfWindowApprovedBy: 'u-mgr' })))).body.code).toBe('approver_named_without_approval');
    expect((await thrown(() => post(routes, body({ outOfWindowApprovedBy: 'u-nobody' })))).body.code).toBe('approver_may_not_approve');
    expect((await thrown(() => post(routes, body({ outOfWindowApprovedBy: 'u-mgr' }), {}, { balanceMinor: 2000, returnedMinor: 4000 }))).body.code).toBe('approval_does_not_match');
    expect((await post(routes, body({ outOfWindowApprovedBy: 'u-mgr' }))).status).toBe(201);
    expect(rec.audits[0]?.after).toMatchObject({ outOfWindowApprovedBy: 'u-mgr' });
  });
  it('refuses an unreadable body as 400 and an empty reason as no_reason', async () => {
    const { routes } = stub();
    expect((await thrown(() => post(routes, { exchangeId: 'X1' }))).status).toBe(400);
    expect((await thrown(() => post(routes, body({ replacement: { saleId: 'S1-X1', receiptNumber: 'R-1X', lines: [{ productId: 'P3', uom: 'each', quantityMinor: 1 }] } })))).status).toBe(400);
    expect((await thrown(() => post(routes, body({ reasonCode: '' })))).body.code).toBe('no_reason');
  });
});
