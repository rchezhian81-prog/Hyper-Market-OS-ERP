import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { approveSupplierWith, SUPPLIER_MAKER, SUPPLIER_CHECKER } from '../support/approved-supplier';

/**
 * M06-FR-02 · WF-03 (OB-288 P3) — the Requisitions and quotes page, in a real browser, on the PRODUCTION API over real
 * PostgreSQL. The br-1 store manager raises a requisition (rice 10, dal 4), records two suppliers' quotes — one covering only
 * the rice — and reads head office's comparison: the cheaper rice and the faster rice are marked on head office's own rows,
 * the quote missing the dal is named "could not be compared in full" and cannot become an order. The manager proposes the
 * order from the whole quote; head office holds it as PROPOSED and LOCAL (the manager buys for their own store, ₹25,000 cap,
 * OB-289/OB-290), the requisition on it; the manager cannot issue it; the owner does. A person with no purchase role reads
 * "cannot read" and sees no raise form. Tamil twin.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['requisitions', 'page', 'e2e', 'key'].join('-').padEnd(48, '0');

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Requisitions and quotes page (M06-FR-02 / WF-03) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/requisitions', html: 'requisitions.html', dataGlobal: 'requisitionsData' },
      seed: async (cloud) => {
        await cloud.grant(SUPPLIER_MAKER, 'store_manager');
        await cloud.grant(SUPPLIER_CHECKER, 'accountant');
        await cloud.grant('u-till', 'cashier');
        const call = (method: 'POST', path: string, userId: string, body: unknown, idempotencyKey: string) => cloud.request({ method, path, userId, idempotencyKey, body });
        await approveSupplierWith(call, 'sup-1');
        await approveSupplierWith(call, 'sup-2');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await shop?.stop();
  });

  it('requisition → two quotes → head office\'s comparison → an order PROPOSED from the whole quote; the owner issues it', async () => {
    const context = await browser.newContext();
    const errors: string[] = [];
    try {
      await shop.signIn(context, MGR, 'br-1');
      const page = await context.newPage();
      page.on('pageerror', (e) => { errors.push(String(e)); });
      await page.goto(`${shop.base}/requisitions`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { requisitions?: unknown }).requisitions !== undefined);
      await expect.poll(() => page.isVisible('#none')).toBe(true);
      expect(await page.isHidden('#open-section')).toBe(true);
      // Every button carries its icon beside its word.
      expect(await page.locator('#raise svg').count()).toBe(1);
      expect(await page.textContent('#raise')).toBe('Raise the requisition');

      // A line with no whole quantity is refused before anything is sent.
      await page.fill('#new-id', 'rq-1');
      await page.fill('#new-productId-0', 'rice');
      await page.fill('#new-quantity-0', '2.5');
      await page.click('#raise');
      await expect.poll(() => page.textContent('#page-status')).toMatch(/whole quantity above 0/);
      await page.fill('#new-quantity-0', '10');
      await page.click('#add-line');
      await page.fill('#new-productId-1', 'dal');
      await page.fill('#new-quantity-1', '4');
      await page.click('#raise');
      await page.locator('#open-section:not([hidden])').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#list tr[data-requisition="rq-1"]')).toMatch(/rice × 10, dal × 4/);
      expect(await page.textContent('#no-quotes')).toBe('No quotes yet.');

      // Two quotes: sup-1 quotes rice only, faster; sup-2 quotes both, rice cheaper.
      const quote = async (quoteId: string, supplierId: string, prices: readonly (readonly [string, string])[]) => {
        await page.fill('#quote-id', quoteId);
        await page.fill('#quote-supplier', supplierId);
        for (const [i, [unit, lead]] of prices.entries()) { await page.fill(`#q-unit-${i}`, unit); await page.fill(`#q-lead-${i}`, lead); }
        await page.click('#record-quote');
        await expect.poll(() => page.textContent('#page-status')).toBe('Quote recorded.');
      };
      await quote('q2', 'sup-2', [['39', '5'], ['90.50', '5']]);
      // A half-filled line is refused before sending; a wholly blank line is one sup-1 did not quote.
      await page.fill('#quote-id', 'q1');
      await page.fill('#quote-supplier', 'sup-1');
      await page.fill('#q-unit-1', '95');
      await page.click('#record-quote');
      await expect.poll(() => page.textContent('#page-status')).toMatch(/needs a price/);
      await page.fill('#q-unit-1', '');
      await quote('q1', 'sup-1', [['42', '2']]);

      // Head office's comparison: q2 cheapest for rice, q1 fastest for rice; q1 named as not comparable in full.
      await expect.poll(() => page.textContent('#overall')).toMatch(/Cheapest overall: sup-2 \(q2\)/);
      expect(await page.textContent('#cmp tr[data-quote="q2"][data-product="rice"]')).toMatch(/₹39\.00.*₹390\.00.*5 days.*Cheapest/);
      expect(await page.textContent('#cmp tr[data-quote="q1"][data-product="rice"]')).toMatch(/₹42\.00.*2 days.*Fastest/);
      expect(await page.locator('#cmp tr[data-quote="q2"][data-product="rice"] svg').count()).toBe(1); // the icon beside "Cheapest"
      expect(await page.textContent('#incomplete')).toMatch(/Could not be compared in full .*q1/);
      // The partial quote cannot become an order — refused before sending.
      expect(await page.locator('#order-quote option[value="sup-1|q1"]').count()).toBe(0);

      // Propose the order from q2 at its prices; delivered to the manager's own store.
      await page.selectOption('#order-quote', 'sup-2|q2');
      await page.fill('#order-store', 'br-1');
      await page.fill('#order-id', 'po-rq-1');
      await page.click('#raise-order');
      await expect.poll(() => page.textContent('#page-status')).toMatch(/Order proposed — a second person issues it on the Buying page\. \(po-rq-1 · ₹752\.00\)/);

      const cloud = shop.cloud();
      const read = async () => (await cloud.request({ method: 'GET', path: '/v1/purchase/orders/po-rq-1', userId: OWNER })).body as { order: Record<string, unknown> };
      expect((await read()).order).toMatchObject({ status: 'proposed', requisitionId: 'rq-1', requisitionedBy: MGR, supplierId: 'sup-2', totalMinor: 75_200, buyingScope: 'local' });
      expect((await cloud.request({ method: 'POST', path: '/v1/purchase/orders/po-rq-1/approval', userId: MGR, idempotencyKey: 'mgr-issue', body: { reason: 'mine' } })).status).toBe(403);
      expect((await cloud.request({ method: 'POST', path: '/v1/purchase/orders/po-rq-1/approval', userId: OWNER, idempotencyKey: 'own-issue', body: { reason: 'cheapest whole quote' } })).status).toBe(200);
      expect((await read()).order).toMatchObject({ status: 'issued', approvedBy: OWNER });

      // Tamil twin.
      await page.click('#lang');
      expect(await page.textContent('#page-h')).toBe('கோரிக்கைகளும் விலைப்புள்ளிகளும்');
      expect(await page.textContent('#raise')).toBe('கோரிக்கையை எழுப்பு');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 180_000);

  it('a cashier (no purchase role) reads "cannot read" and sees no raise form; nothing is sent', async () => {
    const context = await browser.newContext();
    try {
      await shop.signIn(context, 'u-till'); // a cashier: signed in, no purchase right
      const page = await context.newPage();
      const sent: string[] = [];
      page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/v1/purchase')) sent.push(r.url()); });
      await page.goto(`${shop.base}/requisitions`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { requisitions?: unknown }).requisitions !== undefined);
      await expect.poll(() => page.textContent('#page-status')).toBe('Your role cannot read requisitions.');
      expect(await page.isHidden('#raise-section')).toBe(true);
      expect(sent).toEqual([]);
    } finally { await context.close(); }
  }, 120_000);
});
