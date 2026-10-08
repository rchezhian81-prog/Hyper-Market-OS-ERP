import { describe, it, expect, beforeAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { verifyToken } from '../../services/identity/src/token';
import { jwksKeyring } from '../../services/identity/src/jwks';
import { startApi } from '../../services/api/src/main';
import { TEST_IDP } from '../support/api-harness';
import { ensureAppRole, asRole } from '../support/db-app-role';
import { Pool } from 'pg';

/**
 * **Against a REAL Keycloak with the repository's own realm file: a person signs in the way a browser does, and head
 * office believes the token — checked against the server's published keys (OB-15 · ADR-0019 · M02-FR-01 · SEC-03).**
 *
 * Opt-in, because it needs a running Keycloak (`infra/keycloak/realm-sre-store.json` imported). Run it with
 * `KEYCLOAK_PROOF_BASE=http://127.0.0.1:8180 KEYCLOAK_PROOF_ADMIN_PASSWORD_FILE=<file> KEYCLOAK_PROOF_TENANT=<tenant>`; the
 * runbook says how to start one. Without those it skips and says so — it is evidence recorded with each release that
 * touches identity, not a substitute for the always-on unit proofs (`identity-server-tokens.test.ts`).
 *
 * What it proves on the real server:
 *   • the authorisation-code flow with PKCE (S256) is the way in; the password grant is off;
 *   • the token carries the product's person (`sre_user_id`), the shop (`tenant_id`), our audience and `amr`, and head
 *     office's verifier accepts it against the keys the server publishes — and refuses it once a byte is changed;
 *   • a person holding `sre-privileged` is stopped after the password and asked for a second factor — no token yet;
 *   • five wrong passwords lock the account: the right password is then refused too.
 * Every password here is generated at run time.
 */

const BASE = process.env['KEYCLOAK_PROOF_BASE'];
const ADMIN_PW_FILE = process.env['KEYCLOAK_PROOF_ADMIN_PASSWORD_FILE'];
const TENANT = process.env['KEYCLOAK_PROOF_TENANT'];
const ORIGIN = process.env['KEYCLOAK_PROOF_WEB_ORIGIN'] ?? 'http://127.0.0.1:8099';
const READY = BASE !== undefined && ADMIN_PW_FILE !== undefined && TENANT !== undefined;
/** A migrated database for the head-office service step (optional — that step skips without it). */
const DATABASE_URL = process.env['KEYCLOAK_PROOF_DATABASE_URL'];
const REALM = 'sre-store';
const ISSUER = `${BASE}/realms/${REALM}`;

/** A cookie jar just big enough for one sign-in. */
class Jar {
  private readonly cookies = new Map<string, string>();
  take(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const eq = pair!.indexOf('=');
      this.cookies.set(pair!.slice(0, eq), pair!.slice(eq + 1));
    }
  }
  header(): string { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
}

let adminToken = '';
const admin = async (method: string, path: string, body?: unknown): Promise<Response> => fetch(`${BASE}/admin/realms/${REALM}${path}`, {
  method, headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** Create a person the way the product's provisioning will: username = the product's id, carried as `sre_user_id`. */
async function person(userId: string, opts: { privileged?: boolean } = {}): Promise<string> {
  const password = randomBytes(18).toString('base64url');
  const created = await admin('POST', '/users', {
    username: userId, enabled: true, attributes: { sre_user_id: [userId] },
    credentials: [{ type: 'password', value: password, temporary: false }],
  });
  expect(created.status, await created.clone().text()).toBe(201);
  if (opts.privileged === true) {
    const id = (created.headers.get('location') ?? '').split('/').pop()!;
    const role = await (await admin('GET', '/roles/sre-privileged')).json() as unknown;
    expect((await admin('POST', `/users/${id}/role-mappings/realm`, [role])).status).toBe(204);
  }
  return password;
}

/** Sign in as a browser does: authorisation request with PKCE, the login form, the redirect, the code exchange. */
async function signIn(username: string, password: string): Promise<{ token?: string; page: string; status: number }> {
  const jar = new Jar();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const redirect = `${ORIGIN}/auth/callback`;
  const authUrl = `${ISSUER}/protocol/openid-connect/auth?${new URLSearchParams({
    client_id: 'sre-web', response_type: 'code', scope: 'openid', redirect_uri: redirect,
    code_challenge: challenge, code_challenge_method: 'S256', state: randomBytes(8).toString('hex'),
  })}`;
  const form = await fetch(authUrl, { redirect: 'manual' });
  jar.take(form);
  const html = await form.text();
  const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, '&');
  expect(action, 'the login form is shown').toBeDefined();
  const posted = await fetch(action!, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() },
    body: new URLSearchParams({ username, password }).toString(),
  });
  jar.take(posted);
  const location = posted.headers.get('location');
  if (posted.status !== 302 || location === null || !location.startsWith(redirect)) {
    return { page: `${location ?? ''}\n${await posted.text()}`, status: posted.status };
  }
  const code = new URL(location).searchParams.get('code')!;
  const exchanged = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'sre-web', code, redirect_uri: redirect, code_verifier: verifier }).toString(),
  });
  const body = await exchanged.json() as { access_token?: string };
  return { ...(body.access_token === undefined ? {} : { token: body.access_token }), page: '', status: exchanged.status };
}

describe.skipIf(!READY)('a real Keycloak, with the repository realm, signs a person in and head office believes it (OB-15)', () => {
  const run = randomBytes(3).toString('hex');
  const keyring = jwksKeyring({ url: `${ISSUER}/protocol/openid-connect/certs`, fetch: globalThis.fetch });
  const policy = () => ({
    algorithm: 'RS256' as const, secret: '', keyring, subjectClaim: 'sre_user_id',
    issuer: ISSUER, audience: 'sre-retail-os-api', maxLifetimeSeconds: 2_678_400,
  });

  beforeAll(async () => {
    const res = await fetch(`${BASE}/realms/master/protocol/openid-connect/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: process.env['KEYCLOAK_PROOF_ADMIN_USER'] ?? 'kcadmin', password: readFileSync(ADMIN_PW_FILE!, 'utf8').trim() }).toString(),
    });
    adminToken = ((await res.json()) as { access_token: string }).access_token;
    expect(await keyring.refresh()).toBeGreaterThan(0);
  });

  it('the password grant is off for the product client: the way in is the browser flow', async () => {
    const res = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: 'sre-web', username: 'anyone', password: randomBytes(12).toString('hex') }).toString(),
    });
    expect([400, 401]).toContain(res.status);
    expect(((await res.json()) as { error?: string }).error).toBe('unauthorized_client');
  });

  it('a person signs in with code + PKCE; head office verifies the token against the published keys, and refuses it changed', async () => {
    const userId = `u-cashier-${run}`;
    const password = await person(userId);
    const attempt = await signIn(userId, password);
    const token = attempt.token;
    expect(token, `a token was issued (the last answer was ${attempt.status})`).toBeDefined();
    const verdict = verifyToken(token!, policy(), Date.now());
    expect(verdict.ok, verdict.detail).toBe(true);
    expect(verdict.principal).toMatchObject({ userId, tenantId: TENANT, amr: expect.arrayContaining(['pwd']) });
    const [h, p, s] = token!.split('.');
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString('utf8')) as Record<string, unknown>;
    const changed = `${h}.${Buffer.from(JSON.stringify({ ...payload, sre_user_id: 'u-owner' })).toString('base64url')}.${s}`;
    expect(verifyToken(changed, policy(), Date.now()).refusedBecause).toBe('signature_does_not_verify');
  });

  it('a privileged person is stopped after the password and asked for a second factor — no token yet', async () => {
    const userId = `u-owner-${run}`;
    const password = await person(userId, { privileged: true });
    const outcome = await signIn(userId, password);
    expect(outcome.token).toBeUndefined();
    // The next page sets up or asks for the one-time code (first sign-in: set it up).
    expect(outcome.page).toMatch(/otp|totp|authenticator/i);
  });

  it('five wrong passwords lock the account; the right one is then refused too', async () => {
    const userId = `u-locked-${run}`;
    const password = await person(userId);
    for (let i = 0; i < 5; i += 1) expect((await signIn(userId, `${password}-wrong`)).token).toBeUndefined();
    expect((await signIn(userId, password)).token).toBeUndefined();
  });

  it.skipIf(DATABASE_URL === undefined)('the REAL head-office service, configured with the identity server, lets that person in and nobody else', async () => {
    const userId = `u-boss-${run}`;
    const password = await person(userId);
    const { token } = await signIn(userId, password);
    expect(token).toBeDefined();
    const said: string[] = [];
    const pilot = TEST_IDP.policy();
    // The service refuses an all-powerful database login (row-level security); it runs as the restricted application role.
    const platform = new Pool({ connectionString: DATABASE_URL });
    try { await ensureAppRole(platform, 'sre_app_keycloak_proof'); } finally { await platform.end(); }
    const api = await startApi({
      DATABASE_URL: asRole(DATABASE_URL!, 'sre_app_keycloak_proof'), PACK_SIGNING_KEY: ['proof', 'pack', 'key'].join('-').padEnd(48, '0'),
      IDP_SIGNING_KEY: pilot.secret, IDP_ISSUER: pilot.issuer, IDP_AUDIENCE: 'sre-retail-os-api',
      IDP_OIDC_ISSUER: ISSUER, IDP_OIDC_JWKS_URL: `${ISSUER}/protocol/openid-connect/certs`,
      PORT: '0', NODE_ENV: 'test', MIGRATION_TARGET_KIND: 'rehearsal',
      // The person Keycloak signed in is this tenant's first owner, so a read they may do proves who they are.
      BOOTSTRAP_OWNER_TENANT_ID: TENANT, BOOTSTRAP_OWNER_USER_ID: userId,
    }, (t) => { said.push(t); }, (t) => { said.push(t); });
    expect(api, said.join('')).toBeDefined();
    try {
      expect(said.join('')).toMatch(/identity server: [1-9]\d* signing key\(s\) held/);
      const base = `http://127.0.0.1:${api!.port}`;
      const asThem = await fetch(`${base}/v1/approvals/requests`, { headers: { authorization: `Bearer ${token!}` } });
      expect(asThem.status).toBe(200);
      expect((await fetch(`${base}/v1/approvals/requests`)).status).toBe(401);
      const [h, p, sig] = token!.split('.');
      const other = Buffer.from(JSON.stringify({ ...(JSON.parse(Buffer.from(p!, 'base64url').toString('utf8')) as object), sre_user_id: 'u-someone-else' })).toString('base64url');
      expect((await fetch(`${base}/v1/approvals/requests`, { headers: { authorization: `Bearer ${h}.${other}.${sig}` } })).status).toBe(401);
    } finally {
      await api!.stop();
    }
  });
});
