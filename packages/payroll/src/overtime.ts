// Hours worked and overtime (R4 · C16 · OB-208 · OB-227). The signed sentence:
//   "Each employee's hours actually worked per day come from attendance and are shown on the payslip. Hours above the
//    normal daily or weekly hours are overtime, paid at no less than twice the ordinary hourly rate; a lower rate is
//    refused ('overtime below 2×'). … Until the CA fills them, … the normal hours show 'not confirmed', and the pay run
//    says … 'overtime limit not set'; it never assumes a figure."
//
// How overtime is counted (the build's reading, said here so it can be checked):
//   • the hours per day are the attendance store's hours for that person and day (latest per day), in whole minutes;
//   • a day's overtime is the minutes above the normal daily hours; a week's (Monday to Sunday, OB-179/OB-181) is the
//     minutes above the normal weekly hours; a week's overtime is the LARGER of the two (the sum of its days' excess or
//     its weekly excess), so the same hour is never paid twice;
//   • only the days of the pay month count — a week that starts or ends outside the month is judged on its days inside
//     the month;
//   • with only one of the two limits confirmed, that one is applied and the other is named as not set; with neither,
//     no overtime is worked out at all ("overtime limit not set") — the hours are still shown.
//
// The overtime rate is never below twice the ordinary hourly rate (OVERTIME_FLOOR_PERCENT, the signed floor). A rate
// asked for below it is REFUSED (OvertimeBelowFloor). With no confirmed multiplier and no rate asked for, overtime pay is
// not worked out ("overtime rate not set") — never a silent zero, never an assumed 2×.
//
// Pure and deterministic: no clock, no I/O.

import { figureInForce, OVERTIME_FLOOR_PERCENT, PAYROLL_FIGURES, type PayrollLegalSettings } from './legal-settings';

const DAY_MS = 86_400_000;
const isDate = (d: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** Monday of the week `date` is in (getUTCDay: 0 = Sunday). */
const mondayOf = (date: string): string => addDays(date, -((new Date(Date.parse(`${date}T00:00:00Z`)).getUTCDay() + 6) % 7));

/** "7h 30m". */
export const asHours = (minutes: number): string => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
};

export class InvalidOvertimeInput extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidOvertimeInput'; }
}

/** Refused: an overtime rate below twice the ordinary hourly rate ("overtime below 2×"). */
export class OvertimeBelowFloor extends Error {
  readonly code = 'overtime_below_2x';
  constructor(message: string) { super(message); this.name = 'OvertimeBelowFloor'; }
}

/** One day's attendance: hours worked (as the attendance store keeps them, a number of hours). */
export interface HoursFact { readonly date: string; readonly hours: number }

export interface DayWorked {
  readonly date: string;
  readonly workedMinutes: number;
  /** Minutes above the normal daily hours; null while that limit is not confirmed. */
  readonly overDailyMinutes: number | null;
}

export interface WeekWorked {
  readonly weekStart: string;
  /** The days of the week inside the pay month. */
  readonly days: readonly string[];
  readonly workedMinutes: number;
  readonly overDailyMinutes: number | null;
  readonly overWeeklyMinutes: number | null;
  /** The larger of the two — the week's overtime. */
  readonly overtimeMinutes: number;
}

export interface HoursAndOvertime {
  readonly period: string;
  /** Every day of the month with attendance, in date order — the hours actually worked, shown on the payslip. */
  readonly days: readonly DayWorked[];
  readonly totalWorkedMinutes: number;
  readonly weeks: readonly WeekWorked[];
  /** 'computed' when at least one normal-hours limit is confirmed; 'limit_not_set' when neither is. */
  readonly status: 'computed' | 'limit_not_set';
  /** Overtime minutes in the month; null while no limit is set (never a silent zero). */
  readonly overtimeMinutes: number | null;
  readonly normalDailyMinutes: number | null;
  readonly normalWeeklyMinutes: number | null;
  /** The limits not set, in words ("overtime limit not set: …"). */
  readonly notSet: readonly string[];
}

/** The days of a pay month (YYYY-MM). */
export function daysOfMonth(period: string): readonly string[] {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new InvalidOvertimeInput(`the pay period must be YYYY-MM, but reads "${period}"`);
  const out: string[] = [];
  for (let d = `${period}-01`; d.startsWith(period); d = addDays(d, 1)) out.push(d);
  return out;
}

/** Hours worked per day and the month's overtime, from attendance and the confirmed normal hours. Pure. */
export function hoursAndOvertime(input: { readonly settings: PayrollLegalSettings; readonly period: string; readonly hours: readonly HoursFact[] }): HoursAndOvertime {
  const monthDays = daysOfMonth(input.period);
  const inMonth = new Set(monthDays);
  const minutesOn = new Map<string, number>();
  for (const h of input.hours) {
    if (!isDate(h.date)) throw new InvalidOvertimeInput(`an attendance date is not YYYY-MM-DD: "${h.date}"`);
    if (typeof h.hours !== 'number' || !Number.isFinite(h.hours) || h.hours < 0 || h.hours > 24) throw new InvalidOvertimeInput(`the hours on ${h.date} must be 0 to 24, but read "${h.hours}"`);
    if (inMonth.has(h.date)) minutesOn.set(h.date, Math.round(h.hours * 60)); // latest per day wins
  }
  const daily = figureInForce(input.settings, 'normalDailyMinutes') ?? null;
  const weekly = figureInForce(input.settings, 'normalWeeklyMinutes') ?? null;
  const notSet: string[] = [];
  if (daily === null) notSet.push(`overtime limit not set: ${PAYROLL_FIGURES.normalDailyMinutes.label} — not confirmed`);
  if (weekly === null) notSet.push(`overtime limit not set: ${PAYROLL_FIGURES.normalWeeklyMinutes.label} — not confirmed`);

  const days: DayWorked[] = monthDays.filter((d) => minutesOn.has(d)).map((d) => {
    const worked = minutesOn.get(d)!;
    return { date: d, workedMinutes: worked, overDailyMinutes: daily === null ? null : Math.max(0, worked - daily) };
  });
  const byWeek = new Map<string, string[]>();
  for (const d of monthDays) byWeek.set(mondayOf(d), [...(byWeek.get(mondayOf(d)) ?? []), d]);
  const weeks: WeekWorked[] = [...byWeek.entries()].map(([weekStart, ds]) => {
    const worked = ds.reduce((s, d) => s + (minutesOn.get(d) ?? 0), 0);
    const overDaily = daily === null ? null : ds.reduce((s, d) => s + Math.max(0, (minutesOn.get(d) ?? 0) - daily), 0);
    const overWeekly = weekly === null ? null : Math.max(0, worked - weekly);
    return { weekStart, days: ds, workedMinutes: worked, overDailyMinutes: overDaily, overWeeklyMinutes: overWeekly, overtimeMinutes: Math.max(overDaily ?? 0, overWeekly ?? 0) };
  });
  const computed = daily !== null || weekly !== null;
  return {
    period: input.period, days, totalWorkedMinutes: days.reduce((s, d) => s + d.workedMinutes, 0), weeks,
    status: computed ? 'computed' : 'limit_not_set',
    overtimeMinutes: computed ? weeks.reduce((s, w) => s + w.overtimeMinutes, 0) : null,
    normalDailyMinutes: daily, normalWeeklyMinutes: weekly, notSet,
  };
}

export interface OvertimePay {
  readonly status: 'paid' | 'no_overtime' | 'limit_not_set' | 'rate_not_set' | 'ordinary_rate_unknown';
  readonly overtimeMinutes: number | null;
  readonly ordinaryHourlyRateMinor: number | null;
  /** The hourly overtime rate paid; null while not worked out. */
  readonly overtimeHourlyRateMinor: number | null;
  /** Overtime wages in paise; null while not worked out (never a silent zero). */
  readonly payMinor: number | null;
  readonly detail: string;
}

/**
 * The month's overtime wages. The rate is the one asked for, or — with none asked — the ordinary hourly rate times the
 * CA-confirmed multiplier. Either way it is never below twice the ordinary rate: a lower one is REFUSED
 * (OvertimeBelowFloor, "overtime below 2×"). Without an ordinary rate the floor cannot be judged, so nothing is paid as
 * overtime and it is said. Pure.
 */
export function overtimePay(input: {
  readonly settings: PayrollLegalSettings;
  readonly overtimeMinutes: number | null;
  readonly ordinaryHourlyRateMinor?: number;
  readonly overtimeHourlyRateMinor?: number;
}): OvertimePay {
  const ord = input.ordinaryHourlyRateMinor;
  const asked = input.overtimeHourlyRateMinor;
  if (ord !== undefined && (!Number.isInteger(ord) || ord <= 0)) throw new InvalidOvertimeInput('the ordinary hourly rate must be a whole number of paise above 0');
  if (asked !== undefined && (!Number.isInteger(asked) || asked <= 0)) throw new InvalidOvertimeInput('the overtime hourly rate must be a whole number of paise above 0');
  // A rate asked for below the floor is refused whatever the hours — the rate itself is wrong.
  if (asked !== undefined && ord !== undefined && asked * 100 < ord * OVERTIME_FLOOR_PERCENT) {
    throw new OvertimeBelowFloor(`overtime below 2×: ₹${(asked / 100).toFixed(2)} an hour is less than twice the ordinary hourly rate of ₹${(ord / 100).toFixed(2)}`);
  }
  const base = { overtimeMinutes: input.overtimeMinutes, ordinaryHourlyRateMinor: ord ?? null };
  if (input.overtimeMinutes === null) return { ...base, status: 'limit_not_set', overtimeHourlyRateMinor: null, payMinor: null, detail: 'overtime limit not set — no overtime worked out' };
  if (input.overtimeMinutes === 0) return { ...base, status: 'no_overtime', overtimeHourlyRateMinor: null, payMinor: 0, detail: 'no hours above the normal hours' };
  if (ord === undefined) return { ...base, status: 'ordinary_rate_unknown', overtimeHourlyRateMinor: null, payMinor: null, detail: `${asHours(input.overtimeMinutes)} of overtime not paid: the ordinary hourly rate is not in the staff directory, so the 2× floor cannot be checked` };
  const multiplier = figureInForce(input.settings, 'overtimeMultiplierPercent');
  const rate = asked ?? (multiplier === undefined ? undefined : Math.round((ord * multiplier) / 100));
  if (rate === undefined) return { ...base, status: 'rate_not_set', overtimeHourlyRateMinor: null, payMinor: null, detail: `${asHours(input.overtimeMinutes)} of overtime not paid: overtime rate not set — ${PAYROLL_FIGURES.overtimeMultiplierPercent.label} is not confirmed` };
  const payMinor = Math.round((input.overtimeMinutes * rate) / 60);
  return { ...base, status: 'paid', overtimeHourlyRateMinor: rate, payMinor, detail: `${asHours(input.overtimeMinutes)} of overtime at ₹${(rate / 100).toFixed(2)} an hour` };
}
