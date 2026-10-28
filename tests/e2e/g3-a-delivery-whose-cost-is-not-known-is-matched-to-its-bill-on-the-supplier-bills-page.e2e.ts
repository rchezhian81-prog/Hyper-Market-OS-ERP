import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import type { RealCloud } from '../support/real-store';

/**
 * **G3 · OB-509 (owner, 28 Oct 2026) — a delivery booked with its cost NOT KNOWN is matched to its supplier bill from the
 * Supplier bills page, in a real browser, on the PRODUCTION API over real PostgreSQL.**
 *
 * The owner books in 10 brooms that came with no purchase order: the cost typed at the door (₹99.99) is NOT booked, the stock
 * is unvalued. Two bills naming brooms are captured onto head office's register. Then, through Chromium:
 *   • the owner (who booked the delivery in) sees it waiting but is offered no match — the page says another person must;
 *   • the accountant sees it waiting with both bills; while the page is open somebody else matches one bill from elsewhere, so
 *     the accountant's match is refused — said in plain English AND Tamil with head office's own words; after a reload the
 *     delivery is gone from the list (its cost is known) and head office values the 10 brooms at the matched bill's ₹42.00;
 *   • nothing is written on open; no page errors.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['g3', 'bill', 'match', 'e2e', 'key'].join('-').padEnd(48, '0');
const ACCT = 'u-acct-g3';
const BUYER = 'u-buyer-g3';

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('a cost-not-known delivery is matched to its bill on the Supplier bills page (OB-509 · G3)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const as = (c: RealCloud, path: string, body: unknown, key: string, userId: string) => c.request({ method: 'POST', path, userId, body, idempotencyKey: key });
  const capture = (c: RealCloud, invoiceId: string, unitPriceMinor: number) => ok(as(c, `/v1/purchase/invoices/${invoiceId}/capture`, {
    supplierId: 'sup-g3', poId: null, declaredTotalMinor: 10 * unitPriceMinor,
    lines: [{ productId: 'BROOM', quantity: 10, unitPriceMinor, lineTotalMinor: 10 * unitPriceMinor }],
  }, `capture-${invoiceId}`, BUYER), `capture ${invoiceId}`);

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/supplier-bills', html: 'supplier-bills.html', dataGlobal: 'supplierBillsData' },
      seed: async (c) => {
        await c.grant(ACCT, 'accountant', undefined, 'all');
        await c.grant(BUYER, 'store_manager', undefined, 'all');
        await ok(as(c, '/v1/purchase/suppliers/sup-g3', { name: 'Synthetic Brooms Ltd' }, 'sup', BUYER), 'supplier');
        await ok(as(c, '/v1/purchase/suppliers/sup-g3/approval', { reason: 'documents checked' }, 'sup-ok', ACCT), 'supplier approved');
        await ok(as(c, '/v1/inventory/goods-receipt/grn-g3', {
          warehouseId: 'br-1', receivedOnDate: '2026-10-20', currency: 'INR',
          lines: [{ lineId: 'L1', productId: 'BROOM', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: { minor: 9_999, currency: 'INR' }, condition: 'good' }],
        }, 'grn-g3', OWNER), 'delivery with no order');
        await capture(c, 'INV-G3-A', 4_200);
        await capture(c, 'INV-G3-B', 4_200);
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/supplier-bills`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };
  const says = async (page: Page, selector: string, expected: RegExp): Promise<void> => {
    try {
      await page.waitForFunction(([sel, source]) => new RegExp(source!).test((globalThis as unknown as { document: { querySelector(x: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''), [selector, expected.source], { timeout: 15_000 });
    } catch (e) {
      throw new Error(`${selector} never said ${String(expected)} — it says "${await page.locator(selector).first().textContent()}"`, { cause: e });
    }
  };
  const valuation = async () => ((await shop.cloud().request({ method: 'GET', path: '/v1/inventory/valuation', userId: OWNER })).body as { rows: { productId: string; onHandMinor: number; value: { minor: number }; unvaluedMinor: number }[] }).rows.filter((r) => r.productId === 'BROOM');

  it('the receiver is offered no match; the accountant matches the bill — a refusal said in English and Tamil — and the brooms are valued at the bill', async () => {
    expect(await valuation()).toEqual([expect.objectContaining({ onHandMinor: 10, value: expect.objectContaining({ minor: 0 }), unvaluedMinor: 10 })]);

    // ── The owner booked it in: shown, but no match offered ──────────────────────────────────────────────────────────
    let s = await open(OWNER);
    try {
      await s.page.locator('#cnk-list li[data-grn="grn-g3"]').waitFor({ timeout: 15_000 });
      await says(s.page, '#cnk-list li[data-grn="grn-g3"]', /You booked this delivery in, so another person must match its bill\./);
      expect(await s.page.locator('#cnk-list li[data-grn="grn-g3"] button[data-act="match-bill"]').count()).toBe(0);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // ── The accountant: both bills offered; one is matched elsewhere meanwhile → refused, in both languages ────────────
    s = await open(ACCT);
    try {
      const row = s.page.locator('#cnk-list li[data-grn="grn-g3"]');
      await row.waitFor({ timeout: 15_000 });
      await says(s.page, '#cnk-list li[data-grn="grn-g3"]', /BROOM × 10 in stock — no purchase order/);
      expect(await row.locator('select.cnk-bill option').allTextContents()).toEqual([
        'INV-G3-A · supplier sup-g3 · BROOM ₹42.00 each', 'INV-G3-B · supplier sup-g3 · BROOM ₹42.00 each',
      ]);
      expect(s.writes, 'nothing is written on open').toEqual([]);

      await ok(as(shop.cloud(), '/v1/inventory/goods-receipt/grn-g3/bill-match', { invoiceId: 'INV-G3-B' }, 'match-elsewhere', BUYER), 'matched elsewhere');
      await row.locator('select.cnk-bill').selectOption('INV-G3-A');
      await row.locator('button[data-act="match-bill"]').click();
      await says(s.page, '#cnk-list li[data-grn="grn-g3"] p.status', /^Not matched — nothing on this delivery is waiting for that bill\. Head office said: Receipt grn-g3 has no line waiting/);
      expect(s.writes).toEqual(['POST /v1/inventory/goods-receipt/grn-g3/bill-match']);

      await s.page.click('#lang');
      await says(s.page, '#cnk-h', /பில்லுக்காகக் காத்திருக்கும் டெலிவரிகள்/);
      await row.locator('button[data-act="match-bill"]').click();
      await says(s.page, '#cnk-list li[data-grn="grn-g3"] p.status', /^பொருத்தப்படவில்லை — இந்த டெலிவரியில் எதுவும் அந்த பில்லுக்காகக் காத்திருக்கவில்லை\. தலைமை அலுவலகம் சொன்னது: /);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // ── Read back: nothing is waiting; head office values the brooms at the matched bill (₹42.00 × 10), once ───────────
    s = await open(ACCT);
    try {
      await says(s.page, '#cnk-status', /No delivery is waiting for its bill — every cost is known\./);
      expect(await s.page.locator('#cnk-list li').count()).toBe(0);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect(await valuation()).toEqual([expect.objectContaining({ onHandMinor: 10, value: expect.objectContaining({ minor: 42_000 }), unvaluedMinor: 0 })]);
  }, 180_000);

  it('the accountant matches the right bill from the page and the delivery leaves the list', async () => {
    // A second delivery with no order, and its bill.
    await ok(as(shop.cloud(), '/v1/inventory/goods-receipt/grn-g3-2', {
      warehouseId: 'br-1', receivedOnDate: '2026-10-21', currency: 'INR',
      lines: [{ lineId: 'L1', productId: 'MOP', orderedMinor: 4, countedMinor: 4, uom: 'ea', unitCost: { minor: 1, currency: 'INR' }, condition: 'good' }],
    }, 'grn-g3-2', OWNER), 'second delivery');
    await ok(as(shop.cloud(), '/v1/purchase/invoices/INV-G3-MOP/capture', { supplierId: 'sup-g3', poId: null, declaredTotalMinor: 4 * 3_000, lines: [{ productId: 'MOP', quantity: 4, unitPriceMinor: 3_000, lineTotalMinor: 12_000 }] }, 'capture-mop', BUYER), 'mop bill');
    const s = await open(ACCT);
    try {
      const row = s.page.locator('#cnk-list li[data-grn="grn-g3-2"]');
      await row.waitFor({ timeout: 15_000 });
      await row.locator('button[data-act="match-bill"]').click();
      await says(s.page, '#cnk-status', /^Matched — the cost of these goods is now the bill's, and their stock is valued at it\.$/);
      await s.page.locator('#cnk-list li[data-grn="grn-g3-2"]').waitFor({ state: 'detached', timeout: 15_000 });
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const mop = ((await shop.cloud().request({ method: 'GET', path: '/v1/inventory/valuation', userId: OWNER })).body as { rows: { productId: string; value: { minor: number }; unvaluedMinor: number }[] }).rows.filter((r) => r.productId === 'MOP');
    expect(mop).toEqual([expect.objectContaining({ value: expect.objectContaining({ minor: 12_000 }), unvaluedMinor: 0 })]);
  }, 120_000);
});
