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

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
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
  readonly now: () => string;
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
        const records = await deps.attendance(ctx.tenantId, date);
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
        const employees = await deps.employees(ctx.tenantId, branchId);
        const known = new Set(employees.map((e) => e.employeeId));
        const hours = (await deps.attendance(ctx.tenantId, date))
          .filter((r) => known.has(r.employeeId))
          .map((r) => ({ employeeId: r.employeeId, hours: r.hours }));
        const view = labourCost({
          branchId,
          hours,
          employees,
          salesMinor,
          ...(guideBps !== undefined ? { guideBps } : {}),
        });
        return { status: 200, body: { ...view, date } };
      },
    },
  ];
}
