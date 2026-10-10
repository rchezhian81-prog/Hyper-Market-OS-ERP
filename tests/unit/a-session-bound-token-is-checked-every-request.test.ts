import { describe, it, expect } from 'vitest';
import {
  buildRouter, handle, MemoryIdempotencyStore, type HttpRequest, type Principal, type Route, type ChannelGuard,
} from '../../services/kernel/src/index';
import { AccessControl } from '../../packages/rbac/src/rbac';
import { sessionChannelGuard } from '../../services/platform/src/session-channel';
import type { SupportAccessRecord, SupportAccessEvent } from '../../services/platform/src/support-access-lifecycle';
import { verifyToken } from '../../services/identity/src/token';
import { LocalIdp } from '../support/local-idp';

/**
 * **A session-bound token is checked on every request, fail-closed (PA-10 · M33-FR-02/03).** The kernel half: a token
 * that names a support/remote session is refused when no guard is wired (never let through unchecked), asks the guard
 * on EVERY request (not once), and a guard refusal stops the request before the role check and the handler. The guard
 * half: the role check still runs after it, so a grant narrows and never widens; an expired session is ended at its
 * expiry moment and its token revoked. The token half: the claims are read off the SIGNED token, and one naming two
 * sessions is not believed.
 */

const route: Route = { api: 'API-11', method: 'GET', path: '/v1/x', permission: 'x.read', handler: () => ({ status: 200, body: { ran: true } }) };
const ACCESS = new AccessControl(
  [{ id: 'eng', name: 'Engineer', permissions: ['x.read'] }],
  [{ userId: 'u-eng', roleId: 'eng', branchScope: 'all' }],
);
const BOUND: Principal = { tenantId: 't', userId: 'u-eng', branchId: null, tokenId: 'jti-1', channel: { kind: 'support', sessionId: 'sr-1' } };
const PLAIN: Principal = { tenantId: 't', userId: 'u-eng', branchId: null };

function kernel(principal: Principal, channels?: ChannelGuard) {
  const built = buildRouter([route]);
  if (!built.ok) throw new Error('router');
  return () => handle({
    router: built.router!, authenticate: () => principal, access: ACCESS,
    idempotency: new MemoryIdempotencyStore(), newTraceId: () => 'trace',
    ...(channels === undefined ? {} : { channels }),
  }, { method: 'GET', path: '/v1/x', headers: { authorization: 'Bearer t' } } as HttpRequest);
}
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

describe('the kernel checks a session-bound token on every request', () => {
  it('refuses a bound token when no guard is wired — fail-closed, the handler never runs', async () => {
    const res = await kernel(BOUND)();
    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe('session_channel_unchecked');
  });

  it('asks the guard on every request, and its refusal stops the request', async () => {
    let calls = 0;
    let live = true;
    const send = kernel(BOUND, () => { calls += 1; return live ? { ok: true } : { ok: false, code: 'session_channel_not_active', why: 'ended' }; });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    live = false;
    const refused = await send();
    expect(refused.status).toBe(403);
    expect(codeOf(refused)).toBe('session_channel_not_active');
    expect(calls).toBe(3);
  });

  it('never asks the guard about a token bound to nothing', async () => {
    let calls = 0;
    expect((await kernel(PLAIN, () => { calls += 1; return { ok: false }; })()).status).toBe(200);
    expect(calls).toBe(0);
  });

  it('a guard yes does not widen: the role check still refuses a permission the person does not hold', async () => {
    const built = buildRouter([{ ...route, permission: 'y.write.not.held', method: 'GET', path: '/v1/y' }]);
    const res = await handle({
      router: built.router!, authenticate: () => BOUND, access: ACCESS, idempotency: new MemoryIdempotencyStore(),
      newTraceId: () => 'trace', channels: () => ({ ok: true }),
    }, { method: 'GET', path: '/v1/y', headers: { authorization: 'Bearer t' } } as HttpRequest);
    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe('forbidden');
  });
});

describe('the session guard', () => {
  const record = (over: Partial<NonNullable<SupportAccessRecord['session']>> = {}): SupportAccessRecord => ({
    requestId: 'sr-1', status: 'approved',
    request: { requestId: 'sr-1', requesterId: 'u-eng', requesterName: 'Eng', reason: 'trace the stuck heartbeat on till 3', scopes: ['x.read'], tenantId: 't', minutes: 30, at: '2026-10-10T10:00:00Z' },
    decidedBy: 'u-owner',
    session: { sessionId: 'sr-1', requesterId: 'u-eng', requesterName: 'Eng', approvedBy: 'u-owner', reason: 'trace the stuck heartbeat on till 3', scopes: ['x.read'], tenantId: 't', startedAt: '2026-10-10T10:00:00Z', expiresAt: '2026-10-10T10:30:00Z', actions: [], ...over },
  });

  it('ends an expired session at its expiry moment and revokes the token; refuses a permission outside the grant', async () => {
    const recorded: SupportAccessEvent[] = [];
    const revoked: string[] = [];
    let now = '2026-10-10T10:10:00Z';
    const guard = sessionChannelGuard({
      supportRecords: () => [record()], recordSupportEvent: (_t, e) => { recorded.push(e); },
      remoteSessions: () => [], revokeToken: (r) => { revoked.push(r.tokenId); }, now: () => now,
    });
    expect(await guard(BOUND, 'x.read')).toEqual({ ok: true });
    expect((await guard(BOUND, 'z.read')).code).toBe('outside_session_grant');
    expect((await guard(BOUND, 'platform.support.request')).ok).toBe(true); // recording what the session did
    now = '2026-10-10T10:31:00Z';
    const late = await guard(BOUND, 'x.read');
    expect(late.code).toBe('session_channel_not_active');
    expect(recorded).toEqual([{ kind: 'ended', sessionId: 'sr-1', at: '2026-10-10T10:30:00Z' }]);
    expect(revoked).toEqual(['jti-1']);
  });
});

describe('the token carries the session it was issued for', () => {
  const idp = new LocalIdp({ secret: ['session', 'channel', 'unit', 'key'].join('-').padEnd(40, '0'), issuer: 'https://idp.test', audience: 'sre' });
  it('reads the support or remote session off the signed token, and refuses a token naming both', () => {
    const v1 = verifyToken(idp.issue({ sub: 'u-eng', tenantId: 't', supportSessionId: 'sr-1', jti: 'j1' }), idp.policy(), Date.now());
    expect(v1.principal?.channel).toEqual({ kind: 'support', sessionId: 'sr-1' });
    expect(v1.principal?.tokenId).toBe('j1');
    const v2 = verifyToken(idp.issue({ sub: 'u-eng', tenantId: 't', remoteSessionId: 'rs-1' }), idp.policy(), Date.now());
    expect(v2.principal?.channel).toEqual({ kind: 'remote', sessionId: 'rs-1' });
    const both = verifyToken(idp.issue({ sub: 'u-eng', tenantId: 't', supportSessionId: 'sr-1', remoteSessionId: 'rs-1' }), idp.policy(), Date.now());
    expect(both.ok).toBe(false);
    expect(both.refusedBecause).toBe('channel_ambiguous');
  });
});
