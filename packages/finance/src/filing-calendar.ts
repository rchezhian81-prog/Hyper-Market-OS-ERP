// The GST filing calendar and the three-year time bar (R3 · A19 · A18's due date).
//
// Signed acceptance (OB-188): "a filing calendar lists every GSTR-1/3B/9/9C period with its due date and status. A
// return not filed shows an escalating warning, and one within N days of the 3-year bar is raised to the owner as an
// exception (P-03, P-08)." A18 adds: "The 31 Dec due date shows on the filing calendar."
//
// The law the dates come from:
//   • GSTR-1, monthly filer (turnover above ₹5 crore, D2): due the 11th of the following month (CGST s.37, Rule 59).
//   • GSTR-3B, monthly filer: due the 20th of the following month (s.39, Rule 61).
//   • GSTR-9 and GSTR-9C: due 31 December after the financial year ends (s.44, Rule 80).
//   • The time bar (Finance Act 2023, s.37(5), s.39(11), s.44(2)): a return can NOT be filed after three years from its
//     due date — the bar date is the due date three years on. After it the return is permanently barred.
//
// The warning escalates with time, using only those legal dates and the owner's N:
//   not due yet → OVERDUE (past the due date) → NEAR THE BAR (within N days of the bar — an owner exception) → BARRED.
// N is the OWNER's number. It is not in the signed sentence, so this code holds no default: until the owner sets it,
// the near-bar step cannot be judged and the calendar says so as its own exception (P-08), rather than guess.
//
// Pure: `today` is supplied (the shop's own date), there is no clock.

import { parseMonthlyPeriod, parseFinancialYear } from './gst-period';
import { told, type AlertText } from '../../ops/src/alert-words';

export type GstReturnType = 'GSTR1' | 'GSTR3B' | 'GSTR9' | 'GSTR9C';
export const GST_RETURN_TYPES: readonly GstReturnType[] = ['GSTR1', 'GSTR3B', 'GSTR9', 'GSTR9C'];
export const MONTHLY_RETURN_TYPES: readonly GstReturnType[] = ['GSTR1', 'GSTR3B'];
export const ANNUAL_RETURN_TYPES: readonly GstReturnType[] = ['GSTR9', 'GSTR9C'];

/** Years after the due date at which a return is barred. */
export const TIME_BAR_YEARS = 3;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * The due date of a return. Monthly returns take an MMYYYY `period`; annual returns a financial year `YYYY-YY`.
 *
 * @throws InvalidGstPeriod when the period does not fit the return type.
 */
export function dueDateOf(type: GstReturnType, period: string): string {
  if (type === 'GSTR9' || type === 'GSTR9C') {
    const fy = parseFinancialYear(period);
    return `${fy.startYear + 1}-12-31`;
  }
  const p = parseMonthlyPeriod(period);
  const y = p.month === 12 ? p.year + 1 : p.year;
  const m = p.month === 12 ? 1 : p.month + 1;
  return `${y}-${pad2(m)}-${type === 'GSTR1' ? '11' : '20'}`;
}

/** The date after which a return can never be filed: its due date, three years on. */
export function timeBarDateOf(dueDate: string): string {
  return `${Number(dueDate.slice(0, 4)) + TIME_BAR_YEARS}${dueDate.slice(4)}`;
}

/** Whole days from `a` to `b` (YYYY-MM-DD), negative when b is earlier. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`)) / 86_400_000);
}

/** The escalating warning, mildest first. */
export type FilingWarning = 'filed' | 'period_not_ended' | 'not_due_yet' | 'overdue' | 'near_time_bar' | 'time_barred';
export const FILING_WARNING_ORDER: readonly FilingWarning[] = ['filed', 'period_not_ended', 'not_due_yet', 'overdue', 'near_time_bar', 'time_barred'];

export interface FilingFact {
  readonly type: GstReturnType;
  readonly period: string;
  /** Present when the return is filed. */
  readonly filedOn?: string;
  readonly arn?: string;
  /** Where the filed fact came from (the GSTR-1 submission store, or a recorded filing). */
  readonly source?: string;
}

export interface CalendarEntry {
  readonly type: GstReturnType;
  readonly period: string;
  readonly periodEnds: string;
  readonly dueDate: string;
  readonly timeBarDate: string;
  readonly warning: FilingWarning;
  /** Days past the due date (positive) — only for an unfiled return past its due date. */
  readonly daysOverdue?: number;
  /** Days left before the bar — only for an unfiled return not yet barred. */
  readonly daysToTimeBar?: number;
  readonly filedOn?: string;
  readonly arn?: string;
  /** True when this entry must reach the owner as an exception (near the bar, or barred). */
  readonly ownerException: boolean;
  readonly detail: string;
  /** OB-435: for an owner exception, `detail` structured (rendered in English into `detail`, and in Tamil). */
  readonly text?: AlertText;
}

export interface FilingCalendar {
  readonly today: string;
  readonly entries: readonly CalendarEntry[];
  /** The owner's N, or null when not set — and then `nearBarNotJudged` says so. */
  readonly nearBarDays: number | null;
  readonly nearBarNotJudged: boolean;
  readonly ownerExceptions: readonly CalendarEntry[];
  readonly counts: Readonly<Record<FilingWarning, number>>;
  readonly detail: string;
}

/** The month a monthly period's last day, or the financial year's 31 March. */
function periodEnd(type: GstReturnType, period: string): string {
  return type === 'GSTR9' || type === 'GSTR9C' ? parseFinancialYear(period).to : parseMonthlyPeriod(period).to;
}

/** Judge one return on `today`. Pure. */
export function judgeFiling(input: {
  readonly type: GstReturnType;
  readonly period: string;
  readonly today: string;
  readonly fact?: FilingFact;
  readonly nearBarDays: number | null;
}): CalendarEntry {
  const dueDate = dueDateOf(input.type, input.period);
  const timeBarDate = timeBarDateOf(dueDate);
  const periodEnds = periodEnd(input.type, input.period);
  const base = { type: input.type, period: input.period, periodEnds, dueDate, timeBarDate };
  if (input.fact?.filedOn !== undefined) {
    return {
      ...base, warning: 'filed', filedOn: input.fact.filedOn, ...(input.fact.arn !== undefined ? { arn: input.fact.arn } : {}),
      ownerException: false, detail: `${input.type} ${input.period} filed on ${input.fact.filedOn}${input.fact.arn !== undefined ? ` (${input.fact.arn})` : ''}`,
    };
  }
  const daysToTimeBar = daysBetween(input.today, timeBarDate);
  if (input.today > timeBarDate) {
    return { ...base, warning: 'time_barred', daysOverdue: daysBetween(dueDate, input.today), ownerException: true, ...told('gst.timeBarred', { type: input.type, period: input.period, bar: timeBarDate }) };
  }
  if (input.today <= periodEnds) {
    return { ...base, warning: 'period_not_ended', daysToTimeBar, ownerException: false, detail: `${input.type} ${input.period}: the period has not ended; due ${dueDate}` };
  }
  if (input.today <= dueDate) {
    return { ...base, warning: 'not_due_yet', daysToTimeBar, ownerException: false, detail: `${input.type} ${input.period} is due on ${dueDate}` };
  }
  const daysOverdue = daysBetween(dueDate, input.today);
  if (input.nearBarDays !== null && daysToTimeBar <= input.nearBarDays) {
    return { ...base, warning: 'near_time_bar', daysOverdue, daysToTimeBar, ownerException: true, ...told('gst.nearBar', { type: input.type, period: input.period, bar: timeBarDate, days: daysToTimeBar }) };
  }
  return { ...base, warning: 'overdue', daysOverdue, daysToTimeBar, ownerException: false, detail: `${input.type} ${input.period} is ${daysOverdue} day(s) overdue (due ${dueDate}); it is barred for ever on ${timeBarDate}` };
}

/** Is `n` an acceptable owner's N (whole days, 1 to 3 years)? */
export function isValidNearBarDays(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 365 * TIME_BAR_YEARS;
}

/**
 * The whole calendar: every monthly period in `monthlyPeriods` (GSTR-1 and GSTR-3B each) and every financial year in
 * `financialYears` (GSTR-9 and GSTR-9C each), judged on `today`. The most urgent first.
 */
export function buildFilingCalendar(input: {
  readonly today: string;
  readonly monthlyPeriods: readonly string[];
  readonly financialYears: readonly string[];
  readonly facts: readonly FilingFact[];
  readonly nearBarDays: number | null;
}): FilingCalendar {
  const factOf = new Map<string, FilingFact>();
  for (const f of input.facts) if (f.filedOn !== undefined && !factOf.has(`${f.type}|${f.period}`)) factOf.set(`${f.type}|${f.period}`, f);
  const entries: CalendarEntry[] = [];
  const judge = (type: GstReturnType, period: string): void => {
    const fact = factOf.get(`${type}|${period}`);
    entries.push(judgeFiling({ type, period, today: input.today, nearBarDays: input.nearBarDays, ...(fact !== undefined ? { fact } : {}) }));
  };
  for (const p of input.monthlyPeriods) for (const t of MONTHLY_RETURN_TYPES) judge(t, p);
  for (const fy of input.financialYears) for (const t of ANNUAL_RETURN_TYPES) judge(t, fy);
  const rank = (w: FilingWarning): number => FILING_WARNING_ORDER.length - FILING_WARNING_ORDER.indexOf(w);
  entries.sort((a, b) => rank(a.warning) - rank(b.warning) || a.dueDate.localeCompare(b.dueDate) || a.type.localeCompare(b.type));
  const counts = Object.fromEntries(FILING_WARNING_ORDER.map((w) => [w, entries.filter((e) => e.warning === w).length])) as Record<FilingWarning, number>;
  const ownerExceptions = entries.filter((e) => e.ownerException);
  const nearBarNotJudged = input.nearBarDays === null && entries.some((e) => e.warning === 'overdue');
  return {
    today: input.today, entries, nearBarDays: input.nearBarDays, nearBarNotJudged, ownerExceptions, counts,
    detail: `${entries.length} return(s): ${counts.filed} filed, ${counts.overdue} overdue, ${counts.near_time_bar} near the time bar, ${counts.time_barred} time-barred${nearBarNotJudged ? ' — the owner has not set how many days before the bar to be warned, so "near the bar" is not judged' : ''}`,
  };
}
