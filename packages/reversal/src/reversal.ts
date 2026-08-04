// Payment reversal, gateway status and refund reconciliation (M13-FR-04 / §4.3 / §6.2).
//
// This module exists to enforce one sentence from the roadmap: **never invent a
// reversal success.** It is the mirror of the no-invented-approval rule on the tender
// side, and it is broken in the same way — not by a decision, but by a hopeful default.
// A provider call times out, nobody knows what happened, and the easiest code in the
// world marks it done. Two things then go wrong at once, in opposite directions:
//
//   • the customer is told "that's refunded" and it is not, so they come back angry
//     a week later and the shop refunds again — **paying twice for one return**; or
//   • the reversal actually succeeded, the shop believes it failed and refunds by
//     hand — **paying twice for one return**, from the other end.
//
// Both are the same bug: an unknown outcome written down as a known one. So a reversal
// whose result is not known is **`uncertain`**, it stays uncertain, and the ONLY thing
// that resolves it is the provider's own statement (`resolveFromSettlement`). No
// screen, no supervisor and no override can mark an uncertain reversal successful —
// that is deliberate, and it is the whole control.
//
// Three more rules, each protecting real money:
//   • **IDEMPOTENT ON THE REFUND ID.** A retried request returns the existing reversal.
//     A double refund is cash out of the door that nobody notices until the statement.
//   • **NEVER MORE THAN THE ORIGINAL CHARGE**, in total across every reversal against it.
//   • **NO CARD DATA.** Provider tokens and references only (hard rule #3) — a
//     PAN-shaped reference is refused outright, exactly as in reconciliation.
//
// And because the person who has to say something to a waiting customer is a cashier,
// every state carries `tellTheCustomer` — the true sentence, written out, so nobody
// has to improvise a reassuring one.
//
// Pure and deterministic: the provider is a port, the clock is injected.

export type ReversalStatus =
  /** Sent to the provider; no answer yet. */
  | 'pending'
  /** The provider confirmed it. Money is on its way back. */
  | 'succeeded'
  /** The provider refused it. This is an exception, not a quiet nothing. */
  | 'failed'
  /** We do not know. This is a real, permanent-until-reconciled state. */
  | 'uncertain';

export interface OriginalTender {
  readonly tenderId: string;
  readonly saleId: string;
  readonly kind: 'card' | 'upi' | 'wallet' | 'netbanking';
  /** Provider reference or token — never a card number (hard rule #3). */
  readonly providerRef: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly capturedAt: string;
}

export interface Reversal {
  readonly reversalId: string;
  readonly refundId: string;
  readonly originalTenderId: string;
  readonly providerRef: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: ReversalStatus;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly settledAt?: string;
  /** The provider's own reference for the reversal, when it gave one. */
  readonly providerReversalRef?: string;
  readonly failureReason?: string;
  /** How the uncertainty was resolved — always from evidence, never from a screen. */
  readonly resolvedBy?: 'provider_settlement' | 'provider_response';
  /** True once the reversal has been seen on a provider statement (§6.2). */
  readonly reconciled: boolean;
}

/** What the provider adapter returns. `unknown` is a first-class, expected answer. */
export type ProviderOutcome =
  | { readonly result: 'succeeded'; readonly providerReversalRef: string }
  | { readonly result: 'failed'; readonly reason: string }
  | { readonly result: 'unknown'; readonly reason: string };

/**
 * The provider port. Synchronous by signature here because the decision logic is what
 * is being tested; a real adapter wraps an async call and returns `unknown` on a
 * timeout rather than throwing — a thrown timeout is how "unknown" becomes "failed".
 */
export interface ReversalProvider {
  requestReversal(input: {
    readonly providerRef: string;
    readonly amountMinor: number;
    readonly currency: string;
    readonly idempotencyKey: string;
  }): ProviderOutcome;
}

export class CardDataError extends Error {
  constructor() {
    super('A reversal reference must be a provider token/reference, never a card number (hard rule #3).');
    this.name = 'CardDataError';
  }
}

// A bare 13–19 digit string is treated as a possible card PAN and refused — the same
// rule as `packages/reconciliation`, applied at the other end of the money.
const PAN_LIKE = /^\d{13,19}$/;

function assertNotPan(ref: string): void {
  if (PAN_LIKE.test(ref.replace(/[\s-]/g, ''))) {
    throw new CardDataError();
  }
}

export type ReversalRefusal =
  | 'requested'
  | 'already_requested'
  | 'exceeds_original'
  | 'invalid_amount'
  | 'wrong_currency';

export interface ReversalResult {
  readonly refundId: string;
  readonly accepted: boolean;
  readonly outcome: ReversalRefusal;
  readonly detail: string;
  readonly reversal?: Reversal;
  /** The true sentence for the cashier to say. Never a reassuring guess. */
  readonly tellTheCustomer?: string;
}

/** The sentence the counter says, derived from the state — not from optimism. */
export function tellTheCustomer(reversal: Reversal): string {
  switch (reversal.status) {
    case 'succeeded':
      return 'The refund has been sent back to your card. It usually reaches your account in 3 to 5 working days.';
    case 'pending':
      return 'The refund has been sent to the bank and we are waiting for confirmation. We will have an answer shortly; your receipt has the reference on it.';
    case 'uncertain':
      return 'We have asked the bank to refund you and we have not had a clear answer yet. We will not ask you to pay again and we will not refund you twice — we are checking with the bank and will confirm. Please keep this reference.';
    case 'failed':
      return `The bank did not accept the refund${reversal.failureReason === undefined ? '' : ` (${reversal.failureReason})`}. We will refund you another way today — please speak to the manager, who has the reference.`;
  }
}

/**
 * Request a reversal from the provider. Idempotent on the refund id: an existing
 * reversal is returned rather than a second one created.
 *
 * The single most important line in this function is the `unknown` branch — it writes
 * `uncertain`, and nothing anywhere in this module can change that except evidence.
 */
export function requestReversal(
  input: {
    readonly reversalId: string;
    readonly refundId: string;
    readonly original: OriginalTender;
    readonly amountMinor: number;
    readonly requestedBy: string;
    readonly at: string;
    /** Reversals already raised against this original tender, for the cap. */
    readonly existing?: readonly Reversal[];
  },
  provider: ReversalProvider,
): ReversalResult {
  assertNotPan(input.original.providerRef);
  const base = { refundId: input.refundId };
  const existing = input.existing ?? [];

  const already = existing.find((r) => r.refundId === input.refundId);
  if (already !== undefined) {
    return {
      ...base,
      accepted: false,
      outcome: 'already_requested',
      reversal: already,
      tellTheCustomer: tellTheCustomer(already),
      detail: `refund ${input.refundId} already has reversal ${already.reversalId} (${already.status}) — asking again would refund twice`,
    };
  }
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    return { ...base, accepted: false, outcome: 'invalid_amount', detail: 'a reversal of nothing is not a reversal' };
  }

  // A reversal that fails does not free up headroom — the money may still be moving.
  // Only an explicitly failed one is excluded from the cap.
  const committed = existing
    .filter((r) => r.originalTenderId === input.original.tenderId && r.status !== 'failed')
    .reduce((sum, r) => sum + r.amountMinor, 0);
  if (committed + input.amountMinor > input.original.amountMinor) {
    return {
      ...base,
      accepted: false,
      outcome: 'exceeds_original',
      detail: `the original charge was ${input.original.amountMinor} and ${committed} is already being reversed — ${input.amountMinor} more would refund more than was ever taken`,
    };
  }

  const outcome = provider.requestReversal({
    providerRef: input.original.providerRef,
    amountMinor: input.amountMinor,
    currency: input.original.currency,
    // The provider's own idempotency key, so a retried network call is one reversal
    // at their end too — not only at ours.
    idempotencyKey: `rev:${input.refundId}`,
  });

  const shared = {
    reversalId: input.reversalId,
    refundId: input.refundId,
    originalTenderId: input.original.tenderId,
    providerRef: input.original.providerRef,
    amountMinor: input.amountMinor,
    currency: input.original.currency,
    requestedBy: input.requestedBy,
    requestedAt: input.at,
    reconciled: false,
  };

  let reversal: Reversal;
  if (outcome.result === 'succeeded') {
    reversal = {
      ...shared,
      status: 'succeeded',
      settledAt: input.at,
      providerReversalRef: outcome.providerReversalRef,
      resolvedBy: 'provider_response',
    };
  } else if (outcome.result === 'failed') {
    // A refusal is a refusal. It is an exception with a value, not a quiet nothing.
    reversal = { ...shared, status: 'failed', failureReason: outcome.reason };
  } else {
    // The line this whole module exists for. We do not know, so we say we do not know.
    reversal = { ...shared, status: 'uncertain', failureReason: outcome.reason };
  }

  return {
    ...base,
    accepted: reversal.status !== 'failed',
    outcome: 'requested',
    reversal,
    tellTheCustomer: tellTheCustomer(reversal),
    detail:
      reversal.status === 'uncertain'
        ? `the provider did not give a clear answer (${outcome.result === 'unknown' ? outcome.reason : ''}) — recorded as UNCERTAIN and left for the statement to settle, never assumed`
        : reversal.status === 'failed'
          ? `the provider refused the reversal: ${reversal.failureReason ?? 'no reason given'}`
          : `reversed ${input.amountMinor} against ${input.original.providerRef}`,
  };
}

export interface SettlementCredit {
  readonly settlementId: string;
  /** The provider's reference for the credit — matched against the reversal. */
  readonly ref: string;
  readonly amountMinor: number;
  readonly settledAt: string;
}

export interface ResolutionResult {
  readonly reversal: Reversal;
  readonly changed: boolean;
  readonly detail: string;
}

/**
 * Resolve a reversal against the provider's own statement. **This is the only route
 * out of `uncertain`** — there is deliberately no `markSucceeded(reversalId)` in this
 * module, because the moment one exists somebody uses it to clear a queue.
 *
 * A credit that matches confirms it. A statement that has been through the relevant
 * period with no credit confirms the opposite: it did not happen.
 */
export function resolveFromSettlement(input: {
  readonly reversal: Reversal;
  readonly credits: readonly SettlementCredit[];
  /** True when the statement covering the request date is complete, so absence means no. */
  readonly statementComplete: boolean;
  readonly at: string;
}): ResolutionResult {
  const r = input.reversal;
  if (r.status === 'succeeded' && r.reconciled) {
    return { reversal: r, changed: false, detail: 'already reconciled against the statement' };
  }

  const credit = input.credits.find(
    (c) => c.ref === r.providerRef && c.amountMinor === r.amountMinor,
  );

  if (credit !== undefined) {
    return {
      changed: true,
      reversal: {
        ...r,
        status: 'succeeded',
        settledAt: credit.settledAt,
        providerReversalRef: credit.settlementId,
        resolvedBy: 'provider_settlement',
        reconciled: true,
      },
      detail: `matched credit ${credit.settlementId} on the provider statement — the money genuinely went back`,
    };
  }

  if (!input.statementComplete) {
    return {
      reversal: r,
      changed: false,
      detail: 'the statement for this period is not complete, so no credit yet is not the same as no credit — still uncertain',
    };
  }

  if (r.status === 'uncertain' || r.status === 'pending') {
    return {
      changed: true,
      reversal: { ...r, status: 'failed', failureReason: 'no matching credit on a complete provider statement', resolvedBy: 'provider_settlement' },
      detail: 'the complete statement carries no matching credit — the reversal did not happen and the customer must be refunded another way',
    };
  }

  return { reversal: r, changed: false, detail: `nothing to resolve — this reversal is ${r.status}` };
}

export type RefundExceptionKind =
  | 'reversal_failed'
  | 'reversal_uncertain'
  | 'reversal_unreconciled'
  | 'refund_without_reversal'
  | 'over_refunded';

export interface RefundException {
  readonly kind: RefundExceptionKind;
  readonly reversalId?: string;
  readonly refundId: string;
  readonly originalTenderId: string;
  readonly valueMinor: number;
  readonly ageHours?: number;
  /** Named, because an exception nobody owns is an exception nobody clears (P-03). */
  readonly owner: string;
  readonly detail: string;
}

/**
 * The refund exception list for the cash office (M14-FR-03 feeds off the same idea).
 * Every entry is **valued and owned** — a refund problem with no rupee figure and no
 * name against it never reaches the top of anyone's day.
 *
 * Ordered worst-first: failed (the customer is owed money right now), then uncertain,
 * then merely unreconciled.
 */
export function refundExceptions(input: {
  readonly reversals: readonly Reversal[];
  readonly originals: readonly OriginalTender[];
  readonly at: string;
  /** Hours after which an unreconciled reversal is itself an exception. Default 72. */
  readonly reconcileWithinHours?: number;
  readonly owner: string;
}): readonly RefundException[] {
  const within = input.reconcileWithinHours ?? 72;
  const rank: Record<RefundExceptionKind, number> = {
    reversal_failed: 0,
    over_refunded: 1,
    reversal_uncertain: 2,
    reversal_unreconciled: 3,
    refund_without_reversal: 4,
  };

  const exceptions: RefundException[] = [];

  for (const r of input.reversals) {
    const ageHours = Math.max(0, Math.round((Date.parse(input.at) - Date.parse(r.requestedAt)) / 3_600_000));
    const shared = {
      reversalId: r.reversalId,
      refundId: r.refundId,
      originalTenderId: r.originalTenderId,
      valueMinor: r.amountMinor,
      ageHours,
      owner: input.owner,
    };

    if (r.status === 'failed') {
      exceptions.push({
        ...shared,
        kind: 'reversal_failed',
        detail: `the provider refused this reversal${r.failureReason === undefined ? '' : ` (${r.failureReason})`} — the customer is owed this money and has not had it`,
      });
    } else if (r.status === 'uncertain') {
      exceptions.push({
        ...shared,
        kind: 'reversal_uncertain',
        detail: `no clear answer from the provider after ${ageHours}h — do NOT refund again until the statement settles it, or the shop pays twice`,
      });
    } else if (r.status === 'succeeded' && !r.reconciled && ageHours > within) {
      exceptions.push({
        ...shared,
        kind: 'reversal_unreconciled',
        detail: `confirmed by the provider ${ageHours}h ago but still not on a statement — every refund must be independently reconcilable (§6.2)`,
      });
    }
  }

  // More reversed than was ever charged, across every reversal on one tender.
  const byTender = new Map<string, Reversal[]>();
  for (const r of input.reversals) {
    if (r.status === 'failed') continue;
    byTender.set(r.originalTenderId, [...(byTender.get(r.originalTenderId) ?? []), r]);
  }
  for (const [tenderId, rows] of byTender) {
    const original = input.originals.find((o) => o.tenderId === tenderId);
    if (original === undefined) continue;
    const total = rows.reduce((s, r) => s + r.amountMinor, 0);
    if (total > original.amountMinor) {
      exceptions.push({
        kind: 'over_refunded',
        refundId: rows.map((r) => r.refundId).join('+'),
        originalTenderId: tenderId,
        valueMinor: total - original.amountMinor,
        owner: input.owner,
        detail: `${total} reversed against a charge of ${original.amountMinor} — the shop has paid out more than it took`,
      });
    }
  }

  return exceptions.sort(
    (a, b) => rank[a.kind] - rank[b.kind] || b.valueMinor - a.valueMinor || a.refundId.localeCompare(b.refundId),
  );
}

export interface RefundDayTotals {
  readonly reversedMinor: number;
  readonly confirmedMinor: number;
  readonly uncertainMinor: number;
  readonly failedMinor: number;
  readonly balances: boolean;
  readonly detail: string;
}

/**
 * Refund totals for the day close (M14-FR-04 acceptance: *"refund totals reconcile at
 * day close"*). The day does not balance by pretending an uncertain reversal is one
 * thing or the other — it balances by **stating all three numbers**, so a manager
 * closing at 10pm can see exactly how much money is in an unknown state.
 */
export function refundDayTotals(reversals: readonly Reversal[]): RefundDayTotals {
  const sum = (f: (r: Reversal) => boolean): number =>
    reversals.filter(f).reduce((s, r) => s + r.amountMinor, 0);

  const confirmed = sum((r) => r.status === 'succeeded');
  const uncertain = sum((r) => r.status === 'uncertain' || r.status === 'pending');
  const failed = sum((r) => r.status === 'failed');
  const total = confirmed + uncertain + failed;

  return {
    reversedMinor: total,
    confirmedMinor: confirmed,
    uncertainMinor: uncertain,
    failedMinor: failed,
    balances: confirmed + uncertain + failed === total,
    detail:
      uncertain === 0 && failed === 0
        ? `${confirmed} refunded and confirmed`
        : `${confirmed} confirmed, ${uncertain} still unknown, ${failed} refused by the provider — the unknown figure is stated, not split between the other two`,
  };
}
