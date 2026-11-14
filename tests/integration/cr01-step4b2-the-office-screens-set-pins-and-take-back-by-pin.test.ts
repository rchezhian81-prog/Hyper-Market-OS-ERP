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
 * **CR-01 step 4b-2 · OI-06 · ADR-0033 amendment 2 · OB-734 "A" · OB-735 "A" · OB-737 "A" on the REAL till service
 * (`startEdge`) and head office's REAL pipeline over HTTP.**
 *
 *   A till PIN set on the office screen works at once — at the office sign-in, which reads the SAME till-credentials file
 *   as the tills — and the old one stops; a cancelled PIN opens nothing; your own PIN is changed with your current one. The
 *   new PIN is in nothing relayed, logged or printed, and a PIN typed differently twice changes nothing. The manager cannot
 *   touch the owner's PIN (OB-737). A take-back asked by the manager and approved by the owner is done at once; a leaver's
 *   till PIN stops working on this box.
 */

const T = 't-cr01-4b2-box';
const KEY = ['cr01', '4b2', 'privilege', 'box'].join('-').padEnd(48, '0');
const PRIVILEGE_SECRET = randomBytes(32).toString('base64url');
const PACK = {
  version: 1,
  policies: { storeId: 'S1', branchId: 'S1', tradingDayCutoff: '00:00', warehouseId: 'wh-1' },
  lossPreventionRules: [], devices: [],
  roles: [
    { id: 'owner', name: 'Owner', permissions: ['identity.self.read', 'identity.role.request', 'identity.role.grant'] },
    { id: 'store_manager', name: 'Store manager', permissions: ['identity.self.read', 'identity.role.request'] },
    { id: 'warehouse_user', name: 'Warehouse user', permissions: ['identity.self.read'] },
  ],
  roleAssignments: [{ userId: 'u-owner', roleId: 'owner', branchScope: 'all' }, { userId: 'u-mgr', roleId: 'store_manager', branchScope: 'all' }, { userId: 'u-cash', roleId: 'warehouse_user', branchScope: 'all' }],
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

/** Head office's real pipeline, served over HTTP on this PC's loopback (as the office service is on the store PC). */
async function headOffice(): Promise<{ h: ApiHarness; url: string; seen: string[] }> {
  const h = apiHarness({ privilegeSealSecret: PRIVILEGE_SECRET });
  await h.provisionOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-mgr', 'store_manager');
  await h.provisionRole(T, 'u-cash', 'warehouse_user');
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
  const dir = await mkdtemp(join(tmpdir(), 'sre-cr01-4b2-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); await rm(`${dir}-witness`, { recursive: true, force: true }); });
  const env = await prepareTillBox({ dir, key: KEY, pack: PACK, people: [{ userId: 'u-owner', displayName: 'The Owner' }, { userId: 'u-mgr', displayName: 'Manager' }, { userId: 'u-cash', displayName: 'Kala' }] });
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

/** The office sign-in with a PIN: the cookie, or the status it refused with. */
async function tryOffice(url: string, userId: string, pin: string): Promise<{ status: number; cookie?: string }> {
  const r = await fetch(`${url}/office/sign-in`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ staffId: userId, pin, next: '/manager/' }).toString(),
  });
  const cookie = r.headers.get('set-cookie')?.split(';')[0];
  return { status: r.status, ...(r.status === 303 && cookie !== undefined ? { cookie } : {}) };
}
async function signIn(url: string, userId: string, pin = pinOf(userId)): Promise<string> {
  const r = await tryOffice(url, userId, pin);
  expect(r.status).toBe(303);
  return r.cookie!;
}

const post = (url: string, path: string, cookie: string | undefined, body: unknown, site = 'same-origin'): Promise<Response> => fetch(`${url}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': site, ...(cookie === undefined ? {} : { cookie }) }, body: JSON.stringify(body),
});
const logged = async (dir: string): Promise<Record<string, unknown>[]> =>
  (await readLog(join(dir, PRIVILEGE_LOG))).flatMap((r) => (r.ok ? [JSON.parse(r.record) as Record<string, unknown>] : []));

const NEW_PIN = '864213';

describe('till PINs and take-backs on the store PC\'s office screens (CR-01 step 4b-2)', () => {
  it('the manager sets a warehouse worker\'s new PIN: it opens the office sign-in at once, the old one stops — the PIN nowhere', async () => {
    const ho = await headOffice();
    const { url, dir, said } = await box(ho.url);
    const mgr = await signIn(url, 'u-mgr');
    const mismatch = await post(url, '/office/privilege/till-pins', mgr, { pin: pinOf('u-mgr'), request: { action: 'set', userId: 'u-cash', newPin: NEW_PIN, newPinAgain: '864214' } });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ refusedBecause: 'new_pin_not_readable' });
    expect(ho.seen).toEqual([]);

    const r = await post(url, '/office/privilege/till-pins', mgr, { pin: pinOf('u-mgr'), request: { action: 'set', userId: 'u-cash', newPin: NEW_PIN, newPinAgain: NEW_PIN } });
    const body = await r.json() as Record<string, unknown>;
    expect(r.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ ok: true, kind: 'till_pin_change' });
    expect((await tryOffice(url, 'u-cash', NEW_PIN)).status).toBe(303);
    expect((await tryOffice(url, 'u-cash', pinOf('u-cash'))).status).not.toBe(303);

    for (const secret of [NEW_PIN, pinOf('u-mgr')]) {
      expect(ho.seen.join('\n')).not.toContain(secret);
      expect(await readFile(join(dir, PRIVILEGE_LOG), 'utf8')).not.toContain(secret);
      expect(said.join('\n')).not.toContain(secret);
    }
    // Only its fingerprint is on this box.
    expect(await readFile(join(dir, 'till-credentials.json'), 'utf8')).not.toContain(NEW_PIN);
    expect((await logged(dir)).filter((x) => x['act'] === 'till_pin_change').map((x) => x['outcome'])).toEqual(['refused:new_pin_not_readable', 'sealed', 'accepted', 'pin_written_here']);
  });

  it('your own PIN with your current one; a cancelled PIN opens nothing; the owner\'s PIN is out of the manager\'s reach', async () => {
    const ho = await headOffice();
    const { url } = await box(ho.url);
    const mgr = await signIn(url, 'u-mgr');
    const own = await post(url, '/office/privilege/till-pins', mgr, { pin: pinOf('u-mgr'), request: { action: 'own', newPin: NEW_PIN, newPinAgain: NEW_PIN } });
    expect(own.status, JSON.stringify(await own.clone().json())).toBe(200);
    expect((await tryOffice(url, 'u-mgr', NEW_PIN)).status).toBe(303);

    const owner = await post(url, '/office/privilege/till-pins', mgr, { pin: NEW_PIN, request: { action: 'cancel', userId: 'u-owner' } });
    expect(owner.status).toBe(403);
    expect(await owner.json()).toMatchObject({ refusedBecause: 'head_office_refused', code: 'person_holds_more_authority' });
    expect((await tryOffice(url, 'u-owner', pinOf('u-owner'))).status).toBe(303);

    const cancel = await post(url, '/office/privilege/till-pins', mgr, { pin: NEW_PIN, request: { action: 'cancel', userId: 'u-cash' } });
    expect(cancel.status, JSON.stringify(await cancel.clone().json())).toBe(200);
    expect((await tryOffice(url, 'u-cash', pinOf('u-cash'))).status).not.toBe(303);
  });

  it('a leaver: the manager asks, the owner approves — done at once, and the leaver\'s PIN stops working on this box', async () => {
    const ho = await headOffice();
    const { url } = await box(ho.url);
    expect((await tryOffice(url, 'u-cash', pinOf('u-cash'))).status).toBe(303);
    const mgr = await signIn(url, 'u-mgr');
    const asked = await post(url, '/office/privilege/access-changes', mgr, { pin: pinOf('u-mgr'), request: { requestId: 'access-box-1', event: 'leaver', userId: 'u-cash', reason: 'left on Friday', grants: [] } });
    const ab = await asked.json() as { ok: boolean; result: { requestId: string } };
    expect(asked.status, JSON.stringify(ab)).toBe(200);
    const approvalId = ab.result.requestId;

    // The page lists it for the owner, waiting.
    const owner = await signIn(url, 'u-owner');
    const view = await (await fetch(`${url}/office/privilege/users-view`, { headers: { cookie: owner } })).json() as { accessChanges: { approvalId: string; status: string }[] };
    expect(view.accessChanges).toContainEqual(expect.objectContaining({ approvalId, status: 'waiting' }));

    const done = await post(url, `/office/privilege/access-changes/${approvalId}/decide`, owner, { pin: pinOf('u-owner'), request: { decision: 'approved', reason: 'she left' } });
    const db = await done.json() as Record<string, unknown>;
    expect(done.status, JSON.stringify(db)).toBe(200);
    expect(db).toMatchObject({ ok: true, kind: 'access_change_decision', result: { applied: true, tillPinToCancel: 'u-cash' } });
    expect((await tryOffice(url, 'u-cash', pinOf('u-cash'))).status).not.toBe(303);
    const grants = await ho.h.request({ method: 'GET', path: '/v1/identity/grants', userId: 'u-owner', tenantId: T });
    expect(JSON.stringify(grants.body)).not.toContain('"u-cash"');
  });

  it('the office page is told the take-back and till PIN doors', async () => {
    const ho = await headOffice();
    const { url } = await box(ho.url);
    const mgr = await signIn(url, 'u-mgr');
    const html = await (await fetch(`${url}/users/`, { headers: { cookie: mgr } })).text();
    for (const door of ['/office/privilege/access-changes', '/office/privilege/access-changes/{approvalId}/decide', '/office/privilege/till-pins']) expect(html).toContain(door);
  });
});
