// HR/Workforce — roster-gap detection and task certification-gating (M25-FR-01 / M25-FR-03), on the tested
// `packages/workforce` engine.
//
//   • `POST /v1/hr/workforce/roster-gaps` — what a proposed roster is ACTUALLY missing: reported per role per
//     shift, WITH THE HOUR, never averaged ("14 of 16 covered" is a number nobody acts on; "Sunday 06:00 has
//     nobody who can open the shop" is). A leaver still on the grid is not cover. Plus the unstaffed count.
//   • `POST /v1/hr/workforce/task-gate` — may this person do a GATED task, given their certifications, today?
//     The gate is on the TASK, never on the person: someone whose food-handling certificate lapsed cannot work
//     the deli counter but can still stack shelves (`stillAllowed` says so), because a control people route
//     around on a busy Saturday is not a control. An expired OR missing OR unverified certificate blocks the
//     task; a role the task needs and the person lacks blocks it; a leaver is blocked outright. This is the
//     M25-FR-03 acceptance ("an expired certification blocks the gated task") made a live surface.
//
// STATELESS over the tested engine (the caller supplies the roster / the person + certs as a what-if — the
// payroll-review pattern); both commit NOTHING and the durable roster/attendance/certification store is a
// later increment. Co-located with payroll — the other HR surface — under `/v1/hr`. Gated on the manager-held
// `workforce.roster.read` / `workforce.task.read` (§28: managers within scope; P-04 least privilege).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  rosterGaps, canPerformTask,
  type ShiftRequirement, type ShiftAssignment, type Employee, type Certification,
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

/** A certificate on file — only a `verifiedBy` one counts as cover, and its `validUntil` is checked against today. */
const isCertification = (v: unknown): v is Certification =>
  isObj(v) && isStr(v['certificationId']) && isStr(v['employeeId']) && isStr(v['kind'])
  && isStr(v['issuedOn']) && isStr(v['validUntil'])
  && (v['verifiedBy'] === undefined || isStr(v['verifiedBy']));

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
    {
      // May this person do a gated task, today? Body: { employee: Employee, task: string,
      // requiresCertification?: string, requiresRole?: string, certifications: Certification[], today: 'YYYY-MM-DD' }.
      // Returns the decision (allowed + outcome + plain-language detail + what they may still do). The gate is on
      // the TASK, never the person — a lapsed certificate blocks the deli counter, not shelf-stacking (M25-FR-03).
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/task-gate',
      permission: 'workforce.task.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isEmployee(b['employee']) || !isStr(b['task']) || !isStr(b['today'])
          || !isArr(b['certifications']) || !b['certifications'].every(isCertification)
          || (b['requiresCertification'] !== undefined && !isStr(b['requiresCertification']))
          || (b['requiresRole'] !== undefined && !isStr(b['requiresRole']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_task_gate',
            whatHappened: 'A task gate needs an employee (employeeId, name, branchId, roles, active), a task, today (YYYY-MM-DD), a certifications list, and optionally the requiresCertification / requiresRole the task gates on.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the person, the task and their certificates. Nothing is stored — this only decides whether the task is allowed.',
          });
        }

        const decision = canPerformTask({
          employee: b['employee'] as Employee,
          task: b['task'] as string,
          certifications: b['certifications'] as Certification[],
          today: b['today'] as string,
          ...(isStr(b['requiresCertification']) ? { requiresCertification: b['requiresCertification'] as string } : {}),
          ...(isStr(b['requiresRole']) ? { requiresRole: b['requiresRole'] as string } : {}),
        });
        return { status: 200, body: decision };
      },
    },
  ];
}
