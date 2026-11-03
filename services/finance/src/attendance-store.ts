// API-11 HR/Workforce — the DURABLE attendance store (M25 follow-on), on the tested `packages/workforce`
// `labourCost` engine, alongside the roster/certification/SOP stores. The `POST /v1/hr/workforce/labour-cost`
// route is a stateless what-if (the caller supplies the hours, the staff and the day's sales). This persists
// the hours worked (append-only, latest-per-(employee,date), hard rule #2) so the labour-cost view reads
// STORED hours + the stored staff (from the roster store) and survives a restart.
//
//   • `POST /v1/hr/workforce/attendance/:employeeId/:date` — record hours worked by a person on a day. manage.
//   • `GET  /v1/hr/workforce/attendance?date=`             — the stored hours for a day. read.
//   • `GET  /v1/hr/workforce/labour-cost?branchId=&date=&salesMinor=&guideBps=` — the STATEFUL view: folds the
//     stored hours for the day + the stored staff for the branch (with their hourly rate) + the day's sales
//     (supplied — the sales total is finance's number, not re-derived here) and runs the tested `labourCost`.
//     **REPORTED, never enforced** (§29): above-guide is "worth a look", a no-sales day is `not_meaningful`, and
//     there is no route anywhere that could refuse a roster on cost. read.
//
// Writes gated `workforce.roster.manage`; reads `workforce.roster.read` (the same permission the stateless POST
// labour-cost uses). Nothing is enforced here — it records the hours and reports the ratio.
//
// OB-686 (owner, 3 Nov 2026): the labour-cost GUIDE is the owner's setting (`GET/POST /v1/hr/workforce/labour-cost-guide`,
// "not set" until he sets it; append-only, the newest applies). The old built-in 12% is gone: with no guide (neither his
// setting nor one typed for a what-if) the cost and its share are shown and nothing is compared.

import type { Route } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/audit-trail';
import { apiError, assertRecordBranchInScope, assertBranchInScope, scopeOf } from '../../kernel/src/index';
import {
  labourCost,
  type Employee,
} from '../../../packages/workforce/src/workforce';

/** Hours a person worked on a day. */
export interface AttendanceRecord {
  readonly employeeId: string;
  readonly date: string; // YYYY-MM-DD
  readonly hours: number;
}

export interface AttendanceStoreDeps {
  readonly putAttendance: (tenantId: string, record: AttendanceRecord, key: string) => Promise<void> | void;
  /** The stored hours for a day. */
  readonly attendance: (tenantId: string, date: string) => Promise<readonly AttendanceRecord[]> | readonly AttendanceRecord[];
  /** The stored staff (from the roster store), optionally one branch — for their hourly rate. */
  readonly employees: (tenantId: string, branchId?: string) => Promise<readonly Employee[]> | readonly Employee[];
  /** OB-686: the owner's labour-cost guide (latest), or undefined when he has set none. */
  readonly labourGuide?: (tenantId: string) => Promise<LabourGuideSetting | undefined> | LabourGuideSetting | undefined;
  readonly recordLabourGuide?: (tenantId: string, setting: LabourGuideSetting) => Promise<void> | void;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

/** The owner's labour-cost guide, in basis points of sales (1,000 = 10%), with who set it and when. */
export interface LabourGuideSetting {
  readonly guideBps: number;
  readonly setBy: string;
  readonly setAt: string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isNonNegNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

export function attendanceStoreRoutes(deps: AttendanceStoreDeps): readonly Route[] {
  return [
    {
      // Record hours worked. Body: { hours >= 0 }. Latest-per-(employee, date).
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/attendance/:employeeId/:date',
      permission: 'workforce.roster.manage', idempotent: true,
      handler: async (ctx) => {
        const employeeId = (ctx.params['employeeId'] ?? '').trim();
        const date = (ctx.params['date'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (employeeId === '' || !isDate(date) || !isNonNegNum(b['hours'])) {
          throw apiError(400, {
            code: 'not_readable_as_attendance',
            whatHappened: 'An attendance record needs an employeeId and a date (YYYY-MM-DD) in the path and { hours } (0 or more) in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the hours this person worked on the day.',
          });
        }
        // PA-01-r1: hours are recorded only for a person who works at a branch the caller holds.
        assertRecordBranchInScope(ctx, (await deps.employees(ctx.tenantId)).find((e) => e.employeeId === employeeId)?.branchId);
        const record: AttendanceRecord = { employeeId, date, hours: b['hours'] };
        await deps.putAttendance(ctx.tenantId, record, ctx.idempotencyKey ?? `att-${employeeId}-${date}-${deps.now()}`);
        return { status: 200, body: { attendance: record } };
      },
    },
    {
      // The stored hours for a day. Read-only.
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/attendance',
      permission: 'workforce.roster.read',
      handler: async (ctx) => {
        const date = ctx.query['date'];
        if (!isDate(date)) {
          throw apiError(400, {
            code: 'attendance_needs_a_date',
            whatHappened: 'Reading attendance needs a date (YYYY-MM-DD) in the query.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Call GET /v1/hr/workforce/attendance?date=2026-09-14.',
          });
        }
        // PA-01-r1: only the hours of people at the caller's branches.
        const held = scopeOf(ctx);
        const branchOf = new Map((await deps.employees(ctx.tenantId)).map((e) => [e.employeeId, e.branchId] as const));
        const records = (await deps.attendance(ctx.tenantId, date)).filter((r) => {
          const b = branchOf.get(r.employeeId);
          return held === 'all' || (b !== undefined && held.includes(b));
        });
        return { status: 200, body: { attendance: records, count: records.length, date } };
      },
    },
    {
      // Labour cost as a share of sales, from the STORED hours + staff — REPORTED, never enforced (§29). Query:
      // branchId, date, salesMinor (all required), guideBps? Read-only, the stateful counterpart to POST /labour-cost.
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/labour-cost',
      permission: 'workforce.roster.read',
      handler: async (ctx) => {
        const branchId = ctx.query['branchId'];
        const date = ctx.query['date'];
        const salesRaw = ctx.query['salesMinor'];
        const salesMinor = salesRaw === undefined ? NaN : Number(salesRaw);
        const guideRaw = ctx.query['guideBps'];
        const guideBps = guideRaw === undefined || guideRaw === '' ? undefined : Number(guideRaw);
        if (!isStr(branchId) || !isDate(date) || !isNonNegInt(salesMinor) || (guideBps !== undefined && !isPosInt(guideBps))) {
          throw apiError(400, {
            code: 'not_readable_as_a_labour_cost',
            whatHappened: 'A stored labour-cost view needs branchId, date (YYYY-MM-DD) and a whole salesMinor in the query (guideBps optional). The hours and staff come from the store; the day\'s sales figure is supplied.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Call GET /v1/hr/workforce/labour-cost?branchId=b1&date=2026-09-14&salesMinor=… — nothing is stored, this only reports the ratio.',
          });
        }
        assertBranchInScope(ctx, branchId); // PA-01-r1: another branch's labour cost is refused by name
        const employees = await deps.employees(ctx.tenantId, branchId);
        const known = new Set(employees.map((e) => e.employeeId));
        const hours = (await deps.attendance(ctx.tenantId, date))
          .filter((r) => known.has(r.employeeId))
          .map((r) => ({ employeeId: r.employeeId, hours: r.hours }));
        // A guide typed for a what-if wins; else the owner's own setting; else none — and then nothing is compared (OB-686).
        const owners = guideBps === undefined ? await deps.labourGuide?.(ctx.tenantId) : undefined;
        const guide = guideBps ?? owners?.guideBps;
        const view = labourCost({
          branchId,
          hours,
          employees,
          salesMinor,
          ...(guide !== undefined ? { guideBps: guide } : {}),
        });
        return { status: 200, body: { ...view, date, guideFrom: guideBps !== undefined ? 'typed' : owners !== undefined ? 'owner' : 'not_set' } };
      },
    },
    {
      // OB-686: the owner's labour-cost guide — "not set" until he sets it.
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/labour-cost-guide',
      permission: 'workforce.roster.read',
      handler: async (ctx) => {
        const g = await deps.labourGuide?.(ctx.tenantId);
        return { status: 200, body: g === undefined ? { state: 'not_set' } : { state: 'set', guide: g } };
      },
    },
    {
      // OB-686: the OWNER sets the labour-cost guide — { guideBps } (whole, 1 to 10,000). Append-only; the newest applies.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/labour-cost-guide',
      permission: 'workforce.labour.guide.set', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isPosInt(b['guideBps']) || (b['guideBps'] as number) > 10_000) {
          throw apiError(400, { code: 'not_readable_as_a_labour_guide', whatHappened: 'The labour-cost guide is { guideBps }: a whole number of basis points of sales, 1 to 10000 (1000 = 10%).', wasItSaved: 'not_saved', nextSafeAction: 'Send the owner\'s guide. Nothing was changed.' });
        }
        if (deps.recordLabourGuide === undefined) throw apiError(503, { code: 'labour_guide_not_kept', whatHappened: 'Head office has no durable store to keep the guide.', wasItSaved: 'not_saved', nextSafeAction: 'Try again when head office is running on its database.' });
        const before = await deps.labourGuide?.(ctx.tenantId);
        const setting: LabourGuideSetting = { guideBps: b['guideBps'] as number, setBy: ctx.userId, setAt: deps.now() };
        await deps.recordLabourGuide(ctx.tenantId, setting);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'workforce.labour_guide.set', objectType: 'labour_cost_guide', objectId: ctx.tenantId, at: setting.setAt,
          origin: { tenantId: ctx.tenantId, branchId: null }, before: before === undefined ? null : { guideBps: String(before.guideBps) }, after: { guideBps: String(setting.guideBps) }, correlationId: ctx.traceId,
        });
        return { status: 201, body: { state: 'set', guide: setting } };
      },
    },
  ];
}
