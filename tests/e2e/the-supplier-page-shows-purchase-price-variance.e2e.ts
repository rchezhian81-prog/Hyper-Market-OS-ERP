import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { approveSupplierWith, SUPPLIER_MAKER, SUPPLIER_CHECKER } from '../support/approved-supplier';

/**
 * FG-4 · D03-FR-05 — the purchase-price variance on the Supplier scorecard page, in a real browser, on the PRODUCTION API
 * over real PostgreSQL. Rice was ordered at ₹5.00 and arrived at ₹5.50; dal arrived at its order price. The page shows the
 * variance per product and per receipt (+₹5.00 on rice), opens the receipt lines behind a product (drill-through), says
 * "no contract price on file" where there is none (never a zero), and has a Tamil twin. Opening it writes nothing.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS. Text is read only after the expected words
 * appear (never in the same tick as the click).
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['supplier', 'ppv', 'e2e', 'key'].join('-').padEnd(48, '0');

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the purchase-price variance on the Supplier scorecard page (D03-FR-05), in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/supplier-scorecard', html: 'supplier-scorecard.html', dataGlobal: 'supplierScorecardData' },
      seed: async (cloud) => {
        await cloud.grant(SUPPLIER_MAKER, 'store_manager');
        await cloud.grant(SUPPLIER_CHECKER, 'accountant');
        await cloud.grant('u-buyer', 'store_manager');
        const call = (method: 'POST', path: string, userId: string, body: unknown, idempotencyKey: string) => cloud.request({ method, path, userId, idempotencyKey, body });
        await approveSupplierWith(call, 's-rice');
        const post = (path: string, body: unknown, key: string, userId = OWNER) => ok(cloud.request({ method: 'POST', path, userId, idempotencyKey: key, body }), key);
        await post('/v1/purchase/orders/po-rice', { supplierId: 's-rice', deliverToLocationId: 'br-1', lines: [{ productId: 'p-rice', orderedQty: 10, unitCost: { minor: 500, currency: 'INR' } }, { productId: 'p-dal', orderedQty: 10, unitCost: { minor: 1000, currency: 'INR' } }] }, 'po-propose', 'u-buyer');
        await post('/v1/purchase/orders/po-rice/approval', { reason: 'synthetic order' }, 'po-issue');
        await post('/v1/inventory/goods-receipt/grn-rice', {
          warehouseId: 'br-1', receivedOnDate: new Date().toISOString().slice(0, 10), currency: 'INR', poId: 'po-rice',
          lines: [
            { lineId: 'L1', productId: 'p-rice', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: { minor: 550, currency: 'INR' }, condition: 'good' },
            { lineId: 'L2', productId: 'p-dal', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: { minor: 1000, currency: 'INR' }, condition: 'good' },
          ],
        }, 'grn-rice');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await shop?.stop();
  });

  it('per product and per receipt, the lines behind a row, "no contract price on file", and a Tamil twin', async () => {
    const context = await browser.newContext();
    const errors: string[] = [];
    try {
      await shop.signIn(context, OWNER);
      const page = await context.newPage();
      page.on('pageerror', (e) => { errors.push(String(e)); });
      await page.goto(`${shop.base}/supplier-scorecard`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { supplierScorecard?: unknown }).supplierScorecard !== undefined);
      expect(await page.isHidden('#ppv-rollups')).toBe(true); // nothing shown, nothing written, on open
      expect(await page.locator('#ppv-show svg').count()).toBe(1); // an icon beside the words

      // Nothing named → refused before anything is sent.
      await page.click('#ppv-show');
      await expect.poll(() => page.textContent('#ppv-status')).toMatch(/Type the supplier code first/);

      await page.fill('#supplier', 's-rice');
      await page.click('#ppv-show');
      await page.locator('#ppv-products tr[data-key="p-rice"]').waitFor({ timeout: 15_000 });
      await expect.poll(() => page.textContent('#ppv-products tr[data-key="p-rice"]')).toMatch(/\+₹5\.00/);
      expect(await page.textContent('#ppv-products tr[data-key="p-rice"]')).toMatch(/no contract price on file/);
      expect(await page.textContent('#ppv-products tr[data-key="p-dal"]')).toMatch(/₹0\.00/);
      expect(await page.textContent('#ppv-receipts tr[data-key="grn-rice"]')).toMatch(/\+₹5\.00/);
      expect(await page.textContent('#ppv-total')).toMatch(/Against the order \+₹5\.00/);

      // Drill-through: the receipt lines behind the rice row.
      await page.click('#ppv-products button[data-key="p-rice"]');
      await page.locator('#ppv-drill:not([hidden])').waitFor({ timeout: 15_000 });
      await expect.poll(() => page.locator('#ppv-lines tbody tr').count()).toBe(1);
      expect(await page.textContent('#ppv-lines tbody tr')).toMatch(/₹5\.50/);
      expect(await page.textContent('#ppv-lines tbody tr')).toMatch(/₹5\.00/);
      await page.click('#ppv-back');
      await page.locator('#ppv-rollups:not([hidden])').waitFor({ timeout: 15_000 });

      await page.click('#lang');
      await expect.poll(() => page.textContent('#ppv-h')).toMatch(/கொள்முதல் விலை மாறுபாடு/);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 180_000);
});
