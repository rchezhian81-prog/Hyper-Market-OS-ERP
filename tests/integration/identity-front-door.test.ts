import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { createSignInHandler, type SignInRequest } from '../../services/identity/src/sign-in';
import { jwksKeyring } from '../../services/identity/src/jwks';
import { startApi, type RunningApi } from '../../services/api/src/main';
import { TEST_IDP } from '../support/api-harness';
import { ensureAppRole, asRole } from '../support/db-app-role';

/**
 * **The trial server's front door, signed in through the identity server — the REAL nginx configuration, the REAL
 * sign-in service, the REAL head-office service and a REAL Keycloak, end to end (OB-15-b · ADR-0019).**
 *
 * Opt-in: it needs a running Keycloak with the repository realm, nginx on this machine and a migrated database
 * (`KEYCLOAK_PROOF_BASE`, `KEYCLOAK_PROOF_ADMIN_PASSWORD_FILE`, `KEYCLOAK_PROOF_TENANT`, `KEYCLOAK_PROOF_DATABASE_URL`;
 * runbook: identity server). It runs `infra/compose/nginx.identity.conf` itself — only the private addresses of the
 * services behind it are pointed at this machine — on 127.0.0.1:8099, the screens' address the realm returns to.
 *
 * It proves the switch-over the administrator will make:
 *   • a screen with no session goes to the sign-in, the sign-in to the identity server's page, and back;
 *   • the store computer (here a stand-in that echoes what it was told) hears the signed-in person — and a visitor's own
 *     `X-Sre-User` header is overwritten;
 *   • a head-office call through the front door carries the session's token (no token is ever in a cookie): 200 signed
 *     in, 401 without;
 *   • sign-out ends it: the screen sends the person back to the sign-in.
 */

const BASE = process.env['KEYCLOAK_PROOF_BASE'];
const ADMIN_PW_FILE = process.env['KEYCLOAK_PROOF_ADMIN_PASSWORD_FILE'];
const TENANT = process.env['KEYCLOAK_PROOF_TENANT'];
const DATABASE_URL = process.env['KEYCLOAK_PROOF_DATABASE_URL'];
const NGINX = ['/usr/sbin/nginx', '/usr/bin/nginx'].find((p) => existsSync(p));
const READY = BASE !== undefined && ADMIN_PW_FILE !== undefined && TENANT !== undefined && DATABASE_URL !== undefined && NGINX !== undefined;
const FRONT = 'http://127.0.0.1:8099';
const ISSUER = `${BASE}/realms/sre-store`;

const listen = (server: Server): Promise<number> => new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)); });

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

describe.skipIf(!READY)('the front door, signed in through the identity server, end to end (OB-15-b)', () => {
  const run = randomBytes(3).toString('hex');
  const userId = `u-front-door-${run}`;
  const password = randomBytes(18).toString('base64url');
  let api: RunningApi | undefined;
  const servers: Server[] = [];
  let nginx: ChildProcess | undefined;
  const heard: { path: string; user: string | undefined }[] = [];

  beforeAll(async () => {
    // A person in the identity server, as the product's provisioning will make them.
    const tokenRes = await fetch(`${BASE}/realms/master/protocol/openid-connect/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: process.env['KEYCLOAK_PROOF_ADMIN_USER'] ?? 'kcadmin', password: readFileSync(ADMIN_PW_FILE!, 'utf8').trim() }).toString(),
    });
    const admin = ((await tokenRes.json()) as { access_token: string }).access_token;
    const created = await fetch(`${BASE}/admin/realms/sre-store/users`, {
      method: 'POST', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
      body: JSON.stringify({ username: userId, enabled: true, attributes: { sre_user_id: [userId] }, credentials: [{ type: 'password', value: password, temporary: false }] }),
    });
    expect(created.status).toBe(201);

    // The real head-office service, believing the identity server; this person is the tenant's first owner.
    const platform = new Pool({ connectionString: DATABASE_URL });
    try { await ensureAppRole(platform, 'sre_app_front_door_proof'); } finally { await platform.end(); }
    const pilot = TEST_IDP.policy();
    const said: string[] = [];
    api = await startApi({
      DATABASE_URL: asRole(DATABASE_URL!, 'sre_app_front_door_proof'), PACK_SIGNING_KEY: ['proof', 'pack', 'key'].join('-').padEnd(48, '0'),
      IDP_SIGNING_KEY: pilot.secret, IDP_ISSUER: pilot.issuer, IDP_AUDIENCE: 'sre-retail-os-api',
      IDP_OIDC_ISSUER: ISSUER, IDP_OIDC_JWKS_URL: `${ISSUER}/protocol/openid-connect/certs`,
      PORT: '0', NODE_ENV: 'test', MIGRATION_TARGET_KIND: 'rehearsal',
      BOOTSTRAP_OWNER_TENANT_ID: TENANT, BOOTSTRAP_OWNER_USER_ID: userId,
    }, (t) => { said.push(t); }, (t) => { said.push(t); });
    expect(api, said.join('')).toBeDefined();

    // The product's sign-in service.
    const keyring = jwksKeyring({ url: `${ISSUER}/protocol/openid-connect/certs`, fetch: globalThis.fetch });
    await keyring.refresh();
    const signIn = createSignInHandler({
      settings: { issuer: ISSUER, internalIssuer: ISSUER, clientId: 'sre-web', origin: FRONT },
      policy: { algorithm: 'RS256', secret: '', keyring, subjectClaim: 'sre_user_id', issuer: ISSUER, audience: 'sre-retail-os-api', maxLifetimeSeconds: 2_678_400 },
      fetch: globalThis.fetch, now: () => Date.now(), audit: () => {},
    });
    const signInServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
        void signIn({ method: req.method ?? 'GET', url: req.url ?? '/', headers, body: Buffer.concat(chunks).toString('utf8') } as SignInRequest)
          .then((out) => { res.writeHead(out.status, out.headers).end(out.body); });
      });
    });
    servers.push(signInServer);
    const signInPort = await listen(signInServer);

    // A stand-in for the store computer's relay: it says what the front door told it.
    const relay = createServer((req, res) => {
      heard.push({ path: req.url ?? '', user: req.headers['x-sre-user'] as string | undefined });
      res.writeHead(200, { 'content-type': 'text/plain' }).end(`store computer: ${String(req.headers['x-sre-user'])}`);
    });
    servers.push(relay);
    const relayPort = await listen(relay);

    // The REAL front-door configuration; only the private addresses behind it point at this machine.
    const dir = mkdtempSync(join(tmpdir(), 'sre-front-door-'));
    const conf = readFileSync('infra/compose/nginx.identity.conf', 'utf8')
      .replace(/listen 80;/, 'listen 127.0.0.1:8099;')
      .replaceAll('sign-in:8092', `127.0.0.1:${signInPort}`)
      .replaceAll('api:8081', `127.0.0.1:${api!.port}`)
      .replaceAll('edge:8096', `127.0.0.1:${relayPort}`)
      .replace('root /usr/share/nginx/html;', `root ${dir};`);
    writeFileSync(join(dir, 'front.conf'), conf);
    writeFileSync(join(dir, 'nginx.conf'), `pid ${dir}/nginx.pid;\nerror_log ${dir}/error.log;\nevents {}\nhttp {\n access_log off;\n client_body_temp_path ${dir};\n proxy_temp_path ${dir};\n include ${dir}/front.conf;\n}\n`);
    execFileSync(NGINX!, ['-t', '-c', join(dir, 'nginx.conf')], { stdio: 'pipe' });
    nginx = spawn(NGINX!, ['-c', join(dir, 'nginx.conf'), '-g', 'daemon off;'], { stdio: 'ignore' });
    for (let i = 0; i < 50; i += 1) { try { await fetch(`${FRONT}/login/verify`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  }, 60_000);

  afterAll(async () => {
    nginx?.kill('SIGTERM');
    for (const s of servers) s.close();
    await api?.stop();
  });

  it('screen → sign-in → identity server → back; the store computer hears the person; head office believes the session; sign-out ends it', async () => {
    const jar = new Jar();
    const get = async (url: string, headers: Record<string, string> = {}) => {
      const res = await fetch(url.startsWith('http') ? url : `${FRONT}${url}`, { redirect: 'manual', headers: { ...headers, ...(jar.cookies.size === 0 ? {} : { cookie: jar.header() }) } });
      jar.take(res);
      return res;
    };

    // 1 — no session: the screen sends the person to the sign-in, the sign-in to the identity server.
    const screen = await get('/store/manager/');
    expect(screen.status).toBe(302);
    expect(screen.headers.get('location')).toBe('/login/?next=/store/manager/');
    const start = await get('/login/?next=/store/manager/');
    expect(start.status).toBe(303);
    expect(start.headers.get('location')!.startsWith(`${ISSUER}/protocol/openid-connect/auth?`)).toBe(true);

    // 2 — the person signs in on the identity server's own page, and comes back through the front door.
    const kc = new Jar();
    const page = await fetch(start.headers.get('location')!, { redirect: 'manual' });
    kc.take(page);
    const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(await page.text())?.[1]?.replace(/&amp;/g, '&');
    expect(action).toBeDefined();
    const posted = await fetch(action!, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: kc.header() },
      body: new URLSearchParams({ username: userId, password }).toString(),
    });
    const back = posted.headers.get('location')!;
    expect(back.startsWith(`${FRONT}/login/callback?`)).toBe(true);
    const landed = await get(back);
    expect(landed.status).toBe(303);
    expect(landed.headers.get('location')).toBe('/store/manager/');
    expect([...jar.cookies.keys()]).toEqual(['sre_session']);

    // 3 — the screen opens; the store computer hears the signed-in person, whatever the visitor claims.
    const opened = await get('/store/manager/', { 'x-sre-user': 'u-somebody-else' });
    expect(opened.status).toBe(200);
    expect(await opened.text()).toBe(`store computer: ${userId}`);

    // 4 — a head-office call through the front door carries the session's token; without the session, 401.
    expect((await get('/v1/approvals/requests')).status).toBe(200);
    expect((await fetch(`${FRONT}/v1/approvals/requests`)).status).toBe(401);

    // 5 — sign-out ends it: the browser goes to the identity server's sign-out, and the screen asks to sign in again.
    const out = await fetch(`${FRONT}/login/logout`, { method: 'POST', redirect: 'manual', headers: { cookie: jar.header(), origin: FRONT } });
    expect(new URL(out.headers.get('location')!).pathname).toBe('/realms/sre-store/protocol/openid-connect/logout');
    expect((await get('/store/manager/')).status).toBe(302);
    expect(heard.every((h) => h.user === userId)).toBe(true);
  });
});
