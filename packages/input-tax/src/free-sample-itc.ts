// Free samples and the input tax credit they give back (A12 (1) · s.17(5)(h) CGST Act · OB-386, owner, 26 Oct 2026, in
// writing, option A: "staff record a 'free sample' stock issue; the system computes the ITC give-back from buying cost and
// places it in the next GST return for the accountant to check").
//
// Goods given away free are not a supply (no output GST), but the credit taken when they were BOUGHT must be reversed. The
// engine works that credit out from what the goods cost:
//
//   • the buying value is the quantity at head office's own average buying cost of that stock (ex-tax — the cost the stock
//     is carried at; the credit was taken on top of it);
//   • the tax heads and their weight come from the shop's latest captured supplier bill that charged the product: each
//     head's share of that bill line's taxable value, applied to the buying value. So a product bought intra-state gives
//     back CGST + SGST, one bought inter-state IGST, at the rate the bill actually charged — nothing is assumed;
//   • no buying cost held, or no bill on record for the product: the credit is NOT computed and the issue says why — never
//     a zero; a bill that charged no GST gives back nothing, and says so.
//
// The return it goes into is the month of the issue (the shop's trading day) — or, when that month's GSTR-3B is already
// locked to its filed GSTR-1, the first later month that is not.
//
// Pure and deterministic.

import type { TaxComponents } from './gstr2b';

/** One line of a captured supplier bill, as the engine reads it (taxable value and the GST the paper charged). */
export interface PurchaseTaxLine {
  readonly invoiceId: string;
  /** When the bill was captured (ISO) — the latest bill for a product sets the rate. */
  readonly capturedAt: string;
  readonly productId: string;
  /** The line's TAXABLE value in minor units (ex-tax). */
  readonly lineTotalMinor: number;
  readonly cgstMinor?: number;
  readonly sgstMinor?: number;
  readonly igstMinor?: number;
}

export type FreeSampleItc =
  | ({ readonly state: 'computed'; readonly fromInvoiceId: string; readonly buyingValueMinor: number } & TaxComponents)
  | { readonly state: 'no_gst_on_the_bill'; readonly fromInvoiceId: string; readonly buyingValueMinor: number }
  | { readonly state: 'not_computed'; readonly why: 'no_buying_cost' | 'no_bill_for_the_product'; readonly buyingValueMinor: number | null };

const share = (value: number, head: number, base: number): number => Math.round((value * head) / base);

export function freeSampleItc(input: {
  readonly productId: string;
  /** Quantity × head office's average buying cost; undefined when head office holds no cost for the stock there. */
  readonly buyingValueMinor: number | undefined;
  readonly bills: readonly PurchaseTaxLine[];
}): FreeSampleItc {
  if (input.buyingValueMinor === undefined) return { state: 'not_computed', why: 'no_buying_cost', buyingValueMinor: null };
  const value = input.buyingValueMinor;
  const latest = input.bills
    .filter((l) => l.productId === input.productId && l.lineTotalMinor > 0)
    .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt) || b.invoiceId.localeCompare(a.invoiceId))[0];
  if (latest === undefined) return { state: 'not_computed', why: 'no_bill_for_the_product', buyingValueMinor: value };
  const c = latest.cgstMinor ?? 0;
  const s = latest.sgstMinor ?? 0;
  const i = latest.igstMinor ?? 0;
  if (c + s + i === 0) return { state: 'no_gst_on_the_bill', fromInvoiceId: latest.invoiceId, buyingValueMinor: value };
  return {
    state: 'computed', fromInvoiceId: latest.invoiceId, buyingValueMinor: value,
    cgstMinor: share(value, c, latest.lineTotalMinor), sgstMinor: share(value, s, latest.lineTotalMinor), igstMinor: share(value, i, latest.lineTotalMinor), cessMinor: 0,
  };
}

/** YYYY-MM → GSTR-3B's MMYYYY. */
export const gstr3bPeriodOf = (yyyyMm: string): string => `${yyyyMm.slice(5, 7)}${yyyyMm.slice(0, 4)}`;

/** The month after a YYYY-MM. */
export function nextMonth(yyyyMm: string): string {
  const y = Number(yyyyMm.slice(0, 4));
  const m = Number(yyyyMm.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * The return a give-back goes into: the issue's own month, or — while that month's GSTR-3B is locked (`lockedMmyyyy` holds
 * its MMYYYY) — the first later month that is not.
 */
export function returnMonthFor(issueMonth: string, lockedMmyyyy: ReadonlySet<string>): { readonly month: string; readonly movedFrom?: string } {
  let month = issueMonth;
  for (let guard = 0; guard < 240 && lockedMmyyyy.has(gstr3bPeriodOf(month)); guard += 1) month = nextMonth(month);
  return month === issueMonth ? { month } : { month, movedFrom: issueMonth };
}
