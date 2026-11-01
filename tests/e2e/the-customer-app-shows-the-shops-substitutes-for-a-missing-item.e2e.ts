import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright-core';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { seedOnlineShop, callsFor, OWNER, STORE, type ShopCalls } from '../support/online-shop';
import { startCustomerShop, type CustomerShop } from './lib/customer-shop';

/**
 * **G-1 · M03-FR-04 — the customer app shows the shop's approved substitutes for an item it cannot supply**, in a real
 * browser, on the real API (A04 · D08-FR-03 · M20 "the customer confirms … any substitution"):
 *
 *   • the owner sets MILK's approved substitutes on head office (MILK-500 first, then BROOM);
 *   • MILK is out of stock; the customer reviews a basket with it — under the line the app reads
 *     `GET /v1/storefront/products/MILK/substitutes` and says "The shop suggests instead: …", in the shop's order;
 *   • nothing is swapped for the customer: the basket is unchanged until they tap "Add instead" themselves;
 *   • with the shop unreachable for that read, the app says the suggestions could not be read (never silence).
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const PHONE = '+919000000077';
const SUBJECT = 'cust-phone-subs';
const mrp = (minor: number) => [{ value: { minor, currency: 'INR' }, effectiveFrom: '2026-01-01' }];
interface Doc { getElementById(id: string): { hidden: boolean } | null }

describe.skipIf(!existsSync(CHROMIUM))('the customer app shows the shop\'s substitutes for a missing item (G-1 · M03-FR-04)', () => {
  let browser: Browser;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'customer-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });

  it('reads the shop\'s list under the missing line; adds one only on the customer\'s own tap; an unreadable list is said', async () => {
    const h: ApiHarness = apiHarness();
    const T = randomUUID();
    const c: ShopCalls = callsFor(() => h, T);
    const { req, ok } = c;
    await seedOnlineShop(h, T, c);
    // A second milk the shop can offer instead (synthetic).
    await ok(req('POST', '/v1/catalogue/products/MILK-500/publish', {
      product: { sku: 'MILK-500ML', name: 'Synthetic Milk 500ml', baseUom: 'ea', primaryCategoryId: 'dairy', taxClass: '0401', lifecycle: 'active', mrpHistory: mrp(40_00), safety: { allergens: ['milk'], countryOfOrigin: 'India' } },
      categories: [{ categoryId: 'dairy', name: 'Dairy', parentId: null, regulated: ['food'] }],
    }), 'publish MILK-500');
    const today = new Date().toISOString().slice(0, 10);
    await ok(req('POST', '/v1/prices/list/MILK-500/entries/e1', { scope: 'store', scopeRef: STORE, priceMinor: 35_00, mrpMinor: 40_00, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: today }), 'price MILK-500');
    await ok(req('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: today }), 'pack');
    // The owner's approved list for MILK, in the order to try (head office keeps only what it can sell now).
    await ok(req('POST', '/v1/catalogue/products/MILK/substitutes', { substitutes: ['MILK-500', 'BROOM'], reason: 'e2e (synthetic)' }, OWNER), 'substitutes');
    const pack = (await ok(req('GET', '/v1/catalogue/pack'), 'pack read')).body as { snapshot: { version: number; products: { productId: string; name: string; unitPriceMinor: number; baseUom: string }[] } };
    const shopData = async () => ({
      tenantId: T, customerRef: 'guest', packVersion: pack.snapshot.version, locationId: STORE,
      // MILK is out of stock today.
      products: pack.snapshot.products.map((p) => ({ productId: p.productId, name: p.name, categoryId: 'x', unitPriceMinor: p.unitPriceMinor, uom: p.baseUom, barcodes: [], status: 'active', availableMinor: p.productId === 'MILK' ? 0 : 5, availabilityAgeMinutes: 1 })),
      slots: [], storeLocation: { lat: 11.0168, lon: 76.9558 }, policy: { radiusMetres: 10_000, deliveryFeeMinor: 40_00 }, deliveryFeeMinor: 40_00,
    });
    const store: CustomerShop = await startCustomerShop({ h, tenantId: T, subject: SUBJECT, shopData });
    const context = await browser.newContext({ serviceWorkers: 'block' }); // page.route must see the app's own requests
    const page: Page = await context.newPage();
    const errors: string[] = [];
    const reads: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.endsWith('/substitutes')) reads.push(`${r.method()} ${u.pathname}`); });
    try {
      await page.goto(`${store.base}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { document: Doc }).document.getElementById('sample')?.hidden === true, undefined, { timeout: 10_000 });
      await page.fill('#search', 'milk 1l');
      await page.click('button[aria-label="Add Synthetic Milk 1L"]');
      await page.click('#tab-basket');
      // Sign in (the shop answers a signed-in customer).
      await page.fill('#si-phone', PHONE);
      await page.click('#si-send');
      await page.waitForSelector('#si-step-code:not([hidden])', { timeout: 10_000 });
      await page.fill('#si-code', store.sms.codeFor(PHONE) ?? '');
      await page.click('#si-verify');
      await page.waitForSelector('#si-step-in:not([hidden])', { timeout: 10_000 });

      await page.click('#review');
      await page.click('#banner-ok');
      const subs = page.locator('#problem-lines [data-substitutes-for="MILK"]');
      await subs.locator('[data-substitute="MILK-500"]').waitFor({ timeout: 10_000 });
      expect(await subs.textContent()).toMatch(/^ The shop suggests instead: Synthetic Milk 500ml Add instead/);
      expect(await subs.locator('[data-substitute]').evaluateAll((els) => els.map((e) => (e as unknown as { dataset: { substitute: string } }).dataset.substitute))).toEqual(['MILK-500', 'BROOM']);
      expect(reads).toEqual(['GET /v1/storefront/products/MILK/substitutes']);
      // Nothing was swapped: the basket still holds MILK only, until the customer taps.
      const basketLines = () => page.evaluate(() => (globalThis as unknown as { shop: { state(): { lines: { productId: string; quantityMinor: number }[] } } }).shop.state().lines.filter((l) => l.quantityMinor > 0).map((l) => l.productId));
      expect(await basketLines()).toEqual(['MILK']);
      // Reading the suggestions wrote nothing (the app's own saved-basket copy, PUT /v1/me/cart, is the basket as it stands).
      expect(store.writes.filter((w) => w.path !== '/v1/me/cart')).toEqual([]);
      await page.click('#problem-lines [data-add-instead="MILK-500"]');
      expect(await basketLines()).toEqual(['MILK', 'MILK-500']);

      // The shop unreachable for the read: said, never silence.
      await page.route('**/v1/storefront/products/MILK/substitutes', (route) => route.abort());
      await page.click('#review');
      await page.click('#banner-ok');
      await page.locator('#problem-lines [data-substitutes-for="MILK"]', { hasText: 'The shop’s suggestions could not be read just now.' }).waitFor({ timeout: 10_000 });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await store.stop();
    }
  }, 180_000);
});
