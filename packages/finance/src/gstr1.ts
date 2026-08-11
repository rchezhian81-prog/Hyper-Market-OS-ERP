// GSTR-1 Table 12 — the HSN-wise summary of outward supplies (roadmap v2.1 A5). The monthly GST return
// summarises every sale by its HSN code, taxable value and tax, split between registered buyers (B2B) and
// consumers (B2C). The rule the acceptance names: the HSN comes from a CLOSED MASTER, never free text — a
// typed-in or malformed HSN is rejected, because a wrong HSN files the wrong tax against the wrong heading.
//
// This is the read side of the write-path increment: sales persist their tax-relevant lines (HSN, taxable
// value, the CGST/SGST/IGST split) as append-only outward-supply facts, and this folds them into the
// return. The tax facts are captured AS THEY WERE at the time of supply — a product's HSN changing next
// year must not rewrite last month's return — which is exactly why the line is stored, not re-derived.
//
// Pure and deterministic. The HSN digit rule (A4) is reused, not restated.

import { validateHsnForTurnover, InvalidHsnInput } from './hsn';

export type SupplyKind = 'b2b' | 'b2c';

export interface OutwardSupplyLine {
  readonly hsnCode: string;
  readonly description?: string;
  readonly quantityMinor: number;
  readonly uom: string;
  readonly taxableMinor: number;
  readonly rateBps: number;
  readonly cgstMinor: number;
  readonly sgstMinor: number;
  readonly igstMinor: number;
}

export interface ClassifiedLine extends OutwardSupplyLine {
  readonly supplyKind: SupplyKind;
}

export interface LineCheck {
  readonly valid: boolean;
  readonly problems: readonly string[];
}

/**
 * Validate one outward-supply line before it is stored: the HSN must be a well-formed code of the digit
 * count the turnover requires (this is what "closed master, no free text" means — a malformed or typed-in
 * HSN throws and is rejected), the taxable value positive, and the tax split internally consistent (a line
 * is CGST+SGST *or* IGST, never both, and CGST must equal SGST).
 */
export function validateOutwardLine(line: OutwardSupplyLine, opts: { readonly annualTurnoverMinor: number }): LineCheck {
  const problems: string[] = [];
  try {
    const v = validateHsnForTurnover({ hsnCode: line.hsnCode, annualTurnoverMinor: opts.annualTurnoverMinor });
    if (!v.valid) problems.push(`hsnCode (${v.detail})`);
  } catch (e) {
    problems.push(e instanceof InvalidHsnInput ? `hsnCode (${e.message} — a free-text or malformed HSN is rejected)` : 'hsnCode');
  }
  if (!Number.isInteger(line.taxableMinor) || line.taxableMinor <= 0) problems.push('taxableMinor (a positive integer)');
  if (!Number.isInteger(line.rateBps) || line.rateBps < 0) problems.push('rateBps (a non-negative integer)');
  for (const [name, value] of [['cgstMinor', line.cgstMinor], ['sgstMinor', line.sgstMinor], ['igstMinor', line.igstMinor]] as const) {
    if (!Number.isInteger(value) || value < 0) problems.push(`${name} (a non-negative integer)`);
  }
  const intra = line.cgstMinor > 0 || line.sgstMinor > 0;
  const inter = line.igstMinor > 0;
  if (intra && inter) problems.push('tax split (a line is CGST+SGST or IGST, never both)');
  if (intra && line.cgstMinor !== line.sgstMinor) problems.push('tax split (CGST must equal SGST)');
  return { valid: problems.length === 0, problems };
}

export interface HsnSummaryRow {
  readonly hsnCode: string;
  readonly rateBps: number;
  readonly quantityMinor: number;
  readonly taxableMinor: number;
  readonly cgstMinor: number;
  readonly sgstMinor: number;
  readonly igstMinor: number;
  readonly b2bTaxableMinor: number;
  readonly b2cTaxableMinor: number;
}

export interface Gstr1Table12 {
  readonly rows: readonly HsnSummaryRow[];
  readonly totalTaxableMinor: number;
  readonly totalTaxMinor: number;
  readonly b2bTaxableMinor: number;
  readonly b2cTaxableMinor: number;
  readonly detail: string;
}

/**
 * GSTR-1 Table 12: group outward-supply lines by HSN and rate, summing quantity, taxable value and the
 * CGST/SGST/IGST split, and carrying the B2B/B2C split of the taxable value. Rows are ordered by HSN then
 * rate so the return is stable and diffable.
 */
export function gstr1Table12(lines: readonly ClassifiedLine[]): Gstr1Table12 {
  const acc = new Map<string, {
    hsnCode: string; rateBps: number; quantityMinor: number; taxableMinor: number;
    cgstMinor: number; sgstMinor: number; igstMinor: number; b2bTaxableMinor: number; b2cTaxableMinor: number;
  }>();
  for (const l of lines) {
    const key = `${l.hsnCode}|${l.rateBps}`;
    const row = acc.get(key) ?? { hsnCode: l.hsnCode, rateBps: l.rateBps, quantityMinor: 0, taxableMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0, b2bTaxableMinor: 0, b2cTaxableMinor: 0 };
    row.quantityMinor += l.quantityMinor;
    row.taxableMinor += l.taxableMinor;
    row.cgstMinor += l.cgstMinor;
    row.sgstMinor += l.sgstMinor;
    row.igstMinor += l.igstMinor;
    if (l.supplyKind === 'b2b') row.b2bTaxableMinor += l.taxableMinor; else row.b2cTaxableMinor += l.taxableMinor;
    acc.set(key, row);
  }
  const rows = [...acc.values()].sort((a, b) => a.hsnCode.localeCompare(b.hsnCode) || a.rateBps - b.rateBps);
  const totalTaxableMinor = rows.reduce((s, r) => s + r.taxableMinor, 0);
  const totalTaxMinor = rows.reduce((s, r) => s + r.cgstMinor + r.sgstMinor + r.igstMinor, 0);
  const b2bTaxableMinor = rows.reduce((s, r) => s + r.b2bTaxableMinor, 0);
  const b2cTaxableMinor = rows.reduce((s, r) => s + r.b2cTaxableMinor, 0);
  return {
    rows,
    totalTaxableMinor,
    totalTaxMinor,
    b2bTaxableMinor,
    b2cTaxableMinor,
    detail: `${rows.length} HSN/rate row(s); taxable ${totalTaxableMinor} (B2B ${b2bTaxableMinor}, B2C ${b2cTaxableMinor}), tax ${totalTaxMinor}`,
  };
}

// --- the full GSTR-1 return: B2B invoice-level + B2C rate-wise + HSN Table 12 -----------------------
//
// GSTR-1 reports registered-buyer (B2B) supplies invoice-by-invoice — the buyer claims input credit
// against each one, so the detail must survive — while consumer (B2C) supplies are reported only rate-wise
// in aggregate. Both are assembled here from the same stored outward-supply lines, so the return can never
// disagree with the HSN summary about the same sale.

export interface OutwardDocument {
  readonly documentId: string;
  readonly documentDate: string;
  readonly supplyType: SupplyKind;
  readonly recipientGstin?: string;
  readonly lines: readonly OutwardSupplyLine[];
}

export interface RateSummary {
  readonly rateBps: number;
  readonly taxableMinor: number;
  readonly cgstMinor: number;
  readonly sgstMinor: number;
  readonly igstMinor: number;
}

export interface B2bInvoice {
  readonly recipientGstin: string;
  readonly invoiceNumber: string;
  readonly invoiceDate: string;
  readonly invoiceValueMinor: number;
  readonly rateLines: readonly RateSummary[];
}

export interface Gstr1Return {
  readonly b2b: readonly B2bInvoice[];
  readonly b2c: readonly RateSummary[];
  readonly hsn: Gstr1Table12;
  readonly totalTaxableMinor: number;
  readonly totalTaxMinor: number;
}

function summariseByRate(lines: readonly OutwardSupplyLine[]): RateSummary[] {
  const acc = new Map<number, { rateBps: number; taxableMinor: number; cgstMinor: number; sgstMinor: number; igstMinor: number }>();
  for (const l of lines) {
    const row = acc.get(l.rateBps) ?? { rateBps: l.rateBps, taxableMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 };
    row.taxableMinor += l.taxableMinor;
    row.cgstMinor += l.cgstMinor;
    row.sgstMinor += l.sgstMinor;
    row.igstMinor += l.igstMinor;
    acc.set(l.rateBps, row);
  }
  return [...acc.values()].sort((a, b) => a.rateBps - b.rateBps);
}

const isB2b = (doc: OutwardDocument): boolean =>
  doc.supplyType === 'b2b' && typeof doc.recipientGstin === 'string' && doc.recipientGstin !== '';

/**
 * Assemble the GSTR-1 return from stored outward-supply documents: B2B invoice-by-invoice (with a
 * recipient GSTIN and a rate-wise breakdown per invoice), B2C rate-wise in aggregate, and the HSN Table 12
 * over everything. A "B2B" document with no recipient GSTIN is treated as B2C — it cannot be filed as B2B.
 */
export function gstr1Return(docs: readonly OutwardDocument[]): Gstr1Return {
  const b2b: B2bInvoice[] = [];
  const b2cLines: OutwardSupplyLine[] = [];
  for (const doc of docs) {
    if (isB2b(doc)) {
      const rateLines = summariseByRate(doc.lines);
      const invoiceValueMinor = rateLines.reduce((s, r) => s + r.taxableMinor + r.cgstMinor + r.sgstMinor + r.igstMinor, 0);
      b2b.push({ recipientGstin: doc.recipientGstin as string, invoiceNumber: doc.documentId, invoiceDate: doc.documentDate, invoiceValueMinor, rateLines });
    } else {
      b2cLines.push(...doc.lines);
    }
  }
  b2b.sort((a, b) => a.recipientGstin.localeCompare(b.recipientGstin) || a.invoiceNumber.localeCompare(b.invoiceNumber));
  const classified: ClassifiedLine[] = docs.flatMap((d) => d.lines.map((l) => ({ ...l, supplyKind: isB2b(d) ? 'b2b' as const : 'b2c' as const })));
  const hsn = gstr1Table12(classified);
  return { b2b, b2c: summariseByRate(b2cLines), hsn, totalTaxableMinor: hsn.totalTaxableMinor, totalTaxMinor: hsn.totalTaxMinor };
}
