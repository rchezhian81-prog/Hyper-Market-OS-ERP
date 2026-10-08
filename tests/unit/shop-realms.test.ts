import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { shopRealmsFrom, realmOf } from '../../services/identity/src/shop-realms';
import { shopRealmFile } from '../../services/identity/src/shop-realm-file';
import { verifyToken, type TokenPolicy } from '../../services/identity/src/token';
import { revocationAwareAuthenticator, TokenRevocationList } from '../../services/identity/src/revocation';
import { peopleRoutes, foldPeople } from '../../services/identity/src/people';
import { ApiError } from '../../services/kernel/src/index';
import type { RequestContext } from '../../services/kernel/src/router';

/**
 * One realm per shop (OB-15-d · OB-19 "A" · M36-FR-01 · ADR-0003): head office believes each shop's realm only for that
 * shop; the shop's realm file is made with every value written in and no secret; head office's provisioner stays in its
 * own shop.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ISS = 'https://shop.example/auth/realms/sre-store';
const JWKS = 'http://idp:8080/auth/realms/sre-store/protocol/openid-connect/certs';

describe('which realms head office believes, from its settings', () => {
  it('one realm, unpinned, as before', () => {
    expect(shopRealmsFrom({ IDP_OIDC_ISSUER: ISS, IDP_OIDC_JWKS_URL: JWKS })).toEqual({ realms: [{ realm: 'sre-store', tenantId: undefined, issuer: ISS, jwksUrl: JWKS }], problems: [] });
    expect(shopRealmsFrom({})).toEqual({ realms: [], problems: [] });
  });

  it('a further shop: the same identity server, only the realm changed, each pinned to its shop', () => {
    const r = shopRealmsFrom({ IDP_OIDC_ISSUER: ISS, IDP_OIDC_JWKS_URL: JWKS, IDP_OIDC_TENANT_ID: A, IDP_OIDC_SHOP_REALMS: ` sre-anna=${B} ` });
    expect(r.problems).toEqual([]);
    expect(r.realms).toEqual([
      { realm: 'sre-store', tenantId: A, issuer: ISS, jwksUrl: JWKS },
      { realm: 'sre-anna', tenantId: B, issuer: 'https://shop.example/auth/realms/sre-anna', jwksUrl: 'http://idp:8080/auth/realms/sre-anna/protocol/openid-connect/certs' },
    ]);
  });

  it.each([
    [{ IDP_OIDC_SHOP_REALMS: `sre-anna=${B}` }, /every realm is pinned to its own shop/],
    [{ IDP_OIDC_TENANT_ID: A, IDP_OIDC_SHOP_REALMS: 'sre-anna' }, /is not realm=tenant/],
    [{ IDP_OIDC_TENANT_ID: A, IDP_OIDC_SHOP_REALMS: `sre-anna=${A}` }, /given two realms/],
    [{ IDP_OIDC_TENANT_ID: A, IDP_OIDC_SHOP_REALMS: `sre-store=${B}` }, /named twice/],
    [{ IDP_OIDC_TENANT_ID: 'shop-one' }, /must be a tenant id/],
  ])('%j is refused by name — head office does not start', (extra, words) => {
    const r = shopRealmsFrom({ IDP_OIDC_ISSUER: ISS, IDP_OIDC_JWKS_URL: JWKS, ...extra });
    expect(r.problems.join(' ')).toMatch(words);
  });

  it('settings without the identity server, or naming two different realms, are refused', () => {
    expect(shopRealmsFrom({ IDP_OIDC_TENANT_ID: A }).problems.join(' ')).toMatch(/without the identity server/);
    expect(shopRealmsFrom({ IDP_OIDC_ISSUER: ISS, IDP_OIDC_JWKS_URL: JWKS.replace('sre-store', 'other') }).problems.join(' ')).toMatch(/same realm/);
    expect(realmOf(JWKS)).toBe('sre-store');
  });
});

describe('a realm signs for its own shop only', () => {
  // Test-only keys, generated at run time (production code never signs).
  const kp = (kid: string) => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    return { privateKey, kid, keyring: { get: (k: string) => (k === kid ? publicKey : undefined) } };
  };
  const sign = (k: ReturnType<typeof kp>, claims: Record<string, unknown>): string => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = `${enc({ alg: 'RS256', typ: 'JWT', kid: k.kid })}.${enc(claims)}`;
    return `${head}.${cryptoSign('RSA-SHA256', Buffer.from(head), k.privateKey).toString('base64url')}`;
  };
  const now = Date.now();
  const claims = (iss: string, tenant: string) => ({ iss, aud: 'sre-retail-os-api', sre_user_id: 'u-1', tenant_id: tenant, iat: Math.floor(now / 1000) - 5, exp: Math.floor(now / 1000) + 300 });
  const kA = kp('ka');
  const kB = kp('kb');
  const ISS_B = ISS.replace('sre-store', 'sre-anna');
  const policy = (k: ReturnType<typeof kp>, issuer: string, tenantId: string): TokenPolicy => ({
    algorithm: 'RS256', secret: '', keyring: k.keyring, subjectClaim: 'sre_user_id', issuer, tenantId, audience: 'sre-retail-os-api', maxLifetimeSeconds: 2_678_400,
  });

  it('a sign-in naming another shop is refused, even correctly signed by the realm', () => {
    expect(verifyToken(sign(kA, claims(ISS, A)), policy(kA, ISS, A), now).ok).toBe(true);
    const v = verifyToken(sign(kA, claims(ISS, B)), policy(kA, ISS, A), now);
    expect(v).toMatchObject({ ok: false, refusedBecause: 'tenant_not_this_issuers' });
  });

  it('with several realms the issuer CHOOSES among ours — the chosen realm\'s own keys and shop still decide', async () => {
    const auth = revocationAwareAuthenticator(
      [policy(kA, ISS, A), policy(kB, ISS_B, B)],
      new TokenRevocationList({ load: async () => [], record: async () => {} }),
    );
    expect(await auth(sign(kA, claims(ISS, A)))).toMatchObject({ tenantId: A });
    expect(await auth(sign(kB, claims(ISS_B, B)))).toMatchObject({ tenantId: B });
    // Shop B's realm cannot sign for shop A; nor can A's key pass as B's realm; nor an issuer we do not know.
    expect(await auth(sign(kB, claims(ISS_B, A)))).toBeUndefined();
    expect(await auth(sign(kA, claims(ISS_B, B)))).toBeUndefined();
    expect(await auth(sign(kA, claims('https://elsewhere/realms/x', A)))).toBeUndefined();
  });
});

describe('the shop\'s realm file', () => {
  const template = JSON.parse(readFileSync('infra/keycloak/realm-sre-store.json', 'utf8')) as Record<string, unknown>;
  const good = { realm: 'sre-anna', tenantId: B, displayName: 'SRE Anna Nagar', webOrigin: 'https://anna.example', audience: 'sre-retail-os-api' };

  it('every value written in — the realm, the one shop, the address, our API — no placeholder, no person, no secret', () => {
    const made = shopRealmFile(template, good);
    expect(made.ok).toBe(true);
    const realm = (made as { realm: Record<string, unknown> }).realm;
    const text = JSON.stringify(realm);
    expect(text).not.toMatch(/\$\{SRE_/);
    expect(realm).toMatchObject({ realm: 'sre-anna', displayName: 'SRE Anna Nagar', loginTheme: 'sre' });
    const web = (realm['clients'] as Record<string, unknown>[]).find((c) => c['clientId'] === 'sre-web')!;
    expect(web['redirectUris']).toEqual(['https://anna.example/login/callback']);
    const mappers = web['protocolMappers'] as { protocolMapper: string; config: Record<string, string> }[];
    expect(mappers.find((m) => m.protocolMapper === 'oidc-hardcoded-claim-mapper')!.config['claim.value']).toBe(B);
    expect(mappers.find((m) => m.protocolMapper === 'oidc-audience-mapper')!.config['included.custom.audience']).toBe('sre-retail-os-api');
    expect(text).not.toMatch(/"(secret|password|credentials)"\s*:/i);
    // The template is untouched.
    expect(template['realm']).toBe('sre-store');
  });

  it.each([
    [{ realm: 'sre-store' }, /first shop's realm/],
    [{ realm: 'Anna' }, /must be sre-<shop>/],
    [{ tenantId: 'anna' }, /tenant id/],
    [{ webOrigin: 'http://anna.example' }, /must be https/],
    [{ webOrigin: 'https://anna.example/shop' }, /no path/],
    [{ displayName: 'A' }, /2 to 80/],
  ])('%j is refused by name — no file', (over, words) => {
    const made = shopRealmFile(template, { ...good, ...over });
    expect(made.ok).toBe(false);
    expect((made as { readonly problems: readonly string[] }).problems.join(' ')).toMatch(words);
  });

  it('http only when allowed for a test machine', () => {
    expect(shopRealmFile(template, { ...good, webOrigin: 'http://127.0.0.1:8099', allowHttp: true }).ok).toBe(true);
  });
});

describe('head office\'s provisioner stays in its own shop', () => {
  it('another shop\'s administrator is told it is not connected — no person is made in somebody else\'s realm', async () => {
    let issued = 0;
    const routes = peopleRoutes({
      now: () => 't', people: () => foldPeople([]), recordPerson: () => {}, holdsAnyRole: () => false,
      directory: { issue: async () => { issued += 1; return { result: 'issued', resumed: false }; }, end: async () => 'none' },
      directoryTenantId: A,
    });
    const post = routes.find((r) => r.method === 'POST')!;
    const get = routes.find((r) => r.method === 'GET')!;
    const ctx = (tenantId: string) => ({ tenantId, userId: 'u-admin', branchId: null, params: {}, query: {}, body: { signInName: 'asha.k', displayName: 'Asha Kumar' }, traceId: 't', idempotencyKey: 'k' } as RequestContext);
    try { await post.handler(ctx(B)); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(503);
    }
    expect(issued).toBe(0);
    expect((await get.handler(ctx(B))).body).toMatchObject({ connected: false });
    expect((await post.handler(ctx(A))).status).toBe(201);
    expect(issued).toBe(1);
  });
});
