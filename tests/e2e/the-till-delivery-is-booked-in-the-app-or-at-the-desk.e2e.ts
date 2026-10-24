import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright-core';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { seedOnlineShop, listShopOnline, callsFor, OWNER, CASHIER, STORE, type ShopCalls } from '../support/online-shop';
import { startCustomerShop, type CustomerShop } from './lib/customer-shop';
import { startInboxShop, ok as okHo, type InboxShop } from './lib/ai-inbox-shop';
import { listableProduct } from '../support/sell-online';

/**
 * **OB-352 (owner, 24 Oct 2026, in writing) — the till delivery's address and slot, in a real browser.**
 *
 *   • THE CUSTOMER APP (on the real API, in memory): a bill the till marked for delivery names the customer's membership,
 *     which the service desk tied to this app account. Under "Deliveries from the shop" the customer chooses one of their
 *     saved addresses and an open slot and books it; it then reads booked. Tamil.
 *   • THE DELIVERY DESK (the Dispatch page, on the production API over real PostgreSQL): a bill with no member waits for
 *     the desk; the desk enters the map point from the till's slip and a slot; it then reads booked. A point that is not a
 *     latitude and longitude is refused on the page. Tamil. Needs DATABASE_URL for this half; else that half SKIPS.
 * Synthetic data only. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const DATABASE_URL = process.env['DATABASE_URL'];
const PHONE = '+919000000071';
const SUBJECT = 'cust-phone-till-delivery';
const STORE_AT = { lat: 11.0168, lon: 76.9558 };
const NEARBY = { latitude: 11.02, longitude: 76.96 };
const KEY = ['till', 'delivery', 'desk', 'e2e', 'key'].join('-').padEnd(48, '0');
const tillBill = (saleId: string, locationId: string, productId: string, cashier: string, extra: Record<string, unknown> = {}) => ({
  saleId, receiptNumber: `L1-${saleId}`, laneId: 'lane-1', locationId, cashierId: cashier, tradingDay: new Date().toISOString().slice(0, 10), committedAt: new Date().toISOString(),
  totalMinor: 60_00, currency: 'INR', packVersion: 1, lines: [{ productId, quantityMinor: 1, uom: 'ea', unitPriceMinor: 60_00, lineTotalMinor: 60_00 }],
  tenders: [{ kind: 'cash', amountMinor: 60_00 }], delivery: { requested: true, feeMinor: 0 }, ...extra,
});

describe.skipIf(!HAVE_BROWSER)('the till delivery is booked in the app or at the desk (OB-352), in a real browser', () => {
  let browser: Browser;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'customer-app'], { stdio: 'ignore' });
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });

  it('the customer with the app chooses a saved address and a slot for the till\'s bill; it reads booked; Tamil', async () => {
    const h: ApiHarness = apiHarness();
    const T = randomUUID();
    const c: ShopCalls = callsFor(() => h, T);
    const { req, ok } = c;
    await seedOnlineShop(h, T, c);
    await h.enableFeature(T, 'loyalty');
    await h.enableFeature(T, 'delivery');
    await listShopOnline(c);
    await h.provisionRole(T, SUBJECT, 'customer');
    await ok(req('PUT', '/v1/serviceability/delivery-service', { storeLocation: STORE_AT, slotsPerDay: 8, windowOpen: '09:00', windowClose: '21:00', capacityPerSlot: 10, leadMinutes: 60 }), 'delivery service');
    // The service desk enrols the member and ties the membership to this app account (seen on the phone).
    const MOBILE = '98400' + '77777';
    const memberRef = ((await ok(req('POST', '/v1/loyalty/members', { mobile: MOBILE, consent: true, verifiedHow: 'seen_on_phone' }), 'enrol')).body as { memberRef: string }).memberRef;
    await ok(req('POST', '/v1/loyalty/members/app-link', { mobile: MOBILE, appCustomerRef: SUBJECT, verifiedHow: 'seen_on_phone' }), 'app link');
    await ok(req('POST', '/v1/me/addresses/home', { label: 'Home (synthetic)', location: { lat: 11.02, lon: 76.96 }, landmark: 'blue gate' }, SUBJECT), 'saved address');
    // The till's bill for delivery in the member's name, relayed by the store computer.
    expect((await req('POST', '/v1/sales', tillBill('S-APP', STORE, 'MILK', CASHIER, { customerRef: memberRef }), CASHIER)).status).toBe(202);

    const pack = (await ok(req('GET', '/v1/catalogue/pack'), 'pack')).body as { snapshot: { version: number; products: { productId: string; name: string; unitPriceMinor: number; baseUom: string }[] } };
    const shopData = async () => ({
      tenantId: T, customerRef: 'guest', packVersion: pack.snapshot.version, locationId: STORE,
      products: pack.snapshot.products.map((p) => ({ productId: p.productId, name: p.name, categoryId: 'x', unitPriceMinor: p.unitPriceMinor, uom: p.baseUom, barcodes: [], status: 'active', availableMinor: 5, availabilityAgeMinutes: 1 })),
      slots: [], storeLocation: STORE_AT, policy: { radiusMetres: 10_000, deliveryFeeMinor: 40_00 }, deliveryFeeMinor: 40_00,
    });
    const store: CustomerShop = await startCustomerShop({ h, tenantId: T, subject: SUBJECT, shopData });
    const context = await browser.newContext({ geolocation: NEARBY, permissions: ['geolocation'] });
    const page: Page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const text = (sel: string) => page.locator(sel).textContent();
    try {
      await page.goto(`${store.base}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(i: string): { hidden: boolean } | null } }).document.getElementById('sample')?.hidden === true, undefined, { timeout: 10_000 });
      // Sign in (in the basket, as the app asks).
      await page.fill('#search', 'Milk');
      await page.click('button[aria-label="Add Synthetic Milk 1L"]');
      await page.click('#tab-basket');
      await page.fill('#si-phone', PHONE);
      await page.click('#si-send');
      await page.waitForSelector('#si-step-code:not([hidden])', { timeout: 10_000 });
      await page.fill('#si-code', store.sms.codeFor(PHONE) ?? '');
      await page.click('#si-verify');
      await page.waitForSelector('#si-step-in:not([hidden])', { timeout: 10_000 });

      await page.click('#tab-account');
      expect(await text('#till-del-title')).toBe('Deliveries from the shop');
      const row = page.locator('#till-dels .row[data-till-delivery="till-S-APP"]');
      await row.waitFor({ timeout: 10_000 });
      expect(await row.getAttribute('data-status')).toBe('waiting_for_customer_app');
      expect((await row.textContent()) ?? '').toContain('Bill L1-S-APP');
      expect(await row.locator('select.td-address option').allTextContents()).toEqual(['Home (synthetic) — blue gate']);
      expect(await row.locator('select.td-slot option').count()).toBeGreaterThan(0);
      expect(await row.locator('button.book svg.sre-icon').count()).toBe(1);
      await row.locator('button.book').click();
      await page.locator('#till-dels .row[data-status="booked"]').waitFor({ timeout: 10_000 });
      expect(await text('#till-del-say')).toBe('Booked.');
      expect((await page.locator('#till-dels .row[data-status="booked"]').textContent()) ?? '').toContain('✓ Booked for');
      await page.click('#lang');
      await page.locator('#till-del-title', { hasText: 'கடையிலிருந்து டெலிவரிகள்' }).waitFor({ timeout: 10_000 });
      const jobs = (await req('GET', '/v1/delivery/till-jobs', undefined, OWNER)).body as { jobs: { orderId: string; status: string; given: { by: string } }[] };
      expect(jobs.jobs.map((j) => [j.orderId, j.status, j.given.by])).toEqual([['till-S-APP', 'booked', 'customer_app']]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await store.stop();
    }
  }, 120_000);

  describe.skipIf(DATABASE_URL === undefined)('the delivery desk, on the production API', () => {
    let shop: InboxShop;
    let runDate = '';
    beforeAll(async () => {
      shop = await startInboxShop({
        databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
        page: { path: '/dispatch', html: 'dispatch.html', dataGlobal: 'dispatchData' },
        seed: async (cloud) => {
          const req = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, userId = OWNER) => cloud.request({ method, path, userId, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
          for (const f of ['delivery', 'customer_app']) await okHo(req('PUT', `/v1/platform/entitlements/${f}`, { enabled: true }), `feature ${f}`);
          await cloud.grant('u-cash', 'cashier');
          await listableProduct((path, body) => req('POST', path, body), { productId: 'RICE', storeId: 'br-1', priceMinor: 60_00 });
          await okHo(req('PUT', '/v1/serviceability/delivery-service', { storeLocation: STORE_AT, slotsPerDay: 6, windowOpen: '09:00', windowClose: '21:00', capacityPerSlot: 10, leadMinutes: 60 }), 'delivery service');
          runDate = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
          const sold = await cloud.request({ method: 'POST', path: '/v1/sales', userId: 'u-cash', branchId: 'br-1', idempotencyKey: 'sale-desk', body: tillBill('S-DESK', 'br-1', 'RICE', 'u-cash') });
          if (sold.status !== 202) throw new Error(`the till's bill: ${sold.status} ${JSON.stringify(sold.body)}`);
        },
      });
    }, 300_000);
    afterAll(async () => { await shop?.stop(); });

    it('a bill with no member waits for the desk; the desk enters the map point and a slot from the slip; booked; a bad point refused on the page; Tamil', async () => {
      const context = await browser.newContext();
      await shop.signIn(context, OWNER);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${shop.base}/dispatch`, { waitUntil: 'load' });
      expect(await page.textContent('#till-jobs-h')).toBe('Deliveries from the till');
      expect(await page.locator('#show-till-jobs svg').count()).toBe(1);
      await page.fill('#store', 'br-1');
      await page.fill('#till-day', runDate);
      await page.click('#show-till-jobs');
      const row = page.locator('#till-jobs li.row[data-order="till-S-DESK"]');
      await row.waitFor({ timeout: 15_000 });
      expect(await row.getAttribute('data-status')).toBe('waiting_for_delivery_desk');
      expect((await row.textContent()) ?? '').toContain('Waiting for the desk — enter it from the slip');
      expect(await page.textContent('#till-jobs-status')).toBe('1 waiting for the desk · 0 waiting for the customer');
      await row.locator('input.tj-lat').fill('eleven');
      await row.locator('input.tj-lon').fill('76.97');
      await row.locator('button', { hasText: 'Book this delivery' }).click();
      expect(await page.textContent('#till-jobs-status')).toBe('The map point is not a latitude and longitude.');
      await row.locator('input.tj-lat').fill('11.03');
      await row.locator('input.tj-landmark').fill('opposite the temple');
      await row.locator('button', { hasText: 'Book this delivery' }).click();
      await page.locator('#till-jobs li.row[data-order="till-S-DESK"][data-status="booked"]').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#till-jobs-status')).toBe('Saved.');
      expect((await page.textContent('#till-jobs li.row[data-order="till-S-DESK"]')) ?? '').toContain('entered at the desk by u-owner');
      await page.click('#lang');
      expect(await page.textContent('#till-jobs-h')).toBe('கவுண்டரிலிருந்து டெலிவரிகள்');
      expect(errors).toEqual([]);
      await context.close();
    }, 120_000);
  });
});
