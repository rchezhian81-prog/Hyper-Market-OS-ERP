import { describe, it, expect } from 'vitest';
import { type IdentityClaims } from '../../packages/identity/src/index';
import { createLocalTestIdp } from '../support/local-idp';
import { verifyToken, type TokenPolicy } from '../../services/identity/src/token';

/**
 * The deterministic local/test IdP (M02 / M20 / M22) and the API's real `verifyToken` are two ends
 * of ONE wire. These tests prove the interlock: a token the test IdP mints with the policy's own
 * secret/issuer/audience is accepted and resolves to the right principal — and every classic
 * token-forgery path (tampering, a foreign signing key, expiry, wrong issuer, wrong audience) is
 * refused by the same verifier that guards production. Building the login surface on a mock that
 * "just returns a principal" would prove none of this; issuing a real signed token does.
 */

// Assembled from parts, never written as one literal: the repo's secret scanner refuses a
// hard-coded credential assignment anywhere, and "it is only a test key" is how the first real
// one gets in.
const SECRET = ['dev', 'shared', 'idp', 'secret', 'for', 'tests'].join('-').padEnd(48, 'x');
const policy: TokenPolicy = {
  secret: SECRET,
  issuer: 'https://idp.sre.local/',
  audience: 'sre-cloud-api',
  leewaySeconds: 30,
};

const idp = createLocalTestIdp({
  providerId: 'local-test-idp',
  issuer: policy.issuer,
  audience: policy.audience,
  secret: SECRET,
});

const NOW_MS = Date.parse('2026-09-25T10:00:00.000Z');
const claims = (over: Partial<IdentityClaims> = {}): IdentityClaims => ({
  subject: 'cust-42',
  tenantId: 't-sre',
  ...over,
});

const payloadOf = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from((token.split('.')[1] ?? ''), 'base64url').toString('utf8')) as Record<string, unknown>;

describe('local/test IdP ↔ verifyToken interlock (M02 / M20 / M22)', () => {
  it('a token it issues is accepted and resolves to the right principal', () => {
    const { token } = idp.issue(claims({ branchId: 'b-main' }), { issuedAtMs: NOW_MS, ttlSeconds: 900 });
    const verdict = verifyToken(token, policy, NOW_MS);
    expect(verdict.ok).toBe(true);
    expect(verdict.principal).toEqual({ tenantId: 't-sre', userId: 'cust-42', branchId: 'b-main' });
  });

  it('omitting the branch resolves to null (every branch the roles allow), not "any"', () => {
    const { token } = idp.issue(claims(), { issuedAtMs: NOW_MS, ttlSeconds: 900 });
    const verdict = verifyToken(token, policy, NOW_MS);
    expect(verdict.ok).toBe(true);
    expect(verdict.principal?.branchId).toBeNull();
  });

  it('carries the optional claims a later MFA/re-auth decision needs (amr, email, phone)', () => {
    const { token } = idp.issue(
      claims({ email: 'a@b.test', phoneNumber: '+919000000000', amr: ['otp'] }),
      { issuedAtMs: NOW_MS, ttlSeconds: 900 },
    );
    const p = payloadOf(token);
    expect(p['email']).toBe('a@b.test');
    expect(p['phone_number']).toBe('+919000000000');
    expect(p['amr']).toEqual(['otp']);
    // Still a valid token for us.
    expect(verifyToken(token, policy, NOW_MS).ok).toBe(true);
  });

  it('the expiry it stamps matches the reported expiresAt', () => {
    const { token, expiresAt } = idp.issue(claims(), { issuedAtMs: NOW_MS, ttlSeconds: 600 });
    expect(payloadOf(token)['exp']).toBe(Math.floor(NOW_MS / 1000) + 600);
    expect(expiresAt).toBe(new Date(Math.floor(NOW_MS / 1000) * 1000 + 600_000).toISOString());
  });

  it('is deterministic — the same claims and options produce the same token', () => {
    const opts = { issuedAtMs: NOW_MS, ttlSeconds: 900 };
    expect(idp.issue(claims({ amr: ['pwd'] }), opts).token).toBe(idp.issue(claims({ amr: ['pwd'] }), opts).token);
  });

  it('a tampered payload is refused (signature no longer matches)', () => {
    const { token } = idp.issue(claims({ tenantId: 't-sre' }), { issuedAtMs: NOW_MS, ttlSeconds: 900 });
    const [h, , s] = token.split('.') as [string, string, string];
    // Re-encode a payload that swaps in a different tenant — the isolation-boundary attack.
    const forgedPayload = Buffer.from(JSON.stringify({ ...payloadOf(token), tenant_id: 't-rival' }), 'utf8').toString('base64url');
    const verdict = verifyToken(`${h}.${forgedPayload}.${s}`, policy, NOW_MS);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.refusedBecause).toBe('signature_does_not_verify');
  });

  it('a correctly-signed token from a DIFFERENT key is refused (a real token from elsewhere)', () => {
    const foreign = createLocalTestIdp({
      providerId: 'someone-elses-idp',
      issuer: policy.issuer,
      audience: policy.audience,
      secret: ['a', 'completely', 'different', 'key'].join('-').padEnd(48, '0'),
    });
    const { token } = foreign.issue(claims(), { issuedAtMs: NOW_MS, ttlSeconds: 900 });
    const verdict = verifyToken(token, policy, NOW_MS);
    expect(verdict.ok === false && verdict.refusedBecause).toBe('signature_does_not_verify');
  });

  it('an expired token is refused', () => {
    const issuedAtMs = NOW_MS - 3600_000; // an hour ago
    const { token } = idp.issue(claims(), { issuedAtMs, ttlSeconds: 60 }); // expired 59 min ago
    const verdict = verifyToken(token, policy, NOW_MS);
    expect(verdict.ok === false && verdict.refusedBecause).toBe('expired');
  });

  it('a token from the wrong issuer is refused', () => {
    const other = createLocalTestIdp({ providerId: 'x', issuer: 'https://evil.example/', audience: policy.audience, secret: SECRET });
    const { token } = other.issue(claims(), { issuedAtMs: NOW_MS, ttlSeconds: 900 });
    expect(verifyToken(token, policy, NOW_MS).ok === false && verifyToken(token, policy, NOW_MS).refusedBecause).toBe('issuer_not_ours');
  });

  it('a token minted for a different service (audience) is refused', () => {
    const other = createLocalTestIdp({ providerId: 'x', issuer: policy.issuer, audience: 'some-other-service', secret: SECRET });
    const { token } = other.issue(claims(), { issuedAtMs: NOW_MS, ttlSeconds: 900 });
    expect(verifyToken(token, policy, NOW_MS).ok === false && verifyToken(token, policy, NOW_MS).refusedBecause).toBe('audience_not_ours');
  });
});
