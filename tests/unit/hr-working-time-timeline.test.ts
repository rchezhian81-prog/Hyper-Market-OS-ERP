import { describe, it, expect } from 'vitest';
import {
  UNSET_WORKING_TIME_SETTINGS, WORKING_TIME_LIMIT_KEYS, LEAVE_TYPE_KEYS,
  checkWorkingTime, rosterWeekBasis, rosterLimitsNotChecked, holidayRegister, attendanceRegister,
  leaveTypeStatuses, leaveTypeBalance, leaveDaysTaken,
  type WorkingTimeSettings, type WorkingTimeLimitKey, type Employee, type ShiftRequirement, type ShiftAssignment, type LeaveRecord,
} from '../../packages/workforce/src/index';

// R2 addendum C18, verifier lanes34 NEW-1 / NEW-2 and owner decisions OB-155, OB-156, OB-166 — engine level.
// SYNTHETIC limits only (no legal figure is in the engine or in these tests).

const SYNTHETIC: Readonly<Record<WorkingTimeLimitKey, number>> = {
  weeklyHolidayMinDays: 1, maxDailyWorkMinutes: 9 * 60, maxWeeklyWorkMinutes: 48 * 60, maxSpreadOverMinutes: 11 * 60,
  maxContinuousWorkMinutes: 5 * 60, minRestIntervalMinutes: 60, annualLeaveDaysWorkedPerDayEarned: 20,
};
const inForce = (over: Partial<Record<WorkingTimeLimitKey, number | null>> = {}): WorkingTimeSettings => ({
  ...UNSET_WORKING_TIME_SETTINGS,
  limits: Object.fromEntries(WORKING_TIME_LIMIT_KEYS.map((k) => {
    const v = k in over ? over[k]! : SYNTHETIC[k];
    return [k, { value: v, source: 'test fixture', confirmation: 'test fixture' }];
  })) as WorkingTimeSettings['limits'],
});
const emp = (id: string, active = true): Employee => ({ employeeId: id, name: `Person ${id}`, branchId: 'b1', roles: ['cashier'], active });
const at = (day: string, hhmm: string): string => new Date(Date.parse(`${day}T${hhmm}:00+05:30`)).toISOString();
const sh = (id: string, from: [string, string], to: [string, string], branchId = 'b1'): ShiftRequirement =>
  ({ shiftId: id, branchId, startsAt: at(...from), endsAt: at(...to), requiredRoles: [{ role: 'cashier', count: 1 }] });
const on = (shiftId: string, employeeId = 'E1'): ShiftAssignment => ({ shiftId, employeeId, role: 'cashier' });
const WEEK = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'];
const check = (shifts: ShiftRequirement[], settings = inForce(), employees = [emp('E1')], assignments = shifts.map((s) => on(s.shiftId))) =>
  checkWorkingTime({ settings, branchId: 'b1', weekStart: WEEK[0]!, shifts, assignments, employees });

describe('NEW-1: continuous work across local midnight is ONE stretch', () => {
  it('a 10-hour stretch split at midnight into two shifts is caught (it used to pass every check)', () => {
    const c = check([sh('A', [WEEK[1]!, '19:00'], [WEEK[1]!, '23:59']), sh('B', [WEEK[2]!, '00:00'], [WEEK[2]!, '04:59'])]);
    // OB-168: the stretch also counts in full against the daily cap — 4h 59m + 4h 59m worked = 9h 58m on the 20th.
    expect(c.breaches.map((b) => b.rule)).toEqual(['maxContinuousWorkMinutes', 'maxDailyWorkMinutes']);
    expect(c.breaches[0]).toMatchObject({ date: WEEK[1], observed: 599, limit: 300, shiftIds: ['A', 'B'] });
    expect(c.breaches[0]!.detail).toBe('Person E1 works from 2026-10-20 19:00 to 2026-10-21 04:59 (9h 59m) with no rest of at least 1h — longer than the 5h allowed before a rest interval');
    expect(c.breaches[1]).toMatchObject({ date: WEEK[1], observed: 598, limit: 540, shiftIds: ['A', 'B'] });
    expect(c.breaches[1]!.detail).toBe('Person E1 is rostered 9h 58m on 2026-10-20, counting work that runs past midnight to 2026-10-21 04:59 — more than the daily cap of 9h');
  });

  it('a gap of exactly the rest interval is a rest; a shorter gap is not', () => {
    const rested = check([sh('A', [WEEK[1]!, '20:00'], [WEEK[1]!, '23:00']), sh('B', [WEEK[2]!, '00:00'], [WEEK[2]!, '03:00'])]);
    expect(rested.breaches).toEqual([]);
    const short = check([sh('A', [WEEK[1]!, '20:00'], [WEEK[1]!, '23:00']), sh('B', [WEEK[1]!, '23:30'], [WEEK[2]!, '03:00'])]);
    expect(short.breaches.map((b) => b.rule)).toEqual(['maxContinuousWorkMinutes']);
  });

  it('OB-168: daily hours are judged per stretch of work, counted in full on the day it starts — not split at midnight', () => {
    // 12:00–17:00, then 18:00–23:00 and 23:00–02:00 touching (one stretch 18:00–02:00): both stretches start on the
    // 20th, so the 20th carries 5h + 8h = 13h (it was 11h + 2h when split at midnight); nothing is put on the 21st.
    const c = check([sh('A', [WEEK[1]!, '12:00'], [WEEK[1]!, '17:00']), sh('B', [WEEK[1]!, '18:00'], [WEEK[1]!, '23:00']), sh('C', [WEEK[1]!, '23:00'], [WEEK[2]!, '02:00'])],
      inForce({ maxContinuousWorkMinutes: 24 * 60, maxSpreadOverMinutes: 24 * 60 }));
    expect(c.breaches.map((b) => `${b.rule}@${b.date}:${b.observed}`)).toEqual(['maxDailyWorkMinutes@2026-10-20:780']);
    expect(c.breaches[0]!.shiftIds).toEqual(['A', 'B', 'C']);
    expect(c.breaches[0]!.detail).toBe('Person E1 is rostered 13h on 2026-10-20, counting work that runs past midnight to 2026-10-21 02:00 — more than the daily cap of 9h');
    // One overnight shift of 10 hours is 10 hours against the daily cap (it used to count 5h on each local day).
    const night = check([sh('N', [WEEK[1]!, '19:00'], [WEEK[2]!, '05:00'])]);
    expect(night.breaches.map((b) => `${b.rule}@${b.date}:${b.observed}`)).toEqual(['maxContinuousWorkMinutes@2026-10-20:600', 'maxDailyWorkMinutes@2026-10-20:600']);
    expect(night.breaches[1]).toMatchObject({ limit: 540, shiftIds: ['N'] });
    // A 9-hour night shift is exactly at the cap: no daily breach (the cap is "more than", as before).
    const atCap = check([sh('N', [WEEK[1]!, '20:00'], [WEEK[2]!, '05:00'])], inForce({ maxContinuousWorkMinutes: 24 * 60 }));
    expect(atCap.breaches).toEqual([]);
  });

  it('OB-168: a night stretch that started the day before the week is judged in full on that day', () => {
    const c = check([sh('PREV', ['2026-10-18', '20:00'], [WEEK[0]!, '06:00'])], inForce({ maxContinuousWorkMinutes: 24 * 60 }));
    expect(c.breaches.map((b) => `${b.rule}@${b.date}:${b.observed}`)).toEqual(['maxDailyWorkMinutes@2026-10-18:600']);
  });

  it('OB-168: the weekly hours cap still counts the minutes inside the week, split at midnight', () => {
    // 2026-10-18 20:00 → 19 Oct 06:00: only 6h fall inside the week; a weekly cap of 5h is breached by exactly 6h.
    const c = check([sh('PREV', ['2026-10-18', '20:00'], [WEEK[0]!, '06:00'])], inForce({ maxContinuousWorkMinutes: 24 * 60, maxDailyWorkMinutes: 24 * 60, maxWeeklyWorkMinutes: 5 * 60 }));
    expect(c.breaches.map((b) => `${b.rule}:${b.observed}`)).toEqual(['maxWeeklyWorkMinutes:360']);
  });

  it('spread-over follows a stretch past midnight — the split cannot hide it', () => {
    // 13:00–17:00, then 18:00–23:59 and 00:00–01:30 (one stretch): the day of the 20th spreads 13:00 to 01:30 = 12h 30m.
    const shifts = [sh('A', [WEEK[1]!, '13:00'], [WEEK[1]!, '17:00']), sh('B', [WEEK[1]!, '18:00'], [WEEK[1]!, '23:59']), sh('C', [WEEK[2]!, '00:00'], [WEEK[2]!, '01:30'])];
    const c = check(shifts, inForce({ maxContinuousWorkMinutes: 24 * 60, maxDailyWorkMinutes: 24 * 60 }));
    expect(c.breaches.map((b) => `${b.rule}@${b.date}:${b.observed}`)).toEqual(['maxSpreadOverMinutes@2026-10-20:750']);
    expect(c.breaches[0]!.detail).toContain('spreads from 2026-10-20 13:00 to 2026-10-21 01:30 (12h 30m)');
  });

  it('a stretch that started the evening before the week and runs into it is judged', () => {
    const c = check([sh('PREV', ['2026-10-18', '22:00'], [WEEK[0]!, '06:00'])]);
    expect(c.breaches.map((b) => `${b.rule}@${b.date}`)).toEqual(['maxContinuousWorkMinutes@2026-10-18']);
  });
});

describe('NEW-2: the weekly holiday is a whole local day with no work', () => {
  it('the tail of an overnight shift is work on the day it runs into', () => {
    // Mon–Sat 22:00 → 03:00: no shift STARTS on Sunday, but Sunday 00:00–03:00 is work — no day is off.
    const shifts = WEEK.slice(0, 6).map((d, i) => sh(`N${i}`, [d, '22:00'], [WEEK[i + 1]!, '03:00']));
    const c = check(shifts);
    expect(c.breaches.map((b) => b.rule)).toEqual(['weeklyHolidayMinDays']);
    expect(c.breaches[0]).toMatchObject({ observed: 0, limit: 1 });
  });

  it('a shift from the previous week that runs into this week counts', () => {
    // Sunday 18 Oct 22:00 → Monday 19 Oct 04:00, then Tue–Sun days: Monday is not a day off.
    const shifts = [sh('PREV', ['2026-10-18', '23:00'], [WEEK[0]!, '02:00']), ...WEEK.slice(1).map((d, i) => sh(`D${i}`, [d, '09:00'], [d, '13:00']))];
    const c = check(shifts);
    expect(c.breaches.map((b) => b.rule)).toEqual(['weeklyHolidayMinDays']);
    expect(c.shiftsChecked).toBe(7);
  });

  it('the holiday register counts an overnight tail as a worked day too', () => {
    const shifts = WEEK.slice(0, 6).map((d, i) => sh(`N${i}`, [d, '22:00'], [WEEK[i + 1]!, '03:00']));
    const reg = holidayRegister({ from: WEEK[0]!, to: WEEK[6]!, settings: inForce(), employees: [emp('E1')], attendance: [], shifts, assignments: shifts.map((s) => on(s.shiftId)) });
    expect(reg.people[0]!.weeks[0]).toEqual({ weekStart: WEEK[0], daysOff: [], weeklyHolidayGiven: false });
  });
});

describe('NEW-3 (c): a person marked inactive is still checked', () => {
  it('seven days on breaks the weekly holiday whether the person is active or not', () => {
    const shifts = WEEK.map((d, i) => sh(`D${i}`, [d, '09:00'], [d, '13:00']));
    const c = check(shifts, inForce(), [emp('E1', false)]);
    expect(c.breaches.map((b) => b.rule)).toEqual(['weeklyHolidayMinDays']);
    expect(c.breaches[0]!.name).toBe('Person E1 (marked inactive)');
  });

  it('an unreadable shift at another branch held by a person checked is a breach, not silently dropped (L1)', () => {
    const bad: ShiftRequirement = { shiftId: 'BAD2', branchId: 'b2', startsAt: at(WEEK[2]!, '10:00'), endsAt: at(WEEK[2]!, '09:00'), requiredRoles: [] };
    const c = check([sh('A', [WEEK[1]!, '09:00'], [WEEK[1]!, '13:00']), bad]);
    expect(c.breaches.map((b) => `${b.rule}:${b.shiftIds.join(',')}`)).toEqual(['unreadable_shift:BAD2']);
  });
});

describe('OB-155: a limit not in force is named as not checked; those in force are enforced', () => {
  it('names the pending limits, and a rest rule whose partner limit is pending', () => {
    expect(rosterLimitsNotChecked(UNSET_WORKING_TIME_SETTINGS).map((n) => n.key)).toEqual(['weeklyHolidayMinDays', 'maxDailyWorkMinutes', 'maxWeeklyWorkMinutes', 'maxSpreadOverMinutes', 'maxContinuousWorkMinutes', 'minRestIntervalMinutes']);
    const half = inForce({ minRestIntervalMinutes: null });
    const n = rosterLimitsNotChecked(half);
    expect(n.map((x) => x.key)).toEqual(['maxContinuousWorkMinutes', 'minRestIntervalMinutes']);
    expect(n[0]!.missing).toContain('minRestIntervalMinutes');
  });

  it('only the daily cap filled: a 10-hour day breaches it; nothing else is judged', () => {
    const only = inForce({ weeklyHolidayMinDays: null, maxWeeklyWorkMinutes: null, maxSpreadOverMinutes: null, maxContinuousWorkMinutes: null, minRestIntervalMinutes: null });
    const c = check(WEEK.map((d, i) => sh(`D${i}`, [d, '08:00'], [d, '18:00'])), only);
    expect(new Set(c.breaches.map((b) => b.rule))).toEqual(new Set(['maxDailyWorkMinutes']));
    expect(c.notChecked.map((x) => x.key)).toEqual(['weeklyHolidayMinDays', 'maxWeeklyWorkMinutes', 'maxSpreadOverMinutes', 'maxContinuousWorkMinutes', 'minRestIntervalMinutes']);
  });
});

describe('OB-166: the roster a publication checked has one canonical form', () => {
  const base = () => ({ settings: inForce(), branchId: 'b1', weekStart: WEEK[0]!, shifts: [sh('A', [WEEK[0]!, '09:00'], [WEEK[0]!, '13:00']), sh('Z', [WEEK[0]!, '09:00'], [WEEK[0]!, '13:00'], 'b2')], assignments: [on('A'), on('Z', 'OTHER')], employees: [emp('E1'), emp('OTHER')] });

  it('changes when a shift moves, a person is added, or a record is deactivated — not for somebody else\'s shift elsewhere', () => {
    const b0 = rosterWeekBasis(base());
    const moved = base(); moved.shifts[0] = sh('A', [WEEK[0]!, '06:00'], [WEEK[0]!, '23:00']);
    expect(rosterWeekBasis(moved)).not.toBe(b0);
    const added = base(); added.assignments.push(on('A', 'OTHER'));
    expect(rosterWeekBasis(added)).not.toBe(b0);
    const off = base(); off.employees[0] = emp('E1', false);
    expect(rosterWeekBasis(off)).not.toBe(b0);
    const elsewhere = base(); elsewhere.shifts[1] = sh('Z', [WEEK[0]!, '10:00'], [WEEK[0]!, '14:00'], 'b2');
    expect(rosterWeekBasis(elsewhere)).toBe(b0);
    // The person's own shift at another branch is part of what was checked.
    const theirs = base(); theirs.shifts.push(sh('Y', [WEEK[1]!, '09:00'], [WEEK[1]!, '13:00'], 'b2')); theirs.assignments.push(on('Y'));
    expect(rosterWeekBasis(theirs)).not.toBe(b0);
  });
});

describe('OB-156: casual, sick, festival and unpaid leave are settings, unchecked until filled', () => {
  const withLeave = (over: Partial<WorkingTimeSettings['leaveTypes']>): WorkingTimeSettings => ({ ...inForce(), leaveTypes: { ...UNSET_WORKING_TIME_SETTINGS.leaveTypes, ...over } });
  const rec = (date: string, type: LeaveRecord['leaveType'], kind: LeaveRecord['kind'] = 'taken'): LeaveRecord => ({ employeeId: 'E1', date, kind, leaveType: type, recordedBy: 'u', recordedAt: `${date}T00:00:00.000Z` });

  it('ships all four pending, saying what each needs', () => {
    const st = leaveTypeStatuses(UNSET_WORKING_TIME_SETTINGS);
    expect(st.map((s) => `${s.key}:${s.status}`)).toEqual(LEAVE_TYPE_KEYS.map((k) => `${k}:pending`));
    expect(st[0]!.missing).toBe('needs the days a year, the carry-over rule, the provision of the Act it comes from, who confirmed it (owner or CA)');
  });

  it('a pending type is counted but not checked; a filled one gives an entitlement with carry-over', () => {
    const records = [rec('2025-03-01', 'casual'), rec('2026-02-01', 'casual'), rec('2026-02-02', 'casual'), rec('2026-02-03', 'sick')];
    const pending = leaveTypeBalance({ settings: UNSET_WORKING_TIME_SETTINGS, type: 'casual', employeeId: 'E1', year: 2026, records });
    expect(pending).toMatchObject({ check: 'not_checked', taken: 2, entitlement: null, balance: null });
    const settings = withLeave({ casual: { daysPerYear: 3, carryOverMaxDays: 1, source: 'test fixture', confirmation: 'test fixture' } });
    // 2025: 3 a year, 1 taken → 2 unused, 1 carries over. 2026: 3 + 1 = 4, 2 taken → 2 left.
    expect(leaveTypeBalance({ settings, type: 'casual', employeeId: 'E1', year: 2026, records })).toMatchObject({ check: 'checked', entitlement: 4, carriedIn: 1, taken: 2, balance: 2 });
    // Annual leave and the other types are counted apart.
    expect(leaveDaysTaken(records).get('E1')).toBeUndefined();
    expect(leaveDaysTaken(records, 'sick').get('E1')).toEqual(['2026-02-03']);
  });

  it('the attendance register shows which kind of leave a day was', () => {
    const rows = attendanceRegister({ from: WEEK[0]!, to: WEEK[0]!, settings: inForce(), employees: [emp('E1')], attendance: [], shifts: [], assignments: [], leave: [rec(WEEK[0]!, 'sick')] });
    expect(rows[0]!.days[0]).toMatchObject({ status: 'leave', leaveType: 'sick' });
  });
});
