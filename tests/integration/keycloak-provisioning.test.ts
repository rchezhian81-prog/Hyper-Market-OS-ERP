import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { startApi, type RunningApi } from '../../services/api/src/main';
import { keycloakDirectory } from '../../services/identity/src/identity-directory';
import { WITHHELD_ON_REPLAY } from '../../services/kernel/src/pipeline';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';
import { TEST_IDP } from '../support/api-harness';
import { ensureAppRole, asRole } from '../support/db-app-role';

/**
 * **Head office gives a named person a sign-in at a REAL Keycloak, and ends a leaver's (OB-15-c · M02-FR-01 · SEC-03).**
 *
 * Opt-in, like the other real-Keycloak suites (runbook: identity server): a running Keycloak with the repository realm
 * and a freshly migrated database. It proves, on the real server:
 *   • the provisioner the realm defines may manage people and NOTHING else — not the realm, not its clients, not an
 *     administrator role;
 *   • a platform administrator, signed in with password AND a one-time code from their phone, gives a named person a
 *     sign-in through the real head-office service: the one-time password comes back once, `no-store`, and a replay of
 *     the same request does not carry it; a shared name and a person already holding a role are refused;
 *   • that person's first sign-in: the one-time password works once, they must choose their own password AND set up a
 *     one-time code, and the token carries their product id;
 *   • ending their sign-in switches it off: the next sign-in is refused.
 */

const BASE = process.env['KEYCLOAK_PROOF_BASE'];
const ADMIN_PW_FILE = process.env['KEYCLOAK_PROOF_ADMIN_PASSWORD_FILE'];
const TENANT = process.env['KEYCLOAK_PROOF_TENANT'];
const DATABASE_URL = process.env['KEYCLOAK_PROOF_DATABASE_URL'];
const READY = BASE !== undefined && ADMIN_PW_FILE !== undefined && TENANT !== undefined && DATABASE_URL !== undefined;
const REALM = 'sre-store';
const ISSUER = `${BASE}/realms/${REALM}`;
const ORIGIN = 'http://127.0.0.1:8099';

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

const usedWindow = new Map<string, number>();

/** RFC 6238 one-time code, as the person's phone app computes it — a fresh one: the server refuses a code used twice. */
async function freshCode(username: string, secret: Buffer): Promise<string> {
  let window = Math.floor(Date.now() / 30_000);
  while (window <= (usedWindow.get(username) ?? -1)) {
    await new Promise((r) => setTimeout(r, 1000));
    window = Math.floor(Date.now() / 30_000);
  }
  usedWindow.set(username, window);
  return totp(secret, window * 30_000 + 1);
}

function totp(secret: Buffer, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac('sha1', secret).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

const attr = (html: string, re: RegExp): string | undefined => re.exec(html)?.[1]?.replace(/&amp;/g, '&');
const actionOf = (html: string, formId: string): string | undefined =>
  attr(html, new RegExp(`<form[^>]*id="${formId}"[^>]*action="([^"]+)"`)) ?? attr(html, new RegExp(`<form[^>]*action="([^"]+)"[^>]*id="${formId}"`));

interface Journey { readonly token?: string; readonly pages: readonly string[]; readonly refusal?: string }

/**
 * Sign in as a browser does — PKCE, the identity server's pages — answering what it asks: the password, a new password
 * (`newPassword`), a one-time code set-up (the app's secret is remembered in `otpSecrets`), a one-time code.
 */
async function journey(username: string, password: string, otpSecrets: Map<string, Buffer>, newPassword?: string): Promise<Journey> {
  const jar = new Jar();
  const verifier = randomBytes(32).toString('base64url');
  const redirect = `${ORIGIN}/login/callback`;
  const pages: string[] = [];
  let res = await fetch(`${ISSUER}/protocol/openid-connect/auth?${new URLSearchParams({
    client_id: 'sre-web', response_type: 'code', scope: 'openid', redirect_uri: redirect,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    state: randomBytes(8).toString('hex'),
  })}`, { redirect: 'manual' });
  jar.take(res);
  for (let step = 0; step < 6; step += 1) {
    const location = res.headers.get('location');
    if (location !== null && location.startsWith(redirect)) {
      const code = new URL(location).searchParams.get('code')!;
      const exchanged = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'sre-web', code, redirect_uri: redirect, code_verifier: verifier }).toString(),
      });
      const body = await exchanged.json() as { access_token?: string };
      return { ...(body.access_token === undefined ? {} : { token: body.access_token }), pages };
    }
    if (location !== null) { res = await fetch(location, { redirect: 'manual', headers: { cookie: jar.header() } }); jar.take(res); continue; }
    const html = await res.text();
    const post = async (action: string, fields: Record<string, string>) => {
      res = await fetch(action, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() }, body: new URLSearchParams(fields).toString() });
      jar.take(res);
    };
    const login = actionOf(html, 'kc-form-login');
    const update = actionOf(html, 'kc-passwd-update-form');
    const setup = actionOf(html, 'kc-totp-settings-form');
    const otp = actionOf(html, 'kc-otp-login-form');
    if (login !== undefined && !pages.includes('password')) { pages.push('password'); await post(login, { username, password }); continue; }
    if (update !== undefined && newPassword !== undefined) { pages.push('new-password'); await post(update, { 'password-new': newPassword, 'password-confirm': newPassword }); continue; }
    if (setup !== undefined) {
      const secret = attr(html, /name="totpSecret"[^>]*value="([^"]+)"/) ?? attr(html, /value="([^"]+)"[^>]*name="totpSecret"/);
      expect(secret, 'the set-up page carries the app secret').toBeDefined();
      otpSecrets.set(username, Buffer.from(secret!, 'utf8'));
      pages.push('otp-setup');
      await post(setup, { totp: await freshCode(username, otpSecrets.get(username)!), totpSecret: secret!, userLabel: 'proof phone' });
      continue;
    }
    if (otp !== undefined && otpSecrets.has(username) && !pages.includes('otp')) { pages.push('otp'); await post(otp, { otp: await freshCode(username, otpSecrets.get(username)!) }); continue; }
    return { pages, refusal: /class="[^"]*sl-message[^"]*"[^>]*>([^<]+)</.exec(html)?.[1] ?? html.slice(0, 300) };
  }
  return { pages, refusal: 'too many steps' };
}

describe.skipIf(!READY).sequential('a real Keycloak: head office gives a named person a sign-in and ends a leaver\'s (OB-15-c)', { timeout: 120_000 }, () => {
  const run = randomBytes(3).toString('hex');
  const adminUser = `u-pa-${run}`;
  const adminPassword = randomBytes(18).toString('base64url');
  const holder = `u-holder-${run}`;
  const newcomer = `asha.${run}`;
  const otpSecrets = new Map<string, Buffer>();
  let kcAdmin = '';
  let provisionerSecret = '';
  let api: RunningApi | undefined;
  let db: Pool | undefined;
  let issuedPassword = '';

  const admin = (method: string, path: string, body?: unknown, bearer = kcAdmin) => fetch(`${BASE}/admin/realms/${REALM}${path}`, {
    method, headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  beforeAll(async () => {
    const res = await fetch(`${BASE}/realms/master/protocol/openid-connect/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: process.env['KEYCLOAK_PROOF_ADMIN_USER'] ?? 'kcadmin', password: readFileSync(ADMIN_PW_FILE!, 'utf8').trim() }).toString(),
    });
    kcAdmin = ((await res.json()) as { access_token: string }).access_token;
    // The secret the identity server GENERATED for the provisioner — as the administrator copies it, here read back.
    const clients = await (await admin('GET', '/clients?clientId=sre-provisioner')).json() as { id: string }[];
    provisionerSecret = ((await (await admin('GET', `/clients/${clients[0]!.id}/client-secret`)).json()) as { value: string }).value;
    expect(provisionerSecret.length).toBeGreaterThanOrEqual(16);

    // The platform administrator: a person in the identity server with the second-factor role…
    const created = await admin('POST', '/users', {
      username: adminUser, enabled: true, attributes: { sre_user_id: [adminUser] },
      credentials: [{ type: 'password', value: adminPassword, temporary: false }],
    });
    expect(created.status).toBe(201);
    const id = (created.headers.get('location') ?? '').split('/').pop()!;
    const role = await (await admin('GET', '/roles/sre-privileged')).json() as unknown;
    expect((await admin('POST', `/users/${id}/role-mappings/realm`, [role])).status).toBe(204);

    // …who holds the platform administrator's role in the product, and a person who already holds a role.
    db = new Pool({ connectionString: DATABASE_URL });
    await ensureAppRole(db, 'sre_app_provisioning_proof');
    const store = new SqlEventStore(pgPoolClient(db));
    await store.registerTenant(TENANT!, 'test/provision');
    for (const [userId, roleId] of [[adminUser, 'platform_admin'], [holder, 'cashier']] as const) {
      await store.append(TENANT!, STREAM.identity, makeEvent({
        id: `grant-${roleId}-${userId}`, type: 'RoleGranted', occurredAt: new Date().toISOString(),
        idempotencyKey: `grant-${TENANT}-${roleId}-${userId}`, source: 'test/provision',
        payload: { userId, roleId, branchScope: 'all', request: { grantId: `${roleId}-${userId}`, userId, roleId, branchScope: 'all', requestedBy: 'test', approvedBy: 'test', requestedAt: new Date().toISOString() } },
      }));
    }

    const pilot = TEST_IDP.policy();
    const said: string[] = [];
    api = await startApi({
      DATABASE_URL: asRole(DATABASE_URL!, 'sre_app_provisioning_proof'), PACK_SIGNING_KEY: ['proof', 'pack', 'key'].join('-').padEnd(48, '0'),
      IDP_SIGNING_KEY: pilot.secret, IDP_ISSUER: pilot.issuer, IDP_AUDIENCE: 'sre-retail-os-api',
      IDP_OIDC_ISSUER: ISSUER, IDP_OIDC_JWKS_URL: `${ISSUER}/protocol/openid-connect/certs`,
      IDP_PROVISIONER_SECRET: provisionerSecret,
      PORT: '0', NODE_ENV: 'test', MIGRATION_TARGET_KIND: 'rehearsal',
    }, (t) => { said.push(t); }, (t) => { said.push(t); });
    expect(api, said.join('')).toBeDefined();
    expect(said.join('')).toMatch(/people's sign-ins are given from the product/);
    expect(said.join('')).not.toContain(provisionerSecret);
  }, 60_000);

  afterAll(async () => { await api?.stop(); await db?.end(); });

  it('the provisioner may manage people and nothing else: not the realm, not its clients, not an administrator role', async () => {
    const t = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'sre-provisioner', client_secret: provisionerSecret }).toString(),
    });
    const bearer = ((await t.json()) as { access_token: string }).access_token;
    expect((await admin('GET', '/users?max=1', undefined, bearer)).status).toBe(200);
    // Reading the realm's public description is allowed to any of its helpers; changing anything about it is not.
    // It may ask for the client list — and is shown none of them; a client, and its secret, are refused.
    const listed = await admin('GET', '/clients', undefined, bearer);
    expect(listed.status === 403 || ((await listed.json()) as unknown[]).length === 0).toBe(true);
    const own = (await (await admin('GET', '/clients?clientId=sre-provisioner')).json() as { id: string }[])[0]!.id;
    expect((await admin('GET', `/clients/${own}`, undefined, bearer)).status).toBe(403);
    expect((await admin('GET', `/clients/${own}/client-secret`, undefined, bearer)).status).toBe(403);
    expect((await admin('GET', '/authentication/flows', undefined, bearer)).status).toBe(403);
    expect((await admin('PUT', '', { registrationAllowed: true }, bearer)).status).toBe(403);
    expect(((await (await admin('GET', '')).json()) as { registrationAllowed: boolean }).registrationAllowed).toBe(false);
    // An administrator role cannot be handed to anybody — the provisioner itself included.
    const rm = (await (await admin('GET', '/clients?clientId=realm-management')).json() as { id: string }[])[0]!.id;
    const realmAdmin = await (await admin('GET', `/clients/${rm}/roles/realm-admin`)).json() as unknown;
    const self = (await (await admin('GET', '/users?username=service-account-sre-provisioner&exact=true')).json() as { id: string }[])[0]!.id;
    expect((await admin('POST', `/users/${self}/role-mappings/clients/${rm}`, [realmAdmin], bearer)).status).toBe(403);
    // A wrong secret is refused.
    const wrong = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'sre-provisioner', client_secret: randomBytes(16).toString('hex') }).toString(),
    });
    expect(wrong.status).toBe(401);
  });

  it('the platform administrator, signed in with password AND phone code, gives a named person a sign-in through head office — shown once', async () => {
    // First sign-in: the phone code is SET UP — the identity server records that sign-in as the password alone…
    const firstTime = await journey(adminUser, adminPassword, otpSecrets);
    expect(firstTime.pages).toEqual(['password', 'otp-setup']);
    const firstClaims = JSON.parse(Buffer.from(firstTime.token!.split('.')[1]!, 'base64url').toString()) as { amr?: string[] };
    expect(firstClaims.amr).toEqual(['pwd']);
    const base0 = `http://127.0.0.1:${api!.port}`;
    const tooWeak = await fetch(`${base0}/v1/identity/people`, {
      method: 'POST', headers: { authorization: `Bearer ${firstTime.token!}`, 'content-type': 'application/json', 'idempotency-key': randomBytes(8).toString('hex') },
      body: JSON.stringify({ signInName: `ravi.${run}`, displayName: 'Ravi Shankar' }),
    });
    expect(tooWeak.status, 'a sign-in without the code is not enough to give somebody a sign-in').toBe(403);
    // …so the next sign-in asks for the code, and that one is a two-factor sign-in.
    const signedIn = await journey(adminUser, adminPassword, otpSecrets);
    expect(signedIn.pages).toEqual(['password', 'otp']);
    expect(signedIn.token).toBeDefined();
    const claims = JSON.parse(Buffer.from(signedIn.token!.split('.')[1]!, 'base64url').toString()) as { amr?: string[]; auth_time?: number };
    expect(claims.amr).toEqual(expect.arrayContaining(['pwd', 'otp']));
    expect(typeof claims.auth_time).toBe('number');
    const base = `http://127.0.0.1:${api!.port}`;
    const send = (body: unknown, key = randomBytes(8).toString('hex')) => fetch(`${base}/v1/identity/people`, {
      method: 'POST', headers: { authorization: `Bearer ${signedIn.token!}`, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    });

    // A shared name, and a person who already holds a role, are refused by name.
    const shared = await send({ signInName: 'cashier2', displayName: 'Counter Two' });
    expect(shared.status).toBe(422);
    expect(((await shared.json()) as { code?: string; error?: { code?: string } }).error?.code ?? '').toMatch(/shared_or_generic_sign_in/);
    const holding = await send({ signInName: `holder.${run}`, userId: holder, displayName: 'Holder Person' });
    expect(holding.status).toBe(422);

    const key = randomBytes(8).toString('hex');
    const issued = await send({ signInName: newcomer, displayName: 'Asha Kumar' }, key);
    expect(issued.status, await issued.clone().text()).toBe(201);
    expect(issued.headers.get('cache-control')).toBe('no-store');
    const body = await issued.json() as { oneTimePassword: string; state: string; userId: string };
    expect(body.state).toBe('issued');
    expect(body.oneTimePassword).toMatch(/^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/);
    issuedPassword = body.oneTimePassword;

    // The same request again: answered, but the password is not in the replay.
    const replay = await send({ signInName: newcomer, displayName: 'Asha Kumar' }, key);
    expect(replay.headers.get('idempotent-replay')).toBe('true');
    expect(((await replay.json()) as { oneTimePassword: string }).oneTimePassword).toBe(WITHHELD_ON_REPLAY);
    // Nor anywhere in the database.
    for (const table of ['event_ledger', 'idempotency_keys', 'audit_log']) {
      const leaked = await db!.query(`SELECT count(*)::int AS n FROM ${table} t WHERE t::text LIKE $1`, [`%${issuedPassword}%`]);
      expect((leaked.rows[0] as { n: number }).n, table).toBe(0);
    }
    const kept = await db!.query(`SELECT count(*)::int AS n FROM idempotency_keys t WHERE t::text LIKE $1`, [`%${key}%`]);
    expect((kept.rows[0] as { n: number }).n, 'the reply was kept for replay — without the password').toBe(1);

    // At the identity server: enabled, the product id, the second-factor role.
    const found = (await (await admin('GET', `/users?username=${newcomer}&exact=true&briefRepresentation=false`)).json() as { id: string; enabled: boolean; attributes: Record<string, string[]> }[])[0]!;
    expect(found.enabled).toBe(true);
    expect(found.attributes['sre_user_id']).toEqual([newcomer]);
    const roles = await (await admin('GET', `/users/${found.id}/role-mappings/realm`)).json() as { name: string }[];
    expect(roles.map((r) => r.name)).toContain('sre-privileged');

    const people = await (await fetch(`${base}/v1/identity/people`, { headers: { authorization: `Bearer ${signedIn.token!}` } })).json() as { people: { userId: string; state: string }[] };
    expect(people.people.find((p) => p.userId === newcomer)?.state).toBe('issued');
  });

  it('the person\'s first sign-in: the one-time password works once — they choose their own and set up the phone code', async () => {
    const own = randomBytes(15).toString('base64url');
    const first = await journey(newcomer, issuedPassword, otpSecrets, own);
    expect(first.pages).toEqual(expect.arrayContaining(['password', 'new-password', 'otp-setup']));
    expect(first.token).toBeDefined();
    const claims = JSON.parse(Buffer.from(first.token!.split('.')[1]!, 'base64url').toString()) as { sre_user_id?: string };
    expect(claims.sre_user_id).toBe(newcomer);
    expect((await journey(newcomer, issuedPassword, otpSecrets)).token).toBeUndefined();
    const again = await journey(newcomer, own, otpSecrets);
    expect(again.pages).toEqual(['password', 'otp']);
    expect(again.token).toBeDefined();
  });

  it('ending the sign-in switches it off: the next sign-in is refused', async () => {
    const directory = keycloakDirectory({ baseUrl: BASE!, realm: REALM, clientId: 'sre-provisioner', clientSecret: provisionerSecret, secondFactorRole: 'sre-privileged', fetch: globalThis.fetch });
    expect(await directory.end(newcomer)).toBe('ended');
    const found = (await (await admin('GET', `/users?username=${newcomer}&exact=true&briefRepresentation=false`)).json() as { enabled: boolean; attributes: Record<string, string[]> }[])[0]!;
    expect(found.enabled).toBe(false);
    expect(found.attributes['sre_user_id']).toEqual([newcomer]);
    expect(await directory.end(`nobody-${run}`)).toBe('none');
    const after = await journey(newcomer, issuedPassword, otpSecrets);
    expect(after.token).toBeUndefined();
  });
});
