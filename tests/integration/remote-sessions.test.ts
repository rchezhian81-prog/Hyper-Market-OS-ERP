import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';

/**
 * **Control of remote sessions — see and cut off a live remote session, end to end (M33-FR-02, API-11).**
 *
 * A live remote/terminal session is registered, kept visible (a heartbeat advances last-seen), and an
 * administrator can END it with a named reason — no session stays open, unseen, after the work is done, and
 * none ends silently. Durable + append-only; open/heartbeat/terminate gated platform.device.manage, reads
 * platform.health.read.
 */

const TENANT = 't-sre';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const open = (h: ReturnType<typeof apiHarness>, u: string, id: string, key: string, over: Record<string, unknown> = {}) =>
  h.request({ method: 'POST', path: '/v1/platform/remote-sessions', userId: u, tenantId: TENANT, idempotencyKey: key,
    body: { sessionId: id, deviceId: 'till-3', userId: 'u-eng', kind: 'support', ...over } });
const heartbeat = (h: ReturnType<typeof apiHarness>, u: string, id: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/platform/remote-sessions/${id}/heartbeat`, userId: u, tenantId: TENANT, idempotencyKey: key });
const terminate = (h: ReturnType<typeof apiHarness>, u: string, id: string, key: string, reason: unknown = 'work finished') =>
  h.request({ method: 'POST', path: `/v1/platform/remote-sessions/${id}/terminate`, userId: u, tenantId: TENANT, idempotencyKey: key, body: reason === undefined ? {} : { reason } });
const list = (h: ReturnType<typeof apiHarness>, u: string) =>
  h.request({ method: 'GET', path: '/v1/platform/remote-sessions', userId: u, tenantId: TENANT });
const read = (h: ReturnType<typeof apiHarness>, u: string, id: string) =>
  h.request({ method: 'GET', path: `/v1/platform/remote-sessions/${id}`, userId: u, tenantId: TENANT });

describe('control remote sessions (M33-FR-02)', () => {
  it('opens a session, keeps it visible, and an admin cuts it off with a reason', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');

    expect((await open(h, 'u-owner', 'rs1', 'o-1')).status).toBe(201);
    expect((await read(h, 'u-owner', 'rs1')).body).toMatchObject({ session: { status: 'active', active: true } });
    expect((await list(h, 'u-owner')).body).toMatchObject({ active: 1 });

    expect((await heartbeat(h, 'u-owner', 'rs1', 'h-1')).status).toBe(200);

    // Cut it off — with a reason, recorded.
    expect((await terminate(h, 'u-owner', 'rs1', 't-1', 'work finished, cutting the session')).status).toBe(200);
    const ended = (await read(h, 'u-owner', 'rs1')).body as { session: { status: string; terminatedBy: string; terminatedReason: string; active: boolean } };
    expect(ended.session).toMatchObject({ status: 'terminated', terminatedBy: 'u-owner', terminatedReason: 'work finished, cutting the session', active: false });
    expect((await list(h, 'u-owner')).body).toMatchObject({ active: 0 });
  });

  it('lists active sessions first', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await open(h, 'u-owner', 'gone', 'o-1');
    await terminate(h, 'u-owner', 'gone', 't-1', 'closed');
    await open(h, 'u-owner', 'live', 'o-2');

    const body = (await list(h, 'u-owner')).body as { sessions: { sessionId: string; active: boolean }[]; active: number };
    expect(body.active).toBe(1);
    expect(body.sessions[0]).toMatchObject({ sessionId: 'live', active: true }); // active first
  });

  it('refuses a second open of a live id, a termination without a reason, and acting on an unknown session', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await open(h, 'u-owner', 'rs1', 'o-1');

    const dup = await open(h, 'u-owner', 'rs1', 'o-2');
    expect(dup.status).toBe(409);
    expect(codeOf(dup)).toBe('remote_session_already_open');

    const noReason = await h.request({ method: 'POST', path: '/v1/platform/remote-sessions/rs1/terminate', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 't-noreason', body: {} });
    expect(noReason.status).toBe(400);
    expect(codeOf(noReason)).toBe('termination_reason_required');

    expect((await terminate(h, 'u-owner', 'ghost', 't-ghost')).status).toBe(404);
    expect((await heartbeat(h, 'u-owner', 'ghost', 'h-ghost')).status).toBe(404);

    // Ending an already-ended session is refused.
    await terminate(h, 'u-owner', 'rs1', 't-1', 'done');
    const again = await terminate(h, 'u-owner', 'rs1', 't-2', 'again');
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBe('remote_session_already_ended');
  });

  it('a platform administrator may run the whole loop; a user with no role is refused', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await h.provisionRole(TENANT, 'u-admin', 'platform_admin');

    expect((await open(h, 'u-admin', 'rs1', 'o-1')).status).toBe(201);
    expect((await terminate(h, 'u-admin', 'rs1', 't-1', 'done')).status).toBe(200);
    expect((await list(h, 'u-admin')).status).toBe(200);

    expect((await open(h, 'u-nobody', 'rs9', 'o-9')).status).toBe(403);
    expect((await list(h, 'u-nobody')).status).toBe(403);
  });
});
