// API-11 HR/Workforce — the DURABLE roster store (M25-FR-01 follow-on), on the tested `packages/workforce`
// `rosterGaps` engine. The workforce DECISION routes (`workforce.ts`) are STATELESS what-ifs — the caller
// supplies the whole roster in the body every time. This makes the roster DURABLE: the staff directory, the
// shifts and the assignments are each appended to the tenant's append-only log (latest-per-id, hard rule #2),
// so "who is on this week, and what is the roster missing" is a fold of stored facts that survives a restart,
// not a payload a manager has to carry on every call.
//
//   • `POST /v1/hr/workforce/employees/:employeeId`                  — upsert one staff record (active/roles/
//     branch). A leaver is recorded `active:false` — kept, never deleted (hard rule #2/#6) — and stops being cover.
//   • `POST /v1/hr/workforce/shifts/:shiftId`                        — upsert one shift and the roles it cannot run
//     without.
//   • `POST /v1/hr/workforce/shifts/:shiftId/assignments/:employeeId`— assign a person to a shift as a role.
//   • `GET  /v1/hr/workforce/roster?branchId=`                       — the stored roster (employees/shifts/assignments).
//   • `GET  /v1/hr/workforce/roster-gaps?branchId=`                  — the STORED roster's gaps: folds the store and
//     runs the tested `rosterGaps` (the stateful counterpart to the POST what-if in `workforce.ts`), returning the
//     SAME shape. A leaver still on the grid is not cover; a shift with nobody rostered for a required role is the
//     unstaffed-critical exception, surfaced separately (P-03).
//
// Writes are gated `workforce.roster.manage` (a manager within scope — §28, P-04 least privilege); reads are
// `workforce.roster.read`. Nothing here rosters anybody automatically — it records what a manager decided and
// reports, by exception, what the roster is short. Co-located with `workforce.ts` and `pay-run-store.ts` under `/v1/hr`.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  rosterGaps,
  type ShiftRequirement, type ShiftAssignment, type Employee,
} from '../../../packages/workforce/src/workforce';

/** The whole stored roster for a tenant (optionally one branch), the shape `rosterGaps` reads. */
export interface StoredRoster {
  readonly employees: readonly Employee[];
  readonly shifts: readonly ShiftRequirement[];
  readonly assignments: readonly ShiftAssignment[];
}

export interface RosterStoreDeps {
  /** Record/replace one staff record (latest-per-employeeId). */
  readonly putEmployee: (tenantId: string, employee: Employee, key: string) => Promise<void> | void;
  /** Record/replace one shift requirement (latest-per-shiftId). */
  readonly putShift: (tenantId: string, shift: ShiftRequirement, key: string) => Promise<void> | void;
  /** Record/replace one assignment (latest-per-(shiftId,employeeId)). */
  readonly putAssignment: (tenantId: string, assignment: ShiftAssignment, key: string) => Promise<void> | void;
  /** Fold the stored roster, optionally narrowed to one branch. */
  readonly roster: (tenantId: string, branchId?: string) => Promise<StoredRoster> | StoredRoster;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isArr = (v: unknown): v is unknown[] => Array.isArray(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** An employee record the roster is checked against — a leaver (`active:false`) is kept but is not cover. */
const readEmployee = (employeeId: string, b: Record<string, unknown>): Employee | undefined => {
  if (!isStr(b['name']) || !isStr(b['branchId']) || typeof b['active'] !== 'boolean'
    || !isArr(b['roles']) || !(b['roles'] as unknown[]).every(isStr)) return undefined;
  return {
    employeeId,
    name: b['name'],
    branchId: b['branchId'],
    roles: b['roles'] as string[],
    active: b['active'] as boolean,
    ...(isNonNegInt(b['hourlyRateMinor']) ? { hourlyRateMinor: b['hourlyRateMinor'] } : {}),
  };
};

/** A shift and the roles it genuinely cannot run without. */
const readShift = (shiftId: string, b: Record<string, unknown>): ShiftRequirement | undefined => {
  if (!isStr(b['branchId']) || !isStr(b['startsAt']) || !isStr(b['endsAt'])
    || !isArr(b['requiredRoles'])
    || !(b['requiredRoles'] as unknown[]).every((r) => isObj(r) && isStr(r['role']) && isPosInt(r['count']))) return undefined;
  return {
    shiftId,
    branchId: b['branchId'],
    startsAt: b['startsAt'],
    endsAt: b['endsAt'],
    requiredRoles: (b['requiredRoles'] as { role: string; count: number }[]).map((r) => ({ role: r.role, count: r.count })),
  };
};

export function rosterStoreRoutes(deps: RosterStoreDeps): readonly Route[] {
  return [
    {
      // Upsert one staff record. Body: { name, branchId, roles[], active, hourlyRateMinor? }. Latest-per-id.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/employees/:employeeId',
      permission: 'workforce.roster.manage', idempotent: true,
      handler: async (ctx) => {
        const employeeId = (ctx.params['employeeId'] ?? '').trim();
        const employee = employeeId === '' ? undefined : readEmployee(employeeId, (ctx.body ?? {}) as Record<string, unknown>);
        if (employee === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_an_employee',
            whatHappened: 'A staff record needs an employeeId in the path and { name, branchId, roles[], active } in the body (hourlyRateMinor optional).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the staff record. A leaver is recorded with active:false — it is kept, never deleted.',
          });
        }
        await deps.putEmployee(ctx.tenantId, employee, ctx.idempotencyKey ?? `emp-${employeeId}-${deps.now()}`);
        return { status: 200, body: { employee } };
      },
    },
    {
      // Upsert one shift and its required roles. Body: { branchId, startsAt, endsAt, requiredRoles:[{role,count>0}] }.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/shifts/:shiftId',
      permission: 'workforce.roster.manage', idempotent: true,
      handler: async (ctx) => {
        const shiftId = (ctx.params['shiftId'] ?? '').trim();
        const shift = shiftId === '' ? undefined : readShift(shiftId, (ctx.body ?? {}) as Record<string, unknown>);
        if (shift === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_shift',
            whatHappened: 'A shift needs a shiftId in the path and { branchId, startsAt, endsAt, requiredRoles: [{ role, count>0 }] } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the shift and the roles it cannot run without.',
          });
        }
        await deps.putShift(ctx.tenantId, shift, ctx.idempotencyKey ?? `shift-${shiftId}-${deps.now()}`);
        return { status: 200, body: { shift } };
      },
    },
    {
      // Assign a person to a shift as a role. Body: { role }. Latest-per-(shift,employee).
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/shifts/:shiftId/assignments/:employeeId',
      permission: 'workforce.roster.manage', idempotent: true,
      handler: async (ctx) => {
        const shiftId = (ctx.params['shiftId'] ?? '').trim();
        const employeeId = (ctx.params['employeeId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (shiftId === '' || employeeId === '' || !isStr(b['role'])) {
          throw apiError(400, {
            code: 'not_readable_as_an_assignment',
            whatHappened: 'An assignment needs a shiftId and employeeId in the path and { role } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the role this person is rostered for on this shift.',
          });
        }
        const assignment: ShiftAssignment = { shiftId, employeeId, role: b['role'] };
        await deps.putAssignment(ctx.tenantId, assignment, ctx.idempotencyKey ?? `asg-${shiftId}-${employeeId}-${deps.now()}`);
        return { status: 200, body: { assignment } };
      },
    },
    {
      // The stored roster, optionally one branch. Read-only.
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/roster',
      permission: 'workforce.roster.read',
      handler: async (ctx) => {
        const branchId = typeof ctx.query['branchId'] === 'string' && ctx.query['branchId'] !== '' ? ctx.query['branchId'] : undefined;
        const r = await deps.roster(ctx.tenantId, branchId);
        return {
          status: 200,
          body: { employees: r.employees, shifts: r.shifts, assignments: r.assignments, ...(branchId === undefined ? {} : { branchId }) },
        };
      },
    },
    {
      // What the STORED roster is actually missing — the stateful counterpart to POST /roster-gaps. Read-only.
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/roster-gaps',
      permission: 'workforce.roster.read',
      handler: async (ctx) => {
        const branchId = typeof ctx.query['branchId'] === 'string' && ctx.query['branchId'] !== '' ? ctx.query['branchId'] : undefined;
        const r = await deps.roster(ctx.tenantId, branchId);
        const gaps = rosterGaps({ shifts: r.shifts, assignments: r.assignments, employees: r.employees });
        const unstaffed = gaps.filter((g) => g.assigned === 0).length;
        return {
          status: 200,
          body: { gaps, gapCount: gaps.length, unstaffed, shiftsChecked: r.shifts.length, ...(branchId === undefined ? {} : { branchId }) },
        };
      },
    },
  ];
}
