import { describe, it, expect } from 'vitest';
import {
  resolveTdsParams,
  computeTds,
  computeStatutoryDeductions,
  resolveStatutoryParams,
  DEFAULT_TDS_SCHEDULE,
  DEFAULT_STATUTORY_SCHEDULE,
  InvalidStatutorySchedule,
  type TdsParams,
} from '../../packages/payroll/src/index';

const TDS: TdsParams = resolveTdsParams(DEFAULT_TDS_SCHEDULE, '2026-08-01');

describe('resolveTdsParams — effective-dated', () => {
  it('resolves and refuses a pre-schedule / bad date', () => {
    expect(TDS.cessBps).toBe(400);
    expect(() => resolveTdsParams(DEFAULT_TDS_SCHEDULE, '2020-01-01')).toThrow(InvalidStatutorySchedule);
    expect(() => resolveTdsParams(DEFAULT_TDS_SCHEDULE, 'nope')).toThrow(InvalidStatutorySchedule);
  });
});

describe('computeTds — new regime', () => {
  it('taxes ₹15,00,000 with the standard deduction, slabs and 4% cess, spread over 12 months', () => {
    const r = computeTds({ annualGrossIncomeMinor: 150_000_000, regime: 'new', params: TDS });
    expect(r.annualTax.taxableIncomeMinor).toBe(142_500_000); // − ₹75,000 standard deduction
    expect(r.annualTax.grossTaxMinor).toBe(9_375_000); // ₹93,750
    expect(r.annualTax.cessMinor).toBe(375_000); // 4%
    expect(r.annualTax.totalTaxMinor).toBe(9_750_000); // ₹97,500
    expect(r.tdsMonthlyMinor).toBe(812_500); // ₹8,125 / month
  });

  it('applies the 87A rebate to make tax nil at ₹12,50,000', () => {
    const r = computeTds({ annualGrossIncomeMinor: 125_000_000, regime: 'new', params: TDS });
    expect(r.annualTax.grossTaxMinor).toBe(5_750_000);
    expect(r.annualTax.rebate87AMinor).toBe(5_750_000); // full rebate
    expect(r.annualTax.totalTaxMinor).toBe(0);
    expect(r.tdsMonthlyMinor).toBe(0);
  });

  it('spreads the balance over the remaining months after tax already deducted', () => {
    const r = computeTds({ annualGrossIncomeMinor: 150_000_000, regime: 'new', params: TDS, tdsAlreadyDeductedMinor: 4_000_000, monthsRemaining: 6 });
    expect(r.tdsMonthlyMinor).toBe(958_300); // (₹97,500 − ₹40,000) / 6
  });
});

describe('computeTds — old regime honours declared deductions', () => {
  it('taxes ₹8,00,000 less ₹50k standard + ₹1,50,000 declared', () => {
    const r = computeTds({ annualGrossIncomeMinor: 80_000_000, regime: 'old', params: TDS, declaredDeductionsMinor: 15_000_000 });
    expect(r.annualTax.taxableIncomeMinor).toBe(60_000_000); // ₹6,00,000
    expect(r.annualTax.grossTaxMinor).toBe(3_250_000); // ₹32,500
    expect(r.annualTax.totalTaxMinor).toBe(3_380_000); // + 4% cess
    expect(r.tdsMonthlyMinor).toBe(281_700);
  });

  it('rejects impossible inputs', () => {
    expect(() => computeTds({ annualGrossIncomeMinor: -1, regime: 'new', params: TDS })).toThrow(InvalidStatutorySchedule);
    expect(() => computeTds({ annualGrossIncomeMinor: 150_000_000, regime: 'new', params: TDS, monthsRemaining: 0 })).toThrow(InvalidStatutorySchedule);
    expect(() => computeTds({ annualGrossIncomeMinor: 150_000_000, regime: 'new', params: TDS, monthsRemaining: 13 })).toThrow(InvalidStatutorySchedule);
  });
});

describe('computeStatutoryDeductions folds TDS into the total (backward compatible)', () => {
  const PARAMS = resolveStatutoryParams(DEFAULT_STATUTORY_SCHEDULE, '2026-08-01');
  it('adds TDS to the deductions and subtracts it from net', () => {
    const without = computeStatutoryDeductions({ grossMinor: 1_800_000, pfWageMinor: 1_800_000, params: PARAMS });
    const withTds = computeStatutoryDeductions({ grossMinor: 1_800_000, pfWageMinor: 1_800_000, params: PARAMS, tdsMonthlyMinor: 50_000 });
    expect(without.tdsMinor).toBe(0); // default, unchanged behaviour
    expect(withTds.tdsMinor).toBe(50_000);
    expect(withTds.totalEmployeeDeductionMinor).toBe(without.totalEmployeeDeductionMinor + 50_000);
    expect(withTds.netPayMinor).toBe(without.netPayMinor - 50_000);
  });
});
