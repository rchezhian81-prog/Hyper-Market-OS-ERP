import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { decide } from '../support/approval-request';
import { deliveryPlaces } from '../support/approved-supplier';

/**
 * **D-019 on the Price lists page — head office holds no MRP for an item (daily-work walkthrough, M05-FR-01 · §28).**
 *
 * Before: "Head office holds no MRP for this product on that day … Add the MRP on the Product details page first", and
 * nothing more the manager could do there. Now a box for the MRP printed on the pack appears. The law does not move — head
 * office's own route still refuses a price above that MRP — and no approval is loosened: the entry is never sent on the
 * manager's word alone. It waits for a second person, whose approval is for exactly that entry WITH the typed MRP, and the
 * request tells them to check the MRP on the pack. Then it is saved naming them.
 *
 * Served by the store computer; head office's REAL routes, permission checks and approval engine run in memory, every
 * `/v1` call reaching them as the signed-in person. Synthetic data only. Without a browser binary it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['d019', 'price', 'lists', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();
const OWNER = 'u-owner';
const MANAGER = 'u-mgr';
const STORE = 'store-1';
const ITEM = 'NOMRP-BISC';
const RULES = {
  approvalLimitMinor: 500_000, marginFloorBps: 2_000, nearExpiryDays: 30,
  reporting: { laggingAfterMinutes: 5, staleAfterMinutes: 60 },
  service: { returnWindowDays: 7, approvalThresholdMinor: 200_000, noReceiptCapMinor: 50_000, agentAuthorityMinor: 5_000, compensationCapMinor: 50_000 },
  journalPrefixes: { takings: 'TK', tax: 'TX', refunds: 'RF' }, dormantAfterDays: 60, aiStaleAfterMinutes: 60,
  merchandising: { refillAtBp: 5_000, countStaleAfterMinutes: 120, refillRole: 'store_manager' },
  writeOffMaterialThresholdMinor: 50_000,
  checklist: [{ itemId: 'close-1', description: 'Count every till blind', blocking: true }],
};
const OWNER_WORDS = ['identity.self.read', 'catalogue.pack.read', 'price.change.propose', 'price.change.approve', 'org.branch.read'];
const MANAGER_WORDS = ['identity.self.read', 'catalogue.pack.read', 'price.change.propose', 'org.branch.read'];
const ddmm = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

type Doc = { document: { getElementById(id: string): { textContent: string | null } | null } };

describe.skipIf(!HAVE_BROWSER)('D-019: the Price lists page takes the MRP printed on the pack, checked by a second person', () => {
  let browser: Browser;
  let ho: ApiHarness;
  let edge: EdgeProcess;
  let dir: string;
  const stops: (() => Promise<void>)[] = [];
  const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = OWNER) =>
    ho.request({ method, path, userId, tenantId: TENANT, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
  const ok = async (p: ReturnType<typeof req>, what: string) => { const r = await p; if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r; };

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    ho = apiHarness();
    await ho.seedOwner(TENANT, OWNER);
    await ho.provisionRole(TENANT, MANAGER, 'store_manager');
    await deliveryPlaces(ho, TENANT, STORE);
    await ok(req('POST', `/v1/stores/${STORE}/rules`, RULES), 'store rules');
    // An item head office holds NO MRP for (as an item loaded without one) — but it was received at a cost, so the
    // margin can be checked.
    await ok(req('POST', '/v1/inventory/movements', { movementId: 'rx-nomrp', productId: ITEM, locationId: STORE, kind: 'received', quantityMinor: 24, uom: 'EA', occurredAt: new Date(Date.now() - 86_400_000).toISOString(), enteredBy: OWNER, unitCostMinor: 2_000 }), 'receive');

    dir = await mkdtemp(join(tmpdir(), 'sre-d019-'));
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: STORE, branchId: STORE },
      roles: [{ id: 'owner', name: 'Owner', permissions: OWNER_WORDS }, { id: 'manager', name: 'Store manager', permissions: MANAGER_WORDS }],
      roleAssignments: [{ userId: OWNER, roleId: 'owner', branchScope: 'all' }, { userId: MANAGER, roleId: 'manager', branchScope: 'all' }],
    }), 'utf8');
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
    }, () => {}))!;
  }, 240_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  const open = async (who: string, path: string): Promise<{ page: Page; errors: string[]; posts: { path: string; body: unknown }[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': who } });
    stops.push(() => context.close());
    const posts: { path: string; body: unknown }[] = [];
    await context.route('**/v1/**', async (route) => {
      const r = route.request();
      const url = new URL(r.url());
      const raw = r.postData();
      if (r.method() === 'POST') posts.push({ path: url.pathname, body: raw === null ? undefined : JSON.parse(raw) as unknown });
      const answer = await ho.request({
        method: r.method() as 'GET', path: url.pathname, userId: who, tenantId: TENANT,
        ...(raw === null ? {} : { body: JSON.parse(raw) as unknown }),
        ...(r.headers()['idempotency-key'] === undefined ? {} : { idempotencyKey: r.headers()['idempotency-key'] }),
        ...(url.search === '' ? {} : { query: Object.fromEntries(url.searchParams) }),
      });
      await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body ?? {}) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${edge.screens!.port}${path}`, { waitUntil: 'load' });
    return { page, errors, posts };
  };
  const says = async (page: Page, id: string, re: RegExp): Promise<void> => {
    try {
      await page.waitForFunction(([el, src]) => new RegExp(src!).test((globalThis as unknown as Doc).document.getElementById(el!)?.textContent ?? ''), [id, re.source] as const);
    } catch {
      throw new Error(`#${id} says ${JSON.stringify(await page.textContent(`#${id}`))}, not ${String(re)}`);
    }
  };
  const entryPosts = (posts: { path: string; body: unknown }[]) => posts.filter((p) => p.path.startsWith(`/v1/prices/list/${ITEM}/entries/`));

  it('the box appears; above the pack MRP is refused by head office; at or under it waits for the owner, then saves naming him', async () => {
    const { page, errors, posts } = await open(MANAGER, `/price-lists/?product=${ITEM}`);
    await page.fill('#p-product', ITEM);
    await page.fill('#p-ref', STORE);
    await page.fill('#p-from', ddmm(today));
    await page.click('#read-basis');
    await says(page, 'v-mrp', /^Not known$/);
    await says(page, 'v-cost', /^₹20\.00$/);
    await says(page, 'basis-say', /Type the MRP printed on the pack/);
    expect(await page.isHidden('#p-mrp-wrap'), 'the box for the MRP on the pack is offered').toBe(false);

    // No MRP typed: nothing is sent.
    await page.fill('#p-price', '32');
    await page.click('#save');
    await says(page, 'price-status', /^Head office holds no MRP for this product on that day\. Type the MRP printed on the pack first\.$/);
    expect(entryPosts(posts)).toHaveLength(0);

    // Typed: it is never saved on one person's word — it waits for a second person.
    await page.fill('#p-mrp', '35');
    await page.click('#save');
    await says(page, 'price-status', /^The MRP ₹35\.00 was typed from the pack/);
    expect(entryPosts(posts), 'nothing is sent before the second person approves').toHaveLength(0);
    await page.fill('#p-why', 'new stock; MRP 35 on the pack (synthetic)');
    await page.click('#ask');
    await says(page, 'price-status', /^Asked\./);
    const inbox = (await req('GET', '/v1/approvals/requests')).body as { waitingForMe: { requestId: string; kind: string; summary: string; details: Record<string, unknown> }[] };
    const waiting = inbox.waitingForMe.find((x) => x.kind === 'price_list_entry');
    expect(waiting, 'the owner is asked').toBeDefined();
    expect(waiting!.summary).toMatch(/₹35\.00 was typed from the pack: check the MRP on the pack before approving/);
    expect(waiting!.details).toMatchObject({ productId: ITEM, priceMinor: 3_200, mrpMinor: 3_500, scope: 'store', scopeRef: STORE });

    // The owner checks the pack and approves, in his own session; Save sends exactly that entry naming him.
    expect((await decide(ho, TENANT, OWNER, waiting!.requestId, 'approved', 'checked the pack (synthetic)')).status).toBe(201);
    await page.click('#save');
    // OB-806 A · P-08: the save also says what happened at the tills — here the store's pack could not go (this synthetic
    // item has no GST rate, so the pack would be empty), and the page says so plainly instead of a silent "saved".
    await says(page, 'price-status', new RegExp(`Saved with the approval of ${OWNER}\\. (The tills will have it within 5 minutes\\.|It has NOT reached the tills yet: .*)$`));
    const sent = entryPosts(posts);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ priceMinor: 3_200, mrpMinor: 3_500, approvalId: waiting!.requestId });
    expect(errors).toEqual([]);
  }, 180_000);

  it('a price above the MRP typed from the pack is refused by head office’s own route — no approval can lift it', async () => {
    const r = await req('POST', `/v1/prices/list/${ITEM}/entries/e-above`, {
      scope: 'store', scopeRef: STORE, priceMinor: 3_600, mrpMinor: 3_500, costMinor: 2_000, marginFloorBps: 2_000, currency: 'INR', effectiveFrom: today,
    }, MANAGER);
    expect(r.status).toBe(422);
    expect((r.body as { error: { code: string } }).error.code).toBe('price_above_mrp');
  });
});
