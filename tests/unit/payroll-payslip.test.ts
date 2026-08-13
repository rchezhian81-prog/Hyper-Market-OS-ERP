import { describe, it, expect } from 'vitest';
import {
  resolveCompensation,
  buildPayslip,
  resolveStatutoryParams,
  DEFAULT_STATUTORY_SCHEDULE,
  InvalidStatutorySchedule,
  type CompensationComponent,
  type StatutoryParams,
} from '../../packages/payroll/src/index';

const PARAMS: StatutoryParams = resolveStatutoryParams(DEFAULT_STATUTORY_SCHEDULE, '2026-08-01');

// Basic ₹12,000 (PF wage), HRA ₹4,000 → full-month gross ₹16,000 (within the ESI ceiling).
const COMPONENTS: readonly CompensationComponent[] = [
  { code: 'BASIC', monthlyMinor: 1_200_000, partOfPfWage: true },
  { code: 'HRA', monthlyMinor: 400_000 },
];

describe('resolveCompensation — effective-dated, refuses a gap', () => {
  const history = [
    { effectiveFrom: '2026-01-01', components: COMPONENTS },
    { effectiveFrom: '2026-07-01', components: [{ code: 'BASIC', monthlyMinor: 1_500_000, partOfPfWage: true }] },
  ];
  it('takes the structure in force on the pay date', () => {
    expect(resolveCompensation(history, '2026-06-30')[0]!.monthlyMinor).toBe(1_200_000);
    expect(resolveCompensation(history, '2026-07-01')[0]!.monthlyMinor).toBe(1_500_000); // boundary — the raise
  });
  it('refuses a date before the earliest structure, an empty history, and a bad date', () => {
    expect(() => resolveCompensation(history, '2025-12-31')).toThrow(InvalidStatutorySchedule);
    expect(() => resolveCompensation([], '2026-08-01')).toThrow(InvalidStatutorySchedule);
    expect(() => resolveCompensation(history, 'nope')).toThrow(InvalidStatutorySchedule);
  });
});

describe('buildPayslip — earnings → gross + PF wage → statutory → net', () => {
  it('builds a full-month payslip', () => {
    const p = buildPayslip({ onDate: '2026-08-01', components: COMPONENTS, attendance: { calendarDaysInMonth: 31, paidDays: 31 }, params: PARAMS });
    expect(p.grossMinor).toBe(1_600_000);
    expect(p.pfWageMinor).toBe(1_200_000);
    expect(p.statutory.pfEmployeeMinor).toBe(144_000); // 12% of ₹12,000
    expect(p.statutory.esiApplicable).toBe(true);
    expect(p.statutory.esiEmployeeMinor).toBe(12_000); // 0.75% of ₹16,000
    expect(p.netPayMinor).toBe(1_600_000 - 144_000 - 12_000);
    expect(p.lopDays).toBe(0);
  });

  it('prorates every earning AND the PF wage for loss of pay', () => {
    const p = buildPayslip({ onDate: '2026-08-01', components: COMPONENTS, attendance: { calendarDaysInMonth: 30, paidDays: 15 }, params: PARAMS });
    expect(p.lopDays).toBe(15);
    expect(p.earnings.find((e) => e.code === 'BASIC')!.earnedMinor).toBe(600_000); // half of ₹12,000
    expect(p.grossMinor).toBe(800_000); // half of ₹16,000
    expect(p.pfWageMinor).toBe(600_000);
    expect(p.statutory.pfEmployeeMinor).toBe(72_000); // 12% of the reduced PF wage
    expect(p.netPayMinor).toBe(800_000 - 72_000 - 6_000);
  });

  it('excludes a non-gross component from gross but still lists it', () => {
    const withReimb: CompensationComponent[] = [...COMPONENTS, { code: 'REIMB', monthlyMinor: 300_000, partOfGross: false }];
    const p = buildPayslip({ onDate: '2026-08-01', components: withReimb, attendance: { calendarDaysInMonth: 31, paidDays: 31 }, params: PARAMS });
    expect(p.grossMinor).toBe(1_600_000); // reimbursement not in gross
    expect(p.earnings.some((e) => e.code === 'REIMB')).toBe(true);
  });

  it('rejects impossible attendance, empty compensation, and a negative amount', () => {
    expect(() => buildPayslip({ onDate: '2026-08-01', components: COMPONENTS, attendance: { calendarDaysInMonth: 40, paidDays: 30 }, params: PARAMS })).toThrow(InvalidStatutorySchedule);
    expect(() => buildPayslip({ onDate: '2026-08-01', components: COMPONENTS, attendance: { calendarDaysInMonth: 30, paidDays: 35 }, params: PARAMS })).toThrow(InvalidStatutorySchedule);
    expect(() => buildPayslip({ onDate: '2026-08-01', components: [], attendance: { calendarDaysInMonth: 30, paidDays: 30 }, params: PARAMS })).toThrow(InvalidStatutorySchedule);
    expect(() => buildPayslip({ onDate: '2026-08-01', components: [{ code: 'X', monthlyMinor: -1 }], attendance: { calendarDaysInMonth: 30, paidDays: 30 }, params: PARAMS })).toThrow(InvalidStatutorySchedule);
  });
});
