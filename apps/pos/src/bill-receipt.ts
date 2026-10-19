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
} from '../../../packages/receipt/src/index';
import type { CommittedBill } from './session';

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
