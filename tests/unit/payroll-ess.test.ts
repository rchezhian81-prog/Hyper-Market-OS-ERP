import { describe, it, expect } from 'vitest';
import {
  employeeSelfView,
  assertSelfScope,
  EssAccessDenied,
  InvalidEssInput,
  type Payslip,
  type Settlement,
} from '../../packages/payroll/src/index';

// A well-formed payslip for employee "u-asha" (₹30,000 gross; ESI not applicable, so its lines are zero).
const PAYSLIP: Payslip = {
  onDate: '2026-08-31',
  calendarDaysInMonth: 31,
  paidDays: 31,
  lopDays: 0,
  earnings: [
    { code: 'BASIC', fullMonthMinor: 2_000_000, earnedMinor: 2_000_000 },
    { code: 'HRA', fullMonthMinor: 1_000_000, earnedMinor: 1_000_000 },
  ],
  grossMinor: 3_000_000,
  pfWageMinor: 2_000_000,
  statutory: {
    pfEmployeeMinor: 240_000, pfEmployerMinor: 240_000,
    esiApplicable: false, esiEmployeeMinor: 0, esiEmployerMinor: 0,
    professionalTaxMinor: 20_800, tdsMinor: 100_000,
    totalEmployeeDeductionMinor: 360_800,
    totalEmployerContributionMinor: 240_000,
    netPayMinor: 2_639_200,
    detail: 'stub',
  },
  netPayMinor: 2_639_200,
  confirmWithCa: true,
  detail: 'stub',
};

const SETTLEMENT: Settlement = {
  earnings: [{ label: 'Pending salary', kind: 'earning', amountMinor: 2_000_000 }],
  recoveries: [{ label: 'Loan/advance recovery', kind: 'recovery', amountMinor: 500_000 }],
  grossEarningsMinor: 2_000_000,
  totalRecoveriesMinor: 500_000,
  netSettlementMinor: 1_500_000,
  payableToEmployee: true,
  gratuity: { eligible: false, gratuityMinor: 0, cappedAtCeiling: false, detail: 'no gratuity claimed' },
  confirmWithCa: true,
  detail: 'stub',
};

describe('assertSelfScope — an employee may read only their own record', () => {
  it('allows the caller their own id, refuses another, refuses blanks', () => {
    expect(() => assertSelfScope({ requesterEmployeeId: 'u-asha', subjectEmployeeId: 'u-asha' })).not.toThrow();
    expect(() => assertSelfScope({ requesterEmployeeId: 'u-asha', subjectEmployeeId: 'u-bala' })).toThrow(EssAccessDenied);
    expect(() => assertSelfScope({ requesterEmployeeId: '', subjectEmployeeId: 'u-asha' })).toThrow(EssAccessDenied);
    expect(() => assertSelfScope({ requesterEmployeeId: 'u-asha', subjectEmployeeId: '' })).toThrow(EssAccessDenied);
  });
});

describe('employeeSelfView — self-scoped, redacted own payslip', () => {
  it('returns the employee’s own earnings, deductions and net', () => {
    const v = employeeSelfView({ requesterEmployeeId: 'u-asha', subjectEmployeeId: 'u-asha', payslip: PAYSLIP });
    expect(v.employeeId).toBe('u-asha');
    expect(v.payPeriod).toBe('2026-08-31');
    expect(v.grossMinor).toBe(3_000_000);
    expect(v.netPayMinor).toBe(2_639_200);
    expect(v.earnings.map((e) => e.code)).toEqual(['BASIC', 'HRA']);
    // Employee deductions itemised; the zero ESI line is omitted.
    expect(v.deductions.map((d) => d.label)).toEqual(['Provident Fund (your share)', 'Professional Tax', 'Income Tax (TDS)']);
    expect(v.totalDeductionsMinor).toBe(360_800);
    expect(v.confirmWithCa).toBe(true);
  });

  it('shows employer cost SEPARATELY, never as a deduction from the employee', () => {
    const v = employeeSelfView({ requesterEmployeeId: 'u-asha', subjectEmployeeId: 'u-asha', payslip: PAYSLIP });
    // The employer PF is in employerContributions, not in deductions.
    expect(v.employerContributions.totalMinor).toBe(240_000);
    expect(v.employerContributions.lines.map((l) => l.label)).toEqual(['Provident Fund (employer)']);
    expect(v.deductions.some((d) => /employer/i.test(d.label))).toBe(false);
  });

  it('redacts — the view carries no raw statutory/cost-centre/approver internals', () => {
    const v = employeeSelfView({ requesterEmployeeId: 'u-asha', subjectEmployeeId: 'u-asha', payslip: PAYSLIP });
    expect(Object.keys(v).sort()).toEqual([
      'confirmWithCa', 'deductions', 'earnings', 'employeeId', 'employerContributions',
      'grossMinor', 'netPayMinor', 'payPeriod', 'totalDeductionsMinor',
    ]);
    expect((v as unknown as Record<string, unknown>)['statutory']).toBeUndefined();
    expect((v as unknown as Record<string, unknown>)['pfWageMinor']).toBeUndefined();
  });

  it('includes a leaver’s own final-settlement summary when present', () => {
    const v = employeeSelfView({ requesterEmployeeId: 'u-asha', subjectEmployeeId: 'u-asha', payslip: PAYSLIP, settlement: SETTLEMENT });
    expect(v.settlement).toBeDefined();
    expect(v.settlement?.netSettlementMinor).toBe(1_500_000);
    expect(v.settlement?.payableToEmployee).toBe(true);
    expect(v.settlement?.earnings.map((l) => l.label)).toEqual(['Pending salary']);
    expect(v.settlement?.recoveries.map((l) => l.label)).toEqual(['Loan/advance recovery']);
  });

  it('refuses to build a view for anyone but the caller', () => {
    expect(() => employeeSelfView({ requesterEmployeeId: 'u-asha', subjectEmployeeId: 'u-bala', payslip: PAYSLIP })).toThrow(EssAccessDenied);
  });

  it('refuses a malformed payslip', () => {
    expect(() => employeeSelfView({ requesterEmployeeId: 'u-asha', subjectEmployeeId: 'u-asha', payslip: {} as unknown as Payslip })).toThrow(InvalidEssInput);
    const noStatutory = { ...PAYSLIP, statutory: undefined } as unknown as Payslip;
    expect(() => employeeSelfView({ requesterEmployeeId: 'u-asha', subjectEmployeeId: 'u-asha', payslip: noStatutory })).toThrow(InvalidEssInput);
  });
});
