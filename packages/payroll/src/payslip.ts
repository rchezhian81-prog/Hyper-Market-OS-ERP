// Payroll — the payslip earnings/gross builder (WP3 inc2). Increment 1 gave us the statutory deductions
// from a gross and a PF wage; this builds those two figures from an employee's compensation structure and
// the month's attendance, then assembles the full payslip: earnings − statutory deductions = net.
//
// Two things this must get right:
//   • **A compensation structure is effective-dated.** A raise in July does not rewrite June's payslip —
//     the structure in force on the pay date is used, resolved exactly like the statutory rates.
//   • **Loss of pay prorates earnings, not just the total.** Days not paid reduce every earning AND the PF
//     wage (PF is on what was actually earned), so a month with LOP feeds a smaller gross AND a smaller PF
//     wage into the deduction engine — getting only one right is a wrong payslip.
//
// Exact integer paise; each earning is prorated and rounded independently. Pure and deterministic — no
// clock, no I/O. Nothing is a live pay run: this assembles a payslip for REVIEW; committing a pay run
// (maker-checker, lock, the reversal-not-rewrite lifecycle) is a later increment and needs CA/HR/legal GO.

import {
  computeStatutoryDeductions,
  InvalidStatutorySchedule,
  type StatutoryParams,
  type StatutoryDeductionResult,
} from './statutory';

// --- effective-dated compensation structure ----------------------------------------------------------

/** One earning line in an employee's monthly compensation (full-month amount, before proration). */
export interface CompensationComponent {
  /** A stable code — 'BASIC', 'DA', 'HRA', 'SPECIAL', 'CONVEYANCE'… */
  readonly code: string;
  /** The full-month amount in paise. */
  readonly monthlyMinor: number;
  /** Counts toward the PF wage (basic + DA typically). Default false. */
  readonly partOfPfWage?: boolean;
  /** Counts toward gross (almost all earnings). Default true. */
  readonly partOfGross?: boolean;
}

export interface CompensationStructureEntry {
  readonly effectiveFrom: string;
  readonly components: readonly CompensationComponent[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The compensation structure in force on the pay date — filter to entries effective on or before it, take
 * the latest. Mirrors `resolveStatutoryParams`: a raise does not rewrite an earlier month, and a date
 * before the earliest structure is refused rather than guessed. Pure.
 */
export function resolveCompensation(
  history: readonly CompensationStructureEntry[],
  onDate: string,
): readonly CompensationComponent[] {
  if (!ISO_DATE.test(onDate) || Number.isNaN(Date.parse(onDate))) {
    throw new InvalidStatutorySchedule(`the pay date must be YYYY-MM-DD, but reads "${onDate}"`);
  }
  if (history.length === 0) throw new InvalidStatutorySchedule('the compensation history is empty');
  for (const e of history) {
    if (!ISO_DATE.test(e.effectiveFrom) || Number.isNaN(Date.parse(e.effectiveFrom))) {
      throw new InvalidStatutorySchedule(`a compensation entry effectiveFrom is not a date: "${e.effectiveFrom}"`);
    }
  }
  const applicable = [...history]
    .filter((e) => e.effectiveFrom <= onDate)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const inForce = applicable[applicable.length - 1];
  if (inForce === undefined) {
    throw new InvalidStatutorySchedule(`no compensation structure is in force on ${onDate} — the earliest entry starts later`);
  }
  return inForce.components;
}

// --- attendance / loss of pay ------------------------------------------------------------------------

export interface Attendance {
  /** Calendar days in the pay month (28–31). */
  readonly calendarDaysInMonth: number;
  /** Days actually paid — calendar days minus loss-of-pay days. */
  readonly paidDays: number;
}

// --- the payslip -------------------------------------------------------------------------------------

export interface PayslipEarning {
  readonly code: string;
  readonly fullMonthMinor: number;
  /** The amount earned this month after proration for paid days. */
  readonly earnedMinor: number;
}

export interface Payslip {
  readonly onDate: string;
  readonly calendarDaysInMonth: number;
  readonly paidDays: number;
  readonly lopDays: number;
  readonly earnings: readonly PayslipEarning[];
  readonly grossMinor: number;
  readonly pfWageMinor: number;
  readonly statutory: StatutoryDeductionResult;
  readonly netPayMinor: number;
  readonly confirmWithCa: true;
  readonly detail: string;
}

export interface BuildPayslipInput {
  readonly onDate: string;
  /** The compensation components in force (resolve with `resolveCompensation` first if you hold a history). */
  readonly components: readonly CompensationComponent[];
  readonly attendance: Attendance;
  readonly params: StatutoryParams;
  readonly professionalTaxMonthlyMinor?: number;
  /** This month's TDS (income tax) in paise, from the TDS engine. */
  readonly tdsMonthlyMinor?: number;
  readonly esiCoveredForPeriod?: boolean;
}

/** Prorate a full-month paise amount for paid days, rounded to the nearest paise. Exact for a full month. */
function prorate(fullMonthMinor: number, paidDays: number, calendarDays: number): number {
  if (paidDays === calendarDays) return fullMonthMinor; // full month — no rounding drift
  return Math.round((fullMonthMinor * paidDays) / calendarDays);
}

/**
 * Build a payslip: prorate each earning for the month's paid days, sum the gross and the PF wage, run the
 * statutory-deduction engine over them, and report earnings − deductions = net. Loss of pay reduces both
 * the gross and the PF wage. Pure — the statutory computation runs on the tested engine. For REVIEW.
 */
export function buildPayslip(input: BuildPayslipInput): Payslip {
  const { calendarDaysInMonth, paidDays } = input.attendance;
  if (!Number.isInteger(calendarDaysInMonth) || calendarDaysInMonth < 28 || calendarDaysInMonth > 31) {
    throw new InvalidStatutorySchedule(`calendarDaysInMonth must be 28–31, but reads "${calendarDaysInMonth}"`);
  }
  if (!Number.isInteger(paidDays) || paidDays < 0 || paidDays > calendarDaysInMonth) {
    throw new InvalidStatutorySchedule(`paidDays must be a whole number between 0 and ${calendarDaysInMonth}, but reads "${paidDays}"`);
  }
  if (input.components.length === 0) throw new InvalidStatutorySchedule('the compensation structure has no earnings');

  const earnings: PayslipEarning[] = [];
  let grossMinor = 0;
  let pfWageMinor = 0;
  for (const c of input.components) {
    if (!Number.isInteger(c.monthlyMinor) || c.monthlyMinor < 0) {
      throw new InvalidStatutorySchedule(`the amount for "${c.code}" must be a whole, non-negative paise value`);
    }
    const earnedMinor = prorate(c.monthlyMinor, paidDays, calendarDaysInMonth);
    earnings.push({ code: c.code, fullMonthMinor: c.monthlyMinor, earnedMinor });
    if (c.partOfGross !== false) grossMinor += earnedMinor;
    if (c.partOfPfWage === true) pfWageMinor += earnedMinor;
  }

  const statutory = computeStatutoryDeductions({
    grossMinor,
    pfWageMinor,
    params: input.params,
    ...(input.esiCoveredForPeriod !== undefined ? { esiCoveredForPeriod: input.esiCoveredForPeriod } : {}),
    ...(input.professionalTaxMonthlyMinor !== undefined ? { professionalTaxMonthlyMinor: input.professionalTaxMonthlyMinor } : {}),
    ...(input.tdsMonthlyMinor !== undefined ? { tdsMonthlyMinor: input.tdsMonthlyMinor } : {}),
  });

  const lopDays = calendarDaysInMonth - paidDays;
  return {
    onDate: input.onDate,
    calendarDaysInMonth,
    paidDays,
    lopDays,
    earnings,
    grossMinor,
    pfWageMinor,
    statutory,
    netPayMinor: statutory.netPayMinor,
    confirmWithCa: true,
    detail: `${paidDays}/${calendarDaysInMonth} paid days${lopDays > 0 ? ` (${lopDays} LOP)` : ''}: gross ${grossMinor}, deductions ${statutory.totalEmployeeDeductionMinor}, net ${statutory.netPayMinor}`,
  };
}
