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
import { PAYROLL_RELEASE_STEP_UP } from './pay-run-store';
import { apiError } from '../../kernel/src/index';
import {
  resolveStatutoryParams, computeStatutoryDeductions, professionalTaxTamilNadu,
  resolveCompensation, buildPayslip,
  resolveTdsParams, computeTds, DEFAULT_TDS_SCHEDULE,
  foldPayRun, evaluatePayRunTransition,
  buildBankFile, InvalidBankFileInput,
  buildPayrollJournal, InvalidPayrollJournal,
  computeSettlement, resolveSettlementParams, DEFAULT_SETTLEMENT_SCHEDULE,
  employeeSelfView, EssAccessDenied, InvalidEssInput,
  DEFAULT_STATUTORY_SCHEDULE, InvalidStatutorySchedule,
  type StatutoryScheduleEntry, type PtSlab,
  type CompensationComponent, type CompensationStructureEntry,
  type TdsScheduleEntry, type TaxRegime,
  type PayRunEvent, type PayRunAction, type PayRunAggregate,
  type BankPaymentLine, type BankPaymentType,
  type PayrollTotals, type CostCentreGross,
  type SettlementScheduleEntry, type SettlementInput,
  type Payslip, type Settlement,
} from '../../../packages/payroll/src/index';

const isInt = (v: unknown): v is number => Number.isInteger(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * What the bank file and the journal need of head office (2b-vi-b-2 · audit PA-03, register row 12): the pay run as
 * head office RECORDED it — drafted, submitted, approved and locked step by step by signed-in people
 * (`/v1/hr/payroll/pay-run/:id/append`, actor = the caller). Absent (a bare stub), every run is unknown.
 */
export interface PayrollDeps {
  readonly loadPayRun?: (tenantId: string, payRunId: string) => Promise<PayRunAggregate | undefined> | PayRunAggregate | undefined;
}

/** Refused: the run's history in the request. Its approver was a string anyone could write; head office reads its own. */
const eventsInTheRequest = (what: string): Error => apiError(400, {
  code: 'pay_run_is_read_from_the_record',
  whatHappened: `The ${what} is built from the pay run head office recorded — who submitted, approved and locked it, each under their own sign-in — never from a history sent in the request (§28, audit PA-03).`,
  wasItSaved: 'not_saved',
  nextSafeAction: 'Send the payRunId without events[]. Nothing was built.',
});

/** The run as recorded, or refused by name. */
async function recordedRun(deps: PayrollDeps, tenantId: string, payRunId: string, what: string, code: string): Promise<PayRunAggregate> {
  const run = deps.loadPayRun === undefined ? undefined : await deps.loadPayRun(tenantId, payRunId);
  if (run === undefined) {
    throw apiError(422, { code, whatHappened: `Head office has no pay run ${payRunId} — a ${what} needs a locked run.`, wasItSaved: 'not_saved', nextSafeAction: 'Draft, submit, approve and lock the pay run first.' });
  }
  return run;
}

export function payrollRoutes(deps: PayrollDeps = {}): readonly Route[] {
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
      // Build the salary bank-transfer file from a LOCKED pay run. Body: { payRunId, lines[], valueDate?, paymentType? }.
      // The run is the one head office RECORDED (2b-vi-b-2): locked, approved by a different signed-in person; and when
      // the run recorded its net total and headcount, the lines must be exactly that money for exactly those people.
      api: 'API-09', method: 'POST', path: '/v1/hr/payroll/bank-file',
      permission: 'payroll.statutory.read', idempotent: true,
      // Building the salary bank file is the RELEASE moment of payroll (§28, SEC-03): it needs a RECENT,
      // MFA-backed re-authentication from the SIGNED token, enforced at the API boundary so a direct call
      // cannot skip the web-erp prompt (Stage E slice 1 — GAP-SEC-06 follow-on closed). The file still
      // transmits nothing: there is no bank connector on this surface.
      reauth: PAYROLL_RELEASE_STEP_UP,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (b['events'] !== undefined) throw eventsInTheRequest('bank file');
        if (typeof b['payRunId'] !== 'string' || !Array.isArray(b['lines'])) {
          throw apiError(400, { code: 'bank_file_needs_run_and_lines', whatHappened: 'The bank file needs payRunId and lines[] (per-employee net pay).', wasItSaved: 'not_saved', nextSafeAction: 'Send the pay run id and the net-pay lines (name, account, IFSC, amount).' });
        }
        const run = await recordedRun(deps, ctx.tenantId, b['payRunId'], 'bank file', 'bank_file_no_run');
        const lines = b['lines'] as BankPaymentLine[];
        const paid = lines.reduce((sum, l) => sum + (Number.isSafeInteger(l?.netPayMinor) ? l.netPayMinor : 0), 0);
        if ((run.netTotalMinor !== undefined && paid !== run.netTotalMinor) || (run.employeeCount !== undefined && lines.length !== run.employeeCount)) {
          throw apiError(422, {
            code: 'bank_file_does_not_match_the_run',
            whatHappened: `The lines pay ${paid} paise to ${lines.length} people; the approved run ${run.payRunId} is ${run.netTotalMinor ?? '—'} paise to ${run.employeeCount ?? '—'} people. A bank file pays exactly what was approved.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Build the file from the approved run\'s own lines. A different amount is a new run, approved again. Nothing was built.',
          });
        }
        try {
          const file = buildBankFile({
            payRunState: run.state,
            payPeriod: run.payPeriod,
            lines,
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
      // Build the balanced double-entry accounting journal from a LOCKED pay run. Body: { payRunId, totals,
      // costCentres? }. The run is the one head office RECORDED (2b-vi-b-2); its recorded net total must be the journal's.
      api: 'API-09', method: 'POST', path: '/v1/hr/payroll/journal',
      permission: 'payroll.statutory.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (b['events'] !== undefined) throw eventsInTheRequest('payroll journal');
        if (typeof b['payRunId'] !== 'string' || !isObj(b['totals'])) {
          throw apiError(400, { code: 'journal_needs_run_and_totals', whatHappened: 'The payroll journal needs payRunId and totals (gross, PF/ESI employee+employer, PT, TDS, net).', wasItSaved: 'not_saved', nextSafeAction: 'Send the pay run id and the run’s money totals.' });
        }
        const run = await recordedRun(deps, ctx.tenantId, b['payRunId'], 'journal', 'journal_no_run');
        const net = (b['totals'] as Record<string, unknown>)['netMinor'];
        if (run.netTotalMinor !== undefined && net !== run.netTotalMinor) {
          throw apiError(422, {
            code: 'journal_does_not_match_the_run',
            whatHappened: `The totals say net ${String(net)} paise; the approved run ${run.payRunId} is ${run.netTotalMinor} paise. The journal posts exactly what was approved.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the approved run\'s own totals. Nothing was built.',
          });
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
    {
      // A leaver's full-and-final settlement, for REVIEW: pending salary + leave encashment + gratuity (where
      // eligible) + other earnings, minus notice/loan/other recoveries and tax → a signed net (payable to, or
      // recoverable from, the employee). Body: { onDate, pendingSalaryMinor, leaveEncashment?, gratuity?,
      // noticeRecoveryMinor?, loanRecoveryMinor?, otherEarningsMinor?, otherDeductionsMinor?,
      // statutoryDeductionMinor?, schedule? }. Gratuity params (15/26, ≥5 yr, ₹20L cap) are CONFIRM-WITH-CA.
      api: 'API-09', method: 'POST', path: '/v1/hr/payroll/settlement',
      permission: 'payroll.statutory.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['onDate'] !== 'string' || !isInt(b['pendingSalaryMinor'])) {
          throw apiError(400, { code: 'settlement_needs_date_and_pending', whatHappened: 'A full-and-final settlement needs onDate (the exit date, YYYY-MM-DD) and pendingSalaryMinor (the final part-month salary, integer paise).', wasItSaved: 'not_saved', nextSafeAction: 'Send the exit date and the pending salary; add leaveEncashment, gratuity, recoveries and tax as needed.' });
        }
        const schedule = Array.isArray(b['schedule']) ? (b['schedule'] as SettlementScheduleEntry[]) : DEFAULT_SETTLEMENT_SCHEDULE;
        try {
          const params = resolveSettlementParams(schedule, b['onDate']);
          const input: SettlementInput = {
            pendingSalaryMinor: b['pendingSalaryMinor'] as number,
            params,
            ...(isObj(b['leaveEncashment']) ? { leaveEncashment: b['leaveEncashment'] as SettlementInput['leaveEncashment'] } : {}),
            ...(isObj(b['gratuity']) ? { gratuity: b['gratuity'] as SettlementInput['gratuity'] } : {}),
            ...(isInt(b['noticeRecoveryMinor']) ? { noticeRecoveryMinor: b['noticeRecoveryMinor'] as number } : {}),
            ...(isInt(b['loanRecoveryMinor']) ? { loanRecoveryMinor: b['loanRecoveryMinor'] as number } : {}),
            ...(isInt(b['otherEarningsMinor']) ? { otherEarningsMinor: b['otherEarningsMinor'] as number } : {}),
            ...(isInt(b['otherDeductionsMinor']) ? { otherDeductionsMinor: b['otherDeductionsMinor'] as number } : {}),
            ...(isInt(b['statutoryDeductionMinor']) ? { statutoryDeductionMinor: b['statutoryDeductionMinor'] as number } : {}),
          };
          const settlement = computeSettlement(input);
          return { status: 200, body: settlement };
        } catch (err) {
          if (err instanceof InvalidStatutorySchedule) throw apiError(400, { code: 'settlement_invalid', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the exit date, amounts, gratuity/leave inputs or schedule and try again.' });
          throw err;
        }
      },
    },
    {
      // Employee self-service: an employee's OWN payslip (and their own final settlement, if leaving), for
      // review. Body: { employeeId, payslip, settlement? }. Two controls: (1) self-scope — `employeeId` MUST
      // equal the authenticated caller (`ctx.userId`); asking for anyone else is refused (403). (2) redaction
      // — only the employee's own money is returned, employer cost shown separately. Gated on the narrow,
      // widely-held `payroll.ess.self`, NOT the confidential `payroll.statutory.read`.
      api: 'API-09', method: 'POST', path: '/v1/hr/payroll/ess/self',
      permission: 'payroll.ess.self', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['employeeId'] !== 'string' || !isObj(b['payslip'])) {
          throw apiError(400, { code: 'ess_needs_employee_and_payslip', whatHappened: 'A self-service view needs employeeId (your own) and payslip (your own payslip).', wasItSaved: 'not_saved', nextSafeAction: 'Send your employeeId and your payslip; add settlement if you are leaving.' });
        }
        try {
          const view = employeeSelfView({
            requesterEmployeeId: ctx.userId,
            subjectEmployeeId: b['employeeId'],
            payslip: b['payslip'] as unknown as Payslip,
            ...(isObj(b['settlement']) ? { settlement: b['settlement'] as unknown as Settlement } : {}),
          });
          return { status: 200, body: view };
        } catch (err) {
          if (err instanceof EssAccessDenied) throw apiError(403, { code: 'ess_not_your_record', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'You may only view your own payslip. Ask HR for anyone else’s.' });
          if (err instanceof InvalidEssInput) throw apiError(400, { code: 'ess_invalid_payslip', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Send a well-formed payslip (earnings, statutory breakdown, gross and net).' });
          throw err;
        }
      },
    },
  ];
}
