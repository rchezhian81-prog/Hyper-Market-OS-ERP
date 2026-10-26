import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { approveSupplierWith, SUPPLIER_MAKER, SUPPLIER_CHECKER } from '../support/approved-supplier';

/**
 * FG-4 · D03-FR-04 — supplier-managed stock (VMI) on the Supplier submissions page, in a real browser, on the PRODUCTION
 * API over real PostgreSQL. The buyer set rice at br-1 (min 20, max 50) for sup-v; the supplier proposed 30. On the page:
 * the item shows on hand, on order and the room; "Accept" without a price is refused before anything is sent; with the
 * buyer's price it becomes a purchase-order PROPOSAL (not issued); the room then counts it as on order; Tamil twin; every
 * button its icon. Needs DATABASE_URL and Chromium; else it SKIPS. Text is read only after the expected words appear.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['vmi', 'desk', 'e2e', 'key'].join('-').padEnd(48, '0');

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the VMI desk (D03-FR-04) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/supplier-submissions', html: 'supplier-submissions.html', dataGlobal: 'supplierSubmissionsData' },
      seed: async (cloud) => {
        const post = (path: string, body: unknown, key: string, userId = OWNER) => ok(cloud.request({ method: 'POST', path, userId, idempotencyKey: key, body }), key);
        await cloud.grant(SUPPLIER_MAKER, 'store_manager');
        await cloud.grant(SUPPLIER_CHECKER, 'accountant');
        await cloud.grant('u-sup', 'supplier');
        await approveSupplierWith((method, path, userId, body, idempotencyKey) => cloud.request({ method, path, userId, idempotencyKey, body }), 'sup-v');
        await post('/v1/catalogue/products/p-rice/publish', { product: { sku: 'p-rice', name: 'Rice 5kg', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active' }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }, 'publish');
        await post('/v1/inventory/movements', { movementId: 'rice-in', productId: 'p-rice', locationId: 'br-1', kind: 'received', quantityMinor: 15, uom: 'ea', occurredAt: new Date().toISOString(), enteredBy: OWNER, unitCostMinor: 4_000 }, 'rice-in');
        await post('/v1/supplier-portal/partners/sup-v', { grants: ['view_orders'], documents: [], requiredDocuments: [], logins: ['u-sup'] }, 'cfg', SUPPLIER_MAKER);
        await post('/v1/purchase/vmi/limits/sup-v/br-1/p-rice', { minQty: 20, maxQty: 50, uom: 'ea' }, 'limit', SUPPLIER_MAKER);
        await post('/v1/supplier-portal/me/vmi/proposals/vp-1', { storeId: 'br-1', lines: [{ productId: 'p-rice', quantity: 30 }], note: 'weekly top-up (synthetic)' }, 'propose', 'u-sup');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const waitText = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
    const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
    return (node?.textContent ?? '').includes(want!);
  }, [selector, text], { timeout: 15_000 });

  it('the item and its room; a price is the buyer\'s; accepted it is an order proposal; Tamil twin', async () => {
    const context = await browser.newContext();
    const errors: string[] = [];
    try {
      await shop.signIn(context, OWNER);
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${shop.base}/supplier-submissions`, { waitUntil: 'load' });
      await page.locator('#vmi:not([hidden])').waitFor({ timeout: 15_000 });
      await page.locator('#vmi-q-rows li[data-proposal="vp-1"]').waitFor({ timeout: 15_000 });
      await waitText(page, '#vmi-q-rows li[data-proposal="vp-1"] strong', '30 × p-rice');
      expect(await page.locator('#vmi-show svg').count()).toBe(1);

      await page.fill('#vmi-supplier', 'sup-v');
      await page.click('#vmi-show');
      await waitText(page, '#vmi-items', 'room 35');
      expect(await page.textContent('#vmi-items li[data-product="p-rice"]')).toMatch(/on hand 15 · on order 0 · room 35 · below the minimum/);

      // No price → refused before anything is sent.
      await page.fill('#vmi-q-rows li[data-proposal="vp-1"] input.reason', 'below the minimum (synthetic)');
      await page.click('#vmi-q-rows li[data-proposal="vp-1"] button[data-act="vmi-accept"]');
      await waitText(page, '#vmi-q-status', 'Type a unit cost for every item');
      await page.fill('#vmi-q-rows li[data-proposal="vp-1"] input[data-cost="p-rice"]', '40');
      await page.fill('#vmi-q-rows li[data-proposal="vp-1"] input.po', 'po-vmi-e2e');
      await page.click('#vmi-q-rows li[data-proposal="vp-1"] button[data-act="vmi-accept"]');
      await waitText(page, '#vmi-q-rows', 'No supplier top-up is waiting');
      await waitText(page, '#vmi-items', 'room 5');

      const po = (await shop.cloud().request({ method: 'GET', path: '/v1/purchase/orders/po-vmi-e2e', userId: OWNER })).body as { order: { status: string; supplierId: string; totalMinor: number } };
      expect(po.order).toMatchObject({ status: 'proposed', supplierId: 'sup-v', totalMinor: 120_000 });

      await page.click('#lang');
      await waitText(page, '#vmi-h', 'சப்ளையர் நிர்வகிக்கும் சரக்கு');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 180_000);
});
