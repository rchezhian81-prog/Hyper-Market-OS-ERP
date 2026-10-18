// GSTR-9 (annual return) and GSTR-9C (self-certified reconciliation statement) (R3 · A18 · CGST Act s.44, Rule 80).
//
// Signed acceptance (OB-188): "for a financial year, GSTR-9 tables are folded from the twelve filed GSTR-1/3B periods
// and the books. GSTR-9C reconciles books turnover and tax to GSTR-9 and lists every difference with a reason. The
// 31 Dec due date shows on the filing calendar (A19)."
//
// The shop's turnover band is ₹5–10 crore (D2), so BOTH apply: GSTR-9 (above ₹2 crore) and the self-certified GSTR-9C
// (above ₹5 crore). Both are due 31 December after the year ends (`filing-calendar.ts`).
//
//   • GSTR-9 is FOLDED, never typed: Table 4 is the sum of the twelve months' outward figures as they were LOCKED to
//     each filed GSTR-1 (A16) — the till part and the outward documents, not the amendments carried in from a month
//     outside the year; 4G is the reverse-charge liability (A14); Table 5 the nil-rated/exempt value; Table 6 the ITC
//     (reverse charge paid, and the A17 port's figure — "not yet reconciled" for any month makes the year's figure not
//     known, never zero); Tables 10/11 the amendments of this year's months declared later. A month whose GSTR-1 is not
//     filed and locked, or whose GSTR-3B is not recorded filed, is listed and the return says it is INCOMPLETE.
//   • GSTR-9C puts the BOOKS (the day book's posted sale and return vouchers — what the accounts hold) beside GSTR-9, month
//     by month, and names every difference: outward documents the day book does not carry, anything banked after GSTR-1
//     was filed that no amendment has carried, a month not filed, and books that differ from the till (with the days not
//     yet posted to the day book). A difference with no cause the system can name stays OPEN until a named person records
//     its reason (append-only). Nothing is netted away.
//
// Pure and deterministic.

import { parseFinancialYear } from './gst-period';
import {
  ZERO_HEADS, ZERO_OUTWARD, addHeads, addOutward, subOutward, isZeroOutward, taxOf,
  type TaxHeads, type OutwardTotals, type Gstr3bLock, type Gstr1Figures, type CarriedAmendment,
} from './gstr3b';
import type { ItcForPeriod } from './itc-port';

/** One month as GSTR-9/9C read it. */
export interface AnnualMonthInput {
  readonly period: string;
  /** The A16 lock (GSTR-1 filed). Absent: GSTR-1 not filed and locked. */
  readonly lock?: Gstr3bLock;
  /** GSTR-3B recorded filed for the month. */
  readonly gstr3bFiled: boolean;
  /** What is stored for the month now (for the "changed after filing" check). */
  readonly current: Gstr1Figures;
  /** Amendments OF this month (declared in the next). */
  readonly amendmentsOut: readonly CarriedAmendment[];
  readonly reverseCharge: { readonly liability: TaxHeads; readonly itcPaid: TaxHeads };
  readonly itc: ItcForPeriod;
  /** The day book's posted sale − return vouchers for the month (null when the books hold nothing for it). */
  readonly books: { readonly turnoverMinor: number; readonly taxMinor: number } | null;
  /** Trading days in the month with banked sales or returns but no posted day-book voucher. */
  readonly daysNotInBooks: readonly string[];
}

export type MissingReason = 'gstr1_not_filed_and_locked' | 'gstr3b_not_recorded_filed';

export interface Gstr9 {
  readonly fy: string;
  readonly complete: boolean;
  readonly missing: readonly { readonly period: string; readonly reason: MissingReason }[];
  /** Table 4 (and 5): outward supplies of the year's months as filed — till + outward documents. */
  readonly table4Outward: OutwardTotals;
  /** Table 4G: inward supplies on which tax is paid on reverse charge. */
  readonly table4gReverseCharge: TaxHeads;
  /** Table 5: nil-rated / exempt (taxable value) — inside `table4Outward.nilMinor`, said on its own. */
  readonly table5NilMinor: number;
  readonly table6Itc: {
    readonly reverseCharge: TaxHeads;
    readonly allOther:
      | { readonly status: 'reconciled'; readonly igstMinor: number; readonly cgstMinor: number; readonly sgstMinor: number; readonly cessMinor: number }
      | { readonly status: 'not_known'; readonly monthsNotReconciled: readonly string[]; readonly detail: string };
  };
  /** Tables 10/11: amendments of this year's months declared later (signed, net). */
  readonly table10And11Amendments: OutwardTotals;
  /** Turnover declared for the year: Table 4 outward + amendments. */
  readonly declared: OutwardTotals;
  readonly perMonth: readonly { readonly period: string; readonly outward: OutwardTotals | null; readonly reverseCharge: TaxHeads; readonly gstr3bFiled: boolean }[];
  readonly detail: string;
}

const declaredFor = (lock: Gstr3bLock): OutwardTotals => addOutward(lock.figures.fromTill, lock.figures.documents);
const sumAmendments = (as: readonly CarriedAmendment[]): OutwardTotals => as.reduce((acc, a) => addOutward(acc, a.delta), ZERO_OUTWARD);
const rupees = (m: number): string => `₹${(m / 100).toFixed(2)}`;

/**
 * Fold GSTR-9 for a financial year from its twelve months.
 *
 * @throws InvalidGstPeriod if `fy` is not YYYY-YY, or a month given is not one of the year's twelve.
 */
export function foldGstr9(input: { readonly fy: string; readonly months: readonly AnnualMonthInput[] }): Gstr9 {
  const fy = parseFinancialYear(input.fy);
  const byPeriod = new Map(input.months.map((m) => [m.period, m] as const));
  for (const m of input.months) if (!fy.periods.includes(m.period)) throw new Error(`${m.period} is not a month of ${fy.fy}`);
  const missing: { period: string; reason: MissingReason }[] = [];
  let outward = ZERO_OUTWARD;
  let rc = ZERO_HEADS;
  let rcItc = ZERO_HEADS;
  let amendments = ZERO_OUTWARD;
  let itc = { igstMinor: 0, cgstMinor: 0, sgstMinor: 0, cessMinor: 0 };
  const notReconciled: string[] = [];
  const perMonth: Gstr9['perMonth'][number][] = [];
  for (const period of fy.periods) {
    const m = byPeriod.get(period);
    if (m?.lock === undefined) missing.push({ period, reason: 'gstr1_not_filed_and_locked' });
    if (m === undefined || !m.gstr3bFiled) missing.push({ period, reason: 'gstr3b_not_recorded_filed' });
    if (m === undefined) { notReconciled.push(period); perMonth.push({ period, outward: null, reverseCharge: ZERO_HEADS, gstr3bFiled: false }); continue; }
    if (m.lock !== undefined) outward = addOutward(outward, declaredFor(m.lock));
    rc = addHeads(rc, m.reverseCharge.liability);
    rcItc = addHeads(rcItc, m.reverseCharge.itcPaid);
    amendments = addOutward(amendments, sumAmendments(m.amendmentsOut));
    if (m.itc.status === 'reconciled') itc = { igstMinor: itc.igstMinor + m.itc.igstMinor, cgstMinor: itc.cgstMinor + m.itc.cgstMinor, sgstMinor: itc.sgstMinor + m.itc.sgstMinor, cessMinor: itc.cessMinor + m.itc.cessMinor };
    else notReconciled.push(period);
    perMonth.push({ period, outward: m.lock !== undefined ? declaredFor(m.lock) : null, reverseCharge: m.reverseCharge.liability, gstr3bFiled: m.gstr3bFiled });
  }
  const declared = addOutward(outward, amendments);
  const complete = missing.length === 0;
  return {
    fy: fy.fy, complete, missing,
    table4Outward: outward, table4gReverseCharge: rc, table5NilMinor: outward.nilMinor,
    table6Itc: {
      reverseCharge: rcItc,
      allOther: notReconciled.length === 0 ? { status: 'reconciled', ...itc }
        : { status: 'not_known', monthsNotReconciled: notReconciled, detail: `input credit is not yet reconciled for ${notReconciled.length} month(s) (${notReconciled.join(', ')}) — the year's ITC is not known, not zero` },
    },
    table10And11Amendments: amendments,
    declared,
    perMonth,
    detail: `${fy.fy}: ${complete ? 'complete' : `INCOMPLETE — ${missing.length} missing filing(s)`}; outward taxable ${rupees(declared.heads.taxableMinor)}, tax ${rupees(taxOf(declared.heads))}, nil ${rupees(declared.nilMinor)}`,
  };
}

// ── GSTR-9C ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type Gstr9cDifferenceCode =
  | 'month_not_filed'                       // GSTR-1 not filed and locked — the return side is not known
  | 'outward_documents_not_in_books'        // the return carries outward documents the day book does not
  | 'changed_after_gstr1_filed_not_amended' // banked after GSTR-1 was filed, no amendment carried it
  | 'books_differ_from_till';               // the day book and the till disagree (a day not posted, a posting exception)

/** A person's recorded reason for a difference (append-only; the latest stands). */
export interface Gstr9cReason {
  readonly period: string;
  readonly code: Gstr9cDifferenceCode;
  readonly reason: string;
  readonly by: string;
  readonly at: string;
}

export interface Gstr9cDifference {
  readonly period: string;
  readonly code: Gstr9cDifferenceCode;
  /** Books minus GSTR-9 for this cause (turnover = taxable + nil; tax = CGST + SGST + IGST), paise. */
  readonly turnoverMinor: number;
  readonly taxMinor: number;
  /** The reason: the system's where it can name the cause, else the person's — absent means OPEN. */
  readonly reason?: string;
  readonly reasonBy?: string;
  /** False until it carries a reason a person accepts (system-named causes that need action stay open too). */
  readonly explained: boolean;
}

export interface Gstr9c {
  readonly fy: string;
  readonly books: { readonly turnoverMinor: number; readonly taxMinor: number; readonly monthsWithNoBooks: readonly string[] };
  readonly gstr9: { readonly turnoverMinor: number; readonly taxMinor: number };
  /** books − GSTR-9. */
  readonly unreconciled: { readonly turnoverMinor: number; readonly taxMinor: number };
  readonly differences: readonly Gstr9cDifference[];
  readonly open: number;
  readonly detail: string;
}

const turnoverOf = (o: OutwardTotals): number => o.heads.taxableMinor + o.nilMinor;

/**
 * Reconcile the books to GSTR-9 month by month and name every difference. `reasons` are the people's recorded
 * reasons (the latest per month × cause stands).
 */
export function reconcileGstr9c(input: {
  readonly fy: string;
  readonly months: readonly AnnualMonthInput[];
  readonly gstr9: Gstr9;
  readonly reasons: readonly Gstr9cReason[];
}): Gstr9c {
  const fy = parseFinancialYear(input.fy);
  const latestReason = new Map<string, Gstr9cReason>();
  for (const r of input.reasons) latestReason.set(`${r.period}|${r.code}`, r);
  const differences: Gstr9cDifference[] = [];
  const add = (period: string, code: Gstr9cDifferenceCode, turnoverMinor: number, taxMinor: number, systemReason: string | undefined, needsAction: boolean): void => {
    if (turnoverMinor === 0 && taxMinor === 0) return;
    const person = latestReason.get(`${period}|${code}`);
    const reason = person?.reason ?? systemReason;
    differences.push({
      period, code, turnoverMinor, taxMinor,
      ...(reason !== undefined ? { reason } : {}),
      ...(person !== undefined ? { reasonBy: person.by } : {}),
      explained: person !== undefined || (systemReason !== undefined && !needsAction),
    });
  };
  let booksTurnover = 0;
  let booksTax = 0;
  const noBooks: string[] = [];
  const byPeriod = new Map(input.months.map((m) => [m.period, m] as const));
  for (const period of fy.periods) {
    const m = byPeriod.get(period);
    const books = m?.books ?? null;
    if (books === null) noBooks.push(period);
    const bT = books?.turnoverMinor ?? 0;
    const bX = books?.taxMinor ?? 0;
    booksTurnover += bT;
    booksTax += bX;
    if (m === undefined || m.lock === undefined) {
      add(period, 'month_not_filed', bT, bX, undefined, true);
      continue;
    }
    const lock = m.lock;
    const carried = sumAmendments(m.amendmentsOut);
    // Books − (filed till + filed documents + amendments of the month), split into named causes.
    if (!isZeroOutward(lock.figures.documents)) {
      add(period, 'outward_documents_not_in_books', -turnoverOf(lock.figures.documents), -taxOf(lock.figures.documents.heads), 'GSTR-1 carries outward-supply documents (e.g. B2B invoices) that the day book does not post', false);
    }
    const lateTill = subOutward(subOutward(m.current.fromTill, lock.figures.fromTill), carried);
    add(period, 'changed_after_gstr1_filed_not_amended', turnoverOf(lateTill), taxOf(lateTill.heads), `banked after GSTR-1 was filed (${lock.arn}) and not yet carried by an amendment`, true);
    const booksVsTill = { t: bT - turnoverOf(m.current.fromTill), x: bX - taxOf(m.current.fromTill.heads) };
    add(period, 'books_differ_from_till', booksVsTill.t, booksVsTill.x,
      m.daysNotInBooks.length > 0 ? `the day book has not been posted for ${m.daysNotInBooks.join(', ')}` : undefined, true);
  }
  const declaredTurnover = turnoverOf(input.gstr9.declared);
  const declaredTax = taxOf(input.gstr9.declared.heads);
  const open = differences.filter((d) => !d.explained).length;
  return {
    fy: fy.fy,
    books: { turnoverMinor: booksTurnover, taxMinor: booksTax, monthsWithNoBooks: noBooks },
    gstr9: { turnoverMinor: declaredTurnover, taxMinor: declaredTax },
    unreconciled: { turnoverMinor: booksTurnover - declaredTurnover, taxMinor: booksTax - declaredTax },
    differences,
    open,
    detail: `${fy.fy}: books turnover ${rupees(booksTurnover)} vs GSTR-9 ${rupees(declaredTurnover)}; ${differences.length} difference(s), ${open} without an accepted reason`,
  };
}
