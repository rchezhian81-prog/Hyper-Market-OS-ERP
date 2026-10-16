// Working-time compliance pack (R2 addendum C18 · M25) — the Tamil Nadu Shops and Establishments Act, 1947 pack:
// weekly holiday, daily and weekly hours caps, spread-over, rest interval, leave accrual, and the statutory
// attendance / leave / holiday registers.
//
// **No legal number is written in this file.** The repository's requirements name the law (docs/requirements/
// WORLDWIDE_REQUIREMENTS_GAP_ANALYSIS.md row C18: "TN Shops and Establishments Act 1947") but give no figure for any
// limit. So every limit is a SETTING with three parts — the value, the provision of the Act it comes from, and who
// confirmed it (the owner or the chartered accountant, with a reference). A limit missing any of the three is
// PENDING: it is never guessed, never defaulted, and a roster cannot be published while a limit it must be checked
// against is pending (P-08: an unchecked rule is said out loud, not silently passed).
//
// What a breach does: the published roster is REFUSED, with every breach named in words — which person, which day,
// what the roster says and what the limit is (C18 says "enforced"; it names no approver, so nothing here routes a
// breach to anyone for sign-off).
//
// Pure and deterministic: times are passed in, the store's local offset is a setting, no clock, no I/O.

import type { Employee, ShiftAssignment, ShiftRequirement } from './workforce';

/** The limits the pack enforces. Every one is configuration — see the header. */
export type WorkingTimeLimitKey =
  | 'weeklyHolidayMinDays'
  | 'maxDailyWorkMinutes'
  | 'maxWeeklyWorkMinutes'
  | 'maxSpreadOverMinutes'
  | 'maxContinuousWorkMinutes'
  | 'minRestIntervalMinutes'
  | 'annualLeaveDaysWorkedPerDayEarned';

export const WORKING_TIME_LIMIT_KEYS: readonly WorkingTimeLimitKey[] = Object.freeze([
  'weeklyHolidayMinDays', 'maxDailyWorkMinutes', 'maxWeeklyWorkMinutes', 'maxSpreadOverMinutes',
  'maxContinuousWorkMinutes', 'minRestIntervalMinutes', 'annualLeaveDaysWorkedPerDayEarned',
]);

/** The law the pack is built for, as the repository's requirements name it (no section numbers are given there). */
export const WORKING_TIME_LAW = 'Tamil Nadu Shops and Establishments Act, 1947';

/** What each limit means, in words, and the unit its value is in. */
export const WORKING_TIME_LIMITS: Readonly<Record<WorkingTimeLimitKey, { readonly label: string; readonly unit: string; readonly max: number }>> = Object.freeze({
  weeklyHolidayMinDays: { label: 'Weekly holiday — whole days off each person must have in every week', unit: 'days', max: 7 },
  maxDailyWorkMinutes: { label: 'Daily hours cap — the most a person may be rostered to work in one day', unit: 'minutes', max: 24 * 60 },
  maxWeeklyWorkMinutes: { label: 'Weekly hours cap — the most a person may be rostered to work in one week', unit: 'minutes', max: 7 * 24 * 60 },
  maxSpreadOverMinutes: { label: 'Spread-over — the longest span from a person\'s first start to last finish in one day', unit: 'minutes', max: 24 * 60 },
  maxContinuousWorkMinutes: { label: 'Rest interval — the longest a person may work before a rest break', unit: 'minutes', max: 24 * 60 },
  minRestIntervalMinutes: { label: 'Rest interval — the shortest break that counts as a rest', unit: 'minutes', max: 24 * 60 },
  annualLeaveDaysWorkedPerDayEarned: { label: 'Leave accrual — days worked that earn one day of annual leave', unit: 'days worked', max: 366 },
});

/** One limit as the owner set it. All three parts must be present for the limit to be in force. */
export interface LimitSetting {
  /** A whole number in the limit's unit; null while nobody has filled it in. */
  readonly value: number | null;
  /** The provision of the Act (or the rule) the value comes from. */
  readonly source: string | null;
  /** Who confirmed the value — the owner or the CA — with a reference to the confirmation. */
  readonly confirmation: string | null;
}

/** A declared public / festival holiday the holiday register reports against. */
export interface PublicHoliday { readonly date: string; readonly name: string }

export interface WorkingTimeSettings {
  readonly limits: Readonly<Record<WorkingTimeLimitKey, LimitSetting>>;
  /** The declared holidays, with where the list comes from and who confirmed it. */
  readonly publicHolidays: { readonly dates: readonly PublicHoliday[]; readonly source: string | null; readonly confirmation: string | null };
  /** The store's offset from UTC in minutes — a fact about the store's clock, not a legal limit. India is +330. */
  readonly utcOffsetMinutes: number;
}

const EMPTY_LIMIT: LimitSetting = Object.freeze({ value: null, source: null, confirmation: null });

/** The settings as shipped: every limit PENDING, no holidays declared. India Standard Time is UTC+05:30. */
export const UNSET_WORKING_TIME_SETTINGS: WorkingTimeSettings = Object.freeze({
  limits: Object.freeze(Object.fromEntries(WORKING_TIME_LIMIT_KEYS.map((k) => [k, EMPTY_LIMIT])) as Record<WorkingTimeLimitKey, LimitSetting>),
  publicHolidays: Object.freeze({ dates: [], source: null, confirmation: null }),
  utcOffsetMinutes: 330,
});

const filled = (s: string | null): boolean => typeof s === 'string' && s.trim() !== '';

/** A value the limit can hold: a whole number from 1 (0 for none) up to the limit's ceiling. */
export function limitValueIsValid(key: WorkingTimeLimitKey, value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= WORKING_TIME_LIMITS[key].max;
}

export interface LimitStatus {
  readonly key: WorkingTimeLimitKey;
  readonly label: string;
  readonly unit: string;
  readonly status: 'in_force' | 'pending';
  readonly value: number | null;
  /** Why it is pending, in words. Absent when in force. */
  readonly missing?: string;
}

/** Every limit and whether it is in force — a pending one says what is missing. */
export function limitStatuses(settings: WorkingTimeSettings): readonly LimitStatus[] {
  return WORKING_TIME_LIMIT_KEYS.map((key) => {
    const s = settings.limits[key] ?? EMPTY_LIMIT;
    const gaps: string[] = [];
    if (!limitValueIsValid(key, s.value)) gaps.push('the value');
    if (!filled(s.source)) gaps.push('the provision of the Act it comes from');
    if (!filled(s.confirmation)) gaps.push('who confirmed it (owner or CA)');
    const { label, unit } = WORKING_TIME_LIMITS[key];
    return gaps.length === 0
      ? { key, label, unit, status: 'in_force' as const, value: s.value }
      : { key, label, unit, status: 'pending' as const, value: s.value, missing: `needs ${gaps.join(', ')}` };
  });
}

/** The value of a limit that is in force, or undefined when it is pending. */
export function limitInForce(settings: WorkingTimeSettings, key: WorkingTimeLimitKey): number | undefined {
  const st = limitStatuses(settings).find((s) => s.key === key)!;
  return st.status === 'in_force' ? (st.value as number) : undefined;
}

// ── Time arithmetic ──────────────────────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const isDate = (d: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));

/** The store-local calendar date of an instant. */
export function localDateOf(ms: number, utcOffsetMinutes: number): string {
  return new Date(ms + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** `date` plus `n` days (YYYY-MM-DD). */
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** The dates from `from` to `to` inclusive. */
export function datesBetween(from: string, to: string): readonly string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

const hhmm = (ms: number, off: number): string => new Date(ms + off * 60_000).toISOString().slice(11, 16);
const asHours = (minutes: number): string => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
};

interface Interval { readonly shiftId: string; readonly startMs: number; readonly endMs: number }

/** Merge intervals whose gap is shorter than `minGapMs` into one continuous block. */
function blocks(intervals: readonly Interval[], minGapMs: number): { startMs: number; endMs: number; shiftIds: string[] }[] {
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  const out: { startMs: number; endMs: number; shiftIds: string[] }[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && i.startMs - last.endMs < minGapMs) {
      last.endMs = Math.max(last.endMs, i.endMs);
      last.shiftIds.push(i.shiftId);
    } else {
      out.push({ startMs: i.startMs, endMs: i.endMs, shiftIds: [i.shiftId] });
    }
  }
  return out;
}

/** Minutes covered by the intervals, an overlap counted once. */
const coveredMinutes = (intervals: readonly Interval[]): number =>
  blocks(intervals, 1).reduce((sum, b) => sum + Math.round((b.endMs - b.startMs) / 60_000), 0);

// ── The roster check ─────────────────────────────────────────────────────────────────────────────────────────────

export type WorkingTimeRule = WorkingTimeLimitKey | 'unreadable_shift';

export interface WorkingTimeBreach {
  readonly employeeId: string;
  readonly name: string;
  readonly rule: WorkingTimeRule;
  /** The local day the breach is on; absent for a whole-week rule. */
  readonly date?: string;
  /** What the roster gives, in the limit's unit. */
  readonly observed: number;
  /** The limit in force. */
  readonly limit: number;
  readonly shiftIds: readonly string[];
  /** Written for a manager reading it on a phone. */
  readonly detail: string;
}

export interface WorkingTimeCheck {
  readonly weekStart: string;
  readonly weekEnd: string;
  /** Limits a roster must be checked against that are not yet in force — publishing is refused while any are. */
  readonly pending: readonly LimitStatus[];
  readonly breaches: readonly WorkingTimeBreach[];
  readonly employeesChecked: number;
  readonly shiftsChecked: number;
}

/** The limits a roster is checked against (leave accrual is not a roster limit). */
export const ROSTER_LIMIT_KEYS: readonly WorkingTimeLimitKey[] = Object.freeze([
  'weeklyHolidayMinDays', 'maxDailyWorkMinutes', 'maxWeeklyWorkMinutes', 'maxSpreadOverMinutes',
  'maxContinuousWorkMinutes', 'minRestIntervalMinutes',
]);

/**
 * Check one branch's week of roster against every working-time limit in force.
 *
 * The people checked are the active staff assigned to a shift of `branchId` that starts in the week (store-local).
 * Their hours count EVERY shift they hold in the week, at any branch — the limits are on the person, not the shop.
 * A day with no shift is a day off. A shift whose times cannot be read is itself a breach (never skipped silently).
 */
export function checkWorkingTime(input: {
  readonly settings: WorkingTimeSettings;
  readonly branchId: string;
  /** The first store-local day of the week being published (YYYY-MM-DD). */
  readonly weekStart: string;
  readonly shifts: readonly ShiftRequirement[];
  readonly assignments: readonly ShiftAssignment[];
  readonly employees: readonly Employee[];
}): WorkingTimeCheck {
  if (!isDate(input.weekStart)) throw new RangeError(`weekStart must be YYYY-MM-DD, got "${input.weekStart}"`);
  const off = input.settings.utcOffsetMinutes;
  const weekEnd = addDays(input.weekStart, 6);
  const days = datesBetween(input.weekStart, weekEnd);
  const pending = limitStatuses(input.settings).filter((s) => ROSTER_LIMIT_KEYS.includes(s.key) && s.status === 'pending');
  const limit = (k: WorkingTimeLimitKey): number | undefined => limitInForce(input.settings, k);

  const shiftById = new Map(input.shifts.map((s) => [s.shiftId, s]));
  const startOf = (s: ShiftRequirement): number => Date.parse(s.startsAt);
  const inWeek = (s: ShiftRequirement): boolean => {
    const ms = startOf(s);
    if (Number.isNaN(ms)) return false;
    const d = localDateOf(ms, off);
    return d >= input.weekStart && d <= weekEnd;
  };
  const employeeById = new Map(input.employees.map((e) => [e.employeeId, e]));
  const branchShiftIds = new Set(input.shifts.filter((s) => s.branchId === input.branchId && inWeek(s)).map((s) => s.shiftId));
  const people = [...new Set(input.assignments.filter((a) => branchShiftIds.has(a.shiftId)).map((a) => a.employeeId))]
    .filter((id) => employeeById.get(id)?.active !== false)
    .sort();

  const breaches: WorkingTimeBreach[] = [];
  // Unreadable shifts of this branch in or near the week (start unreadable, or end not after start) are breaches.
  for (const s of input.shifts.filter((x) => x.branchId === input.branchId)) {
    const a = Date.parse(s.startsAt);
    const b = Date.parse(s.endsAt);
    const assigned = input.assignments.filter((x) => x.shiftId === s.shiftId).map((x) => x.employeeId);
    if (assigned.length === 0) continue;
    const near = !Number.isNaN(a) ? inWeek(s) : true;
    if (near && (Number.isNaN(a) || Number.isNaN(b) || b <= a)) {
      for (const employeeId of assigned) {
        breaches.push({
          employeeId, name: employeeById.get(employeeId)?.name ?? employeeId, rule: 'unreadable_shift', observed: 0, limit: 0,
          shiftIds: [s.shiftId],
          detail: `Shift ${s.shiftId} has times that cannot be checked (starts "${s.startsAt}", ends "${s.endsAt}") — fix the shift times before publishing`,
        });
      }
    }
  }

  for (const employeeId of people) {
    const name = employeeById.get(employeeId)?.name ?? employeeId;
    const mine: Interval[] = input.assignments
      .filter((a) => a.employeeId === employeeId)
      .map((a) => shiftById.get(a.shiftId))
      .filter((s): s is ShiftRequirement => s !== undefined && inWeek(s))
      .map((s) => ({ shiftId: s.shiftId, startMs: startOf(s), endMs: Date.parse(s.endsAt) }))
      .filter((i) => !Number.isNaN(i.endMs) && i.endMs > i.startMs);
    // One assignment per shift per person (two roles on one shift is still one stretch of work).
    const unique = [...new Map(mine.map((i) => [i.shiftId, i])).values()];
    const byDay = new Map<string, Interval[]>(days.map((d) => [d, []]));
    for (const i of unique) byDay.get(localDateOf(i.startMs, off))!.push(i);

    let weekMinutes = 0;
    for (const d of days) {
      const today = byDay.get(d)!;
      if (today.length === 0) continue;
      const ids = today.map((i) => i.shiftId).sort();
      const worked = coveredMinutes(today);
      weekMinutes += worked;
      const first = Math.min(...today.map((i) => i.startMs));
      const last = Math.max(...today.map((i) => i.endMs));
      const span = Math.round((last - first) / 60_000);

      const daily = limit('maxDailyWorkMinutes');
      if (daily !== undefined && worked > daily) {
        breaches.push({ employeeId, name, rule: 'maxDailyWorkMinutes', date: d, observed: worked, limit: daily, shiftIds: ids,
          detail: `${name} is rostered ${asHours(worked)} on ${d} — more than the daily cap of ${asHours(daily)}` });
      }
      const spread = limit('maxSpreadOverMinutes');
      if (spread !== undefined && span > spread) {
        breaches.push({ employeeId, name, rule: 'maxSpreadOverMinutes', date: d, observed: span, limit: spread, shiftIds: ids,
          detail: `${name}'s day on ${d} spreads from ${hhmm(first, off)} to ${hhmm(last, off)} (${asHours(span)}) — longer than the spread-over limit of ${asHours(spread)}` });
      }
      const continuous = limit('maxContinuousWorkMinutes');
      const rest = limit('minRestIntervalMinutes');
      if (continuous !== undefined && rest !== undefined) {
        for (const b of blocks(today, rest * 60_000)) {
          const stretch = Math.round((b.endMs - b.startMs) / 60_000);
          if (stretch > continuous) {
            breaches.push({ employeeId, name, rule: 'maxContinuousWorkMinutes', date: d, observed: stretch, limit: continuous, shiftIds: [...b.shiftIds].sort(),
              detail: `${name} works ${hhmm(b.startMs, off)}–${hhmm(b.endMs, off)} on ${d} (${asHours(stretch)}) with no rest of at least ${asHours(rest)} — longer than the ${asHours(continuous)} allowed before a rest interval` });
          }
        }
      }
    }

    const weekly = limit('maxWeeklyWorkMinutes');
    const allIds = unique.map((i) => i.shiftId).sort();
    if (weekly !== undefined && weekMinutes > weekly) {
      breaches.push({ employeeId, name, rule: 'maxWeeklyWorkMinutes', observed: weekMinutes, limit: weekly, shiftIds: allIds,
        detail: `${name} is rostered ${asHours(weekMinutes)} in the week of ${input.weekStart} — more than the weekly cap of ${asHours(weekly)}` });
    }
    const holiday = limit('weeklyHolidayMinDays');
    const daysOff = days.filter((d) => byDay.get(d)!.length === 0).length;
    if (holiday !== undefined && daysOff < holiday) {
      breaches.push({ employeeId, name, rule: 'weeklyHolidayMinDays', observed: daysOff, limit: holiday, shiftIds: allIds,
        detail: `${name} has ${daysOff} day(s) off in the week of ${input.weekStart} — the weekly holiday needs at least ${holiday}` });
    }
  }

  return {
    weekStart: input.weekStart, weekEnd, pending,
    breaches: breaches.sort((a, b) => a.employeeId.localeCompare(b.employeeId) || (a.date ?? '').localeCompare(b.date ?? '') || a.rule.localeCompare(b.rule)),
    employeesChecked: people.length,
    shiftsChecked: branchShiftIds.size,
  };
}

// ── Leave ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One day of annual leave taken — or a compensating cancellation of an earlier one (hard rule #2). */
export interface LeaveRecord {
  readonly employeeId: string;
  readonly date: string;
  readonly kind: 'taken' | 'cancelled';
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly note?: string;
}

/** The days of leave still standing: the latest record per (employee, date) is `taken`. */
export function leaveDaysTaken(records: readonly LeaveRecord[]): ReadonlyMap<string, readonly string[]> {
  const latest = new Map<string, LeaveRecord>();
  for (const r of records) latest.set(`${r.employeeId}|${r.date}`, r);
  const out = new Map<string, string[]>();
  for (const r of latest.values()) {
    if (r.kind !== 'taken') continue;
    out.set(r.employeeId, [...(out.get(r.employeeId) ?? []), r.date].sort());
  }
  return out;
}

export interface LeaveBalance {
  readonly employeeId: string;
  readonly daysWorked: number;
  /** Whole days earned; null while the accrual rate is pending. */
  readonly earned: number | null;
  readonly taken: number;
  readonly takenDates: readonly string[];
  /** earned − taken; null while the accrual rate is pending. */
  readonly balance: number | null;
  readonly accrual: 'in_force' | 'pending';
}

/** Annual leave earned from days worked (a day with hours > 0), less the days taken. */
export function leaveBalance(input: {
  readonly settings: WorkingTimeSettings;
  readonly employeeId: string;
  readonly daysWorked: number;
  readonly takenDates: readonly string[];
}): LeaveBalance {
  const per = limitInForce(input.settings, 'annualLeaveDaysWorkedPerDayEarned');
  const taken = input.takenDates.length;
  if (per === undefined) {
    return { employeeId: input.employeeId, daysWorked: input.daysWorked, earned: null, taken, takenDates: input.takenDates, balance: null, accrual: 'pending' };
  }
  const earned = Math.floor(input.daysWorked / per);
  return { employeeId: input.employeeId, daysWorked: input.daysWorked, earned, taken, takenDates: input.takenDates, balance: earned - taken, accrual: 'in_force' };
}

// ── Statutory registers ──────────────────────────────────────────────────────────────────────────────────────────

/** Hours a person worked on a day (the attendance store's record). */
export interface AttendanceFact { readonly employeeId: string; readonly date: string; readonly hours: number }

export type AttendanceDayStatus = 'present' | 'absent' | 'leave' | 'not_recorded' | 'off';

export interface AttendanceRegisterDay {
  readonly date: string;
  readonly rostered: readonly { readonly shiftId: string; readonly from: string; readonly to: string }[];
  readonly hoursRecorded: number | null;
  readonly status: AttendanceDayStatus;
}

export interface AttendanceRegisterRow {
  readonly employeeId: string;
  readonly name: string;
  readonly branchId: string;
  readonly days: readonly AttendanceRegisterDay[];
  readonly daysPresent: number;
  readonly hoursTotal: number;
  /** Rostered days with no attendance recorded — shown, never assumed present or absent (P-08). */
  readonly daysNotRecorded: number;
}

const rosteredOn = (employeeId: string, date: string, shifts: readonly ShiftRequirement[], assignments: readonly ShiftAssignment[], off: number) => {
  const mine = new Set(assignments.filter((a) => a.employeeId === employeeId).map((a) => a.shiftId));
  return shifts
    .filter((s) => mine.has(s.shiftId) && !Number.isNaN(Date.parse(s.startsAt)) && localDateOf(Date.parse(s.startsAt), off) === date)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .map((s) => ({
      shiftId: s.shiftId,
      from: hhmm(Date.parse(s.startsAt), off),
      to: Number.isNaN(Date.parse(s.endsAt)) ? '?' : hhmm(Date.parse(s.endsAt), off),
    }));
};

/**
 * The attendance register for a period: for each person and day, the rostered shift(s), the hours recorded and the
 * status. A rostered day with nothing recorded is `not_recorded` — a gap the register shows, not a guess.
 */
export function attendanceRegister(input: {
  readonly from: string; readonly to: string;
  readonly settings: WorkingTimeSettings;
  readonly employees: readonly Employee[];
  readonly attendance: readonly AttendanceFact[];
  readonly shifts: readonly ShiftRequirement[];
  readonly assignments: readonly ShiftAssignment[];
  readonly leave: readonly LeaveRecord[];
}): readonly AttendanceRegisterRow[] {
  const off = input.settings.utcOffsetMinutes;
  const days = datesBetween(input.from, input.to);
  const hours = new Map(input.attendance.map((a) => [`${a.employeeId}|${a.date}`, a.hours]));
  const leave = leaveDaysTaken(input.leave);
  return [...input.employees].sort((a, b) => a.employeeId.localeCompare(b.employeeId)).map((e) => {
    const onLeave = new Set(leave.get(e.employeeId) ?? []);
    const rows = days.map((date): AttendanceRegisterDay => {
      const rostered = rosteredOn(e.employeeId, date, input.shifts, input.assignments, off);
      const h = hours.get(`${e.employeeId}|${date}`);
      const status: AttendanceDayStatus = h !== undefined && h > 0 ? 'present'
        : onLeave.has(date) ? 'leave'
          : h !== undefined ? 'absent'
            : rostered.length > 0 ? 'not_recorded' : 'off';
      return { date, rostered, hoursRecorded: h ?? null, status };
    });
    return {
      employeeId: e.employeeId, name: e.name, branchId: e.branchId, days: rows,
      daysPresent: rows.filter((r) => r.status === 'present').length,
      hoursTotal: rows.reduce((s, r) => s + (r.hoursRecorded ?? 0), 0),
      daysNotRecorded: rows.filter((r) => r.status === 'not_recorded').length,
    };
  });
}

export interface HolidayRegisterWeek {
  readonly weekStart: string;
  readonly daysOff: readonly string[];
  /** Whether the weekly holiday was given; null while the weekly-holiday limit is pending. */
  readonly weeklyHolidayGiven: boolean | null;
}

export interface HolidayRegister {
  readonly from: string;
  readonly to: string;
  readonly weeklyHoliday: 'in_force' | 'pending';
  readonly people: readonly { readonly employeeId: string; readonly name: string; readonly branchId: string; readonly weeks: readonly HolidayRegisterWeek[] }[];
  /** Declared public holidays in the period and who worked on each (hours recorded, or rostered). */
  readonly publicHolidays: readonly { readonly date: string; readonly name: string; readonly workedBy: readonly string[] }[];
  readonly publicHolidayList: 'in_force' | 'pending';
}

/**
 * The holiday register for a period, in 7-day weeks from `from`: each person's days off (no shift and no hours) and
 * whether the weekly holiday was given; and the declared public holidays with who worked them.
 */
export function holidayRegister(input: {
  readonly from: string; readonly to: string;
  readonly settings: WorkingTimeSettings;
  readonly employees: readonly Employee[];
  readonly attendance: readonly AttendanceFact[];
  readonly shifts: readonly ShiftRequirement[];
  readonly assignments: readonly ShiftAssignment[];
}): HolidayRegister {
  const off = input.settings.utcOffsetMinutes;
  const min = limitInForce(input.settings, 'weeklyHolidayMinDays');
  const worked = (employeeId: string, date: string): boolean =>
    input.attendance.some((a) => a.employeeId === employeeId && a.date === date && a.hours > 0)
    || rosteredOn(employeeId, date, input.shifts, input.assignments, off).length > 0;
  const weeks: string[][] = [];
  for (let start = input.from; start <= input.to; start = addDays(start, 7)) {
    const end = addDays(start, 6) < input.to ? addDays(start, 6) : input.to;
    weeks.push([...datesBetween(start, end)]);
  }
  const ph = input.settings.publicHolidays;
  const phInForce = filled(ph.source) && filled(ph.confirmation);
  return {
    from: input.from, to: input.to,
    weeklyHoliday: min === undefined ? 'pending' : 'in_force',
    people: [...input.employees].sort((a, b) => a.employeeId.localeCompare(b.employeeId)).map((e) => ({
      employeeId: e.employeeId, name: e.name, branchId: e.branchId,
      weeks: weeks.map((w) => {
        const daysOff = w.filter((d) => !worked(e.employeeId, d));
        // A part week at the end of the period is reported but not judged — it is not a whole week.
        const judged = min !== undefined && w.length === 7;
        return { weekStart: w[0]!, daysOff, weeklyHolidayGiven: judged ? daysOff.length >= min : null };
      }),
    })),
    publicHolidays: ph.dates.filter((h) => h.date >= input.from && h.date <= input.to).sort((a, b) => a.date.localeCompare(b.date)).map((h) => ({
      date: h.date, name: h.name,
      workedBy: input.employees.filter((e) => worked(e.employeeId, h.date)).map((e) => e.employeeId).sort(),
    })),
    publicHolidayList: phInForce ? 'in_force' : 'pending',
  };
}

/** The statutory registers' prescribed form numbers and layouts are not in the repository: pending the CA. */
export const REGISTER_FORMAT_NOTE =
  'Built from the stored roster and attendance. The prescribed form numbers and layout under the Act\'s rules are not in the requirements yet — pending the owner\'s or CA\'s confirmation.';
