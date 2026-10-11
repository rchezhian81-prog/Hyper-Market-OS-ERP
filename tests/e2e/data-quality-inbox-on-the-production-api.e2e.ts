import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **The Data Quality inbox (A08), in a real browser, on the PRODUCTION API (audit EA-09 · A08 · QG-11 · PA-01).**
 *
 * The page is served in front of the real API over real PostgreSQL; the gaps are real products published through the
 * real catalogue route. A08's findings rest on the product master, which is the WHOLE shop's (one commerce truth, P-02),
 * so every finding is shop-wide. Through Chromium it proves:
 *   • a manager whose grant reaches one branch sees the shop-wide suggestions (they are everyone's to read) but setting
 *     one aside is company-wide work: the server refuses, the page says so, nothing moves;
 *   • the owner (company-wide steward) sets one aside in their own name; the row moves on the server's re-read;
 *   • fixing a gap the ordinary way (a barcode assigned) drops its suggestion on reload — the AI changed no product;
 *   • the kill switch empties the inbox and says why; and after a RESTART the set-aside is read back.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['data', 'quality', 'inbox', 'e2e', 'key'].join('-').padEnd(48, '0');
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const MRP = [{ value: { minor: 5000, currency: 'INR' }, effectiveFrom: '2026-01-01' }];
const base = { baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'draft' };

const rowsText = (page: Page, list: '#rows' | '#dismissed-rows') => page.$$eval(`${list} .row .headline`, (els) => els.map((e) => e.textContent ?? ''));

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Data Quality inbox (A08) on the production API, in a real browser (EA-09)', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/data-quality', html: 'data-quality.html', dataGlobal: 'dataQualityInboxData' },
      seed: async (cloud) => {
        const publish = (id: string, product: unknown) => ok(cloud.request({ method: 'POST', path: `/v1/catalogue/products/${id}/publish`, userId: OWNER, idempotencyKey: `pub-${id}`, body: { product, categories: [GROCERY] } }), id);
        await publish('p-noscan', { ...base, sku: 'SKU-NOSCAN', name: 'Loose Poha', brand: 'Local', mrpHistory: MRP });
        await publish('p-nomrp', { ...base, sku: 'SKU-NOMRP', name: 'Sugar 1kg', brand: 'Local' });
        await ok(cloud.request({ method: 'POST', path: '/v1/catalogue/products/p-nomrp/barcodes/8901000000004', userId: OWNER, idempotencyKey: 'bc-nomrp', body: { kind: 'ean' } }), 'barcode');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await shop?.stop();
  });

  const open = async (who: string, branch?: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who, branch);
    const page = await context.newPage();
    const asked: string[] = [];
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/')) asked.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/data-quality`, { waitUntil: 'load' });
    return { page, asked, close: () => context.close() };
  };
  const twoRows = (page: Page) => page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(s: string): { length: number } } }).document.querySelectorAll('#rows .row').length === 2, undefined, { timeout: 15_000 });

  it('a br-1 manager reads the shop-wide suggestions but cannot set one aside; the owner can, in their own name', async () => {
    let s = await open(MGR, 'br-1');
    try {
      await twoRows(s.page);
      const shown = await rowsText(s.page, '#rows');
      expect(shown.some((t) => t.includes('Sugar 1kg'))).toBe(true);
      expect(shown.some((t) => t.includes('Loose Poha'))).toBe(true);
      const row = s.page.locator('#rows .row', { hasText: 'Sugar 1kg' });
      await row.locator('.reason').fill('priced next week');
      await row.locator('.act.dismiss').click();
      await s.page.locator('#result.tone-error').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#dismissed-rows .row').count()).toBe(0);
      expect(s.asked).toContain('POST /v1/ai/data-quality/dismissals');
    } finally { await s.close(); }

    s = await open(OWNER);
    try {
      await twoRows(s.page);
      const row = s.page.locator('#rows .row', { hasText: 'Sugar 1kg' });
      await row.locator('.reason').fill('priced next week');
      await row.locator('.act.dismiss').click();
      await s.page.locator('#dismissed-rows .row', { hasText: 'Sugar 1kg' }).waitFor({ timeout: 15_000 });
    } finally { await s.close(); }
    const wl = (await shop.cloud().request({ method: 'GET', path: '/v1/ai/data-quality/worklist', userId: OWNER })).body as { dismissed: { finding: { findingId: string }; dismissal: { by: string }; branchId: string | null }[] };
    expect(wl.dismissed.map((e) => [e.finding.findingId, e.dismissal.by, e.branchId])).toEqual([['dq-missing-mrp:p-nomrp', OWNER, null]]);
  }, 60_000);

  it('refreshed data, the kill switch, and a restart — each read from head office', async () => {
    // A steward fixes the barcode gap the ordinary way: the suggestion drops off on reload.
    await ok(shop.cloud().request({ method: 'POST', path: '/v1/catalogue/products/p-noscan/barcodes/8901000000005', userId: OWNER, idempotencyKey: 'bc-noscan', body: { kind: 'ean' } }), 'fix');
    let s = await open(MGR, 'br-1');
    try {
      await s.page.locator('#dismissed-rows .row', { hasText: 'Sugar 1kg' }).waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#rows .row').count()).toBe(0);
    } finally { await s.close(); }

    await ok(shop.cloud().request({ method: 'PUT', path: '/v1/ai/kill-switch', userId: OWNER, idempotencyKey: 'kill', body: { on: true } }), 'kill');
    s = await open(MGR, 'br-1');
    try {
      await s.page.locator('#state-text', { hasText: /kill switch/i }).waitFor({ timeout: 15_000 });
    } finally { await s.close(); }
    await ok(shop.cloud().request({ method: 'PUT', path: '/v1/ai/kill-switch', userId: OWNER, idempotencyKey: 'unkill-2', body: { on: false } }), 'unkill');

    await shop.restart();
    s = await open(OWNER);
    try {
      await s.page.locator('#dismissed-rows .row', { hasText: 'Sugar 1kg' }).waitFor({ timeout: 15_000 });
    } finally { await s.close(); }
  }, 90_000);
});
