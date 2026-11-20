import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { REPORTS } from '../../packages/reporting/src/index';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **Batch 20c · O2 (owner's missing-options audit, 19 Nov 2026: "18 of the 29 listed reports cannot be run"), in a real
 * Chromium, on the PRODUCTION API over real PostgreSQL.**
 *
 * The owner opens Reports, as the store computer serves it (who is looking, what the shop records, the shop's day):
 *   • all 29 reports are on the "Reports" tab; "Cannot be run yet" is empty; the eighteen head office works out say so;
 *   • Purchases by supplier (Today): head office's order register — the supplier and the order's value — with the days it
 *     covers; the rows have Download to Excel; Print / Save as PDF lays the figures and rows on an A4 page;
 *   • Waste (This month): the write-off at its cost, covering the 1st of the month to today;
 *   • Stock on hand (This month): "Not known for this period — this report shows how things stand now", never a figure;
 *   • GST (This month): GSTR-3B's own taxable value, the month marked provisional — the same figure the GST returns read;
 *   • head office out of reach: "Not known — … cannot reach head office right now" in place of the figures (P-08);
 *   • in Tamil, one language at a time.
 *
 * Screenshots (deviceScaleFactor 1) go to SRE_SCREENSHOT_DIR when it is set. Synthetic data only.
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const SHOTS = process.env['SRE_SCREENSHOT_DIR'];
const KEY = ['batch20c', 'reports', 'ho', 'key'].join('-').padEnd(48, '0');
const ACCT = 'u-acct-20c'; const BUYER = 'u-buyer-20c';
const TODAY = shopDateIn(new Date().toISOString());
const FIRST = `${TODAY.slice(0, 8)}01`;
const dmy = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const inr = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What the store computer serves the Reports page: the shop's records, day and thresholds; a period when one was chosen. */
const reportingData = (period?: { from: string; to: string }) => async (): Promise<Record<string, unknown>> => ({
  storeId: 'br-1', branchId: 'br-1', storeName: 'SRE Hyper Market', now: new Date().toISOString(), tradingDay: TODAY,
  laggingAfterMinutes: 5, staleAfterMinutes: 60, lastSyncedAt: new Date().toISOString(), unsentCount: 0,
  records: [...new Set(REPORTS.flatMap((r) => r.needs))], sales: [], dayTotals: [], exceptions: [], exceptionRulesKnown: true,
  ...(period === undefined ? {} : { period: { asked: period, covered: period, todayOnly: false, heldFrom: FIRST } }),
});

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('batch 20c — every report runs from the Reports page', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/reporting', html: 'reporting.html', dataGlobal: 'reportingData', extraData: reportingData() },
      alsoPages: [{ path: '/reporting-this-month', html: 'reporting.html', dataGlobal: 'reportingData', extraData: reportingData({ from: FIRST, to: TODAY }) }],
      seed: async (c) => {
        const as = (userId: string, path: string, body: unknown, key: string, branchId?: string) => ok(c.request({ method: 'POST', path, userId, body, idempotencyKey: key, ...(branchId === undefined ? {} : { branchId }) }), key);
        await c.grant(ACCT, 'accountant', undefined, 'all');
        await c.grant(BUYER, 'store_manager', undefined, 'all');
        await as(BUYER, '/v1/purchase/suppliers/sup-kav', { name: 'Kaveri Traders', gstin: '33ZZZZZ9999Z1ZF' }, 'sup');
        await as(ACCT, '/v1/purchase/suppliers/sup-kav/approval', { reason: 'documents checked' }, 'sup-ok');
        await as(BUYER, '/v1/purchase/orders/po-20c', { supplierId: 'sup-kav', deliverToLocationId: 'br-1', lines: [{ productId: 'SOAP', orderedQty: 12, unitCost: { minor: 4_000, currency: 'INR' } }] }, 'po', 'br-1');
        await as(OWNER, '/v1/purchase/orders/po-20c/approval', { reason: 'weekly order' }, 'po-ok');
        await as(OWNER, '/v1/inventory/movements', { movementId: 'mv-soap', productId: 'SOAP', locationId: 'br-1', kind: 'received', quantityMinor: 20, uom: 'ea', occurredAt: new Date().toISOString(), enteredBy: OWNER, unitCostMinor: 4_000 }, 'mv');
        await as(OWNER, '/v1/inventory/write-off/WO-20c', { productId: 'SOAP', locationId: 'br-1', qty: 2, uom: 'ea', lossType: 'damage', reasonCode: 'damage' }, 'wo', 'br-1');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (path: string): Promise<{ page: Page; context: BrowserContext; errors: string[] }> => {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    await shop.signIn(context, OWNER);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    await page.locator('#reports-list .row').first().waitFor();
    return { page, context, errors };
  };
  const shot = async (page: Page, name: string): Promise<void> => { if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, name), fullPage: true }); };
  const run = async (page: Page, name: string): Promise<void> => {
    await page.locator('#reports-list .row', { has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) }).locator('button').click();
    await page.locator('#view-report:not([hidden])').waitFor();
    await page.waitForFunction(() => !/Asking head office/.test((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } | null } }).document.getElementById('report-covers')?.textContent ?? ''));
  };

  it('all 29 run; Purchases by supplier comes from head office with the days it covers, downloads and prints', async () => {
    const s = await open('/reporting');
    try {
      expect(await s.page.locator('#reports-list .row').count()).toBe(29);
      expect(await s.page.textContent('#blocked-list')).toContain('Every report this shop needs can be run.');
      expect(await s.page.locator('#reports-list .row .by-head-office').count()).toBe(18);
      await shot(s.page, 'o2-reports-all-29.png');

      await run(s.page, 'Purchases by supplier');
      expect(await s.page.textContent('#report-covers')).toMatch(new RegExp(`^Store SRE Hyper Market · ${dmy(TODAY).replace(/\//g, '\\/')} · worked out by head office from its own records, read at `));
      expect(await s.page.textContent('#report-figures')).toContain(`sup-kav${inr(48_000)}`);
      const rows = await s.page.locator('#report-grid tbody tr').allInnerTexts();
      expect(rows.map((r) => r.split('\t').map((c) => c.trim()))).toEqual([['sup-kav', '1', inr(48_000)]]);
      expect(await s.page.isVisible('#export')).toBe(false);
      await shot(s.page, 'o2-purchases-by-supplier-today.png');

      // Download to Excel: the rows on screen, as the file Excel opens.
      const [file] = await Promise.all([s.page.waitForEvent('download'), s.page.click('#report-download')]);
      const csv = (await readFile((await file.path())!)).toString('utf8');
      expect(csv.slice(1).trim().split('\r\n')).toEqual(['Supplier,Orders,Ordered', `sup-kav,1,${inr(48_000)}`]);

      // Print / Save as PDF: the A4 page carries what it covers, the figures and the rows.
      await s.page.click('#print-report');
      await s.page.locator('#sre-print-sheet .sre-print-page').waitFor();
      expect(await s.page.textContent('#sre-print-title')).toBe('Purchases by supplier');
      expect(await s.page.textContent('.sre-print-head')).toContain(dmy(TODAY));
      expect((await s.page.locator('.sre-print-lines tbody tr').allInnerTexts()).map((r) => r.split('\t').map((c) => c.trim()))).toEqual([['sup-kav', '1', inr(48_000)]]);
      expect(await s.page.textContent('.sre-print-totals')).toContain(inr(48_000));
      await shot(s.page, 'o2-purchases-by-supplier-print.png');
      await s.page.click('#sre-print-close');
      expect(s.errors).toEqual([]);
    } finally { await s.context.close(); }
  }, 120_000);

  it('This month: waste at cost for the 1st to today; stock on hand is about now, so not known; GST is the return\'s own figure', async () => {
    const s = await open('/reporting-this-month?period=this_month');
    try {
      await run(s.page, 'Waste');
      expect(await s.page.textContent('#report-covers')).toContain(FIRST === TODAY ? dmy(TODAY) : `${dmy(FIRST)} to ${dmy(TODAY)}`);
      expect(await s.page.textContent('#report-figures')).toContain(`Thrown away, at cost${inr(8_000)}`);
      await shot(s.page, 'o2-waste-this-month.png');
      await s.page.click('#back');

      await run(s.page, 'Stock on hand');
      expect(await s.page.textContent('#report-figures')).toContain('Not known for this period — this report shows how things stand now');
      expect(await s.page.textContent('#report-figures')).not.toMatch(/₹/);
      await s.page.click('#back');

      await run(s.page, 'GST');
      const month = `${TODAY.slice(5, 7)}${TODAY.slice(0, 4)}`;
      const g3b = (await shop.cloud().request({ method: 'GET', path: `/v1/finance/gstr3b/${month}`, userId: OWNER })).body as { table31: { a: { taxableMinor: number } } };
      expect(await s.page.textContent('#report-figures')).toContain(`Taxable sales (GSTR-3B 3.1 a)${inr(g3b.table31.a.taxableMinor)}`);
      expect(await s.page.textContent('#report-notes')).toContain(`${TODAY.slice(5, 7)}/${TODAY.slice(0, 4)}: provisional — GSTR-1 not filed yet`);
      await shot(s.page, 'o2-gst-this-month.png');

      await s.page.click('#lang');
      expect(await s.page.textContent('#report-title')).toBe('ஜிஎஸ்டி');
      expect(await s.page.textContent('#report-figures')).toContain('வரிக்குட்பட்ட விற்பனை (GSTR-3B 3.1 a)');
      expect(await s.page.textContent('#report-figures')).not.toContain('Taxable sales');
      await shot(s.page, 'o2-gst-this-month-tamil.png');
      expect(s.errors).toEqual([]);
    } finally { await s.context.close(); }
  }, 120_000);

  it('head office out of reach: the report says so — nothing is shown in its place', async () => {
    const s = await open('/reporting');
    try {
      await s.context.route('**/v1/reports/**', (route) => route.abort('internetdisconnected'));
      await run(s.page, 'Shrinkage');
      expect(await s.page.textContent('#report-figures')).toContain('Not known — this report is worked out by head office from its own records, and this computer cannot reach head office right now.');
      expect(await s.page.textContent('#report-figures')).not.toMatch(/₹/);
      expect(await s.page.textContent('#report-covers')).toBe('Store SRE Hyper Market · worked out by head office');
      await shot(s.page, 'o2-shrinkage-head-office-not-reached.png');
      expect(s.errors).toEqual([]);
    } finally { await s.context.close(); }
  }, 120_000);
});
