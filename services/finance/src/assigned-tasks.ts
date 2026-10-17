// API-11 HR/Workforce — assigned store tasks (D-8, roadmap v2.1 addendum, ratified R2): "SOP checklists + assigned tasks
// with deadlines, evidence capture and completion accountability".
//
//   • POST /v1/hr/workforce/assigned-tasks/:taskId          — assign a task to a NAMED person with a deadline: { branchId,
//     title, assignedTo, dueAt, critical, evidenceRequired, sopId?, steps?[] }. The assigner is the caller. With an
//     `sopId` the task is that SOP's checklist, at the version in force now. The assignee must be a person in this shop
//     who may complete tasks. Re-assigning before it is done is a new version (append-only); after, refused. NEW-10: a
//     re-assignment after the deadline passed keeps that missed deadline as the accountable one (the task stays overdue, a
//     critical one stays escalated, and its completion is late from it), lists it among the missed deadlines, and is
//     sealed in the trail as "re-assigned after missing its deadline", with the reason given (optional `reason`).
//     workforce.roster.manage.
//   • POST /v1/hr/workforce/assigned-tasks/:taskId/complete — the ASSIGNEE completes it, in their own sign-in: { stepsDone[],
//     evidenceRefs[], note? }. Every step ticked; the evidence the task requires; on time or minutes late, kept.
//     workforce.task.complete.own.
//   • GET  /v1/hr/workforce/assigned-tasks?branchId=&assignee=&asOf= — every task, worst first. workforce.task.read.
//   • GET  /v1/hr/workforce/my-tasks?asOf=                   — the caller's own tasks. workforce.task.complete.own.
//
// Each assignment and each completion is sealed into the tamper-evident audit trail in the actor's name (M34-FR-01). The
// rules are the pure engine in `packages/workforce/src/assigned-tasks.ts`; the role-routed daily tasks (M25-FR-02) are
// unchanged beside it. No AI assigns or completes a task (hard rule #5): A10 may only point at one.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound, requireActorIsCaller, assertBranchInScope, narrowScope } from '../../kernel/src/index';
import {
  assignmentProblem, assessAssignedTasks, checkCompletion, carriedLateness, accountableDueOf,
  type AssignedTask, type AssignedTaskCompletion, type TaskStep,
} from '../../../packages/workforce/src/assigned-tasks';
import type { AuditEntry } from '../../../packages/audit/src/index';

/** The permission that lets a person complete the tasks assigned to them. */
export const COMPLETE_OWN_TASK = 'workforce.task.complete.own';

export interface AssignedTaskDeps {
  /** The latest version of every task. */
  readonly tasks: (tenantId: string) => Promise<readonly AssignedTask[]> | readonly AssignedTask[];
  readonly completions: (tenantId: string) => Promise<readonly AssignedTaskCompletion[]> | readonly AssignedTaskCompletion[];
  readonly recordTask: (tenantId: string, task: AssignedTask) => Promise<void> | void;
  readonly recordCompletion: (tenantId: string, completion: AssignedTaskCompletion) => Promise<void> | void;
  /** The SOP as published now (M25-FR-04), or undefined. */
  readonly sop: (tenantId: string, sopId: string) => Promise<{ readonly title: string; readonly version: number } | undefined> | { readonly title: string; readonly version: number } | undefined;
  /** What a person holds in this shop (undefined: not a person here). */
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const strList = (v: unknown): string[] | undefined => (v === undefined ? [] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined);

function readSteps(v: unknown): TaskStep[] | undefined {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return undefined;
  const out: TaskStep[] = [];
  for (const s of v) {
    if (s === null || typeof s !== 'object' || !isStr((s as Record<string, unknown>)['stepId']) || !isStr((s as Record<string, unknown>)['label'])) return undefined;
    out.push({ stepId: ((s as Record<string, string>)['stepId'] as string).trim(), label: ((s as Record<string, string>)['label'] as string).trim() });
  }
  return out;
}

export function assignedTaskRoutes(deps: AssignedTaskDeps): readonly Route[] {
  const taskOf = async (tenantId: string, taskId: string) => (await deps.tasks(tenantId)).find((t) => t.taskId === taskId);
  const completionOf = async (tenantId: string, taskId: string) => (await deps.completions(tenantId)).find((c) => c.taskId === taskId);
  return [
    {
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/assigned-tasks/:taskId',
      permission: 'workforce.roster.manage', idempotent: true,
      handler: async (ctx) => {
        const taskId = (ctx.params['taskId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        requireActorIsCaller(ctx, b, 'assignedBy');
        const steps = readSteps(b['steps']);
        const draft = steps === undefined || typeof b['critical'] !== 'boolean' || typeof b['evidenceRequired'] !== 'boolean' ? undefined : {
          branchId: isStr(b['branchId']) ? b['branchId'].trim() : '', title: isStr(b['title']) ? b['title'].trim() : '',
          assignedTo: isStr(b['assignedTo']) ? b['assignedTo'].trim() : '', dueAt: isStr(b['dueAt']) ? b['dueAt'] : '',
          critical: b['critical'], evidenceRequired: b['evidenceRequired'], steps,
        };
        const problem = taskId === '' ? 'the task needs an id in the path' : draft === undefined
          ? 'critical and evidenceRequired must be true/false, and steps a list of { stepId, label }' : assignmentProblem(draft);
        if (problem !== null || draft === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_an_assigned_task',
            whatHappened: `This could not be read as an assigned task: ${problem ?? ''}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { branchId, title, assignedTo, dueAt, critical, evidenceRequired, sopId?, steps? }. Nothing was assigned.',
          });
        }
        assertBranchInScope(ctx, draft.branchId); // PA-01-r1
        const before = await taskOf(ctx.tenantId, taskId);
        if (before !== undefined) assertBranchInScope(ctx, before.branchId);
        if (before !== undefined && (await completionOf(ctx.tenantId, taskId)) !== undefined) {
          throw apiError(409, { code: 'task_already_done', whatHappened: `"${before.title}" is already done — a done task is never re-assigned or rewritten.`, wasItSaved: 'not_saved', nextSafeAction: 'Assign a new task with a new id. Nothing was changed.' });
        }
        // Completion accountability starts at assignment: the assignee is a person in this shop who may complete tasks.
        const held = await deps.permissionsOfUser(ctx.tenantId, draft.assignedTo);
        if (held === undefined || !held.includes(COMPLETE_OWN_TASK)) {
          throw apiError(422, {
            code: held === undefined ? 'assignee_unknown' : 'assignee_cannot_complete_tasks',
            whatHappened: held === undefined
              ? `${draft.assignedTo} is not a person in this shop — a task is assigned to someone who can be asked about it.`
              : `${draft.assignedTo} holds no role that may complete store tasks.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Assign it to a person in the shop who completes tasks. Nothing was assigned.',
          });
        }
        let sop: AssignedTask['sop'];
        if (b['sopId'] !== undefined) {
          const found = isStr(b['sopId']) ? await deps.sop(ctx.tenantId, b['sopId'].trim()) : undefined;
          if (found === undefined) {
            throw apiError(422, { code: 'sop_unknown', whatHappened: `No SOP "${String(b['sopId'])}" is published — an SOP checklist carries out a published SOP.`, wasItSaved: 'not_saved', nextSafeAction: 'Publish the SOP first (POST /v1/hr/workforce/sops/:sopId), or leave sopId out. Nothing was assigned.' });
          }
          sop = { sopId: (b['sopId'] as string).trim(), version: found.version };
          if (draft.steps.length === 0) {
            throw apiError(400, { code: 'not_readable_as_an_assigned_task', whatHappened: 'An SOP checklist needs its steps.', wasItSaved: 'not_saved', nextSafeAction: 'Send the SOP\'s steps. Nothing was assigned.' });
          }
        }
        if (b['reason'] !== undefined && typeof b['reason'] !== 'string') {
          throw apiError(400, { code: 'not_readable_as_an_assigned_task', whatHappened: 'reason, when sent, is text.', wasItSaved: 'not_saved', nextSafeAction: 'Send the reason as text. Nothing was assigned.' });
        }
        const reason = isStr(b['reason']) ? b['reason'].trim() : undefined;
        const at = deps.now();
        // NEW-10: a missed deadline stays on record and stays the one the task is accounted against.
        const carried = carriedLateness(before, at);
        const task: AssignedTask = {
          taskId, ...draft, dueAt: new Date(Date.parse(draft.dueAt)).toISOString(), assignedBy: ctx.userId, assignedAt: at,
          ...(sop === undefined ? {} : { sop }), ...carried,
        };
        const afterMissing = before !== undefined && carried.accountableDueAt !== undefined;
        await deps.recordTask(ctx.tenantId, task);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: before === undefined ? 'store_task.assign' : afterMissing ? 'store_task.reassign_after_missed_deadline' : 'store_task.reassign',
          objectType: 'store_task', objectId: taskId, at,
          origin: { tenantId: ctx.tenantId, branchId: task.branchId },
          before: before === undefined ? null : { assignedTo: before.assignedTo, dueAt: before.dueAt, accountableDueAt: accountableDueOf(before) },
          after: {
            assignedTo: task.assignedTo, dueAt: task.dueAt, accountableDueAt: accountableDueOf(task), missedDeadlines: (task.missedDeadlines ?? []).join(','),
            critical: String(task.critical), evidenceRequired: String(task.evidenceRequired), sop: sop === undefined ? '' : `${sop.sopId}@${sop.version}`, steps: task.steps.map((s) => s.stepId).join(','),
          },
          ...(reason !== undefined ? { reason } : afterMissing ? { reason: `re-assigned after missing its deadline of ${carried.accountableDueAt}` } : {}),
          correlationId: taskId,
        });
        return { status: 201, body: { task } };
      },
    },
    {
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/assigned-tasks/:taskId/complete',
      permission: COMPLETE_OWN_TASK, idempotent: true,
      handler: async (ctx) => {
        const taskId = (ctx.params['taskId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        requireActorIsCaller(ctx, b, 'doneBy');
        const task = await taskOf(ctx.tenantId, taskId);
        if (task === undefined) throw notFound(`assigned task ${taskId}`);
        assertBranchInScope(ctx, task.branchId); // PA-01-r1
        const stepsDone = strList(b['stepsDone']);
        const evidenceRefs = strList(b['evidenceRefs']);
        if (stepsDone === undefined || evidenceRefs === undefined || (b['note'] !== undefined && typeof b['note'] !== 'string')) {
          throw apiError(400, { code: 'not_readable_as_a_task_completion', whatHappened: 'A completion takes { stepsDone: [stepId…], evidenceRefs: [ref…], note? }.', wasItSaved: 'not_saved', nextSafeAction: 'Send what was done. Nothing was recorded.' });
        }
        const at = deps.now();
        const checked = checkCompletion(task, { doneBy: ctx.userId, doneAt: at, stepsDone, evidenceRefs, ...(typeof b['note'] === 'string' ? { note: b['note'] } : {}) }, await completionOf(ctx.tenantId, taskId));
        if (!checked.ok) {
          throw apiError(checked.refusal === 'not_your_task' ? 403 : checked.refusal === 'already_done' ? 409 : 422, {
            code: checked.refusal, whatHappened: checked.detail, wasItSaved: 'not_saved',
            nextSafeAction: checked.refusal === 'evidence_required' ? 'Attach the photo or document reference and complete it again. Nothing was recorded.'
              : checked.refusal === 'checklist_incomplete' ? 'Do and tick every step, then complete it. Nothing was recorded.' : 'Nothing was recorded.',
          });
        }
        await deps.recordCompletion(ctx.tenantId, checked.completion);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'store_task.complete', objectType: 'store_task', objectId: taskId, at,
          origin: { tenantId: ctx.tenantId, branchId: task.branchId },
          before: null,
          after: { doneBy: ctx.userId, lateByMinutes: String(checked.completion.lateByMinutes), accountableDueAt: accountableDueOf(task), evidenceRefs: checked.completion.evidenceRefs.join(','), steps: checked.completion.stepsDone.join(',') },
          correlationId: taskId,
        });
        return { status: 201, body: { completion: checked.completion } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/assigned-tasks',
      permission: 'workforce.task.read',
      handler: async (ctx) => {
        const asked = ctx.query['branchId'];
        const scope = narrowScope(ctx, isStr(asked) ? [asked] : undefined); // PA-01-r1
        const assignee = ctx.query['assignee'];
        const asOf = ctx.query['asOf'];
        const tasks = (await deps.tasks(ctx.tenantId)).filter((t) => (scope === 'all' || scope.includes(t.branchId)) && (!isStr(assignee) || t.assignedTo === assignee));
        const views = assessAssignedTasks(tasks, await deps.completions(ctx.tenantId), isStr(asOf) && !Number.isNaN(Date.parse(asOf)) ? asOf : deps.now());
        return { status: 200, body: { tasks: views, count: views.length, escalated: views.filter((v) => v.status === 'escalated').length, overdue: views.filter((v) => v.status === 'overdue').length, doneLate: views.filter((v) => v.status === 'done_late').length } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/my-tasks',
      permission: COMPLETE_OWN_TASK,
      handler: async (ctx) => {
        const asOf = ctx.query['asOf'];
        const mine = (await deps.tasks(ctx.tenantId)).filter((t) => t.assignedTo === ctx.userId);
        const views = assessAssignedTasks(mine, await deps.completions(ctx.tenantId), isStr(asOf) && !Number.isNaN(Date.parse(asOf)) ? asOf : deps.now());
        return { status: 200, body: { tasks: views, count: views.length } };
      },
    },
  ];
}
