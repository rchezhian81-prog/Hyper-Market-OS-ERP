import { describe, it, expect } from 'vitest';
import {
  UNSET_PAYROLL_LEGAL_SETTINGS, foldPayrollLegalSettings, figureStatuses, hoursAndOvertime, overtimePay, checkMinimumWage, buildStatutoryPayslip,
  OvertimeBelowFloor, BelowMinimumWage, OVERTIME_FLOOR_PERCENT,
  type PayrollLegalSettingChange, type PayrollFigureKey, type MinimumWageClass,
} from '../../packages/payroll/src/index';

/**
 * **R4 · C16 · OB-208 — hours worked, overtime and the minimum wage (the pure engine).** "Each employee's hours actually
 * worked per day come from attendance and are shown on the payslip. Hours above the normal daily or weekly hours are
 * overtime, paid at no less than twice the ordinary hourly rate; a lower rate is refused ('overtime below 2×'). Once
 * the CA fills the minimum wage for an employee's class, a month's pay below it is refused ('below minimum wage'). Until
 * the CA fills them, the minimum wage and the normal hours show 'not confirmed', and the pay run says 'minimum wage not
 * checked' or 'overtime limit not set'; it never assumes a figure."
 *
 * Figures are SYNTHETIC test figures. July 2030 starts on a Monday.
 */

const fig = (key: PayrollFigureKey, value: number): PayrollLegalSettingChange => ({ target: 'figure', key, figure: { value, source: 'test', confirmation: 'CA test' }, by: 'u-ca', at: 'x' });
const cls = (classId: string, monthlyMinor: number, roles: string[], confirmed = true): PayrollLegalSettingChange => ({
  target: 'minimumWage', setting: { classId, label: `Class ${classId}`, roles, monthlyMinor, source: 'test', confirmation: confirmed ? 'CA test' : null } as MinimumWageClass, by: 'u-ca', at: 'x',
});
// Week 1 (1–7 July): 10, 9, then 8 hours a day for five days = 59 hours. Week 2: one 7.5-hour day.
const HOURS = [10, 9, 8, 8, 8, 8, 8].map((h, i) => ({ date: `2030-07-0${i + 1}`, hours: h })).concat([{ date: '2030-07-08', hours: 7.5 }, { date: '2030-06-30', hours: 12 }]);

describe('hours worked and overtime', () => {
  it('the hours per day come from attendance, in minutes; a day outside the month is not counted', () => {
    const r = hoursAndOvertime({ settings: UNSET_PAYROLL_LEGAL_SETTINGS, period: '2030-07', hours: HOURS });
    expect(r.days.map((d) => [d.date, d.workedMinutes])).toEqual([
      ['2030-07-01', 600], ['2030-07-02', 540], ['2030-07-03', 480], ['2030-07-04', 480], ['2030-07-05', 480], ['2030-07-06', 480], ['2030-07-07', 480], ['2030-07-08', 450],
    ]);
    expect(r.totalWorkedMinutes).toBe(3990);
  });

  it('with no normal hours confirmed: "overtime limit not set", and no overtime is assumed (null, not zero)', () => {
    const r = hoursAndOvertime({ settings: UNSET_PAYROLL_LEGAL_SETTINGS, period: '2030-07', hours: HOURS });
    expect(r).toMatchObject({ status: 'limit_not_set', overtimeMinutes: null });
    expect(r.notSet).toEqual([
      'overtime limit not set: Normal hours a day — work above this is overtime — not confirmed',
      'overtime limit not set: Normal hours a week (Monday to Sunday) — work above this is overtime — not confirmed',
    ]);
  });

  it('daily only: the minutes above the daily hours; weekly only: above the weekly hours; both: the larger per week', () => {
    const daily = hoursAndOvertime({ settings: foldPayrollLegalSettings([fig('normalDailyMinutes', 480)]), period: '2030-07', hours: HOURS });
    expect(daily.overtimeMinutes).toBe(180); // 2h + 1h on 1 and 2 July
    expect(daily.notSet).toHaveLength(1);
    const weekly = hoursAndOvertime({ settings: foldPayrollLegalSettings([fig('normalWeeklyMinutes', 2880)]), period: '2030-07', hours: HOURS });
    expect(weekly.overtimeMinutes).toBe(660); // 59h − 48h in week 1
    const both = hoursAndOvertime({ settings: foldPayrollLegalSettings([fig('normalDailyMinutes', 480), fig('normalWeeklyMinutes', 2880)]), period: '2030-07', hours: HOURS });
    expect(both.weeks[0]).toMatchObject({ weekStart: '2030-07-01', overDailyMinutes: 180, overWeeklyMinutes: 660, overtimeMinutes: 660 });
    expect(both.overtimeMinutes).toBe(660); // never 180 + 660 — the same hour is not paid twice
    expect(both.notSet).toEqual([]);
  });

  it('unreadable hours are refused', () => {
    expect(() => hoursAndOvertime({ settings: UNSET_PAYROLL_LEGAL_SETTINGS, period: '2030-07', hours: [{ date: '2030-07-01', hours: 25 }] })).toThrow(/0 to 24/);
    expect(() => hoursAndOvertime({ settings: UNSET_PAYROLL_LEGAL_SETTINGS, period: '2030-7', hours: [] })).toThrow(/YYYY-MM/);
  });
});

describe('overtime is paid at no less than twice the ordinary rate', () => {
  const s = UNSET_PAYROLL_LEGAL_SETTINGS;
  it('a rate below 2× is refused — "overtime below 2×" — whatever the hours', () => {
    expect(() => overtimePay({ settings: s, overtimeMinutes: 660, ordinaryHourlyRateMinor: 10_000, overtimeHourlyRateMinor: 19_999 })).toThrow(OvertimeBelowFloor);
    expect(() => overtimePay({ settings: s, overtimeMinutes: 0, ordinaryHourlyRateMinor: 10_000, overtimeHourlyRateMinor: 15_000 })).toThrow('overtime below 2×: ₹150.00 an hour is less than twice the ordinary hourly rate of ₹100.00');
  });

  it('exactly 2× is paid: 11 hours at ₹200', () => {
    expect(overtimePay({ settings: s, overtimeMinutes: 660, ordinaryHourlyRateMinor: 10_000, overtimeHourlyRateMinor: 20_000 })).toMatchObject({ status: 'paid', payMinor: 220_000, overtimeHourlyRateMinor: 20_000 });
  });

  it('with no rate asked for, the CA\'s confirmed multiplier sets it; unconfirmed, overtime pay is "rate not set" — never an assumed 2×', () => {
    expect(overtimePay({ settings: s, overtimeMinutes: 60, ordinaryHourlyRateMinor: 10_000 })).toMatchObject({ status: 'rate_not_set', payMinor: null });
    const confirmed = foldPayrollLegalSettings([fig('overtimeMultiplierPercent', 250)]);
    expect(overtimePay({ settings: confirmed, overtimeMinutes: 60, ordinaryHourlyRateMinor: 10_000 })).toMatchObject({ status: 'paid', overtimeHourlyRateMinor: 25_000, payMinor: 25_000 });
  });

  it('a multiplier below 200% is never confirmed, even with a confirmation — the floor is the signed sentence, not a setting', () => {
    const low = foldPayrollLegalSettings([fig('overtimeMultiplierPercent', 150)]);
    expect(figureStatuses(low).find((f) => f.key === 'overtimeMultiplierPercent')).toMatchObject({ status: 'not_confirmed', missing: expect.stringContaining('overtime below 2×') });
    expect(overtimePay({ settings: low, overtimeMinutes: 60, ordinaryHourlyRateMinor: 10_000 }).status).toBe('rate_not_set');
    expect(OVERTIME_FLOOR_PERCENT).toBe(200);
  });

  it('without an ordinary hourly rate the floor cannot be checked, so nothing is paid as overtime and it says why', () => {
    expect(overtimePay({ settings: s, overtimeMinutes: 60, overtimeHourlyRateMinor: 30_000 })).toMatchObject({ status: 'ordinary_rate_unknown', payMinor: null });
    expect(overtimePay({ settings: s, overtimeMinutes: null })).toMatchObject({ status: 'limit_not_set', payMinor: null });
    expect(overtimePay({ settings: s, overtimeMinutes: 0 })).toMatchObject({ status: 'no_overtime', payMinor: 0 });
  });
});

describe('the minimum wage', () => {
  it('no class for the role, or an unconfirmed class: "minimum wage not checked" — nothing is refused on a guess', () => {
    expect(checkMinimumWage({ settings: UNSET_PAYROLL_LEGAL_SETTINGS, roles: ['cashier'], monthlyPayMinor: 1 })).toMatchObject({ status: 'not_checked', detail: 'minimum wage not checked: no minimum-wage class is set for the role cashier' });
    const unconfirmed = foldPayrollLegalSettings([cls('shop-a', 1_200_000, ['cashier'], false)]);
    expect(checkMinimumWage({ settings: unconfirmed, roles: ['cashier'], monthlyPayMinor: 1 })).toMatchObject({ status: 'not_checked', detail: 'minimum wage not checked: Class shop-a — not confirmed by the CA' });
  });

  it('once confirmed, a month\'s pay below it is refused — "below minimum wage"; at it, met; two classes, the higher', () => {
    const s = foldPayrollLegalSettings([cls('shop-a', 1_200_000, ['cashier']), cls('shop-b', 1_300_000, ['cashier', 'picker'])]);
    expect(() => checkMinimumWage({ settings: s, roles: ['cashier'], monthlyPayMinor: 1_299_999 })).toThrow(BelowMinimumWage);
    expect(() => checkMinimumWage({ settings: s, roles: ['cashier'], monthlyPayMinor: 1_250_000 })).toThrow('below minimum wage: the month\'s pay of ₹12,500.00 is less than the minimum wage of ₹13,000.00 for Class shop-b');
    expect(checkMinimumWage({ settings: s, roles: ['cashier'], monthlyPayMinor: 1_300_000 })).toMatchObject({ status: 'met', classId: 'shop-b' });
  });
});

describe('the statutory payslip carries all of it', () => {
  const base = {
    period: '2030-07', onDate: '2030-07-31', attendance: { calendarDaysInMonth: 31, paidDays: 31 }, headcount: 5, roles: ['cashier'], hours: HOURS,
    components: [{ code: 'BASIC', monthlyMinor: 1_500_000, partOfPfWage: true }],
  };
  it('with nothing confirmed the pay run says "minimum wage not checked" and "overtime limit not set", and pays no overtime', () => {
    const p = buildStatutoryPayslip({ ...base, settings: UNSET_PAYROLL_LEGAL_SETTINGS, ordinaryHourlyRateMinor: 10_000 });
    expect(p.statutoryChecks.notChecked).toEqual(expect.arrayContaining([
      'minimum wage not checked: no minimum-wage class is set for the role cashier',
      'overtime limit not set: Normal hours a day — work above this is overtime — not confirmed',
    ]));
    expect(p.earnings.map((e) => e.code)).toEqual(['BASIC']);
    expect(p.statutoryChecks.hoursWorked.totalWorkedMinutes).toBe(3990);
  });

  it('confirmed: overtime is added as wages (in gross, not the PF wage); a pay below the minimum is refused', () => {
    const s = foldPayrollLegalSettings([fig('normalDailyMinutes', 480), fig('normalWeeklyMinutes', 2880), fig('overtimeMultiplierPercent', 200), cls('shop-a', 1_400_000, ['cashier'])]);
    const p = buildStatutoryPayslip({ ...base, settings: s, ordinaryHourlyRateMinor: 10_000 });
    expect(p.earnings.find((e) => e.code === 'OVERTIME')?.earnedMinor).toBe(220_000);
    expect(p.grossMinor).toBe(1_720_000);
    expect(p.pfWageMinor).toBe(1_500_000);
    expect(p.statutoryChecks.minimumWage.status).toBe('met');
    expect(() => buildStatutoryPayslip({ ...base, settings: s, components: [{ code: 'BASIC', monthlyMinor: 1_399_900 }] })).toThrow(BelowMinimumWage);
    expect(() => buildStatutoryPayslip({ ...base, settings: s, ordinaryHourlyRateMinor: 10_000, overtimeHourlyRateMinor: 15_000 })).toThrow(OvertimeBelowFloor);
    expect(() => buildStatutoryPayslip({ ...base, settings: s, components: [{ code: 'OVERTIME', monthlyMinor: 1_500_000 }] })).toThrow(/worked out from attendance/);
  });
});
