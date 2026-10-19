import { describe, it, expect } from 'vitest';
import {
  checkParticulars, assertParticulars, payslipsLateForPayDate, localDate, PayslipParticularMissing, PAYSLIP_PARTICULAR_KEYS,
  type ParticularsList, type Payslip,
} from '../../packages/payroll/src/index';

/**
 * **R4 · C15 · OB-208 — the payslip particulars and the pay-date clock (the pure engine).** "Every payslip carries each
 * particular on the CA's list. One missing a listed particular cannot be issued ('payslip particular missing: <name>'). A
 * payslip not issued by the pay date reaches the owner as an exception. … Until the CA fills the list, each particular
 * shows 'not confirmed' on the payslip and nothing is guessed."
 */

const PAYSLIP = {
  onDate: '2030-05-31', calendarDaysInMonth: 31, paidDays: 30, lopDays: 1,
  earnings: [{ code: 'BASIC', fullMonthMinor: 1_000_000, earnedMinor: 967_742 }], grossMinor: 967_742, pfWageMinor: 967_742,
  statutory: { pfEmployeeMinor: 0, pfEmployerMinor: 0, esiApplicable: false, esiEmployeeMinor: 0, esiEmployerMinor: 0, professionalTaxMinor: 0, tdsMinor: 0, totalEmployeeDeductionMinor: 0, totalEmployerContributionMinor: 0, netPayMinor: 967_742, detail: '' },
  netPayMinor: 967_742, confirmWithCa: true, detail: '',
} as Payslip;
const UNSET: ParticularsList = { particulars: null, source: null, confirmation: null };
const LIST: ParticularsList = { particulars: ['employerName', 'employeeName', 'payPeriod', 'netPay', 'hoursWorked'], source: 'Code on Wages rules (test)', confirmation: 'CA (test) ref P-1' };

describe('the particulars list', () => {
  it('until the CA confirms the list, every particular shows "not confirmed" and nothing is refused or guessed', () => {
    const c = checkParticulars(UNSET, { employeeId: 'e1', period: '2030-05', payslip: PAYSLIP, supplied: {} });
    expect(c.listStatus).toBe('not_confirmed');
    expect(c.lines).toHaveLength(PAYSLIP_PARTICULAR_KEYS.length);
    expect(c.lines.every((l) => l.status === 'not_confirmed')).toBe(true);
    expect(c.missing).toEqual([]);
    expect(() => assertParticulars(UNSET, { employeeId: 'e1', period: '2030-05', payslip: PAYSLIP, supplied: {} })).not.toThrow();
    // A list with no confirmation is still not confirmed.
    expect(checkParticulars({ ...LIST, confirmation: null }, { employeeId: 'e1', period: '2030-05', payslip: PAYSLIP, supplied: {} }).listStatus).toBe('not_confirmed');
  });

  it('a confirmed list: each listed particular is carried or missing; the rest are not required', () => {
    const c = checkParticulars(LIST, { employeeId: 'e1', period: '2030-05', payslip: PAYSLIP, supplied: { employerName: 'SRE Hyper Market (test)' } });
    expect(c.listStatus).toBe('confirmed');
    const by = Object.fromEntries(c.lines.map((l) => [l.key, l.status]));
    expect(by).toMatchObject({ employerName: 'carried', payPeriod: 'carried', netPay: 'carried', employeeName: 'missing', hoursWorked: 'missing', uan: 'not_required' });
    expect(c.missing).toEqual(['employeeName', 'hoursWorked']);
  });

  it('one missing a listed particular cannot be issued — refused by name', () => {
    const run = () => assertParticulars(LIST, { employeeId: 'e1', period: '2030-05', payslip: PAYSLIP, supplied: { employerName: 'SRE', employeeName: '  ' } });
    expect(run).toThrow(PayslipParticularMissing);
    expect(run).toThrow('payslip particular missing: Name of the employee; payslip particular missing: Hours actually worked');
  });

  it('a payslip prepared with the statutory checks carries the hours worked', () => {
    const withHours = { ...PAYSLIP, statutoryChecks: { hoursWorked: { days: [], totalWorkedMinutes: 0 }, overtime: {} } };
    expect(assertParticulars(LIST, { employeeId: 'e1', period: '2030-05', payslip: withHours, supplied: { employerName: 'SRE', employeeName: 'Asha R' } }).missing).toEqual([]);
  });
});

describe('the pay-date clock', () => {
  it('reads the issue time in store-local time: 23:00 IST on the pay date is on time, 00:30 IST the next day is late', () => {
    expect(localDate('2030-05-31T17:30:00Z', 330)).toBe('2030-05-31'); // 23:00 IST
    expect(localDate('2030-05-31T19:00:00Z', 330)).toBe('2030-06-01'); // 00:30 IST
    const late = payslipsLateForPayDate({
      today: '2030-06-10', utcOffsetMinutes: 330,
      expected: [
        { employeeId: 'e1', period: '2030-05', payDate: '2030-05-31', issuedAt: '2030-05-31T17:30:00Z' },
        { employeeId: 'e2', period: '2030-05', payDate: '2030-05-31', issuedAt: '2030-05-31T19:00:00Z' },
        { employeeId: 'e3', period: '2030-05', payDate: '2030-05-31' },
        { employeeId: 'e4', period: '2030-05', payDate: '2030-06-15' },
      ],
    });
    expect(late.map((l) => [l.employeeId, l.kind])).toEqual([['e2', 'issued_after_pay_date'], ['e3', 'not_issued_by_pay_date']]);
    expect(late[1]!.detail).toBe("e3's payslip for 2030-05 was not issued by the pay date 2030-05-31");
  });

  it('on the pay date itself an unissued payslip is not yet late', () => {
    expect(payslipsLateForPayDate({ today: '2030-05-31', utcOffsetMinutes: 330, expected: [{ employeeId: 'e1', period: '2030-05', payDate: '2030-05-31' }] })).toEqual([]);
  });
});
