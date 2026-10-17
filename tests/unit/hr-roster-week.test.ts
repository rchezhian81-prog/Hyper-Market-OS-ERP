import { describe, it, expect } from 'vitest';
import {
  UNSET_WORKING_TIME_SETTINGS, WORKING_TIME_LIMIT_KEYS, PENDING_REST_STRETCH_GAP_MINUTES,
  checkWorkingTime, holidayRegister, rosterWeekStartOf, isRosterWeekStart, rosterWeekStartDay, weekdayOf, rosterLimitsNotChecked,
  type WorkingTimeSettings, type WorkingTimeLimitKey, type Employee, type ShiftRequirement, type ShiftAssignment,
} from '../../packages/workforce/src/index';
import { staffRosterVisibility, rosterBasisDigest, type RosterPublication } from '../../services/finance/src/hr-compliance';
import { rosterWeekBasis } from '../../packages/workforce/src/index';

// C18 — OB-179 "A" (the roster week is the shop's fixed Monday-to-Sunday week) and verifier r2final NEW-1 / L2, at the
// engine. SYNTHETIC limits only.

const SYNTHETIC: Readonly<Record<WorkingTimeLimitKey, number>> = {
  weeklyHolidayMinDays: 1, maxDailyWorkMinutes: 9 * 60, maxWeeklyWorkMinutes: 48 * 60, maxSpreadOverMinutes: 11 * 60,
  maxContinuousWorkMinutes: 5 * 60, minRestIntervalMinutes: 60, annualLeaveDaysWorkedPerDayEarned: 20,
};
const inForce = (over: Partial<Record<WorkingTimeLimitKey, number | null>> = {}): WorkingTimeSettings => ({
  ...UNSET_WORKING_TIME_SETTINGS,
  limits: Object.fromEntries(WORKING_TIME_LIMIT_KEYS.map((k) => {
    const v = k in over ? over[k]! : SYNTHETIC[k];
    return [k, { value: v, source: 'test fixture', confirmation: v === null ? null : 'test fixture' }];
  })) as WorkingTimeSettings['limits'],
});
const emp = (id: string): Employee => ({ employeeId: id, name: `Person ${id}`, branchId: 'b1', roles: ['cashier'], active: true });
const at = (day: string, hhmm: string): string => new Date(Date.parse(`${day}T${hhmm}:00+05:30`)).toISOString();
const sh = (id: string, day: string, from: string, to: string): ShiftRequirement =>
  ({ shiftId: id, branchId: 'b1', startsAt: at(day, from), endsAt: at(day, to), requiredRoles: [{ role: 'cashier', count: 1 }] });
const on = (shiftId: string): ShiftAssignment => ({ shiftId, employeeId: 'E1', role: 'cashier' });
const WEEK = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'];

describe('OB-179: the shop\'s roster week', () => {
  it('starts on Monday as shipped; a setting stored before OB-179 reads as Monday', () => {
    expect(rosterWeekStartDay(UNSET_WORKING_TIME_SETTINGS)).toBe('monday');
    const { rosterWeekStartsOn: _drop, ...old } = UNSET_WORKING_TIME_SETTINGS;
    void _drop;
    expect(rosterWeekStartDay(old)).toBe('monday');
    expect(weekdayOf('2026-10-19')).toBe('monday');
    expect(weekdayOf('2026-10-18')).toBe('sunday');
    expect(isRosterWeekStart(old, '2026-10-19')).toBe(true);
    expect(isRosterWeekStart(old, '2026-10-20')).toBe(false);
    expect(WEEK.map((d) => rosterWeekStartOf(old, d))).toEqual(Array(7).fill('2026-10-19'));
    expect(rosterWeekStartOf(old, '2026-10-26')).toBe('2026-10-26');
    const sunday = { ...old, rosterWeekStartsOn: 'sunday' as const };
    expect(rosterWeekStartOf(sunday, '2026-10-24')).toBe('2026-10-18');
    expect(rosterWeekStartOf(sunday, '2026-10-25')).toBe('2026-10-25');
  });

  it('NEW-1: the engine never checks a window that is not a roster week', () => {
    const shifts = WEEK.map((d) => sh(`D-${d}`, d, '09:00', '14:00'));
    const input = { settings: inForce(), branchId: 'b1', shifts, assignments: shifts.map((s) => on(s.shiftId)), employees: [emp('E1')] };
    expect(checkWorkingTime({ ...input, weekStart: WEEK[0]! }).breaches.map((b) => b.rule)).toEqual(['weeklyHolidayMinDays']);
    expect(() => checkWorkingTime({ ...input, weekStart: '2026-10-18' })).toThrow(/roster week starts on monday/);
    expect(() => checkWorkingTime({ ...input, weekStart: '2026-10-20' })).toThrow(/is a tuesday/);
  });

  it('NEW-1: a shift is visible only through the publication of its own Monday week, never a misaligned one', () => {
    const settings = inForce();
    const shifts = WEEK.map((d) => sh(`D-${d}`, d, '09:00', '14:00'));
    const roster = { employees: [emp('E1')], shifts, assignments: shifts.map((s) => on(s.shiftId)) };
    // Hand-made publications of misaligned windows (as one made before OB-179 could be): their digest even matches.
    const pub = (id: string, weekStart: string): RosterPublication => ({
      publicationId: id, branchId: 'b1', weekStart, weekEnd: weekStart, employeesChecked: 1, shiftsChecked: 7, checkedAgainst: {},
      basis: rosterBasisDigest(rosterWeekBasis({ settings, branchId: 'b1', weekStart, ...roster })), publishedBy: 'u-mgr', publishedAt: '2026-10-17T00:00:00Z',
    });
    expect(staffRosterVisibility(settings, roster, [pub('p-sun', '2026-10-18'), pub('p-tue', '2026-10-20')]).visible.size).toBe(0);
    const mon = staffRosterVisibility(settings, roster, [pub('p-mon', '2026-10-19')]);
    expect([...mon.visible.keys()].sort()).toEqual(shifts.map((s) => s.shiftId).sort());
    expect(mon.visible.get('D-2026-10-25')!.publicationId).toBe('p-mon');
  });

  it('the holiday register judges the weekly holiday per Monday week; a week cut by the period is shown, not judged', () => {
    const shifts = WEEK.slice(0, 6).map((d) => sh(`D-${d}`, d, '09:00', '14:00'));
    const reg = holidayRegister({ from: '2026-10-21', to: '2026-11-01', settings: inForce(), employees: [emp('E1')], attendance: [], shifts, assignments: shifts.map((s) => on(s.shiftId)) });
    const weeks = reg.people[0]!.weeks;
    expect(weeks.map((w) => w.weekStart)).toEqual(['2026-10-19', '2026-10-26']);
    expect(weeks[0]).toMatchObject({ daysOff: ['2026-10-25'], weeklyHolidayGiven: null });
    expect(weeks[1]).toMatchObject({ weeklyHolidayGiven: true });
    expect(weeks[1]!.daysOff).toHaveLength(7);
  });
});

describe('verifier r2final L2: while the rest interval is pending, near-touching shifts are one stretch', () => {
  const pendingRest = inForce({ minRestIntervalMinutes: null });
  const run = (gapStart: string) => {
    const shifts = [sh('A', WEEK[1]!, '19:00', '23:59'), { ...sh('B', WEEK[2]!, gapStart, '05:00') }];
    return checkWorkingTime({ settings: pendingRest, branchId: 'b1', weekStart: WEEK[0]!, shifts, assignments: shifts.map((s) => on(s.shiftId)), employees: [emp('E1')] });
  };
  it(`a gap under ${PENDING_REST_STRETCH_GAP_MINUTES} minutes keeps the stretch whole for the daily cap; ${PENDING_REST_STRETCH_GAP_MINUTES} minutes splits it`, () => {
    expect(run('00:00').breaches.map((b) => `${b.rule}@${b.date}:${b.observed}`)).toEqual(['maxDailyWorkMinutes@2026-10-20:599']);
    expect(run('00:13').breaches.map((b) => b.rule)).toEqual(['maxDailyWorkMinutes']);
    expect(run('00:14').breaches).toEqual([]);
    // The continuous-work cap stays NOT CHECKED (it needs the rest interval) — never a breach on a guessed rest.
    expect(run('00:00').breaches.some((b) => b.rule === 'maxContinuousWorkMinutes')).toBe(false);
  });
  it('the not-checked list says what is done meanwhile', () => {
    const n = rosterLimitsNotChecked(pendingRest).find((x) => x.key === 'minRestIntervalMinutes');
    expect(n?.meanwhile).toBe('Until it is in force, shifts less than 15 minutes apart are judged as one stretch of work for the daily hours cap and the spread-over.');
    expect(rosterLimitsNotChecked(inForce())).toEqual([]);
  });
});
