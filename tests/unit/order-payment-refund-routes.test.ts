import { describe, it, expect } from 'vitest';
import { paymentRefundRoutes, type PaymentRefundDeps } from '../../services/orders/src/payments';
import { testModeRefundProcessor, type OrderPayment, type OrderRefund } from '../../packages/orders/src/payment-refunds';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import { actionDetails, fingerprintOf } from '../../services/identity/src/approval-requests';

/**
 * Route-level over a stubbed ledger (M18-FR-04 · M20-FR-03): the shapes each write refuses before anything is
 * recorded or sent, the one-payment-per-order rule, and that a refund is sent to the ORDER's token — never one in
 * the request — exactly once. The money story itself is proven through the real API in
 * `tests/integration/order-payments-and-refunds.test.ts`.
 */

const NOW = '2026-10-10T10:00:00.000Z';
const T = 't-sre';
/** The refund body as it will be sent — carrying a provider token of its own, which the route must ignore — and so what
 *  the approval below was asked for (the engine's own details rule). */
const REFUND = { refundId: 'r1', amountMinor: 1_000, basis: 'goodwill', reason: 'late', providerRef: 'tok_attacker' };
const REFUND_DETAILS = actionDetails(REFUND, { orderId: 'o1' });

function stub() {
  const l = { payments: [] as OrderPayment[], refunds: [] as OrderRefund[], sentTo: [] as string[], spent: false };
  const deps: PaymentRefundDeps = {
    now: () => NOW,
    orderState: (_t, id) => (id === 'o1' ? { state: 'placed', locationId: 'L1', lines: [] } : undefined),
    orderSubstitutions: () => [],
    orderPayment: (_t, id) => l.payments.find((p) => p.orderId === id),
    paymentResolution: () => undefined,
    recordPayment: (_t, p) => { l.payments.push(p); },
    recordPaymentResolution: () => {},
    orderRefunds: (_t, id) => l.refunds.filter((r) => r.orderId === id),
    refundOutcomes: () => [],
    recordRefund: (_t, r) => { l.refunds.push(r); },
    recordRefundOutcome: () => {},
    allPayments: () => l.payments, allPaymentResolutions: () => [], allRefunds: () => l.refunds, allRefundOutcomes: () => [],
    refundThreshold: () => 0,
    // Head office's engine, standing in: request areq-1 was asked by u-mgr for exactly the refund below and approved by
    // u-owner (who holds order.refund.approve) in their own session (ADR-0024). A typed approver is refused.
    approvals: {
      approvalState: (_t, id) => (id !== 'areq-1' ? undefined : {
        request: { requestId: 'areq-1', kind: 'order_refund', subjectRef: 'o1/r1', valueMinor: 1_000, fingerprint: fingerprintOf(REFUND_DETAILS), details: REFUND_DETAILS, summary: 'r', reason: 'late', requestedBy: 'u-mgr', requestedAt: '2026-10-07T00:00:00.000Z' },
        decision: { requestId: 'areq-1', decision: 'approved', decidedBy: 'u-owner', reason: 'ok', decidedAt: '2026-10-07T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' },
        ...(l.spent ? { usedBy: 'order-refund:o1/r1' } : {}),
      }),
      approvalVersion: () => 0,
      spendApproval: () => { l.spent = true; },
      permissionsOfUser: (_t, u) => (u === 'u-owner' ? ['order.refund.approve'] : []),
    },
    refundProcessor: { refund: async (input) => { l.sentTo.push(input.providerRef); return testModeRefundProcessor().refund(input); } },
  };
  return { l, routes: paymentRefundRoutes(deps) };
}
const ctx = (over: Partial<RequestContext>): RequestContext =>
  ({ tenantId: T, userId: 'u-mgr', branchId: null, params: { orderId: 'o1' }, query: {}, body: undefined, traceId: 't', ...over });
const routeFor = (routes: readonly Route[], method: string, path: string): Route => {
  const r = routes.find((x) => x.method === method && x.path === path);
  if (r === undefined) throw new Error(`no route ${method} ${path}`);
  return r;
};
interface Thrown { readonly status: number; readonly body: { readonly code: string } }
async function thrown(fn: () => unknown): Promise<Thrown> {
  try { await fn(); } catch (e) { return e as Thrown; }
  throw new Error('expected a refusal');
}

describe('payment and refund routes — refusals before anything is recorded', () => {
  it('exposes the six routes under the order money permissions', () => {
    const { routes } = stub();
    expect(routes.map((r) => [r.method, r.path, r.permission])).toEqual([
      ['POST', '/v1/orders/:orderId/payment', 'order.payment.record'],
      ['POST', '/v1/orders/:orderId/payment/resolution', 'order.payment.record'],
      ['POST', '/v1/orders/:orderId/refunds', 'order.refund.issue'],
      ['POST', '/v1/orders/:orderId/refunds/:refundId/outcome', 'order.refund.issue'],
      ['GET', '/v1/orders/refunds/pending', 'order.read'],
      ['GET', '/v1/orders/:orderId/refunds', 'order.read'],
    ]);
    expect(routes.filter((r) => r.method === 'POST').every((r) => r.idempotent === true)).toBe(true);
  });

  it('a payment body that cannot be read, a card-shaped reference, and an unknown order are each refused with nothing recorded', async () => {
    const s = stub();
    const post = routeFor(s.routes, 'POST', '/v1/orders/:orderId/payment');
    for (const body of [undefined, {}, { providerRef: 'tok', amountMinor: -1, result: 'authorised' }, { providerRef: 'tok', amountMinor: 10.5, result: 'authorised' }, { providerRef: 'tok', amountMinor: 1, result: 'maybe' }, { providerRef: 'tok', amountMinor: 1, result: 'authorised', reason: 5 }]) {
      expect((await thrown(() => post.handler(ctx({ body })))).body.code).toBe('not_readable_as_a_payment');
    }
    expect((await thrown(() => post.handler(ctx({ body: { providerRef: '5555-4444-3333-2222', amountMinor: 1, result: 'authorised' } })))).body.code).toBe('not_a_provider_token');
    expect((await thrown(() => post.handler(ctx({ params: { orderId: 'o-none' }, body: { providerRef: 'tok', amountMinor: 1, result: 'authorised' } })))).status).toBe(404);
    expect(s.l.payments).toEqual([]);
  });

  it('one payment per order: the second record is refused and points at the resolution route when the first was unknown', async () => {
    const s = stub();
    const post = routeFor(s.routes, 'POST', '/v1/orders/:orderId/payment');
    const first = await post.handler(ctx({ body: { providerRef: 'tok_1', amountMinor: 500, result: 'unknown', reason: 'timeout' } }));
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ payment: { state: 'pending' } });
    const again = await thrown(() => post.handler(ctx({ body: { providerRef: 'tok_1', amountMinor: 500, result: 'authorised' } })));
    expect(again.body.code).toBe('payment_already_recorded');
    expect((again.body as unknown as { nextSafeAction: string }).nextSafeAction).toContain('payment/resolution');
    expect(s.l.payments).toHaveLength(1);
  });

  it('a refund body that cannot be read is refused; a good one is sent to the ORDER\'s token, never the one in the request, exactly once', async () => {
    const s = stub();
    await routeFor(s.routes, 'POST', '/v1/orders/:orderId/payment').handler(ctx({ body: { providerRef: 'tok_order', amountMinor: 5_000, result: 'authorised' } }));
    const post = routeFor(s.routes, 'POST', '/v1/orders/:orderId/refunds');
    for (const body of [undefined, { refundId: 'r', amountMinor: 1, basis: 'pity', reason: 'x' }, { refundId: 'r', amountMinor: 1, basis: 'goodwill' }, { refundId: 'r', amountMinor: 1.5, basis: 'goodwill', reason: 'x' }, { refundId: 'r', amountMinor: 1, basis: 'goodwill', reason: 'x', approvedBy: 9 }]) {
      expect((await thrown(() => post.handler(ctx({ body })))).body.code).toBe('not_readable_as_a_refund');
    }
    // A typed approver is refused by name — naming a person is not their approval (audit PA-03).
    expect((await thrown(() => post.handler(ctx({ body: { ...REFUND, approvedBy: 'u-owner' } })))).body.code).toBe('approver_named_without_approval');
    // Anything not exactly what was approved is refused — here, a different refund.
    expect((await thrown(() => post.handler(ctx({ body: { ...REFUND, refundId: 'r2', approvalId: 'areq-1' } })))).body.code).toBe('approval_does_not_match');
    const res = await post.handler(ctx({ body: { ...REFUND, approvalId: 'areq-1' } }));
    expect(res.status).toBe(201);
    expect(s.l.spent).toBe(true);
    expect(s.l.sentTo).toEqual(['tok_order']);
    expect(s.l.refunds).toHaveLength(1);
    // Same id, same amount and basis → the record, not a second send.
    const same = await post.handler(ctx({ body: { ...REFUND, approvalId: 'areq-1' } }));
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ alreadyRecorded: true });
    expect(s.l.sentTo).toEqual(['tok_order']);
  });

  it('a refund outcome body that cannot be read is refused', async () => {
    const s = stub();
    const post = routeFor(s.routes, 'POST', '/v1/orders/:orderId/refunds/:refundId/outcome');
    expect((await thrown(() => post.handler(ctx({ params: { orderId: 'o1', refundId: 'r1' }, body: { result: 'maybe', evidenceRef: 'x' } })))).body.code).toBe('not_readable_as_an_outcome');
    expect((await thrown(() => post.handler(ctx({ params: { orderId: 'o1', refundId: 'r1' }, body: { result: 'refunded' } })))).body.code).toBe('not_readable_as_an_outcome');
  });
});
