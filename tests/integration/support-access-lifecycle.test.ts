import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';

/**
 * **Durable support-access lifecycle — no perpetual back door, end to end (M33-FR-03 · SEC-11, API-11).**
 *
 * The engine already refuses everything that matters; this proves the LIFECYCLE around it through the real
 * pipeline: a support engineer files a request, the OWNER approves (a time-boxed session) or rejects, the
 * session records what it touched (refused once it is ended — expired access is revoked), and an admin can
 * read who has access now, review who had it, and end one early. The requester can never approve their own
 * (§28), the owner can never lengthen the window, and support may never hold a money scope.
 */

const TENANT = 't-sre';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const fileRequest = (h: ReturnType<typeof apiHarness>, u: string, requestId: string, key: string, over: Record<string, unknown> = {}) =>
  h.request({ method: 'POST', path: '/v1/platform/support-access/requests', userId: u, tenantId: TENANT, idempotencyKey: key,
    body: { requestId, requesterName: 'Vendor Eng', reason: 'investigate the failing settings pack build', scopes: ['config.read'], minutes: 60, ...over } });
const decide = (h: ReturnType<typeof apiHarness>, u: string, requestId: string, decision: string, key: string, over: Record<string, unknown> = {}) =>
  h.request({ method: 'POST', path: `/v1/platform/support-access/requests/${requestId}/decision`, userId: u, tenantId: TENANT, idempotencyKey: key, body: { decision, ...over } });
const act = (h: ReturnType<typeof apiHarness>, u: string, sessionId: string, action: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/platform/support-access/sessions/${sessionId}/actions`, userId: u, tenantId: TENANT, idempotencyKey: key, body: { action } });
const endSession = (h: ReturnType<typeof apiHarness>, u: string, sessionId: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/platform/support-access/sessions/${sessionId}/end`, userId: u, tenantId: TENANT, idempotencyKey: key });
const sessions = (h: ReturnType<typeof apiHarness>, u: string) =>
  h.request({ method: 'GET', path: '/v1/platform/support-access/sessions', userId: u, tenantId: TENANT });
const review = (h: ReturnType<typeof apiHarness>, u: string) =>
  h.request({ method: 'GET', path: '/v1/platform/support-access/review', userId: u, tenantId: TENANT });

// The requester and the approver must be different people (§28). u-owner approves; u-support requests.
async function cast(h: ReturnType<typeof apiHarness>): Promise<void> {
  await h.seedOwner(TENANT, 'u-owner');
  await h.provisionRole(TENANT, 'u-support', 'platform_admin');
}

describe('support-access lifecycle (M33-FR-03 · SEC-11)', () => {
  it('files a request, the owner approves it, the session records an action, and review shows who did what', async () => {
    const h = apiHarness();
    await cast(h);

    expect((await fileRequest(h, 'u-support', 'r1', 'q-1')).status).toBe(201);

    // Pending until the owner acts; no live session yet.
    const pending = await sessions(h, 'u-owner');
    expect((pending.body as { pending: unknown[] }).pending).toHaveLength(1);
    expect((pending.body as { activeCount: number }).activeCount).toBe(0);

    const decided = await decide(h, 'u-owner', 'r1', 'approved', 'd-1');
    expect(decided.status).toBe(200);
    expect((decided.body as { session: { expiresAt: string } }).session.expiresAt).toBeDefined(); // time-boxed

    // Now one session is active, and it can record what it touched.
    expect((await sessions(h, 'u-owner')).body).toMatchObject({ activeCount: 1 });
    expect((await act(h, 'u-support', 'r1', 'read the settings pack', 'a-1')).status).toBe(200);

    const rev = (await review(h, 'u-owner')).body as { review: { sessionId: string; approvedBy: string; actionCount: number; active: boolean }[] };
    expect(rev.review[0]).toMatchObject({ sessionId: 'r1', approvedBy: 'u-owner', actionCount: 1, active: true });
  });

  it('refuses the requester approving their own request (§28), even when they could otherwise approve', async () => {
    const h = apiHarness();
    await cast(h);
    // u-support holds platform.support.grant, so the ROUTE lets them in — but the ENGINE refuses a self-approval.
    await fileRequest(h, 'u-support', 'r1', 'q-1');
    const selfApprove = await decide(h, 'u-support', 'r1', 'approved', 'd-self');
    expect(selfApprove.status).toBe(422);
    expect(codeOf(selfApprove)).toBe('support_access_refused');

    // The request is untouched — a different approver (the owner) still can.
    expect((await decide(h, 'u-owner', 'r1', 'approved', 'd-1')).status).toBe(200);
  });

  it('refuses an approval that would lengthen the window, and a money-moving scope, before any session exists', async () => {
    const h = apiHarness();
    await cast(h);

    await fileRequest(h, 'u-support', 'r1', 'q-1', { minutes: 60 });
    const longer = await decide(h, 'u-owner', 'r1', 'approved', 'd-1', { grantedMinutes: 120 }); // > requested 60
    expect(longer.status).toBe(422);
    expect(codeOf(longer)).toBe('support_access_refused');

    // A forbidden scope is filed but never grantable — refused at the decision (the people who fix the
    // system do not approve its money).
    await fileRequest(h, 'u-support', 'r2', 'q-2', { scopes: ['config.read', 'refund.approve'] });
    const money = await decide(h, 'u-owner', 'r2', 'approved', 'd-2');
    expect(money.status).toBe(422);
    expect(codeOf(money)).toBe('support_access_refused');
  });

  it('ends a session early, and then an action is refused — expired/ended access is revoked (SEC-11)', async () => {
    const h = apiHarness();
    await cast(h);
    await fileRequest(h, 'u-support', 'r1', 'q-1');
    await decide(h, 'u-owner', 'r1', 'approved', 'd-1');

    expect((await endSession(h, 'u-owner', 'r1', 'e-1')).status).toBe(200);
    // The session now reads inactive, and it can no longer record work.
    const after = (await sessions(h, 'u-owner')).body as { sessions: { active: boolean }[]; activeCount: number };
    expect(after.activeCount).toBe(0);
    const late = await act(h, 'u-support', 'r1', 'sneak a look after revocation', 'a-late');
    expect(late.status).toBe(422);
    expect(codeOf(late)).toBe('support_access_refused');
  });

  it('rejects a request cleanly, and refuses deciding an unknown or already-decided request', async () => {
    const h = apiHarness();
    await cast(h);
    await fileRequest(h, 'u-support', 'r1', 'q-1');

    expect((await decide(h, 'u-owner', 'r1', 'rejected', 'd-1')).status).toBe(200);
    const again = await decide(h, 'u-owner', 'r1', 'approved', 'd-2');
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBe('support_request_already_decided');

    const ghost = await decide(h, 'u-owner', 'nope', 'approved', 'd-3');
    expect(ghost.status).toBe(404);
    expect(codeOf(ghost)).toBe('unknown_support_request');
  });

  it('keeps the record across a restart, and is default-deny for a user with no role', async () => {
    const h = apiHarness();
    await cast(h);
    await fileRequest(h, 'u-support', 'r1', 'q-1');
    await decide(h, 'u-owner', 'r1', 'approved', 'd-1');

    const restarted = apiHarness({ store: h.store });
    const rev = (await restarted.request({ method: 'GET', path: '/v1/platform/support-access/review', userId: 'u-owner', tenantId: TENANT })).body as { review: { sessionId: string }[] };
    expect(rev.review[0]?.sessionId).toBe('r1');

    // Nobody unauthorised gets in.
    expect((await fileRequest(h, 'u-nobody', 'r9', 'q-9')).status).toBe(403);
    expect((await sessions(h, 'u-nobody')).status).toBe(403);
    expect((await decide(h, 'u-nobody', 'r1', 'approved', 'd-9')).status).toBe(403);
  });
});
