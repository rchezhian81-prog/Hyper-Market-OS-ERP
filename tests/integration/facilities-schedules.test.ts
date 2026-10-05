import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Facilities maintenance & compliance schedules, end to end through the real API (M26-FR-03, API-11).
// A tick against "fire extinguishers checked" is worth nothing at an inspection: where a schedule
// demands evidence, a completion without it is REFUSED (an accepted-with-a-note task shows green, and
// green is what everybody reads); a safety check needs a second verifier who is not the one who did it
// (§28); and a compliance-linked miss (fire/pest/electrical/statutory) escalates BY ITSELF while
// cleaning never does. Proves the wired facilities surface against the real pipeline and real RBAC.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const fire = (over: Record<string, unknown> = {}) => ({
  branchId: 'BR1', title: 'Fire extinguisher check', category: 'fire_safety', frequency: 'monthly',
  assignedRole: 'facilities', escalatesTo: 'u-mgr', evidenceRequired: true, verificationRequired: true, ...over,
});

const defineSched = (h: ApiHarness, tenantId: string, userId: string, id: string, body = fire(), key?: string) =>
  h.request({ method: 'POST', path: `/v1/facilities/schedules/${id}`, userId, tenantId, idempotencyKey: key ?? `fs-${id}`, body });

const raiseTask = (h: ApiHarness, tenantId: string, userId: string, schedId: string, taskId: string, dueOn: string) =>
  h.request({ method: 'POST', path: `/v1/facilities/schedules/${schedId}/tasks/${taskId}`, userId, tenantId, idempotencyKey: `ft-${taskId}`, body: { dueOn } });

const complete = (h: ApiHarness, tenantId: string, userId: string, taskId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/facilities/tasks/${taskId}/complete`, userId, tenantId, idempotencyKey: key ?? `fc-${taskId}`, body });
// The second person's own act (Wave 2b · PA-03): verify under THEIR sign-in.
const verify = (h: ApiHarness, tenantId: string, userId: string, taskId: string, key?: string) =>
  h.request({ method: 'POST', path: `/v1/facilities/tasks/${taskId}/verify`, userId, tenantId, idempotencyKey: key ?? `fv-${taskId}-${userId}`, body: {} });

const overdue = (h: ApiHarness, tenantId: string, userId: string, asOf: string) =>
  h.request({ method: 'GET', path: '/v1/facilities/overdue', userId, tenantId, query: { asOf } });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
interface Overdue { overdue: { taskId: string; level: string }[]; complianceRisks: number }
const levelOf = (r: Overdue, id: string) => r.overdue.find((o) => o.taskId === id)?.level;

describe('facilities schedules: a hollow tick is refused, a compliance miss escalates itself (M26-FR-03)', () => {
  it('refuses a hollow tick; a safety check waits for a DIFFERENT signed-in person to verify it — the completer cannot, a typed name cannot (Wave 2b · PA-03)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager'); // facilities.task.record — the second person
    await defineSched(h, A, 'u-owner', 'sched-fire');
    await raiseTask(h, A, 'u-owner', 'sched-fire', 't1', '2026-08-05');

    // who did it is the caller: a body naming somebody else, or naming the verifier at all, is refused by name
    expect(codeOf(await complete(h, A, 'u-owner', 't1', { completedBy: 'u-cleaner', evidenceRefs: ['photo.jpg'] }, 'c-0'))).toBe('actor_is_the_caller');
    expect(codeOf(await complete(h, A, 'u-owner', 't1', { evidenceRefs: ['photo.jpg'], verifiedBy: 'u-mgr' }, 'c-1'))).toBe('second_person_is_a_separate_act');
    expect(codeOf(await complete(h, A, 'u-owner', 't1', {}, 'c-a'))).toBe('evidence_missing');
    // evidence attached, verification required: done and recorded, WAITING — not accepted
    const waiting = await complete(h, A, 'u-owner', 't1', { evidenceRefs: ['photo.jpg'] }, 'c-b');
    expect(waiting.status).toBe(202);
    expect(waiting.body).toMatchObject({ accepted: false, outcome: 'not_verified', awaitingVerification: true, completedBy: 'u-owner' });
    const listed = (await overdue(h, A, 'u-owner', '2026-08-10')).body as Overdue & { overdue: { awaitingVerification?: boolean; completedBy?: string }[] };
    expect(listed.overdue.find((o) => o.taskId === 't1')).toMatchObject({ awaitingVerification: true, completedBy: 'u-owner' });
    // the completer cannot verify their own check (§28); a body naming a verifier is refused
    expect(codeOf(await verify(h, A, 'u-owner', 't1'))).toBe('self_verified');
    expect(codeOf(await h.request({ method: 'POST', path: '/v1/facilities/tasks/t1/verify', userId: 'u-mgr', tenantId: A, idempotencyKey: 'fv-named', body: { verifiedBy: 'u-owner' } }))).toBe('actor_is_the_caller');
    // a DIFFERENT signed-in person verifies → accepted
    const ok = await verify(h, A, 'u-mgr', 't1');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ accepted: true, verifiedBy: 'u-mgr' });
    expect((await verify(h, A, 'u-mgr', 't1', 'fv-again')).body).toMatchObject({ alreadyVerified: true });
    // nothing to verify on a task nobody marked done
    await raiseTask(h, A, 'u-owner', 'sched-fire', 't2', '2026-08-05');
    expect(codeOf(await verify(h, A, 'u-mgr', 't2'))).toBe('nothing_to_verify');
  });

  it('escalates a compliance-linked miss by itself, but never buries it among cleaning alerts', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await defineSched(h, A, 'u-owner', 'sched-fire', fire());
    await defineSched(h, A, 'u-owner', 'sched-clean', fire({ title: 'Mop aisle 4', category: 'cleaning', evidenceRequired: false, verificationRequired: false }));
    await raiseTask(h, A, 'u-owner', 'sched-fire', 't-fire', '2026-08-01');
    await raiseTask(h, A, 'u-owner', 'sched-clean', 't-clean', '2026-08-01');

    const r = (await overdue(h, A, 'u-owner', '2026-08-10')).body as Overdue; // both 9 days overdue
    expect(levelOf(r, 't-fire')).toBe('compliance_risk'); // a regulator would care
    expect(levelOf(r, 't-clean')).toBe('escalated');       // late, but not a compliance risk
    expect(r.complianceRisks).toBe(1);
  });

  it('drops an accepted task off the overdue list', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await defineSched(h, A, 'u-owner', 'sched-fire');
    await raiseTask(h, A, 'u-owner', 'sched-fire', 't1', '2026-08-01');
    await h.provisionRole(A, 'u-mgr', 'store_manager');
    await complete(h, A, 'u-owner', 't1', { evidenceRefs: ['photo.jpg'] });
    await verify(h, A, 'u-mgr', 't1');

    expect((await overdue(h, A, 'u-owner', '2026-08-10')).body as Overdue).toMatchObject({ overdue: [] });
  });

  it('is authorized and per-tenant, and refuses unknown/ malformed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // a cashier does not manage facilities
    await defineSched(h, A, 'u-owner', 'sched-fire');

    expect((await defineSched(h, A, 'u-cash', 'sched-x')).status).toBe(403);
    expect((await complete(h, A, 'u-owner', 'GHOST', { evidenceRefs: ['x.jpg'] })).status).toBe(404);
    expect((await defineSched(h, A, 'u-owner', 'sched-bad', fire({ category: 'nonsense' }))).status).toBe(400);

    await h.seedOwner(B, 'u-owner-b');
    expect(((await overdue(h, B, 'u-owner-b', '2026-08-10')).body as Overdue).overdue).toEqual([]);
  });
});
