import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { STORE_RULES } from '../support/store-rules';
import { theEvening, pinTheEveningClock, pinThePageClock } from '../support/evening-clock';

/**
 * **D-18 (R4, OB-216) — competitor prices draft a price change on the Products and prices page; a person approves it**, in a
 * real browser, on the PRODUCTION API over real PostgreSQL:
 *
 *   • tea is ₹100.00 here and Shop A sells it at ₹94.00 (seen 2 days ago): a draft to ₹94.00 is shown, with the rule
 *     ("5.0% or more below us, seen under 14 days ago"); oil's match would fall under the 20% margin floor and is listed
 *     as "draft refused: below margin floor"; opening the page writes nothing and changes no price;
 *   • the owner approves the tea draft: the ONE write is the normal price route (POST /v1/prices/changes), head office's
 *     price is then ₹94.00 and the draft is gone; after a RESTART of the API the price is still ₹94.00;
 *   • a cashier is shown no drafts, and head office refuses the drafts read to them.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['competitor', 'drafts', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const CASHIER = 'u-cash';
// The shop's own date, at an evening UTC moment (19:30 UTC — already tomorrow in the shop), pinned so the evening case is
// proven whenever this runs: the price is dated by the shop's day, never the UTC date.
const EVENING = theEvening();
const TODAY = EVENING.shopDate;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000 - 60_000).toISOString();

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('competitor drafts a person approves on the catalogue page, on the production API (D-18)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) =>
    shop.cloud().request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: randomUUID() }) });
  const shelf = async (id: string): Promise<number> => ((await shop.cloud().request({ method: 'GET', path: `/v1/prices/list/${id}/resolve?storeId=store-1&at=${encodeURIComponent(new Date().toISOString())}`, userId: OWNER })).body as { priceMinor: number }).priceMinor;

  beforeAll(async () => {
    pinTheEveningClock(EVENING);
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: {
        path: '/catalogue', html: 'catalogue.html', dataGlobal: 'catalogueData',
        extraData: async (api) => ({ storeId: 'store-1', today: TODAY, now: new Date().toISOString(), products: ((await api('/v1/catalogue/products')) as { products?: unknown[] }).products ?? [] }),
      },
      seed: async (cloud) => {
        await cloud.grant(CASHIER, 'cashier');
        const req = (path: string, body: unknown) => cloud.request({ method: 'POST', path, userId: OWNER, body, idempotencyKey: `seed-${randomUUID()}` });
        await ok(req('/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' }), 'company');
        await ok(req('/v1/org/nodes/store-1', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }), 'store');
        await ok(req('/v1/stores/store-1/rules', { ...STORE_RULES, marginFloorBps: 2_000 }), 'rules');
        await ok(req('/v1/catalogue/tax-classes/0902/rates/2017-07-01', { rateBps: 500 }), 'tax');
        for (const [id, name, shelfMinor, mrp, cost, theirs] of [['p-tea', 'Tea 250g', 10_000, 10_500, 7_000, 9_400], ['p-oil', 'Groundnut oil 1L', 20_000, 21_000, 17_000, 18_800]] as const) {
          await ok(req(`/v1/catalogue/products/${id}/publish`, { product: { sku: `SKU-${id}`, name, baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '0902', lifecycle: 'active', mrpHistory: [{ value: { minor: mrp, currency: 'INR' }, effectiveFrom: '2026-01-01' }] }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }), `publish ${id}`);
          await ok(req(`/v1/prices/list/${id}/entries/e1`, { scope: 'store', scopeRef: 'store-1', priceMinor: shelfMinor, mrpMinor: mrp, costMinor: cost, marginFloorBps: 0, currency: 'INR', effectiveFrom: TODAY }), `price ${id}`);
          await ok(req('/v1/inventory/movements', { movementId: `rx-${id}`, productId: id, locationId: 'store-1', kind: 'received', quantityMinor: 10, uom: 'EA', occurredAt: daysAgo(30), enteredBy: OWNER, unitCostMinor: cost }), `receive ${id}`);
          await ok(req(`/v1/prices/competitor/o-${id}`, { productId: id, storeId: 'store-1', competitor: 'Shop A', priceMinor: theirs, observedAt: daysAgo(2), source: 'shelf_visit' }), `sighting ${id}`);
        }
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); vi.useRealTimers(); });

  const open = async (who: string) => {
    const context = await browser.newContext();
    await pinThePageClock(context);
    await shop.signIn(context, who);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/catalogue?tab=rivals`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };
  const says = async (page: Page, selector: string, expected: RegExp): Promise<void> => {
    await page.waitForFunction(([sel, source]) => new RegExp(source!).test((globalThis as unknown as { document: { querySelector(x: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''), [selector, expected.source], { timeout: 15_000 });
  };

  it('a draft within MRP and the floor, a refusal by name; nothing changes until the owner approves; the approval is the normal price route', async () => {
    const s = await open(OWNER);
    try {
      await says(s.page, '#drafts-list [data-draft="p-tea"]', /Tea 250g: ₹100\.00 → ₹94\.00 to match Shop A \(6\.0% below, seen 2 day\(s\) ago\)/);
      expect(await s.page.textContent('#drafts-rule')).toMatch(/5\.0% or more below us, seen under 14 days ago \(the agreed starting setting\)/);
      expect(await s.page.textContent('#not-drafted-list [data-not-drafted="p-oil"]')).toBe('Groundnut oil 1L: draft refused: below margin floor (Shop A)');
      expect(await s.page.locator('#drafts-list [data-draft="p-oil"]').count()).toBe(0);
      expect(s.writes, 'nothing is written on open').toEqual([]);
      expect(await shelf('p-tea')).toBe(10_000);

      await s.page.click('#drafts-list [data-approve="p-tea"]');
      await says(s.page, '#drafts-status', /^Approved — the new price goes to the tills with the next price update\./);
      await says(s.page, '#drafts-list', /No price change is drafted for this store\./);
      expect(s.writes).toEqual(['POST /v1/prices/changes']);
      expect(await shelf('p-tea')).toBe(9_400);
      expect(await shelf('p-oil')).toBe(20_000);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    await shop.restart();
    expect(await shelf('p-tea')).toBe(9_400);
  }, 120_000);

  it('a cashier is shown no drafts, and head office refuses the drafts read to them', async () => {
    const s = await open(CASHIER);
    try {
      await says(s.page, '#rivals-status', /You can read the comparison/);
      expect(await s.page.locator('#drafts-block').isHidden()).toBe(true);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect((await call('GET', '/v1/prices/competitor-drafts?storeId=store-1', CASHIER)).status).toBe(403);
  }, 60_000);
});
