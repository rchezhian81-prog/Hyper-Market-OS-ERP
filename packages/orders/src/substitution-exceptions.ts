// Substitution EXCEPTION queue (M19-FR-01) — the worklist of swaps a person must act on.
//
// Recording a substitution decision is not the end of it: some swaps leave money to move or a fact to
// verify, and a swap that quietly leaves the customer with less, or the shop out of pocket, is exactly
// the kind of silent loss P-08 forbids. This turns the recorded substitution decisions into an OWNED,
// VALUED worklist — worst (most money at stake) first — so nothing waits unseen:
//
//   • `refund_due`         — a cheaper swap or a short-pick owes the customer money back (a prepaid
//                            order). The fact is recorded here and ISSUED downstream by finance/refunds.
//   • `collect_adjustment` — a COD / pay-at-store total must change (collect less, or an approved dearer
//                            swap collects more) before the driver/till settles.
//   • `above_cap_charge`   — a dearer substitute was charged ABOVE the original price under explicit
//                            approval; someone should be able to see and stand behind that approval.
//   • `policy_short_pick`  — the policy refused the swap (a controlled item, an allergen, a blocked
//                            brand) so the line was left short; the customer got less than they ordered.
//
// Pure and deterministic: it reads the recorded decisions the caller supplies and computes the queue —
// it writes nothing and prices nothing itself (the amounts are already on the records). Mirrors the
// valued-exception shape of `reconcileCod` / `reconcileChannel`.

/** The minimal view of a recorded substitution this engine needs — the caller (a route) maps its stored
 *  record onto this. Kept independent of the service-side `StoredSubstitution` so the engine stays pure. */
export interface SubstitutionRecordView {
  readonly orderId: string;
  readonly lineId: string;
  readonly outcome: 'substituted' | 'short_picked' | 'not_confirmed';
  /** The policy eligibility, when the swap went through the M19 policy gate. */
  readonly eligibility?: 'auto_accept' | 'needs_confirmation' | 'refused';
  /** The tender-aware settlement recorded on the line, when a tender was supplied. */
  readonly settlementKind?: 'none' | 'prepaid_refund' | 'prepaid_additional_charge' | 'collect_less' | 'collect_more';
  readonly settlementMinor?: number;
  /** True when a dearer substitute was charged above the original price under explicit approval. */
  readonly aboveCap?: boolean;
  /** The M18 cheaper-difference refund fact (a swap recorded without a tender still carries this). */
  readonly refundMinor?: number;
}

export type SubstitutionExceptionKind = 'refund_due' | 'collect_adjustment' | 'above_cap_charge' | 'policy_short_pick';

export interface SubstitutionException {
  readonly orderId: string;
  readonly lineId: string;
  readonly kind: SubstitutionExceptionKind;
  /** The money at stake, always >= 0. */
  readonly amountMinor: number;
  readonly detail: string;
}

export interface SubstitutionExceptionQueue {
  /** Worst (largest amount) first; ties broken by order then line, so the order is deterministic. */
  readonly exceptions: readonly SubstitutionException[];
  readonly count: number;
  /** The total money at stake across the queue. */
  readonly atRiskMinor: number;
}

/** Classify one recorded substitution — or `undefined` when it needs no action (a same-price swap that
 *  moved no money and broke no rule). */
function classify(r: SubstitutionRecordView): SubstitutionException | undefined {
  const base = { orderId: r.orderId, lineId: r.lineId };
  const settlement = r.settlementMinor ?? 0;

  // An above-cap charge is the most sensitive — a customer paid MORE — so it is surfaced first, whatever
  // the tender says, so the approval can be seen and stood behind.
  if (r.aboveCap === true && settlement > 0) {
    return { ...base, kind: 'above_cap_charge', amountMinor: settlement, detail: `dearer substitute charged ${settlement} above the original price under explicit approval` };
  }
  // Money owed back to the customer (a cheaper swap or a short-pick on a prepaid order).
  if (r.settlementKind === 'prepaid_refund' && settlement > 0) {
    return { ...base, kind: 'refund_due', amountMinor: settlement, detail: `refund of ${settlement} due to the customer (prepaid)` };
  }
  // A COD / pay-at-store total that must change before settlement.
  if ((r.settlementKind === 'collect_less' || r.settlementKind === 'collect_more' || r.settlementKind === 'prepaid_additional_charge') && settlement > 0) {
    const dir = r.settlementKind === 'collect_less' ? 'collect less by' : r.settlementKind === 'collect_more' ? 'collect more by' : 'charge';
    return { ...base, kind: 'collect_adjustment', amountMinor: settlement, detail: `${dir} ${settlement} before settlement` };
  }
  // No tender was supplied, but the M18 engine still recorded a cheaper-difference refund fact.
  if ((r.refundMinor ?? 0) > 0) {
    return { ...base, kind: 'refund_due', amountMinor: r.refundMinor!, detail: `refund of ${r.refundMinor} due to the customer` };
  }
  // The policy refused the swap and the line was left short — the customer got less than they ordered.
  if (r.eligibility === 'refused' || (r.outcome !== 'substituted' && r.eligibility !== undefined)) {
    return { ...base, kind: 'policy_short_pick', amountMinor: settlement, detail: 'the substitution was refused by policy and the line was left short' };
  }
  return undefined;
}

/**
 * Build the substitution exception worklist from the recorded decisions.
 *
 * Worst first — the biggest money at stake at the top — because a queue nobody can triage by size is a
 * queue nobody works. Deterministic ordering (amount, then order id, then line id).
 */
export function substitutionExceptions(records: readonly SubstitutionRecordView[]): SubstitutionExceptionQueue {
  const exceptions = records
    .map(classify)
    .filter((e): e is SubstitutionException => e !== undefined)
    .sort((a, b) =>
      b.amountMinor - a.amountMinor ||
      a.orderId.localeCompare(b.orderId) ||
      a.lineId.localeCompare(b.lineId));
  return {
    exceptions,
    count: exceptions.length,
    atRiskMinor: exceptions.reduce((s, e) => s + e.amountMinor, 0),
  };
}
