import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * D-24 (R4, signed OB-227 · OB-220) — the Store events page, in a real browser, on the PRODUCTION API over real
 * PostgreSQL: "A manager records a festival or local event for the store (dates and expected effect). The next forecasts
 * and order proposals use it with no extra step, and each figure it changed names the event. The 7-day forecast is
 * corrected from the most recent days' actual sales, with the back-test error shown beside it. An effect never
 * back-tested shows as 'manager's estimate'. The weather feed is built as a switched-off link."
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['events', 'e2e', 'key'].join('-').padEnd(48, '0');
const today = (): string => new Date().toISOString().slice(0, 10);
const day = (n: number): string => new Date(Date.parse(`${today()}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Store events page (D-24) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/demand-events', html: 'demand-events.html', dataGlobal: 'demandEventsData' },
      seed: async (cloud) => {
        const post = (path: string, body: unknown, key: string) => ok(cloud.request({ method: 'POST', path, userId: OWNER, idempotencyKey: key, body }), key);
        for (let i = 56; i >= 1; i -= 1) {
          const d = day(-i);
          await post('/v1/sales', {
            saleId: `S-${i}`, receiptNumber: `R-${i}`, laneId: 'lane-1', locationId: 'br-1', cashierId: OWNER, tradingDay: d, committedAt: `${d}T06:00:00.000Z`,
            totalMinor: 1_000, currency: 'INR', packVersion: 1,
            lines: [{ productId: 'p-tea', quantityMinor: 10, uom: 'ea', unitPriceMinor: 100, lineTotalMinor: 1_000 }], tenders: [{ kind: 'cash', amountMinor: 1_000 }],
          }, `sale-${i}`);
        }
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await shop?.stop();
  });

  it('the manager records Pongal → "manager\'s estimate" → the forecast names it, with the correction and its back-test → weather off → withdrawn', async () => {
    const context = await browser.newContext();
    const errors: string[] = [];
    try {
      await shop.signIn(context, MGR, 'br-1');
      const page = await context.newPage();
      page.on('pageerror', (e) => { errors.push(String(e)); });
      await page.goto(`${shop.base}/demand-events`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { demandEvents?: unknown }).demandEvents !== undefined);

      // Refused before anything is sent: no store, then no effect.
      await page.click('#save');
      await expect.poll(() => page.textContent('#record-status')).toMatch(/Fill in the store first/);
      await page.fill('#store', 'br-1');
      await page.fill('#label', 'Pongal');
      await page.selectOption('#kind', 'festival');
      await page.fill('#ev-from', day(3));
      await page.fill('#ev-to', day(4));
      await page.click('#save');
      await expect.poll(() => page.textContent('#record-status')).toMatch(/expected effect/);
      await page.fill('#effect', '1.5');
      await page.click('#save');
      await expect.poll(() => page.textContent('#record-status')).toMatch(/Recorded/);
      await page.locator('#events li[data-event]').waitFor({ timeout: 15_000 });
      expect(await page.getAttribute('#events li[data-event]', 'data-basis')).toBe('manager_estimate');
      expect(await page.textContent('#events li[data-event]')).toMatch(/×1\.5 — manager's estimate/);
      expect(await page.getAttribute('#weather', 'data-state')).toBe('switched_off');
      expect(await page.textContent('#weather')).toMatch(/Weather is switched off/);

      // The forecast uses it with no extra step: each changed day names it; the correction and its back-test are beside it.
      await page.fill('#product', 'p-tea');
      await page.click('#forecast');
      await page.locator(`#forecast-rows tr[data-day="${day(3)}"]`).waitFor({ timeout: 15_000 });
      expect(await page.getAttribute(`#forecast-rows tr[data-day="${day(3)}"]`, 'data-events')).toBe('Pongal');
      expect(await page.getAttribute(`#forecast-rows tr[data-day="${day(1)}"]`, 'data-events')).toBe('');
      expect(Number(await page.locator(`#forecast-rows tr[data-day="${day(3)}"] td`).nth(1).textContent())).toBe(15);
      expect(Number(await page.locator(`#forecast-rows tr[data-day="${day(1)}"] td`).nth(1).textContent())).toBe(10);
      expect(await page.textContent('#backtest')).toMatch(/Correction from the last 7 days: ×1\. Back-test error over the last 7 days — plain forecast: 0\.0%; corrected: 0\.0%\./);

      // A withdrawal is a new fact; the next forecast no longer uses it.
      await page.fill('#events li[data-event] input.withdraw-reason', 'moved to next month');
      await page.click('#events li[data-event] button.withdraw');
      await expect.poll(() => page.textContent('#withdraw-status')).toMatch(/Withdrawn/);
      await expect.poll(() => page.locator('#events li[data-event]').count()).toBe(0);
      await page.click('#forecast');
      await expect.poll(() => page.getAttribute(`#forecast-rows tr[data-day="${day(3)}"]`, 'data-events')).toBe('');

      await page.click('#lang');
      expect(await page.textContent('#page-h')).toBe('கடை நிகழ்வுகள்');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 180_000);
});
