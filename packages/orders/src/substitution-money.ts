// Substitution MONEY settlement (M19-FR-01, A04) — what the customer actually pays or gets back
// once a substitution decision is made, and HOW that difference is settled given how they pay.
//
// `amendments.applySubstitution` already fixes the per-line rule: the customer never pays more than
// the line they ordered (a dearer substitute is capped at the original price), and a cheaper one
// refunds the difference. This layer answers the two questions that rule leaves open:
//
//   1. The owner's approved exception — a dearer substitute MAY be charged above the original price
//      when the customer has EXPLICITLY approved it (`approvedAboveCap`). Without that approval it
//      stays capped; silence is never an approval.
//   2. HOW the money moves, which depends on how the order is paid:
//        • prepaid          → a cheaper swap or a short-pick is a REFUND; an approved dearer swap
//                             is an ADDITIONAL CHARGE.
//        • cod / pay_at_store → the same differences change the TOTAL TO COLLECT (less, or more).
//
// A short-picked or unconfirmed line (silence is not consent) is charged nothing: prepaid it is
// refunded in full, on COD/pay-at-store the total to collect drops by that line.
//
// Pure and deterministic; composes `applySubstitution`, adds no new pricing of its own. Basket-wide
// promotion / tax / loyalty recomputation after a swap is the next slice (B2b) — this is the
// single-line settlement it will build on.

import {
  applySubstitution,
  type SubstitutionOffer,
  type SubstitutionDecision,
  type SubstitutionOutcome,
} from './amendments';

export type TenderMode = 'prepaid' | 'cod' | 'pay_at_store';

export type SubstitutionSettlementKind =
  | 'none' // same price, or nothing to move
  | 'prepaid_refund' // prepaid: money back to the customer
  | 'prepaid_additional_charge' // prepaid: an approved dearer swap costs more
  | 'collect_less' // cod / pay_at_store: collect less than first quoted
  | 'collect_more'; // cod / pay_at_store: an approved dearer swap collects more

export interface SubstitutionMoney {
  readonly lineId: string;
  readonly outcome: SubstitutionOutcome;
  /** What the customer is charged for this line after the decision. */
  readonly chargeMinor: number;
  /** True only when a dearer substitute was charged ABOVE the original price under explicit approval. */
  readonly aboveCap: boolean;
  readonly settlementKind: SubstitutionSettlementKind;
  /** Always >= 0; the direction (refund vs charge, less vs more) is carried by `settlementKind`. */
  readonly settlementMinor: number;
  readonly detail: string;
  readonly tellTheCustomer: string;
}

/** Rupees from paise for a customer-facing message (INR minor units). Tamil rendering is added in B5. */
const rupees = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;

/**
 * Settle the money for one substitution decision against how the order is paid.
 *
 * Composes `applySubstitution` (which caps a dearer substitute and refunds a cheaper one) and maps
 * the outcome onto the tender: a refund on a prepaid order, or a smaller total to collect on a
 * COD / pay-at-store one — plus the owner-approved exception where an EXPLICITLY approved dearer
 * substitute is charged above the cap.
 */
export function settleSubstitutionMoney(input: {
  readonly offer: SubstitutionOffer;
  readonly decision: SubstitutionDecision;
  readonly tender: TenderMode;
  /** Explicit customer approval to charge a dearer substitute ABOVE the original price. */
  readonly approvedAboveCap?: boolean;
}): SubstitutionMoney {
  const o = input.offer;
  const prepaid = input.tender === 'prepaid';
  const orderedLineMinor = o.orderedUnitPriceMinor * o.orderedQuantityMinor;
  const substituteLineMinor = o.substituteUnitPriceMinor * o.substituteQuantityMinor;

  const base = applySubstitution({ offer: o, decision: input.decision });

  // Not substituted (declined / no answer): the line is short. Prepaid, the customer already paid,
  // so refund it in full; on COD / pay-at-store, drop it from the total to collect.
  if (base.outcome !== 'substituted') {
    return {
      lineId: o.lineId,
      outcome: base.outcome,
      chargeMinor: 0,
      aboveCap: false,
      settlementKind: orderedLineMinor > 0 ? (prepaid ? 'prepaid_refund' : 'collect_less') : 'none',
      settlementMinor: orderedLineMinor,
      detail: `${o.orderedName}: not substituted — ${prepaid ? 'refund' : 'collect less by'} ${orderedLineMinor}`,
      tellTheCustomer: prepaid
        ? `We could not supply ${o.orderedName}, so we have refunded ${rupees(orderedLineMinor)} for it.`
        : `We could not supply ${o.orderedName}, so you will not be charged ${rupees(orderedLineMinor)} for it.`,
    };
  }

  // Substituted and dearer, with explicit approval: charge the true substitute price above the cap.
  if (substituteLineMinor > orderedLineMinor && input.approvedAboveCap === true) {
    const extra = substituteLineMinor - orderedLineMinor;
    return {
      lineId: o.lineId,
      outcome: 'substituted',
      chargeMinor: substituteLineMinor,
      aboveCap: true,
      settlementKind: prepaid ? 'prepaid_additional_charge' : 'collect_more',
      settlementMinor: extra,
      detail: `${o.substituteName}: dearer substitute approved above cap — ${prepaid ? 'charge' : 'collect'} ${extra} more`,
      tellTheCustomer: prepaid
        ? `As you approved, we swapped in ${o.substituteName} and charged ${rupees(extra)} more.`
        : `As you approved, we swapped in ${o.substituteName}; you will pay ${rupees(extra)} more ${input.tender === 'cod' ? 'on delivery' : 'at the store'}.`,
    };
  }

  // Substituted and capped (dearer, not approved) or cheaper: reuse applySubstitution's charge/refund.
  const refund = base.refundMinor; // > 0 only when the substitute is cheaper
  const dearerCapped = substituteLineMinor > orderedLineMinor;
  return {
    lineId: o.lineId,
    outcome: 'substituted',
    chargeMinor: base.chargeMinor,
    aboveCap: false,
    settlementKind: refund > 0 ? (prepaid ? 'prepaid_refund' : 'collect_less') : 'none',
    settlementMinor: refund,
    detail:
      refund > 0
        ? `${o.substituteName}: cheaper — ${prepaid ? 'refund' : 'collect less by'} ${refund}`
        : dearerCapped
          ? `${o.substituteName}: dearer, charged at the original ${orderedLineMinor} (the shop absorbs the difference)`
          : `${o.substituteName}: same price`,
    tellTheCustomer:
      refund > 0
        ? prepaid
          ? `We swapped in ${o.substituteName}. It is cheaper, so we have refunded ${rupees(refund)}.`
          : `We swapped in ${o.substituteName}. It is cheaper, so you will pay ${rupees(refund)} less.`
        : dearerCapped
          ? `We swapped in ${o.substituteName}. It normally costs more — you pay the original price.`
          : `We swapped in ${o.substituteName} at the same price.`,
  };
}
