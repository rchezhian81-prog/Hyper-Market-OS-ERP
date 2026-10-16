// API-11 HR/Workforce — the working-time compliance pack (R2 addendum C18 · M25), on the tested
// `packages/workforce` working-time engine, over the durable roster and attendance stores.
//
//   • `GET  /v1/hr/compliance/working-time/settings`              — every limit, whether it is in force, and what a
//     pending one still needs. hr.compliance.read.
//   • `POST /v1/hr/compliance/working-time/settings/:key`         — set one limit (value + the provision of the Act
//     + who confirmed it), the declared public holidays (`public-holidays`), or the store's clock offset
//     (`utc-offset`). Each change is a new version on an append-only stream and is sealed into the audit trail.
//     hr.compliance.configure (the owner).
//   • `GET  /v1/hr/compliance/roster-check?branchId=&weekStart=`  — what publishing that week would find: the
//     pending limits and every breach, in words. Changes nothing. workforce.roster.read.
//   • `POST /v1/hr/compliance/roster-publications/:publicationId` — PUBLISH a branch's week. Refused (409) while a
//     roster limit is pending; refused (422) with every breach named when the roster breaks a limit; otherwise the
//     publication is recorded and audited. A breach is never routed around: C18 says "enforced" and names no
//     approver. workforce.roster.manage, within the caller's branches.
//   • `GET  /v1/hr/compliance/roster-publications?branchId=`      — the published weeks. workforce.roster.read.
//   • `POST /v1/hr/compliance/leave/:employeeId/:date`            — record a day of annual leave taken, or cancel
//     one (a compensating record — hard rule #2). Taking leave beyond the accrued balance is refused once the
//     accrual rate is in force. workforce.roster.manage.
//   • `GET  /v1/hr/compliance/registers/attendance|leave|holidays` — the statutory registers produced from the
//     stored roster, attendance and leave. hr.register.read, narrowed to the caller's branches.
//
// No legal number lives here or in the engine: see docs/requirements/hr-compliance-settings.md.

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError, assertBranchInScope, assertRecordBranchInScope, scopeOf } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/audit-trail';
import {
  WORKING_TIME_LIMIT_KEYS, WORKING_TIME_LAW, REGISTER_FORMAT_NOTE,
  limitStatuses, limitValueIsValid, limitInForce, checkWorkingTime, leaveBalance, leaveDaysTaken,
  attendanceRegister, holidayRegister, datesBetween,
  type WorkingTimeSettings, type WorkingTimeLimitKey, type LimitSetting, type PublicHoliday,
  type LeaveRecord, type AttendanceFact, type WorkingTimeBreach,
  type Employee, type ShiftRequirement, type ShiftAssignment,
} from '../../../packages/workforce/src/index';

/** One recorded change to the settings — the latest per target is in force. */
export type WorkingTimeSettingChange =
  | { readonly target: WorkingTimeLimitKey; readonly limit: LimitSetting; readonly by: string; readonly at: string }
  | { readonly target: 'publicHolidays'; readonly publicHolidays: WorkingTimeSettings['publicHolidays']; readonly by: string; readonly at: string }
  | { readonly target: 'utcOffsetMinutes'; readonly utcOffsetMinutes: number; readonly by: string; readonly at: string };

/** A week of a branch's roster that was checked and published. */
export interface RosterPublication {
  readonly publicationId: string;
  readonly branchId: string;
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly employeesChecked: number;
  readonly shiftsChecked: number;
  /** The limits in force when it was checked, so a later change of limit does not rewrite what was checked. */
  readonly checkedAgainst: Readonly<Record<string, number>>;
  readonly publishedBy: string;
  readonly publishedAt: string;
}

export interface HrComplianceDeps {
  readonly settings: (tenantId: string) => Promise<WorkingTimeSettings>;
  readonly recordSettingChange: (tenantId: string, change: WorkingTimeSettingChange, key: string) => Promise<void>;
  readonly roster: (tenantId: string) => Promise<{ readonly employees: readonly Employee[]; readonly shifts: readonly ShiftRequirement[]; readonly assignments: readonly ShiftAssignment[] }>;
  /** The stored hours for every day from `from` to `to` inclusive. */
  readonly attendanceBetween: (tenantId: string, from: string, to: string) => Promise<readonly AttendanceFact[]>;
  readonly leave: (tenantId: string) => Promise<readonly LeaveRecord[]>;
  readonly recordLeave: (tenantId: string, record: LeaveRecord, key: string) => Promise<void>;
  readonly publications: (tenantId: string) => Promise<readonly RosterPublication[]>;
  /** False when the publication id is already taken (the earlier one stands). */
  readonly recordPublication: (tenantId: string, publication: RosterPublication, key: string) => Promise<boolean>;
  readonly recordAudit: (tenantId: string, entry: AuditEntry) => Promise<unknown>;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const optText = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
/** The longest period a register is produced for in one read. */
const MAX_REGISTER_DAYS = 92;

const badRequest = (code: string, whatHappened: string, nextSafeAction: string) =>
  apiError(400, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });

/** The staff THIS caller may see: one branch (theirs) when asked for, otherwise everything their scope holds. */
function staffInScope(ctx: RequestContext, employees: readonly Employee[], branchId: string | undefined): readonly Employee[] {
  if (branchId !== undefined) {
    assertBranchInScope(ctx, branchId);
    return employees.filter((e) => e.branchId === branchId);
  }
  const held = scopeOf(ctx);
  return held === 'all' ? employees : employees.filter((e) => held.includes(e.branchId));
}

function readPeriod(ctx: RequestContext): { from: string; to: string } {
  const from = ctx.query['from'];
  const to = ctx.query['to'];
  if (!isDate(from) || !isDate(to) || to < from || datesBetween(from, to).length > MAX_REGISTER_DAYS) {
    throw badRequest('register_needs_a_period', `A register needs from and to dates (YYYY-MM-DD), from on or before to, at most ${MAX_REGISTER_DAYS} days.`, 'Ask again with ?from=2026-10-01&to=2026-10-31 (and branchId if you hold more than one branch).');
  }
  return { from, to };
}

const branchQuery = (ctx: RequestContext): string | undefined =>
  typeof ctx.query['branchId'] === 'string' && ctx.query['branchId'] !== '' ? ctx.query['branchId'] : undefined;

const audit = (ctx: RequestContext, deps: HrComplianceDeps, action: string, objectId: string, after: Record<string, string>, branchId: string | null = null): Promise<unknown> =>
  deps.recordAudit(ctx.tenantId, {
    actorId: ctx.userId, action, objectType: 'hr_compliance', objectId, at: deps.now(),
    origin: { tenantId: ctx.tenantId, branchId }, before: null, after, correlationId: ctx.traceId,
  });

export function hrComplianceRoutes(deps: HrComplianceDeps): readonly Route[] {
  return [
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/compliance/working-time/settings',
      permission: 'hr.compliance.read',
      handler: async (ctx) => {
        const settings = await deps.settings(ctx.tenantId);
        const limits = limitStatuses(settings);
        return {
          status: 200,
          body: {
            law: WORKING_TIME_LAW, settings, limits,
            pending: limits.filter((l) => l.status === 'pending').map((l) => l.key),
            publicHolidays: { ...settings.publicHolidays, status: isStr(settings.publicHolidays.source) && isStr(settings.publicHolidays.confirmation) ? 'in_force' : 'pending' },
            registerFormat: REGISTER_FORMAT_NOTE,
          },
        };
      },
    },
    {
      // Body for a limit: { value, source?, confirmation? }; for public-holidays: { dates: [{date,name}], source?, confirmation? };
      // for utc-offset: { utcOffsetMinutes }. A limit stays PENDING until value, source and confirmation are all present.
      api: 'API-11', method: 'POST', path: '/v1/hr/compliance/working-time/settings/:key',
      permission: 'hr.compliance.configure', idempotent: true,
      handler: async (ctx) => {
        const key = ctx.params['key'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const at = deps.now();
        const idem = ctx.idempotencyKey ?? `wt-${key}-${at}`;
        let change: WorkingTimeSettingChange;
        if ((WORKING_TIME_LIMIT_KEYS as readonly string[]).includes(key)) {
          const k = key as WorkingTimeLimitKey;
          if (!limitValueIsValid(k, b['value'])) {
            throw badRequest('not_a_working_time_limit', `${k} needs a whole-number value from 1 upwards, in its unit.`, 'Send { value, source, confirmation } — source is the provision of the Act, confirmation names who confirmed it (owner or CA) and their reference.');
          }
          change = { target: k, limit: { value: b['value'], source: optText(b['source']), confirmation: optText(b['confirmation']) }, by: ctx.userId, at };
        } else if (key === 'public-holidays') {
          const dates = b['dates'];
          if (!Array.isArray(dates) || !dates.every((d) => typeof d === 'object' && d !== null && isDate((d as Record<string, unknown>)['date']) && isStr((d as Record<string, unknown>)['name']))) {
            throw badRequest('not_a_holiday_list', 'The public-holiday list needs dates: [{ date: YYYY-MM-DD, name }].', 'Send the declared holidays with where the list comes from (source) and who confirmed it (confirmation).');
          }
          const list: PublicHoliday[] = (dates as { date: string; name: string }[]).map((d) => ({ date: d.date, name: d.name.trim() })).sort((x, y) => x.date.localeCompare(y.date));
          change = { target: 'publicHolidays', publicHolidays: { dates: list, source: optText(b['source']), confirmation: optText(b['confirmation']) }, by: ctx.userId, at };
        } else if (key === 'utc-offset') {
          const v = b['utcOffsetMinutes'];
          if (!Number.isInteger(v) || (v as number) < -720 || (v as number) > 840) {
            throw badRequest('not_a_clock_offset', 'utcOffsetMinutes must be a whole number of minutes from -720 to 840 (India is 330).', 'Send { utcOffsetMinutes: 330 }.');
          }
          change = { target: 'utcOffsetMinutes', utcOffsetMinutes: v as number, by: ctx.userId, at };
        } else {
          throw apiError(404, { code: 'no_such_working_time_setting', whatHappened: `"${key}" is not a working-time setting.`, wasItSaved: 'not_saved', nextSafeAction: `Use one of: ${[...WORKING_TIME_LIMIT_KEYS, 'public-holidays', 'utc-offset'].join(', ')}.` });
        }
        await deps.recordSettingChange(ctx.tenantId, change, idem);
        await audit(ctx, deps, 'hr.working_time.setting.change', change.target, { target: change.target, value: JSON.stringify(change) });
        const settings = await deps.settings(ctx.tenantId);
        return { status: 200, body: { changed: change.target, limits: limitStatuses(settings) } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/compliance/roster-check',
      permission: 'workforce.roster.read',
      handler: async (ctx) => {
        const branchId = ctx.query['branchId'];
        const weekStart = ctx.query['weekStart'];
        if (!isStr(branchId) || !isDate(weekStart)) throw badRequest('roster_check_needs_branch_and_week', 'A roster check needs branchId and weekStart (YYYY-MM-DD).', 'Ask again with ?branchId=b1&weekStart=2026-10-19.');
        assertBranchInScope(ctx, branchId);
        const r = await deps.roster(ctx.tenantId);
        const check = checkWorkingTime({ settings: await deps.settings(ctx.tenantId), branchId, weekStart, ...r });
        return { status: 200, body: { branchId, ...check, publishable: check.pending.length === 0 && check.breaches.length === 0 } };
      },
    },
    {
      // Body: { branchId, weekStart }. Publishing is the moment the limits are enforced.
      api: 'API-11', method: 'POST', path: '/v1/hr/compliance/roster-publications/:publicationId',
      permission: 'workforce.roster.manage', idempotent: true,
      handler: async (ctx) => {
        const publicationId = (ctx.params['publicationId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (publicationId === '' || !isStr(b['branchId']) || !isDate(b['weekStart'])) {
          throw badRequest('not_readable_as_a_publication', 'Publishing a roster needs a publicationId in the path and { branchId, weekStart (YYYY-MM-DD) } in the body.', 'Send the branch and the first day of the week being published.');
        }
        const branchId = b['branchId'];
        const weekStart = b['weekStart'];
        assertBranchInScope(ctx, branchId);
        const settings = await deps.settings(ctx.tenantId);
        const r = await deps.roster(ctx.tenantId);
        const check = checkWorkingTime({ settings, branchId, weekStart, ...r });
        if (check.pending.length > 0) {
          return {
            status: 409,
            body: {
              error: {
                code: 'working_time_limits_pending',
                whatHappened: `The roster cannot be checked, so it was not published: ${check.pending.length} working-time limit(s) are not filled in and confirmed yet — ${check.pending.map((p) => `${p.label} (${p.missing})`).join('; ')}.`,
                wasItSaved: 'not_saved',
                nextSafeAction: 'The owner fills in each limit with the provision of the Act and who confirmed it (owner or CA), then publish again.',
                traceId: ctx.traceId,
              },
              pending: check.pending,
            },
          };
        }
        if (check.breaches.length > 0) {
          const words = (xs: readonly WorkingTimeBreach[]): string => xs.slice(0, 5).map((x) => x.detail).join('; ') + (xs.length > 5 ? `; and ${xs.length - 5} more` : '');
          return {
            status: 422,
            body: {
              error: {
                code: 'roster_breaks_working_time_limits',
                whatHappened: `The roster for the week of ${weekStart} was not published: it breaks the working-time limits ${check.breaches.length} time(s) — ${words(check.breaches)}.`,
                wasItSaved: 'not_saved',
                nextSafeAction: 'Change the shifts or who is on them so every person is within the limits, then publish again.',
                traceId: ctx.traceId,
              },
              breaches: check.breaches,
            },
          };
        }
        const checkedAgainst = Object.fromEntries(WORKING_TIME_LIMIT_KEYS.map((k) => [k, limitInForce(settings, k)]).filter(([, v]) => v !== undefined)) as Record<string, number>;
        const publication: RosterPublication = {
          publicationId, branchId, weekStart, weekEnd: check.weekEnd,
          employeesChecked: check.employeesChecked, shiftsChecked: check.shiftsChecked, checkedAgainst,
          publishedBy: ctx.userId, publishedAt: deps.now(),
        };
        const fresh = await deps.recordPublication(ctx.tenantId, publication, ctx.idempotencyKey ?? `pub-${publicationId}`);
        if (!fresh) {
          throw apiError(409, { code: 'publication_id_taken', whatHappened: `Publication ${publicationId} is already recorded; a publication is never overwritten.`, wasItSaved: 'not_saved', nextSafeAction: 'Publish under a new publication id.' });
        }
        await audit(ctx, deps, 'hr.roster.publish', publicationId, { branchId, weekStart, employeesChecked: String(check.employeesChecked) }, branchId);
        return { status: 201, body: { publication } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/compliance/roster-publications',
      permission: 'workforce.roster.read',
      handler: async (ctx) => {
        const branchId = branchQuery(ctx);
        if (branchId !== undefined) assertBranchInScope(ctx, branchId);
        const held = scopeOf(ctx);
        const rows = (await deps.publications(ctx.tenantId))
          .filter((p) => (branchId === undefined ? held === 'all' || held.includes(p.branchId) : p.branchId === branchId))
          .sort((a, b) => a.weekStart.localeCompare(b.weekStart) || a.publicationId.localeCompare(b.publicationId));
        return { status: 200, body: { publications: rows, count: rows.length } };
      },
    },
    {
      // Body: { kind?: 'taken' | 'cancelled', note? }. Latest record per (employee, date) stands.
      api: 'API-11', method: 'POST', path: '/v1/hr/compliance/leave/:employeeId/:date',
      permission: 'workforce.roster.manage', idempotent: true,
      handler: async (ctx) => {
        const employeeId = (ctx.params['employeeId'] ?? '').trim();
        const date = ctx.params['date'];
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const kind = b['kind'] === undefined ? 'taken' : b['kind'];
        if (employeeId === '' || !isDate(date) || (kind !== 'taken' && kind !== 'cancelled')) {
          throw badRequest('not_readable_as_leave', 'Leave needs an employeeId and a date (YYYY-MM-DD) in the path; kind is taken (the default) or cancelled.', 'Send the day of annual leave, or cancel one recorded by mistake.');
        }
        const r = await deps.roster(ctx.tenantId);
        const employee = r.employees.find((e) => e.employeeId === employeeId);
        if (employee === undefined) throw apiError(404, { code: 'no_such_employee', whatHappened: `${employeeId} is not on the staff register.`, wasItSaved: 'not_saved', nextSafeAction: 'Add the person to the staff register first.' });
        assertRecordBranchInScope(ctx, employee.branchId);
        const records = await deps.leave(ctx.tenantId);
        const standing = leaveDaysTaken(records).get(employeeId) ?? [];
        const settings = await deps.settings(ctx.tenantId);
        let balanceAfter: number | null = null;
        if (kind === 'taken' && !standing.includes(date)) {
          const worked = (await deps.attendanceBetween(ctx.tenantId, '0000-01-01', date)).filter((a) => a.employeeId === employeeId && a.hours > 0).length;
          const bal = leaveBalance({ settings, employeeId, daysWorked: worked, takenDates: standing });
          if (bal.balance !== null && bal.balance < 1) {
            throw apiError(422, {
              code: 'leave_beyond_accrued_balance',
              whatHappened: `${employee.name} has earned ${bal.earned} day(s) of annual leave from ${worked} day(s) worked and has taken ${bal.taken}, so there is no balance left for ${date}.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Check the leave register. Leave beyond the accrued balance is not recorded as annual leave.',
            });
          }
          balanceAfter = bal.balance === null ? null : bal.balance - 1;
        }
        if (kind === 'cancelled' && !standing.includes(date)) {
          throw apiError(409, { code: 'no_leave_to_cancel', whatHappened: `${employee.name} has no annual leave recorded on ${date}.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing to cancel.' });
        }
        const record: LeaveRecord = {
          employeeId, date, kind, recordedBy: ctx.userId, recordedAt: deps.now(),
          ...(isStr(b['note']) ? { note: b['note'].trim() } : {}),
        };
        await deps.recordLeave(ctx.tenantId, record, ctx.idempotencyKey ?? `leave-${employeeId}-${date}-${record.recordedAt}`);
        await audit(ctx, deps, `hr.leave.${kind}`, `${employeeId}:${date}`, { employeeId, date, kind }, employee.branchId);
        return { status: 200, body: { leave: record, accrual: limitInForce(settings, 'annualLeaveDaysWorkedPerDayEarned') === undefined ? 'pending' : 'in_force', ...(balanceAfter === null ? {} : { balanceAfter }) } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/compliance/registers/attendance',
      permission: 'hr.register.read',
      handler: async (ctx) => {
        const { from, to } = readPeriod(ctx);
        const branchId = branchQuery(ctx);
        const r = await deps.roster(ctx.tenantId);
        const employees = staffInScope(ctx, r.employees, branchId);
        const rows = attendanceRegister({
          from, to, settings: await deps.settings(ctx.tenantId), employees,
          attendance: await deps.attendanceBetween(ctx.tenantId, from, to), shifts: r.shifts, assignments: r.assignments, leave: await deps.leave(ctx.tenantId),
        });
        return { status: 200, body: { register: 'attendance', law: WORKING_TIME_LAW, from, to, ...(branchId === undefined ? {} : { branchId }), rows, format: REGISTER_FORMAT_NOTE } };
      },
    },
    {
      // asOf (YYYY-MM-DD) — balances to and including that day.
      api: 'API-11', method: 'GET', path: '/v1/hr/compliance/registers/leave',
      permission: 'hr.register.read',
      handler: async (ctx) => {
        const asOf = ctx.query['asOf'];
        if (!isDate(asOf)) throw badRequest('leave_register_needs_a_date', 'The leave register needs asOf (YYYY-MM-DD).', 'Ask again with ?asOf=2026-10-31.');
        const branchId = branchQuery(ctx);
        const r = await deps.roster(ctx.tenantId);
        const employees = staffInScope(ctx, r.employees, branchId);
        const settings = await deps.settings(ctx.tenantId);
        const worked = (await deps.attendanceBetween(ctx.tenantId, '0000-01-01', asOf)).filter((a) => a.hours > 0);
        const taken = leaveDaysTaken((await deps.leave(ctx.tenantId)).filter((l) => l.date <= asOf));
        const rows = [...employees].sort((a, b) => a.employeeId.localeCompare(b.employeeId)).map((e) => ({
          name: e.name, branchId: e.branchId,
          ...leaveBalance({ settings, employeeId: e.employeeId, daysWorked: worked.filter((a) => a.employeeId === e.employeeId).length, takenDates: taken.get(e.employeeId) ?? [] }),
        }));
        const accrual = limitStatuses(settings).find((l) => l.key === 'annualLeaveDaysWorkedPerDayEarned')!;
        return { status: 200, body: { register: 'leave', law: WORKING_TIME_LAW, asOf, accrual, ...(branchId === undefined ? {} : { branchId }), rows, format: REGISTER_FORMAT_NOTE } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/compliance/registers/holidays',
      permission: 'hr.register.read',
      handler: async (ctx) => {
        const { from, to } = readPeriod(ctx);
        const branchId = branchQuery(ctx);
        const r = await deps.roster(ctx.tenantId);
        const employees = staffInScope(ctx, r.employees, branchId);
        const reg = holidayRegister({ from, to, settings: await deps.settings(ctx.tenantId), employees, attendance: await deps.attendanceBetween(ctx.tenantId, from, to), shifts: r.shifts, assignments: r.assignments });
        return { status: 200, body: { register: 'holidays', law: WORKING_TIME_LAW, ...(branchId === undefined ? {} : { branchId }), ...reg, format: REGISTER_FORMAT_NOTE } };
      },
    },
  ];
}
