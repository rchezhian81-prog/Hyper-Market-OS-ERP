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
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import { addDays } from '../../packages/workforce/src/working-time';

/**
 * **Round 8 · OB-522 (M25-FR-03 · OB-502) in a real browser: the Staff certificates page, served by the store computer, over
 * head office's real certificate routes (OB-380).**
 *
 * The real store computer serves the page as the person the front signed in; head office's API runs in memory and every `/v1`
 * call reaches it as that person on the box's own origin. Through Chromium:
 *   • Kumar the cook has no certificate: head office refuses his bakery run, and the page says his food-handling work is
 *     BLOCKED, in English and Tamil;
 *   • Asha (a manager) records his FoSTaC certificate from the pick-list WITHOUT ticking "I have seen it": the page lists it as
 *     not verified and he is still blocked (and his run still refused);
 *   • Kumar opens the page himself: he is offered no "Verify" on his own certificate;
 *   • the manager who saw the original presses "Verify — I have seen it": the page now says his food-handling work is allowed
 *     until the certificate's last day, and head office takes his run;
 *   • "Renew" fills the form with the person and the kind; the page is in Tamil on the toggle;
 *   • a cashier whom the box lets open the page is refused by head office, said in its words.
 * Synthetic data only. Without a browser binary it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['r8c', 'certs', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();
const OWNER = 'u-owner'; const MANAGER = 'u-mgr'; const ASHA = 'u-asha'; const COOK = 'u-kumar'; const CASHIER = 'u-cash';
const STORE = 'store-1';
const TODAY = shopDateIn(new Date().toISOString());
const UNTIL = addDays(TODAY, 365);

describe.skipIf(!HAVE_BROWSER)('the Staff certificates page through the store computer (OB-522)', () => {
  let browser: Browser;
  let ho: ApiHarness;
  let edge: EdgeProcess;
  let dir: string;
  const stops: (() => Promise<void>)[] = [];
  let run = 0;
  const bake = async (): Promise<{ status: number; code?: string }> => {
    run += 1;
    const r = await ho.request({ method: 'POST', path: `/v1/production/runs/run-${run}`, userId: COOK, tenantId: TENANT, branchId: STORE, idempotencyKey: `run-${run}`, body: { recipeId: 'r-cake', batches: 1, actualOutputMinor: 1, outputBatchId: `CAKE-${run}`, locationId: STORE } });
    return { status: r.status, code: (r.body as { error?: { code?: string } }).error?.code };
  };

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    ho = apiHarness();
    await ho.seedOwner(TENANT, OWNER);
    for (const who of [MANAGER, ASHA, COOK]) await ho.provisionRole(TENANT, who, 'store_manager', [STORE]);
    await ho.provisionRole(TENANT, CASHIER, 'cashier', [STORE]);
    const post = async (path: string, body: unknown, as = OWNER): Promise<void> => {
      const r = await ho.request({ method: 'POST', path, userId: as, tenantId: TENANT, ...(as === OWNER ? {} : { branchId: STORE }), idempotencyKey: `k-${randomUUID()}`, body });
      expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
    };
    await post('/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' });
    await post(`/v1/org/nodes/${STORE}`, { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' });
    await post('/v1/production/departments/cafe', {});
    await post('/v1/production/recipes/r-cake', { departmentId: 'cafe', outputProductId: 'CAKE', outputQuantityMinor: 1, outputUom: 'ea', inputs: [{ productId: 'FLOUR', quantityMinor: 100, uom: 'g' }], shelfLifeHours: 48 });
    await post('/v1/inventory/movements', { movementId: 'seed-flour', productId: 'FLOUR', locationId: STORE, kind: 'received', quantityMinor: 5_000, uom: 'g', occurredAt: new Date(Date.now() - 86_400_000).toISOString(), enteredBy: OWNER });
    for (const [id, name, roles] of [[COOK, 'Kumar', ['cook']], [ASHA, 'Asha', ['store_manager']], [MANAGER, 'Meena', ['store_manager']]] as const) {
      await post(`/v1/hr/workforce/employees/${id}`, { name, branchId: STORE, roles, active: true }, MANAGER);
    }

    dir = await mkdtemp(join(tmpdir(), 'sre-r8c-certs-screen-'));
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: STORE, branchId: STORE },
      roles: [
        { id: 'manager', name: 'Store manager', permissions: ['identity.self.read', 'workforce.roster.read', 'workforce.roster.manage'] },
        { id: 'cashier', name: 'Cashier', permissions: ['identity.self.read', 'workforce.roster.read'] },
      ],
      roleAssignments: [MANAGER, ASHA, COOK].map((u) => ({ userId: u, roleId: 'manager', branchScope: [STORE] })).concat([{ userId: CASHIER, roleId: 'cashier', branchScope: [STORE] }]),
    }), 'utf8');
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
    }, () => {}))!;
  }, 240_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  /** A page on the box's origin as `who`; head office's API carried on that origin, as that person. */
  const open = async (who: string): Promise<{ page: Page; errors: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': who } });
    stops.push(() => context.close());
    await context.route('**/v1/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const raw = req.postData();
      const answer = await ho.request({
        method: req.method() as 'GET', path: url.pathname, userId: who, tenantId: TENANT, branchId: STORE,
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
    const res = await page.goto(`http://127.0.0.1:${edge.screens!.port}/certificates/`, { waitUntil: 'load' });
    expect(res?.status(), 'the page is served by the store computer').toBe(200);
    return { page, errors };
  };
  const says = (page: Page, selector: string, pattern: RegExp): Promise<unknown> => page.waitForFunction(
    ([sel, src]) => new RegExp(src!).test((globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''),
    [selector, pattern.source], { timeout: 15_000 },
  ).catch(async (e: unknown) => {
    const seen = await page.evaluate((sel) => (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel)?.textContent ?? '(none)', selector);
    throw new Error(`${selector} never said ${pattern.source}; it says: ${JSON.stringify(seen)} (${String(e)})`);
  });
  const kumar = `#people li[data-person="${COOK}"]`;

  it('a cook blocked; his FoSTaC certificate recorded, then verified by a second person on the page; the cook allowed', async () => {
    // ── Kumar has no certificate: head office refuses his bakery run; the page says he is blocked ──
    expect(await bake()).toMatchObject({ status: 422, code: 'food_handling_certificate_missing' });
    const a = await open(ASHA);
    await a.page.waitForSelector(`${kumar}[data-food="blocked"]`);
    await says(a.page, `${kumar} .food`, /Food-handling work: BLOCKED — There is no verified food-handling certificate on file for Kumar/);
    // The pick-list: food handling and FoSTaC (which counts as the same) — nothing else.
    expect(await a.page.$$eval('#c-kind option', (os) => os.map((o) => (o as unknown as { value: string }).value))).toEqual(['food-handling', 'fostac']);

    // ── Asha records it from a photocopy, WITHOUT ticking "I have seen it": not verified, still blocked ──
    await a.page.selectOption('#c-person', COOK);
    await a.page.selectOption('#c-kind', 'fostac');
    await a.page.fill('#c-issued', TODAY);
    await a.page.fill('#c-until', UNTIL);
    await a.page.click('#c-record');
    await says(a.page, '#c-status', /^Recorded at head office\.$/);
    await a.page.waitForSelector(`${kumar} li[data-standing="unverified"]`);
    expect(await a.page.textContent(`${kumar} li[data-standing="unverified"]`)).toMatch(/FoSTaC \(FSSAI food safety training\) — counts as food handling · from .* to .*Not verified/);
    expect(await a.page.getAttribute(kumar, 'data-food')).toBe('blocked');
    expect(await bake()).toMatchObject({ status: 422, code: 'food_handling_certificate_missing' });
    expect(a.errors).toEqual([]);

    // ── Kumar on the page: no "Verify" on his own certificate ──
    const k = await open(COOK);
    await k.page.waitForSelector(`${kumar} li[data-standing="unverified"]`);
    expect(await k.page.$$(`${kumar} button[data-act="verify"]`)).toHaveLength(0);
    expect(await k.page.$$(`${kumar} button[data-act="renew"]`)).toHaveLength(1);

    // ── the manager who saw the original verifies it on the page: Kumar is allowed; head office takes his run ──
    const m = await open(MANAGER);
    await m.page.waitForSelector(`${kumar} li[data-standing="unverified"] button[data-act="verify"]`);
    await m.page.click(`${kumar} li[data-standing="unverified"] button[data-act="verify"]`);
    await m.page.waitForSelector(`${kumar}[data-food="allowed"]`);
    await says(m.page, `${kumar} .food`, new RegExp(`Food-handling work: allowed until ${UNTIL}`));
    expect(await m.page.textContent(`${kumar} li[data-standing="valid"]`)).toMatch(/Verified · in date · verified by u-mgr/);
    await says(m.page, '#l-status', /^Verified at head office in your name\.$/);
    expect((await bake()).status).toBe(201);

    // ── Renew fills the form; Tamil on the toggle ──
    await m.page.click(`${kumar} button[data-act="renew"]`);
    expect(await m.page.inputValue('#c-person')).toBe(COOK);
    expect(await m.page.inputValue('#c-kind')).toBe('fostac');
    expect(await m.page.isVisible('#c-renewing')).toBe(true);
    await m.page.click('#lang');
    await says(m.page, '#record-h', /^சான்றிதழைப் பதிவு செய்$/);
    await says(m.page, `${kumar} .food`, /உணவு கையாளும் வேலை: அனுமதி/);
    expect(m.errors).toEqual([]);
    // The 56px-class targets: the record button is a full tap target.
    expect((await m.page.locator('#c-record').boundingBox())!.height).toBeGreaterThanOrEqual(48);
  });

  it('a cashier the box lets open the page is refused by head office, in its words; she is offered no recording', async () => {
    const c = await open(CASHIER);
    await c.page.waitForSelector('#list:not([hidden])');
    expect(await c.page.isHidden('#record')).toBe(true);
    await says(c.page, '#l-status', /^Head office refused: /);
    expect(c.errors).toEqual([]);
  });
});
