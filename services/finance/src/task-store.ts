// API-11 HR/Workforce — the DURABLE daily-task routing + escalation store (M25-FR-02), on the tested
// `packages/workforce` `assessDailyTasks` engine, alongside the roster, certification, SOP, attendance and
// checklist stores. This is the other half of M25-FR-02 (the checklist store is one half): the day's tasks are
// ROUTED to the right role, their completion is recorded, and an overdue CRITICAL task ESCALATES to the manager
// on duty (P-03) — the module's acceptance "an overdue critical task escalates".
//
//   • `POST /v1/hr/workforce/tasks/:taskId`            — define/raise a daily task { description, forRole, dueAt,
//     critical, branchId? }. manage.
//   • `POST /v1/hr/workforce/tasks/:taskId/complete`   — record that it was done { doneBy, doneAt? }. manage.
//   • `GET  /v1/hr/workforce/tasks?role=&branchId=&asOf=` — the routed tasks with their live status: pending /
//     overdue / escalated / done, worst first, with the escalated (critical + overdue) ones surfaced separately.
//     task.read.
//
// Writes gated `workforce.roster.manage`; reads `workforce.task.read`. Nothing completes automatically — it
// records what a role was asked to do and what a person did, and surfaces by exception what has gone critical
// and late (P-03, P-05). A critical task past its due time ESCALATES; a non-critical one is merely overdue,
// because if every late task shouted for a manager the one that mattered would be lost in the noise.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { assessDailyTasks, type DailyTask } from '../../../packages/workforce/src/workforce';

/** A daily task as defined: what it is, the role it is routed to, when it is due, and whether it is critical. */
export interface TaskDefinition {
  readonly taskId: string;
  readonly description: string;
  readonly forRole: string;
  readonly branchId?: string;
  readonly dueAt: string;
  readonly critical: boolean;
}

/** A record that a task was done: who did it and when. */
export interface TaskCompletion {
  readonly taskId: string;
  readonly doneBy: string;
  readonly doneAt: string;
}

export interface TaskStoreDeps {
  readonly putTask: (tenantId: string, def: TaskDefinition, key: string) => Promise<void> | void;
  readonly completeTask: (tenantId: string, completion: TaskCompletion, key: string) => Promise<void> | void;
  /** The stored tasks, each folded with its completion (done/doneBy/doneAt merged in). */
  readonly tasks: (tenantId: string) => Promise<readonly DailyTask[]> | readonly DailyTask[];
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

const readDefinition = (taskId: string, b: Record<string, unknown>): TaskDefinition | undefined => {
  if (!isStr(b['description']) || !isStr(b['forRole']) || !isStr(b['dueAt']) || !isBool(b['critical'])
    || (b['branchId'] !== undefined && !isStr(b['branchId']))) return undefined;
  return {
    taskId, description: b['description'], forRole: b['forRole'], dueAt: b['dueAt'], critical: b['critical'],
    ...(isStr(b['branchId']) ? { branchId: b['branchId'] } : {}),
  };
};

export function taskStoreRoutes(deps: TaskStoreDeps): readonly Route[] {
  return [
    {
      // Define/raise a daily task, routed to a role. Body: { description, forRole, dueAt, critical, branchId? }.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/tasks/:taskId',
      permission: 'workforce.roster.manage', idempotent: true,
      handler: async (ctx) => {
        const taskId = (ctx.params['taskId'] ?? '').trim();
        const def = taskId === '' ? undefined : readDefinition(taskId, (ctx.body ?? {}) as Record<string, unknown>);
        if (def === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_task',
            whatHappened: 'A daily task needs a taskId in the path and { description, forRole, dueAt (ISO), critical (true/false) } in the body (branchId optional).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the task, the role it is for, when it is due, and whether it is critical.',
          });
        }
        await deps.putTask(ctx.tenantId, def, ctx.idempotencyKey ?? `task-${taskId}-${deps.now()}`);
        return { status: 200, body: { task: def } };
      },
    },
    {
      // Record that a task was done. Body: { doneBy, doneAt? }. Recorded even for an unknown task (latest-wins);
      // the routed list only marks a task done when a definition for it exists.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/tasks/:taskId/complete',
      permission: 'workforce.roster.manage', idempotent: true,
      handler: async (ctx) => {
        const taskId = (ctx.params['taskId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (taskId === '' || !isStr(b['doneBy']) || (b['doneAt'] !== undefined && !isStr(b['doneAt']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_completion',
            whatHappened: 'A task completion needs a taskId in the path and { doneBy } in the body (doneAt optional, defaults to now).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send who completed the task.',
          });
        }
        const completion: TaskCompletion = {
          taskId, doneBy: b['doneBy'], doneAt: isStr(b['doneAt']) ? b['doneAt'] : deps.now(),
        };
        await deps.completeTask(ctx.tenantId, completion, ctx.idempotencyKey ?? `taskdone-${taskId}-${deps.now()}`);
        return { status: 200, body: { completion } };
      },
    },
    {
      // Reconcile a task completed OFFLINE at the store (M25-FR-02, §31/P-01, offline-first). When the box has no
      // internet the task is still done; the completion is committed to the store's own outbox (hard rule #1) and
      // the sync agent relays it HERE under the store's sync token. `doneBy` is who was captured at the box —
      // TRUSTED as the synced-return route trusts the lane's operator. Records exactly as the /complete route
      // does (same durable store), gated on the narrow store-sync permission `workforce.completion.sync` — not
      // `roster.manage`, which the box's service identity must not hold (P-04). Idempotent: a re-delivery is one
      // record. Never rejects a task that genuinely happened — only a 400 for a payload it cannot read.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/tasks/:taskId/complete/synced',
      permission: 'workforce.completion.sync', idempotent: true,
      handler: async (ctx) => {
        const taskId = (ctx.params['taskId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (taskId === '' || !isStr(b['doneBy']) || (b['doneAt'] !== undefined && !isStr(b['doneAt']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_completion',
            whatHappened: 'A task completion needs a taskId in the path and { doneBy } in the body (doneAt optional, defaults to now).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Keep it in the outbox and raise it — a task completed at the store must not be dropped.',
          });
        }
        const completion: TaskCompletion = {
          taskId, doneBy: b['doneBy'], doneAt: isStr(b['doneAt']) ? b['doneAt'] : deps.now(),
        };
        await deps.completeTask(ctx.tenantId, completion, ctx.idempotencyKey ?? `taskdone-synced-${taskId}-${deps.now()}`);
        return { status: 200, body: { completion, synced: true } };
      },
    },
    {
      // The routed tasks with their live status. Optionally narrowed ?role= / ?branchId=; ?asOf= sets the instant
      // the clock is read at (defaults to now), so an overdue/escalated task can be assessed deterministically.
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/tasks',
      permission: 'workforce.task.read',
      handler: async (ctx) => {
        const role = (ctx.query['role'] ?? '').trim();
        const branchId = (ctx.query['branchId'] ?? '').trim();
        const asOf = (ctx.query['asOf'] ?? '').trim();
        let tasks = await deps.tasks(ctx.tenantId);
        if (role !== '') tasks = tasks.filter((t) => t.forRole === role);
        if (branchId !== '') tasks = tasks.filter((t) => t.branchId === branchId);
        const report = assessDailyTasks({ tasks, now: asOf === '' ? deps.now() : asOf });
        return {
          status: 200,
          body: {
            tasks: report.assessments,
            count: report.assessments.length,
            escalated: report.escalated,
            escalatedCount: report.escalated.length,
            overdue: report.overdue,
          },
        };
      },
    },
  ];
}
