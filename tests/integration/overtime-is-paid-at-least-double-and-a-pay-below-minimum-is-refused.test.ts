import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { backings, openDatabase, closeDatabase, caller, addStaff, codeOf, whatOf } from '../support/r4-lane1';

/**
 * **R4 · C16 · OB-208 · OB-209 — hours worked, overtime and the minimum wage (the real API, in memory and on real
 * PostgreSQL, with a cold restart).** The hours come from the attendance store; the roles and the ordinary hourly rate
 * from the staff directory. Until the CA fills the normal hours and the minimum wage, the pay run says "overtime limit
 * not set" and "minimum wage not checked" and assumes nothing. Once filled: a multiplier or a rate below twice the
 * ordinary rate is refused ("overtime below 2×"); a month's pay below the class minimum is refused ("below minimum
 * wage"); overtime above the normal hours is paid and shown on the employee's own payslip. Figures are SYNTHETIC.
 */

beforeAll(openDatabase);
afterAll(closeDatabase);

const PERIOD = '2030-07'; // starts on a Monday
const body = (monthlyMinor: number, extra: Record<string, unknown> = {}) => ({
  onDate: '2099-12-31', attendance: { calendarDaysInMonth: 31, paidDays: 31 }, components: [{ code: 'BASIC', monthlyMinor, partOfPfWage: true }], ...extra,
});
type Prepared = { payslip: { earnings: { code: string; earnedMinor: number }[]; grossMinor: number; statutoryChecks: { hoursWorked: { totalWorkedMinutes: number }; overtime: { overtimeMinutes: number | null; pay: { status: string; payMinor: number | null } }; minimumWage: { status: string } } }; notChecked: string[] };

describe.each(backings())('overtime at least double; below minimum refused — on $name (C16)', ({ harness, restart }) => {
  it('not set → said and nothing assumed; set → overtime paid at ≥2×, a lower rate and a pay below the minimum refused', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-ca', 'chartered_accountant');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'e1', 'cashier');
    const c = caller(() => h, T);
    const { req, ok } = c;
    await addStaff(c, 'e1', { roles: ['cashier'], hourlyRateMinor: 10_000 });
    await addStaff(c, 'e2', { roles: ['picker'] }); // no hourly rate in the directory
    // Week 1: 10, 9, then 8 hours a day for five days (59 hours).
    for (const [i, hrs] of [10, 9, 8, 8, 8, 8, 8].entries()) await ok(req('POST', `/v1/hr/workforce/attendance/e1/${PERIOD}-0${i + 1}`, { hours: hrs }), 'hours e1');
    await ok(req('POST', `/v1/hr/workforce/attendance/e2/${PERIOD}-01`, { hours: 11 }), 'hours e2');
    const prepare = (e: string, b: unknown) => req('POST', `/v1/hr/payroll/statutory-payslips/${e}/${PERIOD}`, b);

    // ── Nothing filled: before any payslip the settings say so; after, the pay run says what was not checked ─────────
    const empty = (await ok(req('GET', `/v1/hr/payroll/statutory-check/${PERIOD}`), 'check empty')).body as { payRunSays: string[] };
    expect(empty.payRunSays).toContain('Normal hours a day — work above this is overtime — not confirmed');
    const unset = (await ok(prepare('e1', body(1_500_000)), 'prepare unset')).body as Prepared;
    expect(unset.payslip.statutoryChecks.hoursWorked.totalWorkedMinutes).toBe(59 * 60);
    expect(unset.payslip.statutoryChecks.overtime).toMatchObject({ overtimeMinutes: null, pay: { status: 'limit_not_set', payMinor: null } });
    expect(unset.payslip.earnings.map((e) => e.code)).toEqual(['BASIC']);
    const says = ((await ok(req('GET', `/v1/hr/payroll/statutory-check/${PERIOD}`), 'check')).body as { payRunSays: string[] }).payRunSays;
    expect(says).toEqual(expect.arrayContaining([
      'minimum wage not checked: no minimum-wage class is set for the role cashier',
      'overtime limit not set: Normal hours a day — work above this is overtime — not confirmed',
      'overtime limit not set: Normal hours a week (Monday to Sunday) — work above this is overtime — not confirmed',
    ]));

    // ── The CA fills the normal hours, the multiplier and the class minimum ─────────────────────────────────────────
    const set = (key: string, b: Record<string, unknown>, who = 'u-ca') => req('POST', `/v1/hr/payroll/legal-settings/${key}`, { source: 'TEST FIGURE — synthetic', confirmation: 'CA (test) ref W-1', ...b }, who);
    expect((await set('normalDailyMinutes', { value: 480 }, 'u-mgr')).status).toBe(403);
    await ok(set('normalDailyMinutes', { value: 480 }), 'daily');
    await ok(set('normalWeeklyMinutes', { value: 2880 }), 'weekly');
    const low = await set('overtimeMultiplierPercent', { value: 150 });
    expect(low.status).toBe(422);
    expect(codeOf(low)).toBe('overtime_below_2x');
    await ok(set('overtimeMultiplierPercent', { value: 200 }), 'multiplier');
    expect(codeOf(await set('minimum-wage-shop-a', { label: 'Shop assistants (test)', roles: [] }))).toBe('not_a_minimum_wage_class');
    await ok(set('minimum-wage-shop-a', { label: 'Shop assistants (test)', roles: ['cashier'], monthlyMinor: 1_400_000 }), 'class');

    // A COLD RESTART: the settings come back from the store.
    h = restart(h);
    const below2x = await prepare('e1', body(1_500_000, { overtimeHourlyRateMinor: 15_000 }));
    expect(below2x.status).toBe(422);
    expect(codeOf(below2x)).toBe('overtime_below_2x');
    expect(whatOf(below2x)).toBe('overtime below 2×: ₹150.00 an hour is less than twice the ordinary hourly rate of ₹100.00');
    const belowMin = await prepare('e1', body(1_399_900));
    expect(belowMin.status).toBe(422);
    expect(codeOf(belowMin)).toBe('below_minimum_wage');
    expect(whatOf(belowMin)).toContain('below minimum wage');
    // Neither refusal replaced the payslip prepared before.
    expect(((await ok(req('GET', `/v1/hr/payroll/statutory-check/${PERIOD}`), 'check after')).body as { payslips: { employeeId: string; grossMinor: number }[] }).payslips).toEqual([expect.objectContaining({ employeeId: 'e1', grossMinor: 1_500_000 })]);

    // Overtime: 59h − 48h = 11 hours at 2 × ₹100.
    const paid = (await ok(prepare('e1', body(1_500_000)), 'prepare set')).body as Prepared;
    expect(paid.payslip.statutoryChecks.overtime).toMatchObject({ overtimeMinutes: 660, pay: { status: 'paid', payMinor: 220_000 } });
    expect(paid.payslip.earnings.find((e) => e.code === 'OVERTIME')?.earnedMinor).toBe(220_000);
    expect(paid.payslip.statutoryChecks.minimumWage.status).toBe('met');
    expect(paid.notChecked.some((w) => w.startsWith('minimum wage not checked') || w.startsWith('overtime limit not set'))).toBe(false);

    // e2 has no hourly rate in the directory: 3 hours over, not paid, and said; their role has no class — not checked.
    const e2 = (await ok(prepare('e2', body(1_000_000)), 'prepare e2')).body as Prepared;
    expect(e2.payslip.statutoryChecks.overtime.pay).toMatchObject({ status: 'ordinary_rate_unknown', payMinor: null });
    expect(e2.notChecked).toEqual(expect.arrayContaining(['minimum wage not checked: no minimum-wage class is set for the role picker']));

    // The employee sees their own hours and overtime on their payslip.
    await ok(req('POST', `/v1/hr/payroll/payslips/e1/${PERIOD}`, { payslip: paid.payslip }), 'issue');
    const mine = (await ok(req('GET', '/v1/hr/payroll/my-payslip', undefined, 'e1'), 'my payslip')).body as { view: { earnings: { code: string; amountMinor: number }[]; statutoryNotes: { totalWorkedMinutes: number; hoursWorked: unknown[]; overtime: { overtimeMinutes: number; payMinor: number } } } };
    expect(mine.view.statutoryNotes).toMatchObject({ totalWorkedMinutes: 3540, overtime: { overtimeMinutes: 660, payMinor: 220_000 } });
    expect(mine.view.statutoryNotes.hoursWorked).toHaveLength(7);
    expect(mine.view.earnings).toContainEqual({ code: 'OVERTIME', amountMinor: 220_000 });
  });
});
