import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **R3 lane 1 — the GST returns page, in a real browser, on the PRODUCTION API over real PostgreSQL (A15 · A16 · A14 ·
 * A19 · A18 · A21).**
 *
 * May 2026 at the till: paneer ×2 (₹210 at 5%) and ghee (₹118 at 18%). GSTR-1 for May is prepared with the digest head
 * office gives, approved by a different person and filed (sandbox). Through Chromium the owner: sees the three controls
 * as head office holds them — reverse charge SWITCHED OFF, the 30-day e-invoice guard SWITCHED OFF, the warning window
 * "180 days (owner's decision OB-191)" (never "not set", and the calendar judges "near the bar"); opens May: 3.1(a) ₹300.00 taxable / ₹28.00 tax, equal to the
 * till, input credit NOT KNOWN (never ₹0.00), and "GSTR-1 is filed — lock GSTR-3B to it"; locks it. A paneer sale for
 * 30 May then reaches head office: reloaded, May still shows the FILED ₹300.00 and names the late ₹105.00 as an OPEN
 * difference; the owner records an amendment with a reason and the page says it is declared in 062026, the difference now
 * explained. The calendar lists GSTR-3B 052026; the annual return 2026-27 is incomplete. The page speaks Tamil. A store
 * manager (who may read but holds no switch) sees the same figures.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['gst', 'returns', 'e2e', 'key'].join('-').padEnd(48, '0');
const GSTIN = '33ABCDE1234F1Z5';

interface Doc { querySelectorAll(s: string): { length: number }; querySelector(s: string): { textContent: string | null } | null }

const sale = (saleId: string, productId: string, qty: number, lineTotalMinor: number, tradingDay: string, hsnCode: string, taxRateBps: number) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: OWNER, tradingDay, committedAt: `${tradingDay}T05:30:00Z`,
  totalMinor: lineTotalMinor, currency: 'INR', packVersion: 1,
  lines: [{ productId, quantityMinor: qty, uom: 'each', unitPriceMinor: lineTotalMinor / qty, lineTotalMinor, hsnCode, taxRateBps }],
  tenders: [{ kind: 'cash', amountMinor: lineTotalMinor }],
});

async function showMay(page: Page): Promise<void> {
  await page.fill('#period', '052026');
  await page.click('#show');
  await page.waitForFunction(() => (globalThis as unknown as { document: Doc }).document.querySelector('[data-figure="31a-taxable"]')?.textContent === '₹300.00', undefined, { timeout: 15_000 });
}

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the GST returns page (R3 lane 1) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/gst-returns', html: 'gst-returns.html', dataGlobal: 'gstReturnsData' },
      seed: async (cloud) => {
        await ok(cloud.request({ method: 'POST', path: '/v1/sales', userId: OWNER, idempotencyKey: 's-1', body: sale('S-1', 'p-paneer', 2, 21_000, '2026-05-10', '040610', 500) }), 'sale 1');
        await ok(cloud.request({ method: 'POST', path: '/v1/sales', userId: OWNER, idempotencyKey: 's-2', body: sale('S-2', 'p-ghee', 1, 11_800, '2026-05-12', '040590', 1800) }), 'sale 2');
        const g = await cloud.request({ method: 'GET', path: '/v1/finance/gstr3b/052026', userId: OWNER });
        const digest = (g.body as { gstr1PreviewDigest: string }).gstr1PreviewDigest;
        await ok(cloud.request({ method: 'POST', path: '/v1/finance/gstr1/submission/052026/preview', userId: 'u-hr', idempotencyKey: 'pv', body: { returnDigest: digest } }), 'preview');
        await ok(cloud.request({ method: 'POST', path: '/v1/finance/gstr1/submission/052026/approve', userId: OWNER, idempotencyKey: 'ap', body: {} }), 'approve');
        await ok(cloud.request({ method: 'POST', path: '/v1/finance/gstr1/submission/052026/submit', userId: OWNER, idempotencyKey: 'sb', body: { gstin: GSTIN, digest } }), 'file');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('the owner sees the controls off, locks May to the filed GSTR-1, and carries a late sale by an amendment', async () => {
    const context = await browser.newContext();
    await shop.signIn(context, OWNER);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${shop.base}/gst-returns`, { waitUntil: 'load' });
      await page.locator('#controls li[data-control="reverse-charge"]').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#controls li[data-control="reverse-charge"] .word')).toBe('SWITCHED OFF');
      expect(await page.textContent('#controls li[data-control="einvoice-30-day-guard"] .word')).toBe('SWITCHED OFF');
      expect(await page.textContent('#controls li[data-control="time-bar-warning-days"] .word')).toBe("180 days (owner's decision OB-191)");

      await showMay(page);
      expect(await page.getAttribute('#basis', 'data-basis')).toBe('gstr1_filed_not_yet_locked');
      expect(await page.textContent('[data-figure="31a-tax"]')).toBe('₹28.00');
      expect(await page.textContent('[data-figure="till-net"]')).toBe('₹328.00');
      expect(await page.textContent('[data-figure="4a5"]')).toBe('NOT KNOWN — not yet reconciled');
      expect(await page.locator('#differences li[data-code="none"]').count()).toBe(1);

      // Lock GSTR-3B to the filed GSTR-1.
      await page.click('#lock');
      await page.locator('#ho-result.tone-ok').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#ho-result')).toBe('Locked: 052026');
      await page.waitForFunction(() => (globalThis as unknown as { document: Doc }).document.querySelector('#basis')?.textContent === 'Locked to the filed GSTR-1 — it cannot be changed', undefined, { timeout: 15_000 });

      // A paneer sale for 30 May reaches head office after filing.
      await ok(shop.cloud().request({ method: 'POST', path: '/v1/sales', userId: OWNER, idempotencyKey: 's-3', body: sale('S-3', 'p-paneer', 1, 10_500, '2026-05-30', '040610', 500) }), 'late sale');
      await page.reload({ waitUntil: 'load' });
      await showMay(page);
      const late = page.locator('#differences li[data-code="changed_after_gstr1_filed"]');
      await late.waitFor({ timeout: 15_000 });
      expect(await late.getAttribute('data-explained')).toBe('false');
      expect(await late.locator('.state').textContent()).toContain('₹105.00');

      // No reason → refused on the page; with a reason → recorded, declared in June.
      await page.click('#amend');
      await page.locator('#ho-result.tone-error').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#ho-result')).toBe('Write the reason for the amendment first.');
      await page.fill('#amend-reason', 'sale S-3 reached head office after GSTR-1 was filed');
      await page.click('#amend');
      await page.locator('#ho-result.tone-ok').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#ho-result')).toBe('Amendment recorded — declared in 062026');
      await page.locator('#differences li[data-code="carried_by_amendment"]').waitFor({ timeout: 15_000 });
      expect(await page.locator('#differences li[data-code="changed_after_gstr1_filed"]').count()).toBe(0);
      expect(await page.textContent('[data-figure="31a-taxable"]')).toBe('₹300.00');

      // The calendar and the annual return.
      expect(await page.locator('#calendar li[data-type="GSTR3B"][data-period="052026"]').count()).toBe(1);
      // OB-191: N is 180 days, so "near the bar" is judged — the page never says it is not set.
      expect(await page.textContent('#cal-summary')).not.toMatch(/has not set how many days/);
      expect(await page.textContent('#annual-heading')).toBe('Annual return 2026-27');
      expect(await page.textContent('#annual li[data-return="GSTR9"] .state')).toContain('INCOMPLETE');

      // Tamil words for the same section.
      await page.click('#lang');
      expect(await page.textContent('#ho-title')).toBe('இந்த மாத GST, தலைமை அலுவலகத்திலிருந்து');
      expect(await page.textContent('#controls li[data-control="reverse-charge"] .word')).toBe('நிறுத்தப்பட்டுள்ளது');
      expect(await page.textContent('#controls li[data-control="time-bar-warning-days"] .word')).toBe('180 நாள் (உரிமையாளர் முடிவு OB-191)');
      expect(errors).toEqual([]);
    } finally { await context.close(); }

    // Head office holds the lock and the amendment.
    const may = (await shop.cloud().request({ method: 'GET', path: '/v1/finance/gstr3b/052026', userId: OWNER })).body as { basis: string };
    expect(may.basis).toBe('locked_to_filed_gstr1');
    const june = (await shop.cloud().request({ method: 'GET', path: '/v1/finance/gstr3b/062026', userId: OWNER })).body as { table31: { a: { taxableMinor: number } } };
    expect(june.table31.a.taxableMinor).toBe(10_000);
  }, 120_000);

  it('a store manager reads the same figures and is offered no lock (it is already locked)', async () => {
    const context = await browser.newContext();
    await shop.signIn(context, MGR, 'br-1');
    const page = await context.newPage();
    try {
      await page.goto(`${shop.base}/gst-returns`, { waitUntil: 'load' });
      await showMay(page);
      expect(await page.getAttribute('#basis', 'data-basis')).toBe('locked_to_filed_gstr1');
      expect(await page.locator('#lock').count()).toBe(0);
    } finally { await context.close(); }
  }, 60_000);
});
