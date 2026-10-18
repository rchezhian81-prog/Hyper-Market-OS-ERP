// D-9 (R3, OB-142 "A", OB-181) — labour-demand forecast, the draft roster a manager commits, and actual attendance
// against the roster, on head office's API. The rules are `packages/workforce/src/labour-demand.ts` and `schedule.ts`,
// over the R2 working-time pack (`working-time.ts`, the C18 settings the owner / CA fill in).
//
//   POST /v1/hr/workforce/labour-standards/:role                 the owner's service standard: bills one person serves an hour
//   GET  /v1/hr/workforce/labour-standards
//   GET  /v1/hr/workforce/labour-demand?branchId=&weekStart=     staff needed per role per hour of the Monday–Sunday week
//   POST /v1/hr/workforce/schedule-drafts/:draftId               draft the week's roster from the forecast (nothing is rostered)
//   GET  /v1/hr/workforce/schedule-drafts/:draftId · GET /v1/hr/workforce/schedule-drafts?branchId=&weekStart=
//   POST /v1/hr/workforce/schedule-drafts/:draftId/commit        a MANAGER commits it: its shifts and assignments go on the roster
//   GET  /v1/hr/workforce/schedule/actuals?branchId=&weekStart=  actual attendance against the roster, per person per day
//
// The draft is advisory until a person holding `workforce.roster.manage` commits it (P-05). A commit is refused when the
// draft breaks a working-time limit in force, or when the roster changed after the draft was made (it would no longer
// be what was checked). Labour cost is reported on the draft and never caps anything (OB-142). The week is Monday–Sunday,
// fixed (OB-181). Limits still pending are named, never guessed.

import { createHash } from 'node:crypto';
import type { Route } from '../../kernel/src/index';
import { apiError, assertBranchInScope } from '../../kernel/src/index';
import { forecastLabourDemand, InvalidLabourDemandInputError, type HourlyBill, type ServiceStandard } from '../../../packages/workforce/src/labour-demand';
import { draftRoster, actualAgainstRoster, type DraftRoster } from '../../../packages/workforce/src/schedule';
import { isRosterWeekStart, rosterWeekBasis, checkWorkingTime, limitStatuses, ROSTER_LIMIT_KEYS, WORKING_TIME_LAW, type WorkingTimeSettings } from '../../../packages/workforce/src/working-time';
import type { Employee, ShiftAssignment, ShiftRequirement } from '../../../packages/workforce/src/workforce';
import type { AuditEntry } from '../../../packages/audit/src/index';

/** How many weeks of sales the forecast learns from. */
export const LABOUR_HISTORY_WEEKS = 8;

export interface StoredDraft {
  readonly draftId: string;
  readonly branchId: string;
  readonly weekStart: string;
  readonly draft: DraftRoster;
  /** The digest of the roster the draft was made against (any later change makes it stale). */
  readonly basis: string;
  readonly draftedBy: string;
  readonly draftedAt: string;
  readonly committedBy: string | null;
  readonly committedAt: string | null;
}

export interface ScheduleDeps {
  readonly now: () => string;
  readonly settings: (tenantId: string) => Promise<WorkingTimeSettings>;
  readonly standards: (tenantId: string) => Promise<readonly ServiceStandard[]>;
  readonly recordStandard: (tenantId: string, s: ServiceStandard) => Promise<void>;
  /** The bills of the branch committed in [fromIso, toIso). */
  readonly billsAt: (tenantId: string, branchId: string, fromIso: string, toIso: string) => Promise<readonly HourlyBill[]>;
  readonly roster: (tenantId: string) => Promise<{ readonly employees: readonly Employee[]; readonly shifts: readonly ShiftRequirement[]; readonly assignments: readonly ShiftAssignment[] }>;
  readonly putShift: (tenantId: string, shift: ShiftRequirement, key: string) => Promise<void>;
  readonly putAssignment: (tenantId: string, a: ShiftAssignment, key: string) => Promise<void>;
  readonly drafts: (tenantId: string) => Promise<readonly StoredDraft[]>;
  readonly recordDraft: (tenantId: string, d: StoredDraft) => Promise<void>;
  readonly marks: (tenantId: string) => Promise<readonly { readonly employeeId: string; readonly kind: 'in' | 'out'; readonly at: string }[]>;
  readonly hours: (tenantId: string, from: string, to: string) => Promise<readonly { readonly employeeId: string; readonly date: string; readonly hours: number }[]>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const digest = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 32);
const bad = (code: string, what: string): never => { throw apiError(400, { code, whatHappened: what, wasItSaved: 'not_saved', nextSafeAction: 'Correct the request. Nothing was changed.' }); };
const latestDrafts = (ds: readonly StoredDraft[]): StoredDraft[] => { const m = new Map<string, StoredDraft>(); for (const d of ds) m.set(d.draftId, d); return [...m.values()]; };

function readWeek(branchId: unknown, weekStart: unknown): { branchId: string; weekStart: string } {
  if (!isStr(branchId) || typeof weekStart !== 'string' || !DAY.test(weekStart)) return bad('schedule_needs_branch_and_week', 'This needs a branchId and a weekStart (YYYY-MM-DD, a Monday).');
  if (!isRosterWeekStart(weekStart)) {
    throw apiError(400, { code: 'roster_week_starts_on_monday', whatHappened: `The roster week runs Monday to Sunday (OB-181); ${weekStart} is not a Monday.`, wasItSaved: 'not_saved', nextSafeAction: 'Use the Monday of the week.' });
  }
  return { branchId: branchId.trim(), weekStart };
}

/** What the law pack says about each limit right now — in force, or pending and shown as such (never invented). */
const limitsShown = (settings: WorkingTimeSettings) => ({
  law: WORKING_TIME_LAW,
  limits: limitStatuses(settings).filter((l) => ROSTER_LIMIT_KEYS.includes(l.key)),
  allPending: limitStatuses(settings).filter((l) => ROSTER_LIMIT_KEYS.includes(l.key)).every((l) => l.status === 'pending'),
});

export function scheduleRoutes(deps: ScheduleDeps): readonly Route[] {
  const demandFor = async (tenantId: string, branchId: string, weekStart: string) => {
    const settings = await deps.settings(tenantId);
    const from = addDays(weekStart, -7 * LABOUR_HISTORY_WEEKS);
    const off = settings.utcOffsetMinutes;
    const bills = await deps.billsAt(tenantId, branchId, new Date(Date.parse(`${from}T00:00:00Z`) - off * 60_000 - 86_400_000).toISOString(), new Date(Date.parse(`${weekStart}T00:00:00Z`) + 86_400_000).toISOString());
    const standards = await deps.standards(tenantId);
    const r = await deps.roster(tenantId);
    const roles = [...new Set([...standards.map((s) => s.role), ...r.employees.filter((e) => e.active && e.branchId === branchId).flatMap((e) => e.roles)])].sort();
    try {
      return { settings, roster: r, demand: forecastLabourDemand({ weekStart, historyWeeks: LABOUR_HISTORY_WEEKS, utcOffsetMinutes: off, bills, roles, standards }) };
    } catch (e) {
      if (e instanceof InvalidLabourDemandInputError) return bad('schedule_needs_branch_and_week', e.message);
      throw e;
    }
  };
  return [
    {
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/labour-standards/:role',
      permission: 'workforce.standard.set', idempotent: true,
      handler: async (ctx) => {
        const role = (ctx.params['role'] ?? '').trim();
        const n = ((ctx.body ?? {}) as Record<string, unknown>)['billsPerStaffHour'];
        if (role === '' || !Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > 1000) bad('not_readable_as_a_service_standard', 'A service standard needs { billsPerStaffHour }: how many bills one person of this role serves in an hour (whole, 1–1000).');
        const s: ServiceStandard = { role, billsPerStaffHour: n as number, setBy: ctx.userId, setAt: deps.now() };
        await deps.recordStandard(ctx.tenantId, s);
        await deps.recordAudit?.(ctx.tenantId, { actorId: ctx.userId, action: 'workforce.standard.set', objectType: 'service_standard', objectId: role, at: s.setAt, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null, after: { billsPerStaffHour: String(s.billsPerStaffHour) }, reason: 'OB-142 service level', correlationId: `standard-${role}-${s.setAt}` });
        return { status: 201, body: { standard: s } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/labour-standards',
      permission: 'workforce.roster.read',
      handler: async (ctx) => {
        const latest = new Map<string, ServiceStandard>();
        for (const s of await deps.standards(ctx.tenantId)) latest.set(s.role, s);
        return { status: 200, body: { standards: [...latest.values()], asAt: deps.now() } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/labour-demand',
      permission: 'workforce.roster.read',
      handler: async (ctx) => {
        const { branchId, weekStart } = readWeek(ctx.query['branchId'], ctx.query['weekStart']);
        assertBranchInScope(ctx, branchId);
        const { settings, demand } = await demandFor(ctx.tenantId, branchId, weekStart);
        return { status: 200, body: { branchId, ...demand, workingTime: limitsShown(settings), asAt: deps.now() } };
      },
    },
    {
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/schedule-drafts/:draftId',
      permission: 'workforce.schedule.draft', idempotent: true,
      handler: async (ctx) => {
        const draftId = (ctx.params['draftId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const { branchId, weekStart } = readWeek(b['branchId'], b['weekStart']);
        if (draftId === '') bad('not_readable_as_a_draft', 'The draft id is in the path.');
        assertBranchInScope(ctx, branchId);
        const prior = latestDrafts(await deps.drafts(ctx.tenantId)).find((d) => d.draftId === draftId);
        if (prior !== undefined) return { status: 200, body: { draft: prior, alreadyDrafted: true } };
        const { settings, roster, demand } = await demandFor(ctx.tenantId, branchId, weekStart);
        const draft = draftRoster({ branchId, weekStart, settings, slots: demand.slots, employees: roster.employees, existing: roster, idPrefix: `sched-${draftId}` });
        const stored: StoredDraft = {
          draftId, branchId, weekStart, draft, basis: digest(rosterWeekBasis({ settings, branchId, weekStart, ...roster })),
          draftedBy: ctx.userId, draftedAt: deps.now(), committedBy: null, committedAt: null,
        };
        await deps.recordDraft(ctx.tenantId, stored);
        return { status: 201, body: { draft: stored, demand: { slots: demand.slots.length, staffHoursByRole: demand.staffHoursByRole, rolesNotForecast: demand.rolesNotForecast }, workingTime: limitsShown(settings), committed: false } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/schedule-drafts/:draftId',
      permission: 'workforce.roster.read',
      handler: async (ctx) => {
        const d = latestDrafts(await deps.drafts(ctx.tenantId)).find((x) => x.draftId === (ctx.params['draftId'] ?? '').trim());
        if (d === undefined) throw apiError(404, { code: 'schedule_draft_unknown', whatHappened: 'No such draft roster.', wasItSaved: 'not_saved', nextSafeAction: 'Draft the week first.' });
        assertBranchInScope(ctx, d.branchId);
        return { status: 200, body: { draft: d, workingTime: limitsShown(await deps.settings(ctx.tenantId)) } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/schedule-drafts',
      permission: 'workforce.roster.read',
      handler: async (ctx) => {
        const { branchId, weekStart } = readWeek(ctx.query['branchId'], ctx.query['weekStart']);
        assertBranchInScope(ctx, branchId);
        const list = latestDrafts(await deps.drafts(ctx.tenantId)).filter((d) => d.branchId === branchId && d.weekStart === weekStart);
        return { status: 200, body: { drafts: list.map((d) => ({ draftId: d.draftId, draftedBy: d.draftedBy, draftedAt: d.draftedAt, committedBy: d.committedBy, uncovered: d.draft.uncovered.length, breaches: d.draft.breaches.length })) } };
      },
    },
    {
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/schedule-drafts/:draftId/commit',
      permission: 'workforce.roster.manage', idempotent: true,
      handler: async (ctx) => {
        const draftId = (ctx.params['draftId'] ?? '').trim();
        const d = latestDrafts(await deps.drafts(ctx.tenantId)).find((x) => x.draftId === draftId);
        if (d === undefined) throw apiError(404, { code: 'schedule_draft_unknown', whatHappened: `No draft roster ${draftId}.`, wasItSaved: 'not_saved', nextSafeAction: 'Draft the week first.' });
        assertBranchInScope(ctx, d.branchId);
        if (d.committedBy !== null) return { status: 200, body: { draft: d, alreadyCommitted: true } };
        const settings = await deps.settings(ctx.tenantId);
        const roster = await deps.roster(ctx.tenantId);
        // Judged again NOW, against the limits in force now (a limit the CA filled after the draft was made counts).
        const now = checkWorkingTime({
          settings, branchId: d.branchId, weekStart: d.weekStart, employees: roster.employees,
          shifts: [...roster.shifts, ...d.draft.shifts], assignments: [...roster.assignments, ...d.draft.assignments],
        });
        if (now.breaches.length > 0) {
          throw apiError(422, { code: 'roster_breaks_working_time_limits', whatHappened: `The draft breaks the working-time limits in force ${now.breaches.length} time(s): ${now.breaches.slice(0, 5).map((x) => x.detail).join('; ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Draft the week again. Nothing was rostered.' });
        }
        if (digest(rosterWeekBasis({ settings, branchId: d.branchId, weekStart: d.weekStart, ...roster })) !== d.basis) {
          throw apiError(409, { code: 'roster_changed_since_draft', whatHappened: `The roster for ${d.branchId} changed after draft ${draftId} was made, so it is no longer what was checked.`, wasItSaved: 'not_saved', nextSafeAction: 'Draft the week again. Nothing was rostered.' });
        }
        for (const s of d.draft.shifts) await deps.putShift(ctx.tenantId, { shiftId: s.shiftId, branchId: s.branchId, startsAt: s.startsAt, endsAt: s.endsAt, requiredRoles: s.requiredRoles }, `sched-commit-${draftId}-${s.shiftId}`);
        for (const a of d.draft.assignments) await deps.putAssignment(ctx.tenantId, a, `sched-commit-${draftId}-${a.shiftId}-${a.employeeId}`);
        const committed: StoredDraft = { ...d, committedBy: ctx.userId, committedAt: deps.now() };
        await deps.recordDraft(ctx.tenantId, committed);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'workforce.schedule.commit', objectType: 'schedule_draft', objectId: draftId, at: committed.committedAt!,
          origin: { tenantId: ctx.tenantId, branchId: d.branchId }, before: null,
          after: { branchId: d.branchId, weekStart: d.weekStart, shifts: String(d.draft.shifts.length), uncovered: String(d.draft.uncovered.length), draftedBy: d.draftedBy },
          reason: 'a manager committed the draft roster (P-05)', correlationId: draftId,
        });
        return { status: 200, body: { draft: committed, rostered: { shifts: d.draft.shifts.length, assignments: d.draft.assignments.length }, uncovered: d.draft.uncovered, note: 'The week still needs publishing (the R2 roster publication), as any roster does.' } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/schedule/actuals',
      permission: 'workforce.roster.read',
      handler: async (ctx) => {
        const { branchId, weekStart } = readWeek(ctx.query['branchId'], ctx.query['weekStart']);
        assertBranchInScope(ctx, branchId);
        const settings = await deps.settings(ctx.tenantId);
        const r = await deps.roster(ctx.tenantId);
        const shiftById = new Map(r.shifts.filter((s) => s.branchId === branchId).map((s) => [s.shiftId, s] as const));
        const people = new Set(r.employees.filter((e) => e.branchId === branchId).map((e) => e.employeeId));
        const rostered = r.assignments.flatMap((a) => { const s = shiftById.get(a.shiftId); return s === undefined ? [] : [{ employeeId: a.employeeId, shift: s }]; });
        const rows = actualAgainstRoster({
          weekStart, utcOffsetMinutes: settings.utcOffsetMinutes, rostered,
          marks: (await deps.marks(ctx.tenantId)).filter((m) => people.has(m.employeeId)),
          hours: (await deps.hours(ctx.tenantId, weekStart, addDays(weekStart, 6))).filter((h) => people.has(h.employeeId)),
        });
        const count = (s: string) => rows.filter((x) => x.status === s).length;
        return { status: 200, body: { branchId, weekStart, weekEnd: addDays(weekStart, 6), rows, summary: { asRostered: count('as_rostered'), short: count('short'), over: count('over'), absent: count('absent'), notRecorded: count('not_recorded'), workedUnrostered: count('worked_unrostered') }, asAt: deps.now() } };
      },
    },
  ];
}
