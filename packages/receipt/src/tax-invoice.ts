// The LEGAL GST tax invoice on the till's bill (OB-271 · roadmap v2.1 A1, A2, A4, A8, A9 · CGST Rule 46 · hard rule #1).
//
// During the mirror pilot (OB-248) the old ERP's bill is the legal record and the new till's bill is never handed over.
// For real trading the new till's bill IS the tax invoice, so it must carry every field Rule 46 requires — or not be
// issued at all. This file is that rule, pure and local (no network, no clock):
//
//   • `buildTaxInvoice` assembles the invoice from the committed bill and the shop's legal identity (its legal name,
//     address and GSTIN, from the store's setup) and runs the A1 checker (`checkTaxInvoiceFields`) on every line, with the
//     HSN digit rule for the owner's turnover band (A4, OB-149: 6 digits), the CGST + SGST split for an over-the-counter
//     sale with the store's State as the place of supply (A8), and the tax pulled out of the MRP to the paisa (A9). Any
//     missing field is a REFUSAL with the plain words for it — the till refuses the sale before the disk, so a
//     non-compliant bill can never be issued;
//   • `taxInvoiceRows` lays the invoice out for paper (80 mm, or 58 mm), in English or Tamil, every field row tagged with
//     the field it carries, and a reprint marked DUPLICATE;
//   • `invoiceRenderProblems` is the contract: it reads a rendered invoice back and names every mandatory field the
//     render does not show. The till prints only a render with none missing.
//
// The owner's decisions (21 Oct 2026, in writing; the CA confirms them before real trading is switched on):
//   • OB-278 · Rule 46A: a bill with ANY untaxed (exempt or nil-rated, 0%) line is ONE "Invoice-cum-Bill of Supply"; an
//     all-taxed bill stays a "Tax Invoice". An untaxed line shows as exempt / nil with no tax;
//   • OB-279 · addendum A10: each tax component of the bill — CGST and SGST — is rounded to the nearest rupee (50 paise and
//     up rounds up). The bill's total is the ROUNDED total: taxable value + untaxed value + rounded CGST + rounded SGST;
//   • OB-285 · roadmap B1 · Legal Metrology: a bill is NEVER above the goods' exact MRP-based total (what the lines were
//     charged, to the paisa). When the rounded tax would take it above, a stated, negative "Round off" (never more than
//     ₹1) brings it back to that total. The paper reconciles: taxable + untaxed + rounded CGST + rounded SGST + round
//     off = total;
//   • OB-280: a bill of ₹50,000 or more (Rule 46(e) needs the buyer's name and address) is REFUSED — "bill this on the old
//     system". Business (B2B) bills are not taken at this till at all and also go to the old system.

import { checkTaxInvoiceFields, TAX_INVOICE_TITLE, INVOICE_CUM_BILL_OF_SUPPLY_TITLE } from '../../finance/src/invoice-fields';
import { validateHsnForTurnover, InvalidHsnInput, OWNER_TURNOVER_BAND_FOR_HSN_MINOR } from '../../finance/src/hsn';
import { extractInclusiveGst, InvalidInclusiveTaxInput, roundToNearestRupeeMinor } from '../../finance/src/inclusive-tax';
import { gstStateOf } from '../../finance/src/gst-states';
import { quantityLabel, normaliseUom } from '../../contracts/src/quantity';

/** The shop's legal identity as a tax invoice prints it — from the store's setup (OB-257 `shop`), never typed at a till. */
export interface TaxInvoiceIdentity {
  /** The legal name exactly as on the GST registration certificate. */
  readonly legalName: string;
  /** The 15-character GSTIN the store's sales are filed under. */
  readonly gstin: string;
  /** The store's address (its place of business), one printed line per entry. */
  readonly placeOfBusiness: readonly string[];
}

/** One bill line, as the till committed it (GST inside the line total — A9). */
export interface TaxInvoiceLineInput {
  readonly description: string;
  readonly hsnCode?: string;
  /** Quantity in the unit's smallest step (2 ea, 1234 g). */
  readonly quantityMinor: number;
  readonly uom: string;
  readonly unitPriceMinor: number;
  /** What the line was charged, GST inside, after any discount attributed to it. */
  readonly lineTotalMinor: number;
  readonly taxRateBps: number;
}

export interface TaxInvoiceTenderInput {
  readonly kind: string;
  readonly amountMinor: number;
  /** OB-271: the card machine's or UPI's approval / reference number the cashier typed (never card data). */
  readonly machineRef?: string;
}

export interface TaxInvoiceInput {
  readonly identity: TaxInvoiceIdentity | null | undefined;
  /** The gap-free bill number the store computer issued (A2/A3) — the invoice's serial number. */
  readonly number: string;
  /** When the sale was committed (ISO-8601 UTC) — the invoice's date and time of issue, in India time. */
  readonly committedAt: string;
  readonly laneId: string;
  readonly cashierId: string;
  readonly lines: readonly TaxInvoiceLineInput[];
  /** What the customer paid with — printed, never part of the legal check. */
  readonly tenders?: readonly TaxInvoiceTenderInput[];
  readonly changeMinor?: number;
  /** The annual turnover the HSN digit rule is judged at. Absent → the owner's band (OB-149: above ₹5 crore → 6 digits). */
  readonly annualTurnoverMinor?: number;
  /** OB-279 · OB-285: what the till is about to charge — checked against the invoice's total (they must be the same). */
  readonly totalMinor?: number;
}

export interface TaxInvoiceLine {
  readonly description: string;
  readonly hsnCode: string;
  readonly quantityMinor: number;
  readonly uom: string;
  readonly unitPriceMinor: number;
  readonly rateBps: number;
  /** The value of supply (A9): the line total with the GST pulled out, to the paisa. */
  readonly taxableMinor: number;
  readonly cgstMinor: number;
  readonly sgstMinor: number;
  /** taxable + CGST + SGST — exactly what the line was charged. */
  readonly lineTotalMinor: number;
  /** OB-278: an untaxed (exempt or nil-rated, 0%) line — its whole value is the value of supply, with no tax. */
  readonly untaxed: boolean;
}

/** One GST rate on the bill: what it applied to and the CGST and SGST it gave (half the rate each — A8). */
export interface TaxInvoiceBand {
  readonly rateBps: number;
  readonly taxableMinor: number;
  readonly cgstMinor: number;
  readonly sgstMinor: number;
}

export type TaxInvoiceTitle = typeof TAX_INVOICE_TITLE | typeof INVOICE_CUM_BILL_OF_SUPPLY_TITLE;

export interface TaxInvoiceDocument {
  /** OB-278: "Tax Invoice" when every line is taxed; "Invoice-cum-Bill of Supply" (Rule 46A) when any line is untaxed. */
  readonly title: TaxInvoiceTitle;
  readonly supplier: { readonly legalName: string; readonly placeOfBusiness: readonly string[]; readonly gstin: string; readonly stateCode: string; readonly stateName: string };
  readonly number: string;
  /** YYYY-MM-DD, India time. */
  readonly date: string;
  /** HH:MM, India time. */
  readonly time: string;
  /** An over-the-counter sale: supplied in the store's own State (A8). */
  readonly placeOfSupply: { readonly kind: 'intra_state'; readonly stateCode: string; readonly stateName: string };
  /** Tax is never payable by the buyer on reverse charge for a retail counter sale (Rule 46(p)). */
  readonly reverseCharge: false;
  readonly lines: readonly TaxInvoiceLine[];
  /** The taxed rates only; their CGST and SGST are the exact paisa (A9). */
  readonly bands: readonly TaxInvoiceBand[];
  /** The taxed lines' value of supply. */
  readonly taxableMinor: number;
  /** OB-278: the untaxed (exempt / nil) lines' value — no tax on it. 0 on a plain tax invoice. */
  readonly untaxedMinor: number;
  /** The exact CGST and SGST of the bill, to the paisa (A9) — before the OB-279 rounding. */
  readonly cgstExactMinor: number;
  readonly sgstExactMinor: number;
  /** OB-279 · A10: the bill's CGST and SGST, each rounded to the nearest rupee (50 paise and up rounds up). */
  readonly cgstMinor: number;
  readonly sgstMinor: number;
  readonly totalTaxMinor: number;
  /** What the lines were charged, added up — the goods' own total: the exact MRP-based amount, to the paisa (B1). */
  readonly goodsMinor: number;
  /** OB-279: rounded tax − exact tax — what rounding CGST and SGST to the rupee moved the tax by; at most ₹1 either way. */
  readonly taxRoundingMinor: number;
  /**
   * OB-285: the printed round off — 0, or below 0 when the rounded tax would have put the bill above the goods' exact
   * MRP-based total: the bill is then brought back down to it. Never above 0; never more than ₹1.
   */
  readonly roundOffMinor: number;
  /**
   * The bill's total: taxable + untaxed + rounded CGST + rounded SGST + round off — never above the goods' exact MRP-based
   * total (OB-285). What the customer pays.
   */
  readonly totalMinor: number;
  readonly tenders: readonly TaxInvoiceTenderInput[];
  readonly changeMinor?: number;
  readonly laneId: string;
  readonly cashierId: string;
}

/** What is missing or wrong, by field, with the words for a cashier. Several may come back at once. */
export type TaxInvoiceProblemCode =
  | 'supplier_legal_name' | 'supplier_address' | 'supplier_gstin' | 'place_of_supply'
  | 'invoice_number' | 'invoice_date'
  | 'line_description' | 'line_quantity' | 'line_unit' | 'line_hsn' | 'line_hsn_digits' | 'line_rate' | 'line_taxable_value'
  | 'recipient_details' | 'totals';

export interface TaxInvoiceProblem {
  readonly code: TaxInvoiceProblemCode;
  /** The line (0-based) a line problem is about. */
  readonly line?: number;
  readonly words: string;
}

export type TaxInvoiceBuild =
  | { readonly ok: true; readonly doc: TaxInvoiceDocument }
  | { readonly ok: false; readonly problems: readonly TaxInvoiceProblem[]; readonly laneMessage: string };

/** Rule 46(e) · OB-280: a bill of this total or more needs the buyer's name and address — refused here, old system only. */
export const UNREGISTERED_RECIPIENT_DETAILS_FROM_MINOR = 50_000_00;

/** OB-279: the tax rounding can never be more than ₹1 either way (two components, each moved by at most 50 paise). */
export const MAX_ROUND_OFF_MINOR = 100;

/**
 * OB-279 · addendum A10 · OB-285 — the bill's CGST and SGST, each rounded to the nearest rupee, and what that does to the
 * bill. Pure. The exact components are the sum of each taxed line's own (A9: pulled out of what the line was charged, the
 * odd paisa on SGST); an untaxed line, or one whose rate cannot be split, adds nothing (the invoice itself refuses that).
 *
 * OB-285 (owner, 21 Oct 2026): a bill is never above the goods' exact MRP-based total (roadmap B1, Legal Metrology). When
 * the rounded tax would take it above (`taxRoundingMinor` > 0), the round off goes the other way by the same amount, so
 * the bill is the exact total and the customer never pays more; otherwise the round off is 0 and the bill is the rounded
 * total, as OB-279 set it. `totalLessGoodsMinor` is what the bill is below the goods (0 or less): what the till charges
 * on top of the lines, and what the record carries as its round off.
 */
export function invoiceRoundOff(lines: readonly { readonly lineTotalMinor: number; readonly taxRateBps: number }[]): {
  readonly cgstExactMinor: number; readonly sgstExactMinor: number; readonly cgstMinor: number; readonly sgstMinor: number;
  readonly taxRoundingMinor: number; readonly roundOffMinor: number; readonly totalLessGoodsMinor: number;
} {
  let cgst = 0;
  let sgst = 0;
  for (const l of lines) {
    if (!Number.isSafeInteger(l.lineTotalMinor) || l.lineTotalMinor <= 0 || !Number.isSafeInteger(l.taxRateBps) || l.taxRateBps <= 0) continue;
    try {
      const b = extractInclusiveGst({ mrpMinor: l.lineTotalMinor, rateBps: l.taxRateBps, placeOfSupply: 'intra_state' });
      cgst += b.components.find((c) => c.component === 'CGST')?.amountMinor ?? 0;
      sgst += b.components.find((c) => c.component === 'SGST')?.amountMinor ?? 0;
    } catch (e) {
      if (!(e instanceof InvalidInclusiveTaxInput)) throw e;
    }
  }
  const cgstMinor = roundToNearestRupeeMinor(cgst);
  const sgstMinor = roundToNearestRupeeMinor(sgst);
  const taxRoundingMinor = cgstMinor + sgstMinor - cgst - sgst;
  // OB-285: above the goods? Then back down to them — never a paisa over what the lines were charged.
  const roundOffMinor = taxRoundingMinor > 0 ? -taxRoundingMinor : 0;
  return { cgstExactMinor: cgst, sgstExactMinor: sgst, cgstMinor, sgstMinor, taxRoundingMinor, roundOffMinor, totalLessGoodsMinor: taxRoundingMinor + roundOffMinor };
}

/** India time is UTC+05:30 all year (no daylight saving). */
const IST_OFFSET_MINUTES = 330;

/** The date and time of issue in India time, from an ISO-8601 instant — or `undefined` when it is not one. */
export function indiaDateTime(iso: string): { readonly date: string; readonly time: string } | undefined {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  const local = new Date(ms + IST_OFFSET_MINUTES * 60_000).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

const SETUP_NEXT = 'The shop\'s setup must be completed by the owner before real trading.';
const PROBLEM_WORDS: Readonly<Record<TaxInvoiceProblemCode, string>> = {
  supplier_legal_name: 'the shop\'s legal name is not set up',
  supplier_address: 'the shop\'s address is not set up',
  supplier_gstin: 'the shop\'s GSTIN is not set up or is not a valid GSTIN',
  place_of_supply: 'the State the shop is registered in cannot be read from its GSTIN',
  invoice_number: 'the bill number is not a valid invoice number (up to 16 letters, digits, - or /)',
  invoice_date: 'the date of the bill cannot be read',
  line_description: 'an item has no name',
  line_quantity: 'an item has no quantity',
  line_unit: 'an item has no unit',
  line_hsn: 'an item has no HSN code (or not a code of digits)',
  line_hsn_digits: 'an item\'s HSN code is too short (at least 6 digits are needed at this shop\'s turnover)',
  line_rate: 'an item\'s GST rate cannot be split into CGST and SGST',
  line_taxable_value: 'an item has no value',
  recipient_details: 'the bill is ₹50,000 or more, which needs the customer\'s name and address — the new till does not take them, so bill this on the old system',
  totals: 'the GST and the values do not add up to the total',
};

/** Plain words for a refusal: what is missing, and what to do. Never repeats a value that was not readable. */
function refusalWords(problems: readonly TaxInvoiceProblem[], descriptions: readonly string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const p of problems) {
    const item = p.line === undefined ? '' : `${descriptions[p.line] || `item ${p.line + 1}`}: `;
    const words = `${item}${p.words}`;
    if (!seen.has(words)) { seen.add(words); parts.push(words); }
  }
  const setup = problems.some((p) => p.code.startsWith('supplier_') || p.code === 'place_of_supply');
  const catalogue = problems.some((p) => p.code === 'line_hsn' || p.code === 'line_hsn_digits' || p.code === 'line_rate');
  const next = [
    ...(setup ? [SETUP_NEXT] : []),
    ...(catalogue ? ['Head office must correct the item in the price list.'] : []),
  ];
  return `This bill cannot be issued as a legal tax invoice, so it was NOT saved — do not take money. ${parts.join('; ')}.${next.length === 0 ? ' Tell the manager.' : ` ${next.join(' ')}`}`;
}

const isWholeNonNeg = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/**
 * Assemble the Rule 46 tax invoice for a committed bill, or refuse with every missing field named. Pure; never throws.
 * The A1 checker runs on every line with the invoice's own number, date, GSTIN and place of supply.
 */
export function buildTaxInvoice(input: TaxInvoiceInput): TaxInvoiceBuild {
  const problems: TaxInvoiceProblem[] = [];
  const add = (code: TaxInvoiceProblemCode, line?: number): void => {
    if (!problems.some((p) => p.code === code && p.line === line)) problems.push({ code, ...(line === undefined ? {} : { line }), words: PROBLEM_WORDS[code] });
  };

  const id = input.identity ?? undefined;
  const legalName = typeof id?.legalName === 'string' ? id.legalName.trim() : '';
  const gstin = typeof id?.gstin === 'string' ? id.gstin.trim().toUpperCase() : '';
  const address = Array.isArray(id?.placeOfBusiness) ? id!.placeOfBusiness.filter((l): l is string => typeof l === 'string').map((l) => l.trim()).filter((l) => l !== '') : [];
  if (legalName === '') add('supplier_legal_name');
  if (address.length === 0) add('supplier_address');
  const state = gstStateOf(gstin);
  if (gstin !== '' && state === undefined) add('place_of_supply');

  const when = indiaDateTime(input.committedAt);
  const date = when?.date ?? '';
  const turnover = input.annualTurnoverMinor ?? OWNER_TURNOVER_BAND_FOR_HSN_MINOR;

  if (input.lines.length === 0) add('line_description', 0);
  // OB-278: the heading follows the basket — any untaxed line makes the whole bill an invoice-cum-bill of supply.
  const title: TaxInvoiceTitle = input.lines.some((l) => l.taxRateBps === 0) ? INVOICE_CUM_BILL_OF_SUPPLY_TITLE : TAX_INVOICE_TITLE;
  const lines: TaxInvoiceLine[] = [];
  input.lines.forEach((l, i) => {
    const description = typeof l.description === 'string' ? l.description.trim() : '';
    if (description === '') add('line_description', i);
    if (!isWholeNonNeg(l.quantityMinor) || l.quantityMinor === 0) add('line_quantity', i);
    if (typeof l.uom !== 'string' || l.uom.trim() === '') add('line_unit', i);
    const hsn = typeof l.hsnCode === 'string' ? l.hsnCode.trim() : '';
    if (hsn === '') add('line_hsn', i);
    else {
      try {
        if (!validateHsnForTurnover({ hsnCode: hsn, annualTurnoverMinor: turnover }).valid) add('line_hsn_digits', i);
      } catch (e) {
        if (e instanceof InvalidHsnInput) add('line_hsn', i); else throw e;
      }
    }
    const rateBps = l.taxRateBps;
    if (!isWholeNonNeg(rateBps)) { add('line_rate', i); return; }
    if (!isWholeNonNeg(l.lineTotalMinor) || l.lineTotalMinor === 0) { add('line_taxable_value', i); return; }
    let split;
    try {
      // OB-278: an untaxed line (0%) is its own value with no tax component — `extractInclusiveGst` says exactly that.
      split = extractInclusiveGst({ mrpMinor: l.lineTotalMinor, rateBps, placeOfSupply: 'intra_state' });
    } catch (e) {
      if (e instanceof InvalidInclusiveTaxInput) { add('line_rate', i); return; } throw e;
    }
    const cgst = split.components.find((c) => c.component === 'CGST')?.amountMinor ?? 0;
    const sgst = split.components.find((c) => c.component === 'SGST')?.amountMinor ?? 0;
    // The A1 checker, on this line, with the invoice's own heading, GSTIN, number, date and place of supply.
    const check = checkTaxInvoiceFields({
      documentType: title, supplierGstin: gstin, invoiceNumber: input.number, invoiceDate: date,
      hsnCode: hsn, taxableMinor: split.taxableMinor, rateBps, placeOfSupply: 'intra_state', taxComponents: split.components.map((c) => c.component),
    });
    for (const p of check.problems) {
      if (p.startsWith('supplierGstin')) add('supplier_gstin');
      else if (p.startsWith('invoiceNumber')) add('invoice_number');
      else if (p.startsWith('invoiceDate')) add('invoice_date');
      else if (p.startsWith('hsnCode')) add('line_hsn', i);
      else if (p.startsWith('taxableMinor')) add('line_taxable_value', i);
      else if (p.startsWith('rateBps')) add('line_rate', i);
      else add('place_of_supply');
    }
    lines.push({
      description, hsnCode: hsn, quantityMinor: l.quantityMinor, uom: typeof l.uom === 'string' ? l.uom.trim() : '', unitPriceMinor: l.unitPriceMinor,
      rateBps, taxableMinor: split.taxableMinor, cgstMinor: cgst, sgstMinor: sgst, lineTotalMinor: l.lineTotalMinor, untaxed: rateBps === 0,
    });
  });
  // The checker sees the GSTIN, number and date on each line; with no line to check them on, they are checked here.
  if (lines.length === 0) {
    const check = checkTaxInvoiceFields({ documentType: title, supplierGstin: gstin, invoiceNumber: input.number, invoiceDate: date });
    if (check.problems.some((p) => p.startsWith('supplierGstin'))) add('supplier_gstin');
    if (check.problems.some((p) => p.startsWith('invoiceNumber'))) add('invoice_number');
    if (check.problems.some((p) => p.startsWith('invoiceDate'))) add('invoice_date');
  }

  const taxableMinor = lines.filter((l) => !l.untaxed).reduce((s, l) => s + l.taxableMinor, 0);
  const untaxedMinor = lines.filter((l) => l.untaxed).reduce((s, l) => s + l.taxableMinor, 0);
  const goodsMinor = lines.reduce((s, l) => s + l.lineTotalMinor, 0);
  // OB-279 · A10: each component of the bill rounded to the rupee; OB-285: the round off keeps the bill within the goods.
  const rounded = invoiceRoundOff(lines.map((l) => ({ lineTotalMinor: l.lineTotalMinor, taxRateBps: l.rateBps })));
  const cgstMinor = rounded.cgstMinor;
  const sgstMinor = rounded.sgstMinor;
  const roundOffMinor = rounded.roundOffMinor;
  const totalMinor = taxableMinor + untaxedMinor + cgstMinor + sgstMinor + roundOffMinor;
  // A9 · OB-279 · OB-285: the values and the tax reconcile — each line to what it was charged, to the paisa; the bill to
  // the goods plus the tax rounding plus the round off (each at most ₹1), never above the goods; and to what the till is
  // about to charge, when it says.
  if (lines.some((l) => l.taxableMinor + l.cgstMinor + l.sgstMinor !== l.lineTotalMinor)
    || lines.reduce((s, l) => s + l.cgstMinor, 0) !== rounded.cgstExactMinor || lines.reduce((s, l) => s + l.sgstMinor, 0) !== rounded.sgstExactMinor
    || goodsMinor + rounded.totalLessGoodsMinor !== totalMinor || totalMinor > goodsMinor
    || Math.abs(rounded.taxRoundingMinor) > MAX_ROUND_OFF_MINOR || roundOffMinor > 0 || roundOffMinor < -MAX_ROUND_OFF_MINOR
    || (input.totalMinor !== undefined && input.totalMinor !== totalMinor)) add('totals');
  // OB-280: ₹50,000 or more — the buyer's name and address would be needed; refused, old system only.
  if (totalMinor >= UNREGISTERED_RECIPIENT_DETAILS_FROM_MINOR) add('recipient_details');

  if (problems.length > 0 || state === undefined || when === undefined) {
    if (state === undefined && gstin === '') add('supplier_gstin');
    if (when === undefined) add('invoice_date');
    return { ok: false, problems, laneMessage: refusalWords(problems, input.lines.map((l) => (typeof l.description === 'string' ? l.description.trim() : ''))) };
  }

  const bandMap = new Map<number, { taxable: number; cgst: number; sgst: number }>();
  for (const l of lines.filter((x) => !x.untaxed)) {
    const b = bandMap.get(l.rateBps) ?? { taxable: 0, cgst: 0, sgst: 0 };
    bandMap.set(l.rateBps, { taxable: b.taxable + l.taxableMinor, cgst: b.cgst + l.cgstMinor, sgst: b.sgst + l.sgstMinor });
  }
  const bands = [...bandMap.entries()].sort((a, b) => a[0] - b[0]).map(([rateBps, b]) => ({ rateBps, taxableMinor: b.taxable, cgstMinor: b.cgst, sgstMinor: b.sgst }));

  return {
    ok: true,
    doc: Object.freeze({
      title,
      supplier: { legalName, placeOfBusiness: address, gstin, stateCode: state.code, stateName: state.name },
      number: input.number, date, time: when.time,
      placeOfSupply: { kind: 'intra_state' as const, stateCode: state.code, stateName: state.name },
      reverseCharge: false as const,
      lines, bands, taxableMinor, untaxedMinor, cgstExactMinor: rounded.cgstExactMinor, sgstExactMinor: rounded.sgstExactMinor,
      cgstMinor, sgstMinor, totalTaxMinor: cgstMinor + sgstMinor, goodsMinor, taxRoundingMinor: rounded.taxRoundingMinor, roundOffMinor, totalMinor,
      tenders: (input.tenders ?? []).map((t) => ({ kind: t.kind, amountMinor: t.amountMinor, ...(t.machineRef === undefined ? {} : { machineRef: t.machineRef }) })),
      ...(input.changeMinor === undefined || input.changeMinor <= 0 ? {} : { changeMinor: input.changeMinor }),
      laneId: input.laneId, cashierId: input.cashierId,
    }),
  };
}

// ── The printed invoice ─────────────────────────────────────────────────────────────────────────────────────────────

/** The fields a printed row carries — what the contract reads back. */
export type InvoiceField =
  | 'title' | 'duplicate' | 'supplier_legal_name' | 'supplier_address' | 'supplier_gstin' | 'invoice_number' | 'invoice_date'
  | 'place_of_supply' | 'reverse_charge' | 'line_description' | 'line_hsn' | 'line_rate' | 'line_quantity' | 'line_taxable_value'
  | 'line_amount' | 'band_taxable' | 'cgst' | 'sgst' | 'taxable_total' | 'untaxed_total' | 'cgst_total' | 'sgst_total' | 'round_off'
  | 'total' | 'tender' | 'change'
  | 'signatory' | 'till';

export interface InvoiceRow {
  readonly kind: 'title' | 'centre' | 'pair' | 'text' | 'rule';
  readonly fields: readonly InvoiceField[];
  /** The line (0-based) a line row belongs to; the band (0-based) a band row belongs to. */
  readonly line?: number;
  readonly band?: number;
  readonly text?: string;
  readonly left?: string;
  readonly right?: string;
}

export type InvoiceLanguage = 'en' | 'ta';

/** The printed words, in English and Tamil. The legal heading stays in English on a Tamil bill too, beside the Tamil. */
const LABELS: Readonly<Record<InvoiceLanguage, Readonly<Record<string, string>>>> = {
  en: {
    [TAX_INVOICE_TITLE]: TAX_INVOICE_TITLE, [INVOICE_CUM_BILL_OF_SUPPLY_TITLE]: INVOICE_CUM_BILL_OF_SUPPLY_TITLE, duplicate: 'DUPLICATE — reprint', gstin: 'GSTIN', invoiceNo: 'Invoice No', date: 'Date',
    placeOfSupply: 'Place of supply', reverseCharge: 'Tax payable on reverse charge: No', hsn: 'HSN', gst: 'GST',
    taxable: 'Taxable value', amountsIn: 'Amounts in ₹', taxSummary: 'GST summary', total: 'Total (incl. GST)',
    untaxedRate: 'Exempt / nil — no GST', untaxedValue: 'Value', untaxedTotal: 'Exempt / nil-rated value (no GST)',
    rounded: '(rounded to ₹)', roundOff: 'Round off',
    paid: 'Paid', change: 'Change', approval: 'approval', for: 'For', signatory: 'Authorised signatory', till: 'Till', cashier: 'Cashier',
    cash: 'Cash', card: 'Card', upi: 'UPI', loyalty_points: 'Points', store_credit: 'Store credit',
  },
  ta: {
    [TAX_INVOICE_TITLE]: `${TAX_INVOICE_TITLE} / வரி விலைப்பட்டியல்`,
    [INVOICE_CUM_BILL_OF_SUPPLY_TITLE]: `${INVOICE_CUM_BILL_OF_SUPPLY_TITLE} / விலைப்பட்டியல் மற்றும் வழங்கல் பில்`,
    duplicate: 'நகல் (DUPLICATE) — மறு அச்சு', gstin: 'GSTIN', invoiceNo: 'பில் எண்', date: 'தேதி',
    placeOfSupply: 'வழங்கல் இடம்', reverseCharge: 'தலைகீழ் கட்டண முறையில் வரி: இல்லை', hsn: 'HSN', gst: 'GST',
    taxable: 'வரி விதிக்கத்தக்க மதிப்பு', amountsIn: 'தொகைகள் ₹ இல்', taxSummary: 'GST சுருக்கம்', total: 'மொத்தம் (GST உட்பட)',
    untaxedRate: 'Exempt / nil (விலக்கு / பூஜ்யம்) — GST இல்லை', untaxedValue: 'மதிப்பு', untaxedTotal: 'விலக்கு / பூஜ்ய மதிப்பு (GST இல்லை)',
    rounded: '(₹ க்கு முழுமையாக்கப்பட்டது)', roundOff: 'முழுமையாக்கல் (Round off)',
    paid: 'செலுத்தியது', change: 'மீதி', approval: 'அனுமதி எண்', for: '', signatory: 'அங்கீகரிக்கப்பட்ட கையொப்பம்', till: 'டில்', cashier: 'காசாளர்',
    cash: 'பணம்', card: 'கார்டு', upi: 'UPI', loyalty_points: 'புள்ளிகள்', store_credit: 'கடை வரவு',
  },
};

/** A paisa amount as printed: 1234.50 (the "Amounts in ₹" row says the currency once). */
export function invoiceAmount(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** A rate in basis points as printed: 500 → "5%", 250 → "2.5%", 1800 → "18%". */
export function invoiceRate(bps: number): string {
  const s = (bps / 100).toFixed(2).replace(/\.?0+$/, '');
  return `${s}%`;
}

/** Quantity and unit as printed (Rule 46(h)): "2 Nos", "1.234 kg", "500 g". */
export function invoiceQuantity(quantityMinor: number, uom: string): string {
  const u = normaliseUom(uom);
  if (u === 'ea') return `${quantityMinor} Nos`;
  const label = quantityLabel(quantityMinor, uom);
  return u === undefined && !label.includes(' ') ? `${label} ${uom}` : label;
}

/** DD-MM-YYYY HH:MM — the date and time of issue as a shopper in Tamil Nadu reads it. */
function printedDate(doc: TaxInvoiceDocument): string {
  const [y, m, d] = doc.date.split('-');
  return `${d}-${m}-${y} ${doc.time}`;
}

/**
 * The invoice laid out for paper, row by row, each row naming the fields it carries. `duplicate`: a reprint, marked
 * DUPLICATE at the top (Rule 46 practice — a copy is never passed off as the original). `footer`: the shop's own
 * closing lines from its published receipt template, printed after the legal part.
 */
export function taxInvoiceRows(doc: TaxInvoiceDocument, options: { readonly language?: InvoiceLanguage; readonly duplicate?: boolean; readonly footer?: readonly string[] } = {}): readonly InvoiceRow[] {
  const w = LABELS[options.language ?? 'en'];
  const rows: InvoiceRow[] = [];
  const rule = (): void => { rows.push({ kind: 'rule', fields: [] }); };
  rows.push({ kind: 'title', fields: ['title'], text: w[doc.title] });
  if (options.duplicate === true) rows.push({ kind: 'title', fields: ['duplicate'], text: w['duplicate'] });
  rows.push({ kind: 'centre', fields: ['supplier_legal_name'], text: doc.supplier.legalName });
  for (const line of doc.supplier.placeOfBusiness) rows.push({ kind: 'centre', fields: ['supplier_address'], text: line });
  rows.push({ kind: 'centre', fields: ['supplier_gstin'], text: `${w['gstin']}: ${doc.supplier.gstin}` });
  rule();
  rows.push({ kind: 'pair', fields: ['invoice_number'], left: `${w['invoiceNo']}:`, right: doc.number });
  rows.push({ kind: 'pair', fields: ['invoice_date'], left: `${w['date']}:`, right: printedDate(doc) });
  rows.push({ kind: 'text', fields: ['place_of_supply'], text: `${w['placeOfSupply']}: ${doc.placeOfSupply.stateName} (${doc.placeOfSupply.stateCode})` });
  rows.push({ kind: 'text', fields: ['reverse_charge'], text: w['reverseCharge'] });
  rows.push({ kind: 'text', fields: [], text: w['amountsIn'] });
  rule();
  doc.lines.forEach((l, i) => {
    rows.push({ kind: 'text', fields: ['line_description'], line: i, text: l.description });
    rows.push(l.untaxed
      // OB-278: an untaxed line says so, and carries no tax.
      ? { kind: 'pair', fields: ['line_hsn', 'line_rate', 'line_taxable_value'], line: i, left: `  ${w['hsn']} ${l.hsnCode} · ${w['untaxedRate']}`, right: `${w['untaxedValue']} ${invoiceAmount(l.taxableMinor)}` }
      : { kind: 'pair', fields: ['line_hsn', 'line_rate', 'line_taxable_value'], line: i, left: `  ${w['hsn']} ${l.hsnCode} · ${w['gst']} ${invoiceRate(l.rateBps)}`, right: `${w['taxable']} ${invoiceAmount(l.taxableMinor)}` });
    rows.push({ kind: 'pair', fields: ['line_quantity', 'line_amount'], line: i, left: `  ${invoiceQuantity(l.quantityMinor, l.uom)} × ${invoiceAmount(l.unitPriceMinor)}`, right: invoiceAmount(l.lineTotalMinor) });
  });
  rule();
  rows.push({ kind: 'text', fields: [], text: w['taxSummary'] });
  doc.bands.forEach((b, i) => {
    const half = invoiceRate(b.rateBps / 2);
    rows.push({ kind: 'pair', fields: ['band_taxable'], band: i, left: `${w['taxable']} @ ${invoiceRate(b.rateBps)}`, right: invoiceAmount(b.taxableMinor) });
    rows.push({ kind: 'pair', fields: ['cgst'], band: i, left: `  CGST @ ${half}`, right: invoiceAmount(b.cgstMinor) });
    rows.push({ kind: 'pair', fields: ['sgst'], band: i, left: `  SGST @ ${half}`, right: invoiceAmount(b.sgstMinor) });
  });
  rule();
  rows.push({ kind: 'pair', fields: ['taxable_total'], left: w['taxable']!, right: invoiceAmount(doc.taxableMinor) });
  if (doc.untaxedMinor > 0) rows.push({ kind: 'pair', fields: ['untaxed_total'], left: w['untaxedTotal']!, right: invoiceAmount(doc.untaxedMinor) });
  // OB-279: the bill's CGST and SGST, each rounded to the rupee; OB-285: the round off that keeps the bill within the
  // goods' MRP total — stated, never hidden, and the rows above it add up to the total.
  rows.push({ kind: 'pair', fields: ['cgst_total'], left: `CGST ${w['rounded']}`, right: invoiceAmount(doc.cgstMinor) });
  rows.push({ kind: 'pair', fields: ['sgst_total'], left: `SGST ${w['rounded']}`, right: invoiceAmount(doc.sgstMinor) });
  if (doc.roundOffMinor !== 0) rows.push({ kind: 'pair', fields: ['round_off'], left: w['roundOff']!, right: invoiceAmount(doc.roundOffMinor) });
  rows.push({ kind: 'title', fields: ['total'], left: w['total']!, right: invoiceAmount(doc.totalMinor), text: `${w['total']} ${invoiceAmount(doc.totalMinor)}` });
  rule();
  for (const t of doc.tenders) {
    const kind = w[t.kind] ?? t.kind;
    rows.push({ kind: 'pair', fields: ['tender'], left: `${w['paid']}: ${kind}${t.machineRef === undefined ? '' : ` (${w['approval']} ${t.machineRef})`}`, right: invoiceAmount(t.amountMinor) });
  }
  if (doc.changeMinor !== undefined) rows.push({ kind: 'pair', fields: ['change'], left: w['change']!, right: invoiceAmount(doc.changeMinor) });
  rows.push({ kind: 'text', fields: ['till'], text: `${w['till']} ${doc.laneId} · ${w['cashier']} ${doc.cashierId}` });
  rule();
  rows.push({ kind: 'centre', fields: ['signatory'], text: `${w['for'] === '' ? '' : `${w['for']} `}${doc.supplier.legalName}` });
  rows.push({ kind: 'centre', fields: ['signatory'], text: w['signatory'] });
  for (const line of options.footer ?? []) if (line.trim() !== '') rows.push({ kind: 'centre', fields: [], text: line.trim() });
  return rows;
}

/** A row's printed words, whatever its kind. */
export function rowText(row: InvoiceRow): string {
  if (row.kind === 'rule') return '';
  if (row.kind === 'pair') return `${row.left ?? ''} ${row.right ?? ''}`.trim();
  return row.text ?? `${row.left ?? ''} ${row.right ?? ''}`.trim();
}

/**
 * THE CONTRACT (A1 · OB-278 · OB-279): read a rendered invoice back and name every mandatory field it does not SHOW — the heading (the one the items call for), the
 * supplier's legal name, address and GSTIN, the number and date, the place of supply, the reverse-charge statement, and
 * for every line its description, HSN, quantity with unit, taxable value and rate; the CGST and SGST of every rate; the
 * total; the signatory. Empty only when every field is on the paper with the value the invoice holds.
 */
export function invoiceRenderProblems(rows: readonly InvoiceRow[], doc: TaxInvoiceDocument): readonly string[] {
  const problems: string[] = [];
  const shows = (field: InvoiceField, value: string, where: { line?: number; band?: number } = {}): boolean => rows.some((r) => r.fields.includes(field)
    && (where.line === undefined || r.line === where.line) && (where.band === undefined || r.band === where.band) && rowText(r).includes(value));
  const need = (field: InvoiceField, value: string, name: string, where: { line?: number; band?: number } = {}): void => {
    if (value === '' || !shows(field, value, where)) problems.push(name);
  };
  need('title', doc.title, `the "${doc.title}" heading`);
  // OB-278: the heading is the one the basket calls for — never a plain "Tax Invoice" over an untaxed line.
  if (doc.title !== (doc.lines.some((l) => l.untaxed) ? INVOICE_CUM_BILL_OF_SUPPLY_TITLE : TAX_INVOICE_TITLE)) problems.push('the heading the bill\'s items call for');
  need('supplier_legal_name', doc.supplier.legalName, 'the supplier\'s legal name');
  if (doc.supplier.placeOfBusiness.length === 0) problems.push('the supplier\'s address');
  for (const line of doc.supplier.placeOfBusiness) need('supplier_address', line, 'the supplier\'s address');
  need('supplier_gstin', doc.supplier.gstin, 'the supplier\'s GSTIN');
  need('invoice_number', doc.number, 'the invoice number');
  need('invoice_date', printedDate(doc), 'the invoice date');
  need('place_of_supply', `${doc.placeOfSupply.stateName} (${doc.placeOfSupply.stateCode})`, 'the place of supply (the State and its code)');
  need('reverse_charge', ':', 'whether tax is payable on reverse charge');
  if (doc.lines.length === 0) problems.push('the lines');
  doc.lines.forEach((l, i) => {
    const n = `line ${i + 1}`;
    need('line_description', l.description, `${n}: the description`, { line: i });
    need('line_hsn', l.hsnCode, `${n}: the HSN code`, { line: i });
    need('line_quantity', invoiceQuantity(l.quantityMinor, l.uom), `${n}: the quantity and unit`, { line: i });
    need('line_taxable_value', invoiceAmount(l.taxableMinor), `${n}: the taxable value`, { line: i });
    if (l.untaxed) need('line_rate', 'Exempt / nil', `${n}: that it is exempt / nil-rated`, { line: i });
    else need('line_rate', invoiceRate(l.rateBps), `${n}: the tax rate`, { line: i });
  });
  doc.bands.forEach((b, i) => {
    const n = `GST ${invoiceRate(b.rateBps)}`;
    need('cgst', invoiceAmount(b.cgstMinor), `${n}: the CGST`, { band: i });
    need('cgst', `CGST @ ${invoiceRate(b.rateBps / 2)}`, `${n}: the CGST rate`, { band: i });
    need('sgst', invoiceAmount(b.sgstMinor), `${n}: the SGST`, { band: i });
    need('sgst', `SGST @ ${invoiceRate(b.rateBps / 2)}`, `${n}: the SGST rate`, { band: i });
  });
  if (doc.untaxedMinor > 0) need('untaxed_total', invoiceAmount(doc.untaxedMinor), 'the exempt / nil-rated value');
  need('cgst_total', invoiceAmount(doc.cgstMinor), 'the CGST, rounded to the rupee');
  need('sgst_total', invoiceAmount(doc.sgstMinor), 'the SGST, rounded to the rupee');
  if (doc.roundOffMinor !== 0) need('round_off', invoiceAmount(doc.roundOffMinor), 'the round off');
  need('total', invoiceAmount(doc.totalMinor), 'the total');
  // OB-279 · OB-285: what the paper says adds up — the values, the rounded tax and the round off are the total — and the
  // total is never above what the lines were charged (the goods' MRP total).
  if (doc.taxableMinor + doc.untaxedMinor + doc.cgstMinor + doc.sgstMinor + doc.roundOffMinor !== doc.totalMinor || doc.totalMinor > doc.goodsMinor
    || doc.goodsMinor + doc.taxRoundingMinor + doc.roundOffMinor !== doc.totalMinor) problems.push('a total that adds up');
  need('signatory', doc.supplier.legalName, 'the supplier\'s signatory line');
  return problems;
}

/** The invoice as fixed-width text lines (the on-screen copy of the paper): `width` columns, 48 for 80 mm, 32 for 58 mm. */
export function taxInvoiceText(rows: readonly InvoiceRow[], width = 48): readonly string[] {
  const out: string[] = [];
  const centre = (s: string): string => (s.length >= width ? s : `${' '.repeat(Math.floor((width - s.length) / 2))}${s}`);
  const wrap = (s: string): string[] => { const parts: string[] = []; let rest = s; while (rest.length > width) { parts.push(rest.slice(0, width)); rest = rest.slice(width); } parts.push(rest); return parts; };
  for (const r of rows) {
    if (r.kind === 'rule') { out.push('-'.repeat(width)); continue; }
    if (r.kind === 'pair' || (r.kind === 'title' && r.left !== undefined)) {
      const left = r.left ?? ''; const right = r.right ?? '';
      const gap = width - left.length - right.length;
      if (gap >= 1) out.push(`${left}${' '.repeat(gap)}${right}`);
      else { out.push(...wrap(left)); out.push(`${' '.repeat(Math.max(0, width - right.length))}${right}`); }
      continue;
    }
    const text = r.text ?? '';
    if (r.kind === 'title' || r.kind === 'centre') for (const p of wrap(text)) out.push(centre(p));
    else out.push(...wrap(text));
  }
  return out;
}
