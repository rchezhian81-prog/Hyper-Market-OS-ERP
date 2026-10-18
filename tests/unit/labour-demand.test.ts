import { describe, it, expect } from 'vitest';
import { forecastLabourDemand, InvalidLabourDemandInputError } from '../../packages/workforce/src/labour-demand';
import { draftRoster, actualAgainstRoster } from '../../packages/workforce/src/schedule';
import { UNSET_WORKING_TIME_SETTINGS, type WorkingTimeSettings, type WorkingTimeLimitKey } from '../../packages/workforce/src/working-time';

/** D-9 (R3, OB-142 "A", OB-181): the hourly forecast, the draft roster within the limits in force, and actuals. */
const WEEK = '2026-10-05'; // a Monday
const IST = 330;
const at = (date: string, hhmm: string) => new Date(Date.parse(`${date}T${hhmm}:00Z`) - IST * 60_000).toISOString();
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** 8 weeks of history: every day 1 bill at 10:xx and 2 bills at 18:xx (store time). */
const bills = Array.from({ length: 56 }, (_, i) => addDays(WEEK, -56 + i)).flatMap((d) => [{ at: at(d, '10:15') }, { at: at(d, '18:05') }, { at: at(d, '18:40') }]);
const standards = [{ role: 'cashier', billsPerStaffHour: 1, setBy: 'u-owner', setAt: '2026-10-01T00:00:00Z' }];
const withLimits = (l: Partial<Record<WorkingTimeLimitKey, number>>): WorkingTimeSettings => ({
  ...UNSET_WORKING_TIME_SETTINGS,
  limits: { ...UNSET_WORKING_TIME_SETTINGS.limits, ...Object.fromEntries(Object.entries(l).map(([k, v]) => [k, { value: v, source: 'synthetic provision', confirmation: 'synthetic CA ref' }])) },
});
const staff = [
  { employeeId: 'u-anu', name: 'Anu', branchId: 'S1', roles: ['cashier'], active: true, hourlyRateMinor: 10_000 },
  { employeeId: 'u-bala', name: 'Bala', branchId: 'S1', roles: ['cashier'], active: true },
  { employeeId: 'u-chitra', name: 'Chitra', branchId: 'S1', roles: ['cashier'], active: true, hourlyRateMinor: 12_000 },
];

describe('D-9 labour demand', () => {
  it('forecasts staff per role per hour of the Monday–Sunday week from hourly sales', () => {
    const d = forecastLabourDemand({ weekStart: WEEK, historyWeeks: 8, utcOffsetMinutes: IST, bills, roles: ['cashier', 'store_manager'], standards });
    expect(d.slots.filter((s) => s.date === WEEK)).toEqual([
      { date: WEEK, hour: 10, role: 'cashier', forecastBills: 1, staffNeeded: 1 },
      { date: WEEK, hour: 18, role: 'cashier', forecastBills: 2, staffNeeded: 2 },
    ]);
    expect(d.staffHoursByRole).toEqual({ cashier: 21 });
    expect(d.rolesNotForecast).toEqual([{ role: 'store_manager', reason: 'standard_not_set' }]);
    expect(d.weekEnd).toBe('2026-10-11');
  });
  it('the week is Monday–Sunday, fixed (OB-181)', () => {
    expect(() => forecastLabourDemand({ weekStart: '2026-10-06', historyWeeks: 8, utcOffsetMinutes: IST, bills, roles: ['cashier'], standards })).toThrow(InvalidLabourDemandInputError);
  });
  it('rounds staff UP: enough for the hour', () => {
    const d = forecastLabourDemand({ weekStart: WEEK, historyWeeks: 8, utcOffsetMinutes: IST, bills, roles: ['cashier'], standards: [{ ...standards[0]!, billsPerStaffHour: 3 }] });
    expect(d.slots.every((s) => s.staffNeeded === 1)).toBe(true);
  });
});

describe('D-9 draft roster', () => {
  const demand = forecastLabourDemand({ weekStart: WEEK, historyWeeks: 8, utcOffsetMinutes: IST, bills, roles: ['cashier'], standards });
  it('with every limit pending: covers the need, names every limit not checked, never invents a value', () => {
    const r = draftRoster({ branchId: 'S1', weekStart: WEEK, settings: UNSET_WORKING_TIME_SETTINGS, slots: demand.slots, employees: staff, existing: { shifts: [], assignments: [] }, idPrefix: 'd1' });
    expect(r.uncovered).toEqual([]);
    expect(r.assignments).toHaveLength(21);
    expect(r.notChecked.map((n) => n.key)).toEqual(['weeklyHolidayMinDays', 'maxDailyWorkMinutes', 'maxWeeklyWorkMinutes', 'maxSpreadOverMinutes', 'maxContinuousWorkMinutes', 'minRestIntervalMinutes']);
    expect(r.breaches).toEqual([]);
  });
  it('within limits in force: the weekly hours cap and the weekly holiday leave named uncovered slots; cost reported, not capped', () => {
    const r = draftRoster({ branchId: 'S1', weekStart: WEEK, settings: withLimits({ weeklyHolidayMinDays: 1, maxWeeklyWorkMinutes: 300 }), slots: demand.slots, employees: staff, existing: { shifts: [], assignments: [] }, idPrefix: 'd2' });
    // 3 cashiers × 5 h = 15 of the 21 staff hours; the rest is uncovered, each by name
    expect(r.assignments).toHaveLength(15);
    expect(r.uncovered).toHaveLength(6);
    expect(r.uncovered[0]!.detail).toMatch(/needs one more cashier: every cashier at S1 is already working that day or would go past a working-time limit/);
    expect(r.breaches).toEqual([]);
    const perPerson = new Map<string, number>();
    for (const a of r.assignments) perPerson.set(a.employeeId, (perPerson.get(a.employeeId) ?? 0) + 1);
    expect([...perPerson.values()].every((n) => n <= 5)).toBe(true);
    expect(r.cost.capped).toBe(false);
    expect(r.cost.notCostedPeople).toEqual(['u-bala']);
    expect(r.cost.lines.find((l) => l.employeeId === 'u-anu')!.costMinor).toBe(50_000);
  });
  it('a role nobody holds is uncovered by name', () => {
    const r = draftRoster({ branchId: 'S1', weekStart: WEEK, settings: UNSET_WORKING_TIME_SETTINGS, slots: [{ date: WEEK, hour: 9, role: 'butcher', forecastBills: 3, staffNeeded: 1 }], employees: staff, existing: { shifts: [], assignments: [] }, idPrefix: 'd3' });
    expect(r.uncovered).toEqual([expect.objectContaining({ role: 'butcher', from: '09:00', to: '10:00', reason: 'no_one_with_the_role' })]);
  });
  it('a long block is cut to the daily cap in force', () => {
    const slots = Array.from({ length: 10 }, (_, i) => ({ date: WEEK, hour: 8 + i, role: 'cashier', forecastBills: 1, staffNeeded: 1 }));
    const r = draftRoster({ branchId: 'S1', weekStart: WEEK, settings: withLimits({ maxDailyWorkMinutes: 480 }), slots, employees: staff, existing: { shifts: [], assignments: [] }, idPrefix: 'd4' });
    expect(r.shifts.map((s) => [s.startHour, s.endHour])).toEqual([[8, 16], [16, 18]]);
    expect(new Set(r.assignments.map((a) => a.employeeId)).size).toBe(2);
  });
});

describe('D-9 actual attendance against the roster', () => {
  it('marks (in/out), else recorded hours, else not recorded — never zero', () => {
    const shift = (id: string, from: string, to: string) => ({ shiftId: id, branchId: 'S1', startsAt: at(WEEK, from), endsAt: at(WEEK, to), requiredRoles: [{ role: 'cashier', count: 1 }] });
    const rows = actualAgainstRoster({
      weekStart: WEEK, utcOffsetMinutes: IST,
      rostered: [{ employeeId: 'u-anu', shift: shift('a', '10:00', '11:00') }, { employeeId: 'u-bala', shift: shift('b', '18:00', '19:00') }, { employeeId: 'u-chitra', shift: shift('c', '18:00', '19:00') }],
      marks: [{ employeeId: 'u-anu', kind: 'in', at: at(WEEK, '10:00') }, { employeeId: 'u-anu', kind: 'out', at: at(WEEK, '11:00') }, { employeeId: 'u-dev', kind: 'in', at: at(WEEK, '12:00') }, { employeeId: 'u-dev', kind: 'out', at: at(WEEK, '13:00') }],
      hours: [{ employeeId: 'u-bala', date: WEEK, hours: 0.5 }],
    });
    expect(rows.map((r) => [r.employeeId, r.status, r.actualMinutes, r.source])).toEqual([
      ['u-anu', 'as_rostered', 60, 'attendance_marks'], ['u-bala', 'short', 30, 'hours_recorded'], ['u-chitra', 'not_recorded', null, 'none'], ['u-dev', 'worked_unrostered', 60, 'attendance_marks'],
    ]);
  });
});
