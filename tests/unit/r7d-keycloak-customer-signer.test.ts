import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { keycloakCustomerSigner, customerSubjectFor, customerRealmOf, keycloakSignerSettingsProblems, CUSTOMER_SUBJECT_PREFIX, CustomerSignerError } from '../../services/identity/src/keycloak-customer-signer';
import { customerRealmsFrom } from '../../services/identity/src/customer-realms';
import { customerRealmFile, shopRealmFile } from '../../services/identity/src/shop-realm-file';
import { createCustomerSignInHandler, CUSTOMER_STEP_UP_POLICY, type CustomerSignInRequest } from '../../services/identity/src/customer-sign-in';
import { customerSignInSettingsProblems } from '../../services/identity/src/customer-sign-in-main';
import { verifyToken } from '../../services/identity/src/token';
import { planNewShop, nextSteps } from '../../services/platform/src/new-shop';
import { keycloakStandIn } from '../support/keycloak-stand-in';
import { createOtpSimulator } from '../support/otp-simulator';

/**
 * **OB-510 (owner, 28 Oct 2026) · ADR-0031 amended — the customer's token is signed by our self-hosted identity server, in a
 * customer realm of each shop's own.** Against a stand-in of the customer realm (it signs RS256 and publishes its key, so
 * the signer's own check runs for real). The real identity server is proven by tests/integration/keycloak-customer-realm.test.ts,
 * which SKIPS without a Keycloak (it runs in CI's "Identity server suites (real Keycloak)").
 */

const SHOP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const PHONE = '9876543210';

const rig = (over: { tenantId?: string } = {}) => {
  const kc = keycloakStandIn({ tenantId: SHOP });
  const signer = keycloakCustomerSigner({
    internalIssuer: kc.issuer, issuer: kc.issuer, clientSecret: kc.clientSecret, tenantId: over.tenantId ?? SHOP, audience: 'sre-retail-os-api',
    keyring: kc.keyring, fetch: kc.fetch, now: () => Date.now(), maxLifetimeSeconds: 3_600,
  });
  return { kc, signer };
};

describe('OB-510 · the customer realm signs the customer\'s token', () => {
  it('a customer\'s product id: the same for the same number at the same shop, different elsewhere, and never the number', () => {
    const a = customerSubjectFor(SHOP, PHONE);
    expect(a).toBe(customerSubjectFor(SHOP, PHONE));
    expect(a.startsWith(CUSTOMER_SUBJECT_PREFIX)).toBe(true);
    expect(a).not.toBe(customerSubjectFor(SHOP, '9876543211'));
    expect(a).not.toBe(customerSubjectFor(OTHER, PHONE));
    expect(a).not.toContain(PHONE);
    expect(customerRealmOf('sre-store')).toBe('sre-store-customers');
  });

  it('signs a customer in: the account made once (no number in it), a fresh one-time credential each time, a token the API would believe', async () => {
    const { kc, signer } = rig();
    const first = await signer.signIn({ tenantId: SHOP, phoneNumber: PHONE, amr: ['otp'], authTimeMs: Date.now() });
    const subject = customerSubjectFor(SHOP, PHONE);
    expect(first.subject).toBe(subject);
    expect(first.expiresAtMs).toBeGreaterThan(Date.now());
    // The account holds the product id and nothing personal.
    expect([...kc.users.keys()]).toEqual([subject]);
    expect(JSON.stringify([...kc.users.values()].map((u) => u.attributes))).not.toContain(PHONE);
    // The API's own check: the realm's key, issuer, audience, this shop, customers only.
    const verdict = verifyToken(first.token, { algorithm: 'RS256', secret: '', keyring: kc.keyring, subjectClaim: 'sre_user_id', issuer: kc.issuer, tenantId: SHOP, subjectPrefix: CUSTOMER_SUBJECT_PREFIX, audience: 'sre-retail-os-api' }, Date.now());
    expect(verdict.ok).toBe(true);
    expect(verdict.principal).toMatchObject({ userId: subject, tenantId: SHOP, amr: ['otp'] });
    // Again (a renewal): the same account, NOT made twice, a NEW one-time credential.
    const second = await signer.signIn({ tenantId: SHOP, phoneNumber: PHONE, amr: ['otp'], authTimeMs: Date.now() });
    expect(second.subject).toBe(subject);
    expect(kc.calls.filter((c) => c === `POST /auth/admin/realms/${kc.realm}/users`)).toHaveLength(1);
    expect(kc.credentialsSet).toHaveLength(2);
    expect(new Set(kc.credentialsSet).size).toBe(2);
    expect(kc.credentialsSet.every((c) => c.length >= 32)).toBe(true);
    // One service sign-in serves both (it is reused until it is nearly out).
    expect(kc.calls.filter((c) => c.endsWith('/token'))).toHaveLength(3);
  });

  it('refuses — and never hands back a token — when the realm is for another shop, names another shop or person, or the account is switched off', async () => {
    const other = rig({ tenantId: OTHER });
    await expect(other.signer.signIn({ tenantId: SHOP, phoneNumber: PHONE, amr: ['otp'], authTimeMs: Date.now() })).rejects.toThrow(/another shop/);
    for (const fault of [{ tenantClaim: OTHER }, { subjectClaim: 'u-owner' }, { subjectClaim: `${CUSTOMER_SUBJECT_PREFIX}someone-else` }]) {
      const r = rig();
      Object.assign(r.kc.faults, fault);
      await expect(r.signer.signIn({ tenantId: SHOP, phoneNumber: PHONE, amr: ['otp'], authTimeMs: Date.now() })).rejects.toBeInstanceOf(CustomerSignerError);
    }
    const off = rig();
    await off.signer.signIn({ tenantId: SHOP, phoneNumber: PHONE, amr: ['otp'], authTimeMs: Date.now() });
    off.kc.faults.disable = true;
    await expect(off.signer.signIn({ tenantId: SHOP, phoneNumber: PHONE, amr: ['otp'], authTimeMs: Date.now() })).rejects.toThrow(/switched off/);
    const broken = rig();
    broken.kc.faults.serviceSignIn = 401;
    await expect(broken.signer.signIn({ tenantId: SHOP, phoneNumber: PHONE, amr: ['otp'], authTimeMs: Date.now() })).rejects.toThrow(/service sign-in/);
  });

  it('through the real customer sign-in service: a right code signs the customer in, and no number, code, token or credential reaches a log line', async () => {
    const { kc, signer } = rig();
    const sms = createOtpSimulator();
    const audit: Record<string, unknown>[] = [];
    const ORIGIN = 'https://shop.example.test';
    const handle = createCustomerSignInHandler({ tenantId: SHOP, origin: ORIGIN, sender: sms, signer, stepUp: CUSTOMER_STEP_UP_POLICY, now: () => Date.now(), audit: (l) => { audit.push(l); } });
    const post = (path: string, body: unknown) => handle({ method: 'POST', url: path, body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': '203.0.113.9' } } as CustomerSignInRequest);
    const begin = JSON.parse((await post('/auth/otp/begin', { phoneNumber: PHONE })).body) as { challengeId: string };
    const verify = await post('/auth/otp/verify', { challengeId: begin.challengeId, code: sms.codeFor(PHONE) });
    expect(verify.status).toBe(200);
    const body = JSON.parse(verify.body) as { token?: string };
    expect(typeof body.token).toBe('string');
    expect(verifyToken(body.token!, { algorithm: 'RS256', secret: '', keyring: kc.keyring, subjectClaim: 'sre_user_id', issuer: kc.issuer, tenantId: SHOP, subjectPrefix: CUSTOMER_SUBJECT_PREFIX, audience: 'sre-retail-os-api' }, Date.now()).principal?.userId).toBe(customerSubjectFor(SHOP, PHONE));
    const lines = JSON.stringify(audit);
    expect(lines).toContain('customer_signed_in');
    expect(lines).toContain(customerSubjectFor(SHOP, PHONE)); // the signed-in subject only
    for (const secret of [PHONE, sms.codeFor(PHONE)!, body.token ?? 'no-token', ...kc.credentialsSet, kc.clientSecret]) expect(lines).not.toContain(secret);
    // With the realm refusing, the customer hears a plain refusal and nothing is signed in.
    kc.faults.subjectClaim = 'u-staff-1';
    const again = JSON.parse((await post('/auth/otp/begin', { phoneNumber: '9876500000' })).body) as { challengeId: string };
    const refused = await post('/auth/otp/verify', { challengeId: again.challengeId, code: sms.codeFor('9876500000') });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(audit)).not.toContain('9876500000');
  });

  it('the settings: the signer asked for by name, its addresses and credential FILE (never a value) required', () => {
    expect(keycloakSignerSettingsProblems({})).toEqual([]);
    expect(keycloakSignerSettingsProblems({ CUSTOMER_SIGN_IN_SIGNER: 'magic' }).join(' ')).toMatch(/must be "keycloak"/);
    const missing = keycloakSignerSettingsProblems({ CUSTOMER_SIGN_IN_SIGNER: 'keycloak' }).join(' ');
    for (const k of ['CUSTOMER_REALM_ISSUER', 'CUSTOMER_REALM_INTERNAL_ISSUER', 'CUSTOMER_SIGN_IN_CLIENT_SECRET_FILE', 'IDP_AUDIENCE']) expect(missing).toContain(k);
    expect(customerSignInSettingsProblems({ CUSTOMER_SIGN_IN_ORIGIN: 'https://x.test', CUSTOMER_SIGN_IN_TENANT_ID: SHOP, CUSTOMER_SIGN_IN_SIGNER: 'keycloak' }).join(' ')).toContain('CUSTOMER_SIGN_IN_CLIENT_SECRET_FILE');
  });
});

describe('OB-510 · head office believes a customer realm for its shop and customers only', () => {
  const ISS = 'https://shop.example.test/auth/realms/sre-store';
  const JWKS = 'http://idp:8080/auth/realms/sre-store/protocol/openid-connect/certs';
  it('reads realm=tenant pairs on the same identity server; refuses what could let one realm sign for another', () => {
    expect(customerRealmsFrom({})).toEqual({ realms: [], problems: [] });
    const r = customerRealmsFrom({ IDP_OIDC_ISSUER: ISS, IDP_OIDC_JWKS_URL: JWKS, IDP_OIDC_CUSTOMER_REALMS: ` sre-store-customers=${SHOP} , sre-anna-customers=${OTHER}` });
    expect(r.problems).toEqual([]);
    expect(r.realms).toEqual([
      { realm: 'sre-store-customers', tenantId: SHOP, subjectPrefix: CUSTOMER_SUBJECT_PREFIX, issuer: 'https://shop.example.test/auth/realms/sre-store-customers', jwksUrl: 'http://idp:8080/auth/realms/sre-store-customers/protocol/openid-connect/certs' },
      { realm: 'sre-anna-customers', tenantId: OTHER, subjectPrefix: CUSTOMER_SUBJECT_PREFIX, issuer: 'https://shop.example.test/auth/realms/sre-anna-customers', jwksUrl: 'http://idp:8080/auth/realms/sre-anna-customers/protocol/openid-connect/certs' },
    ]);
    const problem = (extra: Record<string, string>) => customerRealmsFrom({ IDP_OIDC_ISSUER: ISS, IDP_OIDC_JWKS_URL: JWKS, ...extra }, [{ realm: 'sre-x-customers', tenantId: undefined, issuer: '', jwksUrl: '' }]).problems.join(' ');
    expect(problem({ IDP_OIDC_CUSTOMER_REALMS: `sre-store=${SHOP}` })).toMatch(/ending in "-customers"/);
    expect(problem({ IDP_OIDC_CUSTOMER_REALMS: 'sre-store-customers=nope' })).toMatch(/tenant UUID/);
    expect(problem({ IDP_OIDC_CUSTOMER_REALMS: `sre-a-customers=${SHOP},sre-b-customers=${SHOP}` })).toMatch(/two customer realms/);
    expect(problem({ IDP_OIDC_CUSTOMER_REALMS: `sre-a-customers=${SHOP},sre-a-customers=${OTHER}` })).toMatch(/named twice/);
    expect(problem({ IDP_OIDC_CUSTOMER_REALMS: `sre-x-customers=${SHOP}` })).toMatch(/staff realm and a customer realm/);
    expect(customerRealmsFrom({ IDP_OIDC_CUSTOMER_REALMS: `sre-store-customers=${SHOP}` }).problems.join(' ')).toMatch(/without the identity server/);
  });
  it('a token from a customer realm naming a member of staff is refused (subject_not_this_issuers)', () => {
    const kc = keycloakStandIn({ tenantId: SHOP });
    kc.faults.subjectClaim = 'u-owner';
    return (async () => {
      const t = Math.floor(Date.now() / 1000);
      // Mint through the stand-in's own grant: make the account, set a credential, take a token.
      const signer = keycloakCustomerSigner({ internalIssuer: kc.issuer, issuer: kc.issuer, clientSecret: kc.clientSecret, tenantId: SHOP, audience: 'sre-retail-os-api', keyring: kc.keyring, fetch: kc.fetch, now: () => Date.now() });
      await expect(signer.signIn({ tenantId: SHOP, phoneNumber: PHONE, amr: ['otp'], authTimeMs: t * 1000 })).rejects.toThrow(/subject_not_this_issuers/);
    })();
  });
});

describe('OB-510 · the customer realm file the administrator loads', () => {
  const template = JSON.parse(readFileSync('infra/keycloak/realm-sre-store-customers.json', 'utf8')) as Record<string, unknown>;
  const staff = JSON.parse(readFileSync('infra/keycloak/realm-sre-store.json', 'utf8')) as Record<string, unknown>;
  type Client = { clientId: string; directAccessGrantsEnabled: boolean; standardFlowEnabled: boolean; publicClient: boolean; serviceAccountsEnabled?: boolean; protocolMappers?: { config: Record<string, string> }[] };
  it('the repository\'s customer realm: one confidential client, no browser flow, no person, no secret; the staff realm still has no password grant', () => {
    expect(template['realm']).toBe('sre-store-customers');
    const clients = template['clients'] as Client[];
    expect(clients.map((c) => c.clientId)).toEqual(['sre-customer-sign-in']);
    expect(clients[0]).toMatchObject({ publicClient: false, standardFlowEnabled: false, directAccessGrantsEnabled: true, serviceAccountsEnabled: true });
    expect(JSON.stringify(template)).not.toMatch(/"(secret|password)"\s*:\s*"/i);
    expect((template['users'] as { serviceAccountClientId?: string; clientRoles?: Record<string, string[]> }[])).toEqual([
      { username: 'service-account-sre-customer-sign-in', enabled: true, serviceAccountClientId: 'sre-customer-sign-in', clientRoles: { 'realm-management': ['manage-users', 'view-users', 'query-users'] } },
    ]);
    expect((staff['clients'] as Client[]).every((c) => c.directAccessGrantsEnabled === false)).toBe(true);
  });
  it('a new shop\'s customer realm: its own name and shop written in, nothing left to fill', () => {
    const made = customerRealmFile(template, { shopRealm: 'sre-anna', tenantId: OTHER, displayName: 'Anna Nagar', audience: 'sre-retail-os-api' });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.realm['realm']).toBe('sre-anna-customers');
    expect(made.realm['displayName']).toBe('Anna Nagar — customers');
    const text = JSON.stringify(made.realm);
    expect(text).not.toMatch(/\$\{SRE_/);
    expect(((made.realm['clients'] as Client[])[0]!.protocolMappers ?? []).map((m) => m.config['claim.value']).filter((v) => v !== undefined)).toEqual([OTHER, '["otp"]']);
    expect(customerRealmFile(template, { shopRealm: 'sre-store', tenantId: OTHER, displayName: 'Again', audience: 'x' }).ok).toBe(false); // the first shop's own
    expect(customerRealmFile(template, { shopRealm: 'Anna', tenantId: 'nope', displayName: 'A', audience: '' })).toMatchObject({ ok: false });
    // The staff realm tool is unchanged.
    expect(shopRealmFile(staff, { realm: 'sre-anna', tenantId: OTHER, displayName: 'Anna Nagar', webOrigin: 'https://anna.example.test', audience: 'sre-retail-os-api' }).ok).toBe(true);
  });
  it('the new-shop command makes both files and says the fifth step: load the customers\' realm, copy its credential, tell head office', () => {
    const plan = planNewShop({
      tenantId: OTHER, name: 'Anna Nagar', owner: 'u-anna-owner', admins: [], operator: 'u-it', realm: 'sre-anna', webOrigin: 'https://anna.example.test', audience: 'sre-retail-os-api',
      targetKind: 'rehearsal', demoTenantIds: [], knownRoleIds: ['owner'], ownerRoleId: 'owner', realmTemplate: staff, customerRealmTemplate: template,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.customerRealmFile?.['realm']).toBe('sre-anna-customers');
    const steps = nextSteps(plan.shop, 'u-anna-owner', '/srv/realm-sre-anna.json', '/srv/realm-sre-anna-customers.json');
    expect(steps).toHaveLength(5);
    expect(steps[4]).toContain('/srv/realm-sre-anna-customers.json');
    expect(steps[4]).toContain(`sre-anna-customers=${OTHER}`);
    expect(steps[4]).toContain('OB-222');
    expect(nextSteps(plan.shop, 'u-anna-owner', '/srv/realm-sre-anna.json')).toHaveLength(4);
  });
});
