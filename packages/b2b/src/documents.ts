// The B2B document chain (M22-FR-02): quote → sales order → proforma → challan → invoice.
//
// A hypermarket selling to a school, a caterer or a hostel does not hand over a till receipt.
// It runs a chain of documents, and **every one of them is a legal or commercial claim about
// the same underlying order**. The failure everybody has seen is the chain drifting: an
// invoice for 40 cases when 38 were delivered, because the invoice was built from the order
// instead of from the challan.
//
// So the rule here is the one that runs through the whole product: **each document is derived
// from the one before it, never from the one two steps back.**
//
//   quote      what we offered            — non-committing, expires
//   order      what they accepted         — from the quote, at the quoted price
//   proforma   what we will charge        — from the order; not a tax invoice
//   challan    what actually left         — from the order, but quantities are the DISPATCHED ones
//   invoice    what they owe              — **from the challans**, never from the order
//
// Three consequences that are refusals rather than warnings:
//
//   • **AN INVOICE CANNOT EXCEED WHAT WAS DELIVERED.** Partial delivery produces a partial
//     invoice. Billing the ordered quantity when the van carried less is not a rounding
//     issue, it is an overcharge with a tax invoice attached to it.
//   • **A PROFORMA IS NOT A TAX INVOICE.** It carries no GST claim and takes no number from
//     the invoice series. Treating one as the other is how a customer claims input credit
//     against a document that was never filed.
//   • **NUMBERS ARE GAP-FREE AND DRAWN ONCE.** A document that fails validation must not
//     consume a number, because a gap in a tax-invoice series is a question from an
//     assessing officer with no good answer.
//
// Pure and deterministic: numbers are allocated through an injected series, the clock is
// injected, nothing is written here.

import { formatNumber, type NumberFormat } from '../../numbering/src/numbering';

export type B2BDocumentKind = 'quotation' | 'sales_order' | 'proforma' | 'challan' | 'tax_invoice';

export interface B2BLine {
  readonly lineId: string;
  readonly productId: string;
  readonly description: string;
  /** Whole units. Weighed B2B lines are sold in packs, so this stays an integer. */
  readonly qty: number;
  readonly unitPriceMinor: number;
  /** Basis points, e.g. 500 = 5% GST. */
  readonly taxRateBps: number;
}

export interface B2BDocument {
  readonly documentId: string;
  readonly number: string;
  readonly kind: B2BDocumentKind;
  readonly customerId: string;
  readonly tenantId: string;
  readonly issuedAt: string;
  /** What this document was derived from. Empty only for a quotation. */
  readonly derivedFrom?: string;
  readonly lines: readonly B2BLine[];
  readonly netMinor: number;
  readonly taxMinor: number;
  readonly grossMinor: number;
  /** True only for a tax invoice. A proforma carries no tax claim. */
  readonly taxClaimable: boolean;
  readonly detail: string;
}

/** Exact per-line tax, rounded at the line and summed — never a percentage of the total. */
function totals(lines: readonly B2BLine[]): {
  readonly netMinor: number;
  readonly taxMinor: number;
  readonly grossMinor: number;
} {
  let netMinor = 0;
  let taxMinor = 0;
  for (const line of lines) {
    const net = line.unitPriceMinor * line.qty;
    netMinor += net;
    // BigInt so a large institutional order cannot drift at the last paisa.
    taxMinor += Number((BigInt(net) * BigInt(line.taxRateBps) + 5_000n) / 10_000n);
  }
  return { netMinor, taxMinor, grossMinor: netMinor + taxMinor };
}

export type QuotationOutcome = 'issued' | 'no_lines' | 'invalid_quantity';

export interface QuotationResult {
  readonly issued: boolean;
  readonly outcome: QuotationOutcome;
  readonly document?: B2BDocument;
  readonly validUntil?: string;
  readonly detail: string;
}

/**
 * Issue a quotation. **Non-committing** — it moves no stock, reserves nothing and creates
 * no receivable. It does one thing: it fixes a price for a stated window, so the customer
 * can take it to their committee and come back to the same number.
 *
 * A number is drawn only once the lines are valid, so a rejected quote leaves no gap.
 */
export function issueQuotation(input: {
  readonly documentId: string;
  readonly customerId: string;
  readonly tenantId: string;
  readonly lines: readonly B2BLine[];
  readonly format: NumberFormat;
  readonly seq: number;
  readonly at: string;
  /** Days the quoted price holds. Per-tenant. Default 15. */
  readonly validForDays?: number;
}): QuotationResult {
  if (input.lines.length === 0) {
    return { issued: false, outcome: 'no_lines', detail: 'a quotation with no lines is not an offer' };
  }
  const bad = input.lines.find((l) => !Number.isSafeInteger(l.qty) || l.qty < 1);
  if (bad !== undefined) {
    return {
      issued: false,
      outcome: 'invalid_quantity',
      detail: `"${bad.description}" is quoted at ${bad.qty} — and no number has been drawn, so the series keeps no gap`,
    };
  }

  const sums = totals(input.lines);
  const validUntil = new Date(
    Date.parse(input.at) + (input.validForDays ?? 15) * 86_400_000,
  ).toISOString();

  const detail = `quoted ${sums.grossMinor} inclusive, held until ${validUntil.slice(0, 10)} — non-committing until it is converted`;

  return {
    issued: true,
    outcome: 'issued',
    validUntil,
    detail,
    document: {
      documentId: input.documentId,
      number: formatNumber(input.format, input.seq),
      kind: 'quotation',
      customerId: input.customerId,
      tenantId: input.tenantId,
      issuedAt: input.at,
      lines: input.lines,
      ...sums,
      taxClaimable: false,
      detail,
    },
  };
}

export type ConversionOutcome =
  | 'converted'
  | 'expired'
  | 'wrong_customer'
  | 'already_converted'
  | 'credit_blocked';

export interface ConversionResult {
  readonly converted: boolean;
  readonly outcome: ConversionOutcome;
  readonly document?: B2BDocument;
  readonly detail: string;
}

/**
 * Convert a quotation into a sales order **at the quoted price**.
 *
 * The price is taken from the quotation, not re-derived from today's price list. That is the
 * whole point of quoting: the customer accepted a number and the shop honours it inside the
 * window it set. Outside the window it refuses rather than quietly re-pricing, because a
 * silent re-price is discovered at the invoice and costs the account.
 *
 * Credit is checked by `checkCredit` (M22-FR-01) and passed in — this function will not
 * convert an order the credit control has blocked.
 */
export function convertQuotation(input: {
  readonly documentId: string;
  readonly quotation: B2BDocument;
  readonly customerId: string;
  readonly format: NumberFormat;
  readonly seq: number;
  readonly validUntil: string;
  readonly at: string;
  readonly alreadyConvertedFrom?: readonly string[];
  /** The credit decision from M22-FR-01. Absent means not checked, which blocks. */
  readonly creditAllowed?: boolean;
}): ConversionResult {
  if (input.quotation.customerId !== input.customerId) {
    return {
      converted: false,
      outcome: 'wrong_customer',
      detail: 'that quotation was issued to a different customer',
    };
  }
  if ((input.alreadyConvertedFrom ?? []).includes(input.quotation.documentId)) {
    return {
      converted: false,
      outcome: 'already_converted',
      detail: 'this quotation has already become an order — one quote, one order',
    };
  }
  if (input.at > input.validUntil) {
    return {
      converted: false,
      outcome: 'expired',
      detail: `the quoted price held until ${input.validUntil.slice(0, 10)} — re-quote rather than re-price quietly at the invoice`,
    };
  }
  if (input.creditAllowed !== true) {
    return {
      converted: false,
      outcome: 'credit_blocked',
      detail: 'credit control has not cleared this order (M22-FR-01)',
    };
  }

  const sums = totals(input.quotation.lines);
  const detail = `ordered at the quoted price from ${input.quotation.number}, not at today's price list`;

  return {
    converted: true,
    outcome: 'converted',
    detail,
    document: {
      documentId: input.documentId,
      number: formatNumber(input.format, input.seq),
      kind: 'sales_order',
      customerId: input.customerId,
      tenantId: input.quotation.tenantId,
      issuedAt: input.at,
      derivedFrom: input.quotation.documentId,
      lines: input.quotation.lines,
      ...sums,
      taxClaimable: false,
      detail,
    },
  };
}

/**
 * A proforma: what we will charge, so the customer can raise a payment.
 *
 * **It is not a tax invoice.** `taxClaimable` is false and it draws from its own series.
 * A customer claiming input credit against a proforma is claiming against a document that
 * was never filed, and it is the shop that gets the notice.
 */
export function issueProforma(input: {
  readonly documentId: string;
  readonly order: B2BDocument;
  readonly format: NumberFormat;
  readonly seq: number;
  readonly at: string;
}): B2BDocument {
  const sums = totals(input.order.lines);
  return {
    documentId: input.documentId,
    number: formatNumber(input.format, input.seq),
    kind: 'proforma',
    customerId: input.order.customerId,
    tenantId: input.order.tenantId,
    issuedAt: input.at,
    derivedFrom: input.order.documentId,
    lines: input.order.lines,
    ...sums,
    // The single most important field on this document.
    taxClaimable: false,
    detail: 'proforma — a request for payment, NOT a tax invoice, and no input credit may be claimed against it',
  };
}

export type ChallanOutcome = 'issued' | 'over_delivery' | 'nothing_dispatched';

export interface ChallanResult {
  readonly issued: boolean;
  readonly outcome: ChallanOutcome;
  readonly document?: B2BDocument;
  readonly detail: string;
}

/**
 * A delivery challan: **what actually left the building**.
 *
 * Quantities come from the dispatch, not from the order. Partial delivery produces a partial
 * challan, and delivering *more* than was ordered is refused — an unordered case that turns
 * up on an invoice is a dispute, and the driver is the one who has the argument.
 */
export function issueChallan(input: {
  readonly documentId: string;
  readonly order: B2BDocument;
  /** Dispatched quantity per order line. Missing or zero means that line did not go. */
  readonly dispatched: Readonly<Record<string, number>>;
  /** Already-dispatched quantity per line from earlier challans. */
  readonly alreadyDispatched?: Readonly<Record<string, number>>;
  readonly format: NumberFormat;
  readonly seq: number;
  readonly at: string;
}): ChallanResult {
  const prior = input.alreadyDispatched ?? {};

  for (const line of input.order.lines) {
    const now = input.dispatched[line.lineId] ?? 0;
    const cumulative = (prior[line.lineId] ?? 0) + now;
    if (cumulative > line.qty) {
      return {
        issued: false,
        outcome: 'over_delivery',
        detail: `"${line.description}": ${cumulative} dispatched against ${line.qty} ordered — an unordered case on an invoice is a dispute, and the driver has the argument`,
      };
    }
  }

  const lines = input.order.lines
    .map((line): B2BLine => ({ ...line, qty: input.dispatched[line.lineId] ?? 0 }))
    .filter((line) => line.qty > 0);

  if (lines.length === 0) {
    return {
      issued: false,
      outcome: 'nothing_dispatched',
      detail: 'nothing left the building, so there is nothing to challan',
    };
  }

  const sums = totals(lines);
  const short = input.order.lines.filter(
    (l) => (prior[l.lineId] ?? 0) + (input.dispatched[l.lineId] ?? 0) < l.qty,
  );

  const detail =
    short.length === 0
      ? `the whole order went: ${lines.length} line(s)`
      : `${lines.length} line(s) went and ${short.length} line(s) are still short — the invoice will follow what was delivered, not what was ordered`;

  return {
    issued: true,
    outcome: 'issued',
    detail,
    document: {
      documentId: input.documentId,
      number: formatNumber(input.format, input.seq),
      kind: 'challan',
      customerId: input.order.customerId,
      tenantId: input.order.tenantId,
      issuedAt: input.at,
      derivedFrom: input.order.documentId,
      lines,
      ...sums,
      taxClaimable: false,
      detail,
    },
  };
}

export type InvoiceOutcome = 'issued' | 'no_challan' | 'exceeds_delivered' | 'wrong_order';

export interface InvoiceResult {
  readonly issued: boolean;
  readonly outcome: InvoiceOutcome;
  readonly document?: B2BDocument;
  readonly detail: string;
}

/**
 * The tax invoice — **built from the challans, never from the order**.
 *
 * This is the one place in the chain where getting it wrong costs real money in both
 * directions: bill the ordered quantity and the customer is overcharged with a tax document
 * to prove it; bill less and the shop has delivered goods it will never be paid for. So the
 * invoice quantity is the **delivered** quantity, and an invoice that would exceed what the
 * challans record is refused outright.
 */
export function issueTaxInvoice(input: {
  readonly documentId: string;
  readonly order: B2BDocument;
  readonly challans: readonly B2BDocument[];
  /** Quantity per line already invoiced on earlier tax invoices. */
  readonly alreadyInvoiced?: Readonly<Record<string, number>>;
  readonly format: NumberFormat;
  readonly seq: number;
  readonly at: string;
}): InvoiceResult {
  const foreign = input.challans.find((c) => c.derivedFrom !== input.order.documentId);
  if (foreign !== undefined) {
    return {
      issued: false,
      outcome: 'wrong_order',
      detail: `challan ${foreign.number} belongs to a different order`,
    };
  }
  if (input.challans.length === 0) {
    return {
      issued: false,
      outcome: 'no_challan',
      detail: 'nothing has been delivered, so there is nothing to invoice — an invoice is built from challans, never from the order',
    };
  }

  const delivered = new Map<string, number>();
  for (const challan of input.challans) {
    for (const line of challan.lines) {
      delivered.set(line.lineId, (delivered.get(line.lineId) ?? 0) + line.qty);
    }
  }

  const invoiced = input.alreadyInvoiced ?? {};
  const lines: B2BLine[] = [];
  for (const line of input.order.lines) {
    const billable = (delivered.get(line.lineId) ?? 0) - (invoiced[line.lineId] ?? 0);
    if (billable < 0) {
      return {
        issued: false,
        outcome: 'exceeds_delivered',
        detail: `"${line.description}" has already been invoiced beyond what was delivered — that is an overcharge with a tax invoice attached to it`,
      };
    }
    if (billable > 0) lines.push({ ...line, qty: billable });
  }

  if (lines.length === 0) {
    return {
      issued: false,
      outcome: 'exceeds_delivered',
      detail: 'everything delivered has already been invoiced',
    };
  }

  const sums = totals(lines);
  const outstandingLines = input.order.lines.filter(
    (l) => (delivered.get(l.lineId) ?? 0) < l.qty,
  );

  const detail =
    outstandingLines.length === 0
      ? `${sums.grossMinor} for what was delivered on ${input.challans.length} challan(s)`
      : `${sums.grossMinor} for what was delivered so far; ${outstandingLines.length} line(s) remain undelivered and are NOT billed`;

  return {
    issued: true,
    outcome: 'issued',
    detail,
    document: {
      documentId: input.documentId,
      number: formatNumber(input.format, input.seq),
      kind: 'tax_invoice',
      customerId: input.order.customerId,
      tenantId: input.order.tenantId,
      issuedAt: input.at,
      // Derived from the challans. Naming the order here would be the lie.
      derivedFrom: input.challans.map((c) => c.documentId).join(','),
      lines,
      ...sums,
      taxClaimable: true,
      detail,
    },
  };
}

export interface ChainCheck {
  readonly complete: boolean;
  readonly orderedMinor: number;
  readonly deliveredMinor: number;
  readonly invoicedMinor: number;
  readonly undeliveredMinor: number;
  readonly uninvoicedMinor: number;
  readonly detail: string;
}

/**
 * Check the chain end to end: what was ordered, what left, what was billed.
 *
 * Delivered-but-not-invoiced is the number that matters — goods gone out of the door with
 * no claim on them. It is found by reconciling the chain, and nobody finds it by reading
 * one document.
 */
export function checkChain(input: {
  readonly order: B2BDocument;
  readonly challans: readonly B2BDocument[];
  readonly invoices: readonly B2BDocument[];
}): ChainCheck {
  const sum = (docs: readonly B2BDocument[]): number =>
    docs.reduce((s, d) => s + d.grossMinor, 0);

  const orderedMinor = input.order.grossMinor;
  const deliveredMinor = sum(input.challans);
  const invoicedMinor = sum(input.invoices);
  const undeliveredMinor = orderedMinor - deliveredMinor;
  const uninvoicedMinor = deliveredMinor - invoicedMinor;

  return {
    complete: undeliveredMinor === 0 && uninvoicedMinor === 0,
    orderedMinor,
    deliveredMinor,
    invoicedMinor,
    undeliveredMinor,
    uninvoicedMinor,
    detail:
      uninvoicedMinor > 0
        ? `${uninvoicedMinor} has left the building and has not been billed — that is stock gone with no claim on it`
        : undeliveredMinor > 0
          ? `${undeliveredMinor} of the order is still to go; everything delivered is billed`
          : 'ordered, delivered and billed all agree',
  };
}
