import { describe, it, expect } from 'vitest';
import {
  looksLikeCardNumber, paymentPosition, refundPosition, foldRefunds, planOrderRefund, testModeRefundProcessor, refundMessage,
  type OrderPayment, type OrderRefund, type OrderRefundOutcome, type RefundPosition,
} from '../../packages/orders/src/payment-refunds';

/**
 * **The order's payment and refunds — the pure kernel (M18-FR-04 · M20-FR-03 · §28 · §31 · #3).**
 *
 * A payment is what the checkout answered: authorised, declined, or unknown — and unknown is NOT paid until the
 * bank says. A refund goes back to the order's own token for an amount the ledger can vouch for, approved per
 * policy, and a processor that does not answer leaves a PENDING refund that is never reported as done.
 */

const AT = '2026-10-10T10:00:00.000Z';
const payment = (over: Partial<OrderPayment> = {}): OrderPayment =>
  ({ orderId: 'o1', providerRef: 'tok_abc123', amountMinor: 50_000, result: 'authorised', recordedBy: 'u-app', recordedAt: AT, ...over });
const refund = (over: Partial<OrderRefund> = {}): OrderRefund =>
  ({ refundId: 'r1', orderId: 'o1', amountMinor: 10_000, basis: 'goodwill', reason: 'late', requestedBy: 'u-mgr', approvedBy: 'u-owner', providerOutcome: 'refunded', state: 'issued', at: AT, ...over });
const outcome = (over: Partial<OrderRefundOutcome> = {}): OrderRefundOutcome =>
  ({ refundId: 'r1', orderId: 'o1', result: 'refunded', evidenceRef: 'stmt-1', resolvedBy: 'u-acct', at: AT, ...over });

describe('looksLikeCardNumber — hard rule #3 at the door', () => {
  it('refuses 13–19 digit strings, with or without spaces and dashes, and accepts a token', () => {
    expect(looksLikeCardNumber('4111111111111111')).toBe(true);
    expect(looksLikeCardNumber('4111 1111 1111 1111')).toBe(true);
    expect(looksLikeCardNumber('4111-1111-1111-1111')).toBe(true);
    expect(looksLikeCardNumber('tok_4111111111111111')).toBe(false);
    expect(looksLikeCardNumber('12345')).toBe(false);
  });
});

describe('paymentPosition — what the customer has actually paid', () => {
  it('no payment → none, nothing paid; authorised → paid the amount', () => {
    expect(paymentPosition(undefined, undefined)).toMatchObject({ state: 'none', paidMinor: 0 });
    expect(paymentPosition(payment(), undefined)).toMatchObject({ state: 'authorised', paidMinor: 50_000, providerRef: 'tok_abc123' });
  });
  it('declined → nothing paid; unknown → PENDING with nothing paid, until a resolution says which', () => {
    expect(paymentPosition(payment({ result: 'declined', reason: 'insufficient funds' }), undefined)).toMatchObject({ state: 'declined', paidMinor: 0 });
    const pending = paymentPosition(payment({ result: 'unknown' }), undefined);
    expect(pending).toMatchObject({ state: 'pending', paidMinor: 0 });
    expect(pending.detail).toContain('must not be picked');
    expect(paymentPosition(payment({ result: 'unknown' }), { orderId: 'o1', result: 'authorised', evidenceRef: 'stmt', resolvedBy: 'u', resolvedAt: AT })).toMatchObject({ state: 'authorised', paidMinor: 50_000 });
    expect(paymentPosition(payment({ result: 'unknown' }), { orderId: 'o1', result: 'declined', evidenceRef: 'stmt', resolvedBy: 'u', resolvedAt: AT })).toMatchObject({ state: 'declined', paidMinor: 0 });
  });
  it('a resolution never overrides an answer the checkout already had', () => {
    expect(paymentPosition(payment({ result: 'authorised' }), { orderId: 'o1', result: 'declined', evidenceRef: 'x', resolvedBy: 'u', resolvedAt: AT }).state).toBe('authorised');
  });
});

describe('refundPosition / foldRefunds — refunded, pending, refundable', () => {
  it('issued refunds reduce the refundable amount; pending ones are held out too; refused ones do not count', () => {
    const pos = refundPosition({
      payment: paymentPosition(payment(), undefined),
      refunds: [refund({ refundId: 'a', amountMinor: 10_000 }), refund({ refundId: 'b', amountMinor: 5_000, providerOutcome: 'unknown', state: 'pending' }), refund({ refundId: 'c', amountMinor: 7_000, providerOutcome: 'declined', state: 'refused' })],
      outcomes: [],
    });
    expect(pos).toMatchObject({ paidMinor: 50_000, refundedMinor: 10_000, pendingMinor: 5_000, refundableMinor: 35_000 });
    expect(pos.refunds.map((r) => r.effectiveState)).toEqual(['issued', 'pending', 'refused']);
  });
  it('a pending refund becomes issued or refused by its FIRST outcome; a later one is ignored', () => {
    const views = foldRefunds(
      [refund({ refundId: 'b', providerOutcome: 'unknown', state: 'pending' })],
      [outcome({ refundId: 'b', result: 'declined', evidenceRef: 'first' }), outcome({ refundId: 'b', result: 'refunded', evidenceRef: 'second' })],
    );
    expect(views[0]).toMatchObject({ effectiveState: 'refused', outcome: { evidenceRef: 'first' } });
    const pos = refundPosition({ payment: paymentPosition(payment(), undefined), refunds: [refund({ refundId: 'b', providerOutcome: 'unknown', state: 'pending' })], outcomes: [outcome({ refundId: 'b', result: 'refunded' })] });
    expect(pos).toMatchObject({ refundedMinor: 10_000, pendingMinor: 0, refundableMinor: 40_000 });
  });
  it('an outcome on a refund that was never pending changes nothing', () => {
    expect(foldRefunds([refund({ state: 'issued' })], [outcome({ result: 'declined' })])[0]?.effectiveState).toBe('issued');
  });
  it('never reports a negative refundable amount', () => {
    const pos = refundPosition({ payment: paymentPosition(payment({ amountMinor: 1_000 }), undefined), refunds: [refund({ amountMinor: 5_000 })], outcomes: [] });
    expect(pos.refundableMinor).toBe(0);
  });
});

describe('planOrderRefund — from recorded facts only', () => {
  const paid = paymentPosition(payment(), undefined);
  const position = (refunds: OrderRefund[] = []): RefundPosition => refundPosition({ payment: paid, refunds, outcomes: [] });
  const base = { payment: paid, position: position(), amountMinor: 10_000, basis: 'goodwill' as const, substitutionRefundDueMinor: 0, requestedBy: 'u-mgr', approvedBy: 'u-owner', approverHoldsAuthority: true, approvalThresholdMinor: 0 };

  it('refuses when there is no authorised payment, or the payment is still pending', () => {
    expect(planOrderRefund({ ...base, payment: paymentPosition(undefined, undefined) })).toMatchObject({ ok: false, refusedBecause: 'order_not_paid' });
    expect(planOrderRefund({ ...base, payment: paymentPosition(payment({ result: 'declined' }), undefined) })).toMatchObject({ ok: false, refusedBecause: 'order_not_paid' });
    expect(planOrderRefund({ ...base, payment: paymentPosition(payment({ result: 'unknown' }), undefined) })).toMatchObject({ ok: false, refusedBecause: 'payment_pending' });
  });
  it('refuses nothing, a fraction, and more than is refundable — counting pending refunds as committed', () => {
    expect(planOrderRefund({ ...base, amountMinor: 0 })).toMatchObject({ ok: false, refusedBecause: 'nothing_to_refund' });
    expect(planOrderRefund({ ...base, amountMinor: 10.5 })).toMatchObject({ ok: false, refusedBecause: 'nothing_to_refund' });
    expect(planOrderRefund({ ...base, amountMinor: 50_001 })).toMatchObject({ ok: false, refusedBecause: 'exceeds_refundable' });
    const withPending = position([refund({ refundId: 'p', amountMinor: 45_000, providerOutcome: 'unknown', state: 'pending' })]);
    expect(planOrderRefund({ ...base, position: withPending, amountMinor: 6_000 })).toMatchObject({ ok: false, refusedBecause: 'exceeds_refundable' });
    expect(planOrderRefund({ ...base, position: withPending, amountMinor: 5_000 }).ok).toBe(true);
  });
  it('a substitution refund never exceeds what the recorded substitutions owe, less what was already refunded on that basis', () => {
    expect(planOrderRefund({ ...base, basis: 'substitution', amountMinor: 2_000, substitutionRefundDueMinor: 2_000 }).ok).toBe(true);
    expect(planOrderRefund({ ...base, basis: 'substitution', amountMinor: 2_001, substitutionRefundDueMinor: 2_000 })).toMatchObject({ ok: false, refusedBecause: 'basis_not_recorded' });
    const already = position([refund({ refundId: 's', basis: 'substitution', amountMinor: 1_500 })]);
    expect(planOrderRefund({ ...base, position: already, basis: 'substitution', amountMinor: 1_000, substitutionRefundDueMinor: 2_000 })).toMatchObject({ ok: false, refusedBecause: 'basis_not_recorded' });
    expect(planOrderRefund({ ...base, position: already, basis: 'substitution', amountMinor: 500, substitutionRefundDueMinor: 2_000 }).ok).toBe(true);
  });
  it('approval per policy (§28): none named, the requester approving themselves, or an approver without authority all refuse; below the threshold nobody is needed', () => {
    expect(planOrderRefund({ ...base, approvedBy: undefined })).toMatchObject({ ok: false, refusedBecause: 'given_without_approval' });
    expect(planOrderRefund({ ...base, approvedBy: 'u-mgr' })).toMatchObject({ ok: false, refusedBecause: 'approved_by_the_processor' });
    expect(planOrderRefund({ ...base, approverHoldsAuthority: false })).toMatchObject({ ok: false, refusedBecause: 'approver_lacks_authority' });
    expect(planOrderRefund({ ...base, approvedBy: undefined, approvalThresholdMinor: 20_000 }).ok).toBe(true);
    expect(planOrderRefund({ ...base, approvedBy: undefined, amountMinor: 20_000, approvalThresholdMinor: 20_000 })).toMatchObject({ ok: false, refusedBecause: 'given_without_approval' });
  });
});

describe('testModeRefundProcessor — deterministic on the token, never a bank', () => {
  it('refunds by default, declines a -declines token, gives no answer for a -unknown token', async () => {
    const p = testModeRefundProcessor();
    expect(await p.refund({ refundId: 'r1', providerRef: 'tok_ok', amountMinor: 1, currency: 'INR' })).toMatchObject({ result: 'refunded', providerRefundRef: 'rf-test-r1' });
    expect((await p.refund({ refundId: 'r2', providerRef: 'tok-declines', amountMinor: 1, currency: 'INR' })).result).toBe('declined');
    expect((await p.refund({ refundId: 'r3', providerRef: 'tok-unknown', amountMinor: 1, currency: 'INR' })).result).toBe('unknown');
  });
  it('the customer is told the truth for each state — a pending refund is never called done', () => {
    expect(refundMessage('issued', 500)).toContain('have refunded');
    expect(refundMessage('pending', 500)).toContain('waiting for it to confirm');
    expect(refundMessage('refused', 500)).toContain('did not accept');
  });
});
