// A refund goes back the way the money came (R3 · C14 · RBI Payment Aggregator Directions · OB-144 "A").
//
// The owner's rule, in writing (16 Oct 2026): back to the source; cash only for cash sales; a cash refund on a card or
// UPI sale is an EXCEPTION that needs a second person and a written reason. So, for a refund against a bill:
//
//   • it goes to a tender the bill was PAID by, and no more to that tender than the bill paid by it (counting what was
//     already refunded to it) — that is "to the source";
//   • store credit on a bill paid only in cash stays the shop's own store-credit policy (capped, to a named customer), as
//     before — a cash bill has no card or UPI to go back to;
//   • anything else — cash, store credit or another instrument against a card or UPI payment, or more to a tender than it
//     paid — is an EXCEPTION: the desk refuses it unless a second person approved it with a reason;
//   • a bill whose tenders head office does not hold is "source not known" — said, never assumed (P-08).
//
// An exchange is not a money refund (its balance has its own rules). Pure and deterministic.

/** The instruments a provider reverses — a refund to them goes back to the payer's own card or UPI account. */
export const ELECTRONIC_TENDERS: readonly string[] = ['card', 'upi'];

export type RefundChannelVerdict =
  | { readonly verdict: 'to_source'; readonly detail: string }
  | { readonly verdict: 'not_a_money_refund'; readonly detail: string }
  | { readonly verdict: 'source_not_known'; readonly detail: string }
  | { readonly verdict: 'exception_needed'; readonly detail: string; readonly paidBy: Readonly<Record<string, number>> };

/** What a bill was paid by, per tender kind. */
export function paidByTender(tenders: readonly { readonly kind: string; readonly amountMinor: number }[]): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tenders) out[t.kind] = (out[t.kind] ?? 0) + t.amountMinor;
  return out;
}

/**
 * Does this refund go back to the source? `refundedByTender` is what was already refunded against the bill, per tender
 * kind (this refund excluded).
 */
export function refundChannel(input: {
  readonly saleTenders: readonly { readonly kind: string; readonly amountMinor: number }[] | undefined;
  readonly refundedByTender: Readonly<Record<string, number>>;
  readonly refundTender: string;
  readonly refundMinor: number;
}): RefundChannelVerdict {
  const { refundTender, refundMinor } = input;
  if (refundTender === 'exchange' || refundMinor <= 0) return { verdict: 'not_a_money_refund', detail: 'no money goes back on this return' };
  if (input.saleTenders === undefined || input.saleTenders.length === 0) {
    return { verdict: 'source_not_known', detail: 'head office does not hold how this bill was paid, so it cannot say whether the refund goes back to the source' };
  }
  const paidBy = paidByTender(input.saleTenders);
  const electronic = Object.keys(paidBy).filter((k) => ELECTRONIC_TENDERS.includes(k));
  const paid = paidBy[refundTender];
  if (paid !== undefined) {
    const after = (input.refundedByTender[refundTender] ?? 0) + refundMinor;
    if (after <= paid) return { verdict: 'to_source', detail: `back to ${refundTender}, which paid ${paid} on this bill` };
    return { verdict: 'exception_needed', paidBy, detail: `the bill paid ${paid} by ${refundTender}; this refund would take what went back to ${refundTender} to ${after}` };
  }
  if (refundTender === 'store_credit' && electronic.length === 0) {
    return { verdict: 'to_source', detail: 'store credit on a bill paid without card or UPI — the shop\'s store-credit policy applies' };
  }
  const by = Object.entries(paidBy).map(([k, v]) => `${k} ${v}`).join(', ');
  return {
    verdict: 'exception_needed', paidBy,
    detail: electronic.length > 0
      ? `the bill was paid by ${by}; a ${refundTender.replace(/_/g, ' ')} refund does not go back to the ${electronic.join(' / ')} it came from`
      : `the bill was paid by ${by}; a ${refundTender.replace(/_/g, ' ')} refund is not the way the money came`,
  };
}
