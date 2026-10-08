import { describe, it, expect } from 'vitest';
import { createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { verifyToken, type TokenPolicy } from '../../services/identity/src/token';
import { jwksKeyring, signingKeysOf } from '../../services/identity/src/jwks';
import { revocationAwareAuthenticator, TokenRevocationList } from '../../services/identity/src/revocation';

/**
 * **Head office believes the self-hosted identity server's sign-ins — and nothing that only looks like one
 * (OB-15 · ADR-0019 · M02-FR-01 · SEC-02 · hard rule #4).**
 *
 * Keycloak signs each sign-in (RS256) with a private key it never shares and publishes the public keys. Head office holds
 * only those public keys, so it can check a sign-in and can sign none. These prove the check against the attacks token
 * checks are known for: the algorithm switched (to `none`, or to HS256 signed with the public key), a key id that is not
 * the server's, a key carried inside the token, a changed payload, another issuer, another audience, an expired or
 * over-long token — and that a rotated key is picked up, while made-up key ids cannot make it fetch over and over.
 * Every key here is generated at run time; no key is written in the repository.
 */

const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const ISSUER = 'https://store.example.test/auth/realms/sre-store';
const AUDIENCE = 'sre-retail-os-api';
const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');

const pair = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
const server = pair();
const intruder = pair();
const jwkOf = (key: KeyObject, kid: string) => ({ ...key.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' });

/** A token signed the way the identity server signs (test-only: production code never signs). */
function signed(payload: Record<string, unknown>, opts: { kid?: string; key?: KeyObject; header?: Record<string, unknown> } = {}): string {
  const header = b64({ alg: 'RS256', typ: 'JWT', kid: opts.kid ?? 'k1', ...opts.header });
  const body = b64(payload);
  const sig = sign('RSA-SHA256', Buffer.from(`${header}.${body}`), opts.key ?? server.privateKey).toString('base64url');
  return `${header}.${body}.${sig}`;
}
const claims = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER, aud: [AUDIENCE, 'account'], sub: 'kc-5b2f-uuid', sre_user_id: 'u-owner', tenant_id: 'tenant-a',
  iat: NOW / 1000 - 60, exp: NOW / 1000 + 300, auth_time: NOW / 1000 - 60, amr: ['pwd', 'otp'], ...over,
});
const keys = new Map<string, KeyObject>([['k1', server.publicKey]]);
const policy: TokenPolicy = {
  algorithm: 'RS256', secret: '', keyring: { get: (kid) => keys.get(kid) }, subjectClaim: 'sre_user_id',
  issuer: ISSUER, audience: AUDIENCE, maxLifetimeSeconds: 3600,
};

describe('an identity-server sign-in is checked against its own published public keys', () => {
  it('a genuine sign-in names the PRODUCT person (sre_user_id), the tenant from the signed claims, and how they proved it', () => {
    const v = verifyToken(signed(claims()), policy, NOW);
    expect(v.ok).toBe(true);
    expect(v.principal).toMatchObject({ tenantId: 'tenant-a', userId: 'u-owner', amr: ['pwd', 'otp'] });
  });

  it('refuses the algorithm switched: "none", or HS256 signed with the public key as the secret', () => {
    const [, body] = signed(claims()).split('.');
    expect(verifyToken(`${b64({ alg: 'none', kid: 'k1' })}.${body}.`, policy, NOW).refusedBecause).toBe('algorithm_not_ours');
    const pem = server.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const h = b64({ alg: 'HS256', kid: 'k1' });
    const forged = `${h}.${body}.${createHmac('sha256', pem).update(`${h}.${body}`).digest('base64url')}`;
    expect(verifyToken(forged, policy, NOW).refusedBecause).toBe('algorithm_not_ours');
  });

  it('refuses a key id the server has not published, and never uses a key the token carries with it', () => {
    expect(verifyToken(signed(claims(), { kid: 'k-unknown', key: intruder.privateKey }), policy, NOW).refusedBecause).toBe('key_not_ours');
    // The intruder's own public key embedded in the header, under the server's key id: still checked against the SERVER key.
    const embedded = signed(claims(), { key: intruder.privateKey, header: { jwk: jwkOf(intruder.publicKey, 'k1') } });
    expect(verifyToken(embedded, policy, NOW).refusedBecause).toBe('signature_does_not_verify');
  });

  it('refuses a changed payload, another issuer, another audience, an expired or over-long token, and one naming no product person', () => {
    const [h, , s] = signed(claims()).split('.');
    expect(verifyToken(`${h}.${b64(claims({ tenant_id: 'tenant-b' }))}.${s}`, policy, NOW).refusedBecause).toBe('signature_does_not_verify');
    expect(verifyToken(signed(claims({ iss: 'https://elsewhere.test/realms/x' })), policy, NOW).refusedBecause).toBe('issuer_not_ours');
    expect(verifyToken(signed(claims({ aud: 'account' })), policy, NOW).refusedBecause).toBe('audience_not_ours');
    expect(verifyToken(signed(claims({ exp: NOW / 1000 - 120 })), policy, NOW).refusedBecause).toBe('expired');
    expect(verifyToken(signed(claims({ exp: NOW / 1000 + 86_400 })), policy, NOW).refusedBecause).toBe('lifetime_too_long');
    // The server's own `sub` is its internal id, not a product person: a token without the product's id names nobody.
    const noProductId = { ...claims() } as Record<string, unknown>;
    delete noProductId['sre_user_id'];
    expect(verifyToken(signed(noProductId), policy, NOW).refusedBecause).toBe('no_subject');
    expect(verifyToken(signed(claims({ tenant_id: undefined })), policy, NOW).refusedBecause).toBe('no_tenant');
  });
});

describe('the published key set', () => {
  it('keeps only RSA signing keys; an encryption key, another key type or a key with no id is left out', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
    const set = {
      keys: [
        jwkOf(server.publicKey, 'k1'),
        { ...jwkOf(intruder.publicKey, 'k-enc'), use: 'enc' },
        { ...jwkOf(intruder.publicKey, 'k-ps'), alg: 'PS256' },
        { ...ec, kid: 'k-ec', use: 'sig' },
        { ...jwkOf(intruder.publicKey, ''), kid: '' },
      ],
    };
    expect([...signingKeysOf(set).keys()]).toEqual(['k1']);
    expect(signingKeysOf({ nope: true }).size).toBe(0);
  });

  it('a rotated key is fetched when a token names it; made-up key ids cannot make it fetch more than once per interval', async () => {
    let now = NOW;
    let served = [jwkOf(server.publicKey, 'k1')];
    let fetches = 0;
    const fetchStub = (async () => { fetches += 1; return new Response(JSON.stringify({ keys: served })); }) as unknown as typeof globalThis.fetch;
    const ring = jwksKeyring({ url: 'https://idp.test/certs', fetch: fetchStub, now: () => now, minRefreshIntervalMs: 30_000 });
    expect(await ring.refresh()).toBe(1);
    const rotated = pair();
    served = [jwkOf(server.publicKey, 'k1'), jwkOf(rotated.publicKey, 'k2')];
    const auth = revocationAwareAuthenticator([{ ...policy, keyring: ring }], new TokenRevocationList({ load: async () => [], record: async () => {} }), undefined, () => now);
    // Within the interval a new key id is not fetched for…
    expect(await auth(signed(claims(), { kid: 'k2', key: rotated.privateKey }))).toBeUndefined();
    expect(fetches).toBe(1);
    // …after it, ONE fetch picks the rotated key up and the sign-in is believed.
    now += 31_000;
    expect(await auth(signed(claims(), { kid: 'k2', key: rotated.privateKey }))).toMatchObject({ userId: 'u-owner' });
    expect(fetches).toBe(2);
    // A stream of made-up key ids right after: no more fetches.
    for (let i = 0; i < 5; i += 1) expect(await auth(signed(claims(), { kid: `junk-${i}`, key: intruder.privateKey }))).toBeUndefined();
    expect(fetches).toBe(2);
  });

  it('a key set that cannot be fetched keeps the keys already held and says why', async () => {
    const problems: string[] = [];
    let ok = true;
    const fetchStub = (async () => { if (!ok) throw new Error('ECONNREFUSED'); return new Response(JSON.stringify({ keys: [jwkOf(server.publicKey, 'k1')] })); }) as unknown as typeof globalThis.fetch;
    const ring = jwksKeyring({ url: 'https://idp.test/certs', fetch: fetchStub, onProblem: (d) => { problems.push(d); } });
    await ring.refresh();
    ok = false;
    expect(await ring.refresh()).toBe(1);
    expect(ring.get('k1')).toBeDefined();
    expect(problems[0]).toMatch(/could not be fetched/);
  });
});

describe('the pilot sign-in and the identity server, side by side', () => {
  it('each token is checked under the policy for its own signing method; neither can pass as the other', async () => {
    const secret = ['pilot', 'shared', 'secret', 'for', 'tests'].join('-').padEnd(40, 'x');
    const hs: TokenPolicy = { secret, issuer: 'https://pilot.test', audience: AUDIENCE };
    const auth = revocationAwareAuthenticator([hs, policy], new TokenRevocationList({ load: async () => [], record: async () => {} }), undefined, () => NOW);
    const h = b64({ alg: 'HS256', typ: 'JWT' });
    const body = b64({ iss: 'https://pilot.test', aud: AUDIENCE, sub: 'u-cash', tenant_id: 'tenant-a', iat: NOW / 1000, exp: NOW / 1000 + 300 });
    const pilotToken = `${h}.${body}.${createHmac('sha256', secret).update(`${h}.${body}`).digest('base64url')}`;
    expect(await auth(pilotToken)).toMatchObject({ userId: 'u-cash' });
    expect(await auth(signed(claims()))).toMatchObject({ userId: 'u-owner' });
    // An identity-server-looking payload signed with the pilot secret is checked as a pilot token — and the pilot issuer is pinned.
    const rsBody = b64(claims());
    expect(await auth(`${h}.${rsBody}.${createHmac('sha256', secret).update(`${h}.${rsBody}`).digest('base64url')}`)).toBeUndefined();
    // A signing method nobody configured is refused outright.
    expect(await auth(`${b64({ alg: 'ES256', kid: 'k1' })}.${rsBody}.x`)).toBeUndefined();
  });
});
