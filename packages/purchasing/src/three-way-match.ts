// The three-way match (M07-FR-04) — a PO, a receipt and an invoice must agree before anything is
// paid, and where they do not, what is paid is the **lowest** of the three until a person settles
// it. Paying the invoice and investigating afterwards is how an overcharge becomes permanent: the
// supplier has the money and the conversation is now about a refund.
//
// ── Why this is a package and not part of the purchase service ──────────────
//
// It lived inside `services/purchase`, next to that service's HTTP routes. The buyer's screen then
// needed it — and pulling it in dragged `node:http` into a browser bundle, which simply does not
// build. The two ways out of that are to copy the rule into the app, or to move the rule to where
// both can reach it.
//
// A copy would be worse than the build failure it fixed. Two implementations of "what may we pay"
// is one of them being wrong, and the disagreement surfaces as a supplier who was paid one figure
// by the screen and reconciled against another by the service. So it moved here, and the service
// re-exports it: still exactly one rule, reachable from a shop floor with no Node in sight.
//
// Pure and deterministic — no clock, no I/O, no framework.

export interface MatchLine {
  readonly productId: string;
  readonly orderedQty: number;
  readonly receivedQty: number;
  readonly invoicedQty: number;
  readonly orderedUnitMinor: number;
  readonly invoicedUnitMinor: number;
}

export type MatchStatus = 'matched' | 'within_tolerance' | 'blocked';

export interface LineMatch {
  readonly productId: string;
  readonly status: MatchStatus;
  readonly quantityDifference: number;
  readonly priceDifferenceMinor: number;
  /** What may be paid now: never more than the lowest of the three. */
  readonly payableMinor: number;
  readonly detail: string;
}

export interface MatchResult {
  readonly lines: readonly LineMatch[];
  readonly payableMinor: number;
  readonly invoicedMinor: number;
  readonly withheldMinor: number;
  readonly blocked: boolean;
  readonly detail: string;
  readonly ownerAction: string;
}

/**
 * Match a PO, a receipt and an invoice.
 *
 * Where they disagree the payable is the **lowest** of what was ordered, received and invoiced,
 * at the **lower** of the ordered and invoiced price. Paying the invoice and investigating
 * afterwards is how an overcharge becomes permanent — the supplier has the money and the
 * conversation is now about a refund.
 */
export function threeWayMatch(input: {
  readonly lines: readonly MatchLine[];
  /** Quantity tolerance in basis points. Per-tenant (OC-13). Default 0. */
  readonly quantityToleranceBps?: number;
  /** Price tolerance in basis points. Per-tenant. Default 100 (1%). */
  readonly priceToleranceBps?: number;
  /** Value below which a difference is not worth a person's time. Default ₹1. */
  readonly immaterialMinor?: number;
}): MatchResult {
  const qTol = input.quantityToleranceBps ?? 0;
  const pTol = input.priceToleranceBps ?? 100;
  const immaterial = input.immaterialMinor ?? 100;

  // No lines is not a match.
  //
  // Everything below is `map`, `reduce` and `some` over the line set, and all three are perfectly
  // happy with an empty one: an invoice we hold no lines for returned `blocked: false`, "invoiced
  // 0, matched", and told the owner "nothing — the order, the delivery and the invoice agree".
  // Three documents cannot agree when we are holding none of them. The distinction is between
  // *checked and clean* and *not checked*, and only one of those is a reason to pay.
  if (input.lines.length === 0) {
    return {
      lines: [], payableMinor: 0, invoicedMinor: 0, withheldMinor: 0, blocked: true,
      detail: 'no lines were found for this invoice, so nothing has been compared',
      ownerAction: 'Nothing may be paid on this invoice yet — not because a difference was found, but because no order, delivery or invoice line was found to compare. Check the invoice was received and its lines were captured, then match it again.',
    };
  }

  const lines = input.lines.map((l): LineMatch => {
    const payQty = Math.min(l.orderedQty, l.receivedQty, l.invoicedQty);
    const payUnit = Math.min(l.orderedUnitMinor, l.invoicedUnitMinor);
    const payableMinor = payQty * payUnit;

    const quantityDifference = l.invoicedQty - l.receivedQty;
    const priceDifferenceMinor = l.invoicedUnitMinor - l.orderedUnitMinor;

    const qOut = l.orderedQty === 0 ? quantityDifference !== 0
      : Math.abs(quantityDifference * 10_000 / l.orderedQty) > qTol;
    const pOut = l.orderedUnitMinor === 0 ? priceDifferenceMinor !== 0
      : Math.abs(priceDifferenceMinor * 10_000 / l.orderedUnitMinor) > pTol;
    const value = Math.abs(l.invoicedQty * l.invoicedUnitMinor - payableMinor);

    const status: MatchStatus = !qOut && !pOut ? 'matched'
      : value <= immaterial ? 'within_tolerance' : 'blocked';

    return {
      productId: l.productId, status, quantityDifference, priceDifferenceMinor, payableMinor,
      detail: status === 'matched' ? `${l.productId}: agrees at ${payableMinor}`
        : status === 'within_tolerance' ? `${l.productId}: differs by ${value}, inside tolerance`
          : `${l.productId}: invoiced ${l.invoicedQty} at ${l.invoicedUnitMinor}, received ${l.receivedQty}, ordered ${l.orderedQty} at ${l.orderedUnitMinor}. Paying the lower of each: ${payableMinor}`,
    };
  });

  const payableMinor = lines.reduce((t, l) => t + l.payableMinor, 0);
  const invoicedMinor = input.lines.reduce((t, l) => t + l.invoicedQty * l.invoicedUnitMinor, 0);
  const blocked = lines.some((l) => l.status === 'blocked');

  return {
    lines, payableMinor, invoicedMinor, withheldMinor: invoicedMinor - payableMinor, blocked,
    detail: blocked
      ? `invoiced ${invoicedMinor}, payable ${payableMinor}, ${invoicedMinor - payableMinor} withheld`
      : `invoiced ${invoicedMinor}, matched`,
    ownerAction: blocked
      ? `${invoicedMinor - payableMinor} is held back until the differences are settled. The supplier is paid what all three documents agree on — releasing the rest first turns an overcharge into a refund conversation`
      : 'nothing — the order, the delivery and the invoice agree',
  };
}
