// GST return periods (R3 · A15/A16/A18/A19). The shop's turnover band is ₹5–10 crore (owner decision D2,
// OWNER_DECISIONS_2026-08-11), so the quarterly QRMP scheme (≤ ₹5 crore) is NOT open to it: every GSTR-1 and
// GSTR-3B period is ONE CALENDAR MONTH, named the way the GST portal names it — `MMYYYY` (e.g. `052027`). A
// quarterly or free-form period is refused by name, never silently read as a month.
//
// The annual returns (GSTR-9 / GSTR-9C) are per FINANCIAL YEAR, 1 April – 31 March, named `YYYY-YY` (`2026-27`).
// Pure and deterministic — no clock.

export class InvalidGstPeriod extends Error {
  constructor(detail: string) {
    super(`Invalid GST period: ${detail}`);
    this.name = 'InvalidGstPeriod';
  }
}

/** One monthly return period. */
export interface MonthlyPeriod {
  /** The portal's form: MMYYYY. */
  readonly fp: string;
  readonly year: number;
  /** 1–12. */
  readonly month: number;
  /** First day, YYYY-MM-DD. */
  readonly from: string;
  /** Last day, YYYY-MM-DD. */
  readonly to: string;
  /** A sortable key, YYYYMM. */
  readonly sortKey: string;
}

const FP = /^(0[1-9]|1[0-2])(\d{4})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const pad2 = (n: number): string => String(n).padStart(2, '0');
const lastDayOf = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * Read a monthly return period. Only `MMYYYY` is accepted: the shop files monthly (D2: ₹5–10 crore, so no QRMP),
 * and a quarter (`Q1-2027`, `042027-062027`) or any other form is refused.
 *
 * @throws InvalidGstPeriod for anything that is not one calendar month in MMYYYY form.
 */
export function parseMonthlyPeriod(fp: string): MonthlyPeriod {
  const m = FP.exec(typeof fp === 'string' ? fp : '');
  if (m === null) {
    throw new InvalidGstPeriod(`"${String(fp)}" is not a month in MMYYYY form — this shop files monthly (turnover ₹5–10 crore, so the quarterly scheme does not apply)`);
  }
  const month = Number(m[1]);
  const year = Number(m[2]);
  if (year < 2017) throw new InvalidGstPeriod(`"${fp}" is before GST began (July 2017)`);
  return {
    fp, year, month,
    from: `${year}-${pad2(month)}-01`,
    to: `${year}-${pad2(month)}-${pad2(lastDayOf(year, month))}`,
    sortKey: `${year}${pad2(month)}`,
  };
}

/** Is this a valid monthly period? Never throws. */
export function isMonthlyPeriod(fp: unknown): fp is string {
  try { parseMonthlyPeriod(fp as string); return true; } catch { return false; }
}

/** The period a date (YYYY-MM-DD) falls in. */
export function periodOfDate(dateISO: string): string {
  if (!DATE.test(dateISO)) throw new InvalidGstPeriod(`"${dateISO}" is not a YYYY-MM-DD date`);
  return `${dateISO.slice(5, 7)}${dateISO.slice(0, 4)}`;
}

/** The month after `fp`. */
export function nextMonthlyPeriod(fp: string): string {
  const p = parseMonthlyPeriod(fp);
  return p.month === 12 ? `01${p.year + 1}` : `${pad2(p.month + 1)}${p.year}`;
}

/** Compare two periods chronologically (negative when a is earlier). */
export function comparePeriods(a: string, b: string): number {
  return parseMonthlyPeriod(a).sortKey.localeCompare(parseMonthlyPeriod(b).sortKey);
}

/** Every month from `first` to `last` inclusive, oldest first. Empty when last is before first. */
export function periodsBetween(first: string, last: string): readonly string[] {
  const out: string[] = [];
  if (comparePeriods(first, last) > 0) return out;
  let p = first;
  for (;;) {
    out.push(p);
    if (p === last) return out;
    p = nextMonthlyPeriod(p);
  }
}

/** A financial year, 1 April – 31 March. */
export interface FinancialYearPeriods {
  /** `2026-27`. */
  readonly fy: string;
  readonly startYear: number;
  readonly from: string;
  readonly to: string;
  /** The twelve monthly periods, April first. */
  readonly periods: readonly string[];
}

const FY = /^(\d{4})-(\d{2})$/;

/**
 * Read a financial-year label `YYYY-YY` (the second part must be the following year).
 *
 * @throws InvalidGstPeriod for anything else.
 */
export function parseFinancialYear(fy: string): FinancialYearPeriods {
  const m = FY.exec(typeof fy === 'string' ? fy : '');
  if (m === null) throw new InvalidGstPeriod(`"${String(fy)}" is not a financial year in YYYY-YY form (e.g. 2026-27)`);
  const startYear = Number(m[1]);
  if (Number(m[2]) !== (startYear + 1) % 100) throw new InvalidGstPeriod(`"${fy}" — the second year must follow the first (e.g. ${startYear}-${pad2((startYear + 1) % 100)})`);
  if (startYear < 2017) throw new InvalidGstPeriod(`"${fy}" is before GST began`);
  return {
    fy, startYear,
    from: `${startYear}-04-01`,
    to: `${startYear + 1}-03-31`,
    periods: periodsBetween(`04${startYear}`, `03${startYear + 1}`),
  };
}

/** The financial year a monthly period belongs to (`052027` → `2027-28`; `022027` → `2026-27`). */
export function financialYearOfPeriod(fp: string): string {
  const p = parseMonthlyPeriod(fp);
  const start = p.month >= 4 ? p.year : p.year - 1;
  return `${start}-${pad2((start + 1) % 100)}`;
}
