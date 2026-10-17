// API-11 HR/Workforce — the working-time compliance pack (R2 addendum C18 · M25), on the tested
// `packages/workforce` working-time engine, over the durable roster and attendance stores.
//
//   • `GET  /v1/hr/compliance/working-time/settings`              — every limit, whether it is in force, and what a
//     pending one still needs. hr.compliance.read.
//   • `POST /v1/hr/compliance/working-time/settings/:key`         — set one limit (value + the provision of the Act
//     + who confirmed it), the declared public holidays (`public-holidays`), or the store's clock offset
//     (`utc-offset`). Each change is a new version on an append-only stream and is sealed into the audit trail. The
//     roster week is NOT a setting: it always starts on Monday (OB-181 "A").
//     hr.compliance.configure (the owner).
//   • `GET  /v1/hr/compliance/roster-check?branchId=&weekStart=`  — what publishing that week would find: the
//     pending limits and every breach, in words. Changes nothing. workforce.roster.read.
//     OB-179 / OB-181 "A": a roster week always runs Monday to Sunday. A weekStart on any other day is
//     refused by name (400 `not_the_shops_roster_week`) here and on publishing, and a shift is shown to staff only
//     while the publication of ITS OWN roster week stands — so two windows laid across one real week can never make
//     a week the limits refuse visible (verifier r2final NEW-1).
//   • `POST /v1/hr/compliance/roster-publications/:publicationId` — PUBLISH a branch's week. Refused (422) with every
//     breach named when the roster breaks a limit that is in force (OB-152 "A": refuse it — a breach is never routed
//     around). Limits still pending do NOT stop it (OB-155 "A"): the publication records exactly which limits were not
//     checked. The publication also records a digest of the exact roster it checked (`rosterWeekBasis`), so ANY later
//     edit to that roster returns the week to "needs publishing" (OB-166 "A") — and staff see a week only while it is
//     published (GET /v1/hr/workforce/my-roster). workforce.roster.manage, within the caller's branches.
//   • `GET  /v1/hr/compliance/roster-publications?branchId=`      — the publications, each with whether it still
//     stands (`published`) or the roster changed after it (`needs_publishing`). workforce.roster.read.
//   • `POST /v1/hr/compliance/leave/:employeeId/:date`            — record a day of leave taken (annual, casual, sick,
//     festival or unpaid), or cancel one (a compensating record — hard rule #2). Annual leave beyond the accrued
//     balance is refused once the accrual rate is in force; a configurable type beyond its days a year (with carry-
//     over) is refused once the type is in force, and is recorded as NOT CHECKED until then (OB-156).
//     workforce.roster.manage.
//   • `GET  /v1/hr/compliance/registers/attendance|leave|holidays` — the statutory registers produced from the
//     stored roster, attendance and leave. hr.register.read, narrowed to the caller's branches.
//
// No legal number lives here or in the engine: see docs/requirements/hr-compliance-settings.md.

import { createHash } from 'node:crypto';
import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError, assertBranchInScope, assertRecordBranchInScope, scopeOf } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/audit-trail';
import {
  WORKING_TIME_LIMIT_KEYS, WORKING_TIME_LAW, REGISTER_FORMAT_NOTE,
  limitStatuses, limitValueIsValid, limitInForce, checkWorkingTime, leaveBalance, leaveDaysTaken,
  attendanceRegister, holidayRegister, datesBetween, rosterWeekBasis, rosterLimitsNotChecked, addDays,
  ROSTER_WEEK_STARTS_ON, isRosterWeekStart, rosterWeekStartOf, weekdayOf, shiftLocalStartDay, type Weekday,
  LEAVE_TYPE_KEYS, LEAVE_KINDS, LEAVE_TYPES, leaveTypeStatuses, leaveTypeBalance, leaveDaysValueIsValid, standingLeave, leaveKindOf,
  type WorkingTimeSettings, type WorkingTimeLimitKey, type LimitSetting, type PublicHoliday,
  type LeaveRecord, type AttendanceFact, type WorkingTimeBreach, type LimitNotChecked,
  type LeaveTypeKey, type LeaveTypeSetting, type LeaveKind,
  type Employee, type ShiftRequirement, type ShiftAssignment,
} from '../../../packages/workforce/src/index';

/** One recorded change to the settings — the latest per target is in force. */
export type WorkingTimeSettingChange =
  | { readonly target: WorkingTimeLimitKey; readonly limit: LimitSetting; readonly by: string; readonly at: string }
  | { readonly target: 'publicHolidays'; readonly publicHolidays: WorkingTimeSettings['publicHolidays']; readonly by: string; readonly at: string }
  | { readonly target: 'utcOffsetMinutes'; readonly utcOffsetMinutes: number; readonly by: string; readonly at: string }
  /**
   * Recorded only between OB-179 and OB-181, when the roster week start was briefly a setting. Kept on the stream as it
   * was written (append-only, hard rule #2) and NEVER applied: the roster week always starts on Monday (OB-181 "A").
   */
  | { readonly target: 'rosterWeekStartsOn'; readonly rosterWeekStartsOn: Weekday; readonly by: string; readonly at: string }
  | { readonly target: 'leaveType'; readonly leaveType: LeaveTypeKey; readonly setting: LeaveTypeSetting; readonly by: string; readonly at: string };

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
  /**
   * OB-155: the roster limits that were NOT checked because they were pending, each with what it was missing. Absent on a
   * publication made before OB-155 (those could not be made while any limit was pending).
   */
  readonly limitsNotChecked?: readonly LimitNotChecked[];
  /**
   * OB-166: SHA-256 of the exact roster this publication checked (`rosterWeekBasis`). The week stands as published only
   * while the roster still digests to this; any edit returns it to "needs publishing". Absent before OB-166 — such a
   * publication never stands as published.
   */
  readonly basis?: string;
  readonly publishedBy: string;
  readonly publishedAt: string;
}

/** Where a branch's week stands for staff (OB-166). */
export type RosterWeekState = 'not_published' | 'published' | 'needs_publishing';

/** The digest a publication records for the roster it checked. */
export const rosterBasisDigest = (basis: string): string => createHash('sha256').update(basis, 'utf8').digest('hex');

/** A published week staff may see, with the limits that were not checked when it was published (OB-155). */
export interface PublishedWeek {
  readonly branchId: string;
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly publicationId: string;
  readonly publishedAt: string;
  readonly limitsNotChecked: readonly LimitNotChecked[];
}

/** The roster staff may see: each shift of a week that is published NOW, with that week. */
export interface StaffRosterVisibility {
  readonly visible: ReadonlyMap<string, PublishedWeek>;
}

type StoredRosterLike = { readonly employees: readonly Employee[]; readonly shifts: readonly ShiftRequirement[]; readonly assignments: readonly ShiftAssignment[] };

/**
 * The publications of (branch, week) that still match the roster — the week is published while any does. OB-179: only
 * a publication of one of the shop's roster weeks can stand; one made for a window starting on any other day (before
 * OB-179, or under an earlier week-start setting) never does.
 */
export function standingPublications(settings: WorkingTimeSettings, roster: StoredRosterLike, publications: readonly RosterPublication[]): readonly RosterPublication[] {
  const digestOf = new Map<string, string>();
  return publications.filter((p) => {
    if (p.basis === undefined || !isRosterWeekStart(p.weekStart)) return false;
    const k = `${p.branchId}\u0000${p.weekStart}`;
    let d = digestOf.get(k);
    if (d === undefined) {
      d = rosterBasisDigest(rosterWeekBasis({ settings, branchId: p.branchId, weekStart: p.weekStart, ...roster }));
      digestOf.set(k, d);
    }
    return d === p.basis;
  });
}

/** The state of one branch's week: published (a publication still matches), needs publishing (one exists but the roster changed), or not published. */
export function rosterWeekState(settings: WorkingTimeSettings, roster: StoredRosterLike, publications: readonly RosterPublication[], branchId: string, weekStart: string): { readonly state: RosterWeekState; readonly publication?: RosterPublication } {
  const mine = publications.filter((p) => p.branchId === branchId && p.weekStart === weekStart);
  if (mine.length === 0) return { state: 'not_published' };
  const standing = standingPublications(settings, roster, mine).at(-1);
  return standing === undefined ? { state: 'needs_publishing', publication: mine.at(-1)! } : { state: 'published', publication: standing };
}

/**
 * OB-166 "A": what staff may see — only the shifts of a branch's week that is published NOW (a publication whose
 * roster digest still matches). A week edited after publishing is hidden until it is checked and published again.
 * OB-179 "A": a shift belongs to exactly ONE roster week — the shop's week its store-local start day falls in — and it
 * is visible only while a publication of THAT week stands. No other publication can show it.
 */
export function staffRosterVisibility(settings: WorkingTimeSettings, roster: StoredRosterLike, publications: readonly RosterPublication[]): StaffRosterVisibility {
  const standing = new Map<string, PublishedWeek>();
  for (const p of standingPublications(settings, roster, publications)) {
    standing.set(`${p.branchId}\u0000${p.weekStart}`, { branchId: p.branchId, weekStart: p.weekStart, weekEnd: p.weekEnd, publicationId: p.publicationId, publishedAt: p.publishedAt, limitsNotChecked: p.limitsNotChecked ?? [] });
  }
  const visible = new Map<string, PublishedWeek>();
  for (const s of roster.shifts) {
    const day = shiftLocalStartDay(s, settings.utcOffsetMinutes);
    if (day === undefined) continue;
    const week = standing.get(`${s.branchId}\u0000${rosterWeekStartOf(day)}`);
    if (week !== undefined) visible.set(s.shiftId, week);
  }
  return { visible };
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

/** OB-179 / OB-181 "A": refuse, by name, a week that does not start on a Monday. */
function assertRosterWeek(weekStart: string): void {
  if (isRosterWeekStart(weekStart)) return;
  const day = ROSTER_WEEK_STARTS_ON;
  const nearest = rosterWeekStartOf(weekStart);
  throw badRequest('not_the_shops_roster_week',
    `${weekStart} is a ${weekdayOf(weekStart)}. The roster week always starts on ${day}, so a roster is checked and published only for a week starting on a ${day}.`,
    `Use the week starting ${nearest} (the ${day} of that week).`);
}

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
            // OB-181 "A": fixed, not a setting — said here so the page can show it.
            rosterWeek: { startsOn: ROSTER_WEEK_STARTS_ON, words: 'A roster week always runs Monday to Sunday; rosters are published only for those weeks.' },
            pending: limits.filter((l) => l.status === 'pending').map((l) => l.key),
            // OB-155: what a roster check cannot apply yet. OB-156: every leave type and whether it is checked.
            limitsNotChecked: rosterLimitsNotChecked(settings),
            leaveTypes: leaveTypeStatuses(settings),
            publicHolidays: { ...settings.publicHolidays, status: isStr(settings.publicHolidays.source) && isStr(settings.publicHolidays.confirmation) ? 'in_force' : 'pending' },
            registerFormat: REGISTER_FORMAT_NOTE,
          },
        };
      },
    },
    {
      // Body for a limit: { value, source?, confirmation? }; for public-holidays: { dates: [{date,name}], source?, confirmation? };
      // for utc-offset: { utcOffsetMinutes }; for a leave type (leave-casual, leave-sick, leave-festival, leave-unpaid):
      // { daysPerYear, carryOverMaxDays, source?, confirmation? }. A limit or leave type stays PENDING until every part is present.
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
        } else if (key === 'roster-week-start') {
          // OB-181 "A": the roster week is locked to Monday — there is no such setting to change.
          throw apiError(404, { code: 'no_such_working_time_setting', whatHappened: 'The roster week is not a setting: it always runs Monday to Sunday (owner decision OB-181).', wasItSaved: 'not_saved', nextSafeAction: 'Nothing to change. Check and publish rosters for weeks starting on a Monday.' });
        } else if (key.startsWith('leave-') && (LEAVE_TYPE_KEYS as readonly string[]).includes(key.slice(6))) {
          // OB-156: a configurable leave type — days a year and the carry-over rule (0 = nothing carries over).
          const type = key.slice(6) as LeaveTypeKey;
          if (!leaveDaysValueIsValid(b['daysPerYear']) || !leaveDaysValueIsValid(b['carryOverMaxDays'])) {
            throw badRequest('not_a_leave_type_setting', `${LEAVE_TYPES[type].label} needs daysPerYear and carryOverMaxDays as whole numbers of days from 0 to 366 (carryOverMaxDays 0 = nothing carries over).`, 'Send { daysPerYear, carryOverMaxDays, source, confirmation } — source is the provision of the Act, confirmation names who confirmed it (owner or CA) and their reference.');
          }
          change = { target: 'leaveType', leaveType: type, setting: { daysPerYear: b['daysPerYear'], carryOverMaxDays: b['carryOverMaxDays'], source: optText(b['source']), confirmation: optText(b['confirmation']) }, by: ctx.userId, at };
        } else {
          throw apiError(404, { code: 'no_such_working_time_setting', whatHappened: `"${key}" is not a working-time setting.`, wasItSaved: 'not_saved', nextSafeAction: `Use one of: ${[...WORKING_TIME_LIMIT_KEYS, 'public-holidays', 'utc-offset', ...LEAVE_TYPE_KEYS.map((t) => `leave-${t}`)].join(', ')}.` });
        }
        await deps.recordSettingChange(ctx.tenantId, change, idem);
        const target = change.target === 'leaveType' ? `leave-${change.leaveType}` : change.target;
        await audit(ctx, deps, 'hr.working_time.setting.change', target, { target, value: JSON.stringify(change) });
        const settings = await deps.settings(ctx.tenantId);
        return { status: 200, body: { changed: target, limits: limitStatuses(settings), leaveTypes: leaveTypeStatuses(settings) } };
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
        const settings = await deps.settings(ctx.tenantId);
        assertRosterWeek(weekStart);
        const r = await deps.roster(ctx.tenantId);
        const check = checkWorkingTime({ settings, branchId, weekStart, ...r });
        const week = rosterWeekState(settings, r, await deps.publications(ctx.tenantId), branchId, weekStart);
        // OB-155: pending limits do not stop publishing — they are named in `notChecked`. A breach of a limit in force does.
        return { status: 200, body: { branchId, ...check, publishable: check.breaches.length === 0, week: { state: week.state, ...(week.publication === undefined ? {} : { publicationId: week.publication.publicationId }) } } };
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
        assertRosterWeek(weekStart);
        const r = await deps.roster(ctx.tenantId);
        const check = checkWorkingTime({ settings, branchId, weekStart, ...r });
        // OB-155 "A": limits still pending do not stop the publication — it names them. OB-152 "A": a breach of a limit
        // that IS in force refuses it.
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
              notChecked: check.notChecked,
            },
          };
        }
        const checkedAgainst = Object.fromEntries(WORKING_TIME_LIMIT_KEYS.map((k) => [k, limitInForce(settings, k)]).filter(([, v]) => v !== undefined)) as Record<string, number>;
        const publication: RosterPublication = {
          publicationId, branchId, weekStart, weekEnd: check.weekEnd,
          employeesChecked: check.employeesChecked, shiftsChecked: check.shiftsChecked, checkedAgainst,
          limitsNotChecked: check.notChecked,
          basis: rosterBasisDigest(rosterWeekBasis({ settings, branchId, weekStart, ...r })),
          publishedBy: ctx.userId, publishedAt: deps.now(),
        };
        const fresh = await deps.recordPublication(ctx.tenantId, publication, ctx.idempotencyKey ?? `pub-${publicationId}`);
        if (!fresh) {
          throw apiError(409, { code: 'publication_id_taken', whatHappened: `Publication ${publicationId} is already recorded; a publication is never overwritten.`, wasItSaved: 'not_saved', nextSafeAction: 'Publish under a new publication id.' });
        }
        await audit(ctx, deps, 'hr.roster.publish', publicationId, {
          branchId, weekStart, employeesChecked: String(check.employeesChecked),
          limitsNotChecked: check.notChecked.map((n) => n.key).join(',') || 'none',
        }, branchId);
        const unchecked = check.notChecked.length === 0
          ? 'Every working-time limit was checked.'
          : `Published with ${check.notChecked.length} working-time limit(s) NOT checked, because they are not filled in and confirmed yet: ${check.notChecked.map((n) => `${n.label} (${n.missing})`).join('; ')}.${check.notChecked.flatMap((n) => (n.meanwhile === undefined ? [] : [` ${n.meanwhile}`])).join('')}`;
        return { status: 201, body: { publication, notChecked: check.notChecked, words: unchecked } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/compliance/roster-publications',
      permission: 'workforce.roster.read',
      handler: async (ctx) => {
        const branchId = branchQuery(ctx);
        if (branchId !== undefined) assertBranchInScope(ctx, branchId);
        const held = scopeOf(ctx);
        const all = (await deps.publications(ctx.tenantId))
          .filter((p) => (branchId === undefined ? held === 'all' || held.includes(p.branchId) : p.branchId === branchId));
        const standing = new Set(standingPublications(await deps.settings(ctx.tenantId), await deps.roster(ctx.tenantId), all).map((p) => p.publicationId));
        // OB-166: each publication says whether it still stands, or the roster was edited after it ("needs publishing").
        const rows = all
          .map((p) => ({ ...p, limitsNotChecked: p.limitsNotChecked ?? [], state: standing.has(p.publicationId) ? 'stands' as const : 'roster_changed_since' as const }))
          .sort((a, b) => a.weekStart.localeCompare(b.weekStart) || a.publicationId.localeCompare(b.publicationId));
        const weekKeys = [...new Set(rows.map((p) => `${p.branchId}\u0000${p.weekStart}`))];
        const weeks = weekKeys.map((k) => {
          const [b, w] = k.split('\u0000') as [string, string];
          const live = rows.filter((p) => p.branchId === b && p.weekStart === w && p.state === 'stands').at(-1);
          return { branchId: b, weekStart: w, weekEnd: addDays(w, 6), state: live === undefined ? 'needs_publishing' as RosterWeekState : 'published' as RosterWeekState, ...(live === undefined ? {} : { publicationId: live.publicationId, limitsNotChecked: live.limitsNotChecked }) };
        });
        return { status: 200, body: { publications: rows, count: rows.length, weeks } };
      },
    },
    {
      // Body: { kind?: 'taken' | 'cancelled', leaveType?: annual (default) | casual | sick | festival | unpaid, note? }.
      // The latest record per (employee, date) stands — one leave on a day.
      api: 'API-11', method: 'POST', path: '/v1/hr/compliance/leave/:employeeId/:date',
      permission: 'workforce.roster.manage', idempotent: true,
      handler: async (ctx) => {
        const employeeId = (ctx.params['employeeId'] ?? '').trim();
        const date = ctx.params['date'];
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const kind = b['kind'] === undefined ? 'taken' : b['kind'];
        const asked = b['leaveType'] === undefined ? undefined : b['leaveType'];
        if (employeeId === '' || !isDate(date) || (kind !== 'taken' && kind !== 'cancelled') || (asked !== undefined && !(LEAVE_KINDS as readonly unknown[]).includes(asked))) {
          throw badRequest('not_readable_as_leave', `Leave needs an employeeId and a date (YYYY-MM-DD) in the path; kind is taken (the default) or cancelled; leaveType is one of ${LEAVE_KINDS.join(', ')} (annual is the default).`, 'Send the day of leave and its type, or cancel one recorded by mistake.');
        }
        const r = await deps.roster(ctx.tenantId);
        const employee = r.employees.find((e) => e.employeeId === employeeId);
        if (employee === undefined) throw apiError(404, { code: 'no_such_employee', whatHappened: `${employeeId} is not on the staff register.`, wasItSaved: 'not_saved', nextSafeAction: 'Add the person to the staff register first.' });
        assertRecordBranchInScope(ctx, employee.branchId);
        const records = await deps.leave(ctx.tenantId);
        const onTheDay = standingLeave(records).get(`${employeeId}|${date}`);
        const settings = await deps.settings(ctx.tenantId);
        const kindName = (k: LeaveKind): string => (k === 'annual' ? 'Annual leave' : LEAVE_TYPES[k].label);
        if (kind === 'cancelled') {
          if (onTheDay === undefined || (asked !== undefined && leaveKindOf(onTheDay) !== asked)) {
            throw apiError(409, { code: 'no_leave_to_cancel', whatHappened: `${employee.name} has no ${asked === undefined ? 'leave' : kindName(asked as LeaveKind).toLowerCase()} recorded on ${date}.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing to cancel.' });
          }
        }
        const leaveType: LeaveKind = kind === 'cancelled' ? leaveKindOf(onTheDay!) : (asked as LeaveKind | undefined) ?? 'annual';
        // One leave on a day: another type already standing there is cancelled first, never silently replaced (hard rule #10).
        if (kind === 'taken' && onTheDay !== undefined && leaveKindOf(onTheDay) !== leaveType) {
          throw apiError(409, { code: 'other_leave_on_that_day', whatHappened: `${employee.name} already has ${kindName(leaveKindOf(onTheDay)).toLowerCase()} recorded on ${date}.`, wasItSaved: 'not_saved', nextSafeAction: 'Cancel that leave first if the day is to be a different kind of leave.' });
        }
        let balanceAfter: number | null = null;
        let check: 'checked' | 'not_checked' = 'not_checked';
        let missing: string | undefined;
        if (kind === 'taken' && onTheDay === undefined && leaveType === 'annual') {
          const standing = leaveDaysTaken(records).get(employeeId) ?? [];
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
          check = bal.balance === null ? 'not_checked' : 'checked';
        } else if (kind === 'taken' && onTheDay === undefined) {
          // OB-156: a configurable type is checked against its days a year (with carry-over) once it is in force.
          const t = leaveType as LeaveTypeKey;
          const bal = leaveTypeBalance({ settings, type: t, employeeId, year: Number(date.slice(0, 4)), records });
          if (bal.balance !== null && bal.balance < 1) {
            throw apiError(422, {
              code: 'leave_beyond_entitlement',
              whatHappened: `${employee.name} has used ${bal.taken} of ${bal.entitlement} day(s) of ${bal.label.toLowerCase()} for ${bal.year} (${bal.carriedIn} carried over), so there is none left for ${date}.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Check the leave register. Record the day as another kind of leave only if that is what was agreed.',
            });
          }
          balanceAfter = bal.balance === null ? null : bal.balance - 1;
          check = bal.check;
          missing = bal.missing;
        }
        const record: LeaveRecord = {
          employeeId, date, kind, leaveType, recordedBy: ctx.userId, recordedAt: deps.now(),
          ...(isStr(b['note']) ? { note: b['note'].trim() } : {}),
        };
        await deps.recordLeave(ctx.tenantId, record, ctx.idempotencyKey ?? `leave-${employeeId}-${date}-${record.recordedAt}`);
        await audit(ctx, deps, `hr.leave.${kind}`, `${employeeId}:${date}`, { employeeId, date, kind, leaveType }, employee.branchId);
        return {
          status: 200,
          body: {
            leave: record, check, ...(missing === undefined ? {} : { notCheckedBecause: missing }),
            accrual: limitInForce(settings, 'annualLeaveDaysWorkedPerDayEarned') === undefined ? 'pending' : 'in_force',
            ...(balanceAfter === null ? {} : { balanceAfter }),
          },
        };
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
        const settings = await deps.settings(ctx.tenantId);
        const rows = attendanceRegister({
          from, to, settings, employees,
          attendance: await deps.attendanceBetween(ctx.tenantId, from, to), shifts: r.shifts, assignments: r.assignments, leave: await deps.leave(ctx.tenantId),
        });
        return { status: 200, body: { register: 'attendance', law: WORKING_TIME_LAW, from, to, ...(branchId === undefined ? {} : { branchId }), rows, limitsNotChecked: rosterLimitsNotChecked(settings), format: REGISTER_FORMAT_NOTE } };
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
        const upTo = (await deps.leave(ctx.tenantId)).filter((l) => l.date <= asOf);
        const taken = leaveDaysTaken(upTo);
        const year = Number(asOf.slice(0, 4));
        const rows = [...employees].sort((a, b) => a.employeeId.localeCompare(b.employeeId)).map((e) => ({
          name: e.name, branchId: e.branchId,
          ...leaveBalance({ settings, employeeId: e.employeeId, daysWorked: worked.filter((a) => a.employeeId === e.employeeId).length, takenDates: taken.get(e.employeeId) ?? [] }),
          // OB-156: casual, sick, festival and unpaid leave for the leave year of asOf — each checked, or NOT CHECKED.
          otherLeave: LEAVE_TYPE_KEYS.map((type) => leaveTypeBalance({ settings, type, employeeId: e.employeeId, year, records: upTo })),
        }));
        const accrual = limitStatuses(settings).find((l) => l.key === 'annualLeaveDaysWorkedPerDayEarned')!;
        const leaveTypes = leaveTypeStatuses(settings);
        return {
          status: 200,
          body: {
            register: 'leave', law: WORKING_TIME_LAW, asOf, accrual, leaveTypes,
            leaveTypesNotChecked: leaveTypes.filter((t) => t.status === 'pending').map((t) => ({ key: t.key, label: t.label, missing: t.missing! })),
            leaveYear: 'calendar year (January to December) — pending the CA\'s confirmation',
            ...(branchId === undefined ? {} : { branchId }), rows, format: REGISTER_FORMAT_NOTE,
          },
        };
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
        const settings = await deps.settings(ctx.tenantId);
        const reg = holidayRegister({ from, to, settings, employees, attendance: await deps.attendanceBetween(ctx.tenantId, from, to), shifts: r.shifts, assignments: r.assignments });
        return { status: 200, body: { register: 'holidays', law: WORKING_TIME_LAW, ...(branchId === undefined ? {} : { branchId }), ...reg, limitsNotChecked: rosterLimitsNotChecked(settings), format: REGISTER_FORMAT_NOTE } };
      },
    },
  ];
}
