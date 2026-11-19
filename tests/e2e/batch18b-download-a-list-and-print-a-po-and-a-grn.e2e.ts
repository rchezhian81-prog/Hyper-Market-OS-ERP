import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import type { ExportAudit } from '../../packages/export/src/export';

/**
 * **Batch 18b (owner, 19 Nov 2026 — "the most-needed missing options"), in a real Chromium, on the PRODUCTION API over real
 * PostgreSQL:**
 *
 *   • B1 · M30-FR-02 · P-06 — every list has ONE "Download to Excel": the Customers list downloads exactly the rows the person
 *     sees with their search (a CSV with the UTF-8 byte-order mark, columns in screen order). The owner (who may see personal
 *     data, `export.sensitive`) gets the customer numbers and names; the store manager (who may not) gets `[redacted]` in those
 *     columns — the export engine's own rule. Each download is one record in head office's export ledger, in the person's name.
 *   • P1 · M31-FR-02 · WF-03 — Buying → Open orders: "Print / save as PDF" on an issued order opens the A4 page: the shop and
 *     its GSTIN, the PO number (PO/YY-YY/NNNNN), the date, the supplier and its GSTIN, the items with quantity, rate and GST
 *     rate, the total and the signature lines; print media shows that page alone. Opened again with head office out of
 *     reach, it prints from the copy kept on this computer and says so.
 *   • R1 · M31-FR-02 — Goods receipt: "Print GRN" opens the receipt's A4 page with its GRN number and the order it was against.
 *
 * Screenshots (deviceScaleFactor 1) go to SRE_SCREENSHOT_DIR when it is set. Synthetic data only.
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const SHOTS = process.env['SRE_SCREENSHOT_DIR'];
const KEY = ['batch18b', 'print', 'download', 'key'].join('-').padEnd(48, '0');
const SHOP_GSTIN = '33AABCS1429B1Z1';
const SUPPLIER_GSTIN = '33ZZZZZ9999Z1ZF';
const ACCT = 'u-acct-18b'; const BUYER = 'u-buyer-18b'; const RECEIVER = 'u-recv-18b';

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('batch 18b — download a list, print a purchase order and a GRN', () => {
  let browser: Browser;
  let shop: InboxShop;
  let poNumber = '';

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/customers', html: 'customers.html', dataGlobal: 'customersData' },
      alsoPages: [
        { path: '/buying', html: 'buying.html', dataGlobal: 'buyingData', extraData: async (api) => ({ buyerId: ((await api('/v1/identity/me')) as { userId: string }).userId }) },
        { path: '/goods-receipt', html: 'goods-receipt.html', dataGlobal: 'goodsReceiptData' },
      ],
      seed: async (c) => {
        const as = (userId: string, path: string, body: unknown, key: string, branchId?: string) => ok(c.request({ method: 'POST', path, userId, body, idempotencyKey: key, ...(branchId === undefined ? {} : { branchId }) }), key);
        await c.grant(ACCT, 'accountant', undefined, 'all');
        await c.grant(BUYER, 'store_manager', undefined, 'all');
        await c.grant(RECEIVER, 'store_manager', undefined, 'all');
        // The shop's identity: its company, its GST registration, and br-1 under it with that GSTIN and its address.
        await as(OWNER, '/v1/org/nodes/C-18B', { kind: 'company', name: 'SRE Hyper Market Private Limited' }, 'org-c');
        await as(OWNER, `/v1/org/gst-registrations/${SHOP_GSTIN}`, { companyId: 'C-18B', legalName: 'SRE Hyper Market Private Limited' }, 'gst');
        await as(OWNER, '/v1/org/nodes/br-1', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C-18B', companyId: 'C-18B', gstin: SHOP_GSTIN, placeOfBusiness: '12 Main Road, Tiruppur 641601, Tamil Nadu' }, 'org-br1');
        await as(BUYER, '/v1/purchase/suppliers/sup-kav', { name: 'Kaveri Traders', gstin: SUPPLIER_GSTIN }, 'sup');
        await as(ACCT, '/v1/purchase/suppliers/sup-kav/approval', { reason: 'documents checked' }, 'sup-ok');
        await as(OWNER, '/v1/catalogue/tax-classes/1006/rates/2017-07-01', { rateBps: 500 }, 'tax');
        for (const [id, name, uom] of [['RICE', 'Ponni rice', 'kg'], ['SOAP', 'Bath soap 100g', 'ea']] as const) {
          await as(OWNER, `/v1/catalogue/products/${id}/publish`, { product: { sku: `SKU-${id}`, name, baseUom: uom, primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active' }, categories: [{ categoryId: 'grocery', name: 'grocery', parentId: null }] }, `pub-${id}`);
        }
        await as(OWNER, '/v1/inventory/receipt-policy', { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 }, 'pol');
        // An order: 25 kg of rice at ₹60 a kg and 12 soaps at ₹40, issued by the owner; then 12 soaps received against it.
        await as(BUYER, '/v1/purchase/orders/po-18b', { supplierId: 'sup-kav', deliverToLocationId: 'br-1', lines: [
          { productId: 'RICE', orderedQty: 25_000, uom: 'kg', unitCost: { minor: 6_000, currency: 'INR' } },
          { productId: 'SOAP', orderedQty: 12, unitCost: { minor: 4_000, currency: 'INR' } },
        ] }, 'po', 'br-1');
        await as(OWNER, '/v1/purchase/orders/po-18b/approval', { reason: 'weekly order' }, 'po-ok');
        await as(RECEIVER, '/v1/inventory/goods-receipt/grn-18b', {
          warehouseId: 'br-1', receivedOnDate: '2026-11-19', currency: 'INR', poId: 'po-18b',
          lines: [{ lineId: 'L1', productId: 'SOAP', orderedMinor: 12, countedMinor: 12, uom: 'ea', unitCost: { minor: 4_000, currency: 'INR' }, condition: 'good' }],
        }, 'grn');
        // Three customers with a bill each (synthetic member codes and names).
        let n = 0;
        for (const m of ['M-anu', 'M-bala', 'M-chitra']) {
          n += 1;
          await as(OWNER, '/v1/sales', {
            saleId: `S-${n}`, receiptNumber: `R-${n}`, laneId: 'lane-1', locationId: 'br-1', cashierId: OWNER, tradingDay: '2026-11-18', committedAt: '2026-11-18T06:00:00.000Z',
            totalMinor: 5_000, currency: 'INR', packVersion: 1, customerRef: m,
            lines: [{ productId: 'SOAP', quantityMinor: 1, uom: 'ea', unitPriceMinor: 5_000, lineTotalMinor: 5_000 }], tenders: [{ kind: 'cash', amountMinor: 5_000 }],
          }, `sale-${n}`);
        }
      },
    });
    const order = (await shop.cloud().request({ method: 'GET', path: '/v1/purchase/orders/po-18b', userId: OWNER })).body as { order: { documentNumber?: string; number: string } };
    poNumber = order.order.documentNumber ?? order.order.number;
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  /** A signed-in page, with what the store computer tells every office page about the person (its directory: who and what they hold). */
  const open = async (who: string, path: string, branch?: string): Promise<{ page: Page; context: BrowserContext; errors: string[] }> => {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    await shop.signIn(context, who, branch);
    const me = (await shop.cloud().request({ method: 'GET', path: '/v1/identity/me', userId: who, ...(branch === undefined ? {} : { branchId: branch }) })).body as { userId: string; permissions: string[] };
    await context.addInitScript((d) => { (globalThis as unknown as { sreDirectory: unknown }).sreDirectory = d; }, { me: { userId: me.userId, permissions: me.permissions, roleIds: [] } });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    return { page, context, errors };
  };
  const shot = async (page: Page, name: string): Promise<void> => { if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, name), fullPage: true }); };
  const download = async (page: Page, buttonId: string): Promise<string> => {
    const [file] = await Promise.all([page.waitForEvent('download'), page.click(`#${buttonId}`)]);
    return (await readFile((await file.path())!)).toString('utf8');
  };

  it('B1: the Customers list downloads exactly the rows shown — the owner sees the customer numbers, the store manager gets them redacted; head office records both', async () => {
    const owner = await open(OWNER, '/customers');
    try {
      await owner.page.locator('#customer-rows tr[data-customer="M-chitra"]').waitFor();
      await owner.page.fill('#customers-search', 'bala');
      await owner.page.locator('#customer-rows tr[data-customer="M-anu"]').waitFor({ state: 'detached' });
      const text = await download(owner.page, 'customers-download');
      expect(text.charCodeAt(0), 'starts with the byte-order mark Excel needs for Tamil').toBe(0xfeff);
      const lines = text.slice(1).trim().split('\r\n');
      expect(lines[0]).toBe('Customer code,Name,Segment,Bills,Last bill');
      expect(lines).toHaveLength(2); // only what the search left on the screen
      expect(lines[1]).toMatch(/^M-bala,Not known,/);
      await owner.page.waitForFunction(() => /Head office has a record of this download\./.test((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } | null } }).document.getElementById('customers-download-status')?.textContent ?? ''));
      expect(await owner.page.textContent('#customers-download-status')).toMatch(/^Downloaded 1 row\(s\) to Customers-and-their-segments-\d{4}-\d{2}-\d{2}\.csv\./);
      await shot(owner.page, 'b1-customers-download-owner.png');
      expect(owner.errors).toEqual([]);
    } finally { await owner.context.close(); }

    const mgr = await open(MGR, '/customers', 'br-1');
    try {
      await mgr.page.locator('#customer-rows tr[data-customer="M-chitra"]').waitFor();
      const text = await download(mgr.page, 'customers-download');
      const lines = text.slice(1).trim().split('\r\n');
      expect(lines).toHaveLength(4);
      for (const l of lines.slice(1)) expect(l, 'the customer number and the name are personal data').toMatch(/^\[redacted\],\[redacted\],/);
      await mgr.page.waitForFunction(() => /Head office has a record/.test((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } | null } }).document.getElementById('customers-download-status')?.textContent ?? ''));
      expect(await mgr.page.textContent('#customers-download-status')).toMatch(/Personal data removed \(you are not allowed to see it\): Customer code, Name\./);
      await mgr.page.click('#lang');
      expect(await mgr.page.textContent('#customers-download')).toMatch(/Excel கோப்பாகப் பதிவிறக்கு/);
      expect(await mgr.page.textContent('#customers-download-status'), 'what the download said follows the language too').toMatch(/^3 வரிசை\(கள்\) .* பதிவிறக்கப்பட்டன\. தனிப்பட்ட தகவல் நீக்கப்பட்டது/);
      await shot(mgr.page, 'b1-customers-download-manager-redacted.png');
      expect(mgr.errors).toEqual([]);
    } finally { await mgr.context.close(); }

    const ledger = ((await shop.cloud().request({ method: 'GET', path: '/v1/exports', userId: OWNER })).body as { exports: ExportAudit[] }).exports.filter((e) => e.domain === 'screen-list:/customers#customers');
    expect(ledger.map((e) => [e.userId, e.rowCount, e.redactedColumns])).toEqual(expect.arrayContaining([[OWNER, 1, []], [MGR, 3, ['Customer code', 'Name']]]));
  }, 120_000);

  it('P1: an issued order prints on an A4 page with both GSTINs, its PO number, the items with rate and GST rate, the total and the signatures — and again from the copy kept here with head office out of reach', async () => {
    const s = await open(OWNER, '/buying');
    try {
      await s.page.click('#tab-orders');
      await s.page.click('#orders-read');
      const print = s.page.locator('.open-order[data-po="po-18b"] button.print-po');
      await print.waitFor();
      await shot(s.page, 'p1-open-orders-print-button.png');
      await print.click();
      await s.page.locator('#sre-print-sheet .sre-print-page').waitFor();
      const page = (await s.page.textContent('#sre-print-sheet .sre-print-page')) ?? '';
      expect(await s.page.textContent('#sre-print-title')).toBe('Purchase order');
      expect(poNumber).toMatch(/^PO\/\d{2}-\d{2}\/\d{5}$/);
      expect(await s.page.textContent('.sre-print-head')).toContain(poNumber);
      expect(await s.page.textContent('.sre-print-head')).toMatch(/Date\d{2}\/\d{2}\/\d{4}/);
      expect(await s.page.textContent('.sre-print-parties')).toMatch(new RegExp(`SRE Hyper Market.*GSTIN: ${SHOP_GSTIN}.*Kaveri Traders.*GSTIN: ${SUPPLIER_GSTIN}`));
      const rows = await s.page.locator('.sre-print-lines tbody tr').allInnerTexts();
      expect(rows.map((r) => r.split('\t').map((c) => c.trim()))).toEqual([
        ['1', 'Ponni rice (RICE)', '1006', '25.000 kg', '60.00 per kg', '5%', '1,500.00'],
        ['2', 'Bath soap 100g (SOAP)', '1006', '12', '40.00', '5%', '480.00'],
      ]);
      expect(await s.page.textContent('.sre-print-totals')).toMatch(/Total value at these rates\s*₹1,980\.00/);
      expect(await s.page.locator('.sre-print-signature').allInnerTexts()).toEqual(['Prepared by', 'Approved by', 'Supplier\'s acknowledgement']);
      expect(page).toMatch(/Read from head office at/);
      await shot(s.page, 'p1-po-print-sheet.png');
      // On paper: the A4 page alone — the office page and the sheet's buttons are not printed.
      await s.page.emulateMedia({ media: 'print' });
      expect(await s.page.isVisible('#tabs')).toBe(false);
      expect(await s.page.isVisible('#sre-print-go')).toBe(false);
      expect(await s.page.isVisible('.sre-print-page')).toBe(true);
      await shot(s.page, 'p1-po-print-layout-a4.png');
      await s.page.emulateMedia({ media: 'screen' });
      await s.page.click('#sre-print-close');
      expect(await s.page.locator('#sre-print-sheet').count()).toBe(0);

      // Head office out of reach: the same order prints from the copy this computer kept, and the sheet says so.
      await s.context.route('**/v1/documents/print/**', (route) => route.abort('internetdisconnected'));
      await print.click();
      await s.page.locator('#sre-print-sheet .sre-print-page').waitFor();
      expect(await s.page.textContent('#sre-print-status')).toMatch(/^Printed from the copy kept on this computer \(read from head office at .+\)\. Head office could not be reached just now\.$/);
      expect(await s.page.textContent('.sre-print-head')).toContain(poNumber);
      await s.page.click('#sre-print-close');
      expect(s.errors).toEqual([]);
    } finally { await s.context.close(); }
  }, 120_000);

  it('R1: "Print GRN" opens the receipt on an A4 page — its GRN number, the order it was against, what arrived at its rate and GST rate', async () => {
    const s = await open(OWNER, '/goods-receipt');
    try {
      const print = s.page.locator('button.print-grn[data-grn="grn-18b"]');
      await print.waitFor();
      await shot(s.page, 'r1-goods-receipt-print-button.png');
      await print.click();
      await s.page.locator('#sre-print-sheet .sre-print-page').waitFor();
      expect(await s.page.textContent('#sre-print-title')).toBe('Goods receipt note (GRN)');
      expect(await s.page.textContent('.sre-print-head')).toMatch(/NumberGRN1\/\d{2}-\d{2}\/\d{5}/);
      expect(await s.page.textContent('.sre-print-facts')).toContain(`Against purchase order${poNumber}`);
      expect(await s.page.textContent('.sre-print-parties')).toMatch(new RegExp(`GSTIN: ${SHOP_GSTIN}.*Kaveri Traders.*GSTIN: ${SUPPLIER_GSTIN}`));
      const rows = await s.page.locator('.sre-print-lines tbody tr').allInnerTexts();
      expect(rows.map((r) => r.split('\t').map((c) => c.trim()))).toEqual([['1', 'Bath soap 100g (SOAP)', '1006', '12', '40.00', '5%', '480.00']]);
      expect(await s.page.locator('.sre-print-signature').allInnerTexts()).toEqual(['Received by (store)', 'Checked by', 'Delivered by (supplier)']);
      await shot(s.page, 'r1-grn-print-sheet.png');
      await s.page.emulateMedia({ media: 'print' });
      await shot(s.page, 'r1-grn-print-layout-a4.png');
      await s.page.emulateMedia({ media: 'screen' });
      expect(s.errors).toEqual([]);
    } finally { await s.context.close(); }
  }, 120_000);
});
