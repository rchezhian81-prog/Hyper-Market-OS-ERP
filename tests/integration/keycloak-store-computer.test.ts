import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { startApi, type RunningApi } from '../../services/api/src/main';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { TEST_IDP } from '../support/api-harness';
import { LocalIdp } from '../support/local-idp';
import { ensureAppRole, asRole } from '../support/db-app-role';

/**
 * **Against a REAL Keycloak with the repository realm: on the store PC a person signs in to head office through the store
 * computer — password AND one-time code — and the store computer carries THAT person's session to the REAL head-office
 * service (OB-388 · ADR-0029 · ADR-0019).**
 *
 * Opt-in like the other real-Keycloak suites (`scripts/identity-proof.sh`, runbook: identity server): a running Keycloak
 * with `infra/keycloak/realm-sre-store.json` imported and a freshly migrated database. The store computer is a REAL box
 * (`startEdge`) on the store PC's own screen address, `127.0.0.1:8091` — the loopback callback the realm now allows — and
 * head office is the REAL API, believing the identity server's tokens. It proves, on the real server:
 *   • the box sends the person to Keycloak with PKCE and `prompt=login`; a privileged person sets up and then gives a
 *     one-time code; back on the box, the session is the box's (an HttpOnly cookie, no token in the browser);
 *   • a head-office call through the box reaches the REAL API as that person and is answered (200) — with no session it
 *     is refused by the box and never sent;
 *   • a person with a password only (no second step) is refused at the box, and has no session;
 *   • Sign out ends it.
 * Every password and code is made at run time.
 */

const BASE = process.env['KEYCLOAK_PROOF_BASE'];
const ADMIN_PW_FILE = process.env['KEYCLOAK_PROOF_ADMIN_PASSWORD_FILE'];
const TENANT = process.env['KEYCLOAK_PROOF_TENANT'];
const DATABASE_URL = process.env['KEYCLOAK_PROOF_DATABASE_URL'];
const READY = BASE !== undefined && ADMIN_PW_FILE !== undefined && TENANT !== undefined && DATABASE_URL !== undefined;
const REALM = 'sre-store';
const ISSUER = `${BASE}/realms/${REALM}`;
const BOX_PORT = 8091; // the installer's screen port — the loopback callback the realm allows (OB-388)
const BOX = `http://127.0.0.1:${BOX_PORT}`;
const KEY = ['kc', 'store', 'pc', 'signing', 'key'].join('-').padEnd(48, '0');

class Jar {
  readonly cookies = new Map<string, string>();
  readonly raw: string[] = [];
  take(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      this.raw.push(c);
      const [pair] = c.split(';');
      const eq = pair!.indexOf('=');
      const v = pair!.slice(eq + 1);
      if (v === '') this.cookies.delete(pair!.slice(0, eq)); else this.cookies.set(pair!.slice(0, eq), v);
    }
  }
  header(): string { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
}

const usedWindow = new Map<string, number>();
function totp(secret: Buffer, at: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac('sha1', secret).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
/** A fresh RFC 6238 code — the server refuses a code used twice. */
async function freshCode(username: string, secret: Buffer): Promise<string> {
  let window = Math.floor(Date.now() / 30_000);
  while (window <= (usedWindow.get(username) ?? -1)) { await new Promise((r) => setTimeout(r, 1000)); window = Math.floor(Date.now() / 30_000); }
  usedWindow.set(username, window);
  return totp(secret, window * 30_000 + 1);
}
const attr = (html: string, re: RegExp): string | undefined => re.exec(html)?.[1]?.replace(/&amp;/g, '&');
const actionOf = (html: string, formId: string): string | undefined =>
  attr(html, new RegExp(`<form[^>]*id="${formId}"[^>]*action="([^"]+)"`)) ?? attr(html, new RegExp(`<form[^>]*action="([^"]+)"[^>]*id="${formId}"`));

describe.skipIf(!READY).sequential('a real Keycloak: the store computer carries the person\'s own head-office session (OB-388)', { timeout: 120_000 }, () => {
  const run = randomBytes(3).toString('hex');
  const privileged = `u-storepc-${run}`;
  const passwordOnly = `u-storepc-pwd-${run}`;
  const passwords = new Map<string, string>();
  const otpSecrets = new Map<string, Buffer>();
  let adminToken = '';
  let api: RunningApi | undefined;
  let edge: EdgeProcess | undefined;
  let dir = '';

  const admin = (method: string, path: string, body?: unknown): Promise<Response> => fetch(`${BASE}/admin/realms/${REALM}${path}`, {
    method, headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const person = async (userId: string, opts: { privileged: boolean }): Promise<void> => {
    const password = randomBytes(18).toString('base64url');
    passwords.set(userId, password);
    const created = await admin('POST', '/users', { username: userId, enabled: true, attributes: { sre_user_id: [userId] }, credentials: [{ type: 'password', value: password, temporary: false }] });
    expect(created.status, await created.clone().text()).toBe(201);
    if (opts.privileged) {
      const id = (created.headers.get('location') ?? '').split('/').pop()!;
      const role = await (await admin('GET', '/roles/sre-privileged')).json() as unknown;
      expect((await admin('POST', `/users/${id}/role-mappings/realm`, [role])).status).toBe(204);
    }
  };

  beforeAll(async () => {
    const res = await fetch(`${BASE}/realms/master/protocol/openid-connect/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: process.env['KEYCLOAK_PROOF_ADMIN_USER'] ?? 'kcadmin', password: readFileSync(ADMIN_PW_FILE!, 'utf8').trim() }).toString(),
    });
    adminToken = ((await res.json()) as { access_token: string }).access_token;
    await person(privileged, { privileged: true });
    await person(passwordOnly, { privileged: false });

    // The REAL head-office service, believing the identity server; the privileged person is the shop's first owner.
    const platform = new Pool({ connectionString: DATABASE_URL });
    try { await ensureAppRole(platform, 'sre_app_store_pc_proof'); } finally { await platform.end(); }
    const pilot = TEST_IDP.policy();
    const said: string[] = [];
    api = await startApi({
      DATABASE_URL: asRole(DATABASE_URL!, 'sre_app_store_pc_proof'), PACK_SIGNING_KEY: ['proof', 'pack', 'key'].join('-').padEnd(48, '0'), BOX_HISTORY_SEAL_KEY: ['proof', 'seal', 'key'].join('-').padEnd(48, '1'),
      IDP_SIGNING_KEY: pilot.secret, IDP_ISSUER: pilot.issuer, IDP_AUDIENCE: 'sre-retail-os-api',
      IDP_OIDC_ISSUER: ISSUER, IDP_OIDC_JWKS_URL: `${ISSUER}/protocol/openid-connect/certs`,
      PORT: '0', NODE_ENV: 'test', MIGRATION_TARGET_KIND: 'rehearsal',
      BOOTSTRAP_OWNER_TENANT_ID: TENANT, BOOTSTRAP_OWNER_USER_ID: privileged,
    }, (t) => { said.push(t); }, (t) => { said.push(t); });
    expect(api, said.join('')).toBeDefined();

    // The REAL store computer, on the store PC's own screen address; its setup names both people at this store.
    dir = await mkdtemp(join(tmpdir(), 'sre-kc-store-pc-'));
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1' },
      people: [{ userId: privileged, displayName: 'Proof Owner', roleId: 'owner' }, { userId: passwordOnly, displayName: 'Proof Clerk', roleId: 'owner' }],
      roles: [{ id: 'owner', name: 'Owner', permissions: ['identity.self.read', 'finance.period.read', 'approvals.request.read'] }],
      roleAssignments: [{ userId: privileged, roleId: 'owner', branchScope: 'all' }, { userId: passwordOnly, roleId: 'owner', branchScope: 'all' }],
    }), 'utf8');
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT!, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_PACK_FILE: packFile,
      EDGE_SCREEN_PORT: String(BOX_PORT), EDGE_APPS_DIR: 'apps',
      CLOUD_API_URL: `http://127.0.0.1:${api!.port}`, // A box token head office believes (ITS audience, sre-retail-os-api): any other fails sign-in on every background pass, and five failures from
      // 127.0.0.1 lock that address — the same one the person's carried session arrives from (the intermittent 429).
      CLOUD_API_TOKEN: new LocalIdp({ ...pilot, audience: 'sre-retail-os-api' }).issue({ sub: 'u-box', tenantId: TENANT!, branchId: 'store-1' }), EDGE_HEAD_OFFICE_SIGN_IN_ISSUER: ISSUER,
    }, () => {}))!;
  }, 120_000);

  afterAll(async () => {
    await edge?.stop();
    await api?.stop();
    if (dir !== '') await rm(dir, { recursive: true, force: true });
  });

  /** The person's browser on the store PC: start at the box, answer Keycloak's pages, come back to the box's callback. */
  const signInThroughTheBox = async (username: string): Promise<{ box: Jar; landed: Response; pages: string[] }> => {
    const box = new Jar();
    const kc = new Jar();
    const pages: string[] = [];
    const start = await fetch(`${BOX}/login/?next=%2Ffinance-close%2F`, { redirect: 'manual' });
    expect(start.status, await start.clone().text()).toBe(303);
    const auth = new URL(start.headers.get('location')!);
    expect(auth.searchParams.get('prompt')).toBe('login');
    let res = await fetch(auth, { redirect: 'manual' });
    kc.take(res);
    for (let step = 0; step < 8; step += 1) {
      const location = res.headers.get('location');
      if (location !== null && location.startsWith(`${BOX}/login/callback`)) {
        const landed = await fetch(location, { redirect: 'manual' });
        box.take(landed);
        return { box, landed, pages };
      }
      if (location !== null) { res = await fetch(location, { redirect: 'manual', headers: { cookie: kc.header() } }); kc.take(res); continue; }
      const html = await res.text();
      const post = async (action: string, fields: Record<string, string>): Promise<void> => {
        res = await fetch(action, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: kc.header() }, body: new URLSearchParams(fields).toString() });
        kc.take(res);
      };
      const login = actionOf(html, 'kc-form-login');
      const setup = actionOf(html, 'kc-totp-settings-form');
      const otp = actionOf(html, 'kc-otp-login-form');
      if (login !== undefined && !pages.includes('password')) { pages.push('password'); await post(login, { username, password: passwords.get(username)! }); continue; }
      if (setup !== undefined) {
        const secret = attr(html, /name="totpSecret"[^>]*value="([^"]+)"/) ?? attr(html, /value="([^"]+)"[^>]*name="totpSecret"/);
        otpSecrets.set(username, Buffer.from(secret!, 'utf8'));
        pages.push('otp-setup');
        await post(setup, { totp: await freshCode(username, otpSecrets.get(username)!), totpSecret: secret!, userLabel: 'proof phone' });
        continue;
      }
      if (otp !== undefined && otpSecrets.has(username) && !pages.includes('otp')) { pages.push('otp'); await post(otp, { otp: await freshCode(username, otpSecrets.get(username)!) }); continue; }
      throw new Error(`stuck on a Keycloak page after ${pages.join(' → ')}: ${html.slice(0, 300)}`);
    }
    throw new Error('too many steps');
  };

  it('password and a one-time code, through the box; the REAL head office answers the carried session; none → never sent', async () => {
    // The first sign-in SETS UP the one-time code (Keycloak records only `pwd` for it), so a second sign-in with the code is
    // the one that carries the second step (ADR-0019 part 4).
    const first = await signInThroughTheBox(privileged);
    expect(first.pages).toContain('otp-setup');
    const { box, landed, pages } = await signInThroughTheBox(privileged);
    expect(pages).toEqual(['password', 'otp']);
    expect(landed.status, await landed.clone().text()).toBe(200);
    const cookie = box.raw.find((c) => c.startsWith('sre_session='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).not.toMatch(/eyJ/);
    const asThem = await fetch(`${BOX}/v1/approvals/requests`, { headers: { cookie: box.header(), accept: 'application/json' } });
    expect(asThem.status, await asThem.clone().text()).toBe(200);
    const none = await fetch(`${BOX}/v1/approvals/requests`, { headers: { accept: 'application/json' } });
    expect(none.status).toBe(401);
    expect(((await none.json()) as { error: { code: string } }).error.code).toBe('head_office_sign_in_needed');
    // Sign out ends it.
    const out = await fetch(`${BOX}/office/sign-out`, { method: 'POST', redirect: 'manual', headers: { cookie: box.header(), 'sec-fetch-site': 'same-origin' } });
    expect(out.status).toBe(303);
    expect((await fetch(`${BOX}/v1/approvals/requests`, { headers: { cookie: box.header() } })).status).toBe(401);
  });

  it('a person with a password only (no second step) is refused at the box and has no session', async () => {
    const { box, landed } = await signInThroughTheBox(passwordOnly);
    expect(landed.status).toBe(401);
    expect(await landed.text()).toContain('second step');
    expect((await fetch(`${BOX}/v1/approvals/requests`, { headers: { cookie: box.header() } })).status).toBe(401);
  });

  it('the box asks Keycloak for the password every time (prompt=login): a remembered Keycloak sign-in is not reused', async () => {
    const start = await fetch(`${BOX}/login/?next=%2Ffinance-close%2F`, { redirect: 'manual' });
    const res = await fetch(start.headers.get('location')!, { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/id="kc-form-login"/);
  });
});
