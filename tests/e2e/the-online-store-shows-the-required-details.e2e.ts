import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedBody } from '../support/approval-request';
import { testModePaymentProvider } from '../../packages/orders/src/payment-verification';
import { seedOnlineShop, callsFor, OWNER, MANAGER, CHECKER, STORE, type ShopCalls } from '../support/online-shop';
import { startCustomerShop, type CustomerShop } from './lib/customer-shop';

/**
 * **R4 Lane 2 — the customer app, in a real browser, on the real API (B23 · D-28 · WF-16 · M20-FR-04 · D08).**
 *
 *   • the privacy and terms pages open from every page of the store WITHOUT signing in, in English and Tamil;
 *   • before paying, every detail the shop must show is on the basket — "not set" for the grievance officer (OB-223), and
 *     the product said to be not sold online yet, by name; the microphone button is not shown (voice is off, OB-222);
 *   • My receipts: OFF until the customer switches it on (one switch, both ways), sending by SMS/WhatsApp said to be off;
 *     after the desk ties the app to the member and the till banks a bill, the copy shows "Card ending 4242" only;
 *   • My order: a return is refused "return window not set" until the owner sets the windows; then it is raised, and
 *     every step the shop records appears — the refund "waiting" for the bank; and the customer rates what they bought.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const PHONE = '+919000000031';
const SUBJECT = 'cust-phone-r4';
const MEMBER_MOBILE = '9000000031';
const PAY_REF = 'tok_r4_e2e_1';
const STORE_AT = { lat: 11.0168, lon: 76.9558 };
const NEARBY = { latitude: 11.02, longitude: 76.96 };
interface Doc { getElementById(id: string): { hidden: boolean } | null }

describe.skipIf(!existsSync(CHROMIUM))('the online store shows the required details, in a real browser (R4 Lane 2)', () => {
  let browser: Browser;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'customer-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });

  it('privacy and terms without sign-in · duties before paying with "not set" · receipts opt-in, last four only · a return refused, then every step · stars', async () => {
    const provider = testModePaymentProvider();
    const h: ApiHarness = apiHarness({ paymentVerifier: provider });
    const T = randomUUID();
    const c: ShopCalls = callsFor(() => h, T);
    const { req, ok } = c;
    await seedOnlineShop(h, T, c);
    await ok(req('PUT', '/v1/serviceability/delivery-service', { storeLocation: STORE_AT, slotsPerDay: 8, windowOpen: '09:00', windowClose: '21:00', capacityPerSlot: 10, leadMinutes: 60 }), 'delivery service');
    const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    const slot = ((await ok(req('GET', '/v1/serviceability/delivery-service', undefined, OWNER, { day: tomorrow }), 'slots')).body as { slots: { startsAt: string; endsAt: string }[] }).slots[0]!;
    await ok(req('POST', '/v1/online-store/details', { legalName: 'Synthetic Hyper Market Private Limited', address: '1 Test Road, Tamil Nadu', gstin: '33ABCDE1234F1Z5', returnTerms: 'Returns by department, within the window shown.', reason: 'e2e (synthetic)' }), 'details');
    const pack = (await ok(req('GET', '/v1/catalogue/pack'), 'pack')).body as { snapshot: { version: number; products: { productId: string; name: string; unitPriceMinor: number; baseUom: string }[] } };
    const shopData = async () => ({
      tenantId: T, customerRef: 'guest', packVersion: pack.snapshot.version, locationId: STORE,
      products: pack.snapshot.products.map((p) => ({ productId: p.productId, name: p.name, categoryId: 'x', unitPriceMinor: p.unitPriceMinor, uom: p.baseUom, barcodes: [], status: 'active', availableMinor: 5, availabilityAgeMinutes: 1 })),
      slots: [{ slotId: 'tomorrow', startsAt: slot.startsAt, endsAt: slot.endsAt, capacity: 10, booked: 0, kind: 'delivery' }],
      storeLocation: STORE_AT, policy: { radiusMetres: 10_000, deliveryFeeMinor: 40_00 }, deliveryFeeMinor: 40_00,
    });
    const store: CustomerShop = await startCustomerShop({ h, tenantId: T, subject: SUBJECT, shopData });
    const context: BrowserContext = await browser.newContext({ geolocation: NEARBY, permissions: ['geolocation'] });
    const page: Page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      // ── Privacy and terms: from every page, no sign-in ──
      await page.goto(`${store.base}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { document: Doc }).document.getElementById('sample')?.hidden === true, undefined, { timeout: 10_000 });
      expect(await page.isHidden('#voice')).toBe(true); // D08: voice is switched off — no microphone button
      await page.click('#link-terms');
      await page.waitForURL(/terms\.html$/);
      expect(await page.textContent('[data-lang="en"] h1')).toBe('Terms, returns and refunds');
      await page.click('#lang');
      expect(await page.isVisible('[data-lang="ta"] h1')).toBe(true);
      await page.click('[data-lang="ta"] a[href="./privacy.html"]');
      await page.waitForURL(/privacy\.html$/);
      await page.goto(`${store.base}/login.html`, { waitUntil: 'load' });
      expect(await page.locator('a[href="./privacy.html"]').count()).toBe(1);
      expect(await page.locator('a[href="./terms.html"]').count()).toBe(1);

      // ── Basket → sign in → every duty before paying ──
      await page.addInitScript((ref) => { (globalThis as unknown as { shopPaymentRef?: string }).shopPaymentRef = ref; }, PAY_REF);
      await page.goto(`${store.base}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { document: Doc }).document.getElementById('sample')?.hidden === true, undefined, { timeout: 10_000 });
      await page.fill('#search', 'milk');
      await page.click('button[aria-label="Add Synthetic Milk 1L"]');
      await page.click('#tab-basket');
      expect(await page.textContent('#duties-shop')).toBe('Sign in to see every detail the shop must show before you pay.');
      await page.click('#review');
      await page.click('#banner-ok');
      await page.locator('#slots .row button').first().click();
      await page.click('#banner-ok');
      await page.click('#locate');
      await page.locator('#banner-title', { hasText: 'Use my location' }).waitFor({ timeout: 10_000 });
      await page.click('#banner-ok');
      await page.fill('#si-phone', PHONE);
      await page.click('#si-send');
      await page.waitForSelector('#si-step-code:not([hidden])', { timeout: 10_000 });
      await page.fill('#si-code', store.sms.codeFor(PHONE) ?? '');
      await page.click('#si-verify');
      await page.waitForSelector('#si-step-in:not([hidden])', { timeout: 10_000 });
      const milk = page.locator('#duties .row[data-product-id="MILK"]');
      await milk.waitFor({ timeout: 10_000 });
      const duty = (field: string) => milk.locator(`.duties div[data-field="${field}"] dd`).textContent();
      expect(await duty('MRP')).toBe('₹70.00 (inclusive of all taxes)');
      expect(await duty('selling price with tax')).toBe('₹60.00 including ₹2.86 GST at 5%');
      expect(await duty('delivery fee')).toBe('₹40.00');
      expect(await duty('best-before date')).toBe('2099-12-31');
      expect(await duty('country of origin')).toBe('India');
      expect(await duty('shop GSTIN')).toBe('33ABCDE1234F1Z5');
      expect(await duty('grievance officer name')).toBe('not set');
      expect(await duty('grievance officer contact')).toBe('not set');
      expect(await milk.locator('.state').textContent()).toBe('Not sold online yet: online listing incomplete: grievance officer name');
      expect(await milk.locator('.total').textContent()).toBe('Total with delivery: ₹100.00');
      expect(await page.textContent('#duties-shop')).toBe('The online store is not open yet: online listing incomplete: grievance officer name · Sold by: Synthetic Hyper Market Private Limited');
      // Tamil words for the same details.
      await page.click('#lang');
      expect(await milk.locator('.duties div[data-field="grievance officer name"] dd').textContent()).toBe('அமைக்கப்படவில்லை');
      await page.click('#lang');

      // ── OB-234: a product not sold online cannot be paid for. The owner names the grievance officer (synthetic) and
      //    publishes MILK online; the basket reads it again and MILK is "Sold online" ──
      await ok(req('POST', '/v1/online-store/details', { grievanceOfficerName: 'Test Grievance Officer (synthetic)', grievanceOfficerContact: 'grievance@example.test (synthetic)', reason: 'e2e (synthetic)' }), 'grievance officer');
      await ok(req('POST', '/v1/online-store/listings/MILK', { action: 'publish' }), 'publish MILK online');
      await page.click('#tab-shop');
      await page.click('#tab-basket');
      await milk.locator('.state', { hasText: /^Sold online$/ }).waitFor({ timeout: 10_000 });
      expect(await duty('grievance officer name')).toBe('Test Grievance Officer (synthetic)');

      // ── Pay; the shop delivers ──
      provider.capture(PAY_REF, 100_00);
      await page.click('#pay');
      await page.locator('#order-say', { hasText: /confirmed|placed/i }).waitFor({ timeout: 15_000 }).catch(() => undefined);
      const orders = ((await ok(req('GET', '/v1/storefront/orders', undefined, SUBJECT), 'orders')).body as { orders: { orderId: string }[] }).orders;
      expect(orders).toHaveLength(1);
      const orderId = orders[0]!.orderId;
      for (const event of ['confirm', 'pick', 'pack', 'dispatch', 'deliver']) await ok(req('POST', `/v1/orders/${orderId}/transition`, { event }), event);

      // ── My order: a return refused while the windows are "not set"; raised once the owner sets them ──
      await page.click('#tab-order');
      await page.waitForSelector('#return-policy-say:has-text("not set")', { timeout: 10_000 });
      await page.fill('#return-lines input[data-product-id="MILK"]', '1');
      await page.fill('#return-reason', 'it was sour (synthetic)');
      await page.click('#return-send');
      await page.locator('#help-say', { hasText: 'MILK: return window not set: dairy.' }).waitFor({ timeout: 10_000 });
      await ok(req('POST', '/v1/online-returns/policy', { windowDaysByCategory: { dairy: 2, household: 7 }, nonReturnable: [], reason: 'e2e windows (synthetic)' }), 'policy');
      await page.fill('#return-lines input[data-product-id="MILK"]', '1'); // the form is drawn afresh after each answer
      await page.click('#return-send');
      await page.locator('#help-say', { hasText: 'r-' }).waitFor({ timeout: 10_000 });
      await page.locator('#my-returns .row[data-stage="requested"]').waitFor({ timeout: 10_000 });
      const returnId = (await page.locator('#my-returns .row').first().getAttribute('data-return-id'))!;
      // The shop's steps, recorded by people — the refund is asked for and waits for the bank.
      await ok(req('POST', `/v1/online-returns/${returnId}/collection`, { collectOn: tomorrow }, MANAGER), 'book');
      await ok(req('POST', `/v1/online-returns/${returnId}/collected`, {}, MANAGER), 'collected');
      await ok(req('POST', `/v1/online-returns/${returnId}/received`, { lines: [{ productId: 'MILK', receivedMinor: 1 }] }, MANAGER), 'received');
      await ok(req('POST', `/v1/online-returns/${returnId}/lines/MILK/disposition`, { disposition: 'quarantine' }, MANAGER), 'quarantine');
      const body = await approvedBody(h, T, MANAGER, CHECKER, 'order_refund', `${orderId}/rf-e2e`, { refundId: 'rf-e2e' }, { returnId }, 60_00);
      await ok(req('POST', `/v1/online-returns/${returnId}/refund`, body, MANAGER), 'refund');
      await page.click('#tab-shop');
      await page.click('#tab-order');
      const ret = page.locator(`#my-returns .row[data-return-id="${returnId}"]`);
      await page.locator(`#my-returns .row[data-return-id="${returnId}"][data-stage="refund_waiting"]`).waitFor({ timeout: 10_000 });
      expect(await ret.locator('.name').textContent()).toBe(`${returnId} — Refund asked for — waiting for the bank to confirm. It is not done until the bank says so.`);
      expect(await ret.locator('.step').allTextContents()).toEqual([
        'Return asked for: 1 × MILK', `Collection booked for ${tomorrow}`, 'Collected from you', 'Received back at the shop: 1 × MILK',
        'Refund of ₹60.00 asked for — waiting for the bank to confirm',
      ]);

      // ── Stars for what I bought ──
      await page.click('#rate-lines .row[data-product-id="MILK"] button[data-stars="4"]');
      await page.locator('#rate-say', { hasText: 'Thank you — your stars are saved.' }).waitFor({ timeout: 10_000 });
      await page.locator('#rate-lines .row[data-product-id="MILK"] button[data-stars="4"][aria-pressed="true"]').waitFor({ timeout: 10_000 });

      // ── My receipts: off until I switch it on; tied at the desk; the copy shows the card's last four only ──
      await page.click('#tab-privacy');
      await page.locator('#receipts-switch[aria-checked="false"]').waitFor({ timeout: 10_000 });
      expect(await page.textContent('#receipts-switch')).toBe('OFF');
      expect(await page.textContent('#receipts-sending')).toBe('Sending receipts by SMS or WhatsApp is switched off — nothing is sent.');
      await page.locator('#receipts-say', { hasText: SUBJECT }).waitFor({ timeout: 10_000 }); // the reference to show at the desk
      await page.click('#receipts-switch');
      await page.locator('#receipts-switch[aria-checked="true"]').waitFor({ timeout: 10_000 });
      await ok(req('POST', '/v1/loyalty/members', { mobile: MEMBER_MOBILE, consent: true, verifiedHow: 'seen_on_phone' }), 'enrol');
      const memberRef = ((await ok(req('POST', '/v1/loyalty/members/lookup', { mobile: MEMBER_MOBILE }), 'lookup')).body as { memberRef: string }).memberRef;
      await ok(req('POST', '/v1/loyalty/members/app-link', { mobile: MEMBER_MOBILE, appCustomerRef: SUBJECT, verifiedHow: 'seen_on_phone' }), 'link');
      await ok(req('POST', '/v1/sales', {
        saleId: 'sale-r4-e2e', receiptNumber: 'S01-L1-000777', laneId: 'lane-1', locationId: STORE, cashierId: OWNER, tradingDay: new Date().toISOString().slice(0, 10), committedAt: new Date().toISOString(),
        totalMinor: 60_00, currency: 'INR', packVersion: pack.snapshot.version, customerRef: memberRef,
        lines: [{ productId: 'MILK', quantityMinor: 1, uom: 'ea', unitPriceMinor: 60_00, lineTotalMinor: 60_00, taxRateBps: 500, hsnCode: '0401' }],
        tenders: [{ kind: 'card', amountMinor: 60_00, ref: 'ntok-ref-e2e', card: { tokenRef: 'ntok-secret-e2e', last4: '4242', network: 'visa' } }],
      }), 'bank a bill');
      await page.click('#tab-shop');
      await page.click('#tab-privacy');
      const bill = page.locator('#receipts .row[data-receipt="S01-L1-000777"]');
      await bill.waitFor({ timeout: 10_000 });
      expect(await bill.locator('.paid').textContent()).toBe('Paid: Card ending 4242 ₹60.00');
      expect(await bill.locator('.tax').textContent()).toBe('GST included: ₹2.86');
      expect(await page.content()).not.toMatch(/ntok|tokenRef/);
      // The same one switch turns it off again — no confirmation on the way out.
      await page.click('#receipts-switch');
      await page.locator('#receipts-switch[aria-checked="false"]').waitFor({ timeout: 10_000 });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await store.stop();
    }
  }, 120_000);
});
