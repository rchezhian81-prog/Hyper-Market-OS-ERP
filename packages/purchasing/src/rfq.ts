// Requisition → RFQ → quotation comparison (M06-FR-02). Buying starts before the purchase order: a
// buyer raises a REQUISITION (what the shop needs), sends an RFQ to suppliers, and the suppliers quote.
// The control that earns its keep here is the COMPARISON — and it is only honest if it is like-for-like:
//
//   • a quote is compared on a line only if it quotes the SAME product in the SAME currency the
//     requisition is being compared in. A quote in another currency, or one that omits a line, is shown
//     but marked not-comparable, never silently ranked against the others (P-08);
//   • per line, the CHEAPEST (lowest extended cost for the quantity needed) and the FASTEST (shortest
//     lead time) are named — they are frequently different suppliers, and the buyer should see both;
//   • overall, only a quote that covers EVERY line like-for-like can be totalled; its total is the sum
//     of the line costs and its lead time is the SLOWEST line (the order is not complete until the last
//     item arrives). The cheapest-overall and fastest-overall are named, and any quote that could not be
//     totalled is called out by name — an incomplete quote that looks cheap because it is missing a line
//     is exactly the trap this prevents.
//
// Pure and deterministic; composes the Money primitive. Ties break toward the other objective (cheapest
// ties break to the faster; fastest ties break to the cheaper) and then to quote order, so the result
// is stable. This engine decides nothing and commits nothing — it lays the choice out; a human picks and
// a PO is raised through the approved `issuePurchaseOrder` path (§28).

import { add, zero, multiplyByInteger, compare, type Money, type CurrencyCode } from '../../contracts/src/money';

export interface RequisitionLine {
  readonly productId: string;
  /** Whole units needed (> 0). */
  readonly quantity: number;
}

export interface Requisition {
  readonly requisitionId: string;
  /** The currency the comparison is made in — a quote in another currency is not like-for-like. */
  readonly currency: CurrencyCode;
  readonly lines: readonly RequisitionLine[];
}

export interface QuoteLine {
  readonly productId: string;
  readonly unitCost: Money;
  /** Days from order to delivery quoted for this line (whole, ≥ 0). */
  readonly leadTimeDays: number;
}

export interface Quote {
  readonly quoteId: string;
  readonly supplierId: string;
  readonly lines: readonly QuoteLine[];
}

/** One supplier's offer against a requisition line. */
export interface LineOffer {
  readonly supplierId: string;
  readonly quoteId: string;
  readonly unitCost: Money;
  /** unitCost × the quantity the requisition needs. */
  readonly lineCost: Money;
  readonly leadTimeDays: number;
  /** True only when this offer is like-for-like (same currency) and can be ranked. */
  readonly comparable: boolean;
  readonly reason?: string;
}

export interface LineComparison {
  readonly productId: string;
  readonly quantity: number;
  readonly offers: readonly LineOffer[];
  /** The quote ref with the lowest extended cost among comparable offers. */
  readonly cheapest?: { readonly supplierId: string; readonly quoteId: string };
  /** The quote ref with the shortest lead time among comparable offers. */
  readonly fastest?: { readonly supplierId: string; readonly quoteId: string };
}

/** A whole-requisition total for a quote that covers every line like-for-like. */
export interface QuoteTotal {
  readonly supplierId: string;
  readonly quoteId: string;
  readonly totalCost: Money;
  /** The order completes when the slowest line arrives. */
  readonly maxLeadTimeDays: number;
}

export interface QuoteComparison {
  readonly requisitionId: string;
  readonly currency: CurrencyCode;
  readonly lines: readonly LineComparison[];
  /** Totals for the quotes that covered every line like-for-like, in the requisition currency. */
  readonly totals: readonly QuoteTotal[];
  readonly cheapestOverall?: { readonly supplierId: string; readonly quoteId: string };
  readonly fastestOverall?: { readonly supplierId: string; readonly quoteId: string };
  /** Quote ids that could not be totalled because they did not cover every line like-for-like. */
  readonly incompleteQuotes: readonly string[];
  readonly summary: string;
}

export class EmptyRequisitionError extends Error {
  constructor(requisitionId: string) {
    super(`Requisition "${requisitionId}" has no lines to quote.`);
    this.name = 'EmptyRequisitionError';
  }
}

/**
 * Compare supplier quotes against a requisition, like-for-like. Returns the per-line and overall
 * cheapest/fastest among comparable offers, and names any quote that could not be totalled. Never
 * ranks a quote in a different currency or one missing a line against the rest.
 */
export function compareQuotes(input: { readonly requisition: Requisition; readonly quotes: readonly Quote[] }): QuoteComparison {
  const { requisition, quotes } = input;
  if (requisition.lines.length === 0) throw new EmptyRequisitionError(requisition.requisitionId);
  const cur = requisition.currency;

  const lines: LineComparison[] = requisition.lines.map((reqLine) => {
    const offers: LineOffer[] = [];
    for (const q of quotes) {
      const ql = q.lines.find((l) => l.productId === reqLine.productId);
      if (ql === undefined) continue; // this quote did not offer this product
      const comparable = ql.unitCost.currency === cur;
      offers.push({
        supplierId: q.supplierId,
        quoteId: q.quoteId,
        unitCost: ql.unitCost,
        lineCost: multiplyByInteger(ql.unitCost, reqLine.quantity),
        leadTimeDays: ql.leadTimeDays,
        comparable,
        ...(comparable ? {} : { reason: `quoted in ${ql.unitCost.currency}, not ${cur}` }),
      });
    }
    const rankable = offers.filter((o) => o.comparable);
    const cheapest = pickBest(rankable, (a, b) => compare(a.lineCost, b.lineCost) || (a.leadTimeDays - b.leadTimeDays));
    const fastest = pickBest(rankable, (a, b) => (a.leadTimeDays - b.leadTimeDays) || compare(a.lineCost, b.lineCost));
    return {
      productId: reqLine.productId,
      quantity: reqLine.quantity,
      offers,
      ...(cheapest ? { cheapest: refOf(cheapest) } : {}),
      ...(fastest ? { fastest: refOf(fastest) } : {}),
    };
  });

  // A quote is complete only if it has a comparable offer for EVERY requisition line.
  const totals: QuoteTotal[] = [];
  const incompleteQuotes: string[] = [];
  for (const q of quotes) {
    const perLine = requisition.lines.map((reqLine) =>
      lines.find((lc) => lc.productId === reqLine.productId)?.offers.find((o) => o.quoteId === q.quoteId && o.comparable),
    );
    if (perLine.some((o) => o === undefined)) {
      incompleteQuotes.push(q.quoteId);
      continue;
    }
    const complete = perLine as LineOffer[];
    totals.push({
      supplierId: q.supplierId,
      quoteId: q.quoteId,
      totalCost: complete.reduce((sum, o) => add(sum, o.lineCost), zero(cur)),
      maxLeadTimeDays: Math.max(...complete.map((o) => o.leadTimeDays)),
    });
  }

  const cheapestOverall = pickBest(totals, (a, b) => compare(a.totalCost, b.totalCost) || (a.maxLeadTimeDays - b.maxLeadTimeDays));
  const fastestOverall = pickBest(totals, (a, b) => (a.maxLeadTimeDays - b.maxLeadTimeDays) || compare(a.totalCost, b.totalCost));

  return {
    requisitionId: requisition.requisitionId,
    currency: cur,
    lines,
    totals,
    ...(cheapestOverall ? { cheapestOverall: refOf(cheapestOverall) } : {}),
    ...(fastestOverall ? { fastestOverall: refOf(fastestOverall) } : {}),
    incompleteQuotes,
    summary: summarise(quotes.length, totals, cheapestOverall, fastestOverall, incompleteQuotes),
  };
}

function pickBest<T>(items: readonly T[], better: (a: T, b: T) => number): T | undefined {
  if (items.length === 0) return undefined;
  return items.reduce((best, cur) => (better(cur, best) < 0 ? cur : best));
}

const refOf = (o: { supplierId: string; quoteId: string }): { supplierId: string; quoteId: string } =>
  ({ supplierId: o.supplierId, quoteId: o.quoteId });

function summarise(
  quoteCount: number,
  totals: readonly QuoteTotal[],
  cheapest: QuoteTotal | undefined,
  fastest: QuoteTotal | undefined,
  incomplete: readonly string[],
): string {
  if (quoteCount === 0) return 'no quotes to compare yet';
  const parts: string[] = [];
  if (cheapest) parts.push(`cheapest overall: ${cheapest.supplierId} at ${cheapest.totalCost.minor} ${cheapest.totalCost.currency} (minor)`);
  if (fastest) parts.push(`fastest overall: ${fastest.supplierId} in ${fastest.maxLeadTimeDays} days`);
  if (totals.length === 0) parts.push('no quote covered every line like-for-like, so none could be totalled');
  if (incomplete.length > 0) parts.push(`${incomplete.length} quote(s) could not be compared in full: ${incomplete.join(', ')}`);
  return parts.join('; ');
}
