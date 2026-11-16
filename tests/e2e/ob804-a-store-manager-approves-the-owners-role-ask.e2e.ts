import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge } from '../../edge/store-edge/src/main';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { prepareTillBox, pinOf } from '../support/till-operator';
import { aBranch } from '../support/a-branch';
import type { HttpRequest } from '../../services/kernel/src/index';

/**
 * BROWSER. **OB-804 A (owner, 16 Nov 2026, in writing) · daily-work defects D-052 and D-034, on the REAL till service
 * (`startEdge`) and the office API's REAL pipeline over HTTP** — the store PC as installed: office PIN sign-in on, NO head-office
 * sign-in link. The owner, signed in by PIN, asks on Users & roles to give Receiver / QC to the back-store person, his PIN typed
 * again; the request shows as his own (nobody approves their own). The store manager, signed in by PIN, sees it waiting for him
 * on the same page and approves it, his PIN typed again — and the person holds Receiver / QC. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const T = randomUUID();
const KEY = ['ob804', 'role', 'grant', 'box'].join('-').padEnd(48, '0');
const PRIVILEGE_SECRET = randomBytes(32).toString('base64url');
const ROLE_WORDS = ['identity.self.read', 'identity.role.adjust', 'identity.role.request', 'org.branch.read'];
const PACK = {
  version: 1,
  policies: { storeId: 'S1', branchId: 'S1', tradingDayCutoff: '00:00', warehouseId: 'wh-1' },
  lossPreventionRules: [], devices: [],
  roles: [
    { id: 'owner', name: 'Owner', permissions: [...ROLE_WORDS, 'identity.role.grant', 'identity.role.read'] },
    { id: 'store_manager', name: 'Store manager', permissions: ROLE_WORDS },
    { id: 'warehouse_user', name: 'Warehouse user', permissions: ['identity.self.read'] },
  ],
  roleAssignments: [
    { userId: 'u-owner', roleId: 'owner', branchScope: 'all' }, { userId: 'u-mgr', roleId: 'store_manager', branchScope: 'all' },
    { userId: 'u-wh', roleId: 'warehouse_user', branchScope: 'all' },
  ],
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
type Doc = { document: { getElementById(id: string): { textContent: string | null } | null } };
async function says(page: Page, id: string, re: RegExp): Promise<void> {
  try {
    await page.waitForFunction(([el, src]) => new RegExp(src!).test((globalThis as unknown as Doc).document.getElementById(el!)?.textContent ?? ''), [id, re.source] as const);
  } catch { throw new Error(`#${id} says ${JSON.stringify(await page.textContent(`#${id}`))}, not ${String(re)}`); }
}

/** The office API's real pipeline, served over HTTP on this PC's loopback (as SRE-API is on the store PC). */
async function officeApi(): Promise<{ h: ApiHarness; url: string }> {
  const h = apiHarness({ privilegeSealSecret: PRIVILEGE_SECRET });
  await h.seedOwner(T, 'u-owner');
  await aBranch(h, T, 'u-owner', 'S1');
  await h.provisionRole(T, 'u-mgr', 'store_manager');
  await h.provisionRole(T, 'u-wh', 'warehouse_user');
  await h.provisionRole(T, 'u-box', 'store_computer', ['S1']);
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

async function box(api: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sre-ob804-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); await rm(`${dir}-witness`, { recursive: true, force: true }); });
  const env = await prepareTillBox({ dir, key: KEY, pack: PACK, people: [
    { userId: 'u-owner', displayName: 'The Owner' }, { userId: 'u-mgr', displayName: 'Manager' }, { userId: 'u-wh', displayName: 'Back Store' },
  ] });
  const edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
    EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_OFFICE_SIGN_IN: 'pin',
    CLOUD_API_URL: api, CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: 'S1' }),
    BOX_PRIVILEGE_SEAL_KEY: PRIVILEGE_SECRET, ...env,
  }, () => {}))!;
  cleanups.push(async () => { await edge.stop(); });
  return `http://127.0.0.1:${edge.screens!.port}`;
}

describe.skipIf(!HAVE_BROWSER)('in a real browser, on the store PC by PIN: the owner asks for a role, a store manager approves it (OB-804 A)', () => {
  let browser: Browser;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); });

  async function signedIn(url: string, userId: string, path: string): Promise<Page> {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    cleanups.push(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${url}${path}`, { waitUntil: 'load' });
    await page.fill('#office-staff', userId);
    await page.fill('#office-pin', pinOf(userId));
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#office-submit')]);
    return page;
  }
  async function pinAgain(page: Page, userId: string): Promise<void> {
    await page.waitForSelector('#office-pin-again');
    await page.fill('#office-pin-again', pinOf(userId));
    await page.click('#office-pin-confirm button[type="submit"]');
  }
  const holds = async (h: ApiHarness, userId: string, roleId: string): Promise<boolean> => {
    const r = await h.request({ method: 'GET', path: '/v1/identity/grants', userId: 'u-owner', tenantId: T });
    return (r.body as { grants: { userId: string; roleId: string }[] }).grants.some((g) => g.userId === userId && g.roleId === roleId);
  };

  it('the owner asks to give Receiver / QC, by PIN; the store manager approves it on Users & roles, by PIN; the person holds it', async () => {
    const api = await officeApi();
    const url = await box(api.url);
    expect(await holds(api.h, 'u-wh', 'receiver_qc')).toBe(false);

    // The owner asks, on Users & roles, his PIN typed again.
    const owner = await signedIn(url, 'u-owner', '/users/');
    await owner.waitForSelector('#give:not([hidden])');
    await owner.waitForFunction(() => [...(globalThis as unknown as { document: { querySelectorAll(s: string): { value: string }[] } }).document.querySelectorAll('#g-role option')].some((o) => o.value === 'receiver_qc'));
    await owner.fill('#g-person', 'u-wh');
    await owner.selectOption('#g-role', 'receiver_qc');
    await owner.fill('#g-stores', 'S1');
    await owner.fill('#g-reason', 'they receive the deliveries (synthetic)');
    await owner.click('#g-ask');
    await pinAgain(owner, 'u-owner');
    await says(owner, 'give-status', /Asked\./);
    const pending = await api.h.request({ method: 'GET', path: '/v1/identity/grants/pending', userId: 'u-owner', tenantId: T });
    const grantId = (pending.body as { requests: { grantId: string; roleId: string }[] }).requests.find((g) => g.roleId === 'receiver_qc')!.grantId;
    // On the owner's page it is his own: no Approve button for him.
    await owner.goto(`${url}/users/`, { waitUntil: 'load' });
    await owner.waitForSelector(`li[data-grant="${grantId}"]`);
    expect(await owner.$(`li[data-grant="${grantId}"] button`)).toBeNull();
    expect(await holds(api.h, 'u-wh', 'receiver_qc')).toBe(false);

    // The store manager sees it waiting for him, and approves it, his PIN typed again.
    const mgr = await signedIn(url, 'u-mgr', '/users/');
    await mgr.waitForSelector(`li[data-grant="${grantId}"] button`);
    await mgr.fill(`#why-${grantId}`, 'checked with the owner (synthetic)');
    await mgr.click(`li[data-grant="${grantId}"] button:has-text("Approve")`);
    await pinAgain(mgr, 'u-mgr');
    await expect.poll(async () => holds(api.h, 'u-wh', 'receiver_qc'), { timeout: 15_000 }).toBe(true);
  }, 180_000);
});
