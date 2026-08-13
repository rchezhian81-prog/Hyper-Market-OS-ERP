// Payroll — India statutory-deduction engine (roadmap priority 16, owner directive §6). The first payroll
// increment: from an employee's monthly earnings, compute the statutory deductions and the net — PF, ESI
// and Professional Tax — as **effective-dated, configurable rate tables**, never hard-coded law.
//
// Statutory rates, ceilings and slabs change by notification, and a payslip computed last year must still
// be explainable. So the parameters are a dated schedule resolved on the pay date the SAME way GST rates
// are (`resolveGstRate`): filter to what was in force, take the latest, refuse rather than guess on a gap.
// The shipped defaults are the current, widely-published figures — but every one is a named constant with
// a **CONFIRM-WITH-CA** marker, because the cost of a wrong PF ceiling or PT slab is somebody's pay and the
// employer's compliance. Nothing here is a live payroll: the deductions are computed for review, and a
// real pay run needs CA/HR/legal sign-off (an externally-blocked GO), not more code.
//
// Money is integer paise (minor units) with exact arithmetic — a payslip that is a paisa wrong at scale is
// a reconciliation that never closes. Pure and deterministic: no clock, no I/O.

// --- money helpers -----------------------------------------------------------------------------------
const RUPEE = 100; // paise in a rupee
/** Round to the nearest whole rupee (PF/EPF convention). */
const roundRupee = (minor: number): number => Math.round(minor / RUPEE) * RUPEE;
/** Round UP to the next whole rupee (ESIC rule: each contribution is rounded to the next higher rupee). */
const ceilRupee = (minor: number): number => Math.ceil(minor / RUPEE) * RUPEE;
/** `bps` basis points of an amount, as an exact integer paise value (before rupee rounding). */
const bpsOf = (amountMinor: number, bps: number): number => Number((BigInt(amountMinor) * BigInt(bps)) / 10_000n);

// --- effective-dated statutory parameters ------------------------------------------------------------

export interface PfParams {
  /** Employee PF rate in basis points (12% = 1200). CONFIRM-WITH-CA. */
  readonly employeeRateBps: number;
  /** Employer PF rate in basis points (12% = 1200). CONFIRM-WITH-CA. */
  readonly employerRateBps: number;
  /** Monthly PF wage ceiling in paise — PF is computed on min(pfWage, ceiling). ₹15,000. CONFIRM-WITH-CA. */
  readonly wageCeilingMinor: number;
}

export interface EsiParams {
  /** Employee ESI rate in basis points (0.75% = 75). CONFIRM-WITH-CA. */
  readonly employeeRateBps: number;
  /** Employer ESI rate in basis points (3.25% = 325). CONFIRM-WITH-CA. */
  readonly employerRateBps: number;
  /** Monthly gross ceiling for ESI eligibility in paise. ₹21,000. CONFIRM-WITH-CA. */
  readonly grossCeilingMinor: number;
}

/** One Professional-Tax slab (Tamil Nadu, half-yearly): income up to `uptoMinor` pays `amountMinor`. */
export interface PtSlab {
  /** Upper bound of half-yearly income in paise for this slab; `null` is the open-ended top slab. */
  readonly uptoMinor: number | null;
  /** The half-yearly PT for this slab, in paise. */
  readonly amountMinor: number;
}

export interface StatutoryParams {
  readonly pf: PfParams;
  readonly esi: EsiParams;
  /** Tamil Nadu Professional Tax, half-yearly slabs (ascending). CONFIRM-WITH-CA. */
  readonly ptTamilNaduHalfYearly: readonly PtSlab[];
}

/** One dated entry — the parameters in force from `effectiveFrom` (YYYY-MM-DD) until the next entry. */
export interface StatutoryScheduleEntry {
  readonly effectiveFrom: string;
  readonly params: StatutoryParams;
}

// The shipped defaults — current widely-published figures. EVERY value is CONFIRM-WITH-CA before a live run.
// Effective 2020-02-01 (the TN PT revision widely cited); a store confirms and dates its own entries.
export const DEFAULT_STATUTORY_SCHEDULE: readonly StatutoryScheduleEntry[] = [
  {
    effectiveFrom: '2020-02-01',
    params: {
      pf: { employeeRateBps: 1200, employerRateBps: 1200, wageCeilingMinor: 1_500_000 }, // ₹15,000
      esi: { employeeRateBps: 75, employerRateBps: 325, grossCeilingMinor: 2_100_000 }, // ₹21,000
      // Tamil Nadu (Greater Chennai Corporation) half-yearly PT slabs — CONFIRM-WITH-CA.
      ptTamilNaduHalfYearly: [
        { uptoMinor: 2_100_000, amountMinor: 0 }, // up to ₹21,000 → nil
        { uptoMinor: 3_000_000, amountMinor: 13_500 }, // ₹21,001–30,000 → ₹135
        { uptoMinor: 4_500_000, amountMinor: 31_500 }, // ₹30,001–45,000 → ₹315
        { uptoMinor: 6_000_000, amountMinor: 69_000 }, // ₹45,001–60,000 → ₹690
        { uptoMinor: 7_500_000, amountMinor: 102_500 }, // ₹60,001–75,000 → ₹1,025
        { uptoMinor: null, amountMinor: 125_000 }, // above ₹75,000 → ₹1,250
      ],
    },
  },
];

export class InvalidStatutorySchedule extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStatutorySchedule';
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The statutory parameters in force on a pay date — filter to entries effective on or before it, take the
 * latest. Mirrors `resolveGstRate`: a date before the earliest entry is refused, never guessed. Pure.
 */
export function resolveStatutoryParams(
  schedule: readonly StatutoryScheduleEntry[],
  onDate: string,
): StatutoryParams {
  if (!ISO_DATE.test(onDate) || Number.isNaN(Date.parse(onDate))) {
    throw new InvalidStatutorySchedule(`the pay date must be YYYY-MM-DD, but reads "${onDate}"`);
  }
  if (schedule.length === 0) throw new InvalidStatutorySchedule('the statutory schedule is empty');
  for (const e of schedule) {
    if (!ISO_DATE.test(e.effectiveFrom) || Number.isNaN(Date.parse(e.effectiveFrom))) {
      throw new InvalidStatutorySchedule(`a schedule entry effectiveFrom is not a date: "${e.effectiveFrom}"`);
    }
  }
  const applicable = [...schedule]
    .filter((e) => e.effectiveFrom <= onDate)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const inForce = applicable[applicable.length - 1];
  if (inForce === undefined) {
    throw new InvalidStatutorySchedule(`no statutory parameters are in force on ${onDate} — the earliest entry starts later`);
  }
  return inForce.params;
}

// --- Professional Tax (Tamil Nadu, half-yearly) ------------------------------------------------------

export interface ProfessionalTaxResult {
  readonly halfYearlyIncomeMinor: number;
  readonly ptHalfYearlyMinor: number;
  readonly detail: string;
}

/**
 * Tamil Nadu Professional Tax for a half-year, from the half-yearly income and the slab table. PT is a
 * half-yearly levy; the caller apportions it across the six months. Pure. CONFIRM-WITH-CA.
 */
export function professionalTaxTamilNadu(
  halfYearlyIncomeMinor: number,
  slabs: readonly PtSlab[],
): ProfessionalTaxResult {
  if (!Number.isInteger(halfYearlyIncomeMinor) || halfYearlyIncomeMinor < 0) {
    throw new InvalidStatutorySchedule('the half-yearly income must be a whole, non-negative paise amount');
  }
  // Ascending slabs; the first whose upper bound covers the income (or the open-ended top) applies.
  for (const slab of slabs) {
    if (slab.uptoMinor === null || halfYearlyIncomeMinor <= slab.uptoMinor) {
      return {
        halfYearlyIncomeMinor,
        ptHalfYearlyMinor: slab.amountMinor,
        detail: `half-yearly income ${halfYearlyIncomeMinor} → PT ${slab.amountMinor}${slab.uptoMinor === null ? ' (top slab)' : ''}`,
      };
    }
  }
  throw new InvalidStatutorySchedule('the PT slab table has no open-ended top slab — an income above every bound is uncovered');
}

// --- the monthly statutory deduction ----------------------------------------------------------------

export interface StatutoryDeductionInput {
  /** Monthly gross earnings (basic + allowances) in paise — the ESI base. */
  readonly grossMinor: number;
  /** Monthly PF wage (basic + DA) in paise — the PF base (capped at the ceiling). */
  readonly pfWageMinor: number;
  readonly params: StatutoryParams;
  /**
   * ESI's wage-period continuation: an employee covered at the start of a contribution period stays covered
   * to its end even if gross later crosses the ceiling. When true, ESI applies regardless of the ceiling.
   */
  readonly esiCoveredForPeriod?: boolean;
  /** This month's apportioned Professional Tax in paise (PT is a half-yearly levy spread over months). */
  readonly professionalTaxMonthlyMinor?: number;
  /** This month's TDS (income tax) in paise, from the TDS engine. Default 0 (backward compatible). */
  readonly tdsMonthlyMinor?: number;
}

export interface StatutoryDeductionResult {
  readonly pfEmployeeMinor: number;
  readonly pfEmployerMinor: number;
  readonly esiApplicable: boolean;
  readonly esiEmployeeMinor: number;
  readonly esiEmployerMinor: number;
  readonly professionalTaxMinor: number;
  /** This month's TDS (income tax) withheld. */
  readonly tdsMinor: number;
  /** What the employee has withheld this month: PF + ESI + PT + TDS. */
  readonly totalEmployeeDeductionMinor: number;
  /** The employer's own statutory cost this month (PF + ESI employer shares) — a cost, not a deduction. */
  readonly totalEmployerContributionMinor: number;
  /** gross − total employee deduction. */
  readonly netPayMinor: number;
  readonly detail: string;
}

/**
 * Compute a month's statutory deductions and net pay from earnings and the in-force parameters. PF is on
 * the PF wage capped at its ceiling (rounded to the nearest rupee); ESI is on gross, applicable only at or
 * below the gross ceiling unless covered for the period (rounded UP to the next rupee, per ESIC); PT is the
 * apportioned monthly amount supplied by the caller. Net is gross minus the employee's share. Pure.
 */
export function computeStatutoryDeductions(input: StatutoryDeductionInput): StatutoryDeductionResult {
  const { grossMinor, pfWageMinor, params } = input;
  if (!Number.isInteger(grossMinor) || grossMinor < 0 || !Number.isInteger(pfWageMinor) || pfWageMinor < 0) {
    throw new InvalidStatutorySchedule('gross and PF wage must be whole, non-negative paise amounts');
  }

  // PF — on the PF wage capped at the ceiling, rounded to the nearest rupee.
  const pfBase = Math.min(pfWageMinor, params.pf.wageCeilingMinor);
  const pfEmployeeMinor = roundRupee(bpsOf(pfBase, params.pf.employeeRateBps));
  const pfEmployerMinor = roundRupee(bpsOf(pfBase, params.pf.employerRateBps));

  // ESI — on gross, only if within the ceiling (or covered for the period), rounded up to the next rupee.
  const esiApplicable = grossMinor <= params.esi.grossCeilingMinor || input.esiCoveredForPeriod === true;
  const esiEmployeeMinor = esiApplicable ? ceilRupee(bpsOf(grossMinor, params.esi.employeeRateBps)) : 0;
  const esiEmployerMinor = esiApplicable ? ceilRupee(bpsOf(grossMinor, params.esi.employerRateBps)) : 0;

  const professionalTaxMinor = input.professionalTaxMonthlyMinor ?? 0;
  if (!Number.isInteger(professionalTaxMinor) || professionalTaxMinor < 0) {
    throw new InvalidStatutorySchedule('the monthly PT must be a whole, non-negative paise amount');
  }
  const tdsMinor = input.tdsMonthlyMinor ?? 0;
  if (!Number.isInteger(tdsMinor) || tdsMinor < 0) {
    throw new InvalidStatutorySchedule('the monthly TDS must be a whole, non-negative paise amount');
  }

  const totalEmployeeDeductionMinor = pfEmployeeMinor + esiEmployeeMinor + professionalTaxMinor + tdsMinor;
  const totalEmployerContributionMinor = pfEmployerMinor + esiEmployerMinor;
  const netPayMinor = grossMinor - totalEmployeeDeductionMinor;

  return {
    pfEmployeeMinor,
    pfEmployerMinor,
    esiApplicable,
    esiEmployeeMinor,
    esiEmployerMinor,
    professionalTaxMinor,
    tdsMinor,
    totalEmployeeDeductionMinor,
    totalEmployerContributionMinor,
    netPayMinor,
    detail: `gross ${grossMinor} − (PF ${pfEmployeeMinor} + ESI ${esiEmployeeMinor}${esiApplicable ? '' : ' n/a'} + PT ${professionalTaxMinor} + TDS ${tdsMinor}) = net ${netPayMinor}`,
  };
}
