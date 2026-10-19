// D-10 (R4, OB-227) — a supplier's scorecard built from what actually happened: its own purchase orders, the goods
// receipts against them and the invoices the three-way match checked. No figure on it is typed by a person.
//
//   • FILL RATE — what arrived ÷ what was ordered (net of the buyer's own cancellations), line by line, capped at the
//     ordered quantity (an over-delivery is not a better supplier).
//   • ON TIME IN FULL — the share of ORDER LINES delivered complete (accepted quantity at least the ordered quantity) by
//     the agreed date: the day the order was issued plus the lead time on the supplier's contract. With no contracted
//     lead time there is no agreed date, so the figure is `not_rated`, never a guess.
//   • LEAD-TIME RELIABILITY — the spread of the days from issue to delivery (mean absolute deviation as a share of the
//     mean, inverted): a steady seven days beats an average four that is sometimes eleven.
//   • INVOICE ACCURACY — the share of matched invoice lines billed at or below the price the order agreed.
//   • REJECTION RATE — rejected ÷ received. A rate (lower is better), not a score.
//
// A corrected receipt REPLACES its figure: the caller hands each receipt at its latest state (one entry per receipt id),
// and a second person's later disposition of a quarantined or refused line (accept / return / claim) replaces what the
// dock first recorded for that line. A receipt id seen twice is counted once.
//
// A supplier with no delivery in the period reads `not_rated` on every figure (P-08), never a score.
// Pure and deterministic: no clock, no I/O.

export type DerivedRating =
  | { readonly kind: 'rated'; readonly bp: number }
  | { readonly kind: 'not_rated'; readonly because: string };

export interface ScorecardOrderLine {
  readonly productId: string;
  /** Smallest steps of the product's unit (OB-31). */
  readonly orderedQty: number;
  /** The agreed price per WHOLE unit, or per `per` whole units (OB-46). */
  readonly unitCostMinor: number;
  readonly unitCostPer?: number;
}

export interface ScorecardOrder {
  readonly poId: string;
  readonly supplierId: string;
  /** The day the order was issued to the supplier (YYYY-MM-DD) — the clock the lead time runs from. */
  readonly issuedOn: string;
  readonly lines: readonly ScorecardOrderLine[];
  /** The buyer's own approved cancellations, per product — never held against the supplier. */
  readonly cancelledByProduct: Readonly<Record<string, number>>;
}

export interface ScorecardReceiptLine {
  readonly lineId: string;
  readonly productId: string;
  /** Everything counted at the dock for this line (sellable + quarantined + refused + held excess). */
  readonly receivedMinor: number;
  /** Refused or quarantined at the dock (expired, damaged, failed QC) — the dock's first figure. */
  readonly rejectedMinor: number;
  /** A second person's later decision on the line's quarantined / refused stock, when there is one. */
  readonly disposition?: { readonly kind: 'accept' | 'return' | 'claim'; readonly quantityMinor: number };
}

export interface ScorecardReceipt {
  readonly receiptId: string;
  readonly poId: string;
  /** The day the goods arrived (YYYY-MM-DD). */
  readonly receivedOn: string;
  readonly lines: readonly ScorecardReceiptLine[];
}

export interface ScorecardInvoiceLine {
  readonly productId: string;
  readonly unitPriceMinor: number;
  readonly unitPricePer?: number;
}

/** An invoice the three-way match checked against its order. */
export interface ScorecardMatchedInvoice {
  readonly invoiceId: string;
  readonly poId: string;
  readonly lines: readonly ScorecardInvoiceLine[];
}

export interface DerivedScorecard {
  readonly supplierId: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly ordersInScope: number;
  readonly deliveries: number;
  /** Orders in scope with nothing received at all — named, never left out of the fill rate. */
  readonly ordersWithNothingReceived: readonly string[];
  readonly fillRate: DerivedRating;
  readonly onTimeInFull: DerivedRating;
  readonly leadTimeReliability: DerivedRating;
  readonly invoiceAccuracy: DerivedRating;
  readonly rejectionRate: DerivedRating;
  readonly agreedLeadTimeDays: number | null;
  readonly averageLeadTimeDays: number | null;
  readonly worstLeadTimeDays: number | null;
  readonly orderLines: number;
  readonly orderLinesOnTimeInFull: number;
  readonly invoiceLinesChecked: number;
  readonly invoiceLinesAboveAgreedPrice: number;
  /** Where every figure came from — the registers, never a typed number. */
  readonly sources: readonly ['purchase_orders', 'goods_receipts', 'matched_invoices'];
  readonly summary: string;
}

const dayNo = (d: string): number => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
const rated = (num: number, den: number, because: string): DerivedRating =>
  den <= 0 ? { kind: 'not_rated', because } : { kind: 'rated', bp: Math.round((num * 10_000) / den) };

/** What a receipt line finally rejected: a later disposition replaces the dock's first figure (a correction, once). */
export function rejectedAfterCorrection(line: ScorecardReceiptLine): number {
  if (line.disposition === undefined) return line.rejectedMinor;
  return line.disposition.kind === 'accept' ? 0 : Math.min(line.receivedMinor, line.disposition.quantityMinor);
}

export function deriveSupplierScorecard(input: {
  readonly supplierId: string;
  readonly from: string;
  readonly to: string;
  readonly orders: readonly ScorecardOrder[];
  readonly receipts: readonly ScorecardReceipt[];
  readonly invoices: readonly ScorecardMatchedInvoice[];
  /** The lead time on the supplier's contract, when there is one. */
  readonly agreedLeadTimeDays?: number;
}): DerivedScorecard {
  const { supplierId, from, to } = input;
  const ownOrders = new Map(input.orders.filter((o) => o.supplierId === supplierId).map((o) => [o.poId, o] as const));
  // One entry per receipt id (a re-sent receipt is one delivery); only receipts against this supplier's orders.
  const receiptsById = new Map<string, ScorecardReceipt>();
  for (const r of input.receipts) if (ownOrders.has(r.poId)) receiptsById.set(r.receiptId, r);
  const receipts = [...receiptsById.values()];
  const inPeriod = (d: string): boolean => d >= from && d <= to;

  // Orders in scope: issued in the period, or delivered against in the period.
  const scope = new Set<string>();
  for (const o of ownOrders.values()) if (inPeriod(o.issuedOn)) scope.add(o.poId);
  const deliveredInPeriod = receipts.filter((r) => inPeriod(r.receivedOn));
  for (const r of deliveredInPeriod) scope.add(r.poId);
  const orders = [...scope].map((id) => ownOrders.get(id)!).sort((a, b) => a.poId.localeCompare(b.poId));
  // Receipts of the orders in scope, up to the end of the period (a later one is not known yet on this scorecard).
  const scopedReceipts = receipts.filter((r) => scope.has(r.poId) && r.receivedOn <= to);
  const agreedLead = input.agreedLeadTimeDays;

  const empty = (because: string): DerivedRating => ({ kind: 'not_rated', because });
  if (deliveredInPeriod.length === 0) {
    const none = empty('no delivery in the period');
    return {
      supplierId, period: { from, to }, ordersInScope: orders.length, deliveries: 0,
      ordersWithNothingReceived: orders.filter((o) => !scopedReceipts.some((r) => r.poId === o.poId)).map((o) => o.poId),
      fillRate: none, onTimeInFull: none, leadTimeReliability: none, invoiceAccuracy: none, rejectionRate: none,
      agreedLeadTimeDays: agreedLead ?? null, averageLeadTimeDays: null, worstLeadTimeDays: null,
      orderLines: 0, orderLinesOnTimeInFull: 0, invoiceLinesChecked: 0, invoiceLinesAboveAgreedPrice: 0,
      sources: ['purchase_orders', 'goods_receipts', 'matched_invoices'],
      summary: 'not rated — no delivery in the period, which is not the same as a good supplier',
    };
  }

  // ── fill rate and on time in full, per order line ────────────────────────────────────────────────────────────────
  let ordered = 0;
  let filled = 0;
  let lines = 0;
  let otif = 0;
  let received = 0;
  let rejected = 0;
  for (const o of orders) {
    const its = scopedReceipts.filter((r) => r.poId === o.poId);
    const dueDay = agreedLead === undefined ? undefined : dayNo(o.issuedOn) + agreedLead;
    const orderedBy = new Map<string, number>();
    for (const l of o.lines) orderedBy.set(l.productId, (orderedBy.get(l.productId) ?? 0) + l.orderedQty);
    for (const [productId, qty] of orderedBy) {
      const net = Math.max(0, qty - (o.cancelledByProduct[productId] ?? 0));
      if (net === 0) continue; // cancelled in full by the buyer: nothing was asked of the supplier
      lines += 1;
      ordered += net;
      let got = 0;
      let acceptedByDue = 0;
      for (const r of its) {
        for (const l of r.lines.filter((x) => x.productId === productId)) {
          const rej = rejectedAfterCorrection(l);
          got += l.receivedMinor;
          if (dueDay !== undefined && dayNo(r.receivedOn) <= dueDay) acceptedByDue += l.receivedMinor - rej;
        }
      }
      filled += Math.min(got, net);
      if (dueDay !== undefined && acceptedByDue >= net) otif += 1;
    }
    for (const r of its) for (const l of r.lines) { received += l.receivedMinor; rejected += rejectedAfterCorrection(l); }
  }

  // ── lead time, per delivery ──────────────────────────────────────────────────────────────────────────────────────
  const issuedOf = new Map(orders.map((o) => [o.poId, o.issuedOn] as const));
  const leadTimes = scopedReceipts.map((r) => Math.max(0, dayNo(r.receivedOn) - dayNo(issuedOf.get(r.poId)!)));
  const mean = leadTimes.reduce((s, d) => s + d, 0) / leadTimes.length;
  const deviation = leadTimes.reduce((s, d) => s + Math.abs(d - mean), 0) / leadTimes.length;
  const reliabilityBp = mean === 0 ? 10_000 : Math.max(0, 10_000 - Math.round((deviation * 10_000) / mean));

  // ── invoice accuracy, per matched invoice line ──────────────────────────────────────────────────────────────────
  let checked = 0;
  let above = 0;
  const seenInvoice = new Set<string>();
  for (const inv of input.invoices) {
    if (!scope.has(inv.poId) || seenInvoice.has(inv.invoiceId)) continue;
    seenInvoice.add(inv.invoiceId);
    const order = ownOrders.get(inv.poId)!;
    for (const l of inv.lines) {
      const agreed = order.lines.find((x) => x.productId === l.productId);
      if (agreed === undefined) { checked += 1; above += 1; continue; } // billed for something never ordered
      checked += 1;
      // Per whole unit on both sides (OB-46): invoiced ÷ its per  vs  agreed ÷ its per, cross-multiplied exactly.
      if (l.unitPriceMinor * (agreed.unitCostPer ?? 1) > agreed.unitCostMinor * (l.unitPricePer ?? 1)) above += 1;
    }
  }

  const fillRate = rated(filled, ordered, 'nothing was ordered');
  const onTimeInFull: DerivedRating = agreedLead === undefined
    ? empty('no agreed lead time on a contract — there is no agreed date to measure against')
    : rated(otif, lines, 'no order lines');
  const leadTimeReliability: DerivedRating = { kind: 'rated', bp: reliabilityBp };
  const invoiceAccuracy = rated(checked - above, checked, 'no matched invoice in the period');
  const rejectionRate = rated(rejected, received, 'nothing was received');

  const signals: string[] = [];
  const pct = (bp: number): string => `${(bp / 100).toFixed(1)}%`;
  if (fillRate.kind === 'rated' && fillRate.bp < 9_500) signals.push(`fill rate ${pct(fillRate.bp)} — short deliveries empty the shelf`);
  if (onTimeInFull.kind === 'rated' && onTimeInFull.bp < 9_000) signals.push(`on time in full ${pct(onTimeInFull.bp)} of ${lines} order line(s)`);
  if (reliabilityBp < 8_000) signals.push(`lead time swings between ${Math.min(...leadTimes)} and ${Math.max(...leadTimes)} days`);
  if (invoiceAccuracy.kind === 'rated' && above > 0) signals.push(`${above} of ${checked} invoice line(s) billed above the agreed price`);
  if (rejectionRate.kind === 'rated' && rejectionRate.bp > 200) signals.push(`${pct(rejectionRate.bp)} of what arrived was rejected`);
  const nothing = orders.filter((o) => !scopedReceipts.some((r) => r.poId === o.poId)).map((o) => o.poId);
  if (nothing.length > 0) signals.push(`${nothing.length} order(s) with nothing received: ${nothing.join(', ')}`);

  return {
    supplierId, period: { from, to }, ordersInScope: orders.length, deliveries: scopedReceipts.length,
    ordersWithNothingReceived: nothing,
    fillRate, onTimeInFull, leadTimeReliability, invoiceAccuracy, rejectionRate,
    agreedLeadTimeDays: agreedLead ?? null,
    averageLeadTimeDays: Math.round(mean * 10) / 10,
    worstLeadTimeDays: Math.max(...leadTimes),
    orderLines: lines, orderLinesOnTimeInFull: otif, invoiceLinesChecked: checked, invoiceLinesAboveAgreedPrice: above,
    sources: ['purchase_orders', 'goods_receipts', 'matched_invoices'],
    summary: signals.length === 0 ? 'no concerns in the period' : signals.join('; '),
  };
}
