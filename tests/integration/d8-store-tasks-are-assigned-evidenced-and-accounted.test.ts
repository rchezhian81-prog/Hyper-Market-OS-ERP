import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **D-8 (roadmap v2.1 addendum, ratified R2) — "SOP checklists + assigned tasks with deadlines, evidence capture and
 * completion accountability; asserted".**
 *
 * On the real API, in memory and — with DATABASE_URL — on real PostgreSQL: a manager assigns an SOP checklist to a NAMED
 * person with a deadline (the SOP at the version in force); only that person completes it, in their own sign-in, with every
 * step ticked and the evidence it requires; a late completion stays late; an overdue critical task escalates to the
 * assigner; each act is sealed into the audit trail in the actor's name.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
interface View { taskId: string; status: string; assignedTo: string; assignedBy: string; sop?: { sopId: string; version: number }; completion?: { doneBy: string; lateByMinutes: number; evidenceRefs: string[] }; detail: string }

describe.each(backings)('D-8 — store tasks are assigned, evidenced and accounted for — on $name', ({ harness }) => {
  it('an SOP checklist is assigned to a named person; only they complete it, with every step and its evidence; late and overdue stay visible', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-ravi', 'cashier');
    await h.provisionRole(T, 'u-anu', 'cashier');
    let n = 0;
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body, idempotencyKey: `k-${n++}` }), ...(query === undefined ? {} : { query }) });
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const MIN = 60_000;

    // The SOP, published at version 3.
    expect((await call('POST', '/v1/hr/workforce/sops/sop-facing', 'u-owner', { title: 'Shelf facing', version: 3, forRoles: ['cashier'] })).status).toBeLessThan(300);
    const steps = [{ stepId: 'front', label: 'Pull stock to the front' }, { stepId: 'labels', label: 'Labels face out' }];
    const assign = (id: string, body: Record<string, unknown>, by = 'u-mgr') => call('POST', `/v1/hr/workforce/assigned-tasks/${id}`, by, { branchId: 'BR1', title: 'Face up aisle 4', critical: false, evidenceRequired: true, ...body });
    const complete = (id: string, by: string, body: Record<string, unknown>) => call('POST', `/v1/hr/workforce/assigned-tasks/${id}/complete`, by, body);

    // ── "SOP checklists + assigned tasks with deadlines" ──────────────────────────────────────────────────────
    const a1 = await assign('t-face', { assignedTo: 'u-ravi', dueAt: iso(now + 60 * MIN), sopId: 'sop-facing', steps });
    expect(a1.status).toBe(201);
    expect(a1.body).toMatchObject({ task: { assignedTo: 'u-ravi', assignedBy: 'u-mgr', sop: { sopId: 'sop-facing', version: 3 } } });
    // Refused: to nobody in the shop, an unpublished SOP, no deadline, a typed assigner, and by a cashier.
    expect(codeOf(await assign('t-x1', { assignedTo: 'u-ghost', dueAt: iso(now + MIN) }))).toBe('assignee_unknown');
    expect(codeOf(await assign('t-x2', { assignedTo: 'u-ravi', dueAt: iso(now + MIN), sopId: 'sop-none', steps }))).toBe('sop_unknown');
    expect(codeOf(await assign('t-x3', { assignedTo: 'u-ravi' }))).toBe('not_readable_as_an_assigned_task');
    expect(codeOf(await assign('t-x4', { assignedTo: 'u-ravi', dueAt: iso(now + MIN), assignedBy: 'u-owner' }))).toBe('actor_is_the_caller');
    expect((await assign('t-x5', { assignedTo: 'u-anu', dueAt: iso(now + MIN) }, 'u-ravi')).status).toBe(403);

    // ── "completion accountability" — only the assignee, in their own sign-in ────────────────────────────────
    const notMine = await complete('t-face', 'u-anu', { stepsDone: ['front', 'labels'], evidenceRefs: ['photo-1'] });
    expect(notMine.status).toBe(403);
    expect(codeOf(notMine)).toBe('not_your_task');
    expect(codeOf(await complete('t-face', 'u-ravi', { stepsDone: ['front', 'labels'], evidenceRefs: ['photo-1'], doneBy: 'u-anu' }))).toBe('actor_is_the_caller');
    // ── "evidence capture" and the SOP's steps ───────────────────────────────────────────────────────────────
    expect(codeOf(await complete('t-face', 'u-ravi', { stepsDone: ['front'], evidenceRefs: ['photo-1'] }))).toBe('checklist_incomplete');
    expect(codeOf(await complete('t-face', 'u-ravi', { stepsDone: ['front', 'labels'], evidenceRefs: [] }))).toBe('evidence_required');
    const ok = await complete('t-face', 'u-ravi', { stepsDone: ['front', 'labels'], evidenceRefs: ['photo-aisle4'] });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ completion: { doneBy: 'u-ravi', lateByMinutes: 0, evidenceRefs: ['photo-aisle4'] } });
    expect(codeOf(await complete('t-face', 'u-ravi', { stepsDone: ['front', 'labels'], evidenceRefs: ['photo-2'] }))).toBe('already_done');
    expect(codeOf(await assign('t-face', { assignedTo: 'u-anu', dueAt: iso(now + MIN) }))).toBe('task_already_done');

    // A task already past its deadline, done now: kept as late. A critical one nobody did: escalated to the assigner.
    expect((await assign('t-late', { title: 'Count the dairy chiller', assignedTo: 'u-anu', dueAt: iso(now - 30 * MIN), evidenceRequired: false })).status).toBe(201);
    expect(((await complete('t-late', 'u-anu', { stepsDone: [], evidenceRefs: [] })).body as { completion: { lateByMinutes: number } }).completion.lateByMinutes).toBeGreaterThanOrEqual(30);
    expect((await assign('t-crit', { title: 'Remove recalled paneer', assignedTo: 'u-anu', dueAt: iso(now - 10 * MIN), critical: true, evidenceRequired: true })).status).toBe(201);
    // Re-assigning before it is done is a new version (append-only), and the new assignee is the one who must do it.
    expect((await assign('t-reassign', { assignedTo: 'u-ravi', dueAt: iso(now + 120 * MIN) })).status).toBe(201);
    expect((await assign('t-reassign', { assignedTo: 'u-anu', dueAt: iso(now + 120 * MIN) })).status).toBe(201);
    expect(codeOf(await complete('t-reassign', 'u-ravi', { stepsDone: [], evidenceRefs: ['p'] }))).toBe('not_your_task');

    const board = (await call('GET', '/v1/hr/workforce/assigned-tasks', 'u-mgr', undefined, { asOf: iso(now + MIN) })).body as { tasks: View[]; escalated: number; doneLate: number };
    expect(board.tasks.map((t) => [t.taskId, t.status])).toEqual([['t-crit', 'escalated'], ['t-reassign', 'pending'], ['t-late', 'done_late'], ['t-face', 'done']]);
    expect(board.tasks[0]!.detail).toContain('escalated to u-mgr');
    expect(board.tasks.find((t) => t.taskId === 't-reassign')!.assignedTo).toBe('u-anu');
    expect(board.escalated).toBe(1);
    expect(board.doneLate).toBe(1);
    // Each person sees their own; a cashier cannot read the whole board.
    const mine = (await call('GET', '/v1/hr/workforce/my-tasks', 'u-anu')).body as { tasks: View[] };
    expect(mine.tasks.map((t) => t.taskId).sort()).toEqual(['t-crit', 't-late', 't-reassign']);
    expect((await call('GET', '/v1/hr/workforce/assigned-tasks', 'u-ravi')).status).toBe(403);

    // ── each act sealed in the actor's name ──────────────────────────────────────────────────────────────────
    const trail = (await call('GET', '/v1/audit/trail', 'u-owner', undefined, { objectType: 'store_task', objectId: 't-face' })).body as { matches: { action: string; actorId: string }[] };
    expect(trail.matches.map((m) => [m.action, m.actorId])).toEqual([['store_task.assign', 'u-mgr'], ['store_task.complete', 'u-ravi']]);
    expect(((await call('GET', '/v1/audit/trail/verify', 'u-owner')).body as { intact: boolean }).intact).toBe(true);
  });
});
