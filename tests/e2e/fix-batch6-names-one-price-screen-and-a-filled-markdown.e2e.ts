import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { says } from './lib/r4c-box-page';
import { STORE_RULES } from '../support/store-rules';
import { theEvening, pinTheEveningClock, pinThePageClock } from '../support/evening-clock';
import { confirmIt } from './lib/confirm-sheet';

/**
 * **Fix batch 6 of THE PLAN (OB-800) — the store manager's and the owner's "Annoys" rows, in a real browser on the PRODUCTION
 * API over real PostgreSQL.**
 *   • D-014: a write-off waiting on Approvals reads "Item: Sunflower oil 1 L", "Unit: each (pieces)", "Evidence: Photo attached"
 *     — no "prod-oil", no "photo-…", no "About: wo-…", no write-off id;
 *   • D-022: after a price is saved on Change a price the history is read again and shows the new ₹52.00; the two identical
 *     ₹50.00 entries are one row naming versions 1, 2;
 *   • D-023: Price lists opens as the one everyday screen — this store filled, no zone/channel/customer choices — and the
 *     advanced part (price zones, channel prices, one customer's price) is one tick away, nothing removed;
 *   • D-025: a near-expiry row's "Work out a markdown" fills the form and says it in words ("Milk bread 400g · batch B-7 · 2
 *     days left · 100 on hand"); typing is only for an item not on the list; working it out still changes no price.
 * Synthetic data, a fresh tenant. Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['b6', 'annoys', 'e2e', 'key'].join('-').padEnd(48, '0');
const STORE = 'br-1';
const EVENING = theEvening();
const TODAY = EVENING.shopDate;
const plusDays = (n: number): string => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const BREAD = { sku: 'BREAD-400', name: 'Milk bread 400g', baseUom: 'ea', primaryCategoryId: 'bakery', taxClass: '1905', lifecycle: 'active' };
const OIL = { sku: 'OIL-1L', name: 'Sunflower oil 1 L', baseUom: 'ea', primaryCategoryId: 'bakery', taxClass: '1905', lifecycle: 'active' };

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('fix batch 6: names on Approvals, one price screen, a filled markdown (D-014, D-022, D-023, D-025)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) =>
    shop.cloud().request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: randomUUID() }) });

  beforeAll(async () => {
    pinTheEveningClock(EVENING);
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/approvals', html: 'approvals.html', dataGlobal: 'approvalsData' },
      alsoPages: [
        {
          path: '/expiry', html: 'expiry.html', dataGlobal: 'expiryData',
          extraData: async () => ({ storeId: STORE, branchId: STORE, now: `${TODAY}T06:30:00.000Z`, tradingDay: TODAY, nearExpiryDays: 3,
            batches: [{ batchId: 'B-7', productId: 'p-bread', qty: 100, expiry: plusDays(2) }], productNames: { 'p-bread': BREAD.name }, productUnits: { 'p-bread': 'ea' } }),
        },
        {
          path: '/catalogue', html: 'catalogue.html', dataGlobal: 'catalogueData',
          extraData: async (api) => ({ storeId: STORE, today: TODAY, now: new Date().toISOString(), marginFloorBps: 2_000, costsMinor: { 'p-bread': 3_500 },
            products: ((await api('/v1/catalogue/products')) as { products?: unknown[] }).products ?? [] }),
        },
        { path: '/price-lists', html: 'price-lists.html', dataGlobal: 'priceListsData', extraData: async () => ({ storeId: STORE }) },
      ],
      seed: async (cloud) => {
        const req = (path: string, body: unknown, who = OWNER) => cloud.request({ method: 'POST', path, userId: who, ...(who === MGR ? { branchId: STORE } : {}), body, idempotencyKey: `seed-${randomUUID()}` });
        await ok(req('/v1/catalogue/tax-classes/1905/rates/2017-07-01', { rateBps: 500 }), 'tax');
        for (const [id, product] of [['p-bread', BREAD], ['p-oil', OIL]] as const) {
          await ok(req(`/v1/catalogue/products/${id}/publish`, { product: { ...product, mrpHistory: [{ value: { minor: 6_000, currency: 'INR' }, effectiveFrom: '2026-01-01' }] }, categories: [{ categoryId: 'bakery', name: 'Bakery', parentId: null }] }), `publish ${id}`);
        }
        // D-022: two entries that say exactly the same thing (₹50.00 from today at br-1) — versions 1 and 2 of the bread's price
        for (const entry of ['e1', 'e2']) {
          await ok(req(`/v1/prices/list/p-bread/entries/${entry}`, { scope: 'store', scopeRef: STORE, priceMinor: 5_000, mrpMinor: 6_000, costMinor: 3_500, marginFloorBps: 0, currency: 'INR', effectiveFrom: TODAY }), `price ${entry}`);
        }
        await ok(req(`/v1/stores/${STORE}/rules`, { ...STORE_RULES, marginFloorBps: 2_000 }), 'rules');
        // D-014: the manager asks for a material write-off of the oil — it waits for the owner on Approvals
        await ok(req('/v1/approvals/requests', {
          kind: 'stock_write_off', subjectRef: 'wo-uat06-demo-oil-leak', valueMinor: 114_000, summary: 'Write off 3 × Sunflower oil 1 L — leak', reason: 'The tin leaked',
          details: { productId: 'p-oil', locationId: STORE, qty: 3, uom: 'ea', lossType: 'damage', reasonCode: 'damage', valueMinor: 114_000, evidenceRef: 'photo-demo-oil-leak-1', writeOffId: 'wo-uat06-demo-oil-leak' },
        }, MGR), 'write-off request');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); vi.useRealTimers(); });

  const open = async (who: string, path: string) => {
    const context = await browser.newContext();
    await pinThePageClock(context);
    await shop.signIn(context, who, STORE);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };

  it('D-014: the write-off on Approvals names the item and says the unit and the evidence — no codes, no ids', async () => {
    const o = await open(OWNER, '/approvals');
    await says(o.page, '#waiting', /Item: Sunflower oil 1 L/);
    const card = (await o.page.textContent('#waiting')) ?? '';
    expect(card).toContain('Unit: each (pieces)');
    expect(card).toContain('Evidence: Photo attached');
    expect(card).not.toMatch(/p-oil|photo-demo|wo-uat06|Write-off: /);
    expect(o.writes).toEqual([]);
    expect(o.errors).toEqual([]);
    await o.close();
  });

  it('D-022: a saved price is read back into the history at once, and identical entries are one row', async () => {
    const c = await open(OWNER, '/catalogue?tab=price&product=p-bread&price=52.00');
    await c.page.waitForSelector('#view-price:not([hidden])');
    await says(c.page, '#price-history', /₹50\.00/);
    const before = (await c.page.textContent('#price-history')) ?? '';
    expect(before).toContain('1, 2'); // the two identical ₹50.00 entries: one row, both versions
    expect(before.match(/₹50\.00/g)?.length).toBe(1);
    await c.page.click('#save-price');
    await confirmIt(c.page);
    await says(c.page, '#price-history', /₹52\.00/);
    expect(c.writes).toContain('POST /v1/prices/changes');
    expect(c.errors).toEqual([]);
    await c.close();
  });

  it('D-023: Price lists is one everyday screen for this store; zones, channels and customers are one tick away', async () => {
    const p = await open(MGR, '/price-lists');
    await p.page.waitForSelector('#view-prices:not([hidden])');
    expect(await p.page.isHidden('#tab-zones')).toBe(true);
    expect(await p.page.isHidden('#tab-channels')).toBe(true);
    expect(await p.page.isHidden('#p-scope-wrap')).toBe(true);
    await says(p.page, '#daily-note', /Products → Change a price/);
    await p.page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(i: string): { value?: string } | null } }).document.getElementById('p-ref')?.value === 'br-1', undefined, { timeout: 10_000 });
    await p.page.check('#advanced');
    expect(await p.page.isVisible('#tab-zones')).toBe(true);
    expect(await p.page.isVisible('#tab-channels')).toBe(true);
    expect(await p.page.isVisible('#p-scope-wrap')).toBe(true);
    await p.page.click('#tab-zones');
    expect(await p.page.isVisible('#view-zones')).toBe(true);
    await p.page.uncheck('#advanced');
    expect(await p.page.isVisible('#view-prices')).toBe(true); // back on the everyday screen
    expect(p.writes).toEqual([]);
    expect(p.errors).toEqual([]);
    await p.close();
  });

  it('D-025: the near-expiry row fills the markdown form and says it in words; working it out changes no price', async () => {
    const m = await open(MGR, '/expiry');
    await m.page.waitForSelector('#markdown:not([hidden])');
    await says(m.page, '#md-pick-hint', /Work out a markdown/);
    await m.page.click('#expiry-list .row[data-product="p-bread"] .pick-markdown');
    await says(m.page, '#md-picked-what', /^Milk bread 400g · batch B-7 · 2 days left · 100/);
    expect(await m.page.getAttribute('#md-typed', 'open')).toBeNull(); // the typed boxes stay folded away
    expect(await m.page.inputValue('#md-product')).toBe('p-bread');
    const shelf = async (): Promise<number> => ((await call('GET', `/v1/prices/list/p-bread/resolve?storeId=${STORE}&at=${encodeURIComponent(new Date().toISOString())}`, OWNER)).body as { priceMinor: number }).priceMinor;
    const before = await shelf();
    await m.page.fill('#md-rate', '10');
    await m.page.click('#md-go');
    // 25% off head office's own shelf price (₹52.00 after the D-022 case above)
    await says(m.page, '#md-proposal', /^25% off: ₹52\.00 → ₹39\.00$/);
    expect(m.writes).toEqual(['POST /v1/pricing/markdown/propose']);
    expect(await shelf()).toBe(before); // proposing changed no price
    // Tamil: the same row in Tamil words
    await m.page.click('#lang');
    await says(m.page, '#md-picked-what', /தொகுதி B-7/);
    expect(m.errors).toEqual([]);
    await m.close();
  });
});
