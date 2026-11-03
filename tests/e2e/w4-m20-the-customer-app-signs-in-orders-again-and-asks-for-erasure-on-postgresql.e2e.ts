import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import { CHROMIUM, CONNECTED, DATABASE_URL, OWNER, ok, startBoxPageOnCloud, type BoxCloudShop } from './lib/box-page-on-cloud';
import { says } from './lib/r4c-box-page';
import { startCustomerShopOnCloud, inviteAppCustomer, type CloudCustomerShop } from './lib/customer-shop-on-cloud';
import { seedOnlineCatalogue, listShopOnline, type ShopCalls, type Res } from '../support/online-shop';
import { setUpPracticeStores, type RealCloud } from '../support/real-store';
import { pinTheEveningClock, pinThePageClock } from '../support/evening-clock';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import { shiftDate } from '../../packages/calendar/src/trading-day';

/**
 * **W4 · M20-FR-01 · M20-FR-02 · M20-FR-04 (with M16-FR-02/03) — ONE connected run of the customer app: the real app in
 * Chromium and the staff's Customer data requests page in Chromium (served by a REAL store computer), both on the
 * PRODUCTION API over real PostgreSQL.** Synthetic data only. No SMS provider is bought (OB-562): the sign-in goes through
 * the product's own one-time-code service with the RECORDING stub SMS port — nothing is sent anywhere, and the number is a
 * synthetic one in the shape of a phone number, never a real customer's.
 *
 *   • M20-FR-01 — the customer searches the shop's catalogue, adds to the basket, signs in by one-time code (the code read
 *     from the stub port), and the app reads in Tamil;
 *   • M20-FR-02 — the shop's price in the app carries the till's 10% offer on milk and the SAVE20 coupon by name, with the
 *     delivery fee and what to pay; the customer saves the basket as a list and starts a repeat order — both are head
 *     office's on PostgreSQL; on a NEW phone session (nothing kept on the phone) she signs in again and the saved list puts
 *     the past basket back in one tap;
 *   • M20-FR-04 — in "My information" she raises an erasure herself, without contacting staff: the request is on head
 *     office's ledger in PostgreSQL under her, and the staff's Customer data requests page lists it, not yet checked.
 * The evening clock is pinned (the shop's date is ahead of UTC then) so the repeat order's first day is the SHOP's today.
 * Needs DATABASE_URL and Chromium; else it SKIPS.
 */

const STORE = 'br-1';
const MGR = 'u-mgr';
const PHONE = '+919000000420';
const SUBJECT = 'cust-w4-m20';
const STORE_AT = { lat: 11.0168, lon: 76.9558 };
const NEARBY = { latitude: 11.02, longitude: 76.96 };
const MARGIN_OK = { description: 'offer (synthetic)', normalPrice: { minor: 6_000, currency: 'INR' }, promoPrice: { minor: 5_400, currency: 'INR' }, unitCost: { minor: 4_000, currency: 'INR' }, baselineUnits: 100, expectedUnits: 200 };
const day = (offset: number): string => new Date(Date.now() + offset * 864e5).toISOString();
type Doc = { document: { getElementById(id: string): { hidden: boolean } | null } };

const callsOn = (cloud: () => RealCloud): ShopCalls => {
  const req = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, userId = OWNER, query?: Record<string, string>): Promise<Res> =>
    cloud().request({ method, path: query === undefined ? path : `${path}?${new URLSearchParams(query).toString()}`, userId, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
  const okc = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r; };
  return { req, ok: okc };
};

describe.skipIf(!CONNECTED)('W4 · M20-FR-01/02/04 connected: the customer app signs in, orders again and asks for erasure, on PostgreSQL', () => {
  let shop: BoxCloudShop;
  let app: CloudCustomerShop;
  let browser: Browser;

  beforeAll(async () => {
    pinTheEveningClock();
    execFileSync('node', ['scripts/build-app.mjs', 'customer-app'], { stdio: 'ignore' });
    shop = await startBoxPageOnCloud({
      name: 'w4-m20-customer-app', store: STORE,
      people: [{ userId: OWNER }],
      seed: async (cloud) => {
        const c = callsOn(() => cloud);
        await setUpPracticeStores(cloud, OWNER, [STORE]);
        for (const f of ['customer_app', 'delivery', 'loyalty']) await c.ok(c.req('PUT', `/v1/platform/entitlements/${f}`, { enabled: true }), `feature ${f}`);
        await cloud.grant(MGR, 'store_manager', undefined, [STORE]);
        await seedOnlineCatalogue(c, STORE);
        await listShopOnline(c);
        await c.ok(c.req('PUT', '/v1/serviceability/delivery-service', { storeLocation: STORE_AT, slotsPerDay: 8, windowOpen: '09:00', windowClose: '21:00', capacityPerSlot: 10, leadMinutes: 60 }), 'delivery service');
        // The till's offer and a coupon — the same promotion engine the till runs (M05), synthetic figures.
        await c.ok(c.req('POST', '/v1/promotions/milk-10/definition', { kind: 'percent_off', percentBps: 1_000, productIds: ['MILK'], startsAt: day(-1), endsAt: day(30) }), 'define milk-10');
        await c.ok(c.req('POST', '/v1/promotions/milk-10/launch', MARGIN_OK), 'launch milk-10');
        await c.ok(c.req('POST', '/v1/loyalty/coupons/SAVE20', { kind: 'amount_off', valueMinor: 20_00, validUntil: day(30).slice(0, 10), maxRedemptions: 5, maxPerCustomer: 5, minimumBasketMinor: 100_00 }), 'coupon SAVE20');
        // The app customer's login, the governed way (OB-76): invited by the store manager, approved by the owner.
        await inviteAppCustomer(cloud, { customerId: SUBJECT, displayName: 'Meena Sundaram (synthetic)', inviter: MGR, inviterBranch: STORE, approver: OWNER });
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
        consentPurposes: [{ purpose: 'marketing', channel: 'sms' }],
      }),
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await app?.stop(); await shop?.stop(); vi.useRealTimers(); });

  async function phone(): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, geolocation: NEARBY, permissions: ['geolocation'] });
    await pinThePageClock(ctx);
    const page = await ctx.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${app.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as Doc).document.getElementById('sample')?.hidden === true, undefined, { timeout: 10_000 });
    return { ctx, page, errors };
  }
  /** M20-FR-01: sign in by one-time code — the code the stub SMS port recorded (no provider, nothing sent). */
  async function signIn(page: Page): Promise<void> {
    await page.click('#tab-basket');
    await page.fill('#si-phone', PHONE);
    await page.click('#si-send');
    await page.waitForSelector('#si-step-code:not([hidden])');
    const code = app.sms.codeFor(PHONE);
    expect(code, 'the stub SMS port recorded a one-time code').toMatch(/^\d{4,8}$/);
    await page.fill('#si-code', code!);
    await page.click('#si-verify');
    await page.waitForSelector('#si-step-in:not([hidden])');
  }
  const text = (page: Page, sel: string) => page.locator(sel).textContent();

  it('M20-FR-01/02: search → basket → sign in by code → the shop\'s price with the offer and the coupon → a saved list and a repeat order on head office → a new phone session reorders the past basket in one tap', async () => {
    const first = await phone();
    const { page } = first;
    try {
      // ── M20-FR-01: search the shop's catalogue and add to the basket.
      await page.fill('#search', 'milk');
      await page.click('button[aria-label="Add Synthetic Milk 1L"]');
      await page.fill('#search', 'broom');
      await page.click('button[aria-label="Add Synthetic Broom"]');
      await page.click('#tab-basket');
      await page.click('#review');
      await page.click('#banner-ok');
      await page.locator('#slots .row button').first().click();
      await page.click('#banner-ok');
      await page.click('#locate');
      await page.locator('#banner-title', { hasText: 'Use my location' }).waitFor();
      await page.click('#banner-ok');
      await signIn(page);

      // ── M20-FR-02: the shop's price — the till's offer and the coupon by name, the delivery fee, what to pay.
      await page.fill('#coupon', 'SAVE20');
      await page.click('#quote-btn');
      await page.locator('#quote-box:not([hidden])').waitFor();
      const row = (k: string) => text(page, `#quote div[data-kind="${k}"] dd`);
      expect([await row('goods'), await row('offers'), await row('coupon'), await row('delivery'), await row('payable')]).toEqual(['₹210.00', '−₹6.00', '−₹20.00', '₹40.00', '₹224.00']);
      expect(await text(page, '#quote div[data-kind="coupon"] dt')).toBe('Coupon SAVE20');

      // Save the basket as a list — kept on head office for this customer.
      await page.fill('#list-name', 'Weekly (synthetic)');
      await page.click('#save-list');
      await page.locator('#list-say', { hasText: 'Saved as a list on the shop.' }).waitFor();

      // Start a repeat order of this basket; its first day is the SHOP's today.
      await page.click('#tab-account');
      await page.locator('#repeat-orders-empty:not([hidden])').waitFor();
      expect(await page.inputValue('#repeat-start')).toBe(shopDateIn(new Date().toISOString()));
      await page.check('#repeat-every input[value="days"]');
      await page.fill('#repeat-days', '7');
      await page.click('#repeat-save');
      await page.locator('#repeat-orders .row[data-state="active"]').waitFor();
      expect(first.errors).toEqual([]);
    } finally { await first.ctx.close(); }

    // Head office holds both, under her, on PostgreSQL.
    const subs = (await ok(shop.call('GET', '/v1/me/subscriptions', SUBJECT), 'repeat orders')) as { subscriptions: { state: string; customerRef: string; lines: { productId: string }[] }[] };
    expect(subs.subscriptions.map((s) => [s.customerRef, s.state])).toEqual([[SUBJECT, 'active']]);
    expect(subs.subscriptions[0]!.lines.map((l) => l.productId).sort()).toEqual(['BROOM', 'MILK']);

    // ── A NEW phone session: nothing kept on the phone. She signs in again; the saved list puts the past basket back.
    const second = await phone();
    try {
      await signIn(second.page);
      await second.page.click('#tab-shop');
      const list = second.page.locator('#mylists .row', { hasText: 'Weekly (synthetic)' });
      await list.waitFor();
      expect(await list.locator('.name').innerText()).toBe('Weekly (synthetic) — 2 item(s)');
      await list.locator('button').click();
      await second.page.locator('#mine-say', { hasText: 'Added to your basket — check it before you pay.' }).waitFor();
      await second.page.click('#tab-basket');
      await second.page.fill('#coupon', 'SAVE20');
      await second.page.click('#quote-btn');
      await second.page.locator('#quote-box:not([hidden])').waitFor();
      expect(await text(second.page, '#quote div[data-kind="goods"] dd')).toBe('₹210.00');
      // English and Tamil.
      await second.page.click('#lang');
      expect(await text(second.page, '#offers-title')).toBe('சலுகைகளும் உங்கள் விலையும்');
      expect(second.errors).toEqual([]);
    } finally { await second.ctx.close(); }
  }, 240_000);

  it('M20-FR-04: she raises an erasure in "My information" herself; it is on head office\'s ledger in PostgreSQL and on the staff\'s Customer data requests page', async () => {
    const p = await phone();
    try {
      await signIn(p.page);
      await p.page.click('#tab-privacy');
      await p.page.locator('#rights button').last().waitFor();
      await p.page.locator('#rights button').last().click();
      await p.page.locator('#banner-title', { hasText: 'We have your request' }).waitFor();
      const said = (await p.page.locator('#banner-text').textContent()) ?? '';
      expect(said).toMatch(/invoices and tax records/);
      expect(p.errors).toEqual([]);

      // On head office's ledger in PostgreSQL — read straight from the database, under her customer reference.
      const pool = new Pool({ connectionString: DATABASE_URL, max: 1, options: '-c app.tenant_id=*' });
      let rows: { payload: { requestId: string; customerRef: string; kind: string } }[] = [];
      try {
        rows = (await pool.query("SELECT payload FROM event_ledger WHERE tenant_id = $1 AND type = 'DataSubjectRequestRecorded'", [shop.tenantId])).rows as typeof rows;
      } finally { await pool.end(); }
      const mine = rows.map((r) => r.payload).filter((x) => x.customerRef === SUBJECT && x.kind === 'erasure');
      expect(mine.length).toBeGreaterThan(0);
      expect(said).toContain(mine[0]!.requestId);
    } finally { await p.ctx.close(); }

    // The staff's Customer data requests page, on the store computer: her request is waiting, not yet checked.
    const o = await shop.open(OWNER, '/data-requests/');
    expect(o.status).toBe(200);
    await says(o.page, '#rows', new RegExp(`${SUBJECT} — erase their data · not yet checked`));
    expect(o.writes, 'opening the page writes nothing').toEqual([]);
    expect(o.errors).toEqual([]);
    await o.close();
  }, 180_000);
});
