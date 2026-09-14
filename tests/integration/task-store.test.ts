import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// HR/Workforce DURABLE daily-task routing + escalation store (M25-FR-02) on the live API. A task is ROUTED to a
// role, its completion recorded, and an overdue CRITICAL task ESCALATES to the manager on duty (the acceptance
// "an overdue critical task escalates"). Definitions + completions are event-sourced latest-per-taskId on the
// tenant workforce stream (hard rule #2/#6); GET /v1/hr/workforce/tasks folds them and runs the tested
// assessDailyTasks. Writes gated workforce.roster.manage; reads workforce.task.read. ?asOf= makes the clock
// deterministic so escalation can be proven.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const putTask = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/tasks/${id}`, userId: u, tenantId: A, idempotencyKey: key, body });
const completeTask = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/tasks/${id}/complete`, userId: u, tenantId: A, idempotencyKey: key, body });
const listTasks = (h: ApiHarness, u: string, query: Record<string, string> = {}) =>
  h.request({ method: 'GET', path: '/v1/hr/workforce/tasks', userId: u, tenantId: A, query });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface Assessment { readonly taskId: string; readonly forRole: string; readonly status: string; readonly overdueByMinutes?: number }
interface ListBody { readonly tasks: readonly Assessment[]; readonly count: number; readonly escalated: readonly Assessment[]; readonly escalatedCount: number; readonly overdue: number }
const listBody = (res: { body: unknown }): ListBody => res.body as ListBody;

const AFTER_DUE = '2026-09-14T09:00:00Z'; // three hours after a 06:00 due time
const BEFORE_DUE = '2026-09-14T05:00:00Z';

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // workforce.roster.manage + task.read
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('durable daily-task routing + escalation store (M25-FR-02)', () => {
  it('an overdue CRITICAL task escalates; a non-critical one is only overdue; before its due time it is pending', async () => {
    const h = await cast();
    await putTask(h, 'u-mgr', 'T-chiller', { description: 'Chiller temperature check', forRole: 'cashier', dueAt: '2026-09-14T06:00:00Z', critical: true }, 'k1');
    await putTask(h, 'u-mgr', 'T-mop', { description: 'Mop the entrance', forRole: 'cashier', dueAt: '2026-09-14T06:00:00Z', critical: false }, 'k2');

    // Before the due time: both pending, nothing escalated.
    let body = listBody(await listTasks(h, 'u-mgr', { asOf: BEFORE_DUE }));
    expect(body.count).toBe(2);
    expect(body.escalatedCount).toBe(0);
    expect(body.tasks.every((t) => t.status === 'pending')).toBe(true);

    // After the due time: the critical one escalates, the mop is merely overdue.
    body = listBody(await listTasks(h, 'u-mgr', { asOf: AFTER_DUE }));
    expect(body.escalated.map((t) => t.taskId)).toEqual(['T-chiller']);
    expect(body.escalatedCount).toBe(1);
    expect(body.overdue).toBe(1);
    expect(body.tasks[0]).toMatchObject({ taskId: 'T-chiller', status: 'escalated', overdueByMinutes: 180 });
  });

  it('completing a task clears its escalation, and it all survives a restart', async () => {
    const h = await cast();
    await putTask(h, 'u-mgr', 'T-chiller', { description: 'Chiller temperature check', forRole: 'cashier', dueAt: '2026-09-14T06:00:00Z', critical: true }, 'k1');
    // Overdue + critical → escalated.
    expect(listBody(await listTasks(h, 'u-mgr', { asOf: AFTER_DUE })).escalatedCount).toBe(1);

    // Record it done.
    expect((await completeTask(h, 'u-mgr', 'T-chiller', { doneBy: 'Meena' }, 'k2')).status).toBe(200);

    // A restarted process rebuilds from the log: the task reads done, nothing escalated.
    const restarted = apiHarness({ store: h.store });
    const body = listBody(await listTasks(restarted, 'u-owner', { asOf: AFTER_DUE }));
    expect(body.tasks[0]).toMatchObject({ taskId: 'T-chiller', status: 'done' });
    expect(body.escalatedCount).toBe(0);
  });

  it('tasks are ROUTED to a role — the list can be narrowed to the role that must act', async () => {
    const h = await cast();
    await putTask(h, 'u-mgr', 'T-open-till', { description: 'Open the till', forRole: 'cashier', dueAt: '2026-09-14T06:00:00Z', critical: true, branchId: 'b1' }, 'k1');
    await putTask(h, 'u-mgr', 'T-goods-in', { description: 'Receive the morning delivery', forRole: 'warehouse', dueAt: '2026-09-14T06:00:00Z', critical: true, branchId: 'b1' }, 'k2');

    const cashierTasks = listBody(await listTasks(h, 'u-mgr', { role: 'cashier', asOf: AFTER_DUE }));
    expect(cashierTasks.count).toBe(1);
    expect(cashierTasks.tasks[0]!.taskId).toBe('T-open-till');
    // Filtering by branch keeps both; a warehouse task is not the cashier's to answer for.
    expect(listBody(await listTasks(h, 'u-mgr', { branchId: 'b1', asOf: AFTER_DUE })).count).toBe(2);
  });

  it('gates writes/reads, and refuses a malformed task', async () => {
    const h = await cast();
    // A cashier can neither define a task, complete one, nor read the routed list.
    expect((await putTask(h, 'u-cash', 'T-x', { description: 'x', forRole: 'cashier', dueAt: '2026-09-14T06:00:00Z', critical: false }, 'k1')).status).toBe(403);
    expect((await completeTask(h, 'u-cash', 'T-x', { doneBy: 'x' }, 'k2')).status).toBe(403);
    expect((await listTasks(h, 'u-cash')).status).toBe(403);
    // A malformed task (no dueAt, no critical) is refused, nothing stored.
    expect(codeOf(await putTask(h, 'u-mgr', 'T-bad', { description: 'no when', forRole: 'cashier' }, 'k3'))).toBe('not_readable_as_a_task');
    // A malformed completion (no doneBy) is refused.
    expect(codeOf(await completeTask(h, 'u-mgr', 'T-y', {}, 'k4'))).toBe('not_readable_as_a_completion');
  });
});
