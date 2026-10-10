import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { apiHarness, TEST_IDP } from '../support/api-harness';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';

/**
 * **A support or remote session binds the sign-in that uses it (PA-10 · M33-FR-02/03 · SEC-11).**
 *
 * The registers already recorded who was given access, for what, until when, and who cut a session off. This
 * proves the sign-in now OBEYS them, on every request, through the real pipeline and the real token verifier:
 *
 *   • a token issued for a support session reaches only the scopes the owner granted, only for that engineer;
 *   • a token HELD OPEN after the owner ends the session is refused on its very next request, and then revoked
 *     everywhere (the identity ledger's own revocation list), even though it has not reached its own expiry;
 *   • a support session that runs past its time box is refused, ended in the register at its expiry moment, and
 *     its token revoked — nobody has to remember to do it;
 *   • a token held open on a remote session that an administrator terminates is refused the same way;
 *   • an unknown session, someone else's session, and a token naming two sessions are all refused.
 *
 * Run twice: in memory, and on real PostgreSQL (the ledger, the idempotency store and the revocation list all
 * durable) when DATABASE_URL is set.
 */

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

type H = ReturnType<typeof apiHarness>;

function scenarios(make: () => Promise<{ h: H; advance: (minutes: number) => void; TENANT: string }>): void {
  let TENANT = '';
  const file = (h: H, requestId: string, scopes: readonly string[], minutes: number) =>
    h.request({ method: 'POST', path: '/v1/platform/support-access/requests', userId: 'u-eng', tenantId: TENANT, idempotencyKey: `file-${requestId}`,
      body: { requestId, requesterName: 'Vendor Engineer', reason: 'trace the stuck device heartbeat on till 3', scopes, minutes } });
  const approve = (h: H, requestId: string) =>
    h.request({ method: 'POST', path: `/v1/platform/support-access/requests/${requestId}/decision`, userId: 'u-owner', tenantId: TENANT, idempotencyKey: `approve-${requestId}`, body: { decision: 'approved' } });
  const get = (h: H, path: string, token: string) => h.raw({ method: 'GET', path, token });

  it('a support token reaches only the granted scopes, only for its engineer, and a token held open after the owner ends it is refused', async () => {
    const { h, TENANT: t } = await make();
    TENANT = t;
    expect((await file(h, 'sr-1', ['platform.health.read'], 60)).status).toBe(201);
    expect((await approve(h, 'sr-1')).status).toBe(200);

    const held = TEST_IDP.issue({ sub: 'u-eng', tenantId: TENANT, supportSessionId: 'sr-1' });
    // Inside the grant: the remote-session register is a platform.health.read route.
    expect((await get(h, '/v1/platform/remote-sessions', held)).status).toBe(200);
    // The engineer's ROLE holds platform.flag.read, but the owner did not grant it to this session.
    const outside = await get(h, '/v1/platform/flags', held);
    expect(outside.status).toBe(403);
    expect(codeOf(outside)).toBe('outside_session_grant');
    // The session's own record of what it did is always reachable while it is live.
    const acted = await h.raw({ method: 'POST', path: '/v1/platform/support-access/sessions/sr-1/actions', token: held, idempotencyKey: 'act-1', body: { action: 'read the device heartbeat register' } });
    expect(acted.status).toBe(200);

    // Someone else presenting the same session is refused, though they hold the permission themselves.
    const borrowed = TEST_IDP.issue({ sub: 'u-owner', tenantId: TENANT, supportSessionId: 'sr-1' });
    const notYours = await get(h, '/v1/platform/remote-sessions', borrowed);
    expect(notYours.status).toBe(403);
    expect(codeOf(notYours)).toBe('session_channel_not_yours');

    // The owner ends the session early. The engineer's token is still signed and unexpired, and is HELD OPEN…
    expect((await h.request({ method: 'POST', path: '/v1/platform/support-access/sessions/sr-1/end', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'end-sr-1' })).status).toBe(200);
    // …and its very next request is refused, with the reason.
    const afterEnd = await get(h, '/v1/platform/remote-sessions', held);
    expect(afterEnd.status).toBe(403);
    expect(codeOf(afterEnd)).toBe('session_channel_not_active');
    // The refusal also revoked the token itself in the identity ledger: it is now dead for everything.
    expect((await get(h, '/v1/platform/remote-sessions', held)).status).toBe(401);
    expect((await get(h, '/v1/platform/flags', held)).status).toBe(401);
  });

  it('a support session past its time box is refused, ended in the register at its expiry, and its token revoked', async () => {
    const { h, advance, TENANT: t } = await make();
    TENANT = t;
    expect((await file(h, 'sr-2', ['platform.health.read'], 5)).status).toBe(201);
    const approved = await approve(h, 'sr-2');
    expect(approved.status).toBe(200);
    const expiresAt = (approved.body as { session: { expiresAt: string } }).session.expiresAt;

    const held = TEST_IDP.issue({ sub: 'u-eng', tenantId: TENANT, supportSessionId: 'sr-2' });
    expect((await get(h, '/v1/platform/remote-sessions', held)).status).toBe(200);

    advance(6); // past the five-minute window; the token itself is still good for an hour
    const expired = await get(h, '/v1/platform/remote-sessions', held);
    expect(expired.status).toBe(403);
    expect(codeOf(expired)).toBe('session_channel_not_active');

    // The register now records the end — at the expiry moment, not whenever somebody noticed.
    const read = await h.request({ method: 'GET', path: '/v1/platform/support-access/sessions', userId: 'u-owner', tenantId: TENANT });
    // (Only the guard's clock is moved forward in this test, so the register's own "active now" — read off the
    // surface's wall clock — is not asserted here; the recorded end is the fact under test.)
    const sr2 = (read.body as { sessions: { sessionId: string; endedAt?: string }[] }).sessions.find((s) => s.sessionId === 'sr-2');
    expect(sr2?.endedAt).toBe(expiresAt);
    expect((await get(h, '/v1/platform/remote-sessions', held)).status).toBe(401);
  });

  it('a token held open on a remote session is refused once an administrator terminates it', async () => {
    const { h, TENANT: t } = await make();
    TENANT = t;
    expect((await h.request({ method: 'POST', path: '/v1/platform/remote-sessions', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'open-rs-1',
      body: { sessionId: 'rs-1', deviceId: 'till-3', userId: 'u-eng', kind: 'remote_desktop' } })).status).toBe(201);

    const held = TEST_IDP.issue({ sub: 'u-eng', tenantId: TENANT, remoteSessionId: 'rs-1' });
    expect((await get(h, '/v1/platform/flags', held)).status).toBe(200);
    const borrowed = TEST_IDP.issue({ sub: 'u-owner', tenantId: TENANT, remoteSessionId: 'rs-1' });
    expect(codeOf(await get(h, '/v1/platform/flags', borrowed))).toBe('session_channel_not_yours');

    expect((await h.request({ method: 'POST', path: '/v1/platform/remote-sessions/rs-1/terminate', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'term-rs-1',
      body: { reason: 'work finished; closing the connection' } })).status).toBe(200);
    const afterTerminate = await get(h, '/v1/platform/flags', held);
    expect(afterTerminate.status).toBe(403);
    expect(codeOf(afterTerminate)).toBe('session_channel_not_active');
    expect((await get(h, '/v1/platform/flags', held)).status).toBe(401);
  });

  it('a token naming an unknown session is refused, and one naming two sessions is not believed at all', async () => {
    const { h, TENANT: t } = await make();
    TENANT = t;
    const unknown = TEST_IDP.issue({ sub: 'u-eng', tenantId: TENANT, supportSessionId: 'sr-none' });
    expect(codeOf(await get(h, '/v1/platform/remote-sessions', unknown))).toBe('unknown_session_channel');
    const unknownRemote = TEST_IDP.issue({ sub: 'u-eng', tenantId: TENANT, remoteSessionId: 'rs-none' });
    expect(codeOf(await get(h, '/v1/platform/remote-sessions', unknownRemote))).toBe('unknown_session_channel');
    const both = TEST_IDP.issue({ sub: 'u-eng', tenantId: TENANT, supportSessionId: 'sr-none', remoteSessionId: 'rs-none' });
    expect((await get(h, '/v1/platform/remote-sessions', both)).status).toBe(401);
  });
}

function clock(): { now: () => string; advance: (minutes: number) => void } {
  let offsetMs = 0;
  return { now: () => new Date(Date.now() + offsetMs).toISOString(), advance: (m) => { offsetMs += m * 60_000; } };
}

async function cast(h: H, tenant: string): Promise<void> {
  await h.seedOwner(tenant, 'u-owner');
  await h.provisionRole(tenant, 'u-eng', 'platform_admin');
}

describe('support and remote sessions bind the sign-in (PA-10) — in memory', () => {
  scenarios(async () => {
    const c = clock();
    const h = apiHarness({ now: c.now });
    await cast(h, 't-sre');
    return { h, advance: c.advance, TENANT: 't-sre' };
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];

describe.skipIf(!DATABASE_URL)('support and remote sessions bind the sign-in (PA-10) — real PostgreSQL', () => {
  let pool: Pool;
  let run = 0;
  const stamp = Date.now().toString(16).slice(-7);
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
  });
  afterAll(async () => { await pool.end(); });

  scenarios(async () => {
    run += 1;
    // A fresh tenant per scenario, so a re-run on a reused database starts clean.
    const tenant = `d${stamp}-dddd-4ddd-8ddd-${String(run).padStart(12, '0')}`;
    const c = clock();
    const sql = pgPoolClient(pool);
    const h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql), now: c.now });
    await cast(h, tenant);
    return { h, advance: c.advance, TENANT: tenant };
  });
});
