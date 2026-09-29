import { describe, it, expect } from 'vitest';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { LocalIdp } from '../support/local-idp';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';

/**
 * **A token can be cut off before it expires (GAP-SEC-05 · SEC-03 · SEC-11 · OB-01).** Through the REAL pipeline:
 * an owner revokes ONE token by its id, or EVERY token of a user issued up to a moment; the very next request
 * with a revoked token is 401 (told nothing more), a token issued after the cut-off still works, another
 * tenant's identical token id is untouched, the revocation is an append-only fact that survives a restart, and
 * the auditor can read who cut whom off and why. A token with no issue time under a user-wide revocation is
 * refused — fail closed.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaf1';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbf1';
const OWNER = 'u-owner'; const CASHIER = 'u-cashier'; const STAFF = 'u-staff';

const me = (h: ApiHarness, token: string) => h.raw({ method: 'GET', path: '/v1/identity/me', token });
const revoke = (h: ApiHarness, tenantId: string, body: unknown, key: string, userId = OWNER) =>
  h.request({ method: 'POST', path: '/v1/identity/token-revocations', userId, tenantId, idempotencyKey: key, body });
const list = (h: ApiHarness, tenantId: string) =>
  h.request({ method: 'GET', path: '/v1/identity/token-revocations', userId: OWNER, tenantId });
const errorOf = (res: { body: unknown }) => (res.body as { error?: { code?: string } }).error;

/** An IdP whose clock is shifted, to mint a token "issued" earlier or later than now. */
const idpAt = (offsetMs: number) => new LocalIdp({ ...TEST_IDP.policy(), now: () => Date.now() + offsetMs });

describe('revoking ONE token by its id', () => {
  it('the revoked token is 401 on the very next request; a fresh token for the same user still works; the auditor sees the fact', async () => {
    const h = apiHarness();
    await h.seedOwner(A, OWNER);
    await h.provisionRole(A, STAFF, 'cashier');
    const stolen = h.idp.issue({ sub: STAFF, tenantId: A, jti: 'jti-stolen' });
    expect((await me(h, stolen)).status).toBe(200);

    const res = await revoke(h, A, { jti: 'jti-stolen', reason: 'security' }, 'r1');
    expect(res.status).toBe(201);
    expect((res.body as { revocation: { jti: string; revokedBy: string } }).revocation).toMatchObject({ jti: 'jti-stolen', revokedBy: OWNER });

    expect((await me(h, stolen)).status).toBe(401);
    const fresh = h.idp.issue({ sub: STAFF, tenantId: A, jti: 'jti-fresh' });
    expect((await me(h, fresh)).status).toBe(200);

    const seen = (await list(h, A)).body as { revocations: { jti?: string; reason: string }[] };
    expect(seen.revocations).toHaveLength(1);
    expect(seen.revocations[0]).toMatchObject({ jti: 'jti-stolen', reason: 'security' });
  });

  it('a revocation in one tenant never touches another tenant’s token with the same id (OB-01)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, OWNER); await h.seedOwner(B, OWNER);
    const inB = h.idp.issue({ sub: OWNER, tenantId: B, jti: 'jti-shared' });
    await revoke(h, A, { jti: 'jti-shared', reason: 'admin_revoked' }, 'r2');
    expect((await me(h, inB)).status).toBe(200);
    expect((await me(h, h.idp.issue({ sub: OWNER, tenantId: A, jti: 'jti-shared' }))).status).toBe(401);
  });
});

describe('revoking EVERY token of a user issued up to a moment (the leaver / sign-out-everywhere case)', () => {
  it('older tokens are refused, a token issued after the cut-off works, and one with no iat is refused — fail closed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, OWNER);
    await h.provisionRole(A, STAFF, 'cashier');
    const old = idpAt(-120_000).issue({ sub: STAFF, tenantId: A });          // issued two minutes ago
    const noIat = idpAt(-120_000).issue({ sub: STAFF, tenantId: A, iat: null }); // cannot say when
    expect((await me(h, old)).status).toBe(200);
    expect((await me(h, noIat)).status).toBe(200);

    const cutOff = new Date(Date.now() - 60_000).toISOString(); // everything issued up to a minute ago
    expect((await revoke(h, A, { userId: STAFF, issuedBefore: cutOff, reason: 'credential_change' }, 'r3')).status).toBe(201);

    expect((await me(h, old)).status).toBe(401);
    expect((await me(h, noIat)).status).toBe(401);
    expect((await me(h, h.idp.issue({ sub: STAFF, tenantId: A }))).status).toBe(200); // issued now → newer than the cut-off
    expect((await me(h, h.idp.issue({ sub: OWNER, tenantId: A }))).status).toBe(200); // another user untouched
  });

  it('defaults issuedBefore to NOW, so a plain { userId } signs the person out everywhere as of this moment', async () => {
    const h = apiHarness();
    await h.seedOwner(A, OWNER);
    await h.provisionRole(A, STAFF, 'cashier');
    const before = idpAt(-5_000).issue({ sub: STAFF, tenantId: A });
    expect((await revoke(h, A, { userId: STAFF, reason: 'signed_out' }, 'r4')).status).toBe(201);
    expect((await me(h, before)).status).toBe(401);
    expect((await me(h, idpAt(+5_000).issue({ sub: STAFF, tenantId: A }))).status).toBe(200);
  });
});

describe('the revocation is a durable, append-only fact', () => {
  it('survives a restart — a fresh surface over the same store still refuses the revoked token', async () => {
    const store = new InMemoryEventStore();
    const h1 = apiHarness({ store });
    await h1.seedOwner(A, OWNER);
    const token = h1.idp.issue({ sub: OWNER, tenantId: A, jti: 'jti-restart' });
    await revoke(h1, A, { jti: 'jti-restart', reason: 'security' }, 'r5');
    const h2 = apiHarness({ store }); // "restart"
    expect((await me(h2, token)).status).toBe(401);
    expect((await me(h2, h2.idp.issue({ sub: OWNER, tenantId: A, jti: 'jti-other' }))).status).toBe(200);
    expect(((await list(h2, A)).body as { revocations: unknown[] }).revocations).toHaveLength(1);
  });

  it('is idempotent: revoking the same token twice is one fact, not two', async () => {
    const h = apiHarness();
    await h.seedOwner(A, OWNER);
    await revoke(h, A, { jti: 'jti-twice', reason: 'security' }, 'r6');
    await revoke(h, A, { jti: 'jti-twice', reason: 'security' }, 'r7');
    expect(((await list(h, A)).body as { revocations: unknown[] }).revocations).toHaveLength(1);
  });
});

describe('who may revoke, and what a revocation must say', () => {
  it('needs exactly one target and a known reason; a cashier may not revoke', async () => {
    const h = apiHarness();
    await h.seedOwner(A, OWNER);
    await h.provisionRole(A, CASHIER, 'cashier');
    expect(errorOf(await revoke(h, A, { reason: 'security' }, 'v1'))?.code).toBe('revocation_needs_one_target');
    expect(errorOf(await revoke(h, A, { jti: 'x', userId: 'y', reason: 'security' }, 'v2'))?.code).toBe('revocation_needs_one_target');
    expect(errorOf(await revoke(h, A, { jti: 'x', reason: 'because' }, 'v3'))?.code).toBe('revocation_needs_reason');
    expect(errorOf(await revoke(h, A, { userId: 'y', issuedBefore: 'yesterday-ish', reason: 'security' }, 'v4'))?.code).toBe('revocation_issued_before_unreadable');
    expect((await revoke(h, A, { jti: 'x', reason: 'security' }, 'v5', CASHIER)).status).toBe(403);
    expect(((await list(h, A)).body as { revocations: unknown[] }).revocations).toHaveLength(0);
  });
});
