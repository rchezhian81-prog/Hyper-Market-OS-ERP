import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { prepareTillBox, pinOf } from '../support/till-operator';
import type { HttpRequest } from '../../services/kernel/src/index';

/**
 * **Audit C-1 / D-1 (OB-795) · OB-773 "1 A" · ADR-0033 amendment 3, on the REAL till service (`startEdge`) and the office
 * API's REAL pipeline over HTTP.** The store PC as installed: office PIN sign-in on, NO head-office sign-in link. Before
 * this, every office page's `/v1` call was dropped, so no item, price, buying, approval or report page worked on the PC.
 *   • the store manager, signed in by his own PIN, READS an item and SENDS a change for the owner's approval through the
 *     office page's own call — the API records it as his, with his own permissions;
 *   • the cashier's PIN does not open the office; nobody signed in, or a write from another site, is refused at the box;
 *   • a route that needs a second step (MFA) still refuses a PIN sign-in — privilege changes keep their own path;
 *   • a box with no privilege-seal key, or an office API that is down, fails as a lost link (P-08), never a made-up answer.
 * Synthetic data only.
 */

const T = randomUUID();
const KEY = ['c1', 'office', 'calls', 'box'].join('-').padEnd(48, '0');
const PRIVILEGE_SECRET = randomBytes(32).toString('base64url');
const PACK = {
  version: 1,
  policies: { storeId: 'S1', branchId: 'S1', tradingDayCutoff: '00:00', warehouseId: 'wh-1' },
  lossPreventionRules: [], devices: [],
  roles: [
    { id: 'owner', name: 'Owner', permissions: ['identity.self.read'] },
    { id: 'store_manager', name: 'Store manager', permissions: ['identity.self.read'] },
    { id: 'cashier', name: 'Cashier', permissions: ['identity.self.read', 'pos.sale.sync'] },
  ],
  roleAssignments: [
    { userId: 'u-owner', roleId: 'owner', branchScope: 'all' }, { userId: 'u-mgr', roleId: 'store_manager', branchScope: 'all' },
    { userId: 'u-cash', roleId: 'cashier', branchScope: 'all' },
  ],
};
const SALT = { sku: 'SKU-SALT', name: 'Synthetic Salt 1kg', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'active', mrpHistory: [{ value: { minor: 2_800, currency: 'INR' }, effectiveFrom: '2026-01-01' }] };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

/** The office API's real pipeline, served over HTTP on this PC's loopback (as SRE-API is on the store PC). */
async function officeApi(): Promise<{ h: ApiHarness; url: string; tokens: string[]; close: () => Promise<void> }> {
  const h = apiHarness({ privilegeSealSecret: PRIVILEGE_SECRET });
  await h.seedOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-mgr', 'store_manager');
  await h.provisionRole(T, 'u-cash', 'cashier');
  await h.provisionRole(T, 'u-box', 'store_computer', ['S1']);
  const owner = async (method: 'POST', path: string, body: unknown) => {
    const r = await h.request({ method, path, userId: 'u-owner', tenantId: T, idempotencyKey: `k-${randomUUID()}`, body });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  };
  await owner('POST', '/v1/catalogue/categories/grocery', { name: 'Grocery', parentId: null });
  await owner('POST', '/v1/catalogue/tax-classes/25010020/rates/2017-07-01', { rateBps: 500 });
  await owner('POST', '/v1/catalogue/products/SALT/publish', { product: SALT });
  const tokens: string[] = [];
  const server: Server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://x');
        const raw = Buffer.concat(parts).toString('utf8');
        const token = String(req.headers['authorization'] ?? '').replace(/^Bearer /, '');
        tokens.push(token);
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
  const close = async (): Promise<void> => { await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }); };
  cleanups.push(close);
  return { h, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, tokens, close };
}

async function box(api: string, opts: { privilegeKey?: string | null } = {}): Promise<{ edge: EdgeProcess; url: string; said: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'sre-c1-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); await rm(`${dir}-witness`, { recursive: true, force: true }); });
  const env = await prepareTillBox({ dir, key: KEY, pack: PACK, people: [{ userId: 'u-owner', displayName: 'The Owner' }, { userId: 'u-mgr', displayName: 'Manager' }, { userId: 'u-cash', displayName: 'Cashier' }] });
  const said: string[] = [];
  const edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
    EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_OFFICE_SIGN_IN: 'pin',
    CLOUD_API_URL: api, CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: 'S1' }),
    ...(opts.privilegeKey === null ? {} : { BOX_PRIVILEGE_SEAL_KEY: opts.privilegeKey ?? PRIVILEGE_SECRET }),
    ...env,
  }, (line) => { said.push(line); }))!;
  cleanups.push(async () => { await edge.stop(); });
  return { edge, url: `http://127.0.0.1:${edge.screens!.port}`, said };
}

async function signIn(url: string, userId: string): Promise<{ status: number; cookie: string | undefined }> {
  const r = await fetch(`${url}/office/sign-in`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ staffId: userId, pin: pinOf(userId), next: '/manager/' }).toString(),
  });
  return { status: r.status, cookie: r.headers.get('set-cookie')?.split(';')[0] };
}

const call = (url: string, method: 'GET' | 'POST', path: string, cookie: string | undefined, body?: unknown, site = 'same-origin'): Promise<Response> => fetch(`${url}${path}`, {
  method, headers: { 'sec-fetch-site': site, ...(cookie === undefined ? {} : { cookie }), ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': `k-${randomUUID()}` }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe('the store PC\'s office pages reach the office API as the person signed in by PIN (audit C-1)', () => {
  it('the store manager reads an item and sends a change for the owner\'s approval — recorded as his', async () => {
    const api = await officeApi();
    const { url, said } = await box(api.url);
    const mgr = await signIn(url, 'u-mgr');
    expect(mgr.status).toBe(303);

    const read = await call(url, 'GET', '/v1/catalogue/products/SALT', mgr.cookie);
    expect(read.status).toBe(200);
    const item = await read.json() as { product: { name: string }; version: number };
    expect(item.product.name).toBe('Synthetic Salt 1kg');

    const sent = await call(url, 'POST', '/v1/catalogue/changes', mgr.cookie, {
      change: 'product', productId: 'SALT', product: { ...SALT, manufacturer: 'Synthetic Salt Works' }, expectedVersion: item.version, reason: 'maker printed on the new pack (synthetic)',
    });
    expect(sent.status, await sent.clone().text()).toBe(201);
    const inbox = await api.h.request({ method: 'GET', path: '/v1/approvals/requests', userId: 'u-mgr', tenantId: T });
    expect((inbox.body as { mine: { kind: string; status: string }[] }).mine).toContainEqual(expect.objectContaining({ kind: 'catalogue_change', status: 'waiting' }));

    // The manager's own permissions still apply: a direct save of the item is refused by the API, as anywhere else.
    const direct = await call(url, 'POST', '/v1/catalogue/products/SALT/publish', mgr.cookie, { product: SALT });
    expect(direct.status).toBe(403);

    // A route that needs a second step refuses a PIN sign-in (privilege changes keep their own PIN-typed-again path).
    const grant = await call(url, 'POST', '/v1/identity/grants', mgr.cookie, { userId: 'u-x', roleId: 'cashier', branchScope: 'all' });
    expect([401, 403]).toContain(grant.status);

    // The seal never leaves the PC in the box's words, and the privilege secret is never said.
    expect(said.join('\n')).not.toContain(PRIVILEGE_SECRET);
    for (const t of api.tokens) expect(said.join('\n')).not.toContain(t);
  });

  it('refused at the box: nobody signed in, a write from another site, the cashier\'s PIN at the office', async () => {
    const api = await officeApi();
    const { url } = await box(api.url);
    const nobody = await call(url, 'GET', '/v1/catalogue/products/SALT', undefined);
    expect(nobody.status).toBe(401);
    const mgr = await signIn(url, 'u-mgr');
    const crossSite = await call(url, 'POST', '/v1/catalogue/changes', mgr.cookie, { change: 'product' }, 'cross-site');
    expect(crossSite.status).toBe(403);
    const cash = await signIn(url, 'u-cash');
    expect(cash.cookie ?? 'sre_office=').toMatch(/=$/); // no office session for a till-only PIN
    expect((await call(url, 'GET', '/v1/catalogue/products/SALT', cash.cookie)).status).toBe(401);
    expect(api.tokens).toHaveLength(0); // none of these reached the API
  });

  it('a box with no privilege-seal key, or an office API that is down, fails as a lost link — never a made-up answer', async () => {
    const api = await officeApi();
    const noKey = await box(api.url, { privilegeKey: null });
    const a = await signIn(noKey.url, 'u-mgr');
    await expect(call(noKey.url, 'GET', '/v1/catalogue/products/SALT', a.cookie)).rejects.toThrow();

    const { url } = await box(api.url);
    const b = await signIn(url, 'u-mgr');
    await api.close();
    await expect(call(url, 'GET', '/v1/catalogue/products/SALT', b.cookie)).rejects.toThrow();
  });
});
