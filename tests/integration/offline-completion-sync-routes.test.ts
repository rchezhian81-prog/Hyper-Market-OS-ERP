import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M25-FR-02 offline-first (§31/P-01) — the CLOUD half of the offline task/checklist COMPLETION queue (slice 1).
// When the store box has no internet, a manager still opens and closes the shop; the completion is committed to
// the box's own outbox (hard rule #1) and the sync agent later relays it to these dedicated SYNCED routes under
// the store's sync token. They record the completion into the SAME durable stores as the online routes, gated on
// the NARROW `workforce.completion.sync` permission (not the full `workforce.roster.manage`, which the box's
// service identity must not hold — P-04), and are idempotent (a re-delivered completion is one record). The edge
// pipeline that queues + drains these events is slice 2.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const syncChecklist = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/checklists/${id}/synced`, userId: u, tenantId: A, idempotencyKey: key, body });
const checklistStatus = (h: ApiHarness, u: string, id: string) =>
  h.request({ method: 'GET', path: `/v1/hr/workforce/checklists/${id}/status`, userId: u, tenantId: A });
const defineTask = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/tasks/${id}`, userId: u, tenantId: A, idempotencyKey: key, body });
const syncTaskDone = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/tasks/${id}/complete/synced`, userId: u, tenantId: A, idempotencyKey: key, body });
const listTasks = (h: ApiHarness, u: string, query: Record<string, string> = {}) =>
  h.request({ method: 'GET', path: '/v1/hr/workforce/tasks', userId: u, tenantId: A, query });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

// A signed closing checklist, exactly as the box captured it offline.
const closing = () => ({
  kind: 'closing' as const, signedBy: 'Meena', branchId: 'b1',
  items: [
    { itemId: 'safe', description: 'Cash in the safe, counted', done: true, blocking: true },
    { itemId: 'log', description: 'Fridge temperature log filled', done: true, blocking: false },
  ],
});

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // holds workforce.completion.sync (+ manage/read)
  await h.provisionRole(A, 'u-cash', 'cashier');       // holds NEITHER
  return h;
}

describe('offline checklist/task completion sync routes (M25-FR-02, §31/P-01)', () => {
  it('a checklist completed offline syncs to the SAME durable store and reads back complete', async () => {
    const h = await cast();
    // The box relays the completion under a completion.sync-holding token.
    const res = await syncChecklist(h, 'u-mgr', 'CL-1', closing(), 'k1');
    expect(res.status).toBe(200);
    expect((res.body as { synced?: boolean }).synced).toBe(true);

    // It is the same store the online routes use — the status route (read) sees it, signed and complete.
    const s = checklistStatus(h, 'u-mgr', 'CL-1');
    const body = (await s).body as { assessment: { outcome: string; complete: boolean }; checklist: { signedBy?: string } };
    expect(body.assessment.outcome).toBe('complete');
    expect(body.assessment.complete).toBe(true);
    expect(body.checklist.signedBy).toBe('Meena');
  });

  it('a task completed offline syncs and marks the stored task done', async () => {
    const h = await cast();
    await defineTask(h, 'u-mgr', 'T-chiller', { description: 'Chiller temperature check', forRole: 'cashier', dueAt: '2026-09-14T06:00:00Z', critical: true }, 'kd');
    const res = await syncTaskDone(h, 'u-mgr', 'T-chiller', { doneBy: 'Meena' }, 'k1');
    expect(res.status).toBe(200);
    expect((res.body as { synced?: boolean }).synced).toBe(true);

    const list = (await listTasks(h, 'u-mgr', { asOf: '2026-09-14T09:00:00Z' })).body as { tasks: readonly { taskId: string; status: string }[] };
    expect(list.tasks.find((t) => t.taskId === 'T-chiller')?.status).toBe('done');
  });

  it('the synced routes are gated on the narrow completion.sync permission — a cashier is refused', async () => {
    const h = await cast();
    expect((await syncChecklist(h, 'u-cash', 'CL-1', closing(), 'k1')).status).toBe(403);
    expect((await syncTaskDone(h, 'u-cash', 'T-1', { doneBy: 'x' }, 'k2')).status).toBe(403);
  });

  it('a re-delivered completion is idempotent (one record), and a malformed one is refused without dropping it', async () => {
    const h = await cast();
    // Same idempotency key twice — a retry the sync agent makes on an ambiguous first attempt. Both succeed.
    expect((await syncChecklist(h, 'u-mgr', 'CL-1', closing(), 'same-key')).status).toBe(200);
    expect((await syncChecklist(h, 'u-mgr', 'CL-1', closing(), 'same-key')).status).toBe(200);
    // Still exactly one checklist on the shelf.
    const all = (await h.request({ method: 'GET', path: '/v1/hr/workforce/checklists', userId: 'u-mgr', tenantId: A })).body as { count: number };
    expect(all.count).toBe(1);

    // A payload that cannot be read is refused 400 (kept in the outbox and raised — never dropped).
    expect(codeOf(await syncChecklist(h, 'u-mgr', 'CL-bad', { kind: 'midday', items: [] }, 'kb'))).toBe('not_readable_as_a_checklist');
    expect(codeOf(await syncTaskDone(h, 'u-mgr', 'T-bad', {}, 'kt'))).toBe('not_readable_as_a_completion');
  });
});
