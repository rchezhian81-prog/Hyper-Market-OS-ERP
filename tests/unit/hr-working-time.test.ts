import { describe, it, expect } from 'vitest';
import {
  UNSET_WORKING_TIME_SETTINGS, WORKING_TIME_LIMIT_KEYS,
  limitStatuses, checkWorkingTime, leaveBalance, leaveDaysTaken, attendanceRegister, holidayRegister, localDateOf,
  type WorkingTimeSettings, type WorkingTimeLimitKey, type Employee, type ShiftRequirement, type ShiftAssignment, type LeaveRecord,
} from '../../packages/workforce/src/index';

// R2 addendum C18 — the TN Shops and Establishments working-time pack, engine level. No legal number is in the
// engine: these tests set SYNTHETIC limits, chosen only to exercise each rule.

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

const emp = (id: string, branchId = 'b1', active = true): Employee => ({ employeeId: id, name: `Person ${id}`, branchId, roles: ['cashier'], active });
// IST = UTC+05:30: 03:30Z is 09:00 local.
const shift = (id: string, day: string, fromLocal: string, toLocal: string, branchId = 'b1'): ShiftRequirement => {
  const iso = (t: string) => new Date(Date.parse(`${day}T${t}:00+05:30`)).toISOString();
  return { shiftId: id, branchId, startsAt: iso(fromLocal), endsAt: iso(toLocal), requiredRoles: [{ role: 'cashier', count: 1 }] };
};
const on = (shiftId: string, employeeId: string): ShiftAssignment => ({ shiftId, employeeId, role: 'cashier' });
const WEEK = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'];

/** Six 8-hour days, Sunday off — inside every synthetic limit. */
function cleanWeek(employeeId = 'E1') {
  const shifts = WEEK.slice(0, 6).map((d, i) => shift(`S${i}`, d, '09:00', '13:00'))
    .concat(WEEK.slice(0, 6).map((d, i) => shift(`T${i}`, d, '14:00', '18:00')));
  return { shifts, assignments: shifts.map((s) => on(s.shiftId, employeeId)), employees: [emp(employeeId)] };
}

describe('C18 limits are settings — none is in force until value, source and confirmation are all present', () => {
  it('ships every limit PENDING, saying what each still needs', () => {
    const st = limitStatuses(UNSET_WORKING_TIME_SETTINGS);
    expect(st.map((s) => s.key)).toEqual(WORKING_TIME_LIMIT_KEYS);
    expect(st.every((s) => s.status === 'pending')).toBe(true);
    expect(st[0]!.missing).toBe('needs the value, the provision of the Act it comes from, who confirmed it (owner or CA)');
  });

  it('a value without its source or its confirmation stays pending', () => {
    const s: WorkingTimeSettings = { ...UNSET_WORKING_TIME_SETTINGS, limits: { ...UNSET_WORKING_TIME_SETTINGS.limits, maxDailyWorkMinutes: { value: 540, source: 'a section', confirmation: null } } };
    const daily = limitStatuses(s).find((x) => x.key === 'maxDailyWorkMinutes')!;
    expect(daily).toMatchObject({ status: 'pending', missing: 'needs who confirmed it (owner or CA)' });
  });

  it('a roster check lists the pending limits — it never passes a rule it could not check', () => {
    const c = checkWorkingTime({ settings: UNSET_WORKING_TIME_SETTINGS, branchId: 'b1', weekStart: WEEK[0]!, ...cleanWeek() });
    expect(c.pending.map((p) => p.key)).toEqual(['weeklyHolidayMinDays', 'maxDailyWorkMinutes', 'maxWeeklyWorkMinutes', 'maxSpreadOverMinutes', 'maxContinuousWorkMinutes', 'minRestIntervalMinutes']);
    expect(c.breaches).toEqual([]);
  });
});

describe('C18 roster check — every breach named in words', () => {
  it('a clean week has no breach', () => {
    const c = checkWorkingTime({ settings: inForce(), branchId: 'b1', weekStart: WEEK[0]!, ...cleanWeek() });
    expect(c).toMatchObject({ pending: [], breaches: [], employeesChecked: 1, shiftsChecked: 12, weekEnd: '2026-10-25' });
  });

  it('daily cap: a 10-hour day breaches a 9-hour cap', () => {
    const shifts = [shift('A', WEEK[0]!, '08:00', '13:00'), shift('B', WEEK[0]!, '14:00', '19:00')];
    const c = checkWorkingTime({ settings: inForce(), branchId: 'b1', weekStart: WEEK[0]!, shifts, assignments: shifts.map((s) => on(s.shiftId, 'E1')), employees: [emp('E1')] });
    expect(c.breaches).toHaveLength(1);
    expect(c.breaches[0]).toMatchObject({ rule: 'maxDailyWorkMinutes', date: '2026-10-19', observed: 600, limit: 540, shiftIds: ['A', 'B'] });
    expect(c.breaches[0]!.detail).toBe('Person E1 is rostered 10h on 2026-10-19 — more than the daily cap of 9h');
  });

  it('spread-over: 07:00 to 19:00 breaches an 11-hour spread even within the daily cap', () => {
    const shifts = [shift('A', WEEK[0]!, '07:00', '11:00'), shift('B', WEEK[0]!, '15:00', '19:00')];
    const c = checkWorkingTime({ settings: inForce(), branchId: 'b1', weekStart: WEEK[0]!, shifts, assignments: shifts.map((s) => on(s.shiftId, 'E1')), employees: [emp('E1')] });
    expect(c.breaches.map((b) => b.rule)).toEqual(['maxSpreadOverMinutes']);
    expect(c.breaches[0]!.detail).toContain('spreads from 07:00 to 19:00 (12h)');
  });

  it('rest interval: a 6-hour stretch, or two shifts with only a 30-minute gap, has no rest interval', () => {
    const shifts = [shift('A', WEEK[0]!, '09:00', '12:00'), shift('B', WEEK[0]!, '12:30', '15:30')];
    const c = checkWorkingTime({ settings: inForce(), branchId: 'b1', weekStart: WEEK[0]!, shifts, assignments: shifts.map((s) => on(s.shiftId, 'E1')), employees: [emp('E1')] });
    expect(c.breaches.map((b) => b.rule)).toEqual(['maxContinuousWorkMinutes']);
    expect(c.breaches[0]).toMatchObject({ observed: 390, limit: 300, shiftIds: ['A', 'B'] });
    // A full hour's gap is a rest: no breach.
    const ok = [shift('A', WEEK[0]!, '09:00', '12:00'), shift('B', WEEK[0]!, '13:00', '16:00')];
    expect(checkWorkingTime({ settings: inForce(), branchId: 'b1', weekStart: WEEK[0]!, shifts: ok, assignments: ok.map((s) => on(s.shiftId, 'E1')), employees: [emp('E1')] }).breaches).toEqual([]);
  });

  it('weekly holiday and weekly cap: seven days on is two breaches', () => {
    const shifts = WEEK.map((d, i) => shift(`S${i}`, d, '09:00', '13:00')).concat(WEEK.map((d, i) => shift(`T${i}`, d, '14:00', '18:00')));
    const c = checkWorkingTime({ settings: inForce(), branchId: 'b1', weekStart: WEEK[0]!, shifts, assignments: shifts.map((s) => on(s.shiftId, 'E1')), employees: [emp('E1')] });
    expect(c.breaches.map((b) => b.rule).sort()).toEqual(['maxWeeklyWorkMinutes', 'weeklyHolidayMinDays']);
    expect(c.breaches.find((b) => b.rule === 'weeklyHolidayMinDays')!.detail).toBe('Person E1 has 0 day(s) off in the week of 2026-10-19 — the weekly holiday needs at least 1');
    expect(c.breaches.find((b) => b.rule === 'maxWeeklyWorkMinutes')).toMatchObject({ observed: 56 * 60, limit: 48 * 60 });
  });

  it('counts a person\'s shifts at another branch toward their limits; ignores leavers and other weeks', () => {
    const shifts = [shift('A', WEEK[0]!, '08:00', '13:00'), shift('B', WEEK[0]!, '14:00', '19:00', 'b2'), shift('X', '2026-10-26', '08:00', '20:00')];
    const assignments = [on('A', 'E1'), on('B', 'E1'), on('X', 'E1'), on('A', 'GONE')];
    const c = checkWorkingTime({ settings: inForce(), branchId: 'b1', weekStart: WEEK[0]!, shifts, assignments, employees: [emp('E1'), emp('GONE', 'b1', false)] });
    expect(c.employeesChecked).toBe(1);
    expect(c.breaches.map((b) => b.rule)).toEqual(['maxDailyWorkMinutes']);
  });

  it('a shift whose times cannot be checked is itself a breach — never skipped', () => {
    const bad: ShiftRequirement = { shiftId: 'BAD', branchId: 'b1', startsAt: '2026-10-19T10:00:00Z', endsAt: '2026-10-19T09:00:00Z', requiredRoles: [] };
    const c = checkWorkingTime({ settings: inForce(), branchId: 'b1', weekStart: WEEK[0]!, shifts: [bad], assignments: [on('BAD', 'E1')], employees: [emp('E1')] });
    expect(c.breaches.map((b) => b.rule)).toEqual(['unreadable_shift']);
  });

  it('days are the store\'s local days (IST), not UTC', () => {
    // 20:00Z on the 18th is 01:30 on the 19th in India.
    expect(localDateOf(Date.parse('2026-10-18T20:00:00Z'), 330)).toBe('2026-10-19');
    expect(() => checkWorkingTime({ settings: inForce(), branchId: 'b1', weekStart: '19-10-2026', shifts: [], assignments: [], employees: [] })).toThrow(RangeError);
  });
});

describe('C18 leave accrual', () => {
  const rec = (date: string, kind: 'taken' | 'cancelled'): LeaveRecord => ({ employeeId: 'E1', date, kind, recordedBy: 'u', recordedAt: `${date}T00:00:00.000Z` });

  it('earns whole days from days worked; a cancellation is a compensating record', () => {
    const taken = leaveDaysTaken([rec('2026-10-01', 'taken'), rec('2026-10-02', 'taken'), rec('2026-10-02', 'cancelled')]);
    expect(taken.get('E1')).toEqual(['2026-10-01']);
    expect(leaveBalance({ settings: inForce(), employeeId: 'E1', daysWorked: 45, takenDates: ['2026-10-01'] }))
      .toMatchObject({ earned: 2, taken: 1, balance: 1, accrual: 'in_force' });
  });

  it('is pending — no balance invented — while the accrual rate is not confirmed', () => {
    expect(leaveBalance({ settings: inForce({ annualLeaveDaysWorkedPerDayEarned: null }), employeeId: 'E1', daysWorked: 45, takenDates: [] }))
      .toMatchObject({ earned: null, balance: null, accrual: 'pending' });
  });
});

describe('C18 statutory registers from roster and attendance data', () => {
  it('attendance register: present, leave, absent, not recorded and off are told apart', () => {
    const shifts = [shift('A', WEEK[0]!, '09:00', '17:00'), shift('B', WEEK[1]!, '09:00', '17:00'), shift('C', WEEK[2]!, '09:00', '17:00')];
    const rows = attendanceRegister({
      from: WEEK[0]!, to: WEEK[3]!, settings: inForce(), employees: [emp('E1')],
      attendance: [{ employeeId: 'E1', date: WEEK[0]!, hours: 8 }, { employeeId: 'E1', date: WEEK[1]!, hours: 0 }],
      shifts, assignments: shifts.map((s) => on(s.shiftId, 'E1')),
      leave: [{ employeeId: 'E1', date: WEEK[3]!, kind: 'taken', recordedBy: 'u', recordedAt: '2026-10-01T00:00:00.000Z' }],
    });
    expect(rows[0]!.days.map((d) => d.status)).toEqual(['present', 'absent', 'not_recorded', 'leave']);
    expect(rows[0]!.days[0]!.rostered).toEqual([{ shiftId: 'A', from: '09:00', to: '17:00' }]);
    expect(rows[0]).toMatchObject({ daysPresent: 1, hoursTotal: 8, daysNotRecorded: 1 });
  });

  it('holiday register: days off per week judged against the weekly holiday, and who worked a public holiday', () => {
    const { shifts, assignments, employees } = cleanWeek();
    const settings: WorkingTimeSettings = { ...inForce(), publicHolidays: { dates: [{ date: WEEK[1]!, name: 'Synthetic holiday' }], source: 'test', confirmation: 'test' } };
    const reg = holidayRegister({ from: WEEK[0]!, to: WEEK[6]!, settings, employees, attendance: [], shifts, assignments });
    expect(reg.people[0]!.weeks).toEqual([{ weekStart: WEEK[0]!, daysOff: [WEEK[6]!], weeklyHolidayGiven: true }]);
    expect(reg.publicHolidays).toEqual([{ date: WEEK[1]!, name: 'Synthetic holiday', workedBy: ['E1'] }]);
    expect(reg).toMatchObject({ weeklyHoliday: 'in_force', publicHolidayList: 'in_force' });
    // Pending weekly-holiday limit → not judged.
    const pending = holidayRegister({ from: WEEK[0]!, to: WEEK[6]!, settings: UNSET_WORKING_TIME_SETTINGS, employees, attendance: [], shifts, assignments });
    expect(pending.people[0]!.weeks[0]!.weeklyHolidayGiven).toBeNull();
    expect(pending).toMatchObject({ weeklyHoliday: 'pending', publicHolidayList: 'pending' });
  });
});
