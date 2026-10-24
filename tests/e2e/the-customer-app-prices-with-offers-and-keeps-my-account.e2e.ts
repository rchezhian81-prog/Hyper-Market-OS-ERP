import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright-core';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { testModePaymentProvider } from '../../packages/orders/src/payment-verification';
import { seedOnlineShop, listShopOnline, callsFor, OWNER, OTHER_CUSTOMER, STORE, type ShopCalls } from '../support/online-shop';
import { startCustomerShop, type CustomerShop } from './lib/customer-shop';
import { AI_SUGGESTION_NOTICE } from '../../services/ai/src/control';
import { HELP_ANSWER_NOTICE } from '../../services/orders/src/storefront-account';

/**
 * **OB-288 wave 3 — the customer app's commerce screens, in a real browser, on the real API (in memory).**
 *
 *   • D08-FR-02: the CAMERA reads a barcode (the phone's own reader; a stand-in here, with the browser's fake camera) and
 *     it becomes an ordinary search; OB-322: the customer's own voice switch, OFF and back ON, kept on the phone;
 *   • WF-13 · M20-FR-02: "See the shop's price" — the till's 10% offer and the SAVE20 coupon by name, the delivery fee,
 *     what to pay; a bad code refused on the phone; paying pays exactly that price (taken as paid, no mismatch) and the
 *     coupon is spent once — a second customer is told it is used up;
 *   • D08-FR-03: "If something is out" saved; A04 · AI-NFR-11: ideas carry the AI notice;
 *   • My order: "not given yet" until the tap, then head office's own 4-digit code for MY order and the ETA (OB-294); A05: a chosen question answered from the shop's
 *     records with the automatic-answer notice, and "ask a person" raises a case;
 *   • My account: a repeat order from the basket (refused without a day, then saved; pause, resume, cancel — OB-303); an
 *     address saved and removed; "remove saved payment" says nothing is saved; an occasion only with the yes, removed in
 *     one tap; the AI suggestions opt-in, one switch both ways (OB-314). Tamil throughout.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const PHONE = '+919000000041';
const SUBJECT = 'cust-phone-wave3';
const PAY_REF = 'tok_wave3_e2e_1';
const MILK_GTIN = '8900000000012';
const STORE_AT = { lat: 11.0168, lon: 76.9558 };
const NEARBY = { latitude: 11.02, longitude: 76.96 };
const day = (offset: number): string => new Date(Date.now() + offset * 864e5).toISOString();
const MARGIN_OK = { description: 'offer (synthetic)', normalPrice: { minor: 6_000, currency: 'INR' }, promoPrice: { minor: 5_400, currency: 'INR' }, unitCost: { minor: 4_000, currency: 'INR' }, baselineUnits: 100, expectedUnits: 200 };

describe.skipIf(!existsSync(CHROMIUM))('the customer app prices with the till\'s offers and keeps my account (OB-288 wave 3), in a real browser', () => {
  let browser: Browser;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'customer-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });

  it('camera barcode · voice switch · the shop\'s price with offer and coupon, paid exactly · substitution · AI notice · delivery code slot · A05 · repeat orders · addresses · paying · occasions · AI opt-in · Tamil', async () => {
    const provider = testModePaymentProvider();
    const h: ApiHarness = apiHarness({ paymentVerifier: provider });
    const T = randomUUID();
    const c: ShopCalls = callsFor(() => h, T);
    const { req, ok } = c;
    await seedOnlineShop(h, T, c);
    await h.enableFeature(T, 'loyalty');
    await listShopOnline(c);
    await ok(req('PUT', '/v1/serviceability/delivery-service', { storeLocation: STORE_AT, slotsPerDay: 8, windowOpen: '09:00', windowClose: '21:00', capacityPerSlot: 10, leadMinutes: 60 }), 'delivery service');
    const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    const slot = ((await ok(req('GET', '/v1/serviceability/delivery-service', undefined, OWNER, { day: tomorrow }), 'slots')).body as { slots: { startsAt: string; endsAt: string }[] }).slots[0]!;
    await ok(req('POST', '/v1/promotions/milk-10/definition', { kind: 'percent_off', percentBps: 1_000, productIds: ['MILK'], startsAt: day(-1), endsAt: day(30) }), 'define milk-10');
    await ok(req('POST', '/v1/promotions/milk-10/launch', MARGIN_OK), 'launch milk-10');
    await ok(req('POST', '/v1/loyalty/coupons/SAVE20', { kind: 'amount_off', valueMinor: 20_00, validUntil: day(30).slice(0, 10), maxRedemptions: 1, maxPerCustomer: 1, minimumBasketMinor: 100_00 }), 'coupon SAVE20');
    const pack = (await ok(req('GET', '/v1/catalogue/pack'), 'pack')).body as { snapshot: { version: number; products: { productId: string; name: string; unitPriceMinor: number; baseUom: string }[] } };
    const shopData = async () => ({
      tenantId: T, customerRef: 'guest', packVersion: pack.snapshot.version, locationId: STORE,
      products: pack.snapshot.products.map((p) => ({ productId: p.productId, name: p.name, categoryId: 'x', unitPriceMinor: p.unitPriceMinor, uom: p.baseUom, barcodes: p.productId === 'MILK' ? [MILK_GTIN] : [], status: 'active', availableMinor: 5, availabilityAgeMinutes: 1 })),
      slots: [{ slotId: 'tomorrow', startsAt: slot.startsAt, endsAt: slot.endsAt, capacity: 10, booked: 0, kind: 'delivery' }],
      storeLocation: STORE_AT, policy: { radiusMetres: 10_000, deliveryFeeMinor: 40_00 }, deliveryFeeMinor: 40_00,
    });
    const store: CustomerShop = await startCustomerShop({ h, tenantId: T, subject: SUBJECT, shopData });
    const context = await browser.newContext({ geolocation: NEARBY, permissions: ['geolocation', 'camera'] });
    const page: Page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(({ ref, gtin }) => {
      const g = globalThis as unknown as Record<string, unknown>;
      g['shopPaymentRef'] = ref;
      // Stand-ins for the phone's own barcode reader and speech recogniser (the product never sets these).
      g['shopBarcodeStandIn'] = { detect: async () => [{ rawValue: 'not-a-barcode' }, { rawValue: gtin, format: 'ean_13' }] };
      g['shopVoiceStandIn'] = { name: 'fake voice engine (e2e)', available: () => true, listen: async () => ({ heard: true, transcript: 'broom' }) };
    }, { ref: PAY_REF, gtin: MILK_GTIN });
    const text = (sel: string) => page.locator(sel).textContent();
    try {
      await page.goto(`${store.base}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(i: string): { hidden: boolean } | null } }).document.getElementById('sample')?.hidden === true, undefined, { timeout: 10_000 });

      // ── Camera barcode → an ordinary search; voice switch OFF and back ON (kept on the phone) ──
      await page.locator('#scan:not([hidden])').waitFor({ timeout: 10_000 });
      expect(await page.locator('#scan svg.sre-icon').count()).toBe(1);
      await page.click('#scan');
      await page.locator('#scan-say[data-state="read"]').waitFor({ timeout: 15_000 });
      expect(await text('#scan-say')).toBe(`Read from the barcode: ${MILK_GTIN}`);
      expect(await page.inputValue('#search')).toBe(MILK_GTIN);
      expect(await page.isHidden('#scan-box')).toBe(true); // the camera is closed once it has read
      await page.click('button[aria-label="Add Synthetic Milk 1L"]');
      expect(await page.getAttribute('#voice-switch', 'aria-checked')).toBe('true');
      expect(await page.isVisible('#voice')).toBe(true);
      await page.click('#voice-switch');
      expect(await page.getAttribute('#voice-switch', 'aria-checked')).toBe('false');
      expect(await page.isHidden('#voice')).toBe(true);
      expect(await page.evaluate(() => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem('sre.shop.voice'))).toBe('off');
      await page.click('#voice-switch');
      await page.click('#voice');
      await page.locator('#voice-say', { hasText: 'We heard: broom' }).waitFor({ timeout: 10_000 });
      await page.click('button[aria-label="Add Synthetic Broom"]');

      // ── Basket: signed out, the shop's price needs a sign-in; then the offer and the coupon by name ──
      await page.click('#tab-basket');
      await page.click('#quote-btn');
      expect(await text('#quote-say')).toBe('Please sign in first (in the basket).');
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
      await page.fill('#coupon', 'bad code!');
      await page.click('#quote-btn');
      expect(await text('#quote-say')).toBe('A coupon code is letters and digits only. Nothing was sent.');
      await page.fill('#coupon', 'SAVE20');
      await page.click('#quote-btn');
      await page.locator('#quote-box:not([hidden])').waitFor({ timeout: 10_000 });
      const row = (k: string) => text(`#quote div[data-kind="${k}"] dd`);
      expect([await row('goods'), await row('offers'), await row('coupon'), await row('delivery'), await row('payable')]).toEqual(['₹210.00', '−₹6.00', '−₹20.00', '₹40.00', '₹224.00']);
      expect(await text('#quote div[data-kind="coupon"] dt')).toBe('Coupon SAVE20');
      expect(await text('#points-say')).toMatch(/^Your app is not tied to a loyalty membership/);
      expect(await text('#quote-say')).toBe('When you pay, you pay exactly this price.');

      // ── If something is out; ideas carry the AI notice ──
      await page.click('#subs-save');
      expect(await text('#subs-say')).toBe('Choose one first. Nothing was sent.');
      await page.check('#subs input[value="contact_me"]');
      await page.click('#subs-save');
      await page.locator('#subs-say', { hasText: 'Saved' }).waitFor({ timeout: 10_000 });
      await page.click('#ideas');
      await page.locator('#ai-notice:not([hidden])').waitFor({ timeout: 10_000 });
      expect(await text('#ai-notice')).toBe(AI_SUGGESTION_NOTICE.en);

      // ── My account (before paying, while the basket is full): repeat order, address, paying, occasion, AI opt-in ──
      await page.click('#tab-account');
      await page.locator('#repeat-orders-empty:not([hidden])').waitFor({ timeout: 10_000 });
      await page.check('#repeat-every input[value="weekdays"]');
      await page.click('#repeat-save');
      expect(await text('#repeat-say')).toBe('Choose at least one day. Nothing was sent.');
      await page.check('#repeat-every input[value="days"]');
      await page.fill('#repeat-days', '7');
      await page.click('#repeat-save');
      const sub = page.locator('#repeat-orders .row').first();
      await sub.waitFor({ timeout: 10_000 });
      expect(await sub.getAttribute('data-state')).toBe('active');
      await sub.locator('button.pause').click();
      await page.locator('#repeat-orders .row[data-state="paused"]').waitFor({ timeout: 10_000 });
      await page.locator('#repeat-orders .row button.resume').click();
      await page.locator('#repeat-orders .row[data-state="active"]').waitFor({ timeout: 10_000 });
      await page.locator('#repeat-orders .row button.cancel').click();
      await page.locator('#repeat-orders .row[data-state="cancelled"]').waitFor({ timeout: 10_000 });

      await page.click('#address-save');
      expect(await text('#address-say')).toBe('Give the place a name first. Nothing was sent.');
      await page.fill('#address-label', 'Home (synthetic)');
      await page.click('#address-save');
      await page.locator('#addresses .row').first().waitFor({ timeout: 10_000 });
      await page.locator('#addresses .row button.remove').click();
      await page.locator('#addresses-empty:not([hidden])').waitFor({ timeout: 10_000 });
      expect(await text('#paying-say')).toMatch(/^The shop keeps no card details/);
      await page.click('#paying-remove');
      expect(await text('#paying-say')).toBe('Nothing was saved for paying, so nothing needed removing.');

      await page.fill('#occasion-day', '2026-12-25');
      await page.click('#occasion-save');
      expect(await text('#occasion-say')).toBe('Tick the yes first — the shop keeps the day only with it. Nothing was sent.');
      await page.check('#occasion-yes');
      await page.click('#occasion-save');
      await page.locator('#occasions .row', { hasText: 'Birthday — 12-25' }).waitFor({ timeout: 10_000 });
      await page.locator('#occasions .row button.remove').click();
      await page.locator('#occasions .row').waitFor({ state: 'detached', timeout: 10_000 });

      await page.locator('#ai-switch[aria-checked="false"]').waitFor({ timeout: 10_000 });
      expect(await text('#ai-lead')).toBe(AI_SUGGESTION_NOTICE.en);
      await page.click('#ai-switch');
      await page.locator('#ai-switch[aria-checked="true"]').waitFor({ timeout: 10_000 });
      expect(await text('#ai-why')).toBe('On: suggestions may use what you bought before. Switch it off here at any time.');
      await page.click('#ai-switch');
      await page.locator('#ai-switch[aria-checked="false"]').waitFor({ timeout: 10_000 });

      // ── Pay: exactly the shop's price; taken as paid; the coupon spent once ──
      await page.click('#tab-basket');
      provider.capture(PAY_REF, 224_00);
      await page.click('#pay');
      await page.locator('#view-order:not([hidden])').waitFor({ timeout: 15_000 });
      const orders = ((await ok(req('GET', '/v1/storefront/orders', undefined, SUBJECT), 'orders')).body as { orders: { orderId: string }[] }).orders;
      expect(orders).toHaveLength(1);
      const mine = (await ok(req('GET', `/v1/storefront/orders/${orders[0]!.orderId}`, undefined, SUBJECT), 'my order')).body as { payment?: { state?: string; amountMinor?: number } };
      // Authorised — the shop took the app's payment as its own price (a different figure would read pending, a person looks).
      expect(mine.payment?.state).toBe('authorised');
      const second = (await ok(req('POST', '/v1/storefront/cart/quote', { lines: [{ productId: 'BROOM', quantityMinor: 1 }], couponCode: 'SAVE20' }, OTHER_CUSTOMER), 'second customer')).body as { coupon: { applied: boolean; outcome: string } };
      expect(second.coupon).toMatchObject({ applied: false, outcome: 'limit_reached' });

      // ── My order: the delivery code slot, and the shop's assistant ──
      await page.click('#tab-order');
      await page.locator('#handover:not([hidden])').waitFor({ timeout: 10_000 });
      // Nothing is asked on open: "not given yet" until the customer taps (OB-294 · D08-FR-05).
      expect([await text('#handover-code'), await text('#handover-eta')]).toEqual(['not given yet', 'not given yet']);
      expect(await page.locator('#handover-show svg.sre-icon').count()).toBe(1);
      await page.click('#handover-show');
      await page.locator('#handover-code[data-given="true"]').waitFor({ timeout: 10_000 });
      // Head office's own code for MY order — the same four digits the shop holds; the ETA in head office's words.
      const issued = (await ok(req('GET', `/v1/storefront/orders/${orders[0]!.orderId}/delivery-code`, undefined, SUBJECT), 'my code')).body as { code: string };
      expect(issued.code).toMatch(/^\d{4}$/);
      expect(await text('#handover-code')).toBe(issued.code);
      expect(await text('#handover-eta')).toBe('not on a driver’s route yet');
      expect(await text('#handover-say')).toBe('Read these four numbers to the driver when your order arrives. Do not share them before then.');
      // Another customer cannot read it — refused and recorded.
      expect((await req('GET', `/v1/storefront/orders/${orders[0]!.orderId}/delivery-code`, undefined, OTHER_CUSTOMER)).status).toBe(403);
      await page.click('#ask');
      expect(await text('#ask-say')).toBe('Choose a question first. Nothing was sent.');
      await page.check('#ask-topics input[value="delivery_charges"]');
      await page.click('#ask');
      await page.locator('#ask-answer:not([hidden])').waitFor({ timeout: 10_000 });
      expect(await text('#ask-notice')).toBe(HELP_ANSWER_NOTICE.en);
      await page.click('#ask-person');
      await page.locator('#ask-say', { hasText: 'Sent to the shop — a person will reply. Reference:' }).waitFor({ timeout: 10_000 });
      for (const id of ['ask', 'ask-person']) expect(await page.locator(`#${id} svg.sre-icon`).count(), id).toBe(1);

      // ── Tamil ──
      await page.click('#lang');
      // The same code, repainted in Tamil without asking again; the ETA and the advice in Tamil.
      expect(await text('#handover-code')).toBe(issued.code);
      expect(await text('#handover-eta')).toBe('இன்னும் டிரைவரின் வழியில் இல்லை');
      expect(await text('#handover-say')).toBe('உங்கள் ஆர்டர் வரும்போது இந்த நான்கு எண்களை டிரைவரிடம் படித்துச் சொல்லுங்கள். அதற்கு முன் யாரிடமும் பகிர வேண்டாம்.');
      expect(await text('#ask-notice')).toBe(HELP_ANSWER_NOTICE.ta);
      await page.click('#tab-basket');
      expect(await text('#offers-title')).toBe('சலுகைகளும் உங்கள் விலையும்');
      expect(await text('#quote div[data-kind="payable"] dt')).toBe('நீங்கள் செலுத்துவது');
      await page.click('#tab-account');
      expect(await text('#account-title')).toBe('என் கணக்கு');
      expect(await text('#tab-account')).toBe('என் கணக்கு');
      expect(errors).toEqual([]);
      // The camera's picture never went to the shop: no write carries one.
      expect(store.writes.map((w) => w.path).filter((p) => /image|photo|camera/.test(p))).toEqual([]);
    } finally {
      await context.close();
      await store.stop();
    }
  }, 180_000);
});
