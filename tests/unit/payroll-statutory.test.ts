import { describe, it, expect } from 'vitest';
import {
  resolveStatutoryParams,
  computeStatutoryDeductions,
  professionalTaxTamilNadu,
  DEFAULT_STATUTORY_SCHEDULE,
  InvalidStatutorySchedule,
  type StatutoryParams,
} from '../../packages/payroll/src/index';

const PARAMS: StatutoryParams = resolveStatutoryParams(DEFAULT_STATUTORY_SCHEDULE, '2026-08-01');

describe('resolveStatutoryParams — effective-dated, refuses a gap', () => {
  it('resolves the shipped parameters for an in-range date', () => {
    expect(PARAMS.pf.wageCeilingMinor).toBe(1_500_000);
    expect(PARAMS.esi.grossCeilingMinor).toBe(2_100_000);
  });

  it('refuses a date before the earliest entry and a bad date', () => {
    expect(() => resolveStatutoryParams(DEFAULT_STATUTORY_SCHEDULE, '2019-01-01')).toThrow(InvalidStatutorySchedule);
    expect(() => resolveStatutoryParams(DEFAULT_STATUTORY_SCHEDULE, 'nope')).toThrow(InvalidStatutorySchedule);
    expect(() => resolveStatutoryParams([], '2026-08-01')).toThrow(InvalidStatutorySchedule);
  });

  it('takes the latest entry in force when several apply', () => {
    const schedule = [
      { effectiveFrom: '2020-02-01', params: PARAMS },
      { effectiveFrom: '2026-04-01', params: { ...PARAMS, pf: { ...PARAMS.pf, wageCeilingMinor: 2_500_000 } } },
    ];
    expect(resolveStatutoryParams(schedule, '2026-03-31').pf.wageCeilingMinor).toBe(1_500_000);
    expect(resolveStatutoryParams(schedule, '2026-04-01').pf.wageCeilingMinor).toBe(2_500_000); // boundary
  });
});

describe('computeStatutoryDeductions — PF, ESI, net', () => {
  it('caps PF at the ceiling and drops ESI above the gross ceiling', () => {
    // Basic ₹20,000 (PF wage 20,00,000), gross ₹25,000 — above the ESI ceiling.
    const r = computeStatutoryDeductions({ grossMinor: 2_500_000, pfWageMinor: 2_000_000, params: PARAMS });
    expect(r.pfEmployeeMinor).toBe(180_000); // 12% of the ₹15,000 ceiling = ₹1,800
    expect(r.esiApplicable).toBe(false); // ₹25,000 > ₹21,000
    expect(r.esiEmployeeMinor).toBe(0);
    expect(r.netPayMinor).toBe(2_320_000); // 25,000 − 1,800
  });

  it('applies ESI within the ceiling', () => {
    // Basic = gross = ₹18,000 (within ESI ceiling).
    const r = computeStatutoryDeductions({ grossMinor: 1_800_000, pfWageMinor: 1_800_000, params: PARAMS });
    expect(r.pfEmployeeMinor).toBe(180_000); // capped at ₹15,000
    expect(r.esiApplicable).toBe(true);
    expect(r.esiEmployeeMinor).toBe(13_500); // 0.75% of ₹18,000 = ₹135
    expect(r.esiEmployerMinor).toBe(58_500); // 3.25% of ₹18,000 = ₹585
    expect(r.netPayMinor).toBe(1_800_000 - 180_000 - 13_500);
  });

  it('rounds ESI UP to the next rupee (ESIC rule)', () => {
    // Gross ₹15,333 → 0.75% = ₹114.9975 → rounded up to ₹115.
    const r = computeStatutoryDeductions({ grossMinor: 1_533_300, pfWageMinor: 1_533_300, params: PARAMS });
    expect(r.esiEmployeeMinor).toBe(11_500);
  });

  it('honours the ESI wage-period continuation above the ceiling', () => {
    const off = computeStatutoryDeductions({ grossMinor: 2_500_000, pfWageMinor: 2_500_000, params: PARAMS });
    const on = computeStatutoryDeductions({ grossMinor: 2_500_000, pfWageMinor: 2_500_000, params: PARAMS, esiCoveredForPeriod: true });
    expect(off.esiApplicable).toBe(false);
    expect(on.esiApplicable).toBe(true);
    expect(on.esiEmployeeMinor).toBe(18_800); // 0.75% of ₹25,000 = ₹187.50 → up to ₹188
  });

  it('subtracts the apportioned monthly PT and rejects bad money', () => {
    const r = computeStatutoryDeductions({ grossMinor: 1_800_000, pfWageMinor: 1_800_000, params: PARAMS, professionalTaxMonthlyMinor: 2_250 });
    expect(r.professionalTaxMinor).toBe(2_250);
    expect(r.netPayMinor).toBe(1_800_000 - 180_000 - 13_500 - 2_250);
    expect(() => computeStatutoryDeductions({ grossMinor: -1, pfWageMinor: 0, params: PARAMS })).toThrow(InvalidStatutorySchedule);
  });
});

describe('professionalTaxTamilNadu — half-yearly slab', () => {
  it('reads the slab for the half-yearly income', () => {
    expect(professionalTaxTamilNadu(2_000_000, PARAMS.ptTamilNaduHalfYearly).ptHalfYearlyMinor).toBe(0); // ≤ ₹21,000 → nil
    expect(professionalTaxTamilNadu(2_500_000, PARAMS.ptTamilNaduHalfYearly).ptHalfYearlyMinor).toBe(13_500); // ₹135
    expect(professionalTaxTamilNadu(8_000_000, PARAMS.ptTamilNaduHalfYearly).ptHalfYearlyMinor).toBe(125_000); // top → ₹1,250
  });

  it('is right at a slab boundary', () => {
    expect(professionalTaxTamilNadu(3_000_000, PARAMS.ptTamilNaduHalfYearly).ptHalfYearlyMinor).toBe(13_500); // exactly ₹30,000
    expect(professionalTaxTamilNadu(3_000_100, PARAMS.ptTamilNaduHalfYearly).ptHalfYearlyMinor).toBe(31_500); // ₹30,001 → next slab ₹315
  });

  it('rejects a negative income and a table with no open top slab', () => {
    expect(() => professionalTaxTamilNadu(-1, PARAMS.ptTamilNaduHalfYearly)).toThrow(InvalidStatutorySchedule);
    expect(() => professionalTaxTamilNadu(9_999_999, [{ uptoMinor: 100, amountMinor: 0 }])).toThrow(InvalidStatutorySchedule);
  });
});
