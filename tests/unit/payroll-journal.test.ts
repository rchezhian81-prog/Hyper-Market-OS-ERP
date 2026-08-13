import { describe, it, expect } from 'vitest';
import {
  buildPayrollJournal,
  InvalidPayrollJournal,
  type PayrollTotals,
} from '../../packages/payroll/src/index';

// A balanced run: net = gross − (PF + ESI + PT + TDS) employee shares.
const TOTALS: PayrollTotals = {
  grossMinor: 1_600_000,
  pfEmployeeMinor: 144_000, pfEmployerMinor: 144_000,
  esiEmployeeMinor: 12_000, esiEmployerMinor: 52_000,
  professionalTaxMinor: 2_250, tdsMinor: 50_000,
  netMinor: 1_391_750,
};

const amountOf = (j: ReturnType<typeof buildPayrollJournal>, account: string): number =>
  j.lines.filter((l) => l.account === account).reduce((s, l) => s + l.amountMinor, 0);

describe('buildPayrollJournal — balanced double entry from a locked run', () => {
  it('debits salaries + employer PF/ESI and credits net + each payable, balanced', () => {
    const j = buildPayrollJournal({ payRunState: 'locked', payPeriod: '2026-08', totals: TOTALS });
    expect(j.totalDebitMinor).toBe(1_796_000);
    expect(j.totalCreditMinor).toBe(1_796_000);
    expect(j.balanced).toBe(true);
    expect(amountOf(j, 'Salaries & Wages')).toBe(1_600_000);
    expect(amountOf(j, 'Employer PF Contribution')).toBe(144_000);
    expect(amountOf(j, 'Net Pay Payable')).toBe(1_391_750);
    expect(amountOf(j, 'PF Payable')).toBe(288_000); // employee + employer
    expect(amountOf(j, 'ESI Payable')).toBe(64_000);
    expect(amountOf(j, 'Professional Tax Payable')).toBe(2_250);
    expect(amountOf(j, 'TDS Payable')).toBe(50_000);
  });

  it('splits the salary expense across cost-centres that sum to gross', () => {
    const j = buildPayrollJournal({
      payRunState: 'locked', payPeriod: '2026-08', totals: TOTALS,
      costCentres: [{ code: 'STORE', grossMinor: 1_000_000 }, { code: 'WAREHOUSE', grossMinor: 600_000 }],
    });
    const salary = j.lines.filter((l) => l.account === 'Salaries & Wages');
    expect(salary).toHaveLength(2);
    expect(salary.map((l) => l.costCentre).sort()).toEqual(['STORE', 'WAREHOUSE']);
    expect(amountOf(j, 'Salaries & Wages')).toBe(1_600_000);
    expect(j.totalDebitMinor).toBe(j.totalCreditMinor);
  });

  it('omits zero lines (no PT/TDS when there is none)', () => {
    const j = buildPayrollJournal({ payRunState: 'locked', payPeriod: '2026-08', totals: { ...TOTALS, professionalTaxMinor: 0, tdsMinor: 0, netMinor: 1_444_000 } });
    expect(j.lines.some((l) => l.account === 'Professional Tax Payable')).toBe(false);
    expect(j.lines.some((l) => l.account === 'TDS Payable')).toBe(false);
    expect(j.totalDebitMinor).toBe(j.totalCreditMinor);
  });

  it('refuses a run that is not locked', () => {
    for (const state of ['draft', 'submitted', 'approved', 'reversed'] as const) {
      expect(() => buildPayrollJournal({ payRunState: state, payPeriod: '2026-08', totals: TOTALS })).toThrow(InvalidPayrollJournal);
    }
  });

  it('refuses an unbalanced run and a cost-centre split that does not sum to gross', () => {
    expect(() => buildPayrollJournal({ payRunState: 'locked', payPeriod: '2026-08', totals: { ...TOTALS, netMinor: 1_500_000 } })).toThrow(/does not balance/);
    expect(() => buildPayrollJournal({ payRunState: 'locked', payPeriod: '2026-08', totals: TOTALS, costCentres: [{ code: 'X', grossMinor: 1_000_000 }] })).toThrow(/does not sum/);
    expect(() => buildPayrollJournal({ payRunState: 'locked', payPeriod: '2026-08', totals: { ...TOTALS, grossMinor: -1 } })).toThrow(InvalidPayrollJournal);
  });
});
