import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

/**
 * **Round 6 · B2 · B4 — the Products and prices screen, in a real browser.** A packed product with two different MRPs
 * starting on one date is refused by its own name (not "unfinished"), in English and in Tamil; its
 * still-needed list names the consumer-care contact, in both languages. The same product with one MRP and its care
 * contact goes on sale. The screen boots from the box's data (window.catalogueData); no network is needed.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';
const inr = (minor: number) => ({ minor, currency: 'INR' });
const PACKED = { categoryId: 'packed', name: 'Packed household', parentId: null, regulated: ['packed'] };
const base = {
  tenantId: 't1', sku: 'SKU-DET', baseUom: 'each', primaryCategoryId: 'packed', taxClass: '34022010', lifecycle: 'draft',
};
const DATA = {
  userId: 'u-owner', storeId: 'S1', today: '2026-10-27', now: '2026-10-27T10:00:00.000Z', permissions: ['catalogue.pack.publish'], marginFloorBps: 2000,
  categories: [PACKED],
  products: [
    { ...base, productId: 'p-two', sku: 'SKU-TWO', name: 'Synthetic detergent two MRPs',
      mrpHistory: [{ value: inr(120_00), effectiveFrom: '2026-11-01' }, { value: inr(125_00), effectiveFrom: '2026-11-01' }],
      safety: { netQuantity: '1 kg', packerDetails: 'Synthetic Packers', countryOfOrigin: 'India' } },
    { ...base, productId: 'p-ok', sku: 'SKU-OK', name: 'Synthetic detergent one MRP',
      mrpHistory: [{ value: inr(120_00), effectiveFrom: '2026-11-01' }],
      safety: { netQuantity: '1 kg', packerDetails: 'Synthetic Packers', countryOfOrigin: 'India', consumerCareContact: 'Synthetic Care, 1800-000-0000' } },
  ],
  priceEntries: [], costsMinor: {}, barcodes: [], promotions: [],
};

async function startShell(): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const file = path === '/' ? 'catalogue.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) body = body.replace('<!--SCREEN-DATA-->', `<script>window.catalogueData = ${JSON.stringify(DATA).replace(/</g, '\\u003c')};</script>`);
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(body);
      } catch {
        res.writeHead(404); res.end('not found');
      }
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

const says = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
  const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
  return (node?.textContent ?? '').includes(want!);
}, [selector, text], { timeout: 15_000 });

describe.skipIf(!HAVE_BROWSER)('the product screen refuses two MRPs on one date and asks for the care contact (B2 · B4)', () => {
  let browser: Browser;
  let shell: { base: string; stop: () => Promise<void> };
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shell = await startShell();
  }, 120_000);
  afterAll(async () => { await browser?.close(); await shell?.stop(); });

  it('two MRPs are refused by name in English and Tamil; the care contact is named as still needed; the clean pack goes on sale', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${shell.base}/`, { waitUntil: 'load' });
      await page.waitForSelector('#item-list button[aria-label="Synthetic detergent two MRPs"]');
      await page.click('#item-list button[aria-label="Synthetic detergent two MRPs"]');
      await says(page, '#item-score', 'one MRP per date');
      await says(page, '#item-score', 'a consumer-care contact');
      await page.click('#publish');
      await says(page, '#banner-text', 'two different MRPs starting on the same date');

      // Tamil: the refusal and the still-needed names in Tamil.
      await page.click('#banner-ok');
      await page.click('#lang');
      await says(page, '#item-score', 'வாடிக்கையாளர் புகார் தொடர்பு');
      await says(page, '#item-score', 'ஒரு தேதிக்கு ஒரே MRP');
      await page.click('#publish');
      await says(page, '#banner-text', 'ஒரே தேதியில் தொடங்கும் இரண்டு வெவ்வேறு MRP-கள்');
      await page.click('#banner-ok');
      await page.click('#lang');

      // The clean pack (one MRP, its care contact) goes on sale.
      await page.click('#back-to-items');
      await page.click('#item-list button[aria-label="Synthetic detergent one MRP"]');
      await page.click('#publish');
      await says(page, '#banner-title', 'This item is on sale');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);
});
