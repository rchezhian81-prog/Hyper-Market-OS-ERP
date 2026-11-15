import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { TEST_PACK_KEY } from '../support/api-harness';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **D-005 (daily-work defects, fix batch 3) — Products says "Not on the tills — no price", in red, with the reason, for an
 * item the tills were not given; never "On sale".**
 *
 * In the walkthrough milk (11% margin) was refused its price by the 20% margin floor, so head office left it out of the till
 * pack: the till said "Not in the price list … call the manager", but the manager's Products list said "On sale". Here a real
 * store computer serves /products from a pack whose till catalogue carries the oil but not the milk (both on sale in the
 * product master). The store manager opens Products in a real browser, as he would, and reads both rows. No head office:
 * every /v1 read is "not reachable", as on a store PC with the link down. Synthetic data only. Without a browser it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const TENANT = randomUUID();
const STORE = 'store-1';
const MANAGER = 'u-mgr';
const TODAY = shopDateIn(new Date().toISOString());
const master = (productId: string, sku: string, name: string): Record<string, unknown> => ({
  productId, tenantId: TENANT, sku, name, primaryCategoryId: 'grocery', baseUom: 'ea', taxClass: '0401', lifecycle: 'active',
  mrpHistory: [{ value: { minor: 20_000, currency: 'INR' }, effectiveFrom: `${TODAY.slice(0, 4)}-01-01` }],
});

interface Doc { readonly documentElement: { readonly lang: string } }

describe.skipIf(!HAVE_BROWSER)('D-005 — Products names an item that is not on the tills', () => {
  let browser: Browser;
  let edge: EdgeProcess;
  let dir: string;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    dir = await mkdtemp(join(tmpdir(), 'sre-d005-'));
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [],
      policies: { tradingDayCutoff: '00:00', storeId: STORE, branchId: STORE },
      roles: ROLE_CATALOGUE,
      roleAssignments: [{ userId: MANAGER, roleId: 'store_manager', branchScope: [STORE] }],
      pricingPolicy: { userId: MANAGER, approvers: [MANAGER], marginFloorBps: 2_000 },
      categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
      // The till catalogue: the oil only. The milk has no price for this store, so it is not on the tills.
      products: [{ productId: 'OIL', name: 'Sunflower oil 1 L', categoryId: 'grocery', unitPriceMinor: 16_500, unitCostMinor: 13_250, uom: 'ea', taxBps: 500, status: 'active', recallBlock: false, barcodes: ['8901234567890'], availableMinor: 10 }],
      productMaster: [master('OIL', 'OIL-1L', 'Sunflower oil 1 L'), master('MILK', 'MILK-500', 'Milk 500 ml')],
    }), 'utf8');
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
    }, () => {}))!;
  }, 240_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  const open = async (who: string): Promise<{ page: Page; errors: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': who } });
    stops.push(() => context.close());
    await context.route('**/v1/**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const res = await page.goto(`http://127.0.0.1:${edge.screens!.port}/products`, { waitUntil: 'load' });
    expect(res?.status()).toBe(200);
    return { page, errors };
  };

  it('the manager reads "Not on the tills — no price" in red, with why, on the milk — and "On sale" on the oil', async () => {
    const { page, errors } = await open(MANAGER);
    const milk = page.locator('#item-list .row[data-not-on-tills="no_price"]');
    await milk.waitFor({ timeout: 15_000 });
    expect((await milk.locator('strong').textContent())?.trim()).toBe('Milk 500 ml');
    const milkText = (await milk.locator('.what').innerText()).replace(/\s+/g, ' ');
    expect(milkText).not.toContain('On sale');
    expect(milkText).toContain('Not on the tills — no price — head office sent the tills no price for it for this store today');
    // In red: the warning is in the danger text colour, and the row carries the red edge.
    const colour = await milk.locator('small.not-on-tills').evaluate((n) => (globalThis as unknown as { getComputedStyle(e: unknown): { color: string } }).getComputedStyle(n).color);
    const danger = await page.evaluate(`(() => { const p = document.createElement('small'); p.style.color = 'var(--danger-text)'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })()`);
    expect(colour).toBe(danger);
    expect(await milk.getAttribute('class')).toContain('stopped');

    const oil = (await page.locator('#item-list .row').filter({ hasText: 'Sunflower oil 1 L' }).first().locator('.what').innerText()).replace(/\s+/g, ' ');
    expect(oil).toContain('On sale');
    expect(oil).not.toContain('Not on the tills');

    await page.click('#lang');
    await page.waitForFunction(() => (globalThis as unknown as { document: Doc }).document.documentElement.lang === 'ta');
    expect(await milk.locator('small.not-on-tills').innerText()).toMatch(/^கவுண்டர்களில் இல்லை — விலை இல்லை — /);
    expect(errors).toEqual([]);
  });
});
