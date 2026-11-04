import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { chromium, type Browser, type Page } from 'playwright-core';
import { CHROMIUM, CONNECTED, DATABASE_URL, OWNER, ok, startBoxPageOnCloud, type BoxCloudShop } from './lib/box-page-on-cloud';
import { startCustomerShopOnCloud, inviteAppCustomer, type CloudCustomerShop } from './lib/customer-shop-on-cloud';
import { seedOnlineCatalogue, listShopOnline, type ShopCalls, type Res } from '../support/online-shop';
import { setUpPracticeStores, type RealCloud } from '../support/real-store';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import { shiftDate } from '../../packages/calendar/src/trading-day';

/**
 * **W7 · M20-FR-04 (product ratings in the customer app · OB-74 · OB-218) — ONE connected run: the REAL customer app in
 * Chromium, head office the PRODUCTION API on real PostgreSQL.** Synthetic data only; the sign-in goes through the product's
 * own one-time-code service with the recording stub SMS port (nothing is sent anywhere); no live payment provider (EX-03) —
 * the bank's answer is recorded from a synthetic statement line, as the Online orders desk does.
 *
 *   • the customer orders milk in the app and pays; before it reaches her, her stars are REFUSED in the app by head office's
 *     own words ("rate only what you bought") and nothing is saved;
 *   • the order is settled and delivered; on "My order" she taps 4 stars on the milk — the app thanks her, the 4 is shown
 *     pressed, and head office holds her rating on PostgreSQL (one ProductRated on the ledger, stars only, no words);
 *   • she then sees it on the shop's listing in her basket: "★ 4.0 stars (from 1)" — the average and the count, no name;
 *   • English and Tamil.
 * Needs DATABASE_URL and Chromium; else it SKIPS.
 */

const STORE = 'br-1';
const MGR = 'u-mgr';
const PHONE = '+919000000704';
const SUBJECT = 'cust-w7-m20-rate';
const PAY_REF = 'tok_w7_m20_rate';
const STORE_AT = { lat: 11.0168, lon: 76.9558 };
const NEARBY = { latitude: 11.02, longitude: 76.96 };
type Doc = { document: { getElementById(id: string): { hidden: boolean } | null } };

const callsOn = (cloud: () => RealCloud): ShopCalls => {
  const req = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, userId = OWNER, query?: Record<string, string>): Promise<Res> =>
    cloud().request({ method, path: query === undefined ? path : `${path}?${new URLSearchParams(query).toString()}`, userId, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
  const okc = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r; };
  return { req, ok: okc };
};

describe.skipIf(!CONNECTED)('W7 · M20-FR-04 connected: the customer rates what she bought in the app, and sees it on the listing — on PostgreSQL', () => {
  let shop: BoxCloudShop;
  let app: CloudCustomerShop;
  let browser: Browser;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'customer-app'], { stdio: 'ignore' });
    shop = await startBoxPageOnCloud({
      name: 'w7-m20-ratings', store: STORE,
      people: [{ userId: OWNER }],
      seed: async (cloud) => {
        const c = callsOn(() => cloud);
        await setUpPracticeStores(cloud, OWNER, [STORE]);
        for (const f of ['customer_app', 'delivery', 'loyalty']) await c.ok(c.req('PUT', `/v1/platform/entitlements/${f}`, { enabled: true }), `feature ${f}`);
        await cloud.grant(MGR, 'store_manager', undefined, [STORE]);
        await seedOnlineCatalogue(c, STORE);
        await listShopOnline(c);
        await c.ok(c.req('PUT', '/v1/serviceability/delivery-service', { storeLocation: STORE_AT, slotsPerDay: 8, windowOpen: '09:00', windowClose: '21:00', capacityPerSlot: 10, leadMinutes: 60 }), 'delivery service');
        await inviteAppCustomer(cloud, { customerId: SUBJECT, displayName: 'Lakshmi Narayanan (synthetic)', inviter: MGR, inviterBranch: STORE, approver: OWNER });
      },
    });
    const c = callsOn(() => shop.cloud);
    const pack = (await c.ok(c.req('GET', '/v1/catalogue/pack'), 'pack')).body as { snapshot: { version: number; products: { productId: string; name: string; unitPriceMinor: number; baseUom: string }[] } };
    const tomorrow = shiftDate(shopDateIn(new Date().toISOString()), 1);
    const slot = ((await c.ok(c.req('GET', '/v1/serviceability/delivery-service', undefined, OWNER, { day: tomorrow }), 'slots')).body as { slots: { startsAt: string; endsAt: string }[] }).slots[0]!;
    app = await startCustomerShopOnCloud({
      cloud: () => shop.cloud, subject: SUBJECT,
      shopData: async () => ({
        tenantId: shop.cloud.tenantId, customerRef: 'guest', packVersion: pack.snapshot.version, locationId: STORE,
        products: pack.snapshot.products.map((p) => ({ productId: p.productId, name: p.name, categoryId: 'x', unitPriceMinor: p.unitPriceMinor, uom: p.baseUom, barcodes: [], status: 'active', availableMinor: 5, availabilityAgeMinutes: 1 })),
        slots: [{ slotId: 'tomorrow', startsAt: slot.startsAt, endsAt: slot.endsAt, capacity: 10, booked: 0, kind: 'delivery' }],
        storeLocation: STORE_AT, policy: { radiusMetres: 10_000, deliveryFeeMinor: 40_00 }, deliveryFeeMinor: 40_00,
      }),
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await app?.stop(); await shop?.stop(); });

  /** A notice the app raised (e.g. "My order") is read and put away, as she would, before the next tap. */
  const putAwayNotice = async (page: Page) => { if (await page.isVisible('#banner')) { await page.click('#banner-ok'); await page.locator('#banner').waitFor({ state: 'hidden' }); } };
  const says = (page: Page, sel: string, words: string) => page.locator(sel, { hasText: words }).waitFor({ timeout: 15_000 });
  const myOrders = async (): Promise<{ orderId: string; state: string }[]> => ((await ok(shop.call('GET', '/v1/storefront/orders', SUBJECT), 'my orders')) as { orders: { orderId: string; state: string }[] }).orders;

  it('refused before it reaches her; after delivery she taps 4 stars, head office holds them on PostgreSQL, and the listing shows ★ 4.0 from 1', async () => {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, geolocation: NEARBY, permissions: ['geolocation'] });
    const page = await ctx.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript((ref) => { (globalThis as unknown as { shopPaymentRef?: string }).shopPaymentRef = ref; }, PAY_REF);
    try {
      // ── She orders milk in the app: basket → check → slot → location → sign in by one-time code → pay.
      await page.goto(`${app.base}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as Doc).document.getElementById('sample')?.hidden === true, undefined, { timeout: 10_000 });
      await page.fill('#search', 'milk');
      await page.click('button[aria-label="Add Synthetic Milk 1L"]');
      await page.click('#tab-basket');
      await page.click('#review');
      await page.click('#banner-ok');
      await page.locator('#slots .row button').first().click();
      await page.click('#banner-ok');
      await page.click('#locate');
      await page.locator('#banner-title', { hasText: 'Use my location' }).waitFor();
      await page.click('#banner-ok');
      await page.fill('#si-phone', PHONE);
      await page.click('#si-send');
      await page.waitForSelector('#si-step-code:not([hidden])');
      await page.fill('#si-code', app.sms.codeFor(PHONE) ?? '');
      await page.click('#si-verify');
      await page.waitForSelector('#si-step-in:not([hidden])');
      await page.click('#pay');
      await page.locator('#check-payment:not([hidden])').waitFor();
      const order = (await myOrders())[0]!;

      // ── Before it reaches her: head office refuses her stars, by name; nothing is saved.
      await page.click('#tab-order');
      const milkStars = page.locator('#rate-lines .row[data-product-id="MILK"]');
      await milkStars.waitFor();
      await putAwayNotice(page);
      await milkStars.locator('button[data-stars="3"]').click();
      await says(page, '#rate-say', 'rate only what you bought');
      expect(((await ok(shop.call('GET', '/v1/me/ratings', SUBJECT), 'my ratings')) as { count: number }).count).toBe(0);

      // ── The shop settles the payment from a synthetic statement line and moves the order to delivered (the Online orders
      //    desk's own routes; no live provider, EX-03).
      await ok(shop.call('POST', `/v1/orders/${order.orderId}/payment/resolution`, OWNER, { result: 'authorised', evidenceRef: 'STMT-W7-M20-0001' }), 'settle from the statement');
      for (const event of ['confirm', 'pick', 'pack', 'dispatch', 'deliver']) await ok(shop.call('POST', `/v1/orders/${order.orderId}/transition`, OWNER, { event }), `${order.orderId} ${event}`);
      await expect.poll(async () => (await myOrders()).find((o) => o.orderId === order.orderId)?.state).toBe('delivered');

      // ── After delivery: she taps 4 stars on "My order"; the app thanks her and shows the 4 pressed.
      await page.click('#tab-shop');
      await page.click('#tab-order');
      await putAwayNotice(page);
      await milkStars.locator('button[data-stars="4"]').click();
      await says(page, '#rate-say', 'Thank you — your stars are saved.');
      await expect.poll(async () => page.getAttribute('#rate-lines .row[data-product-id="MILK"] button[data-stars="4"]', 'aria-pressed')).toBe('true');
      expect(await page.getAttribute('#rate-lines .row[data-product-id="MILK"] button[data-stars="3"]', 'aria-pressed')).toBe('false');

      // Head office holds it under her, stars only — on PostgreSQL, read straight from the ledger.
      const mine = (await ok(shop.call('GET', '/v1/me/ratings', SUBJECT), 'my ratings')) as { ratings: { productId: string; stars: number }[] };
      expect(mine.ratings.map((r) => [r.productId, r.stars])).toEqual([['MILK', 4]]);
      const pool = new Pool({ connectionString: DATABASE_URL, max: 1, options: '-c app.tenant_id=*' });
      let rows: { payload: Record<string, unknown> }[] = [];
      try {
        rows = (await pool.query("SELECT payload FROM event_ledger WHERE tenant_id = $1 AND type = 'ProductRated'", [shop.tenantId])).rows as typeof rows;
      } finally { await pool.end(); }
      expect(rows.map((r) => [r.payload['productId'], r.payload['customerRef'], r.payload['stars']])).toEqual([['MILK', SUBJECT, 4]]);
      expect(Object.keys(rows[0]!.payload).some((k) => /review|text|comment/i.test(k))).toBe(false); // no words, ever (OB-218)

      // ── She sees it on the shop's listing: milk in the basket again, the average and the count, no name.
      await page.click('#tab-shop');
      await page.fill('#search', 'milk');
      await page.click('button[aria-label="Add Synthetic Milk 1L"]');
      await page.click('#tab-basket');
      await says(page, '#duties .row[data-product-id="MILK"] .rating', '★ 4.0 stars (from 1)');
      const summary = (await ok(shop.call('GET', '/v1/storefront/ratings', SUBJECT), 'the shop\'s summary')) as { ratings: unknown[] };
      expect(summary.ratings).toEqual([{ productId: 'MILK', count: 1, average: 4 }]);
      expect(JSON.stringify(summary)).not.toContain(SUBJECT);

      // English and Tamil.
      await page.click('#lang');
      await page.click('#tab-order');
      await says(page, '#rate-title', 'நீங்கள் வாங்கியதை மதிப்பிடுங்கள்');
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }
  }, 240_000);
});
