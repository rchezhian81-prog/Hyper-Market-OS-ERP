// HR/Workforce — roster-gap detection (M25-FR-01), on the tested `packages/workforce` engine. Given a
// proposed roster — the shifts a branch must cover, who is assigned to each, and the employee list — name
// what is ACTUALLY missing: reported per role per shift, WITH THE HOUR, never averaged ("14 of 16 covered"
// is a number nobody acts on; "Sunday 06:00 has nobody who can open the shop" is). A leaver still on the grid
// is not cover. This is the M25-FR-01 acceptance ("a roster gap is visible; an unstaffed critical role flags
// an exception") made a live surface.
//
//   • `POST /v1/hr/workforce/roster-gaps` — the named gaps in a proposed roster, plus the unstaffed count.
//
// STATELESS over the tested engine (the caller supplies the roster as a what-if — the payroll-review pattern);
// it commits NOTHING and the durable roster/attendance store is a later increment. Co-located with payroll —
// the other HR surface — under `/v1/hr`. Gated on the manager-held `workforce.roster.read` (§28: managers
// within scope; P-04 least privilege).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  rosterGaps,
  type ShiftRequirement, type ShiftAssignment, type Employee,
} from '../../../packages/workforce/src/workforce';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isArr = (v: unknown): v is unknown[] => Array.isArray(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

/** A shift the engine can read: an id, a start hour, and the roles it genuinely cannot run without. */
const isShift = (v: unknown): v is ShiftRequirement =>
  isObj(v) && isStr(v['shiftId']) && isStr(v['branchId']) && isStr(v['startsAt']) && isStr(v['endsAt'])
  && isArr(v['requiredRoles'])
  && (v['requiredRoles'] as unknown[]).every((r) => isObj(r) && isStr(r['role']) && isPosInt(r['count']));

/** An assignment: who is on which shift, as which role. */
const isAssignment = (v: unknown): v is ShiftAssignment =>
  isObj(v) && isStr(v['shiftId']) && isStr(v['employeeId']) && isStr(v['role']);

/** An employee the roster is checked against — a leaver (`active: false`) is not cover. */
const isEmployee = (v: unknown): v is Employee =>
  isObj(v) && isStr(v['employeeId']) && isStr(v['name']) && isStr(v['branchId'])
  && isArr(v['roles']) && (v['roles'] as unknown[]).every(isStr) && typeof v['active'] === 'boolean';

export function workforceRoutes(): readonly Route[] {
  return [
    {
      // The named gaps in a proposed roster. Body: { shifts: ShiftRequirement[], assignments: ShiftAssignment[],
      // employees: Employee[] }. Returns each gap (role + shift + hour + how short), the total, and how many
      // shifts have NOBODY rostered for a required role (the unstaffed-critical exception, M25-FR-01).
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/roster-gaps',
      permission: 'workforce.roster.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isArr(b['shifts']) || !isArr(b['assignments']) || !isArr(b['employees'])
          || !b['shifts'].every(isShift) || !b['assignments'].every(isAssignment) || !b['employees'].every(isEmployee)) {
          throw apiError(400, {
            code: 'not_readable_as_a_roster',
            whatHappened: 'A roster check needs shifts (each with shiftId, branchId, startsAt, endsAt and requiredRoles of {role, count>0}), assignments (shiftId, employeeId, role) and employees (employeeId, name, branchId, roles, active).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the proposed roster. Nothing is stored — this only reports what the roster is missing.',
          });
        }

        const gaps = rosterGaps({
          shifts: b['shifts'] as ShiftRequirement[],
          assignments: b['assignments'] as ShiftAssignment[],
          employees: b['employees'] as Employee[],
        });
        // "Nobody rostered" (assigned === 0) is the unstaffed-critical exception — surfaced separately so a
        // manager sees the shifts that cannot open at all, not just the ones that are a person short (P-03).
        const unstaffed = gaps.filter((g) => g.assigned === 0).length;
        return {
          status: 200,
          body: { gaps, gapCount: gaps.length, unstaffed, shiftsChecked: (b['shifts'] as unknown[]).length },
        };
      },
    },
  ];
}
