import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { theEvening, pinTheEveningClock, pinThePageClock } from '../support/evening-clock';

/**
 * M04-FR-04 · OB-308 (OB-288 P2) — the Floor heat map page, in a real browser, on the PRODUCTION API over real PostgreSQL.
 * Head office holds the store's shelf map, its planogram and its floor plan (coordinates per shelf area), the buying cost of
 * two products and none for a third, and a banked bill. Nothing is read on open; on a click the floor is drawn from above,
 * each area at its coordinates and coloured on the one-hue scale by sales per sq ft; by margin, the area holding the
 * product with no cost says "not known" (no colour of the scale) and names it; a product with no shelf place is listed
 * under the map; Tamil names and words; a cashier reads nothing. Needs DATABASE_URL and Chromium; else it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['heat', 'map', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const STORE = 'br-1';
const HOME = { categoryId: 'staples', name: 'Staples', parentId: null };
// The shop's own date, at an evening UTC moment (19:30 UTC — already tomorrow in the shop), pinned so the evening case is
// proven whenever this runs: the sale is on the shop's trading day, and the page's window opens on the shop's month.
const EVENING = theEvening();
const today = EVENING.shopDate;

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Floor heat map page (M04-FR-04 · OB-308) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  beforeAll(async () => {
    pinTheEveningClock(EVENING);
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/floor-heat-map', html: 'floor-heat-map.html', dataGlobal: 'floorHeatMapData' },
      seed: async (cloud) => {
        const call = (method: 'POST' | 'PUT', path: string, body: unknown) => cloud.request({ method, path, userId: OWNER, idempotencyKey: `seed-${randomUUID()}`, body });
        await cloud.grant('u-cash', 'cashier');
        await ok(call('POST', '/v1/catalogue/tax-classes/1006/rates/2017-07-01', { rateBps: 500 }), 'tax rate');
        for (const id of ['rice', 'dal', 'milk', 'soap']) {
          await ok(call('POST', `/v1/catalogue/products/${id}/publish`, { product: { sku: `SKU-${id}`, name: id, baseUom: 'each', primaryCategoryId: 'staples', taxClass: '1006', lifecycle: 'active' }, categories: [HOME] }), `publish ${id}`);
        }
        await ok(call('PUT', `/v1/merchandising/stores/${STORE}/shelf-map`, { locations: [
          { locationId: 'A1', aisle: 1, rack: 1, bay: 1, shelf: 1, position: 1 }, { locationId: 'B1', aisle: 2, rack: 1, bay: 1, shelf: 1, position: 1 },
        ] }), 'shelf map');
        await ok(call('PUT', `/v1/merchandising/stores/${STORE}/planograms/main`, { effectiveFrom: '2026-01-01', assignments: [
          { productId: 'rice', locationId: 'A1', capacityMinor: 40, primary: true }, { productId: 'dal', locationId: 'A1', capacityMinor: 40, primary: true },
          { productId: 'milk', locationId: 'B1', capacityMinor: 40, primary: true },
        ] }), 'planogram');
        await ok(call('POST', `/v1/merchandising/stores/${STORE}/floor-plan`, { widthFt: 40, depthFt: 30, areas: [
          { areaId: 'staples', name: 'Staples', nameTa: 'மளிகை', x: 0, y: 0, width: 10, depth: 10, locationIds: ['A1'] },
          { areaId: 'dairy', name: 'Dairy', nameTa: 'பால் பொருட்கள்', x: 20, y: 0, width: 5, depth: 10, locationIds: ['B1'] },
        ] }), 'floor plan');
        for (const [id, cost] of [['rice', 8_000], ['dal', 4_000]] as const) {
          await ok(call('POST', '/v1/inventory/movements', { movementId: `rc-${id}`, productId: id, locationId: STORE, kind: 'received', quantityMinor: 10, unitCostMinor: cost, uom: 'each', occurredAt: new Date(Date.now() - 3_600_000).toISOString(), enteredBy: OWNER }), `receive ${id}`);
        }
        const lines = [['rice', 2, 10_500], ['dal', 2, 5_250], ['milk', 5, 3_150], ['soap', 1, 2_100]] as const;
        const total = lines.reduce((s, [, q, p]) => s + q * p, 0);
        await ok(call('POST', '/v1/sales', {
          saleId: 'S1', receiptNumber: 'R-S1', laneId: 'lane-1', cashierId: OWNER, tradingDay: today, committedAt: new Date(Date.now() - 60_000).toISOString(), totalMinor: total, currency: 'INR', packVersion: 1, locationId: STORE,
          lines: lines.map(([productId, qty, price]) => ({ productId, quantityMinor: qty, uom: 'each', unitPriceMinor: price, lineTotalMinor: qty * price })), tenders: [{ kind: 'cash', amountMinor: total }],
        }), 'sale');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); vi.useRealTimers(); });

  it('draws the floor from above, coloured by sales and by margin per sq ft; "not known" is said, never coloured; Tamil; a cashier reads nothing', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    await pinThePageClock(context);
    await shop.signIn(context, OWNER);
    const page = await context.newPage();
    const reads: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/')) reads.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/floor-heat-map`, { waitUntil: 'load' });
    expect(reads, 'nothing is read on open').toEqual([]);
    // The window opens on the SHOP's month so far — at 19:30 UTC the browser (on UTC) still says yesterday.
    expect(await page.inputValue('#to')).toBe(today);
    expect(await page.inputValue('#from')).toBe(`${today.slice(0, 7)}-01`);
    await page.fill('#store', STORE);
    await page.fill('#from', today);
    await page.fill('#to', today);
    await page.click('#show');
    await page.locator('#floor .area').first().waitFor({ timeout: 15_000 });
    expect(reads).toEqual([`GET /v1/merchandising/stores/${STORE}/heat-map`]);
    // Sales: staples ₹315/sq ft is the best (the darkest step); dairy ₹315 too.
    const staples = page.locator('#floor .area[data-area="staples"]');
    expect(await staples.getAttribute('data-band')).toBe('4');
    expect(await page.locator('#areas tr[data-area="staples"] .fig').innerText()).toBe('₹3.15 per sq ft');
    expect(await page.textContent('#off-plan')).toBe('⚠ Sold but not on the floor plan: soap (₹21.00)');
    // Each area sits at its own coordinates: staples at the left, dairy half-way across.
    const [sBox, dBox, floor] = await Promise.all([staples.boundingBox(), page.locator('#floor .area[data-area="dairy"]').boundingBox(), page.locator('#floor').boundingBox()]);
    expect(Math.round(((sBox!.x - floor!.x) * 40) / floor!.width)).toBe(0);
    expect(Math.round(((dBox!.x - floor!.x) * 40) / floor!.width)).toBe(20);
    // The page fits a phone: no sideways scroll.
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);

    // Margin: dairy's milk has no buying cost — not known, no colour of the scale, the product named.
    await page.click('#m-margin');
    await page.locator('#areas tr[data-area="dairy"] .heat').filter({ hasText: 'Not known' }).waitFor({ timeout: 15_000 });
    expect(await page.locator('#floor .area[data-area="dairy"]').getAttribute('data-band')).toBe('unknown');
    expect(await page.locator('#areas tr[data-area="dairy"] .note').innerText()).toBe('⚠ Margin not known — no buying cost for milk');
    expect(await page.locator('#areas tr[data-area="staples"] .fig').innerText()).toBe('₹0.60 per sq ft');
    expect(await page.getAttribute('#m-margin', 'aria-pressed')).toBe('true');
    if (process.env['HEATMAP_SHOT'] !== undefined) await page.screenshot({ path: process.env['HEATMAP_SHOT'], fullPage: true });

    await page.click('#lang');
    expect(await page.textContent('#page-h')).toBe('தள வெப்ப வரைபடம்');
    expect(await page.locator('#floor .area[data-area="dairy"]').innerText()).toBe('பால் பொருட்கள் · தெரியவில்லை');
    expect(errors).toEqual([]);
    await context.close();

    const c = await browser.newContext();
    await pinThePageClock(c);
    await shop.signIn(c, 'u-cash');
    const p2 = await c.newPage();
    await p2.goto(`${shop.base}/floor-heat-map`, { waitUntil: 'load' });
    expect(await p2.textContent('#page-status')).toBe('Your role cannot read space performance.');
    expect(await p2.isDisabled('#show')).toBe(true);
    await c.close();
  }, 180_000);
});
