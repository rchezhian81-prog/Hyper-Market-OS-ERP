// The R4 statutory payslip (C15 · C16 · C19): one payslip for review that carries every R4 check — the hours actually
// worked per day (from attendance), overtime above the normal hours at no less than twice the ordinary rate, the
// minimum-wage floor for the person's class, and PF / ESI from the CA's confirmed settings and the shop's headcount.
// Every check whose figure the CA has not confirmed says "not checked" (or "not worked out") in words, and is named in
// `notChecked` so the pay run can say it out loud (OB-208). Two things are REFUSED outright, per the signed sentences:
// an overtime rate below twice the ordinary rate (OvertimeBelowFloor) and, once confirmed, a month's pay below the
// minimum wage (BelowMinimumWage).
//
// It computes for REVIEW. Approving, locking and the bank file stay on hold (OB-209): nothing here touches the pay-run
// lifecycle or the bank file.
//
// Exact integer paise. Pure and deterministic: no clock, no I/O.

import { InvalidStatutorySchedule, type StatutoryDeductionResult } from './statutory';
import type { CompensationComponent, Payslip, PayslipEarning, Attendance } from './payslip';
import type { PayrollLegalSettings } from './legal-settings';
import { assessContributions, type ContributionAssessment } from './contribution-summary';
import { hoursAndOvertime, overtimePay, type DayWorked, type HoursAndOvertime, type HoursFact, type OvertimePay } from './overtime';
import { checkMinimumWage, type MinimumWageCheck } from './minimum-wage';

export interface StatutoryChecks {
  readonly contributions: ContributionAssessment;
  /** The hours actually worked, per day — shown on the payslip. */
  readonly hoursWorked: { readonly days: readonly DayWorked[]; readonly totalWorkedMinutes: number };
  readonly overtime: {
    readonly status: HoursAndOvertime['status'];
    readonly overtimeMinutes: number | null;
    readonly normalDailyMinutes: number | null;
    readonly normalWeeklyMinutes: number | null;
    readonly weeks: HoursAndOvertime['weeks'];
    readonly pay: OvertimePay;
  };
  readonly minimumWage: MinimumWageCheck;
  /** Every check that could not be made, in words — what the pay run says. */
  readonly notChecked: readonly string[];
}

export interface StatutoryPayslip extends Payslip {
  readonly period: string;
  readonly statutoryChecks: StatutoryChecks;
}

export const OVERTIME_EARNING_CODE = 'OVERTIME';

function prorate(fullMonthMinor: number, paidDays: number, calendarDays: number): number {
  if (paidDays === calendarDays) return fullMonthMinor;
  return Math.round((fullMonthMinor * paidDays) / calendarDays);
}

/**
 * Build the R4 statutory payslip. Throws OvertimeBelowFloor ("overtime below 2×") and BelowMinimumWage ("below minimum
 * wage"); InvalidStatutorySchedule for unreadable input. Pure.
 */
export function buildStatutoryPayslip(input: {
  readonly period: string;
  readonly onDate: string;
  readonly components: readonly CompensationComponent[];
  readonly attendance: Attendance;
  readonly settings: PayrollLegalSettings;
  readonly headcount: number;
  /** The person's staff-directory roles — their minimum-wage class follows from them. */
  readonly roles: readonly string[];
  /** The hours per day from attendance, for the month. */
  readonly hours: readonly HoursFact[];
  /** The ordinary hourly rate, from the staff directory. */
  readonly ordinaryHourlyRateMinor?: number;
  /** An overtime rate asked for (never below 2× the ordinary rate). */
  readonly overtimeHourlyRateMinor?: number;
  readonly esiCoveredForPeriod?: boolean;
  readonly professionalTaxMonthlyMinor?: number;
  readonly tdsMonthlyMinor?: number;
}): StatutoryPayslip {
  const { calendarDaysInMonth, paidDays } = input.attendance;
  if (!/^\d{4}-\d{2}$/.test(input.period)) throw new InvalidStatutorySchedule(`the pay period must be YYYY-MM, but reads "${input.period}"`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.onDate) || Number.isNaN(Date.parse(input.onDate))) throw new InvalidStatutorySchedule(`the pay date must be YYYY-MM-DD, but reads "${input.onDate}"`);
  if (!Number.isInteger(calendarDaysInMonth) || calendarDaysInMonth < 28 || calendarDaysInMonth > 31) throw new InvalidStatutorySchedule(`calendarDaysInMonth must be 28–31, but reads "${calendarDaysInMonth}"`);
  if (!Number.isInteger(paidDays) || paidDays < 0 || paidDays > calendarDaysInMonth) throw new InvalidStatutorySchedule(`paidDays must be a whole number between 0 and ${calendarDaysInMonth}, but reads "${paidDays}"`);
  if (input.components.length === 0) throw new InvalidStatutorySchedule('the compensation structure has no earnings');
  const pt = input.professionalTaxMonthlyMinor ?? 0;
  const tds = input.tdsMonthlyMinor ?? 0;
  if (!Number.isInteger(pt) || pt < 0 || !Number.isInteger(tds) || tds < 0) throw new InvalidStatutorySchedule('PT and TDS must be whole, non-negative paise amounts');

  // Earnings for the paid days; the agreed full-month gross is what the minimum wage is judged on.
  const earnings: PayslipEarning[] = [];
  let grossMinor = 0;
  let pfWageMinor = 0;
  let fullMonthGrossMinor = 0;
  for (const c of input.components) {
    if (!Number.isInteger(c.monthlyMinor) || c.monthlyMinor < 0) throw new InvalidStatutorySchedule(`the amount for "${c.code}" must be a whole, non-negative paise value`);
    if (c.code === OVERTIME_EARNING_CODE) throw new InvalidStatutorySchedule(`"${OVERTIME_EARNING_CODE}" is worked out from attendance, never typed into the compensation`);
    const earnedMinor = prorate(c.monthlyMinor, paidDays, calendarDaysInMonth);
    earnings.push({ code: c.code, fullMonthMinor: c.monthlyMinor, earnedMinor });
    if (c.partOfGross !== false) { grossMinor += earnedMinor; fullMonthGrossMinor += c.monthlyMinor; }
    if (c.partOfPfWage === true) pfWageMinor += earnedMinor;
  }

  // C16 — minimum wage first: a refusal here means nothing else matters.
  const minimumWage = checkMinimumWage({ settings: input.settings, roles: input.roles, monthlyPayMinor: fullMonthGrossMinor });

  // C16 — hours worked and overtime.
  const hours = hoursAndOvertime({ settings: input.settings, period: input.period, hours: input.hours });
  const pay = overtimePay({
    settings: input.settings, overtimeMinutes: hours.overtimeMinutes,
    ...(input.ordinaryHourlyRateMinor === undefined ? {} : { ordinaryHourlyRateMinor: input.ordinaryHourlyRateMinor }),
    ...(input.overtimeHourlyRateMinor === undefined ? {} : { overtimeHourlyRateMinor: input.overtimeHourlyRateMinor }),
  });
  if (pay.status === 'paid' && (pay.payMinor ?? 0) > 0) {
    earnings.push({ code: OVERTIME_EARNING_CODE, fullMonthMinor: pay.payMinor as number, earnedMinor: pay.payMinor as number });
    grossMinor += pay.payMinor as number; // overtime is wages for ESI, not part of the PF wage
  }

  // C19 — PF and ESI from the confirmed settings and the headcount.
  const contributions = assessContributions({
    settings: input.settings, headcount: input.headcount, grossMinor, pfWageMinor,
    ...(input.esiCoveredForPeriod === undefined ? {} : { esiCoveredForPeriod: input.esiCoveredForPeriod }),
  });
  const pfE = contributions.pf.employeeMinor ?? 0;
  const pfR = contributions.pf.employerMinor ?? 0;
  const esiE = contributions.esi.employeeMinor ?? 0;
  const esiR = contributions.esi.employerMinor ?? 0;
  const totalEmployeeDeductionMinor = pfE + esiE + pt + tds;
  const netPayMinor = grossMinor - totalEmployeeDeductionMinor;
  const statutory: StatutoryDeductionResult = {
    pfEmployeeMinor: pfE, pfEmployerMinor: pfR,
    esiApplicable: contributions.esi.status === 'deducted', esiEmployeeMinor: esiE, esiEmployerMinor: esiR,
    professionalTaxMinor: pt, tdsMinor: tds,
    totalEmployeeDeductionMinor, totalEmployerContributionMinor: pfR + esiR, netPayMinor,
    detail: `${contributions.pf.why}; ${contributions.esi.why}`,
  };

  const notChecked = [
    ...(minimumWage.status === 'not_checked' ? [minimumWage.detail] : []),
    ...hours.notSet,
    ...(pay.status === 'rate_not_set' || pay.status === 'ordinary_rate_unknown' ? [pay.detail] : []),
    ...(contributions.pf.status === 'not_confirmed' ? [contributions.pf.why] : []),
    ...(contributions.esi.status === 'not_confirmed' ? [contributions.esi.why] : []),
  ];

  const lopDays = calendarDaysInMonth - paidDays;
  return {
    period: input.period, onDate: input.onDate, calendarDaysInMonth, paidDays, lopDays, earnings, grossMinor, pfWageMinor,
    statutory, netPayMinor, confirmWithCa: true,
    detail: `${paidDays}/${calendarDaysInMonth} paid days${lopDays > 0 ? ` (${lopDays} LOP)` : ''}: gross ${grossMinor}, deductions ${totalEmployeeDeductionMinor}, net ${netPayMinor}`,
    statutoryChecks: {
      contributions,
      hoursWorked: { days: hours.days, totalWorkedMinutes: hours.totalWorkedMinutes },
      overtime: { status: hours.status, overtimeMinutes: hours.overtimeMinutes, normalDailyMinutes: hours.normalDailyMinutes, normalWeeklyMinutes: hours.normalWeeklyMinutes, weeks: hours.weeks, pay },
      minimumWage, notChecked,
    },
  };
}
