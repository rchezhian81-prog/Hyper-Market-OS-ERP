import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { startApi, type RunningApi } from '../../services/api/src/main';
import { customerRealmFile } from '../../services/identity/src/shop-realm-file';
import { keycloakCustomerSigner, customerSubjectFor, CUSTOMER_SUBJECT_PREFIX } from '../../services/identity/src/keycloak-customer-signer';
import { createCustomerSignInHandler, CUSTOMER_STEP_UP_POLICY, type CustomerSignInRequest } from '../../services/identity/src/customer-sign-in';
import { jwksKeyring } from '../../services/identity/src/jwks';
import { verifyToken } from '../../services/identity/src/token';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';
import { TEST_IDP } from '../support/api-harness';
import { ensureAppRole, asRole } from '../support/db-app-role';
import { createOtpSimulator } from '../support/otp-simulator';

/**
 * **OB-510 · ADR-0031 (amended) — a shop's CUSTOMER realm, made by head office's tool and loaded as the administrator
 * loads it, signs the customer's token — a REAL Keycloak, the REAL customer sign-in service and the REAL head office.**
 *
 * Opt-in, like the other real-Keycloak suites (runbook: identity server; `scripts/identity-proof.sh` runs it in CI and
 * refuses a skip there). It SKIPS on a machine with no Keycloak. It:
 *   • makes the customer realm file with `customerRealmFile` and loads it through the identity server's admin interface —
 *     no placeholder left, no secret and no customer in it; the sign-in service's client credential is generated there;
 *   • signs a customer in through the real customer sign-in service (the code read from the recording SMS stand-in, since
 *     no SMS provider is approved — OB-222) with the Keycloak signer: the token is the identity server's, RS256, for this
 *     shop and this customer only; the identity server holds no phone number; the same number is the same customer;
 *   • proves head office, told the customer realm and its shop, believes that token for that shop — and not without being
 *     told, not when pinned to another shop.
 */

const BASE = process.env['KEYCLOAK_PROOF_BASE'];
const ADMIN_PW_FILE = process.env['KEYCLOAK_PROOF_ADMIN_PASSWORD_FILE'];
const TENANT = process.env['KEYCLOAK_PROOF_TENANT'];
const DATABASE_URL = process.env['KEYCLOAK_PROOF_DATABASE_URL'];
const READY = BASE !== undefined && ADMIN_PW_FILE !== undefined && TENANT !== undefined && DATABASE_URL !== undefined;
const OTHER_TENANT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PHONE = '9876543210';
const ORIGIN = 'https://shop.example.test';

describe.skipIf(!READY).sequential('a shop\'s customer realm signs the customer\'s token — real Keycloak, real sign-in service, real head office (OB-510)', () => {
  const run = randomBytes(3).toString('hex');
  const shopRealm = `sre-cproof-${run}`;
  const realm = `${shopRealm}-customers`;
  let kcAdmin = '';
  let clientSecret = '';
  let db: Pool | undefined;
  const apis: RunningApi[] = [];
  const issuer = (): string => `${BASE}/realms/${realm}`;

  const admin = (method: string, path: string, body?: unknown) => fetch(`${BASE}/admin${path}`, {
    method, headers: { authorization: `Bearer ${kcAdmin}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const signer = () => {
    const keyring = jwksKeyring({ url: `${issuer()}/protocol/openid-connect/certs`, fetch: globalThis.fetch });
    return { keyring, signer: keycloakCustomerSigner({ internalIssuer: issuer(), issuer: issuer(), clientSecret, tenantId: TENANT!, audience: 'sre-retail-os-api', keyring, fetch: globalThis.fetch, now: () => Date.now() }) };
  };
  const api = async (env: Record<string, string>): Promise<{ api?: RunningApi; said: string }> => {
    const pilot = TEST_IDP.policy();
    let said = '';
    const started = await startApi({
      DATABASE_URL: asRole(DATABASE_URL!, 'sre_app_customer_realm_proof'), PACK_SIGNING_KEY: ['proof', 'pack', 'key'].join('-').padEnd(48, '0'), BOX_HISTORY_SEAL_KEY: ['proof', 'seal', 'key'].join('-').padEnd(48, '1'),
      IDP_SIGNING_KEY: pilot.secret, IDP_ISSUER: pilot.issuer, IDP_AUDIENCE: 'sre-retail-os-api',
      IDP_OIDC_ISSUER: `${BASE}/realms/sre-store`, IDP_OIDC_JWKS_URL: `${BASE}/realms/sre-store/protocol/openid-connect/certs`, IDP_OIDC_TENANT_ID: TENANT!,
      PORT: '0', NODE_ENV: 'test', MIGRATION_TARGET_KIND: 'rehearsal', ...env,
    }, (t) => { said += t; }, (t) => { said += t; });
    if (started !== undefined) apis.push(started);
    return { ...(started === undefined ? {} : { api: started }), said };
  };
  const me = async (running: RunningApi, token: string) => {
    const res = await fetch(`http://127.0.0.1:${running.port}/v1/identity/me`, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, body: res.status === 200 ? await res.json() as { tenantId: string; userId: string } : undefined };
  };
  const customerSignIn = async (phone: string): Promise<string> => {
    const sms = createOtpSimulator();
    const audit: Record<string, unknown>[] = [];
    const handle = createCustomerSignInHandler({ tenantId: TENANT!, origin: ORIGIN, sender: sms, signer: signer().signer, stepUp: CUSTOMER_STEP_UP_POLICY, now: () => Date.now(), audit: (l) => { audit.push(l); } });
    const post = (path: string, body: unknown) => handle({ method: 'POST', url: path, body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': '203.0.113.20' } } as CustomerSignInRequest);
    const begin = JSON.parse((await post('/auth/otp/begin', { phoneNumber: phone })).body) as { challengeId: string };
    const verify = await post('/auth/otp/verify', { challengeId: begin.challengeId, code: sms.codeFor(phone) });
    expect(verify.status, verify.body).toBe(200);
    expect(JSON.stringify(audit)).not.toContain(phone);
    return (JSON.parse(verify.body) as { token: string }).token;
  };

  beforeAll(async () => {
    const res = await fetch(`${BASE}/realms/master/protocol/openid-connect/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: process.env['KEYCLOAK_PROOF_ADMIN_USER'] ?? 'kcadmin', password: readFileSync(ADMIN_PW_FILE!, 'utf8').trim() }).toString(),
    });
    kcAdmin = ((await res.json()) as { access_token: string }).access_token;
    // The customer realm: made by the tool, loaded as the administrator loads it.
    const template = JSON.parse(readFileSync('infra/keycloak/realm-sre-store-customers.json', 'utf8')) as Record<string, unknown>;
    const made = customerRealmFile(template, { shopRealm, tenantId: TENANT!, displayName: 'SRE Proof Shop', audience: 'sre-retail-os-api' });
    expect(made.ok).toBe(true);
    expect(JSON.stringify((made as { realm: unknown }).realm)).not.toMatch(/\$\{SRE_/);
    const loaded = await admin('POST', '/realms', (made as { realm: unknown }).realm);
    expect(loaded.status, await loaded.clone().text()).toBe(201);
    // The administrator copies the credential the identity server generated for the sign-in service's client.
    const client = ((await (await admin('GET', `/realms/${realm}/clients?clientId=sre-customer-sign-in`)).json()) as { id: string }[])[0]!;
    clientSecret = ((await (await admin('GET', `/realms/${realm}/clients/${client.id}/client-secret`)).json()) as { value?: string }).value ?? '';
    expect(clientSecret.length).toBeGreaterThanOrEqual(16);
    db = new Pool({ connectionString: DATABASE_URL });
    await ensureAppRole(db, 'sre_app_customer_realm_proof');
  }, 60_000);

  afterAll(async () => {
    for (const a of apis) await a.stop();
    await db?.end();
    if (kcAdmin !== '') await admin('DELETE', `/realms/${realm}`);
  });

  it('the loaded customer realm: no customer and no secret came with it; its one client manages users and nothing else', async () => {
    expect(((await (await admin('GET', `/realms/${realm}/users?briefRepresentation=true`)).json()) as unknown[])).toEqual([]);
    const client = ((await (await admin('GET', `/realms/${realm}/clients?clientId=sre-customer-sign-in`)).json()) as { id: string; publicClient: boolean; standardFlowEnabled: boolean; directAccessGrantsEnabled: boolean }[])[0]!;
    expect(client).toMatchObject({ publicClient: false, standardFlowEnabled: false, directAccessGrantsEnabled: true });
    const sa = await (await admin('GET', `/realms/${realm}/clients/${client.id}/service-account-user`)).json() as { id: string };
    const rm = ((await (await admin('GET', `/realms/${realm}/clients?clientId=realm-management`)).json()) as { id: string }[])[0]!;
    const roles = await (await admin('GET', `/realms/${realm}/users/${sa.id}/role-mappings/clients/${rm.id}`)).json() as { name: string }[];
    expect(roles.map((r) => r.name).sort()).toEqual(['manage-users', 'query-users', 'view-users']);
  });

  it('a right code signs the customer in: the identity server\'s own RS256 token, this shop, this customer; no number held there; the same number is the same customer', async () => {
    const token = await customerSignIn(PHONE);
    const { keyring } = signer();
    await keyring.refresh();
    const subject = customerSubjectFor(TENANT!, PHONE);
    const verdict = verifyToken(token, { algorithm: 'RS256', secret: '', keyring, subjectClaim: 'sre_user_id', issuer: issuer(), tenantId: TENANT!, subjectPrefix: CUSTOMER_SUBJECT_PREFIX, audience: 'sre-retail-os-api' }, Date.now());
    expect(verdict.ok, verdict.detail).toBe(true);
    expect(verdict.principal).toMatchObject({ userId: subject, tenantId: TENANT });
    expect(verdict.principal?.amr).toContain('otp');
    const users = await (await admin('GET', `/realms/${realm}/users?briefRepresentation=false`)).json() as { username: string; attributes?: Record<string, string[]>; email?: string; firstName?: string }[];
    expect(users.map((u) => u.username)).toEqual([subject]);
    expect(JSON.stringify(users)).not.toContain(PHONE);
    // Again: the same customer, one account.
    await customerSignIn(PHONE);
    expect(((await (await admin('GET', `/realms/${realm}/users?briefRepresentation=true`)).json()) as unknown[])).toHaveLength(1);
    // The staff realm's checker refuses it: a customer token is not a member of staff's.
    expect(verifyToken(token, { algorithm: 'RS256', secret: '', keyring, subjectClaim: 'sre_user_id', issuer: `${BASE}/realms/sre-store`, audience: 'sre-retail-os-api' }, Date.now()).ok).toBe(false);
  });

  it('head office believes the customer realm only when told, and only for its own shop', async () => {
    const token = await customerSignIn('9876500001');
    const subject = customerSubjectFor(TENANT!, '9876500001');
    const store = new SqlEventStore(pgPoolClient(db!));
    await store.registerTenant(TENANT!, 'test/provision').catch(() => undefined);
    await store.append(TENANT!, STREAM.identity, makeEvent({
      id: `grant-customer-${subject}`, type: 'RoleGranted', occurredAt: new Date().toISOString(), idempotencyKey: `grant-${TENANT}-customer-${subject}`, source: 'test/provision',
      payload: { userId: subject, roleId: 'customer', branchScope: 'all', request: { grantId: `customer-${subject}`, userId: subject, roleId: 'customer', branchScope: 'all', requestedBy: 'test', approvedBy: 'test', requestedAt: new Date().toISOString() } },
    }));
    const { api: told, said } = await api({ IDP_OIDC_CUSTOMER_REALMS: `${realm}=${TENANT}` });
    expect(told, said).toBeDefined();
    expect(said).toContain(`signs CUSTOMERS of shop ${TENANT} only`);
    expect(await me(told!, token)).toEqual({ status: 200, body: expect.objectContaining({ tenantId: TENANT, userId: subject }) });
    const { api: notTold } = await api({});
    expect((await me(notTold!, token)).status).toBe(401);
    const { api: wrongShop } = await api({ IDP_OIDC_CUSTOMER_REALMS: `${realm}=${OTHER_TENANT}` });
    expect((await me(wrongShop!, token)).status).toBe(401);
  });
});
