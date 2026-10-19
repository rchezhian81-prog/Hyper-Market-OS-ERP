import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { approveSupplierWith, SUPPLIER_MAKER, SUPPLIER_CHECKER } from '../support/approved-supplier';

/**
 * D-10 (R4, OB-227) — the Supplier scorecard page, in a real browser, on the PRODUCTION API over real PostgreSQL. A supplier
 * gets an order, a short delivery and an invoice billed above the agreed price on one line; the page shows the five figures
 * built from those registers (fill rate 75.0%, invoice accuracy 50.0%, rejection rate 0.0%, on time in full and lead-time
 * reliability), says where they came from, and a supplier with no delivery reads "Not rated — no delivery in the period"
 * on every figure, never a number. Nothing on the page is typed in, and opening it writes nothing.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['supplier', 'scorecard', 'e2e', 'key'].join('-').padEnd(48, '0');

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Supplier scorecard page (D-10) on the production API, in a real browser', () => {
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
        await approveSupplierWith(call, 's-idle');
        const post = (path: string, body: unknown, key: string, userId = OWNER) => ok(cloud.request({ method: 'POST', path, userId, idempotencyKey: key, body }), key);
        await post('/v1/purchase/contracts/c-rice', { supplierId: 's-rice', startsOn: '2026-01-01', endsOn: '2030-12-31', agreedLeadTimeDays: 7 }, 'contract', 'u-buyer');
        for (const [poId, supplierId] of [['po-rice', 's-rice'], ['po-idle', 's-idle']] as const) {
          await post(`/v1/purchase/orders/${poId}`, { supplierId, deliverToLocationId: 'br-1', lines: [{ productId: 'p-rice', orderedQty: 10, unitCost: { minor: 500, currency: 'INR' } }, { productId: 'p-dal', orderedQty: 10, unitCost: { minor: 1000, currency: 'INR' } }] }, `${poId}-propose`, 'u-buyer');
          await post(`/v1/purchase/orders/${poId}/approval`, { reason: 'synthetic order' }, `${poId}-issue`);
        }
        // 10 rice and only 5 dal arrive; the invoice bills the dal above the agreed ₹10.00.
        await post('/v1/inventory/goods-receipt/grn-rice', {
          warehouseId: 'br-1', receivedOnDate: new Date().toISOString().slice(0, 10), currency: 'INR', poId: 'po-rice',
          lines: [
            { lineId: 'L1', productId: 'p-rice', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: { minor: 500, currency: 'INR' }, condition: 'good' },
            { lineId: 'L2', productId: 'p-dal', orderedMinor: 10, countedMinor: 5, uom: 'ea', unitCost: { minor: 1000, currency: 'INR' }, condition: 'good' },
          ],
        }, 'grn-rice');
        const lines = [{ productId: 'p-rice', quantity: 10, unitPriceMinor: 500, lineTotalMinor: 5000 }, { productId: 'p-dal', quantity: 5, unitPriceMinor: 1100, lineTotalMinor: 5500 }];
        await post('/v1/purchase/invoices/inv-rice/capture', { supplierId: 's-rice', poId: 'po-rice', declaredTotalMinor: 10_500, lines }, 'inv-capture', 'u-buyer');
        await post('/v1/purchase/invoices/inv-rice/match', {}, 'inv-match');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await shop?.stop();
  });

  it('five figures built from the registers; a supplier with no delivery is "Not rated", never a number; Tamil twin', async () => {
    const context = await browser.newContext();
    const errors: string[] = [];
    try {
      await shop.signIn(context, OWNER);
      const page = await context.newPage();
      page.on('pageerror', (e) => { errors.push(String(e)); });
      await page.goto(`${shop.base}/supplier-scorecard`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { supplierScorecard?: unknown }).supplierScorecard !== undefined);
      expect(await page.isHidden('#card-section')).toBe(true); // nothing shown, nothing written, on open

      // Nothing named → refused before anything is sent.
      await page.click('#show');
      await expect.poll(() => page.textContent('#page-status')).toMatch(/Type the supplier code first/);

      await page.fill('#supplier', 's-rice');
      await page.click('#show');
      await page.locator('#card-section:not([hidden])').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#figures .panel[data-figure="fillRate"] .v')).toBe('75.0%');
      expect(await page.textContent('#figures .panel[data-figure="invoiceAccuracy"] .v')).toBe('50.0%');
      expect(await page.textContent('#figures .panel[data-figure="rejectionRate"] .v')).toBe('0.0%');
      expect(await page.getAttribute('#figures .panel[data-figure="onTimeInFull"]', 'data-rated')).toBe('true');
      expect(await page.getAttribute('#figures .panel[data-figure="leadTimeReliability"]', 'data-rated')).toBe('true');
      expect(await page.textContent('#lead-time')).toMatch(/Agreed lead time: 7 days \(c-rice\)/);
      expect(await page.textContent('#sources')).toMatch(/purchase orders, goods receipts and matched invoices/);
      expect(await page.textContent('#summary')).toMatch(/1 of 2 invoice line\(s\) billed above the agreed price/);

      await page.fill('#supplier', 's-idle');
      await page.click('#show');
      await expect.poll(() => page.getAttribute('#figures .panel[data-figure="fillRate"]', 'data-rated')).toBe('false');
      for (const f of ['fillRate', 'onTimeInFull', 'leadTimeReliability', 'invoiceAccuracy', 'rejectionRate']) {
        expect(await page.textContent(`#figures .panel[data-figure="${f}"] .v`)).toBe('Not rated — no delivery in the period');
      }
      expect(await page.textContent('#nothing')).toMatch(/po-idle/);

      await page.click('#lang');
      expect(await page.textContent('#page-h')).toBe('விநியோகஸ்தர் மதிப்பெண் அட்டை');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 180_000);
});
