// HR/Workforce — the people-side DECISION surface (M25-FR-01…04), on the tested `packages/workforce` engine.
//
//   • `POST /v1/hr/workforce/roster-gaps` (FR-01) — what a proposed roster is ACTUALLY missing: reported per
//     role per shift, WITH THE HOUR, never averaged ("14 of 16 covered" is a number nobody acts on; "Sunday
//     06:00 has nobody who can open the shop" is). A leaver still on the grid is not cover. Plus the unstaffed count.
//   • `POST /v1/hr/workforce/task-gate` (FR-03) — may this person do a GATED task, given their certifications,
//     today? The gate is on the TASK, never on the person: someone whose food-handling certificate lapsed cannot
//     work the deli counter but can still stack shelves (`stillAllowed` says so). An expired OR missing OR
//     unverified certificate blocks the task; a needed role the person lacks blocks it; a leaver is blocked outright.
//   • `POST /v1/hr/workforce/checklist-assess` (FR-02) — is the opening/closing/handover checklist done? BLOCKING
//     and non-blocking items are SEPARATED: a blocking item outstanding stops the shop (`blocked_item`); a signed
//     checklist with only non-blocking items left is complete, carrying them visibly into the next handover; an
//     unsigned one is "a list, not a record".
//   • `POST /v1/hr/workforce/incentive` (FR-03) — the exact incentive payout (§29.1): integer minor units, and a
//     MISSED target pays NOTHING, not a proportion — because "nearly" is a conversation, not a formula.
//   • `POST /v1/hr/workforce/sop-status` (FR-04) — who has acknowledged the CURRENT version of each SOP for their
//     role: acknowledging v3 is not acknowledging v5, and an old signature that looks like compliance is not.
//
// STATELESS over the tested engine (the caller supplies the inputs as a what-if — the payroll-review pattern);
// every route commits NOTHING and the durable roster/attendance/certification/SOP stores are later increments.
// Co-located with payroll — the other HR surface — under `/v1/hr`. Each gated on its own manager-held workforce
// permission (§28: managers within scope; P-04 least privilege).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  rosterGaps, canPerformTask, assessChecklist, computeIncentive, sopStatus,
  type ShiftRequirement, type ShiftAssignment, type Employee, type Certification,
  type ChecklistItem, type IncentiveTarget, type SopAcknowledgement,
} from '../../../packages/workforce/src/workforce';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isArr = (v: unknown): v is unknown[] => Array.isArray(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

const CHECKLIST_KINDS = ['opening', 'closing', 'handover'] as const;

/** A checklist item: what it is, whether it is done, and whether the shop cannot run without it. */
const isChecklistItem = (v: unknown): v is ChecklistItem =>
  isObj(v) && isStr(v['itemId']) && isStr(v['description']) && isBool(v['done']) && isBool(v['blocking'])
  && (v['doneBy'] === undefined || isStr(v['doneBy'])) && (v['doneAt'] === undefined || isStr(v['doneAt']))
  && (v['note'] === undefined || isStr(v['note']));

/** An incentive target: exact integer minor units; the payout is earned only if the target is met. */
const isIncentiveTarget = (v: unknown): v is IncentiveTarget =>
  isObj(v) && isStr(v['employeeId']) && isStr(v['metric'])
  && isNonNegInt(v['targetMinor']) && isNonNegInt(v['achievedMinor']) && isNonNegInt(v['payoutMinor'])
  && (v['acceleratorBps'] === undefined || isNonNegInt(v['acceleratorBps']))
  && (v['capMinor'] === undefined || isNonNegInt(v['capMinor']));

/** An SOP that applies to some roles, at a version. */
const isSop = (v: unknown): v is { sopId: string; title: string; version: number; forRoles: readonly string[] } =>
  isObj(v) && isStr(v['sopId']) && isStr(v['title']) && isNonNegInt(v['version'])
  && isArr(v['forRoles']) && (v['forRoles'] as unknown[]).every(isStr);

/** An SOP acknowledgement: which version this employee signed, and when. */
const isAcknowledgement = (v: unknown): v is SopAcknowledgement =>
  isObj(v) && isStr(v['sopId']) && isNonNegInt(v['version']) && isStr(v['employeeId']) && isStr(v['acknowledgedAt']);

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
    {
      // Assess an opening / closing / handover checklist. Body: { checklistId, kind, items: ChecklistItem[],
      // signedBy? }. A blocking item outstanding stops the shop; a signed checklist with only non-blocking items
      // left is complete and carries them into the handover; an unsigned one is not a record (M25-FR-02).
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/checklist-assess',
      permission: 'workforce.checklist.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['checklistId']) || !CHECKLIST_KINDS.includes(b['kind'] as typeof CHECKLIST_KINDS[number])
          || !isArr(b['items']) || !b['items'].every(isChecklistItem)
          || (b['signedBy'] !== undefined && !isStr(b['signedBy']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_checklist',
            whatHappened: 'A checklist assessment needs a checklistId, a kind (opening/closing/handover), items (each with itemId, description, done, blocking) and optionally signedBy.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the checklist. Nothing is stored — this only reports whether it is done.',
          });
        }
        const result = assessChecklist({
          checklistId: b['checklistId'] as string,
          kind: b['kind'] as typeof CHECKLIST_KINDS[number],
          items: b['items'] as ChecklistItem[],
          ...(isStr(b['signedBy']) ? { signedBy: b['signedBy'] as string } : {}),
        });
        return { status: 200, body: result };
      },
    },
    {
      // Compute an incentive payout. Body: an IncentiveTarget { employeeId, metric, targetMinor, achievedMinor,
      // payoutMinor, acceleratorBps?, capMinor? }. Exact integer minor units; a MISSED target pays nothing (§29.1).
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/incentive',
      permission: 'workforce.incentive.read', idempotent: true,
      handler: async (ctx) => {
        const b = ctx.body;
        if (!isIncentiveTarget(b)) {
          throw apiError(400, {
            code: 'not_readable_as_an_incentive',
            whatHappened: 'An incentive needs employeeId, metric, and whole minor-unit targetMinor, achievedMinor and payoutMinor (acceleratorBps and capMinor optional).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the target and what was achieved. Nothing is stored — this only computes the payout.',
          });
        }
        return { status: 200, body: computeIncentive(b) };
      },
    },
    {
      // Who has acknowledged the CURRENT version of each SOP for their role. Body: { employee: Employee,
      // sops: {sopId,title,version,forRoles}[], acknowledgements: SopAcknowledgement[] }. An old signature is
      // not current — acknowledging v3 is not acknowledging v5 (M25-FR-04).
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/sop-status',
      permission: 'workforce.sop.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isEmployee(b['employee']) || !isArr(b['sops']) || !b['sops'].every(isSop)
          || !isArr(b['acknowledgements']) || !b['acknowledgements'].every(isAcknowledgement)) {
          throw apiError(400, {
            code: 'not_readable_as_a_sop_status',
            whatHappened: 'An SOP status check needs an employee, sops (each with sopId, title, version, forRoles) and acknowledgements (sopId, version, employeeId, acknowledgedAt).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the person, the SOPs and their acknowledgements. Nothing is stored — this only reports who is up to date.',
          });
        }
        const statuses = sopStatus({
          employee: b['employee'] as Employee,
          sops: b['sops'] as { sopId: string; title: string; version: number; forRoles: readonly string[] }[],
          acknowledgements: b['acknowledgements'] as SopAcknowledgement[],
        });
        const outstanding = statuses.filter((s) => !s.upToDate).length;
        return { status: 200, body: { statuses, count: statuses.length, outstanding } };
      },
    },
  ];
}
