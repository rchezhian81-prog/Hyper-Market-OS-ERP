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
import { seedOnlineShop, listShopOnline, callsFor, CUSTOMER, OTHER_CUSTOMER, STORE, MANAGER, CASHIER } from '../support/online-shop';
import { dayIn } from '../../services/api/src/customer-commerce-adapters';

/**
 * **Customers' repeat orders on the Delivery exceptions page, in a real browser served by the store computer, over head
 * office's real routes (M17-FR-02 subscriptions · OB-303 · P-03 · Round 4b — "no screen reads repeat orders").**
 *
 * Through Chromium:
 *   • the manager reads every repeat order — the milk plan and the saree plan — and, after "Place the ones due now", the days
 *     not placed come first in the shop's own words (a saree is not sold online); running it again places nothing twice;
 *   • a cashier (no order read) is not served the page by the store computer, and head office refuses the read too.
 * Synthetic data only. Without a browser binary it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const KEY = ['repeat', 'orders', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();

describe.skipIf(!existsSync(CHROMIUM))('repeat orders on the Delivery exceptions page (M17-FR-02 · OB-303)', () => {
  let browser: Browser;
  let ho: ApiHarness;
  let edge: EdgeProcess;
  let dir: string;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    ho = apiHarness();
    const c = callsFor(() => ho, TENANT);
    await seedOnlineShop(ho, TENANT, c);
    await listShopOnline(c);
    const today = dayIn(new Date().toISOString(), 'Asia/Kolkata');
    const plan = (productId: string) => ({ lines: [{ productId, quantityMinor: 1 }], locationId: STORE, schedule: { kind: 'every_days', days: 1 }, startsOn: today, fulfilment: 'pickup' });
    for (const [id, product, who] of [['S-MILK', 'MILK', CUSTOMER], ['S-SAREE', 'SAREE', OTHER_CUSTOMER]] as const) {
      const r = await c.req('POST', `/v1/me/subscriptions/${id}`, plan(product), who);
      if (r.status !== 201) throw new Error(`plan ${id}: ${JSON.stringify(r.body)}`);
    }
    dir = await mkdtemp(join(tmpdir(), 'sre-repeat-orders-'));
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: STORE, branchId: STORE },
      substitutionExceptionPolicy: { permissions: [] },
      roles: [
        { id: 'manager', name: 'Manager', permissions: ['identity.self.read', 'order.read', 'order.exception.manage'] },
        { id: 'cashier', name: 'Cashier', permissions: ['identity.self.read'] },
      ],
      roleAssignments: [{ userId: MANAGER, roleId: 'manager', branchScope: 'all' }, { userId: CASHIER, roleId: 'cashier', branchScope: 'all' }],
    }), 'utf8');
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
    }, () => {}))!;
  }, 240_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  const open = async (who: string): Promise<{ page: Page; errors: string[]; writes: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': who } });
    stops.push(() => context.close());
    const writes: string[] = [];
    await context.route('**/v1/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const raw = req.postData();
      if (req.method() !== 'GET') writes.push(`${req.method()} ${url.pathname}`);
      const answer = await ho.request({
        method: req.method() as 'GET', path: url.pathname, userId: who, tenantId: TENANT,
        ...(raw === null ? {} : { body: JSON.parse(raw) as unknown }),
        ...(req.headers()['idempotency-key'] === undefined ? {} : { idempotencyKey: req.headers()['idempotency-key'] }),
      });
      await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body ?? {}) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const res = await page.goto(`http://127.0.0.1:${edge.screens!.port}/substitution-exceptions/`, { waitUntil: 'load' });
    expect(res?.status()).toBe(200);
    return { page, errors, writes };
  };
  const says = (page: Page, selector: string, pattern: RegExp): Promise<unknown> => page.waitForFunction(
    ([sel, src]) => new RegExp(src!).test((globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''),
    [selector, pattern.source], { timeout: 15_000 },
  );

  it('the manager reads the repeat orders, places the ones due, and the days not placed come first in the shop\'s words', async () => {
    const m = await open(MANAGER);
    await m.page.waitForSelector('#repeat:not([hidden])');
    await m.page.click('#repeat-show');
    await m.page.waitForSelector('#repeat-plans li[data-subscription="S-MILK"][data-state="active"]');
    expect(await m.page.textContent('#repeat-plans li[data-subscription="S-SAREE"]')).toMatch(/On · collect at store-01 · 1 items/);
    await says(m.page, '#repeat-not-placed', /Every repeat order due so far was placed\./);
    await m.page.click('#repeat-run');
    await says(m.page, '#repeat-status', /^Done — placed 2 · not placed 2 · missed 0$/);
    await m.page.waitForSelector('#repeat-not-placed li[data-subscription="S-SAREE"][data-outcome="not_placed"]');
    expect(await m.page.textContent('#repeat-not-placed li[data-subscription="S-SAREE"]')).toMatch(/Not placed — Not placed: SAREE: .*Nothing was charged\./);
    expect(await m.page.locator('#repeat-not-placed li[data-subscription="S-MILK"]').count()).toBe(0);
    await m.page.click('#repeat-run');
    await says(m.page, '#repeat-status', /^Nothing was due — nothing was placed twice\.$/);
    await m.page.click('#lang');
    await says(m.page, '#repeat-h', /^தொடர் ஆர்டர்கள்$/);
    expect(m.writes).toEqual(['POST /v1/repeat-orders/run', 'POST /v1/repeat-orders/run']);
    expect(m.errors).toEqual([]);
  }, 120_000);

  it('a cashier is not served the page, and head office refuses the read', async () => {
    expect((await ho.request({ method: 'GET', path: '/v1/repeat-orders', userId: CASHIER, tenantId: TENANT })).status).toBe(403);
    // The store computer does not even serve the page to a person without the order read (the menu's own rule).
    const context = await browser.newContext({ serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': CASHIER } });
    stops.push(() => context.close());
    const res = await (await context.newPage()).goto(`http://127.0.0.1:${edge.screens!.port}/substitution-exceptions/`);
    expect(res?.status()).toBe(403);
  }, 60_000);
});
