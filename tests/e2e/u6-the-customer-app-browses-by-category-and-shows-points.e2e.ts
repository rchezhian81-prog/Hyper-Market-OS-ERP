import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import { serveShell } from './lib/device-screens';
import { Tally } from './lib/tally';

/**
 * **U6 · M20-FR-01 · M17 · §27 "Customer: Category" / "Customer: Loyalty" (7 Nov 2026) — the customer app, in real Chromium
 * on a 360px phone: browse by CATEGORY from the catalogue the phone holds (one tap to a category, one more to add — no
 * network), and "My points" on the account view that says to sign in when signed out.** Chips at 48px, pressed state in
 * words, a parent counting its children, the one results list; both languages audited (WCAG 2.2 AA, NFR-07).
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const PHONE = { viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, hasTouch: true };
const P = (productId: string, name: string, categoryId: string, price: number) => ({ productId, name, categoryId, unitPriceMinor: price, uom: 'each', barcodes: [], status: 'active', availableMinor: 5, availabilityAgeMinutes: 1 });
const SHOP = {
  tenantId: 'ab000000-0000-4000-8000-000000000050', customerRef: 'guest', packVersion: 3, locationId: 'L1',
  products: [P('MILK', 'Aavin Milk 1L', 'dairy', 60_00), P('CURD', 'Curd 500g', 'dairy', 35_00), P('DAL', 'Toor dal 1kg', 'grocery', 160_00), P('BROOM', 'Broom', 'household', 90_00)],
  categories: [
    { categoryId: 'food', name: 'Food', nameTa: 'உணவு', parentId: null },
    { categoryId: 'dairy', name: 'Dairy', nameTa: 'பால் பொருட்கள்', parentId: 'food' },
    { categoryId: 'grocery', name: 'Grocery', parentId: 'food' },
    { categoryId: 'household', name: 'Household', parentId: null },
  ],
  slots: [], storeLocation: { lat: 11.0168, lon: 76.9558 }, policy: { radiusMetres: 10_000, deliveryFeeMinor: 40_00 }, deliveryFeeMinor: 40_00,
  consentPurposes: [{ purpose: 'order_updates', channel: 'sms', required: true }], consent: { grants: [] },
};

describe.skipIf(!existsSync(CHROMIUM))('the customer app browses by category and shows my points', () => {
  let browser: Browser;
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'customer-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  async function open(): Promise<Page> {
    const srv = await serveShell('customer-app', { shopData: SHOP });
    stops.push(srv.stop);
    const context = await browser.newContext(PHONE);
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(id: string): { hidden: boolean } | null } }).document.getElementById('sample')?.hidden === true, undefined, { timeout: 10_000 });
    return page;
  }

  it('category chips counted (a parent counts its children); one tap lists the category, one more adds; Show everything; search clears it; Tamil names', async () => {
    const page = await open();
    const chips = page.locator('#browse .cat');
    expect(await chips.allTextContents()).toEqual(['Food · 3', 'Dairy · 2', 'Grocery · 1', 'Household · 1']);
    const taps = new Tally(page);
    await taps.tap('#browse .cat[data-category="dairy"]');
    await page.waitForSelector('#results-heading:not([hidden])');
    expect(await page.textContent('#results-heading')).toBe('In: Dairy · 2 item(s)');
    expect(await page.locator('#results .row .name').allTextContents()).toEqual(['Aavin Milk 1L', 'Curd 500g']);
    expect(await page.getAttribute('#browse .cat[data-category="dairy"]', 'aria-pressed')).toBe('true');
    await taps.tap('button[aria-label="Add Curd 500g"]');
    expect(taps.reset(), 'browse a category and add an item').toBeLessThanOrEqual(2);
    expect(await page.textContent('#results .row:nth-child(2) .n')).toBe('1');
    expect(await auditPage(page, { expectLang: 'en' })).toEqual([]);

    // A parent reaches its children; Show everything clears; a typed search clears the category.
    await page.click('#browse .cat[data-category="food"]');
    expect(await page.textContent('#results-heading')).toBe('In: Food · 3 item(s)');
    await page.click('#browse-all');
    expect(await page.isHidden('#results-heading')).toBe(true);
    await page.click('#browse .cat[data-category="household"]');
    await page.fill('#search', 'dal');
    await page.waitForSelector('#results .row');
    expect(await page.isHidden('#results-heading')).toBe(true);
    expect(await page.getAttribute('#browse .cat[data-category="household"]', 'aria-pressed')).toBe('false');

    await page.click('#lang');
    expect(await page.textContent('#browse-title')).toBe('வகை வாரியாகப் பார்');
    expect(await chips.nth(0).textContent()).toBe('உணவு · 3');
    expect(await chips.nth(1).textContent()).toBe('பால் பொருட்கள் · 2');
    expect(await chips.nth(2).textContent()).toBe('Grocery · 1');
    expect(await auditPage(page, { expectLang: 'ta' })).toEqual([]);
  });

  it('My points on the account view: signed out it says to sign in — never a figure it does not hold', async () => {
    const page = await open();
    await page.click('#tab-account');
    await page.waitForSelector('#view-account:not([hidden])');
    expect(await page.textContent('#points-title')).toBe('My points');
    expect(await page.textContent('#points-card')).toBe('Sign in to see your points.');
    expect(await page.isHidden('#points-spend')).toBe(true);
    // U7: the account view's last two small targets reach 44px — the occasion tick box sits in its 44px label, the
    // referral code field is a text field like the others. No exception left in the audit.
    expect((await page.locator('#referral-claim-code').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await page.locator('label:has(#occasion-yes)').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await auditPage(page, { expectLang: 'en' })).toEqual([]);
    await page.click('#lang');
    expect(await page.textContent('#points-title')).toBe('என் புள்ளிகள்');
    expect(await page.textContent('#points-card')).toBe('உங்கள் புள்ளிகளைப் பார்க்க உள்நுழையுங்கள்.');
  });
});
