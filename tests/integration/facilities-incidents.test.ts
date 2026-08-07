import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Facilities incidents & the compliance evidence pack, end to end through the real API (M26-FR-04, API-11).
// An incident closed with no corrective action is an incident that will happen again, recorded as
// "handled" — so a close needs the action written down, evidence where the severity warrants it, and
// somebody other than the reporter signing it off (§28); a reportable incident cannot close until the
// statutory notification is on file, because closing it internally is exactly what makes everybody stop
// thinking about it (#6). And the evidence pack says PLAINLY whether it would survive an inspection:
// a pack that presents a 60%-complete record as "the evidence" is worse than no pack, so every gap is
// named. Proves the wired surface against the real pipeline and real RBAC.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const raise = (h: ApiHarness, tenantId: string, userId: string, id: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/facilities/incidents/${id}`, userId, tenantId, idempotencyKey: `in-${id}`, body });

const close = (h: ApiHarness, tenantId: string, userId: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/facilities/incidents/${id}/close`, userId, tenantId, idempotencyKey: key ?? `cl-${id}`, body });

const evidence = (h: ApiHarness, tenantId: string, userId: string, branchId: string, from: string, to: string) =>
  h.request({ method: 'GET', path: '/v1/facilities/evidence', userId, tenantId, query: { branchId, from, to } });

const defineSched = (h: ApiHarness, tenantId: string, userId: string, id: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/facilities/schedules/${id}`, userId, tenantId, idempotencyKey: `fs-${id}`, body });
const raiseTask = (h: ApiHarness, tenantId: string, userId: string, schedId: string, taskId: string, dueOn: string) =>
  h.request({ method: 'POST', path: `/v1/facilities/schedules/${schedId}/tasks/${taskId}`, userId, tenantId, idempotencyKey: `ft-${taskId}`, body: { dueOn } });
const complete = (h: ApiHarness, tenantId: string, userId: string, taskId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/facilities/tasks/${taskId}/complete`, userId, tenantId, idempotencyKey: `fc-${taskId}`, body });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const serious = (over: Record<string, unknown> = {}) => ({
  branchId: 'BR1', kind: 'injury', severity: 'serious', occurredAt: '2026-08-10T09:00:00Z', reportedAt: '2026-08-10T09:30:00Z',
  reportedBy: 'u-floor', description: 'A member of staff slipped on a wet aisle', evidenceRefs: ['photo.jpg'], ...over,
});
const fireSched = (over: Record<string, unknown> = {}) => ({
  branchId: 'BR1', title: 'Fire extinguisher check', category: 'fire_safety', frequency: 'monthly',
  assignedRole: 'facilities', escalatesTo: 'u-mgr', evidenceRequired: true, verificationRequired: true, ...over,
});
interface Pack { schedulesCovered: number; tasksDue: number; tasksEvidenced: number; tasksMissed: number; openIncidents: number; reportableIncidents: number; presentable: boolean; gaps: string[] }

describe('facilities incidents & evidence: a close needs an action, a pack must survive (M26-FR-04)', () => {
  it('refuses to close on no action, no evidence, a self-close, or an unreported reportable', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await raise(h, A, 'u-owner', 'inc-serious', serious());
    await raise(h, A, 'u-owner', 'inc-noevid', serious({ evidenceRefs: [] }));
    await raise(h, A, 'u-owner', 'inc-report', serious({ severity: 'reportable' }));
    await raise(h, A, 'u-owner', 'inc-minor', serious({ severity: 'minor', evidenceRefs: [] }));

    // No corrective action → refused as a business outcome, not just malformed.
    expect(codeOf(await close(h, A, 'u-owner', 'inc-serious', { closedBy: 'u-mgr', actionTaken: '' }, 'c1'))).toBe('no_action_recorded');
    // A serious incident cannot close on a description alone.
    expect(codeOf(await close(h, A, 'u-owner', 'inc-noevid', { closedBy: 'u-mgr', actionTaken: 'Dried the aisle and put out signage' }, 'c2'))).toBe('no_evidence');
    // The reporter cannot sign off their own serious incident (§28).
    expect(codeOf(await close(h, A, 'u-owner', 'inc-serious', { closedBy: 'u-floor', actionTaken: 'Dried the aisle' }, 'c3'))).toBe('self_closed');
    // A reportable incident cannot close with no statutory notification on file.
    expect(codeOf(await close(h, A, 'u-owner', 'inc-report', { closedBy: 'u-mgr', actionTaken: 'Evacuated and ventilated' }, 'c4'))).toBe('not_reported_to_authority');

    // A minor incident closes on an action alone, even by its own reporter.
    const minor = await close(h, A, 'u-owner', 'inc-minor', { closedBy: 'u-floor', actionTaken: 'Mopped it' }, 'c5');
    expect(minor.status).toBe(200);
    // The serious one closes properly: action + evidence + a different person.
    const ok = await close(h, A, 'u-owner', 'inc-serious', { closedBy: 'u-mgr', actionTaken: 'Non-slip matting laid; toolbox talk held' }, 'c6');
    expect(ok.status).toBe(200);
    expect((ok.body as { closed: boolean }).closed).toBe(true);
    // The reportable one closes once the authority notification is on file.
    const reported = await close(h, A, 'u-owner', 'inc-report', { closedBy: 'u-mgr', actionTaken: 'Evacuated and ventilated', authorityNotifiedOn: '2026-08-11' }, 'c7');
    expect(reported.status).toBe(200);
  });

  it('will not present a pack with a compliance gap, and names it — until the gap is closed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await defineSched(h, A, 'u-owner', 'sfire', fireSched());
    await raiseTask(h, A, 'u-owner', 'sfire', 'tfire', '2026-08-05');

    // The fire check is due and not done → a named, compliance-linked gap; the pack is NOT presentable.
    let p = (await evidence(h, A, 'u-owner', 'BR1', '2026-08-01', '2026-08-31')).body as Pack;
    expect(p.presentable).toBe(false);
    expect(p.tasksMissed).toBe(1);
    expect(p.gaps.some((g) => g.includes('Fire extinguisher check'))).toBe(true);

    // Do it properly (evidence + a second verifier) → the gap closes and the pack can be handed over.
    await complete(h, A, 'u-owner', 'tfire', { completedBy: 'u-cleaner', evidenceRefs: ['ext.jpg'], verifiedBy: 'u-mgr' });
    p = (await evidence(h, A, 'u-owner', 'BR1', '2026-08-01', '2026-08-31')).body as Pack;
    expect(p.presentable).toBe(true);
    expect(p.tasksEvidenced).toBe(1);
    expect(p.tasksMissed).toBe(0);
    expect(p.gaps).toEqual([]);

    // An open serious incident in the window makes the pack un-presentable again, and is named.
    await raise(h, A, 'u-owner', 'inc-open', serious());
    p = (await evidence(h, A, 'u-owner', 'BR1', '2026-08-01', '2026-08-31')).body as Pack;
    expect(p.presentable).toBe(false);
    expect(p.openIncidents).toBe(1);
    expect(p.gaps.some((g) => g.includes('serious injury still open'))).toBe(true);

    // Close it → the pack is presentable once more.
    await close(h, A, 'u-owner', 'inc-open', { closedBy: 'u-mgr', actionTaken: 'Non-slip matting laid' });
    p = (await evidence(h, A, 'u-owner', 'BR1', '2026-08-01', '2026-08-31')).body as Pack;
    expect(p.presentable).toBe(true);
    expect(p.openIncidents).toBe(0);
  });

  it('is authorized and per-tenant, and refuses unknown/malformed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // a cashier does not record facilities incidents
    await raise(h, A, 'u-owner', 'inc-1', serious());

    expect((await raise(h, A, 'u-cash', 'inc-x', serious())).status).toBe(403);
    expect((await close(h, A, 'u-owner', 'GHOST', { closedBy: 'u-mgr', actionTaken: 'x' })).status).toBe(404);
    expect((await raise(h, A, 'u-owner', 'inc-bad', serious({ severity: 'catastrophic' }))).status).toBe(400);

    await h.seedOwner(B, 'u-owner-b');
    const other = (await evidence(h, B, 'u-owner-b', 'BR1', '2026-08-01', '2026-08-31')).body as Pack;
    expect(other.tasksDue).toBe(0);
    expect(other.openIncidents).toBe(0);
    expect(other.presentable).toBe(true);
  });
});
