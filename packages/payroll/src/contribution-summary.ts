// EPF and ESI contributions (R4 · C19 · OB-208 · OB-227). The signed sentence:
//   "Every EPF and ESI rate, wage ceiling and headcount threshold is a setting that shows 'not confirmed' until the CA
//    fills it; the figures in the gap analysis are not used as settled. Once confirmed, PF and ESI are worked out from
//    those settings only after the shop's headcount reaches each threshold. Below a threshold, that contribution is not
//    deducted and the payslip says why. The month's contribution totals equal the sum of the payslip lines to the
//    paisa; a difference is an exception."
//
// So for each scheme the answer is one of:
//   • not_confirmed  — a rate, ceiling or threshold the scheme needs is not confirmed: NOT worked out (the amounts are
//                      null, never a silent zero) and the payslip names the missing settings;
//   • below_threshold — the shop's headcount is below the confirmed threshold: not deducted, and the payslip says why;
//   • not_covered    — ESI only: the employee's gross is above the confirmed ceiling (and not covered for the period);
//   • deducted       — worked out from the confirmed settings: PF on the PF wage up to the ceiling, rounded to the
//                      nearest rupee; ESI on gross, each share rounded up to the next rupee (the same rounding the
//                      statutory engine in `statutory.ts` uses).
//
// Exact integer paise. Pure and deterministic: no clock, no I/O.

import { figureInForce, figureStatuses, type PayrollFigureKey, type PayrollLegalSettings } from './legal-settings';

const RUPEE = 100;
const roundRupee = (minor: number): number => Math.round(minor / RUPEE) * RUPEE;
const ceilRupee = (minor: number): number => Math.ceil(minor / RUPEE) * RUPEE;
const bpsOf = (amountMinor: number, bps: number): number => Number((BigInt(amountMinor) * BigInt(bps)) / 10_000n);

export type ContributionStatus = 'deducted' | 'below_threshold' | 'not_covered' | 'not_confirmed';

export interface SchemeOutcome {
  readonly scheme: 'PF' | 'ESI';
  readonly status: ContributionStatus;
  /** The employee's share in paise; null while not worked out (not confirmed). */
  readonly employeeMinor: number | null;
  /** The employer's share in paise; null while not worked out. */
  readonly employerMinor: number | null;
  /** Why, in words — printed on the payslip. */
  readonly why: string;
  /** The settings that are not confirmed, when status is not_confirmed. */
  readonly notConfirmed?: readonly PayrollFigureKey[];
}

export interface ContributionAssessment {
  readonly headcount: number;
  readonly pf: SchemeOutcome;
  readonly esi: SchemeOutcome;
}

export class InvalidContributionInput extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidContributionInput'; }
}

const PF_KEYS: readonly PayrollFigureKey[] = ['pfEmployeeRateBps', 'pfEmployerRateBps', 'pfWageCeilingMinor', 'pfHeadcountThreshold'];
const ESI_KEYS: readonly PayrollFigureKey[] = ['esiEmployeeRateBps', 'esiEmployerRateBps', 'esiGrossCeilingMinor', 'esiHeadcountThreshold'];

const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

function notConfirmed(scheme: 'PF' | 'ESI', settings: PayrollLegalSettings, keys: readonly PayrollFigureKey[]): SchemeOutcome | undefined {
  const missing = figureStatuses(settings).filter((s) => keys.includes(s.key) && s.status === 'not_confirmed');
  if (missing.length === 0) return undefined;
  return {
    scheme, status: 'not_confirmed', employeeMinor: null, employerMinor: null,
    notConfirmed: missing.map((m) => m.key),
    why: `${scheme} not worked out: not confirmed by the CA — ${missing.map((m) => m.label).join('; ')}`,
  };
}

/**
 * The month's PF and ESI for one employee, from the CA-confirmed settings and the shop's headcount. Pure.
 */
export function assessContributions(input: {
  readonly settings: PayrollLegalSettings;
  /** The shop's headcount — the people in its staff directory now. */
  readonly headcount: number;
  readonly grossMinor: number;
  readonly pfWageMinor: number;
  /** ESI's wage-period continuation: covered at the start of the contribution period stays covered to its end. */
  readonly esiCoveredForPeriod?: boolean;
}): ContributionAssessment {
  const { settings, headcount, grossMinor, pfWageMinor } = input;
  if (!Number.isInteger(headcount) || headcount < 0) throw new InvalidContributionInput('the headcount must be a whole number of people');
  if (!Number.isInteger(grossMinor) || grossMinor < 0 || !Number.isInteger(pfWageMinor) || pfWageMinor < 0) {
    throw new InvalidContributionInput('gross and PF wage must be whole, non-negative paise amounts');
  }
  const v = (k: PayrollFigureKey): number => figureInForce(settings, k) as number;

  const pf: SchemeOutcome = notConfirmed('PF', settings, PF_KEYS) ?? (() => {
    const threshold = v('pfHeadcountThreshold');
    if (headcount < threshold) {
      return { scheme: 'PF' as const, status: 'below_threshold' as const, employeeMinor: 0, employerMinor: 0, why: `PF not deducted: the shop has ${headcount} ${headcount === 1 ? 'person' : 'people'}, below the EPF threshold of ${threshold}` };
    }
    const base = Math.min(pfWageMinor, v('pfWageCeilingMinor'));
    return {
      scheme: 'PF' as const, status: 'deducted' as const,
      employeeMinor: roundRupee(bpsOf(base, v('pfEmployeeRateBps'))), employerMinor: roundRupee(bpsOf(base, v('pfEmployerRateBps'))),
      why: `PF on the PF wage of ${rupees(base)}${base < pfWageMinor ? ` (the ceiling of ${rupees(v('pfWageCeilingMinor'))})` : ''}: the shop has ${headcount} people, at or above the EPF threshold of ${threshold}`,
    };
  })();

  const esi: SchemeOutcome = notConfirmed('ESI', settings, ESI_KEYS) ?? (() => {
    const threshold = v('esiHeadcountThreshold');
    if (headcount < threshold) {
      return { scheme: 'ESI' as const, status: 'below_threshold' as const, employeeMinor: 0, employerMinor: 0, why: `ESI not deducted: the shop has ${headcount} ${headcount === 1 ? 'person' : 'people'}, below the ESI threshold of ${threshold}` };
    }
    const ceiling = v('esiGrossCeilingMinor');
    if (grossMinor > ceiling && input.esiCoveredForPeriod !== true) {
      return { scheme: 'ESI' as const, status: 'not_covered' as const, employeeMinor: 0, employerMinor: 0, why: `ESI not deducted: gross of ${rupees(grossMinor)} is above the ESI ceiling of ${rupees(ceiling)}` };
    }
    return {
      scheme: 'ESI' as const, status: 'deducted' as const,
      employeeMinor: ceilRupee(bpsOf(grossMinor, v('esiEmployeeRateBps'))), employerMinor: ceilRupee(bpsOf(grossMinor, v('esiEmployerRateBps'))),
      why: `ESI on gross of ${rupees(grossMinor)}${grossMinor > ceiling ? ' (covered to the end of the contribution period)' : ''}: the shop has ${headcount} people, at or above the ESI threshold of ${threshold}`,
    };
  })();

  return { headcount, pf, esi };
}

// ── the month's totals reconcile to the payslips ────────────────────────────────────────────────────────────────────

export interface ContributionAmounts {
  readonly pfEmployeeMinor: number;
  readonly pfEmployerMinor: number;
  readonly esiEmployeeMinor: number;
  readonly esiEmployerMinor: number;
}

export const CONTRIBUTION_FIELDS: readonly (keyof ContributionAmounts)[] = ['pfEmployeeMinor', 'pfEmployerMinor', 'esiEmployeeMinor', 'esiEmployerMinor'];

/** One payslip's contribution lines, as the payslip carries them. */
export interface PayslipContributionLine extends ContributionAmounts {
  readonly employeeId: string;
}

/** The month's totals as recorded (from the contribution return or challan), with who recorded them and the reference. */
export interface RecordedContributionTotals extends ContributionAmounts {
  readonly period: string;
  readonly reference: string;
  readonly by: string;
  readonly at: string;
}

export interface ContributionDifference {
  readonly field: keyof ContributionAmounts;
  readonly payslipsMinor: number;
  readonly recordedMinor: number;
  readonly differenceMinor: number;
  readonly detail: string;
}

export interface ContributionReconciliation {
  readonly period: string;
  readonly status: 'reconciled' | 'difference' | 'no_totals_recorded' | 'no_payslips';
  readonly payslipCount: number;
  /** The sum of the payslip lines, to the paisa. */
  readonly payslipTotals: ContributionAmounts;
  readonly recorded: RecordedContributionTotals | null;
  /** One exception per field that does not agree. */
  readonly exceptions: readonly ContributionDifference[];
  readonly detail: string;
}

const FIELD_WORDS: Readonly<Record<keyof ContributionAmounts, string>> = {
  pfEmployeeMinor: 'PF employee share', pfEmployerMinor: 'PF employer share', esiEmployeeMinor: 'ESI employee share', esiEmployerMinor: 'ESI employer share',
};

/**
 * Do the month's recorded totals equal the sum of the payslip lines, to the paisa? Every field that differs is an
 * exception. With no totals recorded, or no payslips, it says so — never "reconciled" by default. Pure.
 */
export function reconcileContributions(input: {
  readonly period: string;
  readonly lines: readonly PayslipContributionLine[];
  readonly recorded: RecordedContributionTotals | null;
}): ContributionReconciliation {
  const payslipTotals: ContributionAmounts = {
    pfEmployeeMinor: input.lines.reduce((s, l) => s + l.pfEmployeeMinor, 0),
    pfEmployerMinor: input.lines.reduce((s, l) => s + l.pfEmployerMinor, 0),
    esiEmployeeMinor: input.lines.reduce((s, l) => s + l.esiEmployeeMinor, 0),
    esiEmployerMinor: input.lines.reduce((s, l) => s + l.esiEmployerMinor, 0),
  };
  const base = { period: input.period, payslipCount: input.lines.length, payslipTotals, recorded: input.recorded };
  if (input.lines.length === 0) {
    return { ...base, status: 'no_payslips', exceptions: [], detail: `no payslips are issued for ${input.period} — nothing to reconcile yet` };
  }
  if (input.recorded === null) {
    return { ...base, status: 'no_totals_recorded', exceptions: [], detail: `the month's contribution totals for ${input.period} are not recorded — not reconciled` };
  }
  const recorded = input.recorded;
  const exceptions = CONTRIBUTION_FIELDS.flatMap((field): ContributionDifference[] => {
    const a = payslipTotals[field];
    const b = recorded[field];
    return a === b ? [] : [{
      field, payslipsMinor: a, recordedMinor: b, differenceMinor: b - a,
      detail: `${FIELD_WORDS[field]}: the payslips add up to ${rupees(a)}, the recorded total is ${rupees(b)} — a difference of ${rupees(Math.abs(b - a))}`,
    }];
  });
  return {
    ...base, status: exceptions.length === 0 ? 'reconciled' : 'difference', exceptions,
    detail: exceptions.length === 0
      ? `the recorded totals for ${input.period} equal the sum of ${input.lines.length} payslip(s) to the paisa`
      : `${exceptions.length} contribution total(s) for ${input.period} differ from the payslips`,
  };
}
