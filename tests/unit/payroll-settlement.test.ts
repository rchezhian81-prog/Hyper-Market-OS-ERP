import { describe, it, expect } from 'vitest';
import {
  computeGratuity,
  computeSettlement,
  resolveSettlementParams,
  DEFAULT_SETTLEMENT_SCHEDULE,
  InvalidStatutorySchedule,
  type SettlementParams,
} from '../../packages/payroll/src/index';

// All amounts in integer paise. ₹1 = 100 paise.
const PARAMS: SettlementParams = resolveSettlementParams(DEFAULT_SETTLEMENT_SCHEDULE, '2026-08-13');

describe('computeGratuity — 15/26 × last-drawn × completed years, ≥5 yr, capped at ₹20L', () => {
  it('pays nothing below the minimum service, pays from the boundary year', () => {
    // last-drawn basic+DA ₹26,000; the 5-year eligibility boundary.
    const lastDrawn = 2_600_000;
    expect(computeGratuity({ completedYears: 4, lastDrawnBasicDaMinor: lastDrawn, params: PARAMS.gratuity }))
      .toMatchObject({ eligible: false, gratuityMinor: 0 });
    // 5 completed years: (2,600,000 × 5 × 15) / 26 = ₹75,000.
    expect(computeGratuity({ completedYears: 5, lastDrawnBasicDaMinor: lastDrawn, params: PARAMS.gratuity }))
      .toMatchObject({ eligible: true, gratuityMinor: 7_500_000, cappedAtCeiling: false });
  });

  it('caps a large gratuity at the statutory ceiling ₹20,00,000', () => {
    // last-drawn ₹5,00,000 over 20 years = far above the ceiling → capped.
    const g = computeGratuity({ completedYears: 20, lastDrawnBasicDaMinor: 50_000_000, params: PARAMS.gratuity });
    expect(g.eligible).toBe(true);
    expect(g.cappedAtCeiling).toBe(true);
    expect(g.gratuityMinor).toBe(200_000_000); // ₹20,00,000
  });

  it('rejects fractional or negative inputs', () => {
    expect(() => computeGratuity({ completedYears: 5.5, lastDrawnBasicDaMinor: 2_600_000, params: PARAMS.gratuity })).toThrow(InvalidStatutorySchedule);
    expect(() => computeGratuity({ completedYears: 5, lastDrawnBasicDaMinor: -1, params: PARAMS.gratuity })).toThrow(InvalidStatutorySchedule);
  });
});

describe('computeSettlement — itemised earnings − recoveries → signed net', () => {
  it('nets a positive settlement payable to the employee (worked example)', () => {
    // pending ₹20,000 + leave 10 days × ₹1,000 + gratuity (10 yr × ₹26,000 last-drawn = ₹1,50,000)
    // = gross ₹1,80,000; recoveries notice ₹5,000 + loan ₹20,000 = ₹25,000 → net ₹1,55,000 payable.
    const s = computeSettlement({
      pendingSalaryMinor: 2_000_000,
      leaveEncashment: { unusedLeaveDays: 10, perDayBasicMinor: 100_000 },
      gratuity: { completedYears: 10, lastDrawnBasicDaMinor: 2_600_000 },
      noticeRecoveryMinor: 500_000,
      loanRecoveryMinor: 2_000_000,
      params: PARAMS,
    });
    expect(s.gratuity.gratuityMinor).toBe(15_000_000); // ₹1,50,000
    expect(s.grossEarningsMinor).toBe(18_000_000); // ₹1,80,000
    expect(s.totalRecoveriesMinor).toBe(2_500_000); // ₹25,000
    expect(s.netSettlementMinor).toBe(15_500_000); // ₹1,55,000
    expect(s.payableToEmployee).toBe(true);
    expect(s.confirmWithCa).toBe(true);
    // Itemised: four earning lines, two recovery lines; zero lines omitted.
    expect(s.earnings.map((l) => l.label)).toEqual(['Pending salary', 'Leave encashment', 'Gratuity']);
    expect(s.recoveries.map((l) => l.label)).toEqual(['Notice-period recovery', 'Loan/advance recovery']);
  });

  it('caps leave encashment at capDays', () => {
    // 30 unused days, capped at 15, at ₹1,000/day = ₹15,000.
    const s = computeSettlement({
      pendingSalaryMinor: 0,
      leaveEncashment: { unusedLeaveDays: 30, perDayBasicMinor: 100_000, capDays: 15 },
      params: PARAMS,
    });
    expect(s.earnings.find((l) => l.label === 'Leave encashment')?.amountMinor).toBe(1_500_000);
    expect(s.grossEarningsMinor).toBe(1_500_000);
  });

  it('nets a negative settlement recoverable from the employee when recoveries exceed dues', () => {
    // pending ₹10,000, no gratuity, loan recovery ₹50,000 → net −₹40,000 recoverable.
    const s = computeSettlement({
      pendingSalaryMinor: 1_000_000,
      loanRecoveryMinor: 5_000_000,
      params: PARAMS,
    });
    expect(s.netSettlementMinor).toBe(-4_000_000);
    expect(s.payableToEmployee).toBe(false);
    expect(s.gratuity.eligible).toBe(false);
  });

  it('omits gratuity when service is short, and includes tax as a recovery', () => {
    const s = computeSettlement({
      pendingSalaryMinor: 3_000_000,
      gratuity: { completedYears: 3, lastDrawnBasicDaMinor: 2_600_000 }, // below 5 years
      statutoryDeductionMinor: 200_000,
      params: PARAMS,
    });
    expect(s.earnings.some((l) => l.label === 'Gratuity')).toBe(false);
    expect(s.recoveries.map((l) => l.label)).toEqual(['Tax / statutory']);
    expect(s.netSettlementMinor).toBe(2_800_000);
  });

  it('rejects malformed money and a missing schedule', () => {
    expect(() => computeSettlement({ pendingSalaryMinor: -1, params: PARAMS })).toThrow(InvalidStatutorySchedule);
    expect(() => computeSettlement({ pendingSalaryMinor: 100, noticeRecoveryMinor: 1.5, params: PARAMS })).toThrow(InvalidStatutorySchedule);
    expect(() => resolveSettlementParams([], '2026-08-13')).toThrow(InvalidStatutorySchedule);
    expect(() => resolveSettlementParams(DEFAULT_SETTLEMENT_SCHEDULE, 'not-a-date')).toThrow(InvalidStatutorySchedule);
    // A gap: an exit date before the earliest schedule entry.
    expect(() => resolveSettlementParams(DEFAULT_SETTLEMENT_SCHEDULE, '2000-01-01')).toThrow(InvalidStatutorySchedule);
  });
});
