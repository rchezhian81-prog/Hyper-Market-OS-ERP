import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useBackings } from '../support/backings';

/**
 * **NEW-10 (verifier, D-8) — re-assigning an overdue task keeps its lateness.** The verifier's case: a critical task due
 * five hours ago has escalated; the manager re-sends it with a deadline an hour from now, the assignee completes it, and it
 * read "done on time". Now, on the real API in memory and on PostgreSQL: the missed deadline stays the ACCOUNTABLE one — the
 * re-assigned task stays escalated, the completion is late from the missed deadline, the missed deadline stays on the
 * task's record, and the re-assignment is sealed in the trail as "re-assigned after missing its deadline" with the
 * manager's reason. A task re-planned BEFORE its deadline is a plain new deadline (on time is on time).
 */

const backings = useBackings();
const HOUR = 3_600_000;
type Res = { status: number; body: unknown };
interface View { taskId: string; status: string; overdueByMinutes?: number; dueAt: string; accountableDueAt?: string; missedDeadlines?: string[]; detail: string; completion?: { lateByMinutes: number; accountableDueAt?: string } }

describe.each(backings)('NEW-10 — a re-assigned overdue task keeps its lateness — on $name', ({ harness }) => {
  it('stays escalated after the re-assignment, completes late from the missed deadline, and the re-assignment is audited', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner'); await h.provisionRole(T, 'u-mgr', 'store_manager'); await h.provisionRole(T, 'u-ravi', 'cashier');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body, idempotencyKey: randomUUID() }) });
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const assign = (taskId: string, dueAt: string, extra: Record<string, unknown> = {}) =>
      call('POST', `/v1/hr/workforce/assigned-tasks/${taskId}`, 'u-mgr', { branchId: 'BR1', title: 'Face aisle 4', assignedTo: 'u-ravi', dueAt, critical: true, evidenceRequired: true, ...extra });
    const board = async (): Promise<View[]> => ((await call('GET', '/v1/hr/workforce/assigned-tasks', 'u-mgr')).body as { tasks: View[] }).tasks;
    const missed = iso(now - 5 * HOUR);

    expect((await assign('t1', missed)).status).toBe(201);
    expect((await board()).find((v) => v.taskId === 't1')).toMatchObject({ status: 'escalated' });

    // The verifier's move: a new deadline an hour from now. It stays escalated, against the deadline it missed.
    const re = await assign('t1', iso(now + HOUR), { reason: 'Ravi was on the till all morning' });
    expect(re.status).toBe(201);
    const after = (await board()).find((v) => v.taskId === 't1')!;
    expect(after.status).toBe('escalated');
    expect(after.accountableDueAt).toBe(missed);
    expect(after.missedDeadlines).toEqual([missed]);
    expect(after.overdueByMinutes).toBeGreaterThanOrEqual(299);
    expect(after.detail).toMatch(/re-assigned after missing its deadline/);
    // His own page says the same.
    expect(((await call('GET', '/v1/hr/workforce/my-tasks', 'u-ravi')).body as { tasks: View[] }).tasks[0]).toMatchObject({ status: 'escalated', accountableDueAt: missed });

    // OB-158: only the assignee completes it; it is done LATE, from the missed deadline.
    expect((await call('POST', '/v1/hr/workforce/assigned-tasks/t1/complete', 'u-mgr', { stepsDone: [], evidenceRefs: ['x'] })).status).toBe(403);
    const done = await call('POST', '/v1/hr/workforce/assigned-tasks/t1/complete', 'u-ravi', { stepsDone: [], evidenceRefs: ['photo-aisle4'] });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect((done.body as { completion: { lateByMinutes: number; accountableDueAt: string } }).completion.lateByMinutes).toBeGreaterThanOrEqual(299);
    expect((done.body as { completion: { accountableDueAt: string } }).completion.accountableDueAt).toBe(missed);
    const final = (await board()).find((v) => v.taskId === 't1')!;
    expect(final.status).toBe('done_late');
    expect(final.detail).toMatch(/minute\(s\) after the deadline \(re-assigned after missing its deadline of/);

    // A task re-planned before its deadline: a plain new deadline — done on time is on time.
    expect((await assign('t2', iso(now + 2 * HOUR), { critical: false })).status).toBe(201);
    expect((await assign('t2', iso(now + 3 * HOUR), { critical: false })).status).toBe(201);
    const t2 = (await board()).find((v) => v.taskId === 't2')!;
    expect(t2.status).toBe('pending');
    expect(t2.accountableDueAt).toBeUndefined();
    expect((await call('POST', '/v1/hr/workforce/assigned-tasks/t2/complete', 'u-ravi', { stepsDone: [], evidenceRefs: ['p'] })).status).toBe(201);
    expect((await board()).find((v) => v.taskId === 't2')!.status).toBe('done');

    // The trail names the re-assignment after the miss, with the reason and both deadlines.
    const trail = (await call('GET', '/v1/audit/trail', 'u-owner')).body as { matches: { action: string; objectId: string; actorId: string; before: Record<string, string> | null; after: Record<string, string>; reason?: string }[] };
    const t1 = trail.matches.filter((m) => m.objectId === 't1' && m.action.startsWith('store_task.'));
    expect(t1.map((m) => [m.action, m.actorId])).toEqual([['store_task.assign', 'u-mgr'], ['store_task.reassign_after_missed_deadline', 'u-mgr'], ['store_task.complete', 'u-ravi']]);
    expect(t1[1]!.reason).toBe('Ravi was on the till all morning');
    expect(t1[1]!.after).toMatchObject({ accountableDueAt: missed, missedDeadlines: missed, dueAt: iso(now + HOUR) });
    expect(((await call('GET', '/v1/audit/trail/verify', 'u-owner')).body as { intact: boolean }).intact).toBe(true);
  });
});
