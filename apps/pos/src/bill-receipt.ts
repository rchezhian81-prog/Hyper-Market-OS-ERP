// The bill a committed sale prints (roadmap v2.1 B13 · M31-FR-02 · M01-FR-02 · hard rules #1 and #3).
//
// The till's receipt goes through ONE renderer — `@sre/receipt`'s `buildReceipt` + `renderReceipt` — so what the paper
// says and what the screen shows are the same lines: the bill number, each line in its unit, a gold piece's
// "HUID: <code>" under its line (BIS hallmarking, B13), a batch under its line (D-20), the GST inside each rate band,
// the total and the payments, and the template version it was printed under.
//
//   • FROM THE COMMITTED SALE — the session's `lastBill()`, read off the record that went to the disk; never re-priced.
//   • OFFLINE — pure and synchronous: no network, no clock.
//   • NEVER COSTS THE SALE — the sale is already saved; a bill that cannot be made is RETURNED with why (P-08), never
//     thrown into the sale path.
//   • NO STORE NAME INVENTED — the header and footer are head office's published receipt template when the box holds
//     one; with none, the bill prints without them rather than with made-up words.

import {
  buildReceipt, renderReceipt, paperFormat, DEFAULT_PAPER_FORMAT, type PaperFormat,
  taxInvoiceRows, taxInvoiceText, invoiceRenderProblems, type InvoiceRow, type InvoiceLanguage,
} from '../../../packages/receipt/src/index';
import type { CommittedBill } from './session';

/**
 * OB-271 — the printed TAX INVOICE of a real-trading sale: its rows for the paper (each tagged with the Rule 46 field it
 * carries), the same as fixed-width lines for the screen, and the paper it is laid out for. A reprint is marked DUPLICATE.
 * The render is read back by the contract (`invoiceRenderProblems`) and NOT handed out when a field is missing — a bill
 * that is not a complete tax invoice is never printed. Pure; never throws; no network.
 */
export type BillTaxInvoice =
  | { readonly ok: true; readonly rows: readonly InvoiceRow[]; readonly lines: readonly string[]; readonly paper: string; readonly paperWidthMm: number; readonly number: string }
  | { readonly ok: false; readonly why: string };

export function billTaxInvoice(
  bill: CommittedBill | undefined,
  options: { readonly template?: BillTemplate | null; readonly language?: InvoiceLanguage; readonly duplicate?: boolean } = {},
): BillTaxInvoice {
  if (bill === undefined) return { ok: false, why: 'no sale has been committed on this till yet' };
  if (bill.taxInvoice === undefined) return { ok: false, why: 'this sale was not taken in real trading, so it has no tax invoice' };
  let format: PaperFormat = DEFAULT_PAPER_FORMAT;
  const named = options.template?.paperFormat;
  if (named !== undefined) {
    try { format = paperFormat(named); } catch { return { ok: false, why: `the receipt template names a paper format this till does not know (${named})` }; }
  }
  const rows = taxInvoiceRows(bill.taxInvoice, {
    ...(options.language === undefined ? {} : { language: options.language }),
    ...(options.duplicate === true ? { duplicate: true } : {}),
    ...(options.template?.footer === undefined ? {} : { footer: options.template.footer }),
  });
  const missing = invoiceRenderProblems(rows, bill.taxInvoice);
  if (missing.length > 0) return { ok: false, why: `the printed invoice would be missing: ${missing.join('; ')}` };
  return { ok: true, rows, lines: taxInvoiceText(rows, format.widthChars), paper: format.id, paperWidthMm: format.widthMm, number: bill.taxInvoice.number };
}

/** The published receipt template's parts the bill needs (`PosReceiptTemplate`, as the box served it). */
export interface BillTemplate {
  readonly version: number;
  readonly header: readonly string[];
  readonly footer: readonly string[];
  readonly paperFormat?: string;
}

export type BillReceipt =
  | { readonly ok: true; readonly lines: readonly string[]; readonly paper: string }
  | { readonly ok: false; readonly why: string };

/** The printed lines of a committed sale's bill, or why there are none. Pure; never throws. */
export function billReceipt(bill: CommittedBill | undefined, template: BillTemplate | null = null): BillReceipt {
  if (bill === undefined) return { ok: false, why: 'no sale has been committed on this till yet' };
  let format: PaperFormat = DEFAULT_PAPER_FORMAT;
  if (template?.paperFormat !== undefined) {
    try { format = paperFormat(template.paperFormat); } catch { return { ok: false, why: `the receipt template names a paper format this till does not know (${template.paperFormat})` }; }
  }
  try {
    const doc = buildReceipt({
      number: bill.number, saleId: bill.saleId, tradingDay: bill.tradingDay, committedAt: bill.committedAt,
      laneId: bill.laneId, cashierId: bill.cashierId, currency: bill.currency,
      lines: bill.lines, taxBands: bill.taxBands,
      netMinor: bill.netMinor, taxMinor: bill.taxMinor, totalMinor: bill.totalMinor,
      tenders: bill.tenders, pricesIncludeTax: true,
      header: template?.header ?? [], footer: template?.footer ?? [],
      ...(template === null ? {} : { templateVersion: template.version }),
    });
    return { ok: true, lines: renderReceipt(doc, format), paper: format.id };
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : 'the bill could not be made' };
  }
}
