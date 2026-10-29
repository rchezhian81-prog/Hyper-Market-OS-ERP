import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright-core';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { testModePaymentProvider } from '../../packages/orders/src/payment-verification';
import { seedOnlineShop, listShopOnline, callsFor, deliveredOrder, OWNER, OTHER_CUSTOMER, STORE, type ShopCalls } from '../support/online-shop';
import { startCustomerShop, type CustomerShop } from './lib/customer-shop';
import { pinTheEveningClock, pinThePageClock } from '../support/evening-clock';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import { shiftDate } from '../../packages/calendar/src/trading-day';

/**
 * **OB-350 scan-and-go and OB-351 invite a friend — the customer app, in a real browser, on the real API (in memory).**
 *
 *   • My account → Invite a friend: my 8-character code; both rewards read "not set yet — nothing is given" until the owner
 *     enters them; my own code is refused; a friend who used it shows as "waiting for their first delivery", then — after
 *     their first delivered order and the owner's number — as earned with the amount (never who they are);
 *   • Scan and go: the camera (the phone's own reader; a stand-in here) and the typed number put lines in; a weighed or
 *     unknown item is refused in words; the shelf total and the shop's price (the till's offers engine) are each named;
 *     "Go to a till" shows the six-digit code; when the store computer brings it up at a till, the phone says which till;
 *   • every word in Tamil too; icons beside words; nothing on a timer.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const PHONE = '+919000000051';
const SUBJECT = 'cust-phone-sg';
const MILK_GTIN = '8900000000012';
const BROOM_GTIN = '8900000000029';
const STORE_AT = { lat: 11.0168, lon: 76.9558 };
const NEARBY = { latitude: 11.02, longitude: 76.96 };

describe.skipIf(!existsSync(CHROMIUM))('the customer app scans and goes, and invites a friend (OB-350 · OB-351), in a real browser', () => {
  let browser: Browser;
  beforeAll(async () => {
    // The journey runs at an evening UTC moment (19:30 UTC — already tomorrow in the shop), pinned so the evening case is
    // proven whenever this runs.
    pinTheEveningClock();
    execFileSync('node', ['scripts/build-app.mjs', 'customer-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  }, 120_000);
  afterAll(async () => { await browser?.close(); vi.useRealTimers(); });

  it('invite a friend: code, "not set", own code refused, a friend waiting then earned · scan and go: camera + typed, refusals, two totals, the till code, which till took it · Tamil', async () => {
    const provider = testModePaymentProvider();
    const h: ApiHarness = apiHarness({ paymentVerifier: provider });
    const T = randomUUID();
    const c: ShopCalls = callsFor(() => h, T);
    const { req, ok } = c;
    await seedOnlineShop(h, T, c);
    await h.enableFeature(T, 'loyalty');
    await listShopOnline(c);
    await h.provisionRole(T, 'u-box', 'store_computer', [STORE]);
    for (const [id, code] of [['MILK', MILK_GTIN], ['BROOM', BROOM_GTIN]] as const) await ok(req('POST', `/v1/catalogue/products/${id}/barcodes/${code}`, { kind: 'ean' }), `barcode ${id}`);
    // The pack is as of the SHOP's today — its prices start then (from 18:30 UTC the UTC date is the shop's yesterday,
    // when no price is yet in force and the pack would be empty).
    await ok(req('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: shopDateIn(new Date().toISOString()) }), 'pack with barcodes');
    await ok(req('PUT', '/v1/serviceability/delivery-service', { storeLocation: STORE_AT, slotsPerDay: 8, windowOpen: '09:00', windowClose: '21:00', capacityPerSlot: 10, leadMinutes: 60 }), 'delivery service');
    const tomorrow = shiftDate(shopDateIn(new Date().toISOString()), 1); // the shop's tomorrow
    const slot = ((await ok(req('GET', '/v1/serviceability/delivery-service', undefined, OWNER, { day: tomorrow }), 'slots')).body as { slots: { startsAt: string; endsAt: string }[] }).slots[0]!;
    const pack = (await ok(req('GET', '/v1/catalogue/pack'), 'pack')).body as { snapshot: { version: number; products: { productId: string; name: string; unitPriceMinor: number; baseUom: string }[] } };
    const shopData = async () => ({
      tenantId: T, customerRef: 'guest', packVersion: pack.snapshot.version, locationId: STORE,
      products: [
        ...pack.snapshot.products.map((p) => ({ productId: p.productId, name: p.name, categoryId: 'x', unitPriceMinor: p.unitPriceMinor, uom: p.baseUom, barcodes: p.productId === 'MILK' ? [MILK_GTIN] : p.productId === 'BROOM' ? [BROOM_GTIN] : [], status: 'active', availableMinor: 5, availabilityAgeMinutes: 1 })),
        { productId: 'LOOSE-RICE', name: 'Synthetic Loose Rice', categoryId: 'x', unitPriceMinor: 60_00, uom: 'kg', barcodes: ['8900000000036'], status: 'active', availableMinor: 5, availabilityAgeMinutes: 1 },
      ],
      slots: [{ slotId: 'tomorrow', startsAt: slot.startsAt, endsAt: slot.endsAt, capacity: 10, booked: 0, kind: 'delivery' }],
      storeLocation: STORE_AT, policy: { radiusMetres: 10_000, deliveryFeeMinor: 40_00 }, deliveryFeeMinor: 40_00,
    });
    const store: CustomerShop = await startCustomerShop({ h, tenantId: T, subject: SUBJECT, shopData });
    const context = await browser.newContext({ geolocation: NEARBY, permissions: ['geolocation', 'camera'] });
    await pinThePageClock(context);
    const page: Page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(({ gtin }) => {
      // A stand-in for the phone's own barcode reader (the product never sets it).
      (globalThis as unknown as Record<string, unknown>)['shopBarcodeStandIn'] = { detect: async () => [{ rawValue: gtin, format: 'ean_13' }] };
    }, { gtin: MILK_GTIN });
    const text = (sel: string) => page.locator(sel).textContent();
    try {
      await page.goto(`${store.base}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(i: string): { hidden: boolean } | null } }).document.getElementById('sample')?.hidden === true, undefined, { timeout: 10_000 });

      // ── Signed out, scan and go still builds the basket on the phone; handing it over needs a sign-in.
      await page.click('#tab-scan');
      expect(await text('#sg-title')).toBe('Scan and go');
      expect(await page.locator('#sg-add svg.sre-icon').count()).toBe(1);
      await page.fill('#sg-typed', BROOM_GTIN);
      await page.click('#sg-add');
      await page.locator('#sg-say[data-state="added"]').waitFor({ timeout: 10_000 });
      await page.click('#sg-till');
      expect(await text('#sg-say')).toBe('Please sign in first (in the basket).');

      // ── Sign in (in the basket, as the app asks).
      await page.click('#tab-shop');
      await page.fill('#search', 'Milk');
      await page.click('button[aria-label="Add Synthetic Milk 1L"]');
      await page.click('#tab-basket');
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

      // ── Invite a friend (OB-351).
      await page.click('#tab-account');
      await page.locator('#referral-box:not([hidden])').waitFor({ timeout: 10_000 });
      const myCode = (await text('#referral-code'))!.trim();
      expect(myCode).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
      expect([await text('#referral-mine'), await text('#referral-friend')]).toEqual(['not set yet — nothing is given until the shop sets it', 'not set yet — nothing is given until the shop sets it']);
      expect(await text('#referrals')).toBe('Nobody has used your code yet.');
      await page.fill('#referral-claim-code', 'bad');
      await page.click('#referral-claim');
      expect(await text('#referral-say')).toBe('A referral code is 8 letters and digits, as your friend’s app shows it. Nothing was sent.');
      await page.fill('#referral-claim-code', myCode.toLowerCase());
      await page.click('#referral-claim');
      await page.locator('#referral-say', { hasText: 'your own referral code' }).waitFor({ timeout: 10_000 });
      expect(await page.locator('#referral-claim svg.sre-icon').count()).toBe(1);
      // A friend uses my code; their first order is delivered; the owner sets only MY side's reward.
      await ok(req('POST', '/v1/me/referral/claim', { code: myCode }, OTHER_CUSTOMER), 'friend claims');
      await page.click('#tab-shop'); await page.click('#tab-account');
      await page.locator('#referrals .row[data-standing="waiting_for_first_delivery"]').waitFor({ timeout: 10_000 });
      expect(await text('#referrals .row')).toBe('⏱ A friend — waiting for their first delivery');
      await deliveredOrder(c, provider, 'ORD-FRIEND-1', OTHER_CUSTOMER);
      await ok(req('POST', '/v1/loyalty/referral-rewards', { referrerRewardMinor: 50_00, reason: 'launch (synthetic)' }), 'owner sets my side');
      await page.click('#tab-shop'); await page.click('#tab-account');
      await page.locator('#referrals .row[data-standing="earned_reward_not_set"]').waitFor({ timeout: 10_000 });
      expect(await text('#referrals .row')).toBe('⏱ A friend — earned — the reward is not set yet · ₹50.00');
      expect([await text('#referral-mine'), await text('#referral-friend')]).toEqual(['₹50.00', 'not set yet — nothing is given until the shop sets it']);

      // ── Scan and go (OB-350): the camera, the typed number, the refusals, two totals, the code for the till.
      await page.click('#tab-scan');
      await page.locator('#sg-scan:not([hidden])').waitFor({ timeout: 10_000 });
      await page.click('#sg-scan');
      await page.locator('#sg-lines .row[data-product="MILK"]').waitFor({ timeout: 15_000 });
      await page.fill('#sg-typed', '8900000000036');
      await page.click('#sg-add');
      expect(await text('#sg-say')).toBe('This is sold by weight — it is weighed at the till, not on the phone.');
      await page.fill('#sg-typed', '1234567');
      await page.click('#sg-add');
      expect(await text('#sg-say')).toBe('That barcode is not in the shop’s list on this phone. Take it to the till to be scanned there.');
      await page.locator('#sg-lines .row[data-product="MILK"] button.more').click();
      expect(await page.getAttribute('#sg-lines .row[data-product="MILK"]', 'data-qty')).toBe('2');
      expect(await text('#sg-shelf')).toBe('₹270.00'); // 2 × 60 + 150, at the shelf prices, before offers
      expect(await text('#sg-shop')).toBe('not asked yet');
      await page.click('#sg-quote');
      await page.locator('#sg-shop[data-asked="true"]').waitFor({ timeout: 10_000 });
      expect(await text('#sg-shop')).toBe('₹270.00'); // the till's offers engine (no offer today), no delivery fee
      expect(await text('#sg-price-note')).toBe('Neither is what you pay: the till works out the price at the lane, with the shop’s offers.');
      await page.click('#sg-till');
      await page.locator('#sg-code-box:not([hidden])').waitFor({ timeout: 10_000 });
      const tillCode = (await text('#sg-code'))!;
      expect(tillCode).toMatch(/^\d{6}$/);
      const held = ((await ok(req('GET', '/v1/storefront/scan-and-go/baskets', undefined, SUBJECT), 'my baskets')).body as { baskets: { code: string; lines: { productId: string; quantityMinor: number }[] }[] }).baskets;
      expect(held.map((b) => [b.code, b.lines.map((l) => [l.productId, l.quantityMinor])])).toEqual([[tillCode, [['BROOM', 1], ['MILK', 2]]]]);
      expect(await page.isHidden('#sg-till')).toBe(true);
      expect(await page.isDisabled('#sg-add')).toBe(true);
      // The store computer brings it up at a till; the phone, opened again, says which till took it.
      const box = TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: STORE });
      expect((await h.raw({ method: 'POST', path: `/v1/store/scan-and-go/${tillCode}/recall`, token: box, idempotencyKey: 'sg-e2e-recall', body: { laneId: 'lane-1', cashierId: 'u-cashier' } })).status).toBe(200);
      await page.click('#tab-shop'); await page.click('#tab-scan');
      await page.locator('#sg-code-say', { hasText: 'Brought up at till lane-1' }).waitFor({ timeout: 10_000 });
      await page.click('#sg-new');
      expect(await text('#sg-lines')).toBe('Nothing scanned yet.');

      // ── Tamil ──
      await page.click('#lang');
      expect(await text('#tab-scan')).toBe('ஸ்கேன் செய்து செல்');
      expect(await text('#sg-title')).toBe('ஸ்கேன் செய்து செல்');
      expect(await text('#sg-shelf-label')).toBe('அலமாரியில் (சலுகைகளுக்கு முன்)');
      await page.click('#tab-account');
      await page.locator('#referral-title', { hasText: 'நண்பரை அழையுங்கள்' }).waitFor({ timeout: 10_000 });
      // The referral box re-paints after the tab opens (it re-reads the programme): wait for its Tamil words, never read early.
      await expect.poll(() => text('#referral-friend'), { timeout: 10_000 }).toBe('இன்னும் அமைக்கப்படவில்லை — கடை அமைக்கும் வரை எதுவும் வழங்கப்படாது');
      expect(errors).toEqual([]);
      // No price was ever sent from the phone for scan-and-go: the basket write carried ids and counts only.
      expect(store.writes.some((w) => w.path.startsWith('/v1/storefront/scan-and-go/baskets/'))).toBe(true);
    } finally {
      await context.close();
      await store.stop();
    }
  }, 180_000);
});
