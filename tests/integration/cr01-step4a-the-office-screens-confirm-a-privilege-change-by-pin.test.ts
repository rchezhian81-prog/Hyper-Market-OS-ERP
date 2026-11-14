import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { PRIVILEGE_LOG } from '../../edge/store-edge/src/office-privilege';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { prepareTillBox, pinOf } from '../support/till-operator';
import { alertLifecycleAdapter } from '../../services/api/src/adapters';
import type { HttpRequest } from '../../services/kernel/src/index';

/**
 * **CR-01 step 4a · OI-06 · ADR-0033 on the REAL till service (`startEdge`) and head office's REAL pipeline over HTTP.**
 *
 *   The store PC with the office PIN sign-in on and NO head-office link. The manager, signed in to the office screens with
 *   his own PIN, asks for a role for a new cashier — his PIN typed again; the owner approves it the same way. The box seals
 *   each act with the dedicated privilege-seal key and relays it under its store token; head office runs the person's own
 *   checks and grants the role. A wrong PIN relays nothing; nobody signed in, or a request from another site, is refused;
 *   the PIN is in no log line the box keeps and nothing the box printed. The office page is told the box's doors.
 */

const T = 't-cr01-4a-box';
const KEY = ['cr01', '4a', 'privilege', 'box'].join('-').padEnd(48, '0');
const PRIVILEGE_SECRET = randomBytes(32).toString('base64url');
const PACK = {
  version: 1,
  policies: { storeId: 'S1', branchId: 'S1', tradingDayCutoff: '00:00', warehouseId: 'wh-1' },
  lossPreventionRules: [], devices: [],
  roles: [
    { id: 'owner', name: 'Owner', permissions: ['identity.self.read', 'identity.role.request', 'identity.role.grant'] },
    { id: 'store_manager', name: 'Store manager', permissions: ['identity.self.read', 'identity.role.request'] },
  ],
  roleAssignments: [{ userId: 'u-owner', roleId: 'owner', branchScope: 'all' }, { userId: 'u-mgr', roleId: 'store_manager', branchScope: 'all' }],
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

/** Head office's real pipeline, served over HTTP on this PC's loopback (as the office service is on the store PC). */
async function headOffice(): Promise<{ h: ApiHarness; url: string; seen: string[] }> {
  const h = apiHarness({ privilegeSealSecret: PRIVILEGE_SECRET });
  await h.provisionOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-mgr', 'store_manager');
  await h.provisionRole(T, 'u-box', 'store_computer', ['S1']);
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://x');
        const raw = Buffer.concat(parts).toString('utf8');
        if (url.pathname.startsWith('/v1/identity/box/')) seen.push(raw);
        const token = String(req.headers['authorization'] ?? '').replace(/^Bearer /, '');
        const out = await h.raw({
          method: (req.method ?? 'GET') as HttpRequest['method'], path: url.pathname, token,
          ...(raw === '' ? {} : { body: JSON.parse(raw) as unknown }),
          ...(typeof req.headers['idempotency-key'] === 'string' ? { idempotencyKey: req.headers['idempotency-key'] } : {}),
          query: Object.fromEntries(url.searchParams),
        });
        res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(out.body));
      })().catch(() => { res.writeHead(500).end('{}'); });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(async () => { await new Promise<void>((r) => server.close(() => r())); });
  const port = (server.address() as { port: number }).port;
  return { h, url: `http://127.0.0.1:${port}`, seen };
}

async function box(api: string, opts: { privilegeKey?: string | null } = {}): Promise<{ edge: EdgeProcess; dir: string; url: string; said: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'sre-cr01-4a-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); await rm(`${dir}-witness`, { recursive: true, force: true }); });
  const env = await prepareTillBox({ dir, key: KEY, pack: PACK, people: [{ userId: 'u-owner', displayName: 'The Owner' }, { userId: 'u-mgr', displayName: 'Manager' }] });
  const said: string[] = [];
  const edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
    EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_OFFICE_SIGN_IN: 'pin',
    CLOUD_API_URL: api, CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: 'S1' }),
    ...(opts.privilegeKey === null ? {} : { BOX_PRIVILEGE_SEAL_KEY: opts.privilegeKey ?? PRIVILEGE_SECRET }),
    ...env,
  }, (line) => { said.push(line); }))!;
  cleanups.push(async () => { await edge.stop(); });
  return { edge, dir, url: `http://127.0.0.1:${edge.screens!.port}`, said };
}

async function signIn(url: string, userId: string): Promise<string> {
  const r = await fetch(`${url}/office/sign-in`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ staffId: userId, pin: pinOf(userId), next: '/manager/' }).toString(),
  });
  expect(r.status).toBe(303);
  return r.headers.get('set-cookie')!.split(';')[0]!;
}

const post = (url: string, path: string, cookie: string | undefined, body: unknown, site = 'same-origin'): Promise<Response> => fetch(`${url}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': site, ...(cookie === undefined ? {} : { cookie }) }, body: JSON.stringify(body),
});
const logged = async (dir: string): Promise<Record<string, unknown>[]> =>
  (await readLog(join(dir, PRIVILEGE_LOG))).flatMap((r) => (r.ok ? [JSON.parse(r.record) as Record<string, unknown>] : []));
const ask = { grantId: 'g-box-1', userId: 'u-new', roleId: 'cashier', branchScope: 'all', reason: 'new cashier for the morning shift' };

describe('the office screens on the store PC make a privilege change by PIN (CR-01 step 4a)', () => {
  it('the manager asks, the owner approves — each PIN typed again; head office grants it as those two people', async () => {
    const ho = await headOffice();
    const { url, dir, said } = await box(ho.url);
    const mgr = await signIn(url, 'u-mgr');

    const wrong = await post(url, '/office/privilege/grants', mgr, { pin: '000000', request: ask });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toMatchObject({ ok: false, refusedBecause: 'pin_not_confirmed' });
    expect(ho.seen).toEqual([]); // nothing relayed

    const asked = await post(url, '/office/privilege/grants', mgr, { pin: pinOf('u-mgr'), request: ask });
    const askedBody = await asked.json() as Record<string, unknown>;
    expect(asked.status, JSON.stringify(askedBody)).toBe(200);
    expect(askedBody).toMatchObject({ ok: true, kind: 'role_request' });
    expect(String(askedBody['ta'])).not.toBe('');

    const owner = await signIn(url, 'u-owner');
    const approved = await post(url, '/office/privilege/grants/g-box-1/approve', owner, { pin: pinOf('u-owner') });
    expect(approved.status, JSON.stringify(await approved.clone().json())).toBe(200);
    expect(await approved.json()).toMatchObject({ ok: true, kind: 'role_grant_approval' });

    const grants = await ho.h.request({ method: 'GET', path: '/v1/identity/grants', userId: 'u-owner', tenantId: T });
    expect((grants.body as { grants: { userId: string; roleId: string }[] }).grants).toContainEqual(expect.objectContaining({ userId: 'u-new', roleId: 'cashier' }));
    const alerts = await alertLifecycleAdapter({ store: ho.h.store, now: () => new Date().toISOString() }).alerts(T);
    expect(alerts.filter((a) => a.alert.alertId.startsWith('privilege-change:'))).toHaveLength(2);

    // The PIN is in nothing relayed, nothing logged, nothing the box said.
    for (const pin of [pinOf('u-mgr'), pinOf('u-owner'), '000000']) {
      expect(ho.seen.join('\n')).not.toContain(pin);
      expect(await readFile(join(dir, PRIVILEGE_LOG), 'utf8')).not.toContain(pin);
      expect(said.join('\n')).not.toContain(pin);
    }
    // Nor the privilege-seal key.
    expect(said.join('\n')).not.toContain(PRIVILEGE_SECRET);
    expect(await readFile(join(dir, PRIVILEGE_LOG), 'utf8')).not.toContain(PRIVILEGE_SECRET);
    expect((await logged(dir)).map((r) => [r['userId'], r['act'], r['outcome']])).toEqual([
      ['u-mgr', 'role_request', 'refused:pin_not_confirmed'],
      ['u-mgr', 'role_request', 'sealed'], ['u-mgr', 'role_request', 'accepted'],
      ['u-owner', 'role_grant_approval', 'sealed'], ['u-owner', 'role_grant_approval', 'accepted'],
    ]);
  });

  it('the manager cannot approve: his PIN is checked holding identity.role.grant, which his role lacks — nothing relayed', async () => {
    const ho = await headOffice();
    const { url } = await box(ho.url);
    const mgr = await signIn(url, 'u-mgr');
    const r = await post(url, '/office/privilege/grants/g-x/approve', mgr, { pin: pinOf('u-mgr') });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ refusedBecause: 'pin_not_confirmed' });
    expect(ho.seen).toEqual([]);
  });

  it('nobody signed in, or a request from another site — refused, nothing relayed', async () => {
    const ho = await headOffice();
    const { url } = await box(ho.url);
    const mgr = await signIn(url, 'u-mgr');
    const cross = await post(url, '/office/privilege/grants', mgr, { pin: pinOf('u-mgr'), request: ask }, 'cross-site');
    expect(cross.status).toBe(403);
    expect(await cross.json()).toMatchObject({ refusedBecause: 'not_from_this_screen' });
    const anon = await post(url, '/office/privilege/grants', undefined, { pin: pinOf('u-mgr'), request: ask });
    expect(anon.status).toBe(401);
    expect(await anon.json()).toMatchObject({ refusedBecause: 'not_signed_in' });
    expect((await fetch(`${url}/office/privilege/grants`, { headers: { cookie: mgr } })).status).toBe(405);
    expect(ho.seen).toEqual([]);
  });

  it('a box with no privilege-seal key refuses in words, never relaying; adding a person says step 4b', async () => {
    const ho = await headOffice();
    const { url } = await box(ho.url, { privilegeKey: null });
    const mgr = await signIn(url, 'u-mgr');
    const r = await post(url, '/office/privilege/grants', mgr, { pin: pinOf('u-mgr'), request: ask });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ refusedBecause: 'not_set_up' });
    const p = await post(url, '/office/privilege/people', mgr, { pin: pinOf('u-mgr'), request: { signInName: 'priya.k', displayName: 'Priya K' } });
    expect(p.status).toBe(501);
    expect(await p.json()).toMatchObject({ refusedBecause: 'comes_in_step_4b' });
    expect(ho.seen).toEqual([]);
  });

  it('the office pages are told the box\'s privilege doors (link off, signed in)', async () => {
    const ho = await headOffice();
    const { url } = await box(ho.url);
    const mgr = await signIn(url, 'u-mgr');
    const r = await fetch(`${url}/users/`, { headers: { cookie: mgr } });
    const html = await r.text();
    expect(r.status, html.slice(0, 300)).toBe(200);
    expect(html).toContain('window.sreOfficePrivilege = ');
    expect(html).toContain('/office/privilege/grants/{grantId}/approve');
  });
});
