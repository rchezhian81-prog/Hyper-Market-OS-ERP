import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { REMOTE_ACCESS_KIND, REMOTE_ACCESS_LOG } from '../../edge/store-edge/src/remote-door';
import { readLog } from '../../edge/store-edge/src/file-log';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { prepareTillBox, pinOf, signInAtLane, operatorHeader, receiptNumberAt } from '../support/till-operator';
import type { HttpRequest } from '../../services/kernel/src/index';

/**
 * **OB-840 · ADR-0035 — the owner reaches Today, the reports and his approvals from outside the shop (owner's decision
 * 18 Nov 2026, "1A, 2A, 3A, 4A, 5A"), on the REAL till service (`startEdge`) and the office API's REAL pipeline.**
 *
 * The relay (a small server in India) signs the owner in with his password and a one-time code and hands each request,
 * with the identity server's token, down the line the store PC dialled out. The line ends at the store PC's REMOTE door
 * (its own loopback listener). Proven here, with a synthetic identity server key pinned as `remote-access setup` pins it:
 *   • refused: no token; a token signed by another key; another issuer; an expired token; a sign-in without the one-time
 *     code; a person who is not the owner; the till, software update, users & roles, privilege acts, price publishing,
 *     the PIN sign-in; an approval that changes a person's access;
 *   • allowed: Today, the reports, the approvals inbox — and approve / reject, recorded IN HIS NAME exactly as in the store,
 *     plus the mark that it came remotely ('remote'), on head office's record and on the door's own log;
 *   • the till sells with the link down, and Today says the link's state in plain words (P-08).
 * Synthetic data only.
 */

const T = randomUUID();
const KEY = ['ob840', 'remote', 'door', 'box'].join('-').padEnd(48, '0');
const PRIVILEGE_SECRET = randomBytes(32).toString('base64url');
const HOST = 'remote.example.test';
const ISSUER = `https://${HOST}/auth/realms/sre-store`;
const AUDIENCE = 'sre-retail-os-api';
const OWNER_PERMS = ['identity.self.read', 'till.dayclose.read', 'reporting.report.read'];
const PACK = {
  version: 1,
  policies: { storeId: 'S1', branchId: 'S1', tradingDayCutoff: '00:00', warehouseId: 'wh-1' },
  lossPreventionRules: [], devices: [],
  roles: [
    { id: 'owner', name: 'Owner', permissions: OWNER_PERMS },
    { id: 'store_manager', name: 'Store manager', permissions: OWNER_PERMS },
    { id: 'cashier', name: 'Cashier', permissions: ['identity.self.read', 'pos.sale.sync'] },
  ],
  roleAssignments: [
    { userId: 'u-owner', roleId: 'owner', branchScope: 'all' }, { userId: 'u-mgr', roleId: 'store_manager', branchScope: 'all' },
  ],
};
const SALT = { sku: 'SKU-SALT', name: 'Synthetic Salt 1kg', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'active', mrpHistory: [{ value: { minor: 2_800, currency: 'INR' }, effectiveFrom: '2026-01-01' }] };

// ── The relay's identity server, synthetic: its signing key (the store PC pins the PUBLIC half) ───────────────────
const realm = generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'realm-key-1';
const jwks = { keys: [{ ...(realm.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: KID, use: 'sig', alg: 'RS256' }] };

function token(over: { userId?: string; amr?: string[]; iss?: string; exp?: number; key?: KeyObject; tenant?: string } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'RS256', kid: KID, typ: 'JWT' });
  const body = b64({
    iss: over.iss ?? ISSUER, aud: [AUDIENCE, 'account'], sub: randomUUID(), sre_user_id: over.userId ?? 'u-owner', tenant_id: over.tenant ?? T,
    iat: now - 10, auth_time: now - 60, exp: over.exp ?? now + 300, amr: over.amr ?? ['pwd', 'otp'], jti: randomUUID(),
  });
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), over.key ?? realm.privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

/** The office API's real pipeline, served over HTTP on this PC's loopback (as SRE-API is on the store PC). */
async function officeApi(): Promise<{ h: ApiHarness; url: string }> {
  const h = apiHarness({ privilegeSealSecret: PRIVILEGE_SECRET });
  await h.seedOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-mgr', 'store_manager');
  await h.provisionRole(T, 'u-box', 'store_computer', ['S1']);
  const owner = async (path: string, body: unknown) => {
    const r = await h.request({ method: 'POST', path, userId: 'u-owner', tenantId: T, idempotencyKey: `k-${randomUUID()}`, body });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  };
  await owner('/v1/catalogue/categories/grocery', { name: 'Grocery', parentId: null });
  await owner('/v1/catalogue/tax-classes/25010020/rates/2017-07-01', { rateBps: 500 });
  await owner('/v1/catalogue/products/SALT/publish', { product: SALT });
  const server: Server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://x');
        const raw = Buffer.concat(parts).toString('utf8');
        const out = await h.raw({
          method: (req.method ?? 'GET') as HttpRequest['method'], path: url.pathname, token: String(req.headers['authorization'] ?? '').replace(/^Bearer /, ''),
          ...(raw === '' ? {} : { body: JSON.parse(raw) as unknown }),
          ...(typeof req.headers['idempotency-key'] === 'string' ? { idempotencyKey: req.headers['idempotency-key'] } : {}),
          query: Object.fromEntries(url.searchParams),
        });
        res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(out.body));
      })().catch(() => { res.writeHead(500).end('{}'); });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(async () => { await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }); });
  return { h, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

interface Box { readonly edge: EdgeProcess; readonly url: string; readonly remote: string; readonly dir: string; readonly said: string[] }

async function box(api: string, opts: { remote?: boolean; allowed?: string } = {}): Promise<Box> {
  const dir = await mkdtemp(join(tmpdir(), 'sre-ob840-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); await rm(`${dir}-witness`, { recursive: true, force: true }); });
  const env = await prepareTillBox({ dir, key: KEY, pack: PACK, people: [{ userId: 'u-owner', displayName: 'The Owner' }, { userId: 'u-mgr', displayName: 'Manager' }, { userId: 'u-lanecash', displayName: 'Lane Cashier' }] });
  const pins = join(dir, 'remote-access.json');
  // What `store-computer remote-access setup` pins: the realm, its PUBLIC signing key, and who may come in (default: owner).
  await writeFile(pins, JSON.stringify({ kind: REMOTE_ACCESS_KIND, host: HOST, issuer: ISSUER, audience: AUDIENCE, tenantId: T, keys: jwks, ...(opts.allowed === undefined ? {} : { allowed: opts.allowed }), setAt: new Date().toISOString() }));
  const said: string[] = [];
  const edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
    EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_OFFICE_SIGN_IN: 'pin',
    CLOUD_API_URL: api, CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: 'S1' }),
    BOX_PRIVILEGE_SEAL_KEY: PRIVILEGE_SECRET,
    ...(opts.remote === false ? {} : { EDGE_REMOTE_DOOR_PORT: '0', EDGE_REMOTE_ACCESS_FILE: pins, EDGE_REMOTE_LINK_STATUS_FILE: join(dir, 'link-status.json') }),
    ...env,
  }, (line) => { said.push(line); }))!;
  cleanups.push(async () => { await edge.stop(); });
  return { edge, dir, said, url: `http://127.0.0.1:${edge.screens!.port}`, remote: `http://127.0.0.1:${edge.screens!.remotePort ?? 0}` };
}

/** A request as the relay hands it down the line: the token in Authorization, and the browser's same-origin mark. */
const viaRelay = (b: Box, path: string, opts: { token?: string | null; method?: 'GET' | 'POST'; body?: unknown; accept?: string } = {}): Promise<Response> => fetch(`${b.remote}${path}`, {
  method: opts.method ?? 'GET', redirect: 'manual',
  headers: {
    'sec-fetch-site': 'same-origin',
    ...(opts.token === null ? {} : { authorization: `Bearer ${opts.token ?? token()}` }),
    ...(opts.accept === undefined ? {} : { accept: opts.accept }),
    ...(opts.body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': `k-${randomUUID()}` }),
  },
  ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
});

async function signIn(url: string, userId: string): Promise<string | undefined> {
  const r = await fetch(`${url}/office/sign-in`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ staffId: userId, pin: pinOf(userId), next: '/manager/' }).toString(),
  });
  return r.headers.get('set-cookie')?.split(';')[0];
}

const errorOf = async (r: Response): Promise<{ code: string; whatHappened: string; wasItSaved: string; nextSafeAction: string }> => ((await r.json()) as { error: { code: string; whatHappened: string; wasItSaved: string; nextSafeAction: string } }).error;
const remoteLog = async (dir: string): Promise<Record<string, unknown>[]> => (await readLog(join(dir, REMOTE_ACCESS_LOG))).flatMap((r) => (r.ok ? [JSON.parse(r.record) as Record<string, unknown>] : []));
/**
 * The door writes its line when the reply has FINISHED going out (screen-server `res.on('finish')`), so the caller can hold
 * the answer a moment before the line is on disk. Read until `done` holds (at most 5 s) — never a fixed sleep, never a skip.
 */
const remoteLogWhen = async (dir: string, done: (log: Record<string, unknown>[]) => boolean): Promise<Record<string, unknown>[]> => {
  const until = Date.now() + 5000;
  for (;;) {
    const log = await remoteLog(dir);
    if (done(log) || Date.now() > until) return log;
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('OB-840: the remote door refuses everything it should, in plain words', () => {
  it('no token, another key, another issuer, expired, no one-time code, another shop — refused before anything is reached', async () => {
    const api = await officeApi();
    const b = await box(api.url);
    expect(b.edge.screens!.remotePort).toBeGreaterThan(0);
    expect(b.said.join('\n')).toMatch(/remote door on 127\.0\.0\.1:\d+ — loopback only/);

    const cases: [string | null, number, string][] = [
      [null, 401, 'no_sign_in'],
      [token({ key: stranger.privateKey }), 401, 'sign_in_not_believed'],
      [token({ iss: 'https://another.example.test/auth/realms/sre-store' }), 401, 'wrong_issuer'],
      [token({ exp: Math.floor(Date.now() / 1000) - 600 }), 401, 'sign_in_expired'],
      [token({ amr: ['pwd'] }), 401, 'second_factor_missing'],
      [token({ tenant: randomUUID() }), 401, 'sign_in_not_believed'],
      ['not-a-token', 401, 'no_sign_in'],
    ];
    for (const [t, status, code] of cases) {
      const r = await viaRelay(b, '/v1/approvals/requests', { token: t });
      expect(r.status, code).toBe(status);
      const e = await errorOf(r);
      expect(e.code).toBe(code);
      expect(e.wasItSaved).toBe('not_saved');
      expect(e.whatHappened.length).toBeGreaterThan(10);
      expect(e.nextSafeAction.length).toBeGreaterThan(10);
    }
    // A page is refused as a page, in words (English and Tamil), never a blank.
    const page = await viaRelay(b, '/manager/', { token: null });
    expect(page.status).toBe(401);
    const html = await page.text();
    expect(html).toContain('You are not signed in.');
    expect(html).toContain('Was anything saved?');
    expect(html).toContain('lang="ta"');
    // Each refusal is on the door's own log, with no token in it.
    const log = await remoteLogWhen(b.dir, (l) => l.filter((e) => e['channel'] === 'remote' && typeof e['refusedBecause'] === 'string').length >= cases.length);
    expect(log.filter((e) => e['channel'] === 'remote' && typeof e['refusedBecause'] === 'string').length).toBeGreaterThanOrEqual(cases.length);
    expect(JSON.stringify(log)).not.toMatch(/eyJ/);
  });

  it('a person who is not the owner is refused — only the owner by default ("4A")', async () => {
    const api = await officeApi();
    const b = await box(api.url);
    const r = await viaRelay(b, '/manager/', { token: token({ userId: 'u-mgr' }) });
    expect(r.status).toBe(403);
    expect(await r.text()).toContain('Only the owner may use');
    // Nobody without a role at this store, whatever the token says.
    expect((await viaRelay(b, '/v1/approvals/requests', { token: token({ userId: 'u-nobody' }) })).status).toBe(403);
  });

  it('the till, software update, users and roles, privilege acts, price publishing and the PIN sign-in are not reachable ("5A")', async () => {
    const api = await officeApi();
    const b = await box(api.url);
    for (const path of ['/pos/', '/update/', '/update/request', '/admin/', '/admin/?tab=users', '/catalogue/', '/pricing', '/office/privilege/grants', '/office/privilege/view', '/about/', '/licence/', '/handheld-seal/', '/directory/products', '/approvals/admin.html', '/manager/../pos/index.html', '/migration/']) {
      const r = await viaRelay(b, path);
      expect(r.status, path).toBe(403);
      expect(await r.text(), path).toContain('not reachable from outside the shop');
    }
    for (const [method, path] of [['POST', '/office/sign-in'], ['POST', '/v1/identity/grants'], ['POST', '/v1/catalogue/products/SALT/publish'], ['POST', '/v1/catalogue/changes'], ['GET', '/v1/identity/people'], ['POST', '/update/request'], ['POST', '/office/privilege/grants']] as const) {
      const r = await viaRelay(b, path, { method, accept: 'application/json', ...(method === 'POST' ? { body: {} } : {}) });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect((await errorOf(r)).code).toBe('not_reachable_remotely');
    }
    // The front door and /office/ never offer the PIN sign-in here: they go to Today.
    for (const path of ['/', '/office/']) {
      const r = await viaRelay(b, path);
      expect(r.status).toBe(303);
      expect(r.headers.get('location')).toBe('/manager/');
    }
    // A write from another site is refused even with a good token.
    const cross = await fetch(`${b.remote}/v1/approvals/requests/x/decide`, { method: 'POST', headers: { authorization: `Bearer ${token()}`, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, body: '{}' });
    expect(cross.status).toBe(403);
    expect((await errorOf(cross)).code).toBe('not_from_this_screen');
  });
});

describe('OB-840: the owner sees Today, the reports and his approvals, and approves — recorded in his name, marked remote', () => {
  it('Today, Reports and Approvals open as the owner, with no PIN sign-in, no box sign-out bar and only those three in the menu', async () => {
    const api = await officeApi();
    const b = await box(api.url);
    for (const path of ['/manager/', '/reporting/', '/approvals/']) {
      const r = await viaRelay(b, path);
      expect(r.status, path).toBe(200);
      const html = await r.text();
      expect(html).toContain('"userId":"u-owner"');
      expect(html).toContain('window.sreSignOut = {"action":"/login/logout"}');
      expect(html).not.toContain('id="sre-office-bar"');
      expect(html).not.toContain('/office/sign-out');
      expect(html).not.toContain('laneWriteBase');
      const nav = /window\.sreNavigation = (\{.*?\});<\/script>/.exec(html);
      expect(nav).not.toBeNull();
      const paths = (JSON.parse(nav![1]!) as { groups: { items: { path: string }[] }[] }).groups.flatMap((g) => g.items.map((i) => i.path));
      expect(paths.length).toBeGreaterThan(0);
      for (const p of paths) expect(['/manager/', '/reporting/', '/approvals']).toContain(p.split('?')[0]);
    }
    // A page's own files pass (the bundle the page loads).
    expect((await viaRelay(b, '/manager/sre-chrome.js')).status).toBe(200);
    // Today says the link's state in plain words — the link service has not reported on this test box.
    const today = await (await viaRelay(b, '/manager/')).text();
    expect(today).toContain('window.sreRemoteLink = {"state":"not_connected"');
  });

  it('the store manager asks; the owner approves from outside — in HIS name, exactly as in the store, plus "remote"', async () => {
    const api = await officeApi();
    const b = await box(api.url);
    // In the shop, the manager (by his own PIN) sends a change for the owner's approval.
    const mgr = await signIn(b.url, 'u-mgr');
    const item = await (await fetch(`${b.url}/v1/catalogue/products/SALT`, { headers: { cookie: mgr!, 'sec-fetch-site': 'same-origin' } })).json() as { version: number };
    const sent = await fetch(`${b.url}/v1/catalogue/changes`, {
      method: 'POST', headers: { cookie: mgr!, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'idempotency-key': `k-${randomUUID()}` },
      body: JSON.stringify({ change: 'product', productId: 'SALT', product: { ...SALT, manufacturer: 'Synthetic Salt Works' }, expectedVersion: item.version, reason: 'maker printed on the new pack (synthetic)' }),
    });
    expect(sent.status, await sent.clone().text()).toBe(201);

    // From outside: the owner reads his inbox through the line…
    const inbox = await viaRelay(b, '/v1/approvals/requests');
    expect(inbox.status).toBe(200);
    const waiting = ((await inbox.json()) as { waitingForMe: { requestId: string; kind: string }[] }).waitingForMe;
    const req = waiting.find((r) => r.kind === 'catalogue_change');
    expect(req).toBeDefined();

    // …and approves it.
    const decided = await viaRelay(b, `/v1/approvals/requests/${encodeURIComponent(req!.requestId)}/decide`, { method: 'POST', body: { decision: 'approved', reason: 'checked the new pack (synthetic)' } });
    expect(decided.status, await decided.clone().text()).toBe(201);
    expect(await decided.json()).toMatchObject({ decidedBy: 'u-owner', decision: 'approved', via: 'remote' });

    // Head office's record: in his name, exactly as in the store, plus the remote mark — as the manager reads it too.
    const asSeen = await api.h.request({ method: 'GET', path: '/v1/approvals/requests', userId: 'u-mgr', tenantId: T });
    expect((asSeen.body as { mine: Record<string, unknown>[] }).mine).toContainEqual(expect.objectContaining({ requestId: req!.requestId, decidedBy: 'u-owner', decidedVia: 'remote' }));

    // The door's own log: who, what, the answer — channel "remote". No token.
    const decidePath = `/v1/approvals/requests/${encodeURIComponent(req!.requestId)}/decide`;
    const log = await remoteLogWhen(b.dir, (l) => l.some((e) => e['method'] === 'POST' && e['path'] === decidePath));
    expect(log).toContainEqual(expect.objectContaining({ channel: 'remote', userId: 'u-owner', method: 'POST', path: `/v1/approvals/requests/${encodeURIComponent(req!.requestId)}/decide`, status: 201 }));
    expect(JSON.stringify(log)).not.toMatch(/eyJ/);
  });

  it('an approval that changes a person\'s access stays in the store ("5A": no user/role/privilege change from outside)', async () => {
    const api = await officeApi();
    const b = await box(api.url);
    const asked = await api.h.request({
      method: 'POST', path: '/v1/approvals/requests', userId: 'u-mgr', tenantId: T, idempotencyKey: `k-${randomUUID()}`,
      body: { kind: 'access_change', subjectRef: 'u-new', details: { userId: 'u-new', roleId: 'cashier', change: 'join' }, valueMinor: null, summary: 'A new cashier joins (synthetic)', reason: 'synthetic' },
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const id = (asked.body as { requestId: string }).requestId;
    const r = await viaRelay(b, `/v1/approvals/requests/${encodeURIComponent(id)}/decide`, { method: 'POST', body: { decision: 'approved', reason: 'from outside (synthetic)' } });
    expect(r.status).toBe(403);
    const e = await errorOf(r);
    expect(e.code).toBe('decide_in_the_store');
    expect(e.wasItSaved).toBe('not_saved');
    const still = await api.h.request({ method: 'GET', path: '/v1/approvals/requests', userId: 'u-mgr', tenantId: T });
    expect((still.body as { mine: Record<string, unknown>[] }).mine).toContainEqual(expect.objectContaining({ requestId: id, status: 'waiting' }));
  });

  it('a decision made in the store carries no remote mark (the store path is unchanged)', async () => {
    const api = await officeApi();
    const b = await box(api.url);
    const mgr = await signIn(b.url, 'u-mgr');
    const item = await (await fetch(`${b.url}/v1/catalogue/products/SALT`, { headers: { cookie: mgr!, 'sec-fetch-site': 'same-origin' } })).json() as { version: number };
    await fetch(`${b.url}/v1/catalogue/changes`, {
      method: 'POST', headers: { cookie: mgr!, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'idempotency-key': `k-${randomUUID()}` },
      body: JSON.stringify({ change: 'product', productId: 'SALT', product: { ...SALT, manufacturer: 'In-store Works' }, expectedVersion: item.version, reason: 'synthetic' }),
    });
    const owner = await signIn(b.url, 'u-owner');
    const inbox = await (await fetch(`${b.url}/v1/approvals/requests`, { headers: { cookie: owner!, 'sec-fetch-site': 'same-origin' } })).json() as { waitingForMe: { requestId: string }[] };
    const id = inbox.waitingForMe[0]!.requestId;
    const d = await fetch(`${b.url}/v1/approvals/requests/${encodeURIComponent(id)}/decide`, {
      method: 'POST', headers: { cookie: owner!, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'idempotency-key': `k-${randomUUID()}` },
      body: JSON.stringify({ decision: 'rejected', reason: 'not now (synthetic)' }),
    });
    expect(d.status).toBe(201);
    const body = await d.json() as Record<string, unknown>;
    expect(body['decidedBy']).toBe('u-owner');
    expect(body['via']).toBeUndefined();
  });
});

describe('OB-840: selling never depends on the line (P-01, hard rule #1), and the link state is said (P-08)', () => {
  it('with the remote door on and no line at all, the till sells', async () => {
    const api = await officeApi();
    const b = await box(api.url);
    const lane = b.edge.lane!.port;
    const t = await signInAtLane(lane, 'u-lanecash');
    const number = await receiptNumberAt(lane, t);
    const saved = await fetch(`http://127.0.0.1:${lane}/lane/sales`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(t) }, body: JSON.stringify({ id: 'S-OB840', number, total: 1, cashierId: 'u-lanecash' }),
    });
    expect((await saved.json() as { committed: boolean }).committed).toBe(true);
  });

  it('Today says connected / not connected since <time> / turned off, from the link service\'s own word', async () => {
    const api = await officeApi();
    const b = await box(api.url);
    const status = join(b.dir, 'link-status.json');
    const owner = await signIn(b.url, 'u-owner');
    const today = async (): Promise<string> => (await (await fetch(`${b.url}/manager/`, { headers: { cookie: owner! } })).text());
    const now = new Date().toISOString();
    await writeFile(status, JSON.stringify({ kind: 'sre-remote-link-status-v1', state: 'connected', since: now, updatedAt: now }));
    expect(await today()).toContain('"en":"Remote access: connected."');
    await writeFile(status, JSON.stringify({ kind: 'sre-remote-link-status-v1', state: 'connecting', since: '2026-11-18T04:30:00.000Z', updatedAt: now }));
    expect(await today()).toMatch(/"en":"Remote access: not connected since 2026-11-18 \d\d:\d\d\."/);
    // A "connected" word that is old is not believed (the service stopped reporting).
    await writeFile(status, JSON.stringify({ kind: 'sre-remote-link-status-v1', state: 'connected', since: '2026-01-01T04:30:00.000Z', updatedAt: '2026-01-01T04:31:00.000Z' }));
    expect(await today()).toContain('"state":"not_connected"');
    await writeFile(status, JSON.stringify({ kind: 'sre-remote-link-status-v1', state: 'off', updatedAt: now }));
    expect(await today()).toContain('"en":"Remote access: turned off."');

    // A box where remote access was never set up: no door at all, and Today says it is turned off.
    const plain = await box(api.url, { remote: false });
    expect(plain.edge.screens!.remotePort).toBeUndefined();
    const o2 = await signIn(plain.url, 'u-owner');
    expect(await (await fetch(`${plain.url}/manager/`, { headers: { cookie: o2! } })).text()).toContain('"en":"Remote access: turned off."');
    expect(await readFile(join(plain.dir, 'store-pack.json'), 'utf8')).toContain('u-owner');
  });
});
