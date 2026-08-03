// Receipt document & rendering (M31-FR-02 / M12-FR-02 / hard rules #1 and #3) —
// what the customer walks away with, and the store's own record of the sale.
//
// Four rules shape this:
//   • GENERATED FROM THE COMMITTED SALE, never a draft (M31-FR-02) — the caller
//     passes the committed record and its gap-free number (`packages/numbering`);
//   • PRINTS OFFLINE — building and rendering are pure and synchronous, so a
//     receipt prints with the cable out (hard rule #1);
//   • EXACT MONEY — every amount comes from integer minor units, never a float, and
//     the GST lines add up to the total (M23);
//   • NO CARD DATA — a tender line may carry the kind and a provider reference only;
//     anything that looks like a card number is REFUSED, not masked and printed
//     (hard rule #3).
//
// A reprint is marked as such on the face of the receipt and carries its reason, so
// a duplicate can never be passed off as an original (M12-FR-02).

import { type CurrencyCode } from '../../contracts/src/money';

export interface ReceiptLineInput {
  readonly description: string;
  /** Quantity in the UOM's smallest unit (e.g. 2 ea, or 1234 g). */
  readonly quantityMinor: number;
  readonly uom: string;
  /** Price of one UOM unit, in minor units. */
  readonly unitPriceMinor: number;
  /** Line total after any discount, in minor units. */
  readonly lineTotalMinor: number;
}

export interface ReceiptTenderInput {
  readonly kind: string;
  readonly amountMinor: number;
  /** Provider reference/token — NEVER a card number (refused below). */
  readonly reference?: string;
}

/** A GST band on the bill: rate, the net it applied to, and the tax charged. */
export interface TaxBandInput {
  readonly rateBps: number;
  readonly netMinor: number;
  readonly taxMinor: number;
}

export interface BuildReceiptInput {
  /** Gap-free document number from `packages/numbering` (M01-FR-02). */
  readonly number: string;
  readonly saleId: string;
  readonly tradingDay: string;
  /** ISO-8601 UTC — printed in the store's local format by the renderer's caller. */
  readonly committedAt: string;
  readonly laneId: string;
  readonly cashierId: string;
  readonly currency: CurrencyCode;
  readonly lines: readonly ReceiptLineInput[];
  readonly taxBands: readonly TaxBandInput[];
  readonly netMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly tenders: readonly ReceiptTenderInput[];
  readonly changeMinor?: number;
  /** Per-tenant header/footer (store name, GSTIN, thanks line) — choose-able. */
  readonly header: readonly string[];
  readonly footer: readonly string[];
  /** Set on a reprint; the receipt is then marked and the reason recorded. */
  readonly reprintOf?: { readonly reason: string; readonly by: string; readonly at: string };
}

export interface ReceiptDocument extends BuildReceiptInput {
  readonly isReprint: boolean;
}

export class CardDataOnReceiptError extends Error {
  constructor() {
    super('A receipt may carry a provider reference, never a card number (hard rule #3).');
    this.name = 'CardDataOnReceiptError';
  }
}

export class ReceiptTotalsError extends Error {
  constructor(detail: string) {
    super(`Receipt totals do not balance: ${detail}.`);
    this.name = 'ReceiptTotalsError';
  }
}

export class ReprintReasonRequiredError extends Error {
  constructor() {
    super('A reprint needs a reason — it is recorded and printed on the copy (M12-FR-02).');
    this.name = 'ReprintReasonRequiredError';
  }
}

// A bare 13–19 digit run is treated as a possible card PAN and refused.
const PAN_LIKE = /^\d{13,19}$/;

/**
 * Build a validated receipt document from a committed sale. Refuses a PAN-like
 * reference, unbalanced totals, and a reprint with no reason. Pure — no clock, no
 * I/O — so it runs on an offline lane.
 */
export function buildReceipt(input: BuildReceiptInput): ReceiptDocument {
  for (const tender of input.tenders) {
    const ref = (tender.reference ?? '').replace(/[\s-]/g, '');
    if (PAN_LIKE.test(ref)) {
      throw new CardDataOnReceiptError();
    }
  }

  // The printed totals must add up, or the receipt is not issued.
  const lineSum = input.lines.reduce((sum, l) => sum + l.lineTotalMinor, 0);
  if (lineSum !== input.netMinor) {
    throw new ReceiptTotalsError(`lines ${lineSum} ≠ net ${input.netMinor}`);
  }
  const bandTax = input.taxBands.reduce((sum, b) => sum + b.taxMinor, 0);
  if (bandTax !== input.taxMinor) {
    throw new ReceiptTotalsError(`tax bands ${bandTax} ≠ tax ${input.taxMinor}`);
  }
  if (input.netMinor + input.taxMinor !== input.totalMinor) {
    throw new ReceiptTotalsError(`net + tax ≠ total ${input.totalMinor}`);
  }

  if (input.reprintOf !== undefined && input.reprintOf.reason.trim() === '') {
    throw new ReprintReasonRequiredError();
  }

  return { ...input, isReprint: input.reprintOf !== undefined };
}

/** Format minor units as a plain amount (no symbol — the printer's font is ASCII). */
function amount(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Left/right justify within the paper width. */
function pair(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - left.length - right.length);
  return left + ' '.repeat(gap) + right;
}

/** Wrap a long description across lines so nothing is silently truncated. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > width) {
    out.push(rest.slice(0, width));
    rest = rest.slice(width);
  }
  out.push(rest);
  return out;
}

function centre(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  const pad = Math.floor((width - text.length) / 2);
  return ' '.repeat(pad) + text;
}

/** Quantity as printed: whole units as-is, weighed goods with their decimals. */
function quantityText(line: ReceiptLineInput): string {
  if (line.uom === 'ea') return String(line.quantityMinor);
  // 1234 g → "1.234 kg"; the UOM's own precision governs (3 for kg/l).
  const precision = line.uom === 'kg' || line.uom === 'l' ? 3 : 0;
  if (precision === 0) return `${line.quantityMinor} ${line.uom}`;
  const scale = 10 ** precision;
  return `${Math.trunc(line.quantityMinor / scale)}.${String(line.quantityMinor % scale).padStart(precision, '0')} ${line.uom}`;
}

/**
 * Render the receipt to plain text lines for a thermal printer. `width` is the
 * paper's character width (typically 32 for 58 mm, 42/48 for 80 mm). Pure.
 */
export function renderText(doc: ReceiptDocument, width = 42): string[] {
  const out: string[] = [];
  const rule = '-'.repeat(width);

  for (const line of doc.header) out.push(centre(line, width));
  out.push(rule);

  if (doc.isReprint) {
    // Unmistakable on the face of the copy — never passed off as an original.
    out.push(centre('*** REPRINT ***', width));
    out.push(centre(`reason: ${doc.reprintOf?.reason ?? ''}`, width));
    out.push(rule);
  }

  out.push(pair(`Bill: ${doc.number}`, doc.tradingDay, width));
  out.push(pair(`Lane: ${doc.laneId}`, `Till: ${doc.cashierId}`, width));
  out.push(rule);

  for (const line of doc.lines) {
    for (const part of wrap(line.description, width)) out.push(part);
    out.push(pair(`  ${quantityText(line)} x ${amount(line.unitPriceMinor)}`, amount(line.lineTotalMinor), width));
  }

  out.push(rule);
  out.push(pair('Subtotal', amount(doc.netMinor), width));
  for (const band of doc.taxBands) {
    out.push(pair(`GST ${(band.rateBps / 100).toFixed(band.rateBps % 100 === 0 ? 0 : 2)}%`, amount(band.taxMinor), width));
  }
  out.push(pair('TOTAL', amount(doc.totalMinor), width));
  out.push(rule);

  for (const tender of doc.tenders) {
    const label = tender.reference ? `${tender.kind} (${tender.reference})` : tender.kind;
    out.push(pair(label, amount(tender.amountMinor), width));
  }
  if (doc.changeMinor !== undefined && doc.changeMinor > 0) {
    out.push(pair('Change', amount(doc.changeMinor), width));
  }

  out.push(rule);
  for (const line of doc.footer) out.push(centre(line, width));

  return out;
}
