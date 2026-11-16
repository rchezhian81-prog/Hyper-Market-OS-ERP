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
import type { HttpRequest } from '../../services/kernel/src/index';

/**
 * BROWSER. **CR-01 step 4c-2 · ADR-0034 · ADR-0033 §2 · OB-740 "B" · OB-809 A, on the REAL till service (`startEdge`) and the
 * office API's REAL pipeline over HTTP** — the store PC as installed: office PIN sign-in on, NO head-office sign-in link.
 *   (a) the store manager, signed in by PIN, asks on Users & roles for Warehouse user + "See floor indents", his PIN typed
 *       again; the owner, signed in by PIN, approves it on the Approvals page, his PIN typed again — it is applied at once,
 *       and a Warehouse user may then read the floor indents (refused before);
 *   (b) the store manager cannot approve his own request;
 *   (c) a never-from-a-screen permission is not offered, and refused by head office if sent anyway;
 *   (d) undo: the owner switches it back off the same way, a store manager approves, and the Warehouse user is refused again.
 * Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const T = randomUUID();
const KEY = ['c4c2', 'role', 'change', 'box'].join('-').padEnd(48, '0');
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
    { userId: 'u-mgr2', roleId: 'store_manager', branchScope: 'all' }, { userId: 'u-wh', roleId: 'warehouse_user', branchScope: 'all' },
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
  await h.provisionRole(T, 'u-mgr', 'store_manager');
  await h.provisionRole(T, 'u-mgr2', 'store_manager');
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
  const dir = await mkdtemp(join(tmpdir(), 'sre-4c2-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); await rm(`${dir}-witness`, { recursive: true, force: true }); });
  const env = await prepareTillBox({ dir, key: KEY, pack: PACK, people: [
    { userId: 'u-owner', displayName: 'The Owner' }, { userId: 'u-mgr', displayName: 'Manager' }, { userId: 'u-mgr2', displayName: 'Second Manager' }, { userId: 'u-wh', displayName: 'Back Store' },
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

describe.skipIf(!HAVE_BROWSER)('in a real browser, on the store PC by PIN: two people change what a role may do (CR-01 step 4c-2 · OB-809)', () => {
  let browser: Browser;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); });

  /** One person at the office screens, signed in with their own staff id and PIN, on `path`. */
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
  /** The PIN box the page opens for a privilege act: the person types their own PIN again. */
  async function pinAgain(page: Page, userId: string): Promise<void> {
    await page.waitForSelector('#office-pin-again');
    await page.fill('#office-pin-again', pinOf(userId));
    await page.click('#office-pin-confirm button[type="submit"]');
  }
  async function askOnUsersPage(page: Page, userId: string, roleId: string, change: 'add' | 'remove', permission: string, reason: string): Promise<void> {
    await page.waitForSelector('#role-change:not([hidden])');
    await page.waitForFunction((r) => [...(globalThis as unknown as { document: { querySelectorAll(s: string): { value: string }[] } }).document.querySelectorAll('#rc-role option')].some((o) => o.value === r), roleId);
    await page.selectOption('#rc-role', roleId);
    await page.selectOption('#rc-change', change);
    await page.selectOption('#rc-perm', permission);
    await page.fill('#rc-reason', reason);
    await page.click('#rc-ask');
    await pinAgain(page, userId);
  }
  async function approveOnApprovalsPage(page: Page, userId: string, approvalId: string): Promise<void> {
    await page.waitForSelector(`li[data-request-id="${approvalId}"] button.approve`);
    await page.fill(`#reason-${approvalId}`, 'checked with the team (synthetic)');
    await page.click(`li[data-request-id="${approvalId}"] button.approve`);
    await pinAgain(page, userId);
  }
  const indentsFor = async (h: ApiHarness, userId: string) => (await h.request({ method: 'GET', path: '/v1/floor/indents', userId, tenantId: T, branchId: 'S1' })).status;
  const waitingRoleChange = async (h: ApiHarness): Promise<string> => {
    const inbox = await h.request({ method: 'GET', path: '/v1/approvals/requests', userId: 'u-owner', tenantId: T });
    const all = [...((inbox.body as { waitingForMe: { requestId: string; kind: string; status: string }[] }).waitingForMe), ...((inbox.body as { mine: { requestId: string; kind: string; status: string }[] }).mine)];
    return all.filter((r) => r.kind === 'role_permission_change' && r.status === 'waiting').at(-1)!.requestId;
  };

  it('(a)–(d): asked by the manager, approved by the owner, each by PIN — applied at once; own approval and a never-list permission refused; undone the same way', async () => {
    const api = await officeApi();
    const url = await box(api.url);
    expect(await indentsFor(api.h, 'u-wh')).toBe(403);

    // (a) The manager asks, on Users & roles, his PIN typed again.
    const mgr = await signedIn(url, 'u-mgr', '/users/');
    await askOnUsersPage(mgr, 'u-mgr', 'warehouse_user', 'add', 'inventory.indent.read', 'the back store fills the shelves from the floor indents (synthetic)');
    await says(mgr, 'rc-status', /Asked\. A second person must approve it on the Approvals page/);
    const approvalId = await waitingRoleChange(api.h);
    expect(await indentsFor(api.h, 'u-wh')).toBe(403); // asked, not approved: nobody's access changed

    // (c) A never-from-a-screen permission is not offered for any role…
    await mgr.selectOption('#rc-role', 'warehouse_user');
    await mgr.selectOption('#rc-change', 'add');
    const offered = await mgr.$$eval('#rc-perm option', (os) => os.map((o) => (o as unknown as { value: string }).value));
    expect(offered).toContain('inventory.indent.request');
    expect(offered).not.toContain('identity.role.adjust');
    expect(offered).not.toContain('approvals.rules.ownerrequest.approve');
    // …and sent anyway through the store computer's door, head office refuses it.
    const never = await mgr.evaluate(async ([pin]) => {
      const r = await fetch('/office/privilege/role-permissions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin, request: { requestId: 'rpc-never', roleId: 'warehouse_user', permission: 'identity.role.adjust', change: 'add', reason: 'should be refused' } }) });
      return { status: r.status, body: await r.json() as { ok: boolean; code?: string } };
    }, [pinOf('u-mgr')]);
    expect(never.status).toBe(422);
    expect(never.body).toMatchObject({ ok: false, code: 'not_changeable_from_a_screen' });

    // (b) The manager cannot approve his own request: it is not offered to him, and his PIN at the door is refused.
    await mgr.goto(`${url}/approvals/`, { waitUntil: 'load' });
    await mgr.waitForTimeout(500);
    expect(await mgr.$(`li[data-request-id="${approvalId}"] button.approve`)).toBeNull();
    const own = await mgr.evaluate(async ([pin, id]) => {
      const r = await fetch(`/office/privilege/role-permissions/${id}/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin, request: { decision: 'approved', reason: 'my own' } }) });
      return { status: r.status, body: await r.json() as { ok: boolean } };
    }, [pinOf('u-mgr'), approvalId] as const);
    expect(own.body.ok).toBe(false);
    expect(await indentsFor(api.h, 'u-wh')).toBe(403);

    // (a) The owner approves on the Approvals page, his PIN typed again: applied at once.
    const owner = await signedIn(url, 'u-owner', '/approvals/');
    await approveOnApprovalsPage(owner, 'u-owner', approvalId);
    await expect.poll(async () => indentsFor(api.h, 'u-wh'), { timeout: 15_000 }).toBe(200);
    const view = await api.h.request({ method: 'GET', path: '/v1/identity/role-permissions', userId: 'u-owner', tenantId: T });
    expect((view.body as { history: { requestedBy: string; approvedBy: string; permission: string; change: string }[] }).history)
      .toEqual([expect.objectContaining({ requestedBy: 'u-mgr', approvedBy: 'u-owner', permission: 'inventory.indent.read', change: 'add' })]);

    // (d) Undo: the owner asks to switch it back off (from the recorded change's Undo), a store manager approves.
    await owner.goto(`${url}/users/`, { waitUntil: 'load' });
    await owner.waitForSelector('#rc-history li[data-change] button');
    await owner.click('#rc-history li[data-change] button');
    expect(await owner.inputValue('#rc-change')).toBe('remove');
    expect(await owner.inputValue('#rc-perm')).toBe('inventory.indent.read');
    await owner.fill('#rc-reason', 'back to the built-in role (synthetic)');
    await owner.click('#rc-ask');
    await pinAgain(owner, 'u-owner');
    await says(owner, 'rc-status', /Asked\./);
    const undoId = await waitingRoleChange(api.h);
    const mgr2 = await signedIn(url, 'u-mgr2', '/approvals/');
    await approveOnApprovalsPage(mgr2, 'u-mgr2', undoId);
    await expect.poll(async () => indentsFor(api.h, 'u-wh'), { timeout: 15_000 }).toBe(403);
  }, 180_000);
});
