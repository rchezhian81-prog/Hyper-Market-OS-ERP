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
import { aBranch } from '../support/a-branch';

/**
 * **The Shelves and space page's head-office setup tabs, in a real browser, served by the store computer, over head office's
 * real routes (Round 4a: re-audit M04-FR-04 · R8-8 / OB-318 · screen gap audit 31 Oct 2026 Round D · P-08).**
 *
 * Before, a display contract, a cluster's range, a season, the shelf map, the planogram and the floor plan could be set only
 * by a programmer, and the Shelves and space, Floor heat map and Shelf compliance pages were dead ends. Now the real store
 * computer serves the page; head office's API runs in memory with its real routes and permission checks, reached on the box's
 * own origin as the signed-in person. Through Chromium:
 *   • the merchandiser publishes the shelf map, the planogram and the floor plan for a store — each a version head office
 *     then holds; a plan on a shelf the store has not mapped is refused in head office's own words;
 *   • lists and drops an item in every store of a cluster (the price-zone register) — the drop goes to clearance where head
 *     office holds stock — sees a store's range, makes a season plan and sees it listed;
 *   • records a display contract with Finance's approval: asks, a different person (the accountant) approves at head office,
 *     the merchandiser records naming that approval — head office's review shows it approved;
 *   • with no answer from head office the screen says nothing was saved; a floor reader is offered no change; Tamil.
 * Synthetic data only. Without a browser binary it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['merch', 'setup', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();
const MANAGER = 'u-mgr';
const FLOOR = 'u-floor';
const ACCOUNTANT = 'u-acct';
const MERCH_PERMISSIONS = ['merchandising.range.read', 'merchandising.range.manage', 'merchandising.display.manage', 'planogram.publish', 'planogram.compliance.read', 'merchandising.space.read'];

interface SetupWindow { readonly merchSetup?: { readonly today: string } }

describe.skipIf(!HAVE_BROWSER)('the Shelves and space setup tabs reach head office through the store computer (M04-FR-04 · R8-8 · Round D)', () => {
  let browser: Browser;
  let ho: ApiHarness;
  let edge: EdgeProcess;
  let dir: string;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    ho = apiHarness();
    await ho.seedOwner(TENANT, 'u-owner');
    await aBranch(ho, TENANT, 'u-owner', 'S1');
    await ho.provisionRole(TENANT, MANAGER, 'store_manager');
    await ho.provisionRole(TENANT, FLOOR, 'cashier');
    await ho.provisionRole(TENANT, ACCOUNTANT, 'accountant');
    const seed = async (method: 'POST' | 'PUT', path: string, body: unknown): Promise<void> => {
      const r = await ho.request({ method, path, userId: 'u-owner', tenantId: TENANT, idempotencyKey: `seed-${randomUUID()}`, body });
      if (r.status >= 300) throw new Error(`${path}: ${r.status} ${JSON.stringify(r.body)}`);
    };
    await seed('POST', '/v1/catalogue/tax-classes/1006/rates/2017-07-01', { rateBps: 500 });
    for (const id of ['diya', 'crackers']) {
      await seed('POST', `/v1/catalogue/products/${id}/publish`, { product: { sku: `SKU-${id}`, name: id, baseUom: 'each', primaryCategoryId: 'festive', taxClass: '1006', lifecycle: 'active' }, categories: [{ categoryId: 'festive', name: 'Festive', parentId: null }] });
    }
    // The cluster is the price-zone register (OB-318): S1 is in zone "north". Head office holds 7 diya at S1.
    await seed('POST', '/v1/prices/zones/north/stores/S1', {});
    await seed('POST', '/v1/inventory/movements', { movementId: 'stock-diya', productId: 'diya', locationId: 'S1', kind: 'received', quantityMinor: 7, uom: 'each', occurredAt: '2026-01-01T00:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 100 });

    dir = await mkdtemp(join(tmpdir(), 'sre-merch-setup-'));
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: 'S1', branchId: 'S1', warehouseId: 'S1-BACK' },
      // The policy names the merchandiser but no permissions: the box tells the page the person's own from its role register.
      merchandisingPolicy: { refillAtBp: 5_000, countStaleAfterMinutes: 120, refillRole: 'shelf-filler', userId: MANAGER },
      roles: [
        { id: 'manager', name: 'Store manager', permissions: ['identity.self.read', ...MERCH_PERMISSIONS] },
        { id: 'floor', name: 'Floor', permissions: ['identity.self.read', 'merchandising.range.read', 'planogram.compliance.read'] },
      ],
      roleAssignments: [{ userId: MANAGER, roleId: 'manager', branchScope: 'all' }, { userId: FLOOR, roleId: 'floor', branchScope: 'all' }],
    }), 'utf8');
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
    }, () => {}))!;
  }, 240_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  /** The page on the box's origin as `who`; head office's API carried on that origin as that person (or cut off). */
  const open = async (who: string, tab: string, opts: { cutOff?: boolean } = {}): Promise<{ page: Page; errors: string[]; v1: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': who } });
    stops.push(() => context.close());
    const v1: string[] = [];
    await context.route('**/v1/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      v1.push(`${req.method()} ${url.pathname}`);
      if (opts.cutOff === true) { await route.abort('connectionreset'); return; }
      const raw = req.postData();
      const answer = await ho.request({
        method: req.method() as 'GET', path: url.pathname, userId: who, tenantId: TENANT,
        ...(raw === null ? {} : { body: JSON.parse(raw) as unknown }),
        ...(req.headers()['idempotency-key'] === undefined ? {} : { idempotencyKey: req.headers()['idempotency-key'] }),
        ...(url.search === '' ? {} : { query: Object.fromEntries(url.searchParams) }),
      });
      await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body ?? {}) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const res = await page.goto(`http://127.0.0.1:${edge.screens!.port}/merchandising/`, { waitUntil: 'load' });
    expect(res?.status(), 'the page is served by the store computer').toBe(200);
    await page.waitForFunction(() => (globalThis as unknown as SetupWindow).merchSetup !== undefined);
    await page.click(`#tab-${tab}`);
    return { page, errors, v1 };
  };
  const statusOf = async (page: Page, id: string): Promise<string> => {
    await page.waitForFunction((sel) => ((globalThis as unknown as { document: { getElementById(i: string): { textContent: string } | null } }).document.getElementById(sel)?.textContent ?? '') !== '', id);
    return ((await page.textContent(`#${id}`)) ?? '').trim();
  };
  const hoGet = async (path: string, query: Record<string, string> = {}): Promise<{ status: number; body: unknown }> =>
    ho.request({ method: 'GET', path, userId: 'u-owner', tenantId: TENANT, query });
  /** Fill line `n` (from 1) of a grid with the given boxes. */
  const fillLine = async (page: Page, grid: string, n: number, values: Record<string, string | boolean>): Promise<void> => {
    for (const [field, value] of Object.entries(values)) {
      const box = page.locator(`#${grid} tr[data-line="${n}"] [data-field="${field}"]`);
      if (typeof value === 'boolean') { if (value) await box.check(); else await box.uncheck(); } else if (field === 'zone') await box.selectOption(value); else await box.fill(value);
    }
  };

  it('with no answer from head office the layout and the contract say nothing was saved, and head office holds nothing', async () => {
    const { page, errors, v1 } = await open(MANAGER, 'layout', { cutOff: true });
    await fillLine(page, 'sm-rows', 1, { locationId: 'A1', aisle: '1', rack: '1', bay: '1', shelf: '1', position: '1' });
    await page.click('#sm-publish');
    expect(await statusOf(page, 'sm-status')).toBe('Head office cannot be reached — nothing was saved. Try again when the connection is back.');
    expect(v1).toEqual(['PUT /v1/merchandising/stores/S1/shelf-map']);
    expect((await hoGet('/v1/merchandising/stores/S1/shelf-map')).status).toBe(404);
    await page.click('#tab-space');
    for (const [id, value] of [['#ct-id', 'DC-0'], ['#ct-supplier', 'sup-x'], ['#ct-description', 'Stand'], ['#ct-funding', '100'], ['#ct-ends', '2026-12-31']]) await page.fill(id!, value!);
    await page.click('#ct-record');
    expect(await statusOf(page, 'ct-status')).toBe('Head office cannot be reached — nothing was saved. Try again when the connection is back.');
    expect(v1).toEqual(['PUT /v1/merchandising/stores/S1/shelf-map', 'POST /v1/merchandising/display-contracts/DC-0']);
    expect(errors).toEqual([]);
  });

  it('a floor reader is offered no change: the publish, cluster and contract buttons are off and the page says why', async () => {
    const { page, errors } = await open(FLOOR, 'layout');
    expect(await page.isDisabled('#sm-publish')).toBe(true);
    expect(await page.isDisabled('#ly-load')).toBe(false);
    expect((await page.textContent('#layout-note'))?.trim()).toBe('Your role can read the layout but not publish it.');
    await page.click('#tab-clusters');
    expect(await page.isDisabled('#cl-list-btn')).toBe(true);
    expect(await page.isDisabled('#cl-show')).toBe(false);
    await page.click('#tab-space');
    expect(await page.isDisabled('#ct-record')).toBe(true);
    expect((await page.textContent('#contract-note'))?.trim()).toBe('Your role cannot record display contracts.');
    expect(errors).toEqual([]);
  });

  it('publishes the shelf map, the planogram and the floor plan as versions head office holds; a plan on an unmapped shelf is refused in head office\'s words', async () => {
    const { page, errors, v1 } = await open(MANAGER, 'layout');
    await page.click('#ly-load');
    expect(await statusOf(page, 'sm-meta')).toBe('No shelf map is published for this store yet.');
    expect(await page.textContent('#fp-meta')).toBe('No floor plan is published for this store yet.');

    await fillLine(page, 'sm-rows', 1, { locationId: 'A1', aisle: '1', rack: '1', bay: '1', shelf: '1', position: '1', zone: 'ambient', label: 'Lamps' });
    await page.click('#sm-add');
    await fillLine(page, 'sm-rows', 2, { locationId: 'B1', aisle: '2', rack: '1', bay: '1', shelf: '1', position: '1' });
    await page.click('#sm-publish');
    expect(await statusOf(page, 'sm-status')).toBe('Shelf map published at head office — version 1');
    const map = (await hoGet('/v1/merchandising/stores/S1/shelf-map')).body as { shelfMap: { version: number; publishedBy: string; locations: { locationId: string }[] } };
    expect(map.shelfMap).toMatchObject({ version: 1, publishedBy: MANAGER });
    expect(map.shelfMap.locations.map((l) => l.locationId)).toEqual(['A1', 'B1']);

    // A facing on a shelf the store has not mapped: head office refuses it, in its own words; nothing is stored.
    await page.fill('#pg-id', 'main');
    await fillLine(page, 'pg-rows', 1, { productId: 'diya', locationId: 'Z9', capacity: '40', primary: true });
    await page.click('#pg-publish');
    const refused = await statusOf(page, 'pg-status');
    expect(refused.startsWith('Head office refused: ')).toBe(true);
    expect(refused).toContain('Z9');
    expect(((await hoGet('/v1/merchandising/stores/S1/planograms')).body as { plans: unknown[] }).plans).toEqual([]);

    await fillLine(page, 'pg-rows', 1, { locationId: 'A1' });
    await page.click('#pg-add');
    await fillLine(page, 'pg-rows', 2, { productId: 'crackers', locationId: 'B1', capacity: '20', primary: true });
    await page.click('#pg-publish');
    await page.waitForFunction(() => ((globalThis as unknown as { document: { getElementById(i: string): { textContent: string } } }).document.getElementById('pg-status').textContent).includes('version'));
    expect((await page.textContent('#pg-status'))?.trim()).toBe('Planogram published at head office — version 1');
    const plans = (await hoGet('/v1/merchandising/stores/S1/planograms')).body as { inForce: { planogramId: string; assignments: unknown[] } | null };
    expect(plans.inForce).toMatchObject({ planogramId: 'main', assignments: [{ productId: 'diya', locationId: 'A1', capacityMinor: 40, primary: true }, { productId: 'crackers', locationId: 'B1', capacityMinor: 20, primary: true }] });

    await page.fill('#fp-width', '40');
    await page.fill('#fp-depth', '30');
    await fillLine(page, 'fp-rows', 1, { areaId: 'festive', name: 'Festive', nameTa: 'பண்டிகை', x: '0', y: '0', width: '10', depth: '10', places: 'A1, B1' });
    await page.click('#fp-publish');
    expect(await statusOf(page, 'fp-status')).toBe('Floor plan published at head office — version 1');
    expect((await hoGet('/v1/merchandising/stores/S1/floor-plan')).body).toMatchObject({ plan: { version: 1, widthFt: 40, depthFt: 30, areas: [{ areaId: 'festive', nameTa: 'பண்டிகை', locationIds: ['A1', 'B1'] }] } });
    expect(v1.filter((c) => !c.startsWith('GET'))).toEqual([
      'PUT /v1/merchandising/stores/S1/shelf-map', 'PUT /v1/merchandising/stores/S1/planograms/main', 'PUT /v1/merchandising/stores/S1/planograms/main', 'POST /v1/merchandising/stores/S1/floor-plan',
    ]);

    // Loading again starts from the versions in force.
    await page.click('#ly-load');
    await page.waitForFunction(() => ((globalThis as unknown as { document: { getElementById(i: string): { textContent: string } } }).document.getElementById('sm-meta').textContent).startsWith('Version 1'));
    expect(await page.inputValue('#sm-rows tr[data-line="2"] [data-field="locationId"]')).toBe('B1');
    expect(await page.inputValue('#fp-rows tr[data-line="1"] [data-field="places"]')).toBe('A1, B1');
    expect(errors).toEqual([]);
  });

  it('lists and drops an item in every store of a cluster (clearance where head office holds stock), shows a store\'s range, and makes a season plan', async () => {
    const { page, errors } = await open(MANAGER, 'clusters');
    const today = await page.evaluate(() => (globalThis as unknown as SetupWindow).merchSetup!.today);
    await page.click('#cl-show');
    await page.locator('#cl-list tr[data-zone="north"]').waitFor();
    expect((await page.textContent('#cl-list tr[data-zone="north"]'))?.trim()).toBe('northS1');

    await page.fill('#cl-zone', 'north');
    await page.fill('#cl-product', 'diya');
    await page.click('#cl-list-btn');
    expect(await statusOf(page, 'cl-status')).toBe('Listed at head office in S1');
    await page.click('#sr-show');
    expect(await statusOf(page, 'sr-status')).toBe(`S1 · ${today}: diya`);

    await page.selectOption('#cl-reason', 'poor_sales');
    await page.click('#cl-drop-btn');
    await page.waitForFunction(() => ((globalThis as unknown as { document: { getElementById(i: string): { textContent: string } } }).document.getElementById('cl-status').textContent).startsWith('Head office recorded the drop'));
    expect((await page.textContent('#cl-status'))?.trim()).toBe('Head office recorded the drop: S1 — put on clearance (stock on hand)');

    await page.fill('#se-plan', 'diwali');
    await page.fill('#se-scope-id', 'north');
    await page.fill('#se-products', 'crackers');
    await page.fill('#se-to', today);
    await page.fill('#se-reason', 'Diwali');
    await page.click('#se-make');
    expect(await statusOf(page, 'se-status')).toBe('Season plan made at head office for S1');
    await page.locator('#se-list tr[data-plan="diwali"]').waitFor();
    expect((await page.textContent('#se-list tr[data-plan="diwali"] .standing'))?.trim()).toBe('in season');
    expect(((await hoGet('/v1/merchandising/season-plans')).body as { plans: { planId: string; productIds: string[] }[] }).plans).toMatchObject([{ planId: 'diwali', productIds: ['crackers'] }]);

    await page.click('#lang');
    await page.waitForFunction(() => (globalThis as unknown as { document: { documentElement: { lang: string } } }).document.documentElement.lang === 'ta');
    // The shared chrome decorates each tab with its section's first sentence; the tab's own word leads it.
    expect((await page.textContent('#tab-clusters'))?.startsWith('கடைக் குழுக்களும் பருவங்களும்')).toBe(true);
    expect(await page.textContent('#cl-list-btn')).toBe('குழுவின் ஒவ்வொரு கடையிலும் சேர்');
    expect((await page.textContent('#se-list tr[data-plan="diwali"] .standing'))?.trim()).toBe('பருவத்தில்');
    expect(errors).toEqual([]);
  });

  it('records a display contract with Finance\'s approval: asks, the accountant approves at head office, the contract is recorded naming that approval', async () => {
    const { page, errors, v1 } = await open(MANAGER, 'space');
    await page.fill('#ct-id', 'DC-1');
    await page.fill('#ct-supplier', 'sup-lamps');
    await page.fill('#ct-description', 'End-cap aisle 1');
    await page.fill('#ct-funding', '5000');
    await page.fill('#ct-ends', '2026-12-31');
    await page.fill('#ct-places', 'A1');
    await page.click('#ct-ask');
    expect(await statusOf(page, 'ct-status')).toBe('Write why, for Finance. Nothing was sent.');
    expect(v1).toEqual([]);
    await page.fill('#ct-reason', 'Festive end-cap');
    await page.click('#ct-ask');
    await page.waitForFunction(() => ((globalThis as unknown as { document: { getElementById(i: string): { textContent: string } } }).document.getElementById('ct-status').textContent).startsWith('Asked.'));
    await page.locator('#ct-asks li[data-ask]').waitFor();
    expect((await page.textContent('#ct-asks li[data-ask] .pill'))?.trim()).toBe('waiting for Finance');

    // A different person, who may approve suppliers, approves it at head office in their own session.
    const inbox = (await ho.request({ method: 'GET', path: '/v1/approvals/requests', userId: ACCOUNTANT, tenantId: TENANT })).body as { waitingForMe: { requestId: string; kind: string }[] };
    const ask = inbox.waitingForMe.find((q) => q.kind === 'display_contract')!;
    expect(ask).toBeDefined();
    const decided = await ho.request({ method: 'POST', path: `/v1/approvals/requests/${ask.requestId}/decide`, userId: ACCOUNTANT, tenantId: TENANT, idempotencyKey: 'decide-dc-1', body: { decision: 'approved', reason: 'terms agreed' } });
    expect(decided.status).toBeLessThan(300);

    await page.click('#ct-asks-show');
    await page.locator('#ct-asks li[data-ask] button').waitFor();
    expect((await page.textContent('#ct-asks li[data-ask] .pill'))?.trim()).toBe(`approved by ${ACCOUNTANT}`);
    await page.click('#ct-asks li[data-ask] button');
    await page.waitForFunction(() => ((globalThis as unknown as { document: { getElementById(i: string): { textContent: string } } }).document.getElementById('ct-status').textContent).startsWith('Recorded'));
    expect((await page.textContent('#ct-status'))?.trim()).toBe('Recorded at head office, with Finance’s approval.');
    await page.locator('#ct-asks li[data-ask] .pill').filter({ hasText: 'already used' }).waitFor();

    const review = await ho.request({ method: 'POST', path: '/v1/merchandising/display-contracts/review', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'review-1', body: { onDate: '2026-11-15', currency: 'INR', storeId: 'S1' } });
    const status = (review.body as { statuses: { contractId: string; finding: string }[] }).statuses.find((s) => s.contractId === 'DC-1');
    expect(status, JSON.stringify(review.body)).toBeDefined();
    expect(status!.finding).not.toBe('unapproved');
    expect(errors).toEqual([]);
  });
});
