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
import type { HttpRequest } from '../../services/kernel/src/index';

/**
 * **CR-01 step 4b-1 · OI-06 · ADR-0033 (amended) · OB-733 "A" · OB-735 on the REAL till service (`startEdge`) and head
 * office's REAL pipeline over HTTP.**
 *
 *   The store PC with the office PIN sign-in on and NO head-office link. The manager adds a new member of staff — a name and
 *   a staff id, his PIN typed again — and head office records a store-PC person (no sign-in anywhere). The owner turns a
 *   pending request down with a reason, his PIN typed again. The Users & roles page reads its lists through the box: head
 *   office answers for the person signed in at the screen, for this store only. A wrong PIN or a missing reason relays
 *   nothing; nobody signed in reads nothing; the PIN is in nothing relayed, logged or printed.
 */

const T = 't-cr01-4b1-box';
const KEY = ['cr01', '4b1', 'privilege', 'box'].join('-').padEnd(48, '0');
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
  const dir = await mkdtemp(join(tmpdir(), 'sre-cr01-4b1-'));
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
const ask = { grantId: 'g-box-r', userId: 'u-new', roleId: 'cashier', branchScope: 'all', reason: 'new cashier for the morning shift' };

describe('the office screens on the store PC add a person, reject a request, and read the lists (CR-01 step 4b-1)', () => {
  it('the manager adds a person, his PIN typed again: head office records a store-PC person; the PIN is nowhere', async () => {
    const ho = await headOffice();
    const { url, dir, said } = await box(ho.url);
    const mgr = await signIn(url, 'u-mgr');

    const wrong = await post(url, '/office/privilege/people', mgr, { pin: '000000', request: { userId: 'priya.k', displayName: 'Priya K' } });
    expect(wrong.status).toBe(403);
    expect(ho.seen).toEqual([]);
    const bad = await post(url, '/office/privilege/people', mgr, { pin: pinOf('u-mgr'), request: { userId: 'priya.k' } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ refusedBecause: 'not_readable' });
    expect(ho.seen).toEqual([]);

    const added = await post(url, '/office/privilege/people', mgr, { pin: pinOf('u-mgr'), request: { userId: 'Priya.K', displayName: 'Priya K' } });
    const body = await added.json() as Record<string, unknown>;
    expect(added.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ ok: true, kind: 'person_provision', result: { userId: 'priya.k', state: 'store_pc', signIn: 'none' } });
    expect(String(body['en'])).toContain('this store PC only');
    expect(String(body['ta'])).not.toBe('');

    const people = await ho.h.request({ method: 'GET', path: '/v1/identity/box/users-view', userId: 'u-box', tenantId: T, query: { for: 'u-owner' } });
    expect((people.body as { people: unknown[] }).people).toContainEqual({ userId: 'priya.k', displayName: 'Priya K', state: 'store_pc' });

    for (const pin of [pinOf('u-mgr'), '000000']) {
      expect(ho.seen.join('\n')).not.toContain(pin);
      expect(await readFile(join(dir, PRIVILEGE_LOG), 'utf8')).not.toContain(pin);
      expect(said.join('\n')).not.toContain(pin);
    }
    expect((await logged(dir)).map((r) => [r['act'], r['outcome'], r['forUserId'] ?? null])).toEqual([
      ['person_provision', 'refused:pin_not_confirmed', null],
      ['person_provision', 'refused:not_readable', null],
      ['person_provision', 'sealed', 'priya.k'], ['person_provision', 'accepted', null],
    ]);
  });

  it('the owner rejects a request with a reason, his PIN typed again; no reason relays nothing', async () => {
    const ho = await headOffice();
    const { url, dir } = await box(ho.url);
    const mgr = await signIn(url, 'u-mgr');
    expect((await post(url, '/office/privilege/grants', mgr, { pin: pinOf('u-mgr'), request: ask })).status).toBe(200);
    const owner = await signIn(url, 'u-owner');
    const seenBefore = ho.seen.length;

    const noReason = await post(url, '/office/privilege/grants/g-box-r/reject', owner, { pin: pinOf('u-owner') });
    expect(noReason.status).toBe(400);
    expect(await noReason.json()).toMatchObject({ refusedBecause: 'not_readable' });
    // The manager does not hold the checker's word: his PIN is not confirmed for it.
    const byMgr = await post(url, '/office/privilege/grants/g-box-r/reject', mgr, { pin: pinOf('u-mgr'), request: { reason: 'no' } });
    expect(byMgr.status).toBe(403);
    expect(ho.seen.length).toBe(seenBefore);

    const r = await post(url, '/office/privilege/grants/g-box-r/reject', owner, { pin: pinOf('u-owner'), request: { reason: 'enough cashiers now' } });
    const body = await r.json() as Record<string, unknown>;
    expect(r.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ ok: true, kind: 'role_grant_rejection', result: { state: 'rejected', rejectedBy: 'u-owner' } });
    const pending = await ho.h.request({ method: 'GET', path: '/v1/identity/grants/pending', userId: 'u-owner', tenantId: T });
    expect(JSON.stringify(pending.body)).not.toContain('g-box-r');
    expect((await logged(dir)).filter((x) => x['act'] === 'role_grant_rejection').map((x) => x['outcome'])).toEqual(['refused:not_readable', 'refused:pin_not_confirmed', 'sealed', 'accepted']);
    expect(ho.seen.join('\n')).not.toContain(pinOf('u-owner'));
  });

  it('the lists, read through the box for the person at the screen; nobody signed in reads nothing', async () => {
    const ho = await headOffice();
    const { url } = await box(ho.url);
    const mgr = await signIn(url, 'u-mgr');
    expect((await post(url, '/office/privilege/grants', mgr, { pin: pinOf('u-mgr'), request: ask })).status).toBe(200);

    const asMgr = await fetch(`${url}/office/privilege/users-view`, { headers: { cookie: mgr } });
    const m = await asMgr.json() as Record<string, unknown>;
    expect(asMgr.status, JSON.stringify(m)).toBe(200);
    expect(m).toMatchObject({ ok: true, for: 'u-mgr', mayAsk: true, mayRead: false, storeId: 'S1' });
    expect((m['grants'] as { userId: string }[]).map((g) => g.userId)).toContain('u-mgr');
    expect(m['pending']).toBeUndefined();

    const owner = await signIn(url, 'u-owner');
    const o = await (await fetch(`${url}/office/privilege/users-view`, { headers: { cookie: owner } })).json() as Record<string, unknown>;
    expect(o).toMatchObject({ ok: true, for: 'u-owner', mayRead: true, mayDecide: true });
    expect((o['pending'] as { grantId: string }[]).map((p) => p.grantId)).toEqual(['g-box-r']);

    const anon = await fetch(`${url}/office/privilege/users-view`);
    expect(anon.status).toBe(401);
    expect(await anon.json()).toMatchObject({ refusedBecause: 'not_signed_in' });
    const posted = await post(url, '/office/privilege/users-view', mgr, {});
    expect(posted.status).toBe(405);
  });

  it('the office page is told every door: give, approve, reject, add a person, and the lists', async () => {
    const ho = await headOffice();
    const { url } = await box(ho.url);
    const mgr = await signIn(url, 'u-mgr');
    const html = await (await fetch(`${url}/users/`, { headers: { cookie: mgr } })).text();
    for (const door of ['/office/privilege/grants', '/office/privilege/grants/{grantId}/approve', '/office/privilege/grants/{grantId}/reject', '/office/privilege/people', '/office/privilege/users-view']) {
      expect(html).toContain(door);
    }
  });
});
