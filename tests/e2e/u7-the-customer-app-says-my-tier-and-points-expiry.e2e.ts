import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright-core';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { seedOnlineShop, listShopOnline, callsFor, CUSTOMER, MANAGER, STORE, type ShopCalls } from '../support/online-shop';
import { startCustomerShop, type CustomerShop } from './lib/customer-shop';
import { auditPage } from './lib/a11y-audit';

/**
 * **U7 (OB-726) · M17-FR-01 "tiers, expiry" · §27 "Customer: Loyalty" — the customer app, in real Chromium on the real API
 * (in memory): a signed-in member's points card says their tier and when points expire.** Before the owner sets either,
 * each line says NOT SET (never a made-up ladder, never "no expiry"); once the owner sets a ladder and an expiry rule, the
 * card says "No tier yet", what reaching Silver needs, and how long points last. Both languages; audited.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const PHONE = '+919876500013';
const MOBILE = '9876500013';

describe.skipIf(!existsSync(CHROMIUM))('the customer app says my tier and when my points expire', () => {
  let browser: Browser;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'customer-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });

  it('not set is said as not set; once the owner sets tiers and expiry, the card says my tier, the next one and how long points last — EN and TA', async () => {
    const h: ApiHarness = apiHarness();
    const T = randomUUID();
    const c: ShopCalls = callsFor(() => h, T);
    await seedOnlineShop(h, T, c);
    await h.enableFeature(T, 'loyalty');
    await listShopOnline(c);
    await c.ok(c.req('POST', '/v1/loyalty/members', { mobile: MOBILE, consent: true, verifiedHow: 'seen_on_phone' }, MANAGER), 'enrol');
    await c.ok(c.req('POST', '/v1/loyalty/members/app-link', { mobile: MOBILE, appCustomerRef: CUSTOMER, verifiedHow: 'seen_on_phone' }, MANAGER), 'link');
    const shopData = async () => ({
      tenantId: T, customerRef: 'guest', packVersion: 1, locationId: STORE, slots: [],
      products: [{ productId: 'MILK', name: 'Aavin Milk 1L', categoryId: 'dairy', unitPriceMinor: 60_00, uom: 'each', barcodes: [], status: 'active', availableMinor: 5, availabilityAgeMinutes: 1 }],
      storeLocation: { lat: 11.0168, lon: 76.9558 }, policy: { radiusMetres: 10_000, deliveryFeeMinor: 40_00 }, deliveryFeeMinor: 40_00,
    });
    const store: CustomerShop = await startCustomerShop({ h, tenantId: T, subject: CUSTOMER, shopData });
    const context = await browser.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true });
    const page: Page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const text = (sel: string) => page.locator(sel).textContent();
    const signIn = async (): Promise<void> => {
      await page.click('#tab-basket');
      await page.fill('#si-phone', PHONE);
      await page.click('#si-send');
      await page.waitForSelector('#si-step-code:not([hidden])', { timeout: 10_000 });
      await page.fill('#si-code', store.sms.codeFor(PHONE) ?? '');
      await page.click('#si-verify');
      await page.waitForSelector('#si-step-in:not([hidden])', { timeout: 10_000 });
    };
    try {
      await page.goto(`${store.base}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(i: string): { hidden: boolean } | null } }).document.getElementById('sample')?.hidden === true, undefined, { timeout: 10_000 });
      await page.click('#tab-account');
      expect(await page.isHidden('#points-tier')).toBe(true); // signed out: no tier line, no expiry line
      expect(await page.isHidden('#points-due')).toBe(true);

      await signIn();

      await page.click('#tab-account');
      await page.waitForSelector('#points-tier:not([hidden])', { timeout: 10_000 });
      expect(await text('#points-tier')).toBe('The shop has not set up tiers.');
      expect(await text('#points-due')).toBe('The shop has not set when points expire.');

      await c.ok(c.req('PUT', '/v1/loyalty/programme/tiers', { tiers: [
        { tierId: 'silver', name: 'Silver', nameTa: 'வெள்ளி', minSpend12mMinor: 1_000_00, multiplierBps: 12_500 },
      ], reason: 'the owner set the ladder' }), 'tiers');
      await c.ok(c.req('PUT', '/v1/loyalty/programme/expiry', { months: 12, reason: 'the owner set the expiry' }), 'expiry');

      // A fresh page (signed in again — the sign-in lives in the open page) reads the card again.
      await page.reload({ waitUntil: 'load' });
      await signIn();
      await page.click('#tab-account');
      await page.waitForSelector('#points-tier:not([hidden])', { timeout: 10_000 });
      await expect.poll(() => text('#points-tier')).toBe('No tier yet. Spend ₹1,000.00 more to reach Silver.');
      expect(await text('#points-due')).toBe('No points are due to expire. Points last 12 months.');
      expect(await auditPage(page, { expectLang: 'en' })).toEqual([]);

      await page.click('#lang');
      expect(await text('#points-tier')).toBe('இன்னும் நிலை இல்லை. வெள்ளி நிலையை அடைய இன்னும் ₹1,000.00 வாங்குங்கள்.');
      expect(await text('#points-due')).toBe('காலாவதியாகும் புள்ளிகள் எதுவும் இல்லை. புள்ளிகள் 12 மாதங்கள் நீடிக்கும்.');
      expect(await auditPage(page, { expectLang: 'ta' })).toEqual([]);
      // Reading moved nothing: no write from the app on this journey but the sign-in.
      expect(store.writes.filter((w) => w.path.includes('loyalty'))).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await store.stop();
    }
  });
});
