import { describe, it, expect } from 'vitest';
import {
  decideRevocation, TokenRevocationList, InMemoryTokenRevocationStore, revocationAwareAuthenticator,
  type TokenRevocation,
} from '../../services/identity/src/revocation';
import { LocalIdp } from '../support/local-idp';

// The token revocation list and the revocation-aware authenticator (GAP-SEC-05): pure decisions first, then the
// cache-over-store behaviour (a revocation recorded through the list bites at once; one recorded elsewhere lands
// within the refresh window), then the authenticator that refuses a revoked-but-valid token and says nothing.

const rev = (over: Partial<TokenRevocation>): TokenRevocation =>
  ({ id: 'r', tenantId: 't', reason: 'security', revokedBy: 'owner', revokedAt: '2026-09-29T10:00:00Z', ...over });

describe('decideRevocation — pure', () => {
  it('by jti: exactly that token, no other', () => {
    const rs = [rev({ id: 'r1', jti: 'j1' })];
    expect(decideRevocation(rs, { sub: 'u', jti: 'j1' }).revoked).toBe(true);
    expect(decideRevocation(rs, { sub: 'u', jti: 'j2' }).revoked).toBe(false);
    expect(decideRevocation(rs, { sub: 'u' }).revoked).toBe(false); // a token with no jti cannot match a jti revocation
  });

  it('by user + issuedBefore: tokens issued at or before the moment are out; newer ones stay; no iat → refused (fail closed)', () => {
    const rs = [rev({ id: 'r2', userId: 'u', issuedBefore: 1_000 })];
    expect(decideRevocation(rs, { sub: 'u', iat: 999 }).revoked).toBe(true);
    expect(decideRevocation(rs, { sub: 'u', iat: 1_000 }).revoked).toBe(true);
    expect(decideRevocation(rs, { sub: 'u', iat: 1_001 }).revoked).toBe(false);
    expect(decideRevocation(rs, { sub: 'u' }).revoked).toBe(true);
    expect(decideRevocation(rs, { sub: 'v', iat: 1 }).revoked).toBe(false);
    expect(decideRevocation(rs, { sub: 'u', iat: 1 }).because).toContain('every token of u');
  });
});

describe('TokenRevocationList — a cache over the store', () => {
  it('a revocation recorded THROUGH the list bites immediately; one recorded behind its back lands after the refresh window', async () => {
    let nowMs = 0;
    const store = new InMemoryTokenRevocationStore();
    const list = new TokenRevocationList(store, { refreshAfterMs: 1_000, now: () => nowMs });
    expect((await list.isRevoked('t', { sub: 'u', jti: 'j1' })).revoked).toBe(false); // cached: nothing

    await list.revoke('t', rev({ id: 'r1', jti: 'j1' }));
    expect((await list.isRevoked('t', { sub: 'u', jti: 'j1' })).revoked).toBe(true);

    store.record('t', rev({ id: 'r2', jti: 'j2' })); // another instance wrote this
    expect((await list.isRevoked('t', { sub: 'u', jti: 'j2' })).revoked).toBe(false); // not yet seen here
    nowMs += 1_001;
    expect((await list.isRevoked('t', { sub: 'u', jti: 'j2' })).revoked).toBe(true); // refreshed
  });

  it('is tenant-scoped', async () => {
    const list = new TokenRevocationList();
    await list.revoke('t1', rev({ id: 'r1', tenantId: 't1', jti: 'j' }));
    expect((await list.isRevoked('t1', { sub: 'u', jti: 'j' })).revoked).toBe(true);
    expect((await list.isRevoked('t2', { sub: 'u', jti: 'j' })).revoked).toBe(false);
  });
});

describe('revocationAwareAuthenticator', () => {
  const idp = new LocalIdp({ secret: ['revocation', 'auth', 'test', 'key'].join('-').padEnd(48, '0'), issuer: 'https://idp.test/', audience: 'sre-api' });

  it('a valid-but-revoked token yields NO principal, and the operator (not the caller) learns why', async () => {
    const list = new TokenRevocationList();
    const seen: string[] = [];
    const auth = revocationAwareAuthenticator(idp.policy(), list, (r) => seen.push(r));
    const token = idp.issue({ sub: 'u', tenantId: 't', jti: 'j-1' });
    expect(await auth(token)).toMatchObject({ tenantId: 't', userId: 'u' });
    await list.revoke('t', rev({ id: 'r', tenantId: 't', jti: 'j-1' }));
    expect(await auth(token)).toBeUndefined();
    expect(seen).toEqual(['revoked']);
  });

  it('still refuses a bad signature / expired token exactly as before, with the verifier’s reason', async () => {
    const seen: string[] = [];
    const auth = revocationAwareAuthenticator(idp.policy(), new TokenRevocationList(), (r) => seen.push(r));
    expect(await auth(idp.issue({ sub: 'u', tenantId: 't', ttlSeconds: -3600 }))).toBeUndefined(); // well past the 30s leeway
    expect(await auth('not.a.token')).toBeUndefined(); // three parts, but the header is not JSON
    expect(seen).toEqual(['expired', 'header_unreadable']);
  });
});
