import { describe, it, expect } from 'vitest';
import {
  UNSET_PAYROLL_LEGAL_SETTINGS, foldPayrollLegalSettings, figureStatuses, figureInForce, assessContributions, reconcileContributions,
  PAYROLL_FIGURE_KEYS, DEFAULT_STATUTORY_SCHEDULE,
  type PayrollLegalSettingChange, type PayrollFigureKey, type PayrollLegalSettings,
} from '../../packages/payroll/src/index';

/**
 * **R4 · C19 · OB-208 — EPF and ESI follow the CA's settings and the shop's headcount (the pure engine).**
 * "Every EPF and ESI rate, wage ceiling and headcount threshold is a setting that shows 'not confirmed' until the CA fills
 * it; the figures in the gap analysis are not used as settled. Once confirmed, PF and ESI are worked out from those
 * settings only after the shop's headcount reaches each threshold. Below a threshold, that contribution is not deducted
 * and the payslip says why. The month's contribution totals equal the sum of the payslip lines to the paisa; a
 * difference is an exception."
 *
 * The figures below are SYNTHETIC test figures, picked for easy arithmetic — not the legal rates.
 */

const fig = (key: PayrollFigureKey, value: number, confirmed = true): PayrollLegalSettingChange => ({
  target: 'figure', key, figure: { value, source: 'test figure', confirmation: confirmed ? 'CA test ref' : null }, by: 'u-ca', at: '2030-01-01T00:00:00Z',
});
const confirmedSettings = (): PayrollLegalSettings => foldPayrollLegalSettings([
  fig('pfEmployeeRateBps', 1000), fig('pfEmployerRateBps', 1100), fig('pfWageCeilingMinor', 1_000_000), fig('pfHeadcountThreshold', 3),
  fig('esiEmployeeRateBps', 100), fig('esiEmployerRateBps', 300), fig('esiGrossCeilingMinor', 2_000_000), fig('esiHeadcountThreshold', 2),
]);

describe('every rate, ceiling and threshold starts not confirmed (OB-208)', () => {
  it('as shipped, all eleven figures read "not confirmed" and none is in force', () => {
    const st = figureStatuses(UNSET_PAYROLL_LEGAL_SETTINGS);
    expect(st).toHaveLength(PAYROLL_FIGURE_KEYS.length);
    expect(st.every((s) => s.status === 'not_confirmed' && s.value === null)).toBe(true);
    for (const k of PAYROLL_FIGURE_KEYS) expect(figureInForce(UNSET_PAYROLL_LEGAL_SETTINGS, k)).toBeUndefined();
  });

  it('a figure with no confirmation, or no source, stays not confirmed and says what is missing', () => {
    const s = foldPayrollLegalSettings([fig('pfEmployeeRateBps', 1200, false)]);
    const pf = figureStatuses(s).find((x) => x.key === 'pfEmployeeRateBps')!;
    expect(pf.status).toBe('not_confirmed');
    expect(pf.missing).toContain('who confirmed it');
  });

  it('with nothing confirmed, PF and ESI are NOT worked out — null, never a silent zero — and the shipped defaults are not used', () => {
    const a = assessContributions({ settings: UNSET_PAYROLL_LEGAL_SETTINGS, headcount: 50, grossMinor: 1_800_000, pfWageMinor: 1_200_000 });
    expect(a.pf).toMatchObject({ status: 'not_confirmed', employeeMinor: null, employerMinor: null });
    expect(a.esi).toMatchObject({ status: 'not_confirmed', employeeMinor: null, employerMinor: null });
    expect(a.pf.why).toMatch(/^PF not worked out: not confirmed by the CA/);
    expect(a.pf.notConfirmed).toEqual(['pfEmployeeRateBps', 'pfEmployerRateBps', 'pfWageCeilingMinor', 'pfHeadcountThreshold']);
    // The CONFIRM-WITH-CA defaults still sit in statutory.ts for the old preview routes, but the R4 assessment never reads them.
    expect(DEFAULT_STATUTORY_SCHEDULE[0]!.params.pf.employeeRateBps).toBe(1200);
  });

  it('one unconfirmed ESI figure holds ESI back while a confirmed PF is worked out', () => {
    const s = foldPayrollLegalSettings([
      fig('pfEmployeeRateBps', 1000), fig('pfEmployerRateBps', 1100), fig('pfWageCeilingMinor', 1_000_000), fig('pfHeadcountThreshold', 3),
      fig('esiEmployeeRateBps', 100), fig('esiEmployerRateBps', 300), fig('esiGrossCeilingMinor', 2_000_000), fig('esiHeadcountThreshold', 2, false),
    ]);
    const a = assessContributions({ settings: s, headcount: 5, grossMinor: 1_500_000, pfWageMinor: 800_000 });
    expect(a.pf.status).toBe('deducted');
    expect(a.esi.status).toBe('not_confirmed');
    expect(a.esi.notConfirmed).toEqual(['esiHeadcountThreshold']);
  });
});

describe('once confirmed, each contribution starts only at its headcount threshold', () => {
  it('below the EPF threshold PF is not deducted and the payslip says why; at it, PF is worked out', () => {
    const s = confirmedSettings();
    const below = assessContributions({ settings: s, headcount: 2, grossMinor: 1_500_000, pfWageMinor: 800_000 });
    expect(below.pf).toMatchObject({ status: 'below_threshold', employeeMinor: 0, employerMinor: 0 });
    expect(below.pf.why).toBe('PF not deducted: the shop has 2 people, below the EPF threshold of 3');
    expect(below.esi.status).toBe('deducted'); // ESI's threshold (2) is reached
    const at = assessContributions({ settings: s, headcount: 3, grossMinor: 1_500_000, pfWageMinor: 800_000 });
    // 10% / 11% of ₹8,000 = ₹800 / ₹880, rounded to the rupee.
    expect(at.pf).toMatchObject({ status: 'deducted', employeeMinor: 80_000, employerMinor: 88_000 });
  });

  it('PF is on the PF wage up to the confirmed ceiling; ESI rounds each share up to the next rupee', () => {
    const a = assessContributions({ settings: confirmedSettings(), headcount: 10, grossMinor: 1_234_567, pfWageMinor: 1_500_000 });
    expect(a.pf.employeeMinor).toBe(100_000); // 10% of the ₹10,000 ceiling, not of ₹15,000
    expect(a.pf.why).toContain('(the ceiling of ₹10,000)');
    expect(a.esi.employeeMinor).toBe(12_400); // 1% of ₹12,345.67 = ₹123.46 → ₹124
    expect(a.esi.employerMinor).toBe(37_100); // 3% = ₹370.37 → ₹371
  });

  it('ESI: below its threshold not deducted; above the gross ceiling not covered; covered for the period, deducted', () => {
    const s = confirmedSettings();
    expect(assessContributions({ settings: s, headcount: 1, grossMinor: 1_000_000, pfWageMinor: 0 }).esi.why).toBe('ESI not deducted: the shop has 1 person, below the ESI threshold of 2');
    const over = assessContributions({ settings: s, headcount: 10, grossMinor: 2_500_000, pfWageMinor: 0 });
    expect(over.esi).toMatchObject({ status: 'not_covered', employeeMinor: 0 });
    expect(over.esi.why).toContain('above the ESI ceiling of ₹20,000');
    const covered = assessContributions({ settings: s, headcount: 10, grossMinor: 2_500_000, pfWageMinor: 0, esiCoveredForPeriod: true });
    expect(covered.esi).toMatchObject({ status: 'deducted', employeeMinor: 25_000, employerMinor: 75_000 });
  });

  it('a headcount or a wage that is not a whole number is refused', () => {
    expect(() => assessContributions({ settings: confirmedSettings(), headcount: 2.5, grossMinor: 1, pfWageMinor: 1 })).toThrow(/headcount/);
    expect(() => assessContributions({ settings: confirmedSettings(), headcount: 2, grossMinor: -1, pfWageMinor: 1 })).toThrow(/paise/);
  });
});

describe('the month\'s totals equal the payslip lines to the paisa; a difference is an exception', () => {
  const lines = [
    { employeeId: 'e1', pfEmployeeMinor: 80_000, pfEmployerMinor: 88_000, esiEmployeeMinor: 15_000, esiEmployerMinor: 45_000 },
    { employeeId: 'e2', pfEmployeeMinor: 60_000, pfEmployerMinor: 66_000, esiEmployeeMinor: 0, esiEmployerMinor: 0 },
  ];
  const rec = (over: Partial<Record<string, number>> = {}) => ({ period: '2030-05', reference: 'ECR-1', by: 'u', at: 'x', pfEmployeeMinor: 140_000, pfEmployerMinor: 154_000, esiEmployeeMinor: 15_000, esiEmployerMinor: 45_000, ...over });

  it('equal → reconciled', () => {
    const r = reconcileContributions({ period: '2030-05', lines, recorded: rec() });
    expect(r.status).toBe('reconciled');
    expect(r.exceptions).toEqual([]);
    expect(r.payslipTotals).toEqual({ pfEmployeeMinor: 140_000, pfEmployerMinor: 154_000, esiEmployeeMinor: 15_000, esiEmployerMinor: 45_000 });
  });

  it('one paisa out is an exception that names the field and both figures', () => {
    const r = reconcileContributions({ period: '2030-05', lines, recorded: rec({ esiEmployerMinor: 45_001 }) });
    expect(r.status).toBe('difference');
    expect(r.exceptions).toHaveLength(1);
    expect(r.exceptions[0]).toMatchObject({ field: 'esiEmployerMinor', payslipsMinor: 45_000, recordedMinor: 45_001, differenceMinor: 1 });
    expect(r.exceptions[0]!.detail).toBe('ESI employer share: the payslips add up to ₹450, the recorded total is ₹450.01 — a difference of ₹0.01');
  });

  it('no totals recorded, or no payslips, is said — never "reconciled" by default', () => {
    expect(reconcileContributions({ period: '2030-05', lines, recorded: null }).status).toBe('no_totals_recorded');
    expect(reconcileContributions({ period: '2030-05', lines: [], recorded: rec() }).status).toBe('no_payslips');
  });
});
