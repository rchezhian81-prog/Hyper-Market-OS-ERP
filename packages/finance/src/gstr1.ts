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
  /** A7: the GST Compensation Cess on the line (GSTN `csamt`). Absent = none. */
  readonly cessMinor?: number;
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
  /** A7: the compensation cess in this HSN/rate row — present only when a line in it carries one. */
  readonly cessMinor?: number;
}

export interface Gstr1Table12 {
  readonly rows: readonly HsnSummaryRow[];
  readonly totalTaxableMinor: number;
  readonly totalTaxMinor: number;
  readonly b2bTaxableMinor: number;
  readonly b2cTaxableMinor: number;
  /** A7: the cess across the table — present only when any row carries one. */
  readonly totalCessMinor?: number;
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
    cgstMinor: number; sgstMinor: number; igstMinor: number; b2bTaxableMinor: number; b2cTaxableMinor: number; cessMinor?: number;
  }>();
  for (const l of lines) {
    const key = `${l.hsnCode}|${l.rateBps}`;
    const row = acc.get(key) ?? { hsnCode: l.hsnCode, rateBps: l.rateBps, quantityMinor: 0, taxableMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0, b2bTaxableMinor: 0, b2cTaxableMinor: 0 };
    if (l.cessMinor !== undefined && l.cessMinor !== 0) row.cessMinor = (row.cessMinor ?? 0) + l.cessMinor;
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
  const totalCessMinor = rows.reduce((s, r) => s + (r.cessMinor ?? 0), 0);
  return {
    rows,
    totalTaxableMinor,
    totalTaxMinor,
    b2bTaxableMinor,
    b2cTaxableMinor,
    ...(rows.some((r) => r.cessMinor !== undefined) ? { totalCessMinor } : {}),
    detail: `${rows.length} HSN/rate row(s); taxable ${totalTaxableMinor} (B2B ${b2bTaxableMinor}, B2C ${b2cTaxableMinor}), tax ${totalTaxMinor}${totalCessMinor !== 0 ? `, compensation cess ${totalCessMinor}` : ''}`,
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
  /**
   * OB-428: the place of supply — the 2-digit GST State code the document's CGST + SGST or IGST split was judged on (for a
   * B2B tax invoice, the delivery State it records). Absent on a document recorded before it was carried.
   */
  readonly placeOfSupplyStateCode?: string;
  readonly lines: readonly OutwardSupplyLine[];
}

export interface RateSummary {
  readonly rateBps: number;
  readonly taxableMinor: number;
  readonly cgstMinor: number;
  readonly sgstMinor: number;
  readonly igstMinor: number;
  /** A7: the compensation cess at this rate — present only when a line carries one. */
  readonly cessMinor?: number;
}

export interface B2bInvoice {
  readonly recipientGstin: string;
  readonly invoiceNumber: string;
  readonly invoiceDate: string;
  readonly invoiceValueMinor: number;
  /** OB-428: the State code the invoice records as its place of supply, when it records one. */
  readonly placeOfSupplyStateCode?: string;
  readonly rateLines: readonly RateSummary[];
}

/**
 * OB-431: a supply to an unregistered buyer (no GSTIN), kept invoice by invoice so the GSTN file can place it State-wise in
 * B2CS, or — inter-State and above the legal value (`b2clThresholdOn`) — invoice-wise in B2CL. The value is what the invoice
 * was for: its taxable value, GST and compensation cess.
 */
export interface B2cInvoice {
  readonly invoiceNumber: string;
  readonly invoiceDate: string;
  readonly invoiceValueMinor: number;
  /** The State code the document records as its place of supply, when it records one. */
  readonly placeOfSupplyStateCode?: string;
  readonly rateLines: readonly RateSummary[];
}

export interface Gstr1Return {
  readonly b2b: readonly B2bInvoice[];
  readonly b2c: readonly RateSummary[];
  /** OB-431: the same B2C supplies as `b2c`, document by document (what the GSTN file's B2CS and B2CL are built from). */
  readonly b2cInvoices: readonly B2cInvoice[];
  readonly hsn: Gstr1Table12;
  readonly totalTaxableMinor: number;
  readonly totalTaxMinor: number;
}

function summariseByRate(lines: readonly OutwardSupplyLine[]): RateSummary[] {
  const acc = new Map<number, { rateBps: number; taxableMinor: number; cgstMinor: number; sgstMinor: number; igstMinor: number; cessMinor?: number }>();
  for (const l of lines) {
    const row = acc.get(l.rateBps) ?? { rateBps: l.rateBps, taxableMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 };
    row.taxableMinor += l.taxableMinor;
    row.cgstMinor += l.cgstMinor;
    row.sgstMinor += l.sgstMinor;
    row.igstMinor += l.igstMinor;
    if (l.cessMinor !== undefined && l.cessMinor !== 0) row.cessMinor = (row.cessMinor ?? 0) + l.cessMinor;
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
  const b2cInvoices: B2cInvoice[] = [];
  const b2cLines: OutwardSupplyLine[] = [];
  for (const doc of docs) {
    const rateLines = summariseByRate(doc.lines);
    const pos = doc.placeOfSupplyStateCode === undefined ? {} : { placeOfSupplyStateCode: doc.placeOfSupplyStateCode };
    if (isB2b(doc)) {
      const invoiceValueMinor = rateLines.reduce((s, r) => s + r.taxableMinor + r.cgstMinor + r.sgstMinor + r.igstMinor, 0);
      b2b.push({ recipientGstin: doc.recipientGstin as string, invoiceNumber: doc.documentId, invoiceDate: doc.documentDate, invoiceValueMinor, ...pos, rateLines });
    } else {
      b2cLines.push(...doc.lines);
      // OB-431: the invoice value the B2CL line is judged on is the whole invoice — taxable value, GST and cess.
      const invoiceValueMinor = rateLines.reduce((s, r) => s + r.taxableMinor + r.cgstMinor + r.sgstMinor + r.igstMinor + (r.cessMinor ?? 0), 0);
      b2cInvoices.push({ invoiceNumber: doc.documentId, invoiceDate: doc.documentDate, invoiceValueMinor, ...pos, rateLines });
    }
  }
  b2b.sort((a, b) => a.recipientGstin.localeCompare(b.recipientGstin) || a.invoiceNumber.localeCompare(b.invoiceNumber));
  b2cInvoices.sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate) || a.invoiceNumber.localeCompare(b.invoiceNumber));
  const classified: ClassifiedLine[] = docs.flatMap((d) => d.lines.map((l) => ({ ...l, supplyKind: isB2b(d) ? 'b2b' as const : 'b2c' as const })));
  const hsn = gstr1Table12(classified);
  return { b2b, b2c: summariseByRate(b2cLines), b2cInvoices, hsn, totalTaxableMinor: hsn.totalTaxableMinor, totalTaxMinor: hsn.totalTaxMinor };
}

// --- the GSTN portal JSON (the file the GST portal actually accepts) -------------------------------
//
// The return above is our clean shape; this serialises it into the GSTN GSTR-1 JSON the portal ingests.
// Two conversions matter and are easy to get wrong: money is stored in **paise** and the portal wants
// **rupees** (÷100), and dates are stored `YYYY-MM-DD` while the portal wants `DD-MM-YYYY`. B2B invoices
// are grouped by counterparty GSTIN (`ctin`), each carrying its own invoices (`inv`) and rate-wise items
// (`itms`/`itm_det`); B2C is rate-wise (`b2cs`); the HSN summary is `hsn.data`.
//
// This is faithful to the documented schema, but the portal's offline validation tool is the authority —
// a first live filing should round-trip through it before submission (recorded as an owner check).
//
// OB-428 (owner, option A, 27 Oct 2026, in writing): each B2B invoice carries, at the invoice level as the GSTN schema
// puts them, its place of supply `pos` (the 2-digit State code), the reverse-charge flag `rchrg` and the invoice type
// `inv_typ`. `rchrg` is always "N": this system has no outward supply under reverse charge (reverse charge here is only
// on what the shop BUYS — GSTR-3B Table 3.1(d), A14 — and the till's tax invoice prints "reverse charge: No"). `inv_typ` is
// always "R" (regular): no export, SEZ or deemed-export invoice is made here. The `pos` is the State the invoice records;
// an invoice recorded without one that charged only CGST + SGST is, by that split, a supply inside the filer's own State
// (the first two digits of the filer's GSTIN). One that charged IGST with no State recorded, or whose State disagrees with
// its split, is NOT guessed: the file is refused, naming each invoice (`Gstr1ExportRefused`).
//
// OB-431 (owner, option A, 28 Oct 2026, in writing): supplies to unregistered buyers go State-wise. Each `b2cs` row carries
// its place of supply `pos` and is one (supply type, place of supply, rate) group — the GSTN schema's `sply_ty` "INTRA"
// when the place of supply is the filer's own State, "INTER" otherwise. An inter-State B2C invoice whose value is above
// the legal line (`b2clThresholdOn` — the line is dated) is reported invoice by invoice in `b2cl`, grouped by place of
// supply, and is then NOT also in `b2cs`. Every B2C document's place of supply is judged the same way as a B2B invoice's
// (`judgePlaceOfSupply`); one that cannot be judged stops the file by name with the B2B ones, never guessed.

export interface GstnItemDetail { readonly rt: number; readonly txval: number; readonly camt: number; readonly samt: number; readonly iamt: number; }
export interface GstnInvoiceItem { readonly num: number; readonly itm_det: GstnItemDetail; }
export interface GstnB2bInvoice { readonly inum: string; readonly idt: string; readonly val: number; readonly pos: string; readonly rchrg: 'Y' | 'N'; readonly inv_typ: 'R'; readonly itms: readonly GstnInvoiceItem[]; }
export interface GstnB2b { readonly ctin: string; readonly inv: readonly GstnB2bInvoice[]; }
export interface GstnB2cs { readonly sply_ty: 'INTRA' | 'INTER'; readonly pos: string; readonly typ: 'OE'; readonly rt: number; readonly txval: number; readonly camt: number; readonly samt: number; readonly iamt: number; readonly csamt?: number; }
/** OB-431: a B2CL invoice item — inter-State only, so IGST (and any cess), never CGST/SGST. */
export interface GstnB2clItemDetail { readonly rt: number; readonly txval: number; readonly iamt: number; readonly csamt?: number; }
export interface GstnB2clItem { readonly num: number; readonly itm_det: GstnB2clItemDetail; }
export interface GstnB2clInvoice { readonly inum: string; readonly idt: string; readonly val: number; readonly itms: readonly GstnB2clItem[]; }
export interface GstnB2cl { readonly pos: string; readonly inv: readonly GstnB2clInvoice[]; }
export interface GstnHsnRow { readonly num: number; readonly hsn_sc: string; readonly rt: number; readonly qty: number; readonly txval: number; readonly camt: number; readonly samt: number; readonly iamt: number; }
export interface GstnGstr1 {
  readonly gstin: string;
  readonly fp: string;
  readonly b2b: readonly GstnB2b[];
  readonly b2cl: readonly GstnB2cl[];
  readonly b2cs: readonly GstnB2cs[];
  readonly hsn: { readonly data: readonly GstnHsnRow[] };
}

/** Paise → rupees, rounded to 2 decimals (the portal's money unit). */
const rupees = (minor: number): number => Math.round(minor) / 100;
/** `YYYY-MM-DD` → `DD-MM-YYYY` (the portal's date form). */
const gstnDate = (iso: string): string => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
/** basis points → a percentage rate (500 bps → 5). */
const pct = (bps: number): number => bps / 100;

// --- the B2CL line (a dated rule, CGST Rules 2017, rule 59(4)) --------------------------------------------------------
//
// An inter-State supply to an unregistered buyer is reported invoice-wise (B2CL) when the invoice value is MORE THAN the
// line in force on the invoice date, and State-wise in B2CS otherwise. The line was ₹2,50,000 from the start of GST and
// is ₹1,00,000 for invoices dated on or after 1 August 2024 (Notification No. 12/2024–Central Tax). A statutory number,
// not the owner's; a later change is a new row here, never an edit to an old one.

export interface B2clThreshold {
  /** The first invoice date (YYYY-MM-DD) this line applies to. */
  readonly effectiveFrom: string;
  /** An invoice value MORE THAN this (paise) goes to B2CL; equal to it stays in B2CS. */
  readonly exceedsMinor: number;
  readonly basis: string;
}

export const B2CL_THRESHOLDS: readonly B2clThreshold[] = [
  { effectiveFrom: '2017-07-01', exceedsMinor: 25_000_000, basis: 'CGST Rules 2017, rule 59(4)(a)(ii): inter-State supplies to unregistered persons with invoice value more than ₹2,50,000' },
  { effectiveFrom: '2024-08-01', exceedsMinor: 10_000_000, basis: 'rule 59(4)(a)(ii) as amended by Notification No. 12/2024–Central Tax: invoice value more than ₹1,00,000, for invoices from 1 August 2024' },
];

/** The B2CL line in force on an invoice date, or undefined for a date before GST began (1 July 2017). Pure. */
export function b2clThresholdOn(invoiceDate: string, table: readonly B2clThreshold[] = B2CL_THRESHOLDS): B2clThreshold | undefined {
  return [...table].filter((t) => t.effectiveFrom <= invoiceDate).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)).pop();
}

/** A document the GSTN file cannot be made with, named. `recipientGstin` is absent for a supply to an unregistered buyer. */
export interface Gstr1ExportProblem { readonly invoiceNumber: string; readonly recipientGstin?: string; readonly why: string }

/** OB-428 · OB-431: the GSTN file cannot be made as it stands — each named document's place of supply is missing or disagrees. */
export class Gstr1ExportRefused extends Error {
  constructor(readonly problems: readonly Gstr1ExportProblem[]) {
    super(`the GSTR-1 file cannot be made: ${problems.map((p) => `${p.invoiceNumber} (${p.recipientGstin ?? 'unregistered buyer'}) — ${p.why}`).join('; ')}`);
    this.name = 'Gstr1ExportRefused';
  }
}

/**
 * OB-428 · OB-431: the place of supply a document files under, or why it cannot be said. The State it records is used; with
 * none, a document with only CGST + SGST (or no tax) is inside the filer's own State. The split must agree with the State:
 * CGST + SGST only inside the filer's State, IGST only outside it. Pure.
 */
export function judgePlaceOfSupply(rateLines: readonly RateSummary[], recorded: string | undefined, filerGstin: string): { readonly pos: string } | { readonly why: string } {
  const own = filerGstin.slice(0, 2);
  const igst = rateLines.some((r) => r.igstMinor !== 0);
  const local = rateLines.some((r) => r.cgstMinor !== 0 || r.sgstMinor !== 0);
  const pos = recorded ?? (igst ? undefined : own);
  if (pos === undefined) return { why: 'it charged IGST (a supply to another State) but no place of supply is recorded on it' };
  if (!/^\d{2}$/.test(pos)) return { why: `its place of supply "${pos}" is not a 2-digit State code` };
  if (pos === own && igst) return { why: `it charged IGST but its place of supply (${pos}) is the filer's own State` };
  if (pos !== own && local) return { why: `it charged CGST + SGST but its place of supply (${pos}) is not the filer's own State (${own})` };
  return { pos };
}

/** OB-428: the place of supply a B2B invoice files under in the GSTN file, or why it cannot be said (`judgePlaceOfSupply`). */
export function gstnPlaceOfSupply(inv: B2bInvoice, filerGstin: string): { readonly pos: string } | { readonly why: string } {
  return judgePlaceOfSupply(inv.rateLines, inv.placeOfSupplyStateCode, filerGstin);
}

/** One B2CS group, summed in paise before the single conversion to rupees. */
export interface B2csGroup { readonly sply_ty: 'INTRA' | 'INTER'; readonly pos: string; readonly rateBps: number; taxable: number; cgst: number; sgst: number; igst: number; cess?: number }

/** OB-431: add a rate line to its (supply type, place of supply, rate) B2CS group. */
export function addToB2cs(acc: Map<string, B2csGroup>, sply: 'INTRA' | 'INTER', pos: string, r: RateSummary): void {
  const k = `${sply}|${pos}|${r.rateBps}`;
  const row = acc.get(k) ?? { sply_ty: sply, pos, rateBps: r.rateBps, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
  row.taxable += r.taxableMinor; row.cgst += r.cgstMinor; row.sgst += r.sgstMinor; row.igst += r.igstMinor;
  if (r.cessMinor !== undefined && r.cessMinor !== 0) row.cess = (row.cess ?? 0) + r.cessMinor;
  acc.set(k, row);
}

/** OB-431: the B2CS rows, ordered by supply type, place of supply and rate (stable, diffable), in rupees. */
export function b2csRows(acc: ReadonlyMap<string, B2csGroup>): GstnB2cs[] {
  return [...acc.values()]
    .sort((a, b) => a.sply_ty.localeCompare(b.sply_ty) || a.pos.localeCompare(b.pos) || a.rateBps - b.rateBps)
    .map((r) => ({ sply_ty: r.sply_ty, pos: r.pos, typ: 'OE' as const, rt: pct(r.rateBps), txval: rupees(r.taxable), camt: rupees(r.cgst), samt: rupees(r.sgst), iamt: rupees(r.igst), ...(r.cess === undefined ? {} : { csamt: rupees(r.cess) }) }));
}

/**
 * Serialise a GSTR-1 return into the GSTN portal JSON. `gstin` is the supplier's own GSTIN and `fp` is the
 * filing period `MMYYYY` — both supplied per export rather than stored, so the same period can be re-run.
 */
export function toGstnGstr1(ret: Gstr1Return, meta: { readonly gstin: string; readonly fp: string }): GstnGstr1 {
  const byCtin = new Map<string, GstnB2bInvoice[]>();
  const problems: Gstr1ExportProblem[] = [];
  for (const inv of ret.b2b) {
    const where = gstnPlaceOfSupply(inv, meta.gstin);
    if ('why' in where) { problems.push({ invoiceNumber: inv.invoiceNumber, recipientGstin: inv.recipientGstin, why: where.why }); continue; }
    const invoice: GstnB2bInvoice = {
      inum: inv.invoiceNumber,
      idt: gstnDate(inv.invoiceDate),
      val: rupees(inv.invoiceValueMinor),
      pos: where.pos,
      rchrg: 'N',
      inv_typ: 'R',
      itms: inv.rateLines.map((r, i) => ({ num: i + 1, itm_det: { rt: pct(r.rateBps), txval: rupees(r.taxableMinor), camt: rupees(r.cgstMinor), samt: rupees(r.sgstMinor), iamt: rupees(r.igstMinor) } })),
    };
    byCtin.set(inv.recipientGstin, [...(byCtin.get(inv.recipientGstin) ?? []), invoice]);
  }
  // OB-431: each B2C document — State-wise into B2CS, or (inter-State and above the dated line) invoice-wise into B2CL.
  const own = meta.gstin.slice(0, 2);
  const b2csAcc = new Map<string, B2csGroup>();
  const byPos = new Map<string, GstnB2clInvoice[]>();
  for (const inv of ret.b2cInvoices) {
    const where = judgePlaceOfSupply(inv.rateLines, inv.placeOfSupplyStateCode, meta.gstin);
    if ('why' in where) { problems.push({ invoiceNumber: inv.invoiceNumber, why: where.why }); continue; }
    const inter = where.pos !== own;
    if (inter) {
      const line = b2clThresholdOn(inv.invoiceDate);
      if (line === undefined) { problems.push({ invoiceNumber: inv.invoiceNumber, why: `it is dated ${inv.invoiceDate}, before GST began (1 July 2017)` }); continue; }
      if (inv.invoiceValueMinor > line.exceedsMinor) {
        byPos.set(where.pos, [...(byPos.get(where.pos) ?? []), {
          inum: inv.invoiceNumber,
          idt: gstnDate(inv.invoiceDate),
          val: rupees(inv.invoiceValueMinor),
          itms: inv.rateLines.map((r, i) => ({ num: i + 1, itm_det: { rt: pct(r.rateBps), txval: rupees(r.taxableMinor), iamt: rupees(r.igstMinor), ...(r.cessMinor === undefined ? {} : { csamt: rupees(r.cessMinor) }) } })),
        }]);
        continue;
      }
    }
    for (const r of inv.rateLines) addToB2cs(b2csAcc, inter ? 'INTER' : 'INTRA', where.pos, r);
  }
  if (problems.length > 0) throw new Gstr1ExportRefused(problems);
  const b2b: GstnB2b[] = [...byCtin.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([ctin, inv]) => ({ ctin, inv }));
  const b2cl: GstnB2cl[] = [...byPos.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([pos, inv]) => ({ pos, inv }));
  const data: GstnHsnRow[] = ret.hsn.rows.map((r, i) => ({ num: i + 1, hsn_sc: r.hsnCode, rt: pct(r.rateBps), qty: r.quantityMinor / 1000, txval: rupees(r.taxableMinor), camt: rupees(r.cgstMinor), samt: rupees(r.sgstMinor), iamt: rupees(r.igstMinor) }));
  return { gstin: meta.gstin, fp: meta.fp, b2b, b2cl, b2cs: b2csRows(b2csAcc), hsn: { data } };
}
