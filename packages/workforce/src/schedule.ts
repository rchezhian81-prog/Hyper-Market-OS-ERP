// D-9 (R3, OB-142 "A") — a DRAFT roster that meets the forecast staff need within the working-time limits already built
// in R2 (`working-time.ts`, the C18 pack). Pure and deterministic.
//
// Signed sentence (part): "A draft roster meeting it within labour-law limits (max daily and weekly hours, spread-over,
// weekly holiday) that a manager commits (P-05). Each uncovered slot or rule breach is listed by name. Actual attendance
// versus the roster is reported." OB-142: labour cost is REPORTED, never capped.
//
// How the draft is built:
//   • SHIFTS from the need: for each day and role, the hours needing at least 1 person form the first shift(s), the hours
//     needing at least 2 the second, and so on — each a contiguous block of hours for ONE person of that role;
//   • a block longer than a limit IN FORCE (the daily hours cap, the continuous-work cap, the spread-over) is cut into
//     pieces no longer than the strictest of them. A limit still PENDING (no value, provision or confirmation yet) is never
//     guessed: it is not applied, and the draft names it in `notChecked`, exactly as the R2 roster check does (OB-155);
//   • PEOPLE are given shifts in time order: an active person of the store who holds the role, and for whom the shift
//     keeps every limit in force — the day's hours, the week's hours (with what they already work this week, at any store)
//     and the weekly holiday (whole days off). One shift per person per day. Among those who can, the person with the
//     fewest hours this week first (spread the work), then by id;
//   • a shift nobody can take is an UNCOVERED SLOT, listed by name — the day, the hours, the role and why;
//   • the whole draft is then put through the R2 check (`checkWorkingTime`) with the rest of the roster, and any breach it
//     finds is listed by name too (P-08);
//   • COST is reported per person (hours × their hourly rate), and a person with no rate on file is named, never costed
//     at zero. Nothing is capped by cost.

import type { Employee, ShiftAssignment, ShiftRequirement } from './workforce';
import { checkWorkingTime, limitInForce, rosterLimitsNotChecked, addDays, localDateOf, type WorkingTimeSettings, type WorkingTimeBreach, type LimitNotChecked } from './working-time';
import type { DemandSlot } from './labour-demand';

export interface DraftShift extends ShiftRequirement {
  readonly date: string;
  readonly role: string;
  readonly startHour: number;
  readonly endHour: number;
}

export interface UncoveredSlot {
  readonly shiftId: string;
  readonly date: string;
  readonly role: string;
  readonly from: string;
  readonly to: string;
  readonly reason: 'no_one_with_the_role' | 'everyone_at_a_limit';
  readonly detail: string;
}

export interface DraftCostLine { readonly employeeId: string; readonly name: string; readonly minutes: number; readonly hourlyRateMinor: number | null; readonly costMinor: number | null }

export interface DraftRoster {
  readonly branchId: string;
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly shifts: readonly DraftShift[];
  readonly assignments: readonly ShiftAssignment[];
  readonly uncovered: readonly UncoveredSlot[];
  readonly breaches: readonly WorkingTimeBreach[];
  readonly notChecked: readonly LimitNotChecked[];
  readonly cost: { readonly lines: readonly DraftCostLine[]; readonly knownMinor: number; readonly notCostedPeople: readonly string[]; readonly capped: false };
  readonly staffHoursNeeded: number;
  readonly staffHoursRostered: number;
}

const two = (n: number): string => String(n).padStart(2, '0');
const isoOf = (date: string, hour: number, off: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + hour * 3_600_000 - off * 60_000).toISOString();

export function draftRoster(input: {
  readonly branchId: string;
  readonly weekStart: string;
  readonly settings: WorkingTimeSettings;
  readonly slots: readonly DemandSlot[];
  readonly employees: readonly Employee[];
  /** The roster as stored (every store), so a person's other shifts count against their limits. */
  readonly existing: { readonly shifts: readonly ShiftRequirement[]; readonly assignments: readonly ShiftAssignment[] };
  /** The id prefix for the draft's shifts. */
  readonly idPrefix: string;
}): DraftRoster {
  const off = input.settings.utcOffsetMinutes;
  const weekEnd = addDays(input.weekStart, 6);
  const daily = limitInForce(input.settings, 'maxDailyWorkMinutes');
  const weekly = limitInForce(input.settings, 'maxWeeklyWorkMinutes');
  const spread = limitInForce(input.settings, 'maxSpreadOverMinutes');
  const continuous = limitInForce(input.settings, 'maxContinuousWorkMinutes');
  const holidays = limitInForce(input.settings, 'weeklyHolidayMinDays');
  const cutHours = Math.max(1, Math.floor(Math.min(daily ?? Infinity, spread ?? Infinity, continuous ?? Infinity) / 60));

  // ── shifts from the need ─────────────────────────────────────────────────────────────────────────────────────
  const shifts: DraftShift[] = [];
  const byDayRole = new Map<string, Map<number, number>>();
  for (const s of input.slots) {
    const k = `${s.date}|${s.role}`;
    const m = byDayRole.get(k) ?? new Map<number, number>();
    m.set(s.hour, Math.max(m.get(s.hour) ?? 0, s.staffNeeded));
    byDayRole.set(k, m);
  }
  for (const [k, need] of [...byDayRole].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [date, role] = k.split('|') as [string, string];
    const most = Math.max(...need.values());
    for (let lane = 1; lane <= most; lane++) {
      let h = 0;
      while (h < 24) {
        if ((need.get(h) ?? 0) < lane) { h++; continue; }
        let end = h;
        while (end < 24 && (need.get(end) ?? 0) >= lane) end++;
        for (let a = h; a < end; a += Number.isFinite(cutHours) ? cutHours : end - h) {
          const b = Math.min(end, Number.isFinite(cutHours) ? a + cutHours : end);
          const shiftId = `${input.idPrefix}-${date}-${role}-${lane}-${two(a)}`;
          shifts.push({ shiftId, branchId: input.branchId, startsAt: isoOf(date, a, off), endsAt: isoOf(date, b, off), requiredRoles: [{ role, count: 1 }], date, role, startHour: a, endHour: b });
        }
        h = end;
      }
    }
  }
  shifts.sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : a.shiftId < b.shiftId ? -1 : 1));

  // ── what each person already works this week, at any store ───────────────────────────────────────────────────
  const minutesOf = (s: ShiftRequirement): number => Math.max(0, Math.round((Date.parse(s.endsAt) - Date.parse(s.startsAt)) / 60_000));
  const dayOf = (s: ShiftRequirement): string => localDateOf(Date.parse(s.startsAt), off);
  const existingById = new Map(input.existing.shifts.map((s) => [s.shiftId, s] as const));
  const week = new Map<string, number>(); const days = new Map<string, Map<string, number>>();
  const book = (employeeId: string, s: ShiftRequirement): void => {
    const d = dayOf(s);
    if (d < input.weekStart || d > weekEnd) return;
    week.set(employeeId, (week.get(employeeId) ?? 0) + minutesOf(s));
    const m = days.get(employeeId) ?? new Map<string, number>();
    m.set(d, (m.get(d) ?? 0) + minutesOf(s));
    days.set(employeeId, m);
  };
  for (const a of input.existing.assignments) { const s = existingById.get(a.shiftId); if (s !== undefined) book(a.employeeId, s); }

  // ── people to shifts ─────────────────────────────────────────────────────────────────────────────────────────
  const staff = input.employees.filter((e) => e.active && e.branchId === input.branchId);
  const assignments: ShiftAssignment[] = [];
  const uncovered: UncoveredSlot[] = [];
  for (const s of shifts) {
    const withRole = staff.filter((e) => e.roles.includes(s.role));
    const mins = minutesOf(s);
    const can = withRole.filter((e) => {
      const myDays = days.get(e.employeeId) ?? new Map<string, number>();
      if ((myDays.get(s.date) ?? 0) > 0) return false; // one shift a day
      if (daily !== undefined && mins > daily) return false;
      if (spread !== undefined && mins > spread) return false;
      if (weekly !== undefined && (week.get(e.employeeId) ?? 0) + mins > weekly) return false;
      if (holidays !== undefined && myDays.size + 1 > 7 - holidays) return false;
      return true;
    }).sort((a, b) => (week.get(a.employeeId) ?? 0) - (week.get(b.employeeId) ?? 0) || (a.employeeId < b.employeeId ? -1 : 1));
    const who = can[0];
    if (who === undefined) {
      const reason = withRole.length === 0 ? 'no_one_with_the_role' as const : 'everyone_at_a_limit' as const;
      uncovered.push({
        shiftId: s.shiftId, date: s.date, role: s.role, from: `${two(s.startHour)}:00`, to: `${two(s.endHour)}:00`, reason,
        detail: `${s.date} ${two(s.startHour)}:00–${two(s.endHour)}:00 needs one more ${s.role}: ${reason === 'no_one_with_the_role' ? `nobody at ${input.branchId} holds the ${s.role} role` : `every ${s.role} at ${input.branchId} is already working that day or would go past a working-time limit`}.`,
      });
      continue;
    }
    assignments.push({ shiftId: s.shiftId, employeeId: who.employeeId, role: s.role });
    book(who.employeeId, s);
  }

  // ── the R2 check over the draft and the rest of the roster ───────────────────────────────────────────────────
  const covered = new Set(assignments.map((a) => a.shiftId));
  const kept = shifts.filter((s) => covered.has(s.shiftId));
  const check = checkWorkingTime({
    settings: input.settings, branchId: input.branchId, weekStart: input.weekStart,
    shifts: [...input.existing.shifts, ...kept], assignments: [...input.existing.assignments, ...assignments], employees: input.employees,
  });

  // ── cost: reported, never capped ─────────────────────────────────────────────────────────────────────────────
  const minutesBy = new Map<string, number>();
  for (const a of assignments) { const s = kept.find((x) => x.shiftId === a.shiftId)!; minutesBy.set(a.employeeId, (minutesBy.get(a.employeeId) ?? 0) + minutesOf(s)); }
  const lines: DraftCostLine[] = [...minutesBy].sort(([a], [b]) => (a < b ? -1 : 1)).map(([employeeId, minutes]) => {
    const e = input.employees.find((x) => x.employeeId === employeeId)!;
    const rate = e.hourlyRateMinor ?? null;
    return { employeeId, name: e.name, minutes, hourlyRateMinor: rate, costMinor: rate === null ? null : Math.round((rate * minutes) / 60) };
  });
  return {
    branchId: input.branchId, weekStart: input.weekStart, weekEnd,
    shifts: kept, assignments, uncovered, breaches: check.breaches,
    notChecked: rosterLimitsNotChecked(input.settings),
    cost: { lines, knownMinor: lines.reduce((n, l) => n + (l.costMinor ?? 0), 0), notCostedPeople: lines.filter((l) => l.costMinor === null).map((l) => l.employeeId), capped: false },
    staffHoursNeeded: input.slots.reduce((n, s) => n + s.staffNeeded, 0),
    staffHoursRostered: [...minutesBy.values()].reduce((n, m) => n + m, 0) / 60,
  };
}

// ── actual attendance against the roster ─────────────────────────────────────────────────────────────────────────

export type ActualStatus = 'as_rostered' | 'short' | 'over' | 'absent' | 'not_recorded' | 'worked_unrostered';
export interface ActualVsRoster {
  readonly employeeId: string;
  readonly date: string;
  readonly rosteredMinutes: number;
  readonly actualMinutes: number | null;
  readonly differenceMinutes: number | null;
  readonly status: ActualStatus;
  readonly source: 'attendance_marks' | 'hours_recorded' | 'none';
}

/**
 * Per person per day of the week: what the roster gave them, against what they actually worked — from their clock-in /
 * clock-out marks (C21: by fingerprint or PIN, the same), else the hours recorded for the day, else NOT RECORDED (said,
 * never zero). A day with marks or hours but no rostered shift is `worked_unrostered`.
 */
export function actualAgainstRoster(input: {
  readonly weekStart: string;
  readonly utcOffsetMinutes: number;
  readonly rostered: readonly { readonly employeeId: string; readonly shift: ShiftRequirement }[];
  readonly marks: readonly { readonly employeeId: string; readonly kind: 'in' | 'out'; readonly at: string }[];
  readonly hours: readonly { readonly employeeId: string; readonly date: string; readonly hours: number }[];
}): readonly ActualVsRoster[] {
  const off = input.utcOffsetMinutes;
  const weekEnd = addDays(input.weekStart, 6);
  const rost = new Map<string, number>();
  for (const r of input.rostered) {
    const d = localDateOf(Date.parse(r.shift.startsAt), off);
    if (d < input.weekStart || d > weekEnd) continue;
    const k = `${r.employeeId}|${d}`;
    rost.set(k, (rost.get(k) ?? 0) + Math.round((Date.parse(r.shift.endsAt) - Date.parse(r.shift.startsAt)) / 60_000));
  }
  const marked = new Map<string, number>();
  const byPersonDay = new Map<string, { kind: 'in' | 'out'; ms: number }[]>();
  for (const m of input.marks) {
    const ms = Date.parse(m.at);
    const d = localDateOf(ms, off);
    if (d < input.weekStart || d > weekEnd) continue;
    const k = `${m.employeeId}|${d}`;
    byPersonDay.set(k, [...(byPersonDay.get(k) ?? []), { kind: m.kind, ms }]);
  }
  for (const [k, ms] of byPersonDay) {
    let total = 0; let open: number | null = null;
    for (const m of ms.sort((a, b) => a.ms - b.ms)) {
      if (m.kind === 'in') open = open ?? m.ms;
      else if (open !== null) { total += m.ms - open; open = null; }
    }
    marked.set(k, Math.round(total / 60_000));
  }
  const hrs = new Map<string, number>();
  for (const h of input.hours) if (h.date >= input.weekStart && h.date <= weekEnd) hrs.set(`${h.employeeId}|${h.date}`, Math.round(h.hours * 60));
  const keys = [...new Set([...rost.keys(), ...marked.keys(), ...hrs.keys()])].sort();
  return keys.map((k) => {
    const [employeeId, date] = k.split('|') as [string, string];
    const rosteredMinutes = rost.get(k) ?? 0;
    const source = marked.has(k) ? 'attendance_marks' as const : hrs.has(k) ? 'hours_recorded' as const : 'none' as const;
    const actual = marked.get(k) ?? hrs.get(k) ?? null;
    let status: ActualStatus;
    if (actual === null) status = 'not_recorded'; // nothing recorded is said, never read as absent or as zero
    else if (rosteredMinutes === 0) status = actual > 0 ? 'worked_unrostered' : 'as_rostered';
    else if (actual === 0) status = 'absent';
    else status = actual === rosteredMinutes ? 'as_rostered' : actual < rosteredMinutes ? 'short' : 'over';
    return { employeeId, date, rosteredMinutes, actualMinutes: actual, differenceMinutes: actual === null ? null : actual - rosteredMinutes, status, source };
  });
}
