// Working-time compliance pack (R2 addendum C18 · M25) — the Tamil Nadu Shops and Establishments Act, 1947 pack:
// weekly holiday, daily and weekly hours caps, spread-over, rest interval, leave accrual, and the statutory
// attendance / leave / holiday registers.
//
// **No legal number is written in this file.** The repository's requirements name the law (docs/requirements/
// WORLDWIDE_REQUIREMENTS_GAP_ANALYSIS.md row C18: "TN Shops and Establishments Act 1947") but give no figure for any
// limit. So every limit is a SETTING with three parts — the value, the provision of the Act it comes from, and who
// confirmed it (the owner or the chartered accountant, with a reference). A limit missing any of the three is
// PENDING: it is never guessed and never defaulted. A pending limit is NOT CHECKED, and says so: OB-155 (owner, 16 Oct
// 2026) — a roster may be published while limits are pending, and the publication, the roster and the registers name
// exactly which limits were not checked (P-08: an unchecked rule is said out loud, not silently passed).
//
// What a breach of a limit that IS in force does: the published roster is REFUSED, with every breach named in words —
// which person, which day, what the roster says and what the limit is (C18 says "enforced"; OB-152 "A": refuse it —
// nothing here routes a breach to anyone for sign-off).
//
// Leave beside annual leave (OB-156): casual, sick, festival and unpaid leave are settings too — days a year and a
// carry-over rule, each with its source and confirmation. Until a type is filled it is shown as not checked.
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
  /** OB-156: the configurable leave types (casual, sick, festival, unpaid) — every one pending until the CA's values. */
  readonly leaveTypes: Readonly<Record<LeaveTypeKey, LeaveTypeSetting>>;
}

const EMPTY_LIMIT: LimitSetting = Object.freeze({ value: null, source: null, confirmation: null });

/** The settings as shipped: every limit PENDING, no holidays declared. India Standard Time is UTC+05:30. */
export const UNSET_WORKING_TIME_SETTINGS: WorkingTimeSettings = Object.freeze({
  limits: Object.freeze(Object.fromEntries(WORKING_TIME_LIMIT_KEYS.map((k) => [k, EMPTY_LIMIT])) as Record<WorkingTimeLimitKey, LimitSetting>),
  publicHolidays: Object.freeze({ dates: [], source: null, confirmation: null }),
  utcOffsetMinutes: 330,
  leaveTypes: Object.freeze({
    casual: { daysPerYear: null, carryOverMaxDays: null, source: null, confirmation: null },
    sick: { daysPerYear: null, carryOverMaxDays: null, source: null, confirmation: null },
    festival: { daysPerYear: null, carryOverMaxDays: null, source: null, confirmation: null },
    unpaid: { daysPerYear: null, carryOverMaxDays: null, source: null, confirmation: null },
  }),
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
  /** The local day the breach is on (for a stretch of work, the day it starts); absent for a whole-week rule. */
  readonly date?: string;
  /** What the roster gives, in the limit's unit. */
  readonly observed: number;
  /** The limit in force. */
  readonly limit: number;
  readonly shiftIds: readonly string[];
  /** Written for a manager reading it on a phone. */
  readonly detail: string;
}

/** A roster limit that the check could NOT apply, and why (OB-155: named on the publication, never passed silently). */
export interface LimitNotChecked {
  readonly key: WorkingTimeLimitKey;
  readonly label: string;
  /** What is missing, in words. */
  readonly missing: string;
}

export interface WorkingTimeCheck {
  readonly weekStart: string;
  readonly weekEnd: string;
  /** Roster limits that are not yet in force (each missing its value, source or confirmation). */
  readonly pending: readonly LimitStatus[];
  /**
   * Every roster limit this check could not apply — the pending ones, and a rest-interval rule whose partner limit is
   * pending (the continuous-work cap and the shortest rest only mean something together). OB-155: a week may be
   * published while this is not empty, and the publication says exactly which limits were not checked.
   */
  readonly notChecked: readonly LimitNotChecked[];
  readonly breaches: readonly WorkingTimeBreach[];
  readonly employeesChecked: number;
  readonly shiftsChecked: number;
}

/** The limits a roster is checked against (leave accrual is not a roster limit). */
export const ROSTER_LIMIT_KEYS: readonly WorkingTimeLimitKey[] = Object.freeze([
  'weeklyHolidayMinDays', 'maxDailyWorkMinutes', 'maxWeeklyWorkMinutes', 'maxSpreadOverMinutes',
  'maxContinuousWorkMinutes', 'minRestIntervalMinutes',
]);

/** The roster limits that cannot be applied with these settings, each with what it is missing. */
export function rosterLimitsNotChecked(settings: WorkingTimeSettings): readonly LimitNotChecked[] {
  const st = limitStatuses(settings).filter((s) => ROSTER_LIMIT_KEYS.includes(s.key));
  const pending = new Set(st.filter((s) => s.status === 'pending').map((s) => s.key));
  return st.flatMap((s): LimitNotChecked[] => {
    if (s.status === 'pending') return [{ key: s.key, label: s.label, missing: s.missing ?? 'pending' }];
    if (s.key === 'maxContinuousWorkMinutes' && pending.has('minRestIntervalMinutes')) {
      return [{ key: s.key, label: s.label, missing: 'needs the shortest rest interval (minRestIntervalMinutes) to be in force too' }];
    }
    if (s.key === 'minRestIntervalMinutes' && pending.has('maxContinuousWorkMinutes')) {
      return [{ key: s.key, label: s.label, missing: 'needs the longest continuous work (maxContinuousWorkMinutes) to be in force too' }];
    }
    return [];
  });
}

/** The UTC instant of store-local midnight at the start of `date`. */
const localMidnightMs = (date: string, off: number): number => Date.parse(`${date}T00:00:00Z`) - off * 60_000;

/** A shift's times, or undefined when they cannot be read (either time unreadable, or the end not after the start). */
function readableTimes(s: ShiftRequirement): { startMs: number; endMs: number } | undefined {
  const startMs = Date.parse(s.startsAt);
  const endMs = Date.parse(s.endsAt);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return undefined;
  return { startMs, endMs };
}

/** Minutes of the intervals that fall inside [fromMs, toMs), an overlap counted once. */
function minutesWithin(intervals: readonly Interval[], fromMs: number, toMs: number): number {
  const clipped = intervals
    .map((i) => ({ shiftId: i.shiftId, startMs: Math.max(i.startMs, fromMs), endMs: Math.min(i.endMs, toMs) }))
    .filter((i) => i.endMs > i.startMs);
  return coveredMinutes(clipped);
}

/** "19:00–23:00 on 2026-10-20", or "from 2026-10-20 19:00 to 2026-10-21 04:59" when it runs past local midnight. */
function span(startMs: number, endMs: number, off: number): string {
  const d1 = localDateOf(startMs, off);
  return d1 === localDateOf(endMs - 1, off) ? `${hhmm(startMs, off)}–${hhmm(endMs, off)} on ${d1}` : `from ${d1} ${hhmm(startMs, off)} to ${localDateOf(endMs, off)} ${hhmm(endMs, off)}`;
}

/** "07:00 to 19:00", or "2026-10-20 19:00 to 2026-10-21 05:00" when it runs past local midnight. */
function fromTo(startMs: number, endMs: number, off: number): string {
  const d1 = localDateOf(startMs, off);
  return d1 === localDateOf(endMs - 1, off) ? `${hhmm(startMs, off)} to ${hhmm(endMs, off)}` : `${d1} ${hhmm(startMs, off)} to ${localDateOf(endMs, off)} ${hhmm(endMs, off)}`;
}

/** What a week's check reads: the branch's shifts touching the week, the people on them and every shift they hold. */
interface WeekScope {
  readonly weekEnd: string;
  readonly weekStartMs: number;
  readonly weekEndMs: number;
  /** The branch's shifts with any minute in the week, readable or not (an unreadable one whose start is in the week). */
  readonly branchShifts: readonly ShiftRequirement[];
  /** Everybody assigned to one of those shifts — active or not (NEW-3: a deactivated person is still checked). */
  readonly people: readonly string[];
}

function weekScope(input: {
  readonly settings: WorkingTimeSettings;
  readonly branchId: string;
  readonly weekStart: string;
  readonly shifts: readonly ShiftRequirement[];
  readonly assignments: readonly ShiftAssignment[];
}): WeekScope {
  if (!isDate(input.weekStart)) throw new RangeError(`weekStart must be YYYY-MM-DD, got "${input.weekStart}"`);
  const off = input.settings.utcOffsetMinutes;
  const weekEnd = addDays(input.weekStart, 6);
  const weekStartMs = localMidnightMs(input.weekStart, off);
  const weekEndMs = weekStartMs + 7 * DAY_MS;
  const touchesWeek = (s: ShiftRequirement): boolean => {
    const t = readableTimes(s);
    if (t !== undefined) return t.startMs < weekEndMs && t.endMs > weekStartMs;
    const a = Date.parse(s.startsAt);
    return Number.isNaN(a) ? true : a >= weekStartMs - DAY_MS && a < weekEndMs;
  };
  const branchShifts = input.shifts.filter((s) => s.branchId === input.branchId && touchesWeek(s));
  const ids = new Set(branchShifts.map((s) => s.shiftId));
  const people = [...new Set(input.assignments.filter((a) => ids.has(a.shiftId)).map((a) => a.employeeId))].sort();
  return { weekEnd, weekStartMs, weekEndMs, branchShifts, people };
}

/**
 * Check one branch's week of roster against every working-time limit in force.
 *
 * The people checked are everybody assigned to a shift of `branchId` with any minute in the week (store-local) —
 * including a person marked inactive, so deactivating somebody never hides their shifts from the check. Their hours
 * count EVERY shift they hold, at any branch — the limits are on the person, not the shop.
 *
 * Work is judged as one timeline, not day by day (verifier lanes34 NEW-1):
 *   • shifts that touch, or are separated by less than the shortest rest interval, are ONE stretch of work — even
 *     across local midnight — for the continuous-work and the spread-over rules; a stretch is dated by the local day
 *     it starts on, and a stretch that started the day before the week and runs into it is judged too;
 *   • daily hours count the minutes that fall on each local calendar day (IST), split at local midnight;
 *   • a day counts as a weekly holiday only when NO minute of work falls on it (NEW-2) — the tail of an overnight shift
 *     is work on the day it runs into — and a shift from the previous week running into this one counts.
 * A shift whose times cannot be read is itself a breach (never skipped silently), at any branch for a person checked.
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
  const scope = weekScope(input);
  const { weekEnd, weekStartMs, weekEndMs } = scope;
  const off = input.settings.utcOffsetMinutes;
  const days = datesBetween(input.weekStart, weekEnd);
  const pending = limitStatuses(input.settings).filter((s) => ROSTER_LIMIT_KEYS.includes(s.key) && s.status === 'pending');
  const limit = (k: WorkingTimeLimitKey): number | undefined => limitInForce(input.settings, k);
  const employeeById = new Map(input.employees.map((e) => [e.employeeId, e]));
  const nameOf = (id: string): string => {
    const e = employeeById.get(id);
    return e === undefined ? id : e.active ? e.name : `${e.name} (marked inactive)`;
  };
  const shiftById = new Map(input.shifts.map((s) => [s.shiftId, s]));
  const breaches: WorkingTimeBreach[] = [];

  // Unreadable shifts: this branch's shifts near the week, and any shift a person checked holds near the week.
  const near = (s: ShiftRequirement): boolean => {
    const a = Date.parse(s.startsAt);
    return Number.isNaN(a) ? true : a >= weekStartMs - DAY_MS && a < weekEndMs;
  };
  const checked = new Set(scope.people);
  const flagged = new Set<string>();
  for (const a of input.assignments) {
    const s = shiftById.get(a.shiftId);
    if (s === undefined || readableTimes(s) !== undefined || !near(s)) continue;
    if (s.branchId !== input.branchId && !checked.has(a.employeeId)) continue;
    const k = `${s.shiftId}|${a.employeeId}`;
    if (flagged.has(k)) continue;
    flagged.add(k);
    breaches.push({
      employeeId: a.employeeId, name: nameOf(a.employeeId), rule: 'unreadable_shift', observed: 0, limit: 0, shiftIds: [s.shiftId],
      detail: `Shift ${s.shiftId} has times that cannot be checked (starts "${s.startsAt}", ends "${s.endsAt}") — fix the shift times before publishing`,
    });
  }

  const rest = limit('minRestIntervalMinutes');
  const continuous = limit('maxContinuousWorkMinutes');
  const daily = limit('maxDailyWorkMinutes');
  const spread = limit('maxSpreadOverMinutes');
  const weekly = limit('maxWeeklyWorkMinutes');
  const holiday = limit('weeklyHolidayMinDays');

  for (const employeeId of scope.people) {
    const name = nameOf(employeeId);
    // Every readable shift the person holds, at any branch — one entry per shift (two roles on one shift is one stretch).
    const mine = new Map<string, Interval>();
    for (const a of input.assignments) {
      if (a.employeeId !== employeeId || mine.has(a.shiftId)) continue;
      const s = shiftById.get(a.shiftId);
      const t = s === undefined ? undefined : readableTimes(s);
      if (t !== undefined) mine.set(a.shiftId, { shiftId: a.shiftId, ...t });
    }
    const all = [...mine.values()];
    // Stretches over the person's whole timeline: touching, or a gap shorter than the rest interval, is one stretch.
    const stretches = blocks(all, rest === undefined ? 1 : rest * 60_000)
      .filter((b) => b.startMs < weekEndMs && b.endMs > weekStartMs);
    const inWeek = all.filter((i) => i.startMs < weekEndMs && i.endMs > weekStartMs);

    let weekMinutes = 0;
    const daysOff: string[] = [];
    for (const d of days) {
      const from = localMidnightMs(d, off);
      const worked = minutesWithin(all, from, from + DAY_MS);
      weekMinutes += worked;
      if (worked === 0) { daysOff.push(d); continue; }
      if (daily !== undefined && worked > daily) {
        const ids = all.filter((i) => i.startMs < from + DAY_MS && i.endMs > from).map((i) => i.shiftId).sort();
        breaches.push({ employeeId, name, rule: 'maxDailyWorkMinutes', date: d, observed: worked, limit: daily, shiftIds: ids,
          detail: `${name} is rostered ${asHours(worked)} on ${d} — more than the daily cap of ${asHours(daily)}` });
      }
    }

    // Spread-over: the stretches that START on a day, from the first start to the last finish (a stretch running past
    // midnight is not cut there). The day before the week counts when one of its stretches runs into the week.
    if (spread !== undefined) {
      const byStartDay = new Map<string, { startMs: number; endMs: number; shiftIds: string[] }[]>();
      for (const b of stretches) {
        const d = localDateOf(b.startMs, off);
        byStartDay.set(d, [...(byStartDay.get(d) ?? []), b]);
      }
      // A day's earlier stretches that ended before the week are still part of that day's spread.
      for (const b of blocks(all, rest === undefined ? 1 : rest * 60_000)) {
        const d = localDateOf(b.startMs, off);
        const list = byStartDay.get(d);
        if (list !== undefined && !list.some((x) => x.startMs === b.startMs)) list.push(b);
      }
      for (const [d, list] of [...byStartDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const first = Math.min(...list.map((b) => b.startMs));
        const last = Math.max(...list.map((b) => b.endMs));
        const spanMinutes = Math.round((last - first) / 60_000);
        if (spanMinutes > spread) {
          breaches.push({ employeeId, name, rule: 'maxSpreadOverMinutes', date: d, observed: spanMinutes, limit: spread, shiftIds: list.flatMap((b) => b.shiftIds).sort(),
            detail: `${name}'s day on ${d} spreads from ${fromTo(first, last, off)} (${asHours(spanMinutes)}) — longer than the spread-over limit of ${asHours(spread)}` });
        }
      }
    }

    if (continuous !== undefined && rest !== undefined) {
      for (const b of stretches) {
        const stretch = Math.round((b.endMs - b.startMs) / 60_000);
        if (stretch > continuous) {
          breaches.push({ employeeId, name, rule: 'maxContinuousWorkMinutes', date: localDateOf(b.startMs, off), observed: stretch, limit: continuous, shiftIds: [...b.shiftIds].sort(),
            detail: `${name} works ${span(b.startMs, b.endMs, off)} (${asHours(stretch)}) with no rest of at least ${asHours(rest)} — longer than the ${asHours(continuous)} allowed before a rest interval` });
        }
      }
    }

    const allIds = inWeek.map((i) => i.shiftId).sort();
    if (weekly !== undefined && weekMinutes > weekly) {
      breaches.push({ employeeId, name, rule: 'maxWeeklyWorkMinutes', observed: weekMinutes, limit: weekly, shiftIds: allIds,
        detail: `${name} is rostered ${asHours(weekMinutes)} in the week of ${input.weekStart} — more than the weekly cap of ${asHours(weekly)}` });
    }
    if (holiday !== undefined && daysOff.length < holiday) {
      breaches.push({ employeeId, name, rule: 'weeklyHolidayMinDays', observed: daysOff.length, limit: holiday, shiftIds: allIds,
        detail: `${name} has ${daysOff.length} day(s) off in the week of ${input.weekStart} — the weekly holiday needs at least ${holiday}` });
    }
  }

  return {
    weekStart: input.weekStart, weekEnd, pending, notChecked: rosterLimitsNotChecked(input.settings),
    breaches: breaches.sort((a, b) => a.employeeId.localeCompare(b.employeeId) || (a.date ?? '').localeCompare(b.date ?? '') || a.rule.localeCompare(b.rule)),
    employeesChecked: scope.people.length,
    shiftsChecked: scope.branchShifts.length,
  };
}

/**
 * The exact roster a week's check depends on, in a canonical text form (OB-166): the branch's shifts touching the
 * week; the people on them (their staff records, active or not); every shift those people hold from a week before to
 * a week after, at any branch; and the assignments to all of those shifts. A publication records a digest of this, so
 * ANY later change to what was checked — a shift moved, a person added, a record deactivated — leaves the week
 * "needs publishing" until it is checked and published again.
 */
export function rosterWeekBasis(input: {
  readonly settings: WorkingTimeSettings;
  readonly branchId: string;
  readonly weekStart: string;
  readonly shifts: readonly ShiftRequirement[];
  readonly assignments: readonly ShiftAssignment[];
  readonly employees: readonly Employee[];
}): string {
  const scope = weekScope(input);
  const people = new Set(scope.people);
  const lo = scope.weekStartMs - 7 * DAY_MS;
  const hi = scope.weekEndMs + 7 * DAY_MS;
  const shiftById = new Map(input.shifts.map((s) => [s.shiftId, s]));
  const ids = new Set(scope.branchShifts.map((s) => s.shiftId));
  for (const a of input.assignments) {
    if (!people.has(a.employeeId)) continue;
    const s = shiftById.get(a.shiftId);
    if (s === undefined) continue;
    const t = readableTimes(s);
    const startMs = Date.parse(s.startsAt);
    if (t !== undefined ? t.startMs < hi && t.endMs > lo : Number.isNaN(startMs) || (startMs >= lo && startMs < hi)) ids.add(s.shiftId);
  }
  const shifts = [...ids].sort().map((id) => {
    const s = shiftById.get(id)!;
    return [s.shiftId, s.branchId, s.startsAt, s.endsAt, [...s.requiredRoles].map((r) => [r.role, r.count]).sort()];
  });
  const assignments = input.assignments.filter((a) => ids.has(a.shiftId))
    .map((a) => [a.shiftId, a.employeeId, a.role]).sort((x, y) => x.join('\u0000').localeCompare(y.join('\u0000')));
  const employees = [...people].sort().map((id) => {
    const e = input.employees.find((x) => x.employeeId === id);
    return e === undefined ? [id, null] : [id, e.name, e.branchId, e.active];
  });
  return JSON.stringify({ v: 1, branchId: input.branchId, weekStart: input.weekStart, utcOffsetMinutes: input.settings.utcOffsetMinutes, shifts, assignments, employees });
}

/** Whether a shift's local start day falls in the week [weekStart, weekStart + 6]. */
export function shiftStartsInWeek(shift: ShiftRequirement, weekStart: string, utcOffsetMinutes: number): boolean {
  const ms = Date.parse(shift.startsAt);
  if (Number.isNaN(ms)) return false;
  const d = localDateOf(ms, utcOffsetMinutes);
  return d >= weekStart && d <= addDays(weekStart, 6);
}

// ── Leave ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The leave types beside annual leave (OB-156). Each is a setting: days a year and a carry-over rule, from the CA. */
export type LeaveTypeKey = 'casual' | 'sick' | 'festival' | 'unpaid';
export const LEAVE_TYPE_KEYS: readonly LeaveTypeKey[] = Object.freeze(['casual', 'sick', 'festival', 'unpaid']);
/** Annual leave (earned from days worked) and the configurable types. */
export type LeaveKind = 'annual' | LeaveTypeKey;
export const LEAVE_KINDS: readonly LeaveKind[] = Object.freeze(['annual', ...LEAVE_TYPE_KEYS]);

export const LEAVE_TYPES: Readonly<Record<LeaveTypeKey, { readonly label: string }>> = Object.freeze({
  casual: { label: 'Casual leave' },
  sick: { label: 'Sick leave' },
  festival: { label: 'Festival leave' },
  unpaid: { label: 'Unpaid leave' },
});

/** The most days a leave setting may hold. */
const MAX_LEAVE_DAYS = 366;

/** One leave type as the owner set it. In force only when all four parts are present. */
export interface LeaveTypeSetting {
  /** Days of this leave a person may take in a leave year (a whole number, 0 for none); null while not filled in. */
  readonly daysPerYear: number | null;
  /** The most unused days carried into the next leave year (0 = nothing carries over); null while not filled in. */
  readonly carryOverMaxDays: number | null;
  /** The provision of the Act (or the rule) the values come from. */
  readonly source: string | null;
  /** Who confirmed the values — the owner or the CA — with a reference. */
  readonly confirmation: string | null;
}

export const EMPTY_LEAVE_TYPE: LeaveTypeSetting = Object.freeze({ daysPerYear: null, carryOverMaxDays: null, source: null, confirmation: null });

/** A whole number of days a leave setting can hold: 0 up to 366. */
export function leaveDaysValueIsValid(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_LEAVE_DAYS;
}

export interface LeaveTypeStatus {
  readonly key: LeaveTypeKey;
  readonly label: string;
  /** `pending` = shown as NOT CHECKED: leave of this type is recorded but no balance is enforced. */
  readonly status: 'in_force' | 'pending';
  readonly daysPerYear: number | null;
  readonly carryOverMaxDays: number | null;
  readonly missing?: string;
}

/** Every configurable leave type and whether it is checked — a pending one says what it still needs. */
export function leaveTypeStatuses(settings: WorkingTimeSettings): readonly LeaveTypeStatus[] {
  return LEAVE_TYPE_KEYS.map((key) => {
    const s = settings.leaveTypes[key];
    const gaps: string[] = [];
    if (!leaveDaysValueIsValid(s.daysPerYear)) gaps.push('the days a year');
    if (!leaveDaysValueIsValid(s.carryOverMaxDays)) gaps.push('the carry-over rule');
    if (!filled(s.source)) gaps.push('the provision of the Act it comes from');
    if (!filled(s.confirmation)) gaps.push('who confirmed it (owner or CA)');
    const base = { key, label: LEAVE_TYPES[key].label, daysPerYear: s.daysPerYear, carryOverMaxDays: s.carryOverMaxDays };
    return gaps.length === 0 ? { ...base, status: 'in_force' as const } : { ...base, status: 'pending' as const, missing: `needs ${gaps.join(', ')}` };
  });
}

/** One day of leave taken — or a compensating cancellation of an earlier one (hard rule #2). */
export interface LeaveRecord {
  readonly employeeId: string;
  readonly date: string;
  readonly kind: 'taken' | 'cancelled';
  /** Which leave. Absent on a record made before OB-156 — those are annual leave. */
  readonly leaveType?: LeaveKind;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly note?: string;
}

/** The leave standing on each (employee, date): the latest record there, when it is `taken`. */
export function standingLeave(records: readonly LeaveRecord[]): ReadonlyMap<string, LeaveRecord> {
  const latest = new Map<string, LeaveRecord>();
  for (const r of records) latest.set(`${r.employeeId}|${r.date}`, r);
  return new Map([...latest].filter(([, r]) => r.kind === 'taken'));
}

/** The type of a leave record (annual when the record predates OB-156). */
export const leaveKindOf = (r: LeaveRecord): LeaveKind => r.leaveType ?? 'annual';

/** The days of one type of leave still standing, per employee, sorted. Annual leave by default. */
export function leaveDaysTaken(records: readonly LeaveRecord[], type: LeaveKind = 'annual'): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const r of standingLeave(records).values()) {
    if (leaveKindOf(r) !== type) continue;
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

export interface LeaveTypeBalance {
  readonly type: LeaveTypeKey;
  readonly label: string;
  /** `not_checked` while the type's settings are pending — the days are counted, no limit is applied. */
  readonly check: 'checked' | 'not_checked';
  /** The leave year (taken as the calendar year — pending the CA's confirmation). */
  readonly year: number;
  readonly taken: number;
  readonly takenDates: readonly string[];
  /** Days a year + days carried in; null while not checked. */
  readonly entitlement: number | null;
  readonly carriedIn: number | null;
  /** entitlement − taken; null while not checked. */
  readonly balance: number | null;
  readonly missing?: string;
}

/**
 * One configurable leave type for one person and one leave year: the days taken that year and, once the type is in
 * force, the entitlement — the days a year plus what carried over (the unused days of the year before, up to the
 * carry-over limit, chained from the first year the person took that leave).
 */
export function leaveTypeBalance(input: {
  readonly settings: WorkingTimeSettings;
  readonly type: LeaveTypeKey;
  readonly employeeId: string;
  readonly year: number;
  readonly records: readonly LeaveRecord[];
}): LeaveTypeBalance {
  const dates = leaveDaysTaken(input.records, input.type).get(input.employeeId) ?? [];
  const inYear = (y: number): string[] => dates.filter((d) => Number(d.slice(0, 4)) === y);
  const takenDates = inYear(input.year);
  const status = leaveTypeStatuses(input.settings).find((s) => s.key === input.type)!;
  const base = { type: input.type, label: status.label, year: input.year, taken: takenDates.length, takenDates };
  if (status.status === 'pending') {
    return { ...base, check: 'not_checked', entitlement: null, carriedIn: null, balance: null, missing: status.missing! };
  }
  const perYear = status.daysPerYear!;
  const carryMax = status.carryOverMaxDays!;
  const firstYear = Math.min(input.year, ...dates.map((d) => Number(d.slice(0, 4))));
  let carried = 0;
  for (let y = firstYear; y < input.year; y += 1) carried = Math.min(carryMax, Math.max(0, perYear + carried - inYear(y).length));
  const entitlement = perYear + carried;
  return { ...base, check: 'checked', entitlement, carriedIn: carried, balance: entitlement - takenDates.length };
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
  /** Which leave, when the status is `leave`. */
  readonly leaveType?: LeaveKind;
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
  // Any type of leave standing on the day (OB-156), annual or configurable.
  const leave = standingLeave(input.leave);
  return [...input.employees].sort((a, b) => a.employeeId.localeCompare(b.employeeId)).map((e) => {
    const rows = days.map((date): AttendanceRegisterDay => {
      const rostered = rosteredOn(e.employeeId, date, input.shifts, input.assignments, off);
      const h = hours.get(`${e.employeeId}|${date}`);
      const onLeave = leave.get(`${e.employeeId}|${date}`);
      const status: AttendanceDayStatus = h !== undefined && h > 0 ? 'present'
        : onLeave !== undefined ? 'leave'
          : h !== undefined ? 'absent'
            : rostered.length > 0 ? 'not_recorded' : 'off';
      return { date, rostered, hoursRecorded: h ?? null, status, ...(status === 'leave' && onLeave !== undefined ? { leaveType: leaveKindOf(onLeave) } : {}) };
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
  // A day is worked when hours are recorded on it, or any minute of a rostered shift falls on it — the tail of an
  // overnight shift is work on the day it runs into (verifier lanes34 NEW-2).
  const shiftById = new Map(input.shifts.map((s) => [s.shiftId, s]));
  const worked = (employeeId: string, date: string): boolean => {
    if (input.attendance.some((a) => a.employeeId === employeeId && a.date === date && a.hours > 0)) return true;
    const from = localMidnightMs(date, off);
    return input.assignments.some((a) => {
      if (a.employeeId !== employeeId) return false;
      const s = shiftById.get(a.shiftId);
      const t = s === undefined ? undefined : readableTimes(s);
      return t === undefined ? s !== undefined && rosteredOn(employeeId, date, [s], [a], off).length > 0 : t.startMs < from + DAY_MS && t.endMs > from;
    });
  };
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
