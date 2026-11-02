// GST credit notes and debit notes to business customers (M23-FR-02 · OB-678 · CGST s.34 · hard rule #2).
//
// OB-678 (owner, 2 Nov 2026, in writing): a note is raised ONLY against a business (B2B) tax invoice — a till bill's return
// stays on the till's own return and refund (WF-11). This engine works from the invoice head office ITSELF holds (the stored
// tax invoice, with the CGST / SGST / IGST split it charged line by line) — never from figures a request carries:
//
//   • every line of a note names a line of THAT invoice; a line the invoice does not carry is refused by name;
//   • a CREDIT note never takes off a line more than the invoice charged on it, less every earlier credit note against the
//     same line (cumulatively) — crediting more than was billed is a payment out dressed as an adjustment;
//   • the tax comes off each line in the proportion it went on, component by component (CGST, SGST, IGST), worked out
//     cumulatively so the last note against a line reverses exactly what is left and never a paisa more;
//   • a DEBIT note (more is owed — a price charged too low) charges the line's own rate, split the way the invoice was
//     (CGST + SGST inside the State, IGST across States);
//   • an invoice that carries no CGST / SGST / IGST split cannot be credited or debited: the split would be a guess (P-08);
//   • the invoice itself is never changed. The note is its own document with its own number and date, and it belongs to
//     the return for the month it was ISSUED (CGST s.34); after the s.34(2) limit it is commercially real, tax-free.
//
// Exact integer money (BigInt where it multiplies). Pure: no clock, no I/O, no number drawn here.

import { taxAdjustmentDeadline, type CreditNote, type CreditReason, type NoteKind, type TaxComponent } from './credit-notes';
import type { OutwardNote, RateSummary } from './gstr1';

export interface NoteInvoiceLine {
  readonly lineId: string;
  readonly productId: string;
  readonly description: string;
  readonly qty: number;
  readonly unitPriceMinor: number;
  readonly taxRateBps: number;
}

export interface NoteInvoiceSplitLine {
  readonly lineId: string;
  readonly taxableMinor: number;
  readonly rateBps: number;
  readonly cgstMinor: number;
  readonly sgstMinor: number;
  readonly igstMinor: number;
}

/** The business tax invoice as head office holds it — the only source a note is worked from. */
export interface NoteInvoice {
  readonly documentId: string;
  readonly number: string;
  readonly customerId: string;
  /** The invoice's own date in the shop (YYYY-MM-DD). Drives the financial year and the s.34(2) limit. */
  readonly issuedOn: string;
  readonly lines: readonly NoteInvoiceLine[];
  readonly gst?: {
    readonly placeOfSupply: 'intra_state' | 'inter_state';
    readonly deliveryStateCode: string;
    readonly lines: readonly NoteInvoiceSplitLine[];
  };
  /** The buyer's GSTIN the invoice was made out to (OB-416); absent → the buyer was unregistered. */
  readonly recipientGstin?: string;
}

/** What a person asks a note to carry: a line of the invoice and the taxable value on it (in paise). */
export interface NoteLineAsked {
  readonly lineId: string;
  readonly taxableMinor: number;
}

export interface CustomerNoteLine {
  readonly lineId: string;
  readonly productId: string;
  readonly description: string;
  readonly rateBps: number;
  readonly taxableMinor: number;
  readonly cgstMinor: number;
  readonly sgstMinor: number;
  readonly igstMinor: number;
}

/**
 * A note to a business customer. It IS a `CreditNote` (the same shape the period reconciliation folds), with the lines,
 * the CGST / SGST / IGST it carries and the invoice it relieves, as head office worked them out.
 */
export interface CustomerNote extends CreditNote {
  /** The invoice's own document id on the customer's chain (the number is `againstInvoiceNumber`). */
  readonly invoiceDocumentId: string;
  readonly invoiceIssuedOn: string;
  readonly lines: readonly CustomerNoteLine[];
  readonly cgstMinor: number;
  readonly sgstMinor: number;
  readonly igstMinor: number;
  readonly taxMinor: number;
  readonly placeOfSupplyStateCode: string;
  readonly recipientGstin?: string;
  readonly financialYear: string;
}

export type CustomerNoteOutcome =
  | 'issued'
  | 'wrong_customer'
  | 'no_lines'
  | 'line_not_on_invoice'
  | 'line_twice'
  | 'zero_value'
  | 'exceeds_invoice'
  | 'invoice_has_no_gst_split';

export interface CustomerNoteResult {
  readonly issued: boolean;
  readonly outcome: CustomerNoteOutcome;
  readonly detail: string;
  readonly note?: CustomerNote;
}

/** The Indian financial year a shop date falls in: April to March, written "2026-27". */
export function financialYearOf(shopDate: string): string {
  const y = Number(shopDate.slice(0, 4));
  const m = Number(shopDate.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

const mulDiv = (a: number, b: number, c: number): number => (c === 0 ? 0 : Number((BigInt(a) * BigInt(b)) / BigInt(c)));

/**
 * Work out a credit or debit note against a business tax invoice head office holds. `earlier` is every note already issued
 * against this invoice (any kind); only earlier CREDIT notes use up a line's headroom.
 */
export function customerNoteAgainstInvoice(input: {
  readonly noteId: string;
  readonly number: string;
  readonly kind: NoteKind;
  readonly invoice: NoteInvoice;
  readonly customerId: string;
  readonly reason: CreditReason;
  readonly lines: readonly NoteLineAsked[];
  readonly earlier: readonly CustomerNote[];
  /** The note's own date in the shop (YYYY-MM-DD). */
  readonly issuedOn: string;
}): CustomerNoteResult {
  const inv = input.invoice;
  const refuse = (outcome: CustomerNoteOutcome, detail: string): CustomerNoteResult => ({ issued: false, outcome, detail });
  if (inv.customerId !== input.customerId) return refuse('wrong_customer', `${inv.number} was issued to a different customer`);
  if (inv.gst === undefined) {
    return refuse('invoice_has_no_gst_split', `${inv.number} carries no CGST / SGST / IGST split (the store's GSTIN was not on record when it was issued), so the tax a note would reverse or charge cannot be worked out without guessing`);
  }
  if (input.lines.length === 0) return refuse('no_lines', 'a note names at least one line of the invoice and the value on it');
  const seen = new Set<string>();
  const out: CustomerNoteLine[] = [];
  const credits = input.earlier.filter((n) => n.kind === 'credit_note' && n.invoiceDocumentId === inv.documentId);
  for (const asked of input.lines) {
    if (seen.has(asked.lineId)) return refuse('line_twice', `line ${asked.lineId} is named twice on one note`);
    seen.add(asked.lineId);
    const line = inv.lines.find((l) => l.lineId === asked.lineId);
    const split = inv.gst.lines.find((l) => l.lineId === asked.lineId);
    if (line === undefined || split === undefined) return refuse('line_not_on_invoice', `${inv.number} carries no line ${asked.lineId}`);
    if (!Number.isSafeInteger(asked.taxableMinor) || asked.taxableMinor <= 0) return refuse('zero_value', `line ${asked.lineId}: a note carries a value above nothing`);
    if (input.kind === 'credit_note') {
      const before = credits.flatMap((n) => n.lines).filter((l) => l.lineId === asked.lineId);
      const already = before.reduce((s, l) => s + l.taxableMinor, 0);
      const left = split.taxableMinor - already;
      if (asked.taxableMinor > left) {
        return refuse('exceeds_invoice', `"${line.description}": ${asked.taxableMinor} asked, but ${inv.number} charged ${split.taxableMinor} on it and earlier credit notes already took ${already} — at most ${left} is left to credit`);
      }
      // Cumulatively in proportion: what all credits to date should have reversed, less what earlier ones did.
      const upTo = already + asked.taxableMinor;
      const share = (charged: number, reversed: number): number => mulDiv(charged, upTo, split.taxableMinor) - reversed;
      out.push({
        lineId: line.lineId, productId: line.productId, description: line.description, rateBps: split.rateBps, taxableMinor: asked.taxableMinor,
        cgstMinor: share(split.cgstMinor, before.reduce((s, l) => s + l.cgstMinor, 0)),
        sgstMinor: share(split.sgstMinor, before.reduce((s, l) => s + l.sgstMinor, 0)),
        igstMinor: share(split.igstMinor, before.reduce((s, l) => s + l.igstMinor, 0)),
      });
    } else {
      // A debit note charges the line's own rate, rounded at the line as the invoice was, split as the invoice was.
      const tax = Number((BigInt(asked.taxableMinor) * BigInt(split.rateBps) + 5_000n) / 10_000n);
      const inter = inv.gst.placeOfSupply === 'inter_state';
      const cgst = inter ? 0 : Math.floor(tax / 2);
      out.push({
        lineId: line.lineId, productId: line.productId, description: line.description, rateBps: split.rateBps, taxableMinor: asked.taxableMinor,
        cgstMinor: cgst, sgstMinor: inter ? 0 : tax - cgst, igstMinor: inter ? tax : 0,
      });
    }
  }

  const sum = (k: 'taxableMinor' | 'cgstMinor' | 'sgstMinor' | 'igstMinor'): number => out.reduce((s, l) => s + l[k], 0);
  const taxableMinor = sum('taxableMinor');
  const cgstMinor = sum('cgstMinor'); const sgstMinor = sum('sgstMinor'); const igstMinor = sum('igstMinor');
  const taxMinor = cgstMinor + sgstMinor + igstMinor;
  // The components by rate, the shape the period reconciliation reads (CGST and SGST each carry half the line's rate).
  const byComponent = new Map<string, { component: string; rateBps: number; amountMinor: number }>();
  for (const l of out) {
    for (const [component, amount, rate] of [['CGST', l.cgstMinor, l.rateBps / 2], ['SGST', l.sgstMinor, l.rateBps / 2], ['IGST', l.igstMinor, l.rateBps]] as const) {
      if (amount === 0) continue;
      const key = `${component}@${rate}`;
      const row = byComponent.get(key) ?? { component, rateBps: rate, amountMinor: 0 };
      row.amountMinor += amount; byComponent.set(key, row);
    }
  }
  const taxes: TaxComponent[] = [...byComponent.values()];
  const financialYear = financialYearOf(inv.issuedOn);
  const deadline = taxAdjustmentDeadline(financialYear);
  const taxAdjustable = input.issuedOn <= deadline;
  const words = input.kind === 'credit_note' ? 'credit note' : 'debit note';
  return {
    issued: true,
    outcome: 'issued',
    detail: taxAdjustable
      ? `${words} ${input.number} against ${inv.number}: ${taxableMinor} plus ${taxMinor} tax`
      : `${words} ${input.number} against ${inv.number} issued after the ${deadline} limit — commercially valid, tax NOT adjustable (CGST s.34(2))`,
    note: {
      noteId: input.noteId,
      number: input.number,
      kind: input.kind,
      againstInvoiceId: inv.number,
      againstInvoiceNumber: inv.number,
      invoiceDocumentId: inv.documentId,
      invoiceIssuedOn: inv.issuedOn,
      customerId: input.customerId,
      issuedOn: input.issuedOn,
      reason: input.reason,
      lines: out,
      taxableMinor,
      taxes,
      cgstMinor, sgstMinor, igstMinor, taxMinor,
      grossMinor: taxableMinor + taxMinor,
      taxAdjustable,
      // The month it was ISSUED, never the invoice's month (CGST s.34).
      declareInPeriod: input.issuedOn.slice(0, 7),
      placeOfSupplyStateCode: inv.gst.deliveryStateCode,
      ...(inv.recipientGstin === undefined ? {} : { recipientGstin: inv.recipientGstin }),
      financialYear,
      detail: taxAdjustable
        ? `${input.kind === 'credit_note' ? 'takes off' : 'adds'} ${taxableMinor} plus ${taxMinor} tax (CGST ${cgstMinor}, SGST ${sgstMinor}, IGST ${igstMinor}), declared in ${input.issuedOn.slice(0, 7)}`
        : `${taxableMinor}; the ${taxMinor} of tax cannot be adjusted after ${deadline} (CGST s.34(2))`,
    },
  };
}

/** A business customer's note as the GSTR-1 credit/debit-note section reads it: rate-wise, under its own number and date. */
export function outwardNoteOf(note: CustomerNote): OutwardNote {
  const byRate = new Map<number, { rateBps: number; taxableMinor: number; cgstMinor: number; sgstMinor: number; igstMinor: number }>();
  for (const l of note.lines) {
    const row = byRate.get(l.rateBps) ?? { rateBps: l.rateBps, taxableMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 };
    row.taxableMinor += l.taxableMinor; row.cgstMinor += l.cgstMinor; row.sgstMinor += l.sgstMinor; row.igstMinor += l.igstMinor;
    byRate.set(l.rateBps, row);
  }
  const rateLines: RateSummary[] = [...byRate.values()].sort((a, b) => a.rateBps - b.rateBps);
  return {
    noteNumber: note.number, noteDate: note.issuedOn, noteType: note.kind === 'credit_note' ? 'C' : 'D',
    againstInvoiceNumber: note.againstInvoiceNumber, againstInvoiceDate: note.invoiceIssuedOn,
    ...(note.recipientGstin === undefined ? {} : { recipientGstin: note.recipientGstin }),
    placeOfSupplyStateCode: note.placeOfSupplyStateCode, taxAdjustable: note.taxAdjustable, rateLines,
  };
}

/** Is this stored note one raised against a business tax invoice (OB-678), rather than an older free-standing one? */
export const isCustomerNote = (n: CreditNote): n is CustomerNote =>
  typeof (n as Partial<CustomerNote>).invoiceDocumentId === 'string' && Array.isArray((n as Partial<CustomerNote>).lines);
