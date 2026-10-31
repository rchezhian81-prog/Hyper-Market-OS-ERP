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
 * **OB-569 (owner, 31 Oct 2026) — the cashier's Products page, in a real browser served by a real store computer: name,
 * price and barcode only; no cost, no supplier, no commercial field ever reaches the cashier's browser.**
 *
 * The cashier may open Products (`catalogue.pack.read`) but holds no right to see costs and suppliers (`supplier.view`);
 * the store manager does. The store computer trims the page data BEFORE it leaves the box, so the cashier's browser never
 * holds a cost — not in the page's data, not anywhere in the HTML it was sent — while the manager's page carries it.
 * Synthetic data only. Without a browser binary it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const TENANT = randomUUID();
const STORE = 'store-1';
const CASHIER = 'u-cash'; const MANAGER = 'u-mgr';
const TODAY = shopDateIn(new Date().toISOString());
const COST = 13_250;

interface CatalogueGlobals { readonly catalogueData?: Record<string, unknown> }

describe.skipIf(!HAVE_BROWSER)('OB-569 — the cashier\'s Products page carries no cost', () => {
  let browser: Browser;
  let edge: EdgeProcess;
  let dir: string;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    dir = await mkdtemp(join(tmpdir(), 'sre-ob569-'));
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [],
      policies: { tradingDayCutoff: '00:00', storeId: STORE, branchId: STORE },
      roles: ROLE_CATALOGUE,
      roleAssignments: [{ userId: CASHIER, roleId: 'cashier', branchScope: [STORE] }, { userId: MANAGER, roleId: 'store_manager', branchScope: [STORE] }],
      pricingPolicy: { userId: MANAGER, approvers: [MANAGER], marginFloorBps: 2_000 },
      categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
      products: [{ productId: 'OIL', name: 'Sunflower oil 1 L', categoryId: 'grocery', unitPriceMinor: 16_500, unitCostMinor: COST, uom: 'ea', taxBps: 500, status: 'active', recallBlock: false, barcodes: ['8901234567890'], availableMinor: 10 }],
      productMaster: [{
        productId: 'OIL', tenantId: TENANT, sku: 'OIL-1L', name: 'Sunflower oil 1 L', brand: 'Sunny', manufacturer: 'Sunny Oils Pvt Ltd',
        primaryCategoryId: 'grocery', baseUom: 'ea', taxClass: '1512', lifecycle: 'active',
        mrpHistory: [{ value: { minor: 18_000, currency: 'INR' }, effectiveFrom: `${TODAY.slice(0, 4)}-01-01` }],
      }],
    }), 'utf8');
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
    }, () => {}))!;
  }, 240_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  /** The Products page on the store computer as `who`, with every byte the browser was sent kept. */
  const open = async (who: string): Promise<{ page: Page; html: string; errors: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': who } });
    stops.push(() => context.close());
    // Head office: the item's price list (the price the page shows, read item by item); anything else is "not reachable".
    await context.route('**/v1/**', (route) => (new URL(route.request().url()).pathname === '/v1/prices/list/OIL/history'
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: [{ id: 'p1', productId: 'OIL', scope: 'store', scopeRef: STORE, price: { minor: 16_500, currency: 'INR' }, effectiveFrom: `${TODAY.slice(0, 4)}-01-01T00:00:00.000Z`, status: 'active', version: 1 }] }) })
      : route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const res = await page.goto(`http://127.0.0.1:${edge.screens!.port}/products`, { waitUntil: 'load' });
    expect(res?.status(), '/products is served by the store computer').toBe(200);
    return { page, html: (await res?.text()) ?? '', errors };
  };

  it('the cashier\'s browser holds the name, price and barcode — and no cost, maker or margin anywhere it was sent', async () => {
    const { page, html, errors } = await open(CASHIER);
    const data = await page.evaluate(() => (globalThis as unknown as CatalogueGlobals).catalogueData ?? null);
    expect(data, 'the page was given its data').not.toBeNull();
    expect(data).not.toHaveProperty('costsMinor');
    expect(data).not.toHaveProperty('marginFloorBps');
    expect(data!['barcodes']).toEqual([{ barcode: '8901234567890', productId: 'OIL' }]);
    // Each product carries exactly its id (to key its barcode and price) and its name — nothing else.
    expect(data!['products']).toEqual([{ productId: 'OIL', name: 'Sunflower oil 1 L' }]);
    expect(data!['productFields']).toBe('name_price_barcode');
    // Nothing commercial in ANY byte the store computer sent this browser — not the cost, the maker, the code, the MRP.
    expect(html).not.toMatch(new RegExp(`${COST}|costsMinor|unitCostMinor|Sunny|marginFloorBps|OIL-1L|mrpHistory|taxClass|1512`));
    // On screen: the name and the barcode; the price once read from head office.
    const row = page.locator('#item-list .row[data-product="OIL"]');
    await row.waitFor({ timeout: 15_000 });
    expect((await row.locator('strong').textContent())?.trim()).toBe('Sunflower oil 1 L');
    expect((await row.locator('.barcodes').textContent())?.trim()).toBe('8901234567890');
    await row.locator('button.show-price').click();
    await page.waitForFunction(() => /₹165\.00/.test((globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector('#item-list .row[data-product="OIL"] .price')?.textContent ?? ''), undefined, { timeout: 15_000 });
    expect(await page.locator('#item-list').textContent()).toContain('Costs and suppliers are not shown on this screen.');
    expect(errors).toEqual([]);
  });

  it('the store manager (who holds the right) is sent the cost', async () => {
    const { page, errors } = await open(MANAGER);
    const data = await page.evaluate(() => (globalThis as unknown as CatalogueGlobals).catalogueData ?? null);
    expect(data!['costsMinor']).toEqual({ OIL: COST });
    expect(data!['marginFloorBps']).toBe(2_000);
    expect(errors).toEqual([]);
  });
});
