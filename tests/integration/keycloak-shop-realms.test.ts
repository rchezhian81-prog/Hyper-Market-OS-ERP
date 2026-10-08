import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { startApi, type RunningApi } from '../../services/api/src/main';
import { shopRealmFile } from '../../services/identity/src/shop-realm-file';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';
import { TEST_IDP } from '../support/api-harness';
import { ensureAppRole, asRole } from '../support/db-app-role';

/**
 * **A second shop's own realm, made by head office's tool and loaded as the administrator loads it — a REAL Keycloak
 * and the REAL head-office service (OB-15-d · OB-19 "A" · M36-FR-01 · ADR-0003 hard isolation).**
 *
 * Opt-in, like the other real-Keycloak suites (runbook: identity server): a running Keycloak with the repository realm
 * (the first shop's), its admin password file, and a freshly migrated database. It:
 *   • makes the second shop's realm file with `shopRealmFile` and loads it through the identity server's own admin
 *     interface — what "Create realm → choose the file" does — with no placeholder left and no secret in it;
 *   • signs a person into EACH shop's realm, through the realms' own pages;
 *   • proves head office, told which realm signs for which shop, puts each person in their own shop and nowhere else;
 *   • and that a realm pinned to the wrong shop is refused outright — a realm can never sign for another shop.
 */

const BASE = process.env['KEYCLOAK_PROOF_BASE'];
const ADMIN_PW_FILE = process.env['KEYCLOAK_PROOF_ADMIN_PASSWORD_FILE'];
const TENANT_A = process.env['KEYCLOAK_PROOF_TENANT'];
const DATABASE_URL = process.env['KEYCLOAK_PROOF_DATABASE_URL'];
const READY = BASE !== undefined && ADMIN_PW_FILE !== undefined && TENANT_A !== undefined && DATABASE_URL !== undefined;
const ORIGIN = 'http://127.0.0.1:8099';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

class Jar {
  readonly cookies = new Map<string, string>();
  take(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const eq = pair!.indexOf('=');
      const v = pair!.slice(eq + 1);
      if (v === '') this.cookies.delete(pair!.slice(0, eq)); else this.cookies.set(pair!.slice(0, eq), v);
    }
  }
  header(): string { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
}

/** Sign in through a realm's own page with code + PKCE; the access token, or undefined. */
async function signIn(realm: string, username: string, password: string): Promise<string | undefined> {
  const issuer = `${BASE}/realms/${realm}`;
  const jar = new Jar();
  const verifier = randomBytes(32).toString('base64url');
  const redirect = `${ORIGIN}/login/callback`;
  const page = await fetch(`${issuer}/protocol/openid-connect/auth?${new URLSearchParams({
    client_id: 'sre-web', response_type: 'code', scope: 'openid', redirect_uri: redirect,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 'x',
  })}`, { redirect: 'manual' });
  jar.take(page);
  const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(await page.text())?.[1]?.replace(/&amp;/g, '&');
  if (action === undefined) return undefined;
  const posted = await fetch(action, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() }, body: new URLSearchParams({ username, password }).toString() });
  const location = posted.headers.get('location');
  if (location === null || !location.startsWith(redirect)) return undefined;
  const exchanged = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'sre-web', code: new URL(location).searchParams.get('code')!, redirect_uri: redirect, code_verifier: verifier }).toString(),
  });
  return ((await exchanged.json()) as { access_token?: string }).access_token;
}

describe.skipIf(!READY).sequential('a second shop\'s own realm, made by head office\'s tool and loaded by hand — real Keycloak, real head office (OB-15-d)', () => {
  const run = randomBytes(3).toString('hex');
  const realmB = `sre-proof-${run}`;
  const personA = `u-a-${run}`;
  const personB = `u-b-${run}`;
  const passA = randomBytes(18).toString('base64url');
  const passB = randomBytes(18).toString('base64url');
  let kcAdmin = '';
  let db: Pool | undefined;
  const apis: RunningApi[] = [];

  const admin = (method: string, path: string, body?: unknown) => fetch(`${BASE}/admin${path}`, {
    method, headers: { authorization: `Bearer ${kcAdmin}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const api = async (env: Record<string, string>): Promise<{ api?: RunningApi; said: string }> => {
    const pilot = TEST_IDP.policy();
    let said = '';
    const started = await startApi({
      DATABASE_URL: asRole(DATABASE_URL!, 'sre_app_shop_realms_proof'), PACK_SIGNING_KEY: ['proof', 'pack', 'key'].join('-').padEnd(48, '0'),
      IDP_SIGNING_KEY: pilot.secret, IDP_ISSUER: pilot.issuer, IDP_AUDIENCE: 'sre-retail-os-api',
      IDP_OIDC_ISSUER: `${BASE}/realms/sre-store`, IDP_OIDC_JWKS_URL: `${BASE}/realms/sre-store/protocol/openid-connect/certs`,
      PORT: '0', NODE_ENV: 'test', MIGRATION_TARGET_KIND: 'rehearsal', ...env,
    }, (t) => { said += t; }, (t) => { said += t; });
    if (started !== undefined) apis.push(started);
    return { ...(started === undefined ? {} : { api: started }), said };
  };
  const me = async (running: RunningApi, token: string) => {
    const res = await fetch(`http://127.0.0.1:${running.port}/v1/identity/me`, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, body: res.status === 200 ? await res.json() as { tenantId: string; userId: string } : undefined };
  };

  beforeAll(async () => {
    const res = await fetch(`${BASE}/realms/master/protocol/openid-connect/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: process.env['KEYCLOAK_PROOF_ADMIN_USER'] ?? 'kcadmin', password: readFileSync(ADMIN_PW_FILE!, 'utf8').trim() }).toString(),
    });
    kcAdmin = ((await res.json()) as { access_token: string }).access_token;

    // The second shop's realm: made by the tool, loaded as the administrator loads it.
    const template = JSON.parse(readFileSync('infra/keycloak/realm-sre-store.json', 'utf8')) as Record<string, unknown>;
    const made = shopRealmFile(template, { realm: realmB, tenantId: TENANT_B, displayName: 'SRE Proof Shop', webOrigin: ORIGIN, audience: 'sre-retail-os-api', allowHttp: true });
    expect(made.ok).toBe(true);
    const text = JSON.stringify((made as { realm: unknown }).realm);
    expect(text).not.toMatch(/\$\{SRE_/);
    const loaded = await admin('POST', '/realms', (made as { realm: unknown }).realm);
    expect(loaded.status, await loaded.clone().text()).toBe(201);

    // A person in each shop's realm, each holding a role in their own shop.
    for (const [realm, user, password] of [['sre-store', personA, passA], [realmB, personB, passB]] as const) {
      const created = await admin('POST', `/realms/${realm}/users`, {
        username: user, enabled: true, attributes: { sre_user_id: [user] },
        credentials: [{ type: 'password', value: password, temporary: false }],
      });
      expect(created.status, await created.clone().text()).toBe(201);
    }
    db = new Pool({ connectionString: DATABASE_URL });
    await ensureAppRole(db, 'sre_app_shop_realms_proof');
    const store = new SqlEventStore(pgPoolClient(db));
    for (const [tenant, user] of [[TENANT_A!, personA], [TENANT_B, personB]] as const) {
      await store.registerTenant(tenant, 'test/provision');
      await store.append(tenant, STREAM.identity, makeEvent({
        id: `grant-cashier-${user}`, type: 'RoleGranted', occurredAt: new Date().toISOString(),
        idempotencyKey: `grant-${tenant}-cashier-${user}`, source: 'test/provision',
        payload: { userId: user, roleId: 'cashier', branchScope: 'all', request: { grantId: `cashier-${user}`, userId: user, roleId: 'cashier', branchScope: 'all', requestedBy: 'test', approvedBy: 'test', requestedAt: new Date().toISOString() } },
      }));
    }
  }, 60_000);

  afterAll(async () => {
    for (const a of apis) await a.stop();
    await db?.end();
    if (kcAdmin !== '') await admin('DELETE', `/realms/${realmB}`);
  });

  it('the loaded realm is the shop\'s: its id written in, its own address to return to, the owner\'s look, no person but the provisioner\'s account', async () => {
    const rep = await (await admin('GET', `/realms/${realmB}`)).json() as { loginTheme?: string; displayName?: string };
    expect(rep).toMatchObject({ loginTheme: 'sre', displayName: 'SRE Proof Shop' });
    const client = ((await (await admin('GET', `/realms/${realmB}/clients?clientId=sre-web`)).json()) as { redirectUris: string[]; protocolMappers: { config: Record<string, string> }[] }[])[0]!;
    expect(client.redirectUris).toEqual([`${ORIGIN}/login/callback`]);
    expect(client.protocolMappers.map((m) => m.config['claim.value']).filter((v) => v !== undefined)).toEqual([TENANT_B]);
    // The only people are those added since; the provisioner's account (listed apart) manages users and nothing else.
    const users = await (await admin('GET', `/realms/${realmB}/users?briefRepresentation=true`)).json() as { username: string }[];
    expect(users.map((u) => u.username)).toEqual([personB]);
    const prov = ((await (await admin('GET', `/realms/${realmB}/clients?clientId=sre-provisioner`)).json()) as { id: string }[])[0]!;
    const sa = await (await admin('GET', `/realms/${realmB}/clients/${prov.id}/service-account-user`)).json() as { id: string };
    const rm = ((await (await admin('GET', `/realms/${realmB}/clients?clientId=realm-management`)).json()) as { id: string }[])[0]!;
    const roles = await (await admin('GET', `/realms/${realmB}/users/${sa.id}/role-mappings/clients/${rm.id}`)).json() as { name: string }[];
    expect(roles.map((r) => r.name).sort()).toEqual(['manage-users', 'query-users', 'view-users']);
    // The provisioner's secret was generated by the server on load — the file carried none.
    const secret = ((await (await admin('GET', `/realms/${realmB}/clients/${prov.id}/client-secret`)).json()) as { value?: string }).value ?? '';
    expect(secret.length).toBeGreaterThanOrEqual(16);
  });

  it('head office, told which realm signs for which shop, puts each person in their own shop — and nowhere else', async () => {
    const { api: running, said } = await api({ IDP_OIDC_TENANT_ID: TENANT_A!, IDP_OIDC_SHOP_REALMS: `${realmB}=${TENANT_B}` });
    expect(running, said).toBeDefined();
    expect(said).toContain(`signs for shop ${TENANT_A} only`);
    expect(said).toContain(`signs for shop ${TENANT_B} only`);
    const a = await signIn('sre-store', personA, passA);
    const b = await signIn(realmB, personB, passB);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(await me(running!, a!)).toEqual({ status: 200, body: expect.objectContaining({ tenantId: TENANT_A, userId: personA }) });
    expect(await me(running!, b!)).toEqual({ status: 200, body: expect.objectContaining({ tenantId: TENANT_B, userId: personB }) });
    // A person of one shop does not exist in the other shop's realm.
    expect(await signIn(realmB, personA, passA)).toBeUndefined();
  });

  it('a realm pinned to the wrong shop is refused outright; a second shop without the first pinned does not start', async () => {
    const { api: wrong } = await api({ IDP_OIDC_TENANT_ID: TENANT_B, IDP_OIDC_SHOP_REALMS: `${realmB}=${TENANT_A}` });
    expect(wrong).toBeDefined();
    const a = await signIn('sre-store', personA, passA);
    const b = await signIn(realmB, personB, passB);
    expect((await me(wrong!, a!)).status).toBe(401);
    expect((await me(wrong!, b!)).status).toBe(401);
    // Not told which shop the realm is for → the second shop's realm is not believed at all.
    const { api: unknownRealm } = await api({ IDP_OIDC_TENANT_ID: TENANT_A! });
    expect((await me(unknownRealm!, b!)).status).toBe(401);
    const { api: refused, said } = await api({ IDP_OIDC_SHOP_REALMS: `${realmB}=${TENANT_B}` });
    expect(refused).toBeUndefined();
    expect(said).toMatch(/every realm is pinned to its own shop/);
  });
});
