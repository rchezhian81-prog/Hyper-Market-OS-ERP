// The exchange engine (M13-FR-03 "support exchanges … with approval thresholds"; M21) — pure.
//
// An exchange is a RETURN against a bill and a REPLACEMENT SALE, settled together: the goods coming
// back are credited at the price the customer actually paid for them (the original bill's own line
// price, never today's), the goods going out are priced as the desk rang them, and the DIFFERENCE is
// either refunded (the shop owes the customer), collected (the customer owes the shop) or nothing (an
// even exchange). The roadmap's two money rules carry over unchanged — a product comes back at most
// once, and the value credited against a bill can never exceed what the bill was paid — so they are
// enforced here against the SAME register the refund guard uses (`return-register.ts`), and the
// approval rule follows the money that actually leaves: an even exchange or a top-up needs no §28
// approver (`refundRequiresApproval` says a zero-value refund is not material); a refund of the balance
// needs one at or above the tenant's threshold, exactly like a plain refund.
//
// This module commits nothing. It says *yes, and here is the money* or *no, and exactly why*; the
// service appends the return record and the replacement sale in ONE batch. Pure so the desk's own
// screen can run the identical arithmetic before it submits.

import { returnRegister, returnableLines, alreadyRefundedMinor, type OriginalSale, type RecordedReturn } from './return-register';
import type { ReturnRequestLine } from './assess-return';

/** A line going OUT on the replacement, as the desk rang it (what was charged, never what "should" be). */
export interface ReplacementLine {
  readonly productId: string;
  readonly uom: string;
  readonly quantityMinor: number;
  readonly unitPriceMinor: number;
  /** What the line actually charged: unit × quantity, less any `discountMinor` (never more). */
  readonly lineTotalMinor: number;
  /** A promotion discount ATTRIBUTED to this line by the till (SP-9b-ii · M05-FR-03 · CGST s.15(3)) — the same
   *  per-line attribution the sale record carries. Absent or 0 when the line was charged at full price. */
  readonly discountMinor?: number;
}

export type ExchangeRefusal =
  | 'no_return_lines'
  | 'no_replacement_lines'
  | 'line_not_readable'
  | 'product_not_on_this_bill'
  | 'more_than_was_sold'
  | 'refund_exceeds_what_is_left'
  | 'replacement_lines_do_not_sum';

/** Which way the balance goes, and how much. `even` is the zero-value exchange the roadmap names. */
export type ExchangeBalanceKind = 'even' | 'refund' | 'top_up';

export interface ExchangeAssessment {
  readonly ok: boolean;
  readonly refusedBecause?: ExchangeRefusal;
  readonly detail: string;
  /** The value credited for the goods coming back, at the ORIGINAL bill's prices (minor units). */
  readonly returnedValueMinor: number;
  /** What the replacement goods cost, as rung (minor units). */
  readonly replacementTotalMinor: number;
  /** replacement − returned: positive → the customer pays the difference; negative → the shop refunds it. */
  readonly netMinor: number;
  readonly balance: ExchangeBalanceKind;
  /** The magnitude of the balance (0 for an even exchange). */
  readonly balanceMinor: number;
  /** How much of the returned value is applied against the replacement (the `exchange_credit` tender). */
  readonly appliedMinor: number;
  /** Lines whose disposition is `resell` — the units back in sellable stock. */
  readonly restockedLines: number;
  /** What may still come back on the bill AFTER this exchange (per product), for the desk to show. */
  readonly remaining: readonly { readonly productId: string; readonly returnableMinor: number }[];
}

/**
 * Value the returned units at the price the bill actually charged for them: each original line's
 * per-unit price (line total ÷ quantity, so a line-level discount is honoured) × the units coming back,
 * rounded to the paise. A product sold on two lines at two prices is valued at the bill's average for
 * that product — the register is per product, not per line, so this is the only consistent choice.
 */
export function returnedValueAtOriginalPrices(sale: OriginalSale, lines: readonly Pick<ReturnRequestLine, 'productId' | 'quantityMinor'>[]): number {
  const byProduct = new Map<string, { qty: number; total: number }>();
  for (const l of sale.lines) {
    const cur = byProduct.get(l.productId) ?? { qty: 0, total: 0 };
    // The money per product comes from the bill's own priced lines when the record carries them, else
    // the bill total pro-rated by quantity (a bill with no line prices — a legacy load — still values
    // fairly rather than at zero).
    byProduct.set(l.productId, { qty: cur.qty + l.quantityMinor, total: cur.total + (l.lineTotalMinor ?? 0) });
  }
  const anyPriced = [...byProduct.values()].some((v) => v.total > 0);
  const totalQty = [...byProduct.values()].reduce((s, v) => s + v.qty, 0);
  let value = 0;
  for (const line of lines) {
    const p = byProduct.get(line.productId);
    if (p === undefined || p.qty <= 0) continue;
    const perUnit = anyPriced ? p.total / p.qty : (totalQty > 0 ? sale.totalMinor / totalQty : 0);
    value += Math.round(perUnit * line.quantityMinor);
  }
  return value;
}

export function assessExchange(input: {
  readonly sale: OriginalSale;
  readonly priorReturns: readonly RecordedReturn[];
  readonly priorRefunds: readonly { readonly returnId: string; readonly originalSaleId: string | null; readonly refundMinor: number }[];
  readonly exchange: {
    readonly exchangeId: string;
    readonly returnLines: readonly ReturnRequestLine[];
    readonly replacementLines: readonly ReplacementLine[];
  };
}): ExchangeAssessment {
  const { sale, exchange } = input;
  // This exchange does not count against itself (an idempotent retry is assessed as if new).
  const priorReturns = input.priorReturns.filter((r) => r.returnId !== exchange.exchangeId);
  const priorRefunds = input.priorRefunds.filter((r) => r.returnId !== exchange.exchangeId);

  const replacementTotalMinor = exchange.replacementLines.reduce((s, l) => s + l.lineTotalMinor, 0);
  const returnedValueMinor = returnedValueAtOriginalPrices(sale, exchange.returnLines);
  const netMinor = replacementTotalMinor - returnedValueMinor;
  const balance: ExchangeBalanceKind = netMinor === 0 ? 'even' : netMinor > 0 ? 'top_up' : 'refund';
  const base = {
    returnedValueMinor, replacementTotalMinor, netMinor, balance, balanceMinor: Math.abs(netMinor),
    appliedMinor: Math.min(returnedValueMinor, replacementTotalMinor),
    restockedLines: exchange.returnLines.filter((l) => l.disposition === 'resell').length,
  };
  const refuse = (refusedBecause: ExchangeRefusal, detail: string): ExchangeAssessment =>
    ({ ok: false, refusedBecause, detail, ...base, remaining: [] });

  if (exchange.returnLines.length === 0) return refuse('no_return_lines', 'An exchange must have at least one line coming back — with nothing returned it is a sale, not an exchange.');
  if (exchange.replacementLines.length === 0) return refuse('no_replacement_lines', 'An exchange must have at least one line going out — with nothing replacing the goods it is a return, not an exchange.');
  for (const l of exchange.returnLines) {
    if (!Number.isInteger(l.quantityMinor) || l.quantityMinor <= 0) return refuse('line_not_readable', `Returned ${l.productId}: the quantity must be a positive whole number.`);
  }
  for (const l of exchange.replacementLines) {
    const discount = l.discountMinor ?? 0;
    if (!Number.isInteger(l.quantityMinor) || l.quantityMinor <= 0 || !Number.isInteger(l.unitPriceMinor) || l.unitPriceMinor < 0 || !Number.isInteger(l.lineTotalMinor) || l.lineTotalMinor < 0
      || !Number.isInteger(discount) || discount < 0) {
      return refuse('line_not_readable', `Replacement ${l.productId}: quantity, unit price, line total and discount must be whole numbers (quantity > 0, discount ≥ 0).`);
    }
    if (l.unitPriceMinor * l.quantityMinor - discount !== l.lineTotalMinor) {
      return refuse('replacement_lines_do_not_sum', `Replacement ${l.productId}: ${l.quantityMinor} × ${l.unitPriceMinor}${discount > 0 ? ` − ${discount}` : ''} ≠ ${l.lineTotalMinor}.`);
    }
  }

  // At most once per product, against the WHOLE history of the bill (M13-FR-01).
  const returnable = returnableLines(sale, returnRegister(priorReturns));
  const byProduct = new Map(returnable.map((r) => [r.productId, r]));
  const askedByProduct = new Map<string, number>();
  for (const l of exchange.returnLines) askedByProduct.set(l.productId, (askedByProduct.get(l.productId) ?? 0) + l.quantityMinor);
  for (const [productId, asked] of askedByProduct) {
    const r = byProduct.get(productId);
    if (r === undefined) return refuse('product_not_on_this_bill', `${productId} is not on bill ${sale.number}, so it cannot be exchanged against it.`);
    if (asked > r.returnableMinor) {
      return refuse('more_than_was_sold', `${productId}: ${asked} asked back but only ${r.returnableMinor} of the ${r.soldMinor} sold may still come back.`);
    }
  }

  // The value credited can never take the bill past what it was paid (M13-FR-03).
  const refunded = alreadyRefundedMinor(sale.saleId, priorRefunds);
  if (refunded + returnedValueMinor > sale.totalMinor) {
    return refuse('refund_exceeds_what_is_left', `Crediting ${returnedValueMinor} would take bill ${sale.number} to ${refunded + returnedValueMinor} against ${sale.totalMinor} paid.`);
  }

  const remaining = returnable.map((r) => ({ productId: r.productId, returnableMinor: r.returnableMinor - (askedByProduct.get(r.productId) ?? 0) }));
  const detail = balance === 'even'
    ? `Even exchange: ${returnedValueMinor} back, ${replacementTotalMinor} out — nothing owed either way.`
    : balance === 'top_up'
      ? `The customer pays ${netMinor} more: ${replacementTotalMinor} out against ${returnedValueMinor} credited.`
      : `The shop refunds ${-netMinor}: ${returnedValueMinor} credited against ${replacementTotalMinor} out.`;
  return { ok: true, detail, ...base, remaining };
}
