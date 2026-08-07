// Pending-payment recovery (D04-FR-02 / M12-FR-03 / §4.3).
//
// The till asks the card machine for authorisation. The card machine does not answer.
// The customer is standing there with a queue behind them. **This module is what
// happens next**, and it exists because both obvious answers are wrong:
//
//   • Assume it worked → the shop hands over the goods for nothing, and finds out at
//     the end of the month, by which time the customer is long gone.
//   • Assume it failed → the customer is charged twice, notices on their statement,
//     and now the shop owes a refund it did not know about.
//
// So the tender is committed as **`uncertain`** — a real state, not a placeholder —
// the sale completes locally (hard rule #1: the lane never waits on a network call),
// and recovery reconciles it afterwards **against the provider's own record**. Exactly
// as with a reversal, there is deliberately **no way to resolve an uncertain tender by
// hand**: the moment one exists, somebody uses it to clear a queue at 9pm.
//
// The two outcomes both cost money, in opposite directions, and both are surfaced:
//
//   • **NOT PAID** — the shop is owed. Valued, owned, and carrying whatever customer
//     reference was captured, because a named customer can be contacted and an
//     anonymous one cannot, and the system should say which this is rather than imply
//     the debt is collectable.
//   • **PAID TWICE** — the customer is owed. This one is reported just as loudly. A
//     shop that only chases money owed *to* it and quietly keeps money owed *by* it is
//     not running a control, it is running a leak in its own favour.
//
// Pure and deterministic: the provider is a port, the clock is injected.

export type PendingOutcome =
  | 'confirmed_paid'
  | 'confirmed_not_paid'
  | 'still_unknown'
  | 'paid_more_than_once';

export interface UncertainTender {
  readonly tenderId: string;
  readonly saleId: string;
  readonly laneId: string;
  readonly kind: 'card' | 'upi' | 'wallet' | 'netbanking';
  /** Provider reference / token — never a card number (hard rule #3). */
  readonly providerRef: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly capturedAt: string;
  /** Present only when the customer was identified — most walk-ins are not. */
  readonly customerRef?: string;
  /** What the lane already tried, so recovery is not a first attempt every time. */
  readonly attempts?: number;
}

/** One authorisation record as the provider reports it. */
export interface ProviderAuthorisation {
  readonly ref: string;
  readonly amountMinor: number;
  readonly status: 'captured' | 'declined' | 'voided';
  readonly at: string;
}

export interface RecoveryResult {
  readonly tenderId: string;
  readonly outcome: PendingOutcome;
  readonly resolved: boolean;
  readonly detail: string;
  /** What the shop or the customer is owed, in minor units. Zero when settled clean. */
  readonly owedMinor: number;
  readonly owedBy: 'nobody' | 'customer' | 'shop';
  /** Whether the person owed can actually be reached. */
  readonly contactable: boolean;
  readonly tellTheCustomer?: string;
}

/**
 * Resolve one uncertain tender against the provider's authorisation record.
 *
 * `statementComplete` matters as much as the records themselves: **no authorisation
 * found on an incomplete record is not the same as no authorisation.** Treating it as
 * a decline is how a shop chases a customer who already paid.
 */
export function recoverPendingTender(input: {
  readonly tender: UncertainTender;
  readonly authorisations: readonly ProviderAuthorisation[];
  /** True when the provider's record for this period is known to be complete. */
  readonly statementComplete: boolean;
  readonly at: string;
}): RecoveryResult {
  const t = input.tender;
  const mine = input.authorisations.filter((a) => a.ref === t.providerRef);
  const captured = mine.filter((a) => a.status === 'captured');
  const base = { tenderId: t.tenderId, contactable: t.customerRef !== undefined };

  if (captured.length > 1) {
    // The lane retried and the provider took the money each time. The customer is owed.
    const overMinor = captured.reduce((s, a) => s + a.amountMinor, 0) - t.amountMinor;
    return {
      ...base,
      outcome: 'paid_more_than_once',
      resolved: true,
      owedMinor: overMinor,
      owedBy: 'customer',
      detail: `${captured.length} captures against one sale — the customer paid ${overMinor} more than the bill and is owed it back`,
      tellTheCustomer:
        'Our machine took your payment more than once. We have refunded the extra amount today — you should see it back within 3 to 5 working days.',
    };
  }

  if (captured.length === 1) {
    const only = captured[0]!;
    if (only.amountMinor !== t.amountMinor) {
      const difference = only.amountMinor - t.amountMinor;
      return {
        ...base,
        outcome: difference > 0 ? 'paid_more_than_once' : 'confirmed_not_paid',
        resolved: true,
        owedMinor: Math.abs(difference),
        owedBy: difference > 0 ? 'customer' : 'shop',
        detail: `the provider captured ${only.amountMinor} against a bill of ${t.amountMinor} — a ${difference > 0 ? 'over' : 'under'}-capture of ${Math.abs(difference)}`,
      };
    }
    return {
      ...base,
      outcome: 'confirmed_paid',
      resolved: true,
      owedMinor: 0,
      owedBy: 'nobody',
      detail: `confirmed captured by the provider at ${only.at} — the sale is fully paid`,
    };
  }

  if (!input.statementComplete) {
    // The single most important branch after the uncertain state itself.
    return {
      ...base,
      outcome: 'still_unknown',
      resolved: false,
      owedMinor: t.amountMinor,
      owedBy: 'shop',
      detail:
        "the provider's record for this period is not complete, so no authorisation yet is not the same as no authorisation — do not chase the customer on this",
    };
  }

  const declinedOrVoided = mine.length > 0;
  return {
    ...base,
    outcome: 'confirmed_not_paid',
    resolved: true,
    owedMinor: t.amountMinor,
    owedBy: 'shop',
    detail: declinedOrVoided
      ? `the provider ${mine[0]?.status === 'declined' ? 'declined' : 'voided'} this payment — the goods left the shop unpaid${t.customerRef === undefined ? ' and the customer was not identified, so there is nobody to contact' : ''}`
      : `no authorisation exists on a complete provider record — this sale was never paid for${t.customerRef === undefined ? ', and the customer was not identified, so there is nobody to contact' : ''}`,
  };
}

export interface PendingExposure {
  /** Money the shop is owed and can chase, because the customer is identified. */
  readonly recoverableMinor: number;
  /** Money the shop is owed from customers it cannot identify. Realistically, a loss. */
  readonly unrecoverableMinor: number;
  /** Money the shop owes back to customers. Reported just as loudly. */
  readonly owedToCustomersMinor: number;
  /** Still genuinely unknown. Stated, never split between the other figures. */
  readonly unknownMinor: number;
  readonly detail: string;
}

/**
 * The pending-payment exposure for the day close (M14-FR-04). Four numbers, kept
 * separate on purpose — a single "pending" total lets a manager close the day believing
 * the money is merely late.
 *
 * The distinction that earns its place is **recoverable vs unrecoverable**: an unpaid
 * sale to an identified account is a debt; the same sale to an anonymous walk-in is a
 * loss, and calling it a debt means it sits on a chase list for a year before anyone
 * admits it.
 */
export function pendingExposure(results: readonly RecoveryResult[]): PendingExposure {
  let recoverable = 0;
  let unrecoverable = 0;
  let owedToCustomers = 0;
  let unknown = 0;

  for (const r of results) {
    if (r.outcome === 'still_unknown') {
      unknown += r.owedMinor;
    } else if (r.owedBy === 'customer') {
      owedToCustomers += r.owedMinor;
    } else if (r.owedBy === 'shop') {
      if (r.contactable) recoverable += r.owedMinor;
      else unrecoverable += r.owedMinor;
    }
  }

  const parts: string[] = [];
  if (recoverable > 0) parts.push(`${recoverable} owed to the shop by identified customers`);
  if (unrecoverable > 0) parts.push(`${unrecoverable} unpaid by customers who cannot be identified — treat this as a loss, not a debt`);
  if (owedToCustomers > 0) parts.push(`${owedToCustomers} the shop owes back to customers`);
  if (unknown > 0) parts.push(`${unknown} still genuinely unknown`);

  return {
    recoverableMinor: recoverable,
    unrecoverableMinor: unrecoverable,
    owedToCustomersMinor: owedToCustomers,
    unknownMinor: unknown,
    detail: parts.length === 0 ? 'no pending payments outstanding' : parts.join('; '),
  };
}

/**
 * Whether the day may close with these pending payments outstanding.
 *
 * The day is **not** blocked by an unknown payment — blocking would leave the shop
 * unable to close through no fault of its own, and a manager who cannot close starts
 * looking for a way around the system. It is blocked by the shop **holding money that
 * belongs to a customer**, because that is the one the shop can fix tonight and the
 * one nobody chases tomorrow.
 */
export function dayCloseCheck(exposure: PendingExposure): {
  readonly canClose: boolean;
  readonly detail: string;
} {
  if (exposure.owedToCustomersMinor > 0) {
    return {
      canClose: false,
      detail: `${exposure.owedToCustomersMinor} is owed back to customers — refund it before closing; nobody will chase this tomorrow on the customer's behalf`,
    };
  }
  if (exposure.unknownMinor > 0) {
    return {
      canClose: true,
      detail: `${exposure.unknownMinor} is still unknown and stays on the exception list — the day closes, but this figure is stated rather than absorbed`,
    };
  }
  return { canClose: true, detail: 'no pending payments outstanding' };
}
