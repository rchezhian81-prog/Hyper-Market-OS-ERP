import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { says } from './lib/r4c-box-page';
import { theEvening, pinTheEveningClock, pinThePageClock } from '../support/evening-clock';

/**
 * **W3 (D06-FR-06 "shelf / POS / app price integrity" · D-7 · B25) — a shelf walk recorded and checked on the Price mismatches
 * page, in a real browser, on the PRODUCTION API over real PostgreSQL.** The page used to only read the ageing report.
 *   • the store manager records what the shelf label shows for oil (₹45.00 at A3-02, under the shop's ₹50.00) and what the app
 *     shows for rice (₹70.00, the shop's own price); a typed "45.5.0" is refused on the page and nothing is sent;
 *   • she checks the walk: head office's verdict puts the oil label FIRST as "shows less than the till" (the price the customer
 *     was offered), the rice agrees; the till's price was head office's own price of record, never typed;
 *   • the ageing report then lists the oil label as an open mismatch in the owner's first band; no price was changed;
 *   • a cashier is offered no walk.
 * Synthetic data, a fresh tenant. Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['w3', 'price', 'walk', 'key'].join('-').padEnd(48, '0');
const CASHIER = 'u-cash';
const STORE = 'br-1';
// The shop's own date at an evening UTC moment (19:30 UTC — already tomorrow in the shop), pinned so the evening case is
// proven whenever this runs: the shelf price is dated by the shop's day, never the UTC date.
const EVENING = theEvening();

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('a shelf walk is recorded and checked on the Price mismatches page (D06-FR-06)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const price = async (id: string): Promise<number> => ((await shop.cloud().request({ method: 'GET', path: `/v1/prices/list/${id}/resolve?storeId=${STORE}&at=${encodeURIComponent(new Date().toISOString())}`, userId: OWNER })).body as { priceMinor: number }).priceMinor;

  beforeAll(async () => {
    pinTheEveningClock(EVENING);
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/price-integrity', html: 'price-integrity.html', dataGlobal: 'storeOpsData' },
      seed: async (cloud) => {
        await cloud.grant(CASHIER, 'cashier', undefined, [STORE]);
        for (const [id, minor] of [['OIL', 5_000], ['RICE', 7_000]] as const) {
          await ok(cloud.request({ method: 'POST', path: `/v1/prices/list/${id}/entries/e1`, userId: OWNER, idempotencyKey: `price-${id}`, body: { scope: 'store', scopeRef: STORE, priceMinor: minor, mrpMinor: minor * 2, costMinor: 1_000, marginFloorBps: 0, currency: 'INR', effectiveFrom: EVENING.shopDate } }), `price ${id}`);
        }
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); vi.useRealTimers(); });

  const open = async (who: string) => {
    const context = await browser.newContext();
    await pinThePageClock(context);
    await shop.signIn(context, who, STORE);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/price-integrity`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };

  it('record the oil label and the rice on the app, check the walk: the oil label comes first; the ageing report lists it', async () => {
    const m = await open(MGR);
    await m.page.waitForSelector('#walk:not([hidden])');
    await says(m.page, '#walk-rows', /Nothing recorded yet in this walk/);
    await m.page.fill('#branch', STORE);
    await m.page.fill('#w-product', 'OIL');
    await m.page.fill('#w-shown', '45.5.0');
    await m.page.click('#w-record');
    await says(m.page, '#record-status', /^Type the price shown in rupees/);
    expect(m.writes).toEqual([]);
    await m.page.fill('#w-shown', '45');
    await m.page.fill('#w-shelf', 'A3-02');
    await m.page.click('#w-record');
    await says(m.page, '#record-status', /^Recorded: OIL ₹45\.00\.$/);
    await m.page.fill('#w-product', 'RICE');
    await m.page.selectOption('#w-surface', 'app');
    await m.page.fill('#w-shown', '70.00');
    await m.page.click('#w-record');
    await says(m.page, '#record-status', /^Recorded: RICE ₹70\.00\.$/);
    await says(m.page, '#walk-rows', /OIL — Shelf label ₹45\.00 · A3-02.*RICE — Customer app ₹70\.00/);
    expect(m.writes.filter((w) => w.startsWith('POST /v1/pricing/integrity/observations/'))).toHaveLength(2);

    await m.page.click('#w-check');
    await says(m.page, '#check-status', /^2 product\(s\) checked\.$/);
    await says(m.page, '#risk-rows li[data-product="OIL"]', /OIL — Shelf label shows less than the till\s*shown ₹45\.00 · till ₹50\.00\s*A3-02/);
    expect(await m.page.locator('#check-result li[data-product="RICE"]').count()).toBe(0);
    expect(m.writes).toContain('POST /v1/pricing/integrity/audit');
    // the ageing report learns the walk: the oil label is open, in the owner's first band
    await says(m.page, '#rows tr[data-product="OIL"][data-surface="shelf_label"]', /OIL.*₹50\.00.*₹45\.00/);
    // nothing changed a price
    expect(await price('OIL')).toBe(5_000);
    expect(m.writes.some((w) => w.includes('/v1/prices/'))).toBe(false);
    await m.page.click('#lang');
    await says(m.page, '#record-h', /^அடுக்கில் காட்டும் விலையைப் பதிவு செய்$/);
    expect(m.errors).toEqual([]);
    await m.close();
  }, 120_000);

  it('a cashier is offered no shelf walk, and head office refuses an observation from him', async () => {
    const c = await open(CASHIER);
    await c.page.waitForLoadState('load');
    expect(await c.page.isVisible('#walk')).toBe(false);
    expect(c.writes).toEqual([]);
    await c.close();
    const refused = await shop.cloud().request({ method: 'POST', path: '/v1/pricing/integrity/observations/o-cash', userId: CASHIER, branchId: STORE, idempotencyKey: randomUUID(), body: { branchId: STORE, productId: 'OIL', surface: 'shelf_label', priceMinor: 1 } });
    expect(refused.status).toBe(403);
  });
});
