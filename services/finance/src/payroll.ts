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
  buildBankFile, InvalidBankFileInput,
  buildPayrollJournal, InvalidPayrollJournal,
  DEFAULT_STATUTORY_SCHEDULE, InvalidStatutorySchedule,
  type StatutoryScheduleEntry, type PtSlab,
  type CompensationComponent, type CompensationStructureEntry,
  type TdsScheduleEntry, type TaxRegime,
  type PayRunEvent, type PayRunAction,
  type BankPaymentLine, type BankPaymentType,
  type PayrollTotals, type CostCentreGross,
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
    {
      // Build the salary bank-transfer file from a LOCKED pay run. Body: { payRunId, events, lines[],
      // valueDate?, paymentType? }. The events are folded to confirm the run is locked before the file builds.
      api: 'API-09', method: 'POST', path: '/v1/hr/payroll/bank-file',
      permission: 'payroll.statutory.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['payRunId'] !== 'string' || !Array.isArray(b['events']) || !Array.isArray(b['lines'])) {
          throw apiError(400, { code: 'bank_file_needs_run_and_lines', whatHappened: 'The bank file needs payRunId, the pay run’s events[] (to confirm it is locked) and lines[] (per-employee net pay).', wasItSaved: 'not_saved', nextSafeAction: 'Send the pay run history and the net-pay lines (name, account, IFSC, amount).' });
        }
        const run = foldPayRun(b['payRunId'], b['events'] as PayRunEvent[]);
        if (run === undefined) {
          throw apiError(422, { code: 'bank_file_no_run', whatHappened: 'There is no pay run for those events — a bank file needs a locked run.', wasItSaved: 'not_saved', nextSafeAction: 'Draft, submit, approve and lock the pay run first.' });
        }
        try {
          const file = buildBankFile({
            payRunState: run.state,
            payPeriod: run.payPeriod,
            lines: b['lines'] as BankPaymentLine[],
            ...(typeof b['valueDate'] === 'string' ? { valueDate: b['valueDate'] } : {}),
            ...(typeof b['paymentType'] === 'string' ? { paymentType: b['paymentType'] as BankPaymentType } : {}),
          });
          return { status: 200, body: file };
        } catch (err) {
          if (err instanceof InvalidBankFileInput) throw apiError(422, { code: 'bank_file_invalid', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Lock the run and fix the named lines, then rebuild — a bad line in a bulk file is a failed payment.' });
          throw err;
        }
      },
    },
    {
      // Build the balanced double-entry accounting journal from a LOCKED pay run. Body: { payRunId, events,
      // totals, costCentres? }. The events are folded to confirm the run is locked before the journal builds.
      api: 'API-09', method: 'POST', path: '/v1/hr/payroll/journal',
      permission: 'payroll.statutory.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['payRunId'] !== 'string' || !Array.isArray(b['events']) || !isObj(b['totals'])) {
          throw apiError(400, { code: 'journal_needs_run_and_totals', whatHappened: 'The payroll journal needs payRunId, the pay run’s events[] (to confirm it is locked) and totals (gross, PF/ESI employee+employer, PT, TDS, net).', wasItSaved: 'not_saved', nextSafeAction: 'Send the pay run history and the run’s money totals.' });
        }
        const run = foldPayRun(b['payRunId'], b['events'] as PayRunEvent[]);
        if (run === undefined) {
          throw apiError(422, { code: 'journal_no_run', whatHappened: 'There is no pay run for those events — a journal needs a locked run.', wasItSaved: 'not_saved', nextSafeAction: 'Draft, submit, approve and lock the pay run first.' });
        }
        try {
          const journal = buildPayrollJournal({
            payRunState: run.state,
            payPeriod: run.payPeriod,
            totals: b['totals'] as unknown as PayrollTotals,
            ...(Array.isArray(b['costCentres']) ? { costCentres: b['costCentres'] as CostCentreGross[] } : {}),
          });
          return { status: 200, body: journal };
        } catch (err) {
          if (err instanceof InvalidPayrollJournal) throw apiError(422, { code: 'journal_invalid', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Lock the run and send consistent totals (net = gross − employee deductions; cost-centres sum to gross).' });
          throw err;
        }
      },
    },
  ];
}
