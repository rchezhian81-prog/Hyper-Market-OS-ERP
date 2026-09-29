// The order's payment and its refunds — M18-FR-04 · M20-FR-03 · M23-FR-03 · §28 · §31 · hard rules #2, #3.
//
// Until now the cloud's order knew nothing about its money: the storefront took a payment answer in the
// customer's browser, and a cancellation or a cheaper substitute left a "refund due" as a fact with nowhere
// to go. This is the pure kernel for both halves:
//
//   • the PAYMENT is recorded once against the order as the checkout answered it — `authorised` (paid),
//     `declined`, or `unknown` (the bank has not said; the order is NOT confirmed and must not be picked —
//     §31, "no fake approval"). Only a provider TOKEN is ever recorded (#3): a reference that looks like a
//     card number is refused before anything is written.
//   • a REFUND goes back to where the money came from — the order's own token, never one supplied with the
//     request — for an amount the ledger can vouch for: never more than was paid less what is already
//     refunded or in flight, and on a `substitution` basis never more than the substitutions recorded as
//     owing. It is approved per policy (§28: an approver who is not the requester and holds the authority,
//     above the tenant's threshold). The processor's answer is recorded as it came: `refunded` (issued),
//     `declined` (refused — the money did not move, the refundable amount is untouched), or `unknown`
//     (PENDING — the money MAY have moved, so the amount is held out of the refundable position until the
//     provider's statement says which; a pending refund is never reported as done — "no fake refund").
//
// Append-only throughout (hard rule #2): a payment resolution, a refund outcome are new facts beside the
// old, never edits. The processor is a PORT; the only implementation this repository ships is the test-mode
// one, deterministic on the token, until the payment provider (EX-03) is in hand.

import { refundGovernanceFindings, type RefundGovernanceFinding } from '../../returns/src/assess-return';

export type PaymentResult = 'authorised' | 'declined' | 'unknown';

/** The checkout's payment answer, recorded once against the order. */
export interface OrderPayment {
  readonly orderId: string;
  /** The provider's token for this payment — never a card number (#3). */
  readonly providerRef: string;
  readonly amountMinor: number;
  readonly result: PaymentResult;
  /** The provider's own word for a decline or an unknown, when it gave one. */
  readonly reason?: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

/** What the bank finally said about a payment that was `unknown` at checkout — a NEW fact, never an edit. */
export interface OrderPaymentResolution {
  readonly orderId: string;
  readonly result: 'authorised' | 'declined';
  /** The statement line, the provider's reference, the support ticket — what this rests on. */
  readonly evidenceRef: string;
  readonly resolvedBy: string;
  readonly resolvedAt: string;
}

export type PaymentState = 'none' | 'authorised' | 'declined' | 'pending';

export interface PaymentPosition {
  readonly state: PaymentState;
  /** What the customer has actually paid. Zero unless the payment is (finally) authorised. */
  readonly paidMinor: number;
  readonly providerRef?: string;
  readonly detail: string;
}

/** A PAN-shaped string: 13–19 digits once spaces and dashes are removed. Refused as a provider reference (#3). */
export function looksLikeCardNumber(ref: string): boolean {
  return /^\d{13,19}$/.test(ref.replace(/[\s-]/g, ''));
}

export function paymentPosition(payment: OrderPayment | undefined, resolution: OrderPaymentResolution | undefined): PaymentPosition {
  if (payment === undefined) return { state: 'none', paidMinor: 0, detail: 'no online payment recorded for this order (pay at store / cash on delivery, or the checkout never reached the cloud)' };
  const effective: PaymentResult = payment.result === 'unknown' && resolution !== undefined ? resolution.result : payment.result;
  switch (effective) {
    case 'authorised':
      return { state: 'authorised', paidMinor: payment.amountMinor, providerRef: payment.providerRef, detail: `paid ${payment.amountMinor} against the provider token${resolution === undefined ? '' : ` (confirmed later: ${resolution.evidenceRef})`}` };
    case 'declined':
      return { state: 'declined', paidMinor: 0, providerRef: payment.providerRef, detail: `payment declined${payment.reason === undefined ? '' : ` (${payment.reason})`}${resolution === undefined ? '' : ` — confirmed later: ${resolution.evidenceRef}`}; nothing was charged` };
    case 'unknown':
      return { state: 'pending', paidMinor: 0, providerRef: payment.providerRef, detail: `payment outcome unknown${payment.reason === undefined ? '' : ` (${payment.reason})`} — the order is NOT confirmed and must not be picked until the bank says` };
  }
}

export type RefundBasis = 'cancellation' | 'substitution' | 'short_pick' | 'goodwill';
export type ProviderRefundResult = 'refunded' | 'declined' | 'unknown';
export type RefundState = 'issued' | 'pending' | 'refused';

/** A refund as it was attempted against the order's token, and what the processor said. */
export interface OrderRefund {
  readonly refundId: string;
  readonly orderId: string;
  readonly amountMinor: number;
  readonly basis: RefundBasis;
  readonly reason: string;
  readonly requestedBy: string;
  readonly approvedBy?: string;
  readonly providerOutcome: ProviderRefundResult;
  readonly state: RefundState;
  readonly providerRefundRef?: string;
  readonly providerDetail?: string;
  readonly at: string;
}

/** The provider's final word on a refund that was `unknown` — from its statement, a NEW fact. */
export interface OrderRefundOutcome {
  readonly refundId: string;
  readonly orderId: string;
  readonly result: 'refunded' | 'declined';
  readonly evidenceRef: string;
  readonly resolvedBy: string;
  readonly at: string;
}

export interface RefundView extends OrderRefund {
  /** The refund's state once any later outcome is folded in. */
  readonly effectiveState: RefundState;
  readonly outcome?: OrderRefundOutcome;
}

export interface RefundPosition {
  readonly paidMinor: number;
  /** Refunds the provider confirmed (at once, or later by statement). */
  readonly refundedMinor: number;
  /** Refunds the provider has not confirmed either way — held out of the refundable amount. */
  readonly pendingMinor: number;
  /** What may still be refunded: paid − refunded − pending. Never negative. */
  readonly refundableMinor: number;
  readonly refunds: readonly RefundView[];
}

export function foldRefunds(refunds: readonly OrderRefund[], outcomes: readonly OrderRefundOutcome[]): readonly RefundView[] {
  const byId = new Map<string, OrderRefundOutcome>();
  for (const o of outcomes) if (!byId.has(o.refundId)) byId.set(o.refundId, o); // the first outcome stands
  return refunds.map((r) => {
    const outcome = r.state === 'pending' ? byId.get(r.refundId) : undefined;
    const effectiveState: RefundState = outcome === undefined ? r.state : outcome.result === 'refunded' ? 'issued' : 'refused';
    return { ...r, effectiveState, ...(outcome === undefined ? {} : { outcome }) };
  });
}

export function refundPosition(input: {
  readonly payment: PaymentPosition;
  readonly refunds: readonly OrderRefund[];
  readonly outcomes: readonly OrderRefundOutcome[];
}): RefundPosition {
  const views = foldRefunds(input.refunds, input.outcomes);
  const refundedMinor = views.filter((v) => v.effectiveState === 'issued').reduce((t, v) => t + v.amountMinor, 0);
  const pendingMinor = views.filter((v) => v.effectiveState === 'pending').reduce((t, v) => t + v.amountMinor, 0);
  return {
    paidMinor: input.payment.paidMinor,
    refundedMinor,
    pendingMinor,
    refundableMinor: Math.max(0, input.payment.paidMinor - refundedMinor - pendingMinor),
    refunds: views,
  };
}

export type RefundRefusal =
  | 'order_not_paid'        // no authorised online payment on this order — there is nothing to send back
  | 'payment_pending'       // the payment itself is not yet known to have happened
  | 'nothing_to_refund'     // a zero or negative amount
  | 'exceeds_refundable'    // more than paid less what is refunded or in flight
  | 'basis_not_recorded'    // a substitution refund larger than what the recorded substitutions owe
  | RefundGovernanceFinding;

export interface RefundPlan {
  readonly ok: boolean;
  readonly refusedBecause?: RefundRefusal;
  readonly detail: string;
}

/**
 * May this refund be sent? Decided from recorded facts only: the payment position, the refunds so far, the
 * substitutions recorded as owing, the tenant's approval threshold and the approver's own authority.
 */
export function planOrderRefund(input: {
  readonly payment: PaymentPosition;
  readonly position: RefundPosition;
  readonly amountMinor: number;
  readonly basis: RefundBasis;
  /** What the order's recorded substitutions say is owed (sum of their `refundMinor`). */
  readonly substitutionRefundDueMinor: number;
  readonly requestedBy: string;
  readonly approvedBy?: string;
  readonly approverHoldsAuthority: boolean;
  readonly approvalThresholdMinor: number;
}): RefundPlan {
  if (input.payment.state === 'pending') return { ok: false, refusedBecause: 'payment_pending', detail: 'the payment itself is not yet known to have happened — resolve it first; a refund of money that may never have arrived is a gift' };
  if (input.payment.state !== 'authorised') return { ok: false, refusedBecause: 'order_not_paid', detail: 'no authorised online payment is recorded on this order — there is no token to send money back to' };
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) return { ok: false, refusedBecause: 'nothing_to_refund', detail: 'a refund needs a whole positive amount in paise' };
  if (input.amountMinor > input.position.refundableMinor) {
    return { ok: false, refusedBecause: 'exceeds_refundable', detail: `${input.amountMinor} exceeds the ${input.position.refundableMinor} still refundable (paid ${input.position.paidMinor}, refunded ${input.position.refundedMinor}, pending ${input.position.pendingMinor})` };
  }
  if (input.basis === 'substitution') {
    const alreadyOnThisBasis = input.position.refunds.filter((r) => r.basis === 'substitution' && r.effectiveState !== 'refused').reduce((t, r) => t + r.amountMinor, 0);
    if (input.amountMinor > input.substitutionRefundDueMinor - alreadyOnThisBasis) {
      return { ok: false, refusedBecause: 'basis_not_recorded', detail: `the recorded substitutions owe ${input.substitutionRefundDueMinor - alreadyOnThisBasis} on this order, not ${input.amountMinor}` };
    }
  }
  const findings = refundGovernanceFindings({
    refundMinor: input.amountMinor, approvalThresholdMinor: input.approvalThresholdMinor,
    processedBy: input.requestedBy, ...(input.approvedBy === undefined ? {} : { approvedBy: input.approvedBy }),
    approverHoldsAuthority: input.approverHoldsAuthority,
  });
  const first = findings[0];
  if (first !== undefined) {
    const why: Record<string, string> = {
      given_without_approval: `a refund of ${input.amountMinor} is at or above the approval threshold (${input.approvalThresholdMinor}) and names no approver (§28)`,
      approved_by_the_processor: 'the person requesting the refund cannot also be its approver (§28)',
      approver_lacks_authority: 'the named approver does not hold refund-approval authority in this tenant',
    };
    return { ok: false, refusedBecause: first, detail: why[first] ?? first };
  }
  return { ok: true, detail: `${input.amountMinor} of ${input.position.refundableMinor} refundable, on the ${input.basis} basis` };
}

/** The processor port. The money moves HERE and nowhere else in the order surface. */
export interface RefundProcessor {
  refund(input: { readonly refundId: string; readonly providerRef: string; readonly amountMinor: number; readonly currency: 'INR' }):
    Promise<{ readonly result: ProviderRefundResult; readonly providerRefundRef?: string; readonly detail?: string }>;
}

/**
 * The test-mode processor (OA-4): deterministic on the token so every branch is reachable in a rehearsal —
 * a token ending `-declines` is declined, `-unknown` gets no answer, anything else is refunded. Never a real
 * provider: EX-03 is an outside-world gate, and this is what stands in until it is closed.
 */
export function testModeRefundProcessor(): RefundProcessor {
  return {
    refund: async ({ refundId, providerRef }) => {
      if (providerRef.endsWith('-declines')) return { result: 'declined', detail: 'test-mode provider: this token declines every refund' };
      if (providerRef.endsWith('-unknown')) return { result: 'unknown', detail: 'test-mode provider: no answer within the timeout' };
      return { result: 'refunded', providerRefundRef: `rf-test-${refundId}`, detail: 'test-mode provider: refunded' };
    },
  };
}

/** What to tell the customer, from the recorded facts and nothing else. */
export function refundMessage(state: RefundState, amountMinor: number): string {
  switch (state) {
    case 'issued': return `We have refunded ${amountMinor} paise to the way you paid. Your bank may take a few days to show it.`;
    case 'pending': return `We have asked your bank to refund ${amountMinor} paise and are waiting for it to confirm. We will tell you as soon as it does — nothing further is needed from you.`;
    case 'refused': return `Your bank did not accept the refund of ${amountMinor} paise to the way you paid. We will arrange it another way and be in touch.`;
  }
}
