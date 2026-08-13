// HR/Payroll — statutory-deduction preview (roadmap priority 16, owner directive §6), on the tested
// `packages/payroll` engine. From a month's earnings and the in-force statutory parameters, compute the
// employee deductions (PF, ESI, Professional Tax) and the net pay — for REVIEW. A real pay run needs
// CA/HR/legal sign-off (an externally-blocked GO), so this route commits nothing.
//
//   • `POST /v1/hr/payroll/statutory-deductions` — a month's PF/ESI/PT and net, from earnings + pay date.
//   • `POST /v1/hr/payroll/professional-tax-tn`   — Tamil Nadu half-yearly PT from half-yearly income.
//
// Stateless over the tested engine; the shipped rate/ceiling/slab defaults are CONFIRM-WITH-CA. Payroll is
// confidential, so both routes are gated on the owner-held `payroll.statutory.read` permission.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  resolveStatutoryParams, computeStatutoryDeductions, professionalTaxTamilNadu,
  resolveCompensation, buildPayslip,
  resolveTdsParams, computeTds, DEFAULT_TDS_SCHEDULE,
  foldPayRun, evaluatePayRunTransition,
  DEFAULT_STATUTORY_SCHEDULE, InvalidStatutorySchedule,
  type StatutoryScheduleEntry, type PtSlab,
  type CompensationComponent, type CompensationStructureEntry,
  type TdsScheduleEntry, type TaxRegime,
  type PayRunEvent, type PayRunAction,
} from '../../../packages/payroll/src/index';

const isInt = (v: unknown): v is number => Number.isInteger(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function payrollRoutes(): readonly Route[] {
  return [
    {
      // A month's statutory deductions + net pay. Body: { onDate, grossMinor, pfWageMinor,
      // esiCoveredForPeriod?, professionalTaxMonthlyMinor?, schedule? }. Schedule defaults to the shipped one.
      api: 'API-09', method: 'POST', path: '/v1/hr/payroll/statutory-deductions',
      permission: 'payroll.statutory.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['onDate'] !== 'string' || !isInt(b['grossMinor']) || !isInt(b['pfWageMinor'])) {
          throw apiError(400, { code: 'statutory_needs_date_and_wages', whatHappened: 'Statutory deductions need onDate (YYYY-MM-DD), grossMinor (integer paise) and pfWageMinor (integer paise).', wasItSaved: 'not_saved', nextSafeAction: 'Send the pay date and the month’s gross and PF-wage amounts in paise.' });
        }
        const schedule = Array.isArray(b['schedule']) ? (b['schedule'] as StatutoryScheduleEntry[]) : DEFAULT_STATUTORY_SCHEDULE;
        try {
          const params = resolveStatutoryParams(schedule, b['onDate']);
          const result = computeStatutoryDeductions({
            grossMinor: b['grossMinor'] as number,
            pfWageMinor: b['pfWageMinor'] as number,
            params,
            ...(typeof b['esiCoveredForPeriod'] === 'boolean' ? { esiCoveredForPeriod: b['esiCoveredForPeriod'] } : {}),
            ...(isInt(b['professionalTaxMonthlyMinor']) ? { professionalTaxMonthlyMinor: b['professionalTaxMonthlyMinor'] as number } : {}),
          });
          return { status: 200, body: { ...result, confirmWithCa: true } };
        } catch (err) {
          if (err instanceof InvalidStatutorySchedule) throw apiError(400, { code: 'statutory_invalid', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the pay date, wages or schedule and try again.' });
          throw err;
        }
      },
    },
    {
      // Tamil Nadu half-yearly Professional Tax. Body: { onDate, halfYearlyIncomeMinor, schedule? }.
      api: 'API-09', method: 'POST', path: '/v1/hr/payroll/professional-tax-tn',
      permission: 'payroll.statutory.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['onDate'] !== 'string' || !isInt(b['halfYearlyIncomeMinor'])) {
          throw apiError(400, { code: 'pt_needs_date_and_income', whatHappened: 'TN Professional Tax needs onDate (YYYY-MM-DD) and halfYearlyIncomeMinor (integer paise).', wasItSaved: 'not_saved', nextSafeAction: 'Send the date and the half-yearly income in paise.' });
        }
        const schedule = Array.isArray(b['schedule']) ? (b['schedule'] as StatutoryScheduleEntry[]) : DEFAULT_STATUTORY_SCHEDULE;
        try {
          const params = resolveStatutoryParams(schedule, b['onDate']);
          const result = professionalTaxTamilNadu(b['halfYearlyIncomeMinor'] as number, params.ptTamilNaduHalfYearly as PtSlab[]);
          return { status: 200, body: { ...result, confirmWithCa: true } };
        } catch (err) {
          if (err instanceof InvalidStatutorySchedule) throw apiError(400, { code: 'pt_invalid', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the date, income or schedule and try again.' });
          throw err;
        }
      },
    },
    {
      // A full payslip for review: earnings prorated for paid days → gross + PF wage → statutory → net.
      // Body: { onDate, attendance:{calendarDaysInMonth,paidDays}, components? | compensationHistory?,
      //         schedule?, professionalTaxMonthlyMinor?, esiCoveredForPeriod? }.
      api: 'API-09', method: 'POST', path: '/v1/hr/payroll/payslip',
      permission: 'payroll.statutory.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const att = b['attendance'];
        if (typeof b['onDate'] !== 'string' || !isObj(att) || !isInt(att['calendarDaysInMonth']) || !isInt(att['paidDays'])) {
          throw apiError(400, { code: 'payslip_needs_date_and_attendance', whatHappened: 'A payslip needs onDate (YYYY-MM-DD) and attendance { calendarDaysInMonth, paidDays }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the pay date, the month’s calendar days and the paid days, plus the compensation.' });
        }
        const hasHistory = Array.isArray(b['compensationHistory']);
        const hasComponents = Array.isArray(b['components']);
        if (!hasHistory && !hasComponents) {
          throw apiError(400, { code: 'payslip_needs_compensation', whatHappened: 'A payslip needs the compensation — either components (in force) or a compensationHistory to resolve on the pay date.', wasItSaved: 'not_saved', nextSafeAction: 'Send components: [{ code, monthlyMinor, partOfPfWage?, partOfGross? }, …] or compensationHistory.' });
        }
        const schedule = Array.isArray(b['schedule']) ? (b['schedule'] as StatutoryScheduleEntry[]) : DEFAULT_STATUTORY_SCHEDULE;
        try {
          const params = resolveStatutoryParams(schedule, b['onDate']);
          const components = hasHistory
            ? resolveCompensation(b['compensationHistory'] as CompensationStructureEntry[], b['onDate'])
            : (b['components'] as CompensationComponent[]);
          const payslip = buildPayslip({
            onDate: b['onDate'],
            components,
            attendance: { calendarDaysInMonth: att['calendarDaysInMonth'] as number, paidDays: att['paidDays'] as number },
            params,
            ...(typeof b['esiCoveredForPeriod'] === 'boolean' ? { esiCoveredForPeriod: b['esiCoveredForPeriod'] } : {}),
            ...(isInt(b['professionalTaxMonthlyMinor']) ? { professionalTaxMonthlyMinor: b['professionalTaxMonthlyMinor'] as number } : {}),
            ...(isInt(b['tdsMonthlyMinor']) ? { tdsMonthlyMinor: b['tdsMonthlyMinor'] as number } : {}),
          });
          return { status: 200, body: payslip };
        } catch (err) {
          if (err instanceof InvalidStatutorySchedule) throw apiError(400, { code: 'payslip_invalid', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the date, attendance, compensation or schedule and try again.' });
          throw err;
        }
      },
    },
    {
      // This month's TDS (income tax). Body: { onDate, regime, annualGrossIncomeMinor, declaredDeductionsMinor?,
      //   tdsAlreadyDeductedMinor?, monthsRemaining?, schedule? }. Feed the result's tdsMonthlyMinor to the payslip.
      api: 'API-09', method: 'POST', path: '/v1/hr/payroll/tds',
      permission: 'payroll.statutory.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const regime = b['regime'];
        if (typeof b['onDate'] !== 'string' || (regime !== 'new' && regime !== 'old') || !isInt(b['annualGrossIncomeMinor'])) {
          throw apiError(400, { code: 'tds_needs_date_regime_income', whatHappened: 'TDS needs onDate (YYYY-MM-DD), regime ("new"/"old") and annualGrossIncomeMinor (integer paise).', wasItSaved: 'not_saved', nextSafeAction: 'Send the pay date, the chosen tax regime and the projected annual gross income.' });
        }
        const schedule = Array.isArray(b['schedule']) ? (b['schedule'] as TdsScheduleEntry[]) : DEFAULT_TDS_SCHEDULE;
        try {
          const params = resolveTdsParams(schedule, b['onDate']);
          const result = computeTds({
            annualGrossIncomeMinor: b['annualGrossIncomeMinor'] as number,
            regime: regime as TaxRegime,
            params,
            ...(isInt(b['declaredDeductionsMinor']) ? { declaredDeductionsMinor: b['declaredDeductionsMinor'] as number } : {}),
            ...(isInt(b['tdsAlreadyDeductedMinor']) ? { tdsAlreadyDeductedMinor: b['tdsAlreadyDeductedMinor'] as number } : {}),
            ...(isInt(b['monthsRemaining']) ? { monthsRemaining: b['monthsRemaining'] as number } : {}),
          });
          return { status: 200, body: result };
        } catch (err) {
          if (err instanceof InvalidStatutorySchedule) throw apiError(400, { code: 'tds_invalid', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the date, regime, income or schedule and try again.' });
          throw err;
        }
      },
    },
    {
      // Evaluate a pay-run lifecycle transition. Body: { payRunId, events: PayRunEvent[], action, actor,
      // reason? }. Folds the append-only events to the current state, then says whether the action is
      // allowed — enforcing maker ≠ checker and lock-is-final. Preview: the caller appends the event on OK.
      api: 'API-09', method: 'POST', path: '/v1/hr/payroll/pay-run/evaluate',
      permission: 'payroll.statutory.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const ACTIONS: readonly PayRunAction[] = ['submit', 'approve', 'reject', 'lock', 'reverse'];
        if (typeof b['payRunId'] !== 'string' || !Array.isArray(b['events']) || !ACTIONS.includes(b['action'] as PayRunAction) || typeof b['actor'] !== 'string') {
          throw apiError(400, { code: 'pay_run_needs_events_action_actor', whatHappened: 'Evaluating a pay-run transition needs payRunId, events[] (the append-only history), action (submit/approve/reject/lock/reverse) and actor.', wasItSaved: 'not_saved', nextSafeAction: 'Send the run’s events, the proposed action and who is taking it.' });
        }
        const current = foldPayRun(b['payRunId'], b['events'] as PayRunEvent[]);
        const decision = evaluatePayRunTransition({
          ...(current !== undefined ? { current } : {}),
          action: b['action'] as PayRunAction,
          actor: b['actor'],
          ...(typeof b['reason'] === 'string' ? { reason: b['reason'] } : {}),
        });
        return { status: 200, body: { current: current ?? null, decision } };
      },
    },
  ];
}
