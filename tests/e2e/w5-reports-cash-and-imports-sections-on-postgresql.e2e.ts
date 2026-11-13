import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startW4Shop, openAs, says, type W4Shop } from './lib/w4-office-shop';

/**
 * **W5 · reports, cash and imports, connected: the new sections on four office pages, in a real browser, on the production API
 * surface over real PostgreSQL (DATABASE_URL).**
 *   • M29-FR-04 — Owner alerts: a scheduled report's run history (the run head office prepared for the shop's day);
 *   • M29-FR-02 — Compare stores: the drill audit reads (who looked behind a figure);
 *   • OB-82 — Cash office: a till with no old records is said so; placing it is refused by head office in its words, and the
 *     placement asks a reason first;
 *   • OB-315 — Data in and out: a product file's check is KEPT as a dry run, with its row problems, in the person's name, and
 *     nothing is loaded;
 *   • M30-FR-04 — Data in and out: each source's data quality and every job (a refused file included) read.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner'; const CASHIER = 'u-cashier';
const PAGES = {
  '/owner-alerts': { html: 'owner-alerts.html', dataGlobal: 'ownerAlertsData' },
  '/branch-compare': { html: 'branch-compare.html', dataGlobal: 'branchCompareData' },
  '/cash-office': { html: 'cash-office.html', dataGlobal: 'cashOfficeData' },
  '/data-io': { html: 'data-io.html', dataGlobal: 'dataIoData' },
};

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('W5 reports, cash and imports sections, connected on PostgreSQL', () => {
  let browser: Browser;
  let shop: W4Shop;
  const T = randomUUID();
  const as = async (userId: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const r = await shop.ho().request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `seed-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startW4Shop({ tenantId: T, databaseUrl: DATABASE_URL, pages: PAGES });
    await shop.ho().seedOwner(T, OWNER);
    await shop.ho().provisionRole(T, CASHIER, 'cashier', ['store-1']);
    // A daily sales report due at midnight (so it is due whatever the hour), prepared once by head office for today.
    await as(OWNER, 'POST', '/v1/reporting/report-schedules/s-sales', { kind: 'report', target: 'sales_by_day', dueAt: [0, 0] });
    await as(OWNER, 'POST', '/v1/reporting/report-schedules/run', {});
    // A supplier's file the importer refused, kept on the job history (refusals included).
    await as(OWNER, 'POST', '/v1/purchase/import-jobs/job-1', { sourceId: 'supplier-anand', templateId: 'supplier-invoice-v1', fileName: 'anand-oct.csv', outcome: 'refused', totalRows: 10, validRows: 6, errorRows: 4, duplicatesForReview: 0, errors: [{ line: 3, column: 'gstin', kind: 'missing_required', message: 'GSTIN is missing' }], refusalReason: 'four rows had no valid GSTIN' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('M29-FR-04 · M29-FR-02: the owner reads a scheduled report\'s runs on Owner alerts and the drill audit on Compare stores', async () => {
    expect(shop.backing).toBe('PostgreSQL');
    let s = await openAs(shop, browser, OWNER, '/owner-alerts');
    try {
      await s.page.click('#w5-runs-load');
      await expect.poll(async () => s.page.locator('#w5-runs-schedule option').count(), { timeout: 15_000 }).toBe(1);
      await s.page.click('#w5-runs-show');
      await says(s.page, '#w5-runs-list li', /^\d{4}-\d{2}-\d{2} · prepared · .* — Sales by day/);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    s = await openAs(shop, browser, OWNER, '/branch-compare');
    try {
      await says(s.page, '#w5-drill-h', /^Who looked behind a figure$/);
      await s.page.click('#w5-drill-show');
      await says(s.page, '#w5-drill-list', /Nothing to show\./);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);

  it('OB-82: on Cash office a till with no old records is said so; placing asks a reason and head office refuses — in its words', async () => {
    const s = await openAs(shop, browser, OWNER, '/cash-office');
    try {
      await s.page.fill('#w5-leg-till', 'till-9'); await s.page.fill('#w5-leg-store', 'store-1');
      await s.page.click('#w5-leg-look');
      await says(s.page, '#w5-leg-answer', /^This till has no old records to place\.$/);
      await s.page.click('#w5-leg-place');
      await says(s.page, '#w5-leg-status', /^Say, in writing, why\.$/);
      await s.page.fill('#w5-leg-why', 'it has always been at store 1');
      await s.page.click('#w5-leg-place');
      await says(s.page, '#w5-leg-status', /^Head office refused: /);
      expect(s.writes).toEqual(['POST /v1/tills/till-9/legacy-placement']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);

  it('OB-315 · M30-FR-04: on Data in and out a product file\'s check is kept as a dry run; quality and every job are read', async () => {
    const s = await openAs(shop, browser, OWNER, '/data-io');
    try {
      await s.page.click('#w5-dry-load');
      await expect.poll(async () => s.page.locator('#w5-dry-template option').count(), { timeout: 15_000 }).toBeGreaterThan(0);
      await s.page.selectOption('#w5-dry-template', 'product-v1');
      await s.page.fill('#w5-dry-file', 'productId,sku,name,baseUom,primaryCategoryId,taxClass\nP-1,SKU-1,Ponni rice 5kg,each,no-such-category,GST5');
      await s.page.click('#w5-dry-keep');
      await says(s.page, '#w5-dry-status', /^Kept\.$/);
      await says(s.page, '#w5-dry-list li', /product-v1 · u-owner · 1 rows · 0 good · 1 with problems · not ready to load/);
      await s.page.click('#w5-qual-show');
      await says(s.page, '#w5-qual-list li[data-id="supplier-anand"]', /^supplier-anand · 1 · 10 rows · /);
      // U7: every job is on the register now (one page from head office): the row's cells, in order
      await says(s.page, '#w5-qual-jobs tr[data-id="job-1"]', /anand-oct\.csv.*refused.*6\/10.*u-owner/);
      expect(s.writes, 'a dry run loads nothing').toEqual([expect.stringMatching(/^POST \/v1\/import\/dry-runs\/dry-/)]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const commits = await as(OWNER, 'GET', '/v1/import/commits') as { total: number };
    expect(commits.total, 'nothing was loaded').toBe(0);
  }, 120_000);

  it('a cashier is told his role cannot keep checks or read the import history', async () => {
    const s = await openAs(shop, browser, CASHIER, '/data-io', 'store-1');
    try {
      await says(s.page, '#w5-dry-status', /^Your role cannot do this\.$/);
      expect(await s.page.locator('#w5-dry-keep, #w5-qual-show').count()).toBe(0);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);
});
