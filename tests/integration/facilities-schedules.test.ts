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

const overdue = (h: ApiHarness, tenantId: string, userId: string, asOf: string) =>
  h.request({ method: 'GET', path: '/v1/facilities/overdue', userId, tenantId, query: { asOf } });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
interface Overdue { overdue: { taskId: string; level: string }[]; complianceRisks: number }
const levelOf = (r: Overdue, id: string) => r.overdue.find((o) => o.taskId === id)?.level;

describe('facilities schedules: a hollow tick is refused, a compliance miss escalates itself (M26-FR-03)', () => {
  it('refuses a completion with no evidence, no verifier, or a self-verified safety check', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await defineSched(h, A, 'u-owner', 'sched-fire');
    await raiseTask(h, A, 'u-owner', 'sched-fire', 't1', '2026-08-05');

    expect(codeOf(await complete(h, A, 'u-owner', 't1', { completedBy: 'u-cleaner' }, 'c-a'))).toBe('evidence_missing');
    expect(codeOf(await complete(h, A, 'u-owner', 't1', { completedBy: 'u-cleaner', evidenceRefs: ['photo.jpg'] }, 'c-b'))).toBe('not_verified');
    expect(codeOf(await complete(h, A, 'u-owner', 't1', { completedBy: 'u-cleaner', evidenceRefs: ['photo.jpg'], verifiedBy: 'u-cleaner' }, 'c-c'))).toBe('self_verified');
    // Evidence attached and a DIFFERENT person verified → accepted.
    const ok = await complete(h, A, 'u-owner', 't1', { completedBy: 'u-cleaner', evidenceRefs: ['photo.jpg'], verifiedBy: 'u-mgr' }, 'c-d');
    expect(ok.status).toBe(200);
    expect((ok.body as { accepted: boolean }).accepted).toBe(true);
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
    await complete(h, A, 'u-owner', 't1', { completedBy: 'u-cleaner', evidenceRefs: ['photo.jpg'], verifiedBy: 'u-mgr' });

    expect((await overdue(h, A, 'u-owner', '2026-08-10')).body as Overdue).toMatchObject({ overdue: [] });
  });

  it('is authorized and per-tenant, and refuses unknown/ malformed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // a cashier does not manage facilities
    await defineSched(h, A, 'u-owner', 'sched-fire');

    expect((await defineSched(h, A, 'u-cash', 'sched-x')).status).toBe(403);
    expect((await complete(h, A, 'u-owner', 'GHOST', { completedBy: 'u-cleaner' })).status).toBe(404);
    expect((await defineSched(h, A, 'u-owner', 'sched-bad', fire({ category: 'nonsense' }))).status).toBe(400);

    await h.seedOwner(B, 'u-owner-b');
    expect(((await overdue(h, B, 'u-owner-b', '2026-08-10')).body as Overdue).overdue).toEqual([]);
  });
});
