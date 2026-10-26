import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { approveSupplierWith, SUPPLIER_MAKER, SUPPLIER_CHECKER } from '../support/approved-supplier';

/**
 * FG-4 · A12 (1) · OB-386 — a free sample, in a real browser, on the PRODUCTION API over real PostgreSQL. A store manager
 * gives two rice as a tasting on the write-off capture screen; the screen shows head office's sentence (CGST ₹2.50 + SGST
 * ₹2.50 given back, in this month's return). The accountant opens the Input tax credit page for the month, sees it "not
 * checked yet", and agrees it with a note. Tamil twin; icons beside the words. Needs DATABASE_URL and Chromium; else it
 * SKIPS. Text is read only after the expected words appear.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['free', 'sample', 'e2e', 'key'].join('-').padEnd(48, '0');
const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('a free sample and its GST give-back (OB-386), in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/write-off-capture', html: 'write-off-capture.html', dataGlobal: 'writeOffCaptureData' },
      alsoPages: [{ path: '/itc-review', html: 'itc-review.html', dataGlobal: 'itcReviewData' }],
      seed: async (cloud) => {
        const post = (path: string, body: unknown, key: string, userId = OWNER) => ok(cloud.request({ method: 'POST', path, userId, idempotencyKey: key, body }), key);
        await cloud.grant(SUPPLIER_MAKER, 'store_manager');
        await cloud.grant(SUPPLIER_CHECKER, 'accountant');
        await cloud.grant('u-recv', 'store_manager');
        await cloud.grant('u-acct', 'accountant');
        await approveSupplierWith((method, path, userId, body, idempotencyKey) => cloud.request({ method, path, userId, idempotencyKey, body }), 'sup-r');
        await post('/v1/purchase/orders/po-r', { supplierId: 'sup-r', deliverToLocationId: 'br-1', lines: [{ productId: 'p-rice', orderedQty: 10, unitCost: { minor: 5_000, currency: 'INR' } }] }, 'po', SUPPLIER_MAKER);
        await post('/v1/purchase/orders/po-r/approval', { reason: 'synthetic order' }, 'po-issue');
        await post('/v1/inventory/goods-receipt/grn-r', {
          warehouseId: 'br-1', receivedOnDate: new Date().toISOString().slice(0, 10), currency: 'INR', poId: 'po-r',
          lines: [{ lineId: 'L1', productId: 'p-rice', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: { minor: 5_000, currency: 'INR' }, condition: 'good' }],
        }, 'grn', 'u-recv');
        await post('/v1/purchase/invoices/inv-r/capture', { supplierId: 'sup-r', poId: 'po-r', declaredTotalMinor: 52_500, lines: [{ productId: 'p-rice', quantity: 10, unitPriceMinor: 5_000, lineTotalMinor: 50_000, cgstMinor: 1_250, sgstMinor: 1_250 }] }, 'bill', SUPPLIER_MAKER);
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const waitText = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
    const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
    return (node?.textContent ?? '').includes(want!);
  }, [selector, text], { timeout: 15_000 });

  it('given on the write-off screen; checked by the accountant on the ITC page', async () => {
    const errors: string[] = [];
    const staff = await browser.newContext();
    try {
      await shop.signIn(staff, 'u-recv');
      const page = await staff.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${shop.base}/write-off-capture`, { waitUntil: 'load' });
      await page.locator('#fs:not([hidden])').waitFor({ timeout: 15_000 });
      expect(await page.locator('#fs-save svg').count()).toBe(1);
      await page.fill('#fs-product', 'p-rice'); await page.fill('#fs-location', 'br-1'); await page.fill('#fs-qty', '2'); await page.fill('#fs-note', 'tasting at the counter (synthetic)');
      await page.click('#fs-save');
      await waitText(page, '#fs-result', 'Recorded');
      expect(await page.textContent('#fs-result')).toMatch(/CGST ₹2\.50, SGST ₹2\.50/);
    } finally { await staff.close(); }

    const acct = await browser.newContext();
    try {
      await shop.signIn(acct, 'u-acct');
      const page = await acct.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${shop.base}/itc-review?period=${month}`, { waitUntil: 'load' });
      await page.locator('#fs-rows li').first().waitFor({ timeout: 15_000 });
      await waitText(page, '#fs-rows', 'Not checked yet');
      await page.fill('#fs-rows li input.check-note', 'rate matches bill inv-r (synthetic)');
      await page.click('#fs-rows li button[data-act="agreed"]');
      await waitText(page, '#fs-rows', 'Agreed');
      await page.click('#lang');
      await waitText(page, '#fs-heading', 'இலவச மாதிரிகள்');
      expect(errors).toEqual([]);
    } finally { await acct.close(); }
  }, 180_000);
});
