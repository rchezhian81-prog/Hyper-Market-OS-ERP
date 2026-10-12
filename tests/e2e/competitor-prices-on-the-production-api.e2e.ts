import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { STORE_RULES } from '../support/store-rules';

/**
 * **Competitor price capture and comparison on the Products and prices page, in a real browser, on the PRODUCTION API
 * over real PostgreSQL (D06-FR-05 "competitor capture" · M05 · P-02 · P-05).**
 *
 * The catalogue page is served in front of the real API; who is looking comes from head office's `GET /v1/identity/me`
 * and the products from its own `GET /v1/catalogue/products`. Through Chromium, on the "Competitor prices" tab:
 *
 *   • nothing is written on open; with no sighting, the page says so;
 *   • the owner records a shelf-visit price for toor dal — head office keeps it, and the comparison it works out shows OUR
 *     effective price at the store (₹120.00) beside theirs (₹110.00) with the gap in words ("we are dearer by ₹10.00");
 *   • a sighting dated in the future is refused in head office's words; recording changes NO price (our price, read from
 *     head office's own comparison, is still ₹120.00);
 *   • after a RESTART of the API the sighting is still there; the tab speaks Tamil;
 *   • a cashier (reads the catalogue, may not propose prices) sees the comparison and is offered no recording; an
 *     accountant (no catalogue read) is told so — and head office refuses each directly.
 *
 * Synthetic data, a fresh tenant. Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['competitor', 'prices', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const CASHIER = 'u-cash';
const ACCT = 'u-acct';
const TODAY = new Date().toISOString().slice(0, 10);

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('competitor prices on the catalogue page, on the production API, in a real browser (D06-FR-05)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) =>
    shop.cloud().request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: randomUUID() }) });
  const comparison = async () => (await call('GET', '/v1/prices/competitor?storeId=store-1', OWNER)).body as { products: { productId: string; ourPriceMinor: number | null; competitors: { competitor: string; priceMinor: number; gapMinor?: number }[] }[] };

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: {
        path: '/catalogue', html: 'catalogue.html', dataGlobal: 'catalogueData',
        // What the store computer tells the catalogue screen: its store, today and now, and head office's products.
        extraData: async (api) => ({ storeId: 'store-1', today: TODAY, now: new Date().toISOString(), products: ((await api('/v1/catalogue/products')) as { products?: unknown[] }).products ?? [] }),
      },
      seed: async (cloud) => {
        await cloud.grant(CASHIER, 'cashier');
        await cloud.grant(ACCT, 'accountant');
        const req = (path: string, body: unknown) => cloud.request({ method: 'POST', path, userId: OWNER, body, idempotencyKey: `seed-${randomUUID()}` });
        await ok(req('/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' }), 'company');
        await ok(req('/v1/org/nodes/store-1', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }), 'store');
        await ok(req('/v1/stores/store-1/rules', { ...STORE_RULES, marginFloorBps: 0 }), 'rules');
        await ok(req('/v1/catalogue/tax-classes/0713/rates/2017-07-01', { rateBps: 500 }), 'tax');
        await ok(req('/v1/catalogue/products/p-dal/publish', { product: { sku: 'DAL-1KG', name: 'Toor dal 1kg', baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '0713', lifecycle: 'active' }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }), 'publish');
        await ok(req('/v1/prices/list/p-dal/entries/e1', { scope: 'store', scopeRef: 'store-1', priceMinor: 12_000, mrpMinor: 14_000, costMinor: 9_000, marginFloorBps: 0, currency: 'INR', effectiveFrom: TODAY }), 'price');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname.replace(/\/[^/]+$/, '/:id')}`); });
    await page.goto(`${shop.base}/catalogue?tab=rivals`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };
  const says = async (page: Page, selector: string, expected: RegExp): Promise<void> => {
    await page.waitForFunction(([sel, source]) => new RegExp(source!).test((globalThis as unknown as { document: { querySelector(x: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''), [selector, expected.source], { timeout: 15_000 });
  };

  it('the owner records a sighting; the comparison is head office\'s; a future sighting is refused; no price changes; it survives a restart', async () => {
    let s = await open(OWNER);
    try {
      await says(s.page, '#rivals-list', /No competitor price recorded for this store yet\./);
      expect(s.writes, 'nothing is written on open').toEqual([]);
      expect(await s.page.locator('#rival-product option').allInnerTexts()).toEqual(['Toor dal 1kg (p-dal)']);
      await s.page.fill('#rival-competitor', 'Reliance Smart');
      await s.page.fill('#rival-price', '110');
      await s.page.selectOption('#rival-source', 'shelf_visit');
      await s.page.click('#rival-record');
      await says(s.page, '#rival-record-status', /^Recorded — head office kept the sighting\. No price was changed\./);
      await says(s.page, '#rivals-list [data-product="p-dal"]', /Toor dal 1kg — Our price ₹120\.00/);
      expect(await s.page.locator('#rivals-list [data-competitor="Reliance Smart"]').innerText()).toBe('Reliance Smart: ₹110.00 · we are dearer by ₹10.00 · Shelf visit · seen today');

      // A sighting dated tomorrow: head office refuses it in its own words.
      const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 16);
      await s.page.fill('#rival-competitor', 'More Supermarket');
      await s.page.fill('#rival-price', '115');
      await s.page.fill('#rival-seen', tomorrow);
      await s.page.click('#rival-record');
      await says(s.page, '#rival-record-status', /^Head office refused: The sighting is dated after now\. Use the time you actually saw the price\./);
      expect(await s.page.locator('#rivals-list [data-competitor="More Supermarket"]').count()).toBe(0);
      expect(s.writes).toEqual(['POST /v1/prices/competitor/:id', 'POST /v1/prices/competitor/:id']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // Head office's record — and our price is unchanged: recording changes no price.
    await shop.restart();
    const c = await comparison();
    expect(c.products).toEqual([expect.objectContaining({ productId: 'p-dal', ourPriceMinor: 12_000, competitors: [expect.objectContaining({ competitor: 'Reliance Smart', priceMinor: 11_000, gapMinor: 1_000 })] })]);
    s = await open(OWNER);
    try {
      await says(s.page, '#rivals-list [data-product="p-dal"]', /Reliance Smart: ₹110\.00/);
      await s.page.click('#lang');
      expect(await s.page.locator('#tab-rivals .t').innerText()).toBe('போட்டியாளர் விலைகள்');
      expect(await s.page.locator('#rival-record').innerText()).toBe('இந்த விலையைப் பதிவு செய்');
      await says(s.page, '#rivals-list [data-competitor="Reliance Smart"]', /நாம் அதிகம் ₹10\.00 · அலமாரிப் பார்வை · இன்று பார்த்தது/);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);

  it('a cashier reads the comparison and is offered no recording; an accountant cannot read it; head office refuses each directly', async () => {
    let s = await open(CASHIER);
    try {
      await says(s.page, '#rivals-status', /You can read the comparison; recording a price needs a pricing role\./);
      await says(s.page, '#rivals-list [data-product="p-dal"]', /Reliance Smart/);
      expect(await s.page.locator('#rivals-form').isHidden()).toBe(true);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect((await call('POST', '/v1/prices/competitor/obs-cashier', CASHIER, { productId: 'p-dal', storeId: 'store-1', competitor: 'X', priceMinor: 100, observedAt: new Date().toISOString(), source: 'phone' })).status).toBe(403);

    s = await open(ACCT);
    try {
      await says(s.page, '#rivals-status', /Your role cannot read the comparison\./);
      expect(await s.page.locator('#rivals-list > *').count()).toBe(0);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect((await call('GET', '/v1/prices/competitor?storeId=store-1', ACCT)).status).toBe(403);
  }, 60_000);
});
