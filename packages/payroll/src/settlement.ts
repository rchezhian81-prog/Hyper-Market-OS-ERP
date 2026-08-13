// Payroll — full-and-final settlement (WP3 inc7). When an employee leaves, one statement squares everything
// up: the salary earned in the final month, unused leave encashed, GRATUITY where they qualify, any notice
// shortfall or outstanding loan recovered, and the tax on it — netting to an amount PAYABLE to them, or (if
// the recoveries exceed the dues) RECOVERABLE from them. Getting this wrong underpays someone on their way
// out or writes off money owed, so it is itemised and exact.
//
// Gratuity is the piece with a formula and a statutory ceiling: 15/26 of the last-drawn basic+DA per
// completed year, for five or more years of service, capped at ₹20,00,000. Those numbers change by
// notification, so they are effective-dated, configurable CONFIRM-WITH-CA constants — resolved on the exit
// date the same way every other statutory figure is. Exact integer paise. Pure and deterministic.

import { InvalidStatutorySchedule } from './statutory';

const RUPEE = 100;
const roundRupee = (minor: number): number => Math.round(minor / RUPEE) * RUPEE;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// --- effective-dated gratuity parameters -------------------------------------------------------------

export interface GratuityParams {
  /** The 15/26 factor: numerator (days of wages per year). CONFIRM-WITH-CA. */
  readonly factorNumerator: number;
  /** The 15/26 factor: denominator (working days in a month). CONFIRM-WITH-CA. */
  readonly factorDenominator: number;
  /** Minimum completed years of service to qualify (5). CONFIRM-WITH-CA. */
  readonly minCompletedYears: number;
  /** Statutory maximum gratuity in paise (₹20,00,000). CONFIRM-WITH-CA. */
  readonly ceilingMinor: number;
}

export interface SettlementParams {
  readonly gratuity: GratuityParams;
}

export interface SettlementScheduleEntry {
  readonly effectiveFrom: string;
  readonly params: SettlementParams;
}

// Effective 2018-03-29 (the ₹20 lakh ceiling). EVERY value is CONFIRM-WITH-CA before a live run.
export const DEFAULT_SETTLEMENT_SCHEDULE: readonly SettlementScheduleEntry[] = [
  {
    effectiveFrom: '2018-03-29',
    params: {
      gratuity: { factorNumerator: 15, factorDenominator: 26, minCompletedYears: 5, ceilingMinor: 200_000_000 },
    },
  },
];

/** The settlement parameters in force on the exit date — filter/sort/last, refuse a gap. */
export function resolveSettlementParams(schedule: readonly SettlementScheduleEntry[], onDate: string): SettlementParams {
  if (!ISO_DATE.test(onDate) || Number.isNaN(Date.parse(onDate))) {
    throw new InvalidStatutorySchedule(`the exit date must be YYYY-MM-DD, but reads "${onDate}"`);
  }
  if (schedule.length === 0) throw new InvalidStatutorySchedule('the settlement schedule is empty');
  for (const e of schedule) {
    if (!ISO_DATE.test(e.effectiveFrom) || Number.isNaN(Date.parse(e.effectiveFrom))) {
      throw new InvalidStatutorySchedule(`a settlement schedule entry effectiveFrom is not a date: "${e.effectiveFrom}"`);
    }
  }
  const applicable = [...schedule].filter((e) => e.effectiveFrom <= onDate).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const inForce = applicable[applicable.length - 1];
  if (inForce === undefined) throw new InvalidStatutorySchedule(`no settlement parameters are in force on ${onDate}`);
  return inForce.params;
}

// --- gratuity ----------------------------------------------------------------------------------------

export interface GratuityResult {
  readonly eligible: boolean;
  readonly gratuityMinor: number;
  readonly cappedAtCeiling: boolean;
  readonly detail: string;
}

/**
 * Gratuity for a leaver: `factor × last-drawn basic+DA × completed years`, if they have served the minimum
 * years, capped at the statutory ceiling. Pure. CONFIRM-WITH-CA.
 */
export function computeGratuity(input: { completedYears: number; lastDrawnBasicDaMinor: number; params: GratuityParams }): GratuityResult {
  const { completedYears, lastDrawnBasicDaMinor, params } = input;
  if (!Number.isInteger(completedYears) || completedYears < 0) throw new InvalidStatutorySchedule('completedYears must be a whole, non-negative number');
  if (!Number.isInteger(lastDrawnBasicDaMinor) || lastDrawnBasicDaMinor < 0) throw new InvalidStatutorySchedule('the last-drawn basic+DA must be a whole, non-negative paise amount');
  if (completedYears < params.minCompletedYears) {
    return { eligible: false, gratuityMinor: 0, cappedAtCeiling: false, detail: `not eligible — ${completedYears} completed year(s), needs ${params.minCompletedYears}` };
  }
  const raw = Number((BigInt(lastDrawnBasicDaMinor) * BigInt(completedYears) * BigInt(params.factorNumerator)) / BigInt(params.factorDenominator));
  const rawRupee = roundRupee(raw);
  const cappedAtCeiling = rawRupee > params.ceilingMinor;
  const gratuityMinor = cappedAtCeiling ? params.ceilingMinor : rawRupee;
  return {
    eligible: true,
    gratuityMinor,
    cappedAtCeiling,
    detail: `${params.factorNumerator}/${params.factorDenominator} × last-drawn × ${completedYears} yr = ${rawRupee}${cappedAtCeiling ? ` (capped at ${params.ceilingMinor})` : ''}`,
  };
}

// --- the settlement ----------------------------------------------------------------------------------

export interface SettlementLine {
  readonly label: string;
  readonly kind: 'earning' | 'recovery';
  readonly amountMinor: number;
}

export interface Settlement {
  readonly earnings: readonly SettlementLine[];
  readonly recoveries: readonly SettlementLine[];
  readonly grossEarningsMinor: number;
  readonly totalRecoveriesMinor: number;
  /** Signed: positive is payable to the employee, negative is recoverable from them. */
  readonly netSettlementMinor: number;
  readonly payableToEmployee: boolean;
  readonly gratuity: GratuityResult;
  readonly confirmWithCa: true;
  readonly detail: string;
}

export interface SettlementInput {
  /** The salary earned in the final part-month (already prorated by the payslip engine). */
  readonly pendingSalaryMinor: number;
  /** Unused leave to encash: days × per-day basic, optionally capped at `capDays`. */
  readonly leaveEncashment?: { readonly unusedLeaveDays: number; readonly perDayBasicMinor: number; readonly capDays?: number };
  /** Gratuity inputs; omit if not applicable. */
  readonly gratuity?: { readonly completedYears: number; readonly lastDrawnBasicDaMinor: number };
  /** Notice-period shortfall recovered from the employee. */
  readonly noticeRecoveryMinor?: number;
  /** Outstanding advances/loans recovered. */
  readonly loanRecoveryMinor?: number;
  readonly otherEarningsMinor?: number;
  readonly otherDeductionsMinor?: number;
  /** Tax (TDS) and any statutory deduction on the settlement, computed with the deduction engines. */
  readonly statutoryDeductionMinor?: number;
  readonly params: SettlementParams;
}

function assertMinor(label: string, v: number | undefined): number {
  if (v === undefined) return 0;
  if (!Number.isInteger(v) || v < 0) throw new InvalidStatutorySchedule(`${label} must be a whole, non-negative paise amount`);
  return v;
}

/**
 * Compute an exiting employee's full-and-final settlement: earnings (pending salary, leave encashment,
 * gratuity, other) minus recoveries (notice shortfall, loans, other, tax), netting to a signed amount —
 * payable to the employee, or recoverable from them when recoveries exceed dues. Itemised. Pure.
 */
export function computeSettlement(input: SettlementInput): Settlement {
  const pendingSalaryMinor = assertMinor('pendingSalaryMinor', input.pendingSalaryMinor);

  let encashmentMinor = 0;
  if (input.leaveEncashment !== undefined) {
    const le = input.leaveEncashment;
    if (!Number.isInteger(le.unusedLeaveDays) || le.unusedLeaveDays < 0) throw new InvalidStatutorySchedule('unusedLeaveDays must be a whole, non-negative number');
    assertMinor('perDayBasicMinor', le.perDayBasicMinor);
    if (le.capDays !== undefined && (!Number.isInteger(le.capDays) || le.capDays < 0)) throw new InvalidStatutorySchedule('capDays must be a whole, non-negative number');
    const days = le.capDays !== undefined ? Math.min(le.unusedLeaveDays, le.capDays) : le.unusedLeaveDays;
    encashmentMinor = days * le.perDayBasicMinor;
  }

  const gratuity = input.gratuity !== undefined
    ? computeGratuity({ completedYears: input.gratuity.completedYears, lastDrawnBasicDaMinor: input.gratuity.lastDrawnBasicDaMinor, params: input.params.gratuity })
    : { eligible: false, gratuityMinor: 0, cappedAtCeiling: false, detail: 'no gratuity claimed' };

  const otherEarningsMinor = assertMinor('otherEarningsMinor', input.otherEarningsMinor);
  const noticeRecoveryMinor = assertMinor('noticeRecoveryMinor', input.noticeRecoveryMinor);
  const loanRecoveryMinor = assertMinor('loanRecoveryMinor', input.loanRecoveryMinor);
  const otherDeductionsMinor = assertMinor('otherDeductionsMinor', input.otherDeductionsMinor);
  const statutoryDeductionMinor = assertMinor('statutoryDeductionMinor', input.statutoryDeductionMinor);

  const earnings: SettlementLine[] = [];
  if (pendingSalaryMinor > 0) earnings.push({ label: 'Pending salary', kind: 'earning', amountMinor: pendingSalaryMinor });
  if (encashmentMinor > 0) earnings.push({ label: 'Leave encashment', kind: 'earning', amountMinor: encashmentMinor });
  if (gratuity.gratuityMinor > 0) earnings.push({ label: 'Gratuity', kind: 'earning', amountMinor: gratuity.gratuityMinor });
  if (otherEarningsMinor > 0) earnings.push({ label: 'Other earnings', kind: 'earning', amountMinor: otherEarningsMinor });

  const recoveries: SettlementLine[] = [];
  if (noticeRecoveryMinor > 0) recoveries.push({ label: 'Notice-period recovery', kind: 'recovery', amountMinor: noticeRecoveryMinor });
  if (loanRecoveryMinor > 0) recoveries.push({ label: 'Loan/advance recovery', kind: 'recovery', amountMinor: loanRecoveryMinor });
  if (otherDeductionsMinor > 0) recoveries.push({ label: 'Other deductions', kind: 'recovery', amountMinor: otherDeductionsMinor });
  if (statutoryDeductionMinor > 0) recoveries.push({ label: 'Tax / statutory', kind: 'recovery', amountMinor: statutoryDeductionMinor });

  const grossEarningsMinor = earnings.reduce((s, l) => s + l.amountMinor, 0);
  const totalRecoveriesMinor = recoveries.reduce((s, l) => s + l.amountMinor, 0);
  const netSettlementMinor = grossEarningsMinor - totalRecoveriesMinor;
  const payableToEmployee = netSettlementMinor >= 0;

  return {
    earnings,
    recoveries,
    grossEarningsMinor,
    totalRecoveriesMinor,
    netSettlementMinor,
    payableToEmployee,
    gratuity,
    confirmWithCa: true,
    detail: `earnings ${grossEarningsMinor} − recoveries ${totalRecoveriesMinor} = ${netSettlementMinor} (${payableToEmployee ? 'payable to employee' : 'recoverable from employee'})`,
  };
}
