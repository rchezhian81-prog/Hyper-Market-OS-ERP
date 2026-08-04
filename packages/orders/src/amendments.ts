// Cancellation, substitution, returns and channel reconciliation (M18-FR-04 / A04 / #5).
//
// An order changes after it is placed far more often than anyone plans for, and every one
// of those changes touches money or stock that has already been promised. Two rules carry
// the whole module:
//
//   • **A CANCELLATION RELEASES THE RESERVATION.** Always, and as part of the same act.
//     Stock reserved for an order nobody is going to collect is stock the shop cannot
//     sell and does not know it cannot sell — it shows as unavailable to a walk-in
//     customer standing in front of it. A cancellation that forgets the release is the
//     commonest cause of phantom out-of-stocks.
//
//   • **A SUBSTITUTION NEEDS THE CUSTOMER'S CONFIRMATION** (A04, and the spirit of hard
//     rule #5). Not "we assume yes because they picked the cheap option". A picker
//     swapping full-fat for skimmed, or one brand of atta for another, is making a
//     decision about someone else's dinner, their diet or their religion — and the
//     substitution people remember is the one they did not agree to. So an unconfirmed
//     substitute is **never picked, never charged and never delivered**; the line is
//     short instead, which is the honest outcome.
//
// Two supporting rules that stop a substitution becoming a price increase:
//   • the customer **never pays more** than the line they ordered — a dearer substitute is
//     charged at the original price, and the difference is the shop's cost of not having
//     the item;
//   • a cheaper substitute is charged **at the cheaper price**, and the difference is
//     refunded rather than quietly kept.
//
// Channel reconciliation (the last part of FR-04) answers the question a finance team
// actually asks: **does every order in the sales channel appear in our ledger, and vice
// versa?** Both directions, valued, because an order the channel has and we do not is
// unfulfilled revenue, and one we have and the channel does not is a phantom.
//
// Pure and deterministic: the clock is injected, nothing is written here.

export type CancelOutcome =
  | 'cancelled'
  | 'too_late'
  | 'already_cancelled'
  | 'already_delivered'
  | 'no_reason';

export interface CancelResult {
  readonly orderId: string;
  readonly cancelled: boolean;
  readonly outcome: CancelOutcome;
  /** The reservations to release. Never empty on a successful cancellation. */
  readonly releaseReservationIds: readonly string[];
  /** What must be refunded, if the customer already paid. */
  readonly refundMinor: number;
  readonly detail: string;
}

/**
 * Cancel an order. The release of every reservation is returned **as part of the result**,
 * not left to a caller to remember: a cancellation that forgets the release makes stock
 * invisible to the shop floor, and nobody connects the two for weeks.
 */
export function cancelOrder(input: {
  readonly orderId: string;
  readonly state: 'placed' | 'confirmed' | 'picking' | 'packed' | 'dispatched' | 'delivered' | 'cancelled';
  readonly reservationIds: readonly string[];
  readonly paidMinor: number;
  readonly cancelledBy: string;
  readonly reason: string;
  readonly at: string;
}): CancelResult {
  const base = { orderId: input.orderId, releaseReservationIds: [] as string[], refundMinor: 0 };

  if (input.state === 'cancelled') {
    return { ...base, cancelled: false, outcome: 'already_cancelled', detail: 'this order is already cancelled' };
  }
  if (input.state === 'delivered') {
    return {
      ...base,
      cancelled: false,
      outcome: 'already_delivered',
      detail: 'this order was delivered — it is a return now, not a cancellation, and the goods have to come back',
    };
  }
  if (input.state === 'dispatched') {
    return {
      ...base,
      cancelled: false,
      outcome: 'too_late',
      detail: 'this order is with the driver — cancel it as a failed delivery so the stock comes back on the van, not on paper',
    };
  }
  if (input.reason.trim() === '') {
    return { ...base, cancelled: false, outcome: 'no_reason', detail: 'a cancellation needs a reason' };
  }

  return {
    orderId: input.orderId,
    cancelled: true,
    outcome: 'cancelled',
    // Every reservation, always, in the same act as the cancellation.
    releaseReservationIds: [...input.reservationIds],
    refundMinor: input.paidMinor,
    detail: `cancelled by ${input.cancelledBy}: ${input.reason}. ${input.reservationIds.length} reservation(s) released${input.paidMinor > 0 ? `, ${input.paidMinor} to refund` : ''}`,
  };
}

export type SubstitutionDecision = 'confirmed' | 'declined' | 'no_answer';

export interface SubstitutionOffer {
  readonly lineId: string;
  readonly orderedProductId: string;
  readonly orderedName: string;
  readonly orderedUnitPriceMinor: number;
  readonly orderedQuantityMinor: number;
  readonly substituteProductId: string;
  readonly substituteName: string;
  readonly substituteUnitPriceMinor: number;
  readonly substituteQuantityMinor: number;
  readonly offeredAt: string;
}

export type SubstitutionOutcome = 'substituted' | 'short_picked' | 'not_confirmed';

export interface SubstitutionResult {
  readonly lineId: string;
  readonly outcome: SubstitutionOutcome;
  /** The product the picker may actually put in the crate. */
  readonly pickProductId?: string;
  readonly pickQuantityMinor: number;
  /** What the customer is charged for this line, in minor units. */
  readonly chargeMinor: number;
  /** Refund due where the substitute is cheaper. Never kept. */
  readonly refundMinor: number;
  readonly detail: string;
  readonly tellTheCustomer: string;
}

/**
 * Apply a substitution decision.
 *
 * **`no_answer` is not a yes.** The line is short-picked, the customer is charged nothing
 * for it, and they are told. Treating silence as consent is how somebody gets a product
 * they cannot eat — and the substitution people remember is always the one they did not
 * agree to.
 */
export function applySubstitution(input: {
  readonly offer: SubstitutionOffer;
  readonly decision: SubstitutionDecision;
}): SubstitutionResult {
  const o = input.offer;
  const orderedLineMinor = o.orderedUnitPriceMinor * o.orderedQuantityMinor;

  if (input.decision !== 'confirmed') {
    return {
      lineId: o.lineId,
      outcome: input.decision === 'declined' ? 'short_picked' : 'not_confirmed',
      pickQuantityMinor: 0,
      chargeMinor: 0,
      refundMinor: 0,
      detail:
        input.decision === 'declined'
          ? `${o.orderedName}: the customer declined the substitute, so the line is short and not charged`
          : `${o.orderedName}: no answer, so nothing is substituted — silence is not consent (A04)`,
      tellTheCustomer:
        input.decision === 'declined'
          ? `We did not have ${o.orderedName} and you did not want the alternative, so it is not in your order and you have not been charged for it.`
          : `We did not have ${o.orderedName} and could not reach you in time, so we have left it out rather than guess. You have not been charged for it.`,
    };
  }

  const substituteLineMinor = o.substituteUnitPriceMinor * o.substituteQuantityMinor;
  // The customer never pays more for our failure to have the item they ordered.
  const chargeMinor = Math.min(substituteLineMinor, orderedLineMinor);
  const refundMinor = Math.max(0, orderedLineMinor - substituteLineMinor);

  return {
    lineId: o.lineId,
    outcome: 'substituted',
    pickProductId: o.substituteProductId,
    pickQuantityMinor: o.substituteQuantityMinor,
    chargeMinor,
    refundMinor,
    detail:
      substituteLineMinor > orderedLineMinor
        ? `${o.substituteName} costs ${substituteLineMinor - orderedLineMinor} more and is charged at the original ${orderedLineMinor} — the difference is ours, not the customer's`
        : refundMinor > 0
          ? `${o.substituteName} is ${refundMinor} cheaper, charged at ${chargeMinor} and the difference refunded`
          : `${o.substituteName} at the same price`,
    tellTheCustomer:
      substituteLineMinor > orderedLineMinor
        ? `We swapped ${o.orderedName} for ${o.substituteName} as you agreed. It normally costs more — you have been charged the original price.`
        : refundMinor > 0
          ? `We swapped ${o.orderedName} for ${o.substituteName} as you agreed. It is cheaper, so we have refunded the difference.`
          : `We swapped ${o.orderedName} for ${o.substituteName} as you agreed.`,
  };
}

export type ChannelDiscrepancyKind =
  | 'in_channel_not_in_ledger'
  | 'in_ledger_not_in_channel'
  | 'value_mismatch'
  | 'state_mismatch';

export interface ChannelOrder {
  readonly orderId: string;
  readonly valueMinor: number;
  readonly state: string;
}

export interface ChannelDiscrepancy {
  readonly kind: ChannelDiscrepancyKind;
  readonly orderId: string;
  readonly channelValueMinor?: number;
  readonly ledgerValueMinor?: number;
  readonly varianceMinor: number;
  readonly detail: string;
}

export interface ChannelReconciliation {
  readonly channel: string;
  readonly matched: number;
  readonly matchedValueMinor: number;
  readonly discrepancies: readonly ChannelDiscrepancy[];
  readonly atRiskValueMinor: number;
  readonly reconciles: boolean;
  readonly detail: string;
}

/**
 * Reconcile a sales channel against our own ledger, **in both directions**.
 *
 * The two failures are different and a one-way check misses one of them entirely:
 * an order **the channel has and we do not** is revenue we never fulfilled and the
 * customer is waiting; an order **we have and the channel does not** is a phantom that
 * will never be paid for. Both are valued and reported.
 */
export function reconcileChannel(input: {
  readonly channel: string;
  readonly channelOrders: readonly ChannelOrder[];
  readonly ledgerOrders: readonly ChannelOrder[];
}): ChannelReconciliation {
  const byId = new Map(input.ledgerOrders.map((o) => [o.orderId, o]));
  const channelIds = new Set(input.channelOrders.map((o) => o.orderId));
  const discrepancies: ChannelDiscrepancy[] = [];
  let matched = 0;
  let matchedValueMinor = 0;

  for (const o of [...input.channelOrders].sort((a, b) => a.orderId.localeCompare(b.orderId))) {
    const ours = byId.get(o.orderId);
    if (ours === undefined) {
      discrepancies.push({
        kind: 'in_channel_not_in_ledger',
        orderId: o.orderId,
        channelValueMinor: o.valueMinor,
        varianceMinor: o.valueMinor,
        detail: 'the channel has this order and we do not — a customer is waiting for something nobody is picking',
      });
      continue;
    }
    if (ours.valueMinor !== o.valueMinor) {
      discrepancies.push({
        kind: 'value_mismatch',
        orderId: o.orderId,
        channelValueMinor: o.valueMinor,
        ledgerValueMinor: ours.valueMinor,
        varianceMinor: ours.valueMinor - o.valueMinor,
        detail: `the channel says ${o.valueMinor} and our ledger says ${ours.valueMinor} — one of them will be what the customer is charged`,
      });
      continue;
    }
    if (ours.state !== o.state) {
      discrepancies.push({
        kind: 'state_mismatch',
        orderId: o.orderId,
        varianceMinor: 0,
        detail: `the channel shows "${o.state}" and we show "${ours.state}" — the customer is reading the channel`,
      });
      continue;
    }
    matched += 1;
    matchedValueMinor += o.valueMinor;
  }

  for (const o of [...input.ledgerOrders].sort((a, b) => a.orderId.localeCompare(b.orderId))) {
    if (channelIds.has(o.orderId)) continue;
    discrepancies.push({
      kind: 'in_ledger_not_in_channel',
      orderId: o.orderId,
      ledgerValueMinor: o.valueMinor,
      varianceMinor: o.valueMinor,
      detail: 'we have this order and the channel does not — a phantom that will never be paid for',
    });
  }

  const atRiskValueMinor = discrepancies.reduce((s, d) => s + Math.abs(d.varianceMinor), 0);
  return {
    channel: input.channel,
    matched,
    matchedValueMinor,
    discrepancies,
    atRiskValueMinor,
    reconciles: discrepancies.length === 0,
    detail:
      discrepancies.length === 0
        ? `${matched} order(s) matched, ${matchedValueMinor} — ${input.channel} reconciles exactly`
        : `${discrepancies.length} discrepanc(y/ies) worth ${atRiskValueMinor} between ${input.channel} and our ledger`,
  };
}
