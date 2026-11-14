// CR-01 OI-13-A12 (OB-763 B, owner 14 Nov 2026) — the supplier-bill match explainer's rule.
//
// When a supplier bill does not match its purchase order and the goods received (M07-FR-04, the three-way match), this
// says WHY in plain sentences — one per difference, each naming the product and the figures it came from — and drafts the
// query to the supplier for what the supplier must correct. It reads the match verdict head office already recorded
// (`threeWayMatch` above, never a second copy of the rule) and the bill as captured.
//
// It DRAFTS. It pays nothing, approves nothing, issues no debit note and changes no figure: the bill stays held at the
// lowest of the three until the accounts person decides, through the ordinary routes (hard rule 5, P-05). A debit note
// touches what the shop pays, so it is never auto-approved.
//
// Pure and deterministic — no clock, no I/O.

import type { MatchStatus } from './three-way-match';

/** A recorded match verdict and the bill it judged — what head office already holds. */
export interface BillMatchFacts {
  readonly invoiceId: string;
  readonly supplierId: string;
  readonly poId: string | null;
  readonly matchedAt: string;
  readonly blocked: boolean;
  readonly invoicedMinor: number;
  readonly payableMinor: number;
  readonly withheldMinor: number;
  readonly lines: readonly {
    readonly productId: string;
    readonly status: MatchStatus;
    /** Invoiced minus received. */
    readonly quantityDifference: number;
    /** Bill price minus order price, per unit. */
    readonly priceDifferenceMinor: number;
    readonly payableMinor: number;
  }[];
  /** What the match could not verify (no order, order not issued, another supplier, billed beyond the order, …). */
  readonly flags: readonly string[];
  /** The bill's own lines as captured, when on file — gives "the bill says 50". */
  readonly invoiceLines?: readonly { readonly productId: string; readonly quantity: number; readonly unitPriceMinor: number }[];
}

export type BillReasonCode =
  | 'bill_not_on_file'
  | 'no_purchase_order'
  | 'order_unknown'
  | 'order_not_issued'
  | 'supplier_differs_from_order'
  | 'billed_more_than_ordered'
  | 'nothing_to_compare'
  | 'billed_more_than_received'
  | 'billed_less_than_received'
  | 'price_higher_than_order'
  | 'price_lower_than_order'
  | 'within_tolerance';

export interface BillReason {
  readonly code: BillReasonCode;
  readonly productId?: string;
  /** The figures the sentence came from, so a screen can say it in another language. */
  readonly values: Readonly<Record<string, string | number>>;
  readonly sentence: string;
  /** True when it is the supplier's to correct (a corrected bill or a credit note). */
  readonly forSupplier: boolean;
}

export interface BillMismatchExplanation {
  readonly invoiceId: string;
  readonly supplierId: string;
  readonly poId: string | null;
  /** True when money is held back or the bill cannot be paid yet — a person must decide. */
  readonly needsAPerson: boolean;
  readonly heldBackMinor: number;
  readonly reasons: readonly BillReason[];
  /** The query to the supplier, drafted — only for what the supplier must correct; null when nothing is theirs. */
  readonly supplierQuery: string | null;
  readonly summary: string;
}

/** Rupees the Indian way: ₹1,23,456.78 (a minus sign before the ₹). */
export function inRupees(minor: number): string {
  const sign = minor < 0 ? '−' : '';
  const abs = Math.abs(Math.trunc(minor));
  const whole = String(Math.floor(abs / 100));
  const paise = String(abs % 100).padStart(2, '0');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest === '' ? last3 : `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
  return `${sign}₹${grouped}.${paise}`;
}

const reason = (code: BillReasonCode, sentence: string, values: Readonly<Record<string, string | number>>, forSupplier: boolean, productId?: string): BillReason =>
  ({ code, sentence, values, forSupplier, ...(productId === undefined ? {} : { productId }) });

/**
 * Explain why a bill does not match — or null when the latest match is clean (nothing to explain is not a draft).
 * Order: what stops the bill being compared at all, then line by line (quantity, then price), then what is only within tolerance.
 */
export function explainBillMismatch(facts: BillMatchFacts): BillMismatchExplanation | null {
  const flags = new Set(facts.flags);
  const reasons: BillReason[] = [];
  const po = facts.poId ?? '';

  if (flags.has('invoice_unknown')) reasons.push(reason('bill_not_on_file', `Bill ${facts.invoiceId} is not on file at head office, so it could not be compared with anything.`, { invoiceId: facts.invoiceId }, false));
  if (flags.has('no_purchase_order')) reasons.push(reason('no_purchase_order', 'The bill names no purchase order, and none was found for this supplier.', {}, false));
  if (flags.has('order_unknown')) reasons.push(reason('order_unknown', `The bill names order ${po}, which is not on file.`, { poId: po }, true));
  if (flags.has('order_not_issued')) reasons.push(reason('order_not_issued', `Order ${po} was not issued when the bill was matched, so nothing on the bill can be paid against it yet.`, { poId: po }, false));
  if (flags.has('supplier_differs_from_order')) reasons.push(reason('supplier_differs_from_order', `The bill is from a different supplier from the one on order ${po}.`, { poId: po }, true));
  if (flags.has('order_over_invoiced')) reasons.push(reason('billed_more_than_ordered', `Together with earlier bills, this bill claims more than order ${po} asked for.`, { poId: po }, true));
  if (facts.lines.length === 0 && facts.blocked) {
    reasons.push(reason('nothing_to_compare', 'No order, delivery or bill line was found to compare, so nothing may be paid on this bill yet.', {}, false));
  }

  const billQty = new Map<string, number>();
  for (const l of facts.invoiceLines ?? []) billQty.set(l.productId, (billQty.get(l.productId) ?? 0) + l.quantity);
  let anyOutside = false;
  let anyWithin = false;
  for (const line of facts.lines) {
    if (line.status === 'matched') continue;
    if (line.status === 'within_tolerance') anyWithin = true; else anyOutside = true;
    const p = line.productId;
    const q = line.quantityDifference;
    if (q > 0) {
      const billed = billQty.get(p);
      reasons.push(billed === undefined
        ? reason('billed_more_than_received', `${p}: ${q} more billed than received.`, { productId: p, extra: q }, true, p)
        : reason('billed_more_than_received', `${p}: the bill says ${billed}, we received ${billed - q} — ${q} more billed than received.`, { productId: p, billed, received: billed - q, extra: q }, true, p));
    } else if (q < 0) {
      reasons.push(reason('billed_less_than_received', `${p}: ${-q} fewer billed than received — the supplier may send a second bill for the rest.`, { productId: p, fewer: -q }, false, p));
    }
    const d = line.priceDifferenceMinor;
    if (d > 0) reasons.push(reason('price_higher_than_order', `${p}: the bill price is ${inRupees(d)} a unit higher than the order.`, { productId: p, perUnit: inRupees(d) }, true, p));
    else if (d < 0) reasons.push(reason('price_lower_than_order', `${p}: the bill price is ${inRupees(-d)} a unit lower than the order — the lower price is the one paid.`, { productId: p, perUnit: inRupees(-d) }, false, p));
  }
  if (anyWithin && !anyOutside) reasons.push(reason('within_tolerance', 'Every difference is inside the shop\'s match tolerance, so the bill can be paid as matched.', {}, false));

  const heldBackMinor = Math.max(0, facts.withheldMinor);
  if (reasons.length === 0 && heldBackMinor === 0 && !facts.blocked) return null;

  const needsAPerson = facts.blocked || heldBackMinor > 0;
  const supplierReasons = reasons.filter((r) => r.forSupplier);
  const supplierQuery = supplierReasons.length === 0 ? null : [
    `About your bill ${facts.invoiceId}${facts.poId === null ? '' : ` against our order ${facts.poId}`}:`,
    ...supplierReasons.map((r) => `- ${r.sentence}`),
    heldBackMinor > 0 ? `Please send a corrected bill or a credit note for ${inRupees(heldBackMinor)}.` : 'Please send a corrected bill.',
    '— SRE Hyper Market, accounts (draft: a person checks and sends it)',
  ].join('\n');
  const summary = `Bill ${facts.invoiceId} from ${facts.supplierId} does not match${facts.poId === null ? '' : ` order ${facts.poId}`}: `
    + `${reasons.length} reason(s)${heldBackMinor > 0 ? `, ${inRupees(heldBackMinor)} held back` : ''}. A person decides; the bill stays at the lowest of order, receipt and bill until then.`;
  return { invoiceId: facts.invoiceId, supplierId: facts.supplierId, poId: facts.poId, needsAPerson, heldBackMinor, reasons, supplierQuery, summary };
}
