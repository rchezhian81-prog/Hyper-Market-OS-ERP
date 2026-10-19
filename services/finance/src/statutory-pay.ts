// API-09 Payroll — the R4 statutory pay checks (C15 · C16 · C19 · OB-208 · OB-209 · OB-227), on the tested
// `packages/payroll` engines. Head-office routes only; the rules live in the package.
//
//   • GET  /v1/hr/payroll/legal-settings            — every legal figure (EPF / ESI rates, ceilings and headcount
//     thresholds; normal daily and weekly hours; the overtime multiplier), every minimum-wage class and the payslip
//     particulars list, each "confirmed" or "not confirmed" with what is missing. `payroll.legal.read`.
//   • POST /v1/hr/payroll/legal-settings/:key       — the CA (or the owner on the CA's written confirmation) fills one:
//     a figure key, `minimum-wage-<classId>` or `payslip-particulars`. Body { value | …, source, confirmation }. A
//     multiplier below 200% is refused ("overtime below 2×"). Append-only; audited. `payroll.legal.configure`.
//   • POST /v1/hr/payroll/statutory-payslips/:employeeId/:period — PREPARE one person's payslip for review: the hours
//     per day from attendance, overtime, the minimum wage, PF / ESI on the headcount. Refused 422 by name: "overtime
//     below 2×", "below minimum wage". Stored (append-only, latest per person and month) so the pay run can be checked.
//   • GET  /v1/hr/payroll/statutory-check/:period   — what the pay run says: every check not made ("minimum wage not
//     checked", "overtime limit not set", "PF not worked out …"), the payslips prepared, the contribution
//     reconciliation and the payslips late for their pay date. Read-only.
//   • POST /v1/hr/payroll/contributions/:period/totals — record the month's EPF / ESI totals (from the return or
//     challan) with a reference; GET /v1/hr/payroll/contributions/:period — do they equal the payslips to the paisa?
//   • GET  /v1/hr/payroll/payslip-exceptions?period= — payslips not issued by their pay date; POST …/raise puts each
//     one in every owner's alert inbox (once per payslip).
//
// Payroll is confidential: everything but the settings is owner-gated on `payroll.statutory.read`. Nothing here
// approves, locks or releases a pay run, or builds a bank file (OB-209) — those routes are unchanged and on hold.

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/audit-trail';
import type { Employee } from '../../../packages/workforce/src/workforce';
import {
  PAYROLL_FIGURE_KEYS, PAYROLL_FIGURES, PAYSLIP_PARTICULARS, PAYSLIP_PARTICULAR_KEYS, OVERTIME_FLOOR_PERCENT,
  figureStatuses, figureValueIsValid, minimumWageClassConfirmed, particularsListConfirmed,
  resolveCompensation, buildStatutoryPayslip, reconcileContributions, payslipsLateForPayDate, localDate, daysOfMonth,
  OvertimeBelowFloor, BelowMinimumWage, InvalidStatutorySchedule, InvalidOvertimeInput, InvalidContributionInput,
  CONTRIBUTION_FIELDS,
  type PayrollLegalSettings, type PayrollLegalSettingChange, type PayrollFigureKey, type PayslipParticularKey,
  type StatutoryPayslip, type HoursFact, type RecordedContributionTotals, type PayslipLateException,
  type CompensationComponent, type CompensationStructureEntry,
} from '../../../packages/payroll/src/index';
import type { IssuedPayslip } from './payslip-store';

/** A payslip prepared for review — who prepared it and when; the latest per (employee, period) stands. */
export interface PreparedPayslip {
  readonly employeeId: string;
  readonly period: string;
  readonly payslip: StatutoryPayslip;
  readonly preparedBy: string;
  readonly preparedAt: string;
}

export interface StatutoryPayDeps {
  readonly now: () => string;
  readonly settings: (tenantId: string) => Promise<PayrollLegalSettings>;
  readonly recordSettingChange: (tenantId: string, change: PayrollLegalSettingChange, key: string) => Promise<void>;
  /** The staff directory (the roster store's people). */
  readonly staff: (tenantId: string) => Promise<readonly Employee[]>;
  /** A person's hours per day from attendance, `from`..`to` inclusive (latest per day). */
  readonly hoursBetween: (tenantId: string, employeeId: string, from: string, to: string) => Promise<readonly HoursFact[]>;
  readonly prepared: (tenantId: string, period: string) => Promise<readonly PreparedPayslip[]>;
  readonly recordPrepared: (tenantId: string, p: PreparedPayslip, key: string) => Promise<void>;
  /** The issued payslips of a period, latest issue per person. */
  readonly issued: (tenantId: string, period: string) => Promise<readonly IssuedPayslip[]>;
  readonly contributionTotals: (tenantId: string, period: string) => Promise<RecordedContributionTotals | undefined>;
  readonly recordContributionTotals: (tenantId: string, t: RecordedContributionTotals, key: string) => Promise<void>;
  /** The store's offset from UTC in minutes (India +330) — the working-time pack's setting. */
  readonly utcOffsetMinutes: (tenantId: string) => Promise<number>;
  /** Put each exception in every owner's alert inbox, once. */
  readonly raiseOwnerAlerts: (tenantId: string, exceptions: readonly PayslipLateException[], by: string, at: string) => Promise<{ readonly raised: number; readonly alreadyOpen: number; readonly owners: number }>;
  readonly recordAudit: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const optText = (v: unknown): string | null => (isStr(v) ? v.trim() : null);
const isPeriod = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
const bad = (code: string, whatHappened: string, nextSafeAction: string) => apiError(400, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });
const refused = (code: string, whatHappened: string, nextSafeAction: string) => apiError(422, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });

const audit = (ctx: RequestContext, deps: StatutoryPayDeps, action: string, objectId: string, after: Record<string, string>): Promise<unknown> | void =>
  deps.recordAudit(ctx.tenantId, {
    actorId: ctx.userId, action, objectType: 'payroll_legal_setting', objectId, at: deps.now(),
    origin: { tenantId: ctx.tenantId, branchId: null }, before: null, after, correlationId: ctx.traceId,
  });

/** Everything the settings page shows: each figure, each class and the particulars list with its status. */
export function legalSettingsView(settings: PayrollLegalSettings) {
  const figures = figureStatuses(settings);
  return {
    figures,
    minimumWages: settings.minimumWages.map((c) => ({ ...c, status: minimumWageClassConfirmed(c) ? 'confirmed' : 'not_confirmed' })),
    particulars: {
      ...settings.particulars,
      status: particularsListConfirmed(settings.particulars) ? 'confirmed' : 'not_confirmed',
      catalogue: PAYSLIP_PARTICULAR_KEYS.map((k) => ({ key: k, ...PAYSLIP_PARTICULARS[k] })),
    },
    notConfirmed: figures.filter((f) => f.status === 'not_confirmed').map((f) => f.key),
    overtimeFloor: { percent: OVERTIME_FLOOR_PERCENT, words: 'Overtime is never paid at less than twice the ordinary hourly rate (owner\'s signed sentence, C16).' },
    note: 'Every figure is the CA\'s to fill (OB-208). Until one is confirmed it is never assumed: the check that needs it says "not checked".',
  };
}

/** The month's payslip lines and the reconciliation against the recorded totals. */
async function contributionsFor(deps: StatutoryPayDeps, tenantId: string, period: string) {
  const issued = await deps.issued(tenantId, period);
  const lines = issued.map((p) => ({
    employeeId: p.employeeId,
    pfEmployeeMinor: p.payslip.statutory.pfEmployeeMinor, pfEmployerMinor: p.payslip.statutory.pfEmployerMinor,
    esiEmployeeMinor: p.payslip.statutory.esiEmployeeMinor, esiEmployerMinor: p.payslip.statutory.esiEmployerMinor,
  }));
  return reconcileContributions({ period, lines, recorded: (await deps.contributionTotals(tenantId, period)) ?? null });
}

/** The payslips late for their pay date: every prepared one, against its issue. */
async function lateFor(deps: StatutoryPayDeps, tenantId: string, period: string | undefined): Promise<readonly PayslipLateException[]> {
  const offset = await deps.utcOffsetMinutes(tenantId);
  const today = localDate(deps.now(), offset);
  const periods = period === undefined ? undefined : [period];
  const prepared = periods === undefined ? [] : await deps.prepared(tenantId, periods[0]!);
  const issued = periods === undefined ? [] : await deps.issued(tenantId, periods[0]!);
  const issuedAt = new Map(issued.map((i) => [i.employeeId, i.issuedAt] as const));
  const issuedWithoutTime = new Set(issued.filter((i) => i.issuedAt === undefined).map((i) => i.employeeId));
  return payslipsLateForPayDate({
    today, utcOffsetMinutes: offset,
    expected: prepared.filter((p) => !issuedWithoutTime.has(p.employeeId)).map((p) => ({
      employeeId: p.employeeId, period: p.period, payDate: p.payslip.onDate,
      ...(issuedAt.get(p.employeeId) === undefined ? {} : { issuedAt: issuedAt.get(p.employeeId)! }),
    })),
  });
}

export function statutoryPayRoutes(deps: StatutoryPayDeps): readonly Route[] {
  return [
    {
      api: 'API-09', method: 'GET', path: '/v1/hr/payroll/legal-settings',
      permission: 'payroll.legal.read',
      handler: async (ctx) => ({ status: 200, body: legalSettingsView(await deps.settings(ctx.tenantId)) }),
    },
    {
      // Body for a figure: { value, source?, confirmation? }. For `minimum-wage-<classId>`: { label, roles: [..],
      // monthlyMinor, source?, confirmation? }. For `payslip-particulars`: { particulars: [key…], source?, confirmation? }.
      api: 'API-09', method: 'POST', path: '/v1/hr/payroll/legal-settings/:key',
      permission: 'payroll.legal.configure', idempotent: true,
      handler: async (ctx) => {
        const key = (ctx.params['key'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const at = deps.now();
        let change: PayrollLegalSettingChange;
        if ((PAYROLL_FIGURE_KEYS as readonly string[]).includes(key)) {
          const k = key as PayrollFigureKey;
          if (k === 'overtimeMultiplierPercent' && isInt(b['value']) && (b['value'] as number) < OVERTIME_FLOOR_PERCENT) {
            throw refused('overtime_below_2x', `overtime below 2×: a rate of ${b['value'] as number}% of the ordinary hourly rate is less than twice it (the owner's signed floor, C16).`, `Send ${OVERTIME_FLOOR_PERCENT} or more. Nothing was changed.`);
          }
          if (!figureValueIsValid(k, b['value'])) {
            const m = PAYROLL_FIGURES[k];
            throw bad('not_a_payroll_figure', `${m.label} needs a whole number from ${m.min} to ${m.max}, in ${m.unit}.`, 'Send { value, source, confirmation } — source is the Act, rule or notification; confirmation names the CA and their reference. Nothing was changed.');
          }
          change = { target: 'figure', key: k, figure: { value: b['value'], source: optText(b['source']), confirmation: optText(b['confirmation']) }, by: ctx.userId, at };
        } else if (key.startsWith('minimum-wage-') && /^[a-z0-9][a-z0-9_-]{0,47}$/.test(key.slice(13))) {
          const roles = b['roles'];
          if (!isStr(b['label']) || !Array.isArray(roles) || roles.length === 0 || !roles.every(isStr) || !isInt(b['monthlyMinor']) || (b['monthlyMinor'] as number) <= 0) {
            throw bad('not_a_minimum_wage_class', 'A minimum-wage class needs a label, the staff-directory roles it covers (roles: […]) and the full-month minimum wage in paise (monthlyMinor > 0).', 'Send { label, roles, monthlyMinor, source, confirmation }. Nothing was changed.');
          }
          change = { target: 'minimumWage', setting: { classId: key.slice(13), label: (b['label'] as string).trim(), roles: [...new Set((roles as string[]).map((r) => r.trim()))].sort(), monthlyMinor: b['monthlyMinor'] as number, source: optText(b['source']), confirmation: optText(b['confirmation']) }, by: ctx.userId, at };
        } else if (key === 'payslip-particulars') {
          const list = b['particulars'];
          if (!Array.isArray(list) || list.length === 0 || !list.every((k) => (PAYSLIP_PARTICULAR_KEYS as readonly unknown[]).includes(k))) {
            throw bad('not_a_particulars_list', `The particulars list is one or more of: ${PAYSLIP_PARTICULAR_KEYS.join(', ')}. A particular the CA needs that is not on it is a build change.`, 'Send { particulars: [...], source, confirmation }. Nothing was changed.');
          }
          change = { target: 'particulars', list: { particulars: [...new Set(list as PayslipParticularKey[])], source: optText(b['source']), confirmation: optText(b['confirmation']) }, by: ctx.userId, at };
        } else {
          throw apiError(404, { code: 'no_such_payroll_setting', whatHappened: `"${key}" is not a payroll legal setting.`, wasItSaved: 'not_saved', nextSafeAction: `Use one of: ${PAYROLL_FIGURE_KEYS.join(', ')}, minimum-wage-<classId>, payslip-particulars.` });
        }
        await deps.recordSettingChange(ctx.tenantId, change, ctx.idempotencyKey ?? `${key}-${at}`);
        await audit(ctx, deps, 'payroll.legal_setting.change', key, { key, value: JSON.stringify(change) });
        return { status: 200, body: { changed: key, ...legalSettingsView(await deps.settings(ctx.tenantId)) } };
      },
    },
    {
      // Prepare one person's payslip for review. Body: { onDate, attendance: { calendarDaysInMonth, paidDays },
      // components | compensationHistory, overtimeHourlyRateMinor?, esiCoveredForPeriod?, professionalTaxMonthlyMinor?,
      // tdsMonthlyMinor? }. Hours, roles, the hourly rate and the headcount are read from the store, never the body.
      api: 'API-09', method: 'POST', path: '/v1/hr/payroll/statutory-payslips/:employeeId/:period',
      permission: 'payroll.statutory.read', idempotent: true,
      handler: async (ctx) => {
        const employeeId = (ctx.params['employeeId'] ?? '').trim();
        const period = (ctx.params['period'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const att = b['attendance'];
        if (employeeId === '' || !isPeriod(period) || !isStr(b['onDate']) || !isObj(att) || !isInt(att['calendarDaysInMonth']) || !isInt(att['paidDays'])) {
          throw bad('statutory_payslip_needs_period_date_attendance', 'Preparing a payslip needs the employee and the month (YYYY-MM) in the path, and { onDate (the pay date), attendance: { calendarDaysInMonth, paidDays } } with the compensation in the body.', 'Send the pay date, the month\'s days and paid days, and components or compensationHistory. Nothing was saved.');
        }
        if (b['hours'] !== undefined || b['headcount'] !== undefined || b['roles'] !== undefined || b['ordinaryHourlyRateMinor'] !== undefined) {
          throw bad('statutory_payslip_reads_the_record', 'The hours worked come from attendance, the roles and the ordinary hourly rate from the staff directory, and the headcount from the directory too — never from the request.', 'Send the request without hours, headcount, roles or ordinaryHourlyRateMinor. Nothing was saved.');
        }
        const staff = await deps.staff(ctx.tenantId);
        const person = staff.find((e) => e.employeeId === employeeId);
        if (person === undefined) {
          throw refused('not_in_the_staff_directory', `${employeeId} is not in the staff directory, so their roles, hourly rate and hours cannot be read.`, 'Add the person to the staff directory first. Nothing was saved.');
        }
        const hasHistory = Array.isArray(b['compensationHistory']);
        if (!hasHistory && !Array.isArray(b['components'])) {
          throw bad('payslip_needs_compensation', 'A payslip needs the compensation — components (in force) or a compensationHistory to resolve on the pay date.', 'Send components: [{ code, monthlyMinor, partOfPfWage?, partOfGross? }]. Nothing was saved.');
        }
        const days = daysOfMonth(period);
        try {
          const components = hasHistory ? resolveCompensation(b['compensationHistory'] as CompensationStructureEntry[], b['onDate'] as string) : (b['components'] as CompensationComponent[]);
          const payslip = buildStatutoryPayslip({
            period, onDate: (b['onDate'] as string).trim(), components,
            attendance: { calendarDaysInMonth: att['calendarDaysInMonth'] as number, paidDays: att['paidDays'] as number },
            settings: await deps.settings(ctx.tenantId),
            headcount: staff.filter((e) => e.active).length,
            roles: person.roles,
            hours: await deps.hoursBetween(ctx.tenantId, employeeId, days[0]!, days[days.length - 1]!),
            ...(isInt(person.hourlyRateMinor) && (person.hourlyRateMinor as number) > 0 ? { ordinaryHourlyRateMinor: person.hourlyRateMinor as number } : {}),
            ...(isInt(b['overtimeHourlyRateMinor']) ? { overtimeHourlyRateMinor: b['overtimeHourlyRateMinor'] as number } : {}),
            ...(typeof b['esiCoveredForPeriod'] === 'boolean' ? { esiCoveredForPeriod: b['esiCoveredForPeriod'] } : {}),
            ...(isInt(b['professionalTaxMonthlyMinor']) ? { professionalTaxMonthlyMinor: b['professionalTaxMonthlyMinor'] as number } : {}),
            ...(isInt(b['tdsMonthlyMinor']) ? { tdsMonthlyMinor: b['tdsMonthlyMinor'] as number } : {}),
          });
          const preparedAt = deps.now();
          await deps.recordPrepared(ctx.tenantId, { employeeId, period, payslip, preparedBy: ctx.userId, preparedAt }, ctx.idempotencyKey ?? `prepared-${employeeId}-${period}-${preparedAt}`);
          return { status: 200, body: { employeeId, period, payslip, notChecked: payslip.statutoryChecks.notChecked } };
        } catch (err) {
          if (err instanceof OvertimeBelowFloor) throw refused('overtime_below_2x', err.message, 'Pay overtime at no less than twice the ordinary hourly rate. Nothing was saved.');
          if (err instanceof BelowMinimumWage) throw refused('below_minimum_wage', err.message, 'Raise the pay to at least the minimum wage for the person\'s class, or ask the CA if the class is wrong. Nothing was saved.');
          if (err instanceof InvalidStatutorySchedule || err instanceof InvalidOvertimeInput || err instanceof InvalidContributionInput) throw bad('statutory_payslip_invalid', err.message, 'Correct the date, attendance or compensation and try again. Nothing was saved.');
          throw err;
        }
      },
    },
    {
      // What the pay run says for a month: every check not made, each payslip prepared, the contribution reconciliation
      // and the payslips late for their pay date. Read-only; the pay run's approve / lock / bank file stay on hold.
      api: 'API-09', method: 'GET', path: '/v1/hr/payroll/statutory-check/:period',
      permission: 'payroll.statutory.read',
      handler: async (ctx) => {
        const period = (ctx.params['period'] ?? '').trim();
        if (!isPeriod(period)) throw bad('statutory_check_needs_a_month', 'The pay-run check needs a month (YYYY-MM).', 'Call GET /v1/hr/payroll/statutory-check/2026-10.');
        const settings = await deps.settings(ctx.tenantId);
        const prepared = await deps.prepared(ctx.tenantId, period);
        const payRunSays = [...new Set(prepared.flatMap((p) => p.payslip.statutoryChecks.notChecked))].sort();
        // With nothing prepared yet, the settings themselves say what will not be checked.
        const fromSettings = figureStatuses(settings).filter((f) => f.status === 'not_confirmed').map((f) => `${f.label} — not confirmed`);
        return {
          status: 200,
          body: {
            period,
            payRunSays: payRunSays.length > 0 ? payRunSays : prepared.length === 0 ? fromSettings : [],
            payslips: prepared.map((p) => ({
              employeeId: p.employeeId, payDate: p.payslip.onDate, grossMinor: p.payslip.grossMinor, netPayMinor: p.payslip.netPayMinor,
              pf: p.payslip.statutoryChecks.contributions.pf, esi: p.payslip.statutoryChecks.contributions.esi,
              minimumWage: p.payslip.statutoryChecks.minimumWage, overtime: p.payslip.statutoryChecks.overtime.pay,
              totalWorkedMinutes: p.payslip.statutoryChecks.hoursWorked.totalWorkedMinutes, notChecked: p.payslip.statutoryChecks.notChecked,
              preparedBy: p.preparedBy, preparedAt: p.preparedAt,
            })),
            contributions: await contributionsFor(deps, ctx.tenantId, period),
            lateForPayDate: await lateFor(deps, ctx.tenantId, period),
            release: { state: 'on_hold', words: 'Approving, locking and the bank file stay on hold (OB-209): this check prepares and shows payslips only.' },
          },
        };
      },
    },
    {
      // Record the month's EPF / ESI totals as returned / paid. Body: { pfEmployeeMinor, pfEmployerMinor,
      // esiEmployeeMinor, esiEmployerMinor, reference }. A later record is a new fact; the latest is compared.
      api: 'API-09', method: 'POST', path: '/v1/hr/payroll/contributions/:period/totals',
      permission: 'payroll.statutory.read', idempotent: true,
      handler: async (ctx) => {
        const period = (ctx.params['period'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isPeriod(period) || !isStr(b['reference']) || !CONTRIBUTION_FIELDS.every((f) => isInt(b[f]) && (b[f] as number) >= 0)) {
          throw bad('not_readable_as_contribution_totals', `The month's totals need the month (YYYY-MM) in the path and ${CONTRIBUTION_FIELDS.join(', ')} (whole paise, 0 or more) with the return or challan reference in the body.`, 'Send the totals and their reference. Nothing was saved.');
        }
        const t: RecordedContributionTotals = {
          period, reference: (b['reference'] as string).trim(), by: ctx.userId, at: deps.now(),
          pfEmployeeMinor: b['pfEmployeeMinor'] as number, pfEmployerMinor: b['pfEmployerMinor'] as number,
          esiEmployeeMinor: b['esiEmployeeMinor'] as number, esiEmployerMinor: b['esiEmployerMinor'] as number,
        };
        await deps.recordContributionTotals(ctx.tenantId, t, ctx.idempotencyKey ?? `contrib-${period}-${t.at}`);
        return { status: 200, body: { recorded: t, reconciliation: await contributionsFor(deps, ctx.tenantId, period) } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/hr/payroll/contributions/:period',
      permission: 'payroll.statutory.read',
      handler: async (ctx) => {
        const period = (ctx.params['period'] ?? '').trim();
        if (!isPeriod(period)) throw bad('contributions_need_a_month', 'The contribution reconciliation needs a month (YYYY-MM).', 'Call GET /v1/hr/payroll/contributions/2026-10.');
        return { status: 200, body: await contributionsFor(deps, ctx.tenantId, period) };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/hr/payroll/payslip-exceptions',
      permission: 'payroll.statutory.read',
      handler: async (ctx) => {
        const period = ctx.query['period'];
        if (!isPeriod(period)) throw bad('payslip_exceptions_need_a_month', 'The late-payslip list needs ?period=YYYY-MM.', 'Call GET /v1/hr/payroll/payslip-exceptions?period=2026-10.');
        const exceptions = await lateFor(deps, ctx.tenantId, period);
        return { status: 200, body: { period, exceptions, count: exceptions.length } };
      },
    },
    {
      // Put every payslip late for its pay date in each owner's alert inbox — once per payslip.
      api: 'API-09', method: 'POST', path: '/v1/hr/payroll/payslip-exceptions/raise',
      permission: 'payroll.statutory.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isPeriod(b['period'])) throw bad('payslip_exceptions_need_a_month', 'Raising late payslips needs { period: YYYY-MM }.', 'Send the month. Nothing was raised.');
        const exceptions = await lateFor(deps, ctx.tenantId, b['period'] as string);
        const r = await deps.raiseOwnerAlerts(ctx.tenantId, exceptions, ctx.userId, deps.now());
        return { status: 200, body: { period: b['period'], exceptions: exceptions.length, ...r } };
      },
    },
  ];
}
