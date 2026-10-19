import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * EA-07 (R4, signed OB-227 · OB-222) — the Morning brief page, in a real browser, on the PRODUCTION API over real
 * PostgreSQL: "The morning brief is still prepared every day, but its sending is a switched-off link with a test
 * stand-in. Nothing is sent while switched off, and the brief's screen says it was not sent."
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['brief', 'e2e', 'key'].join('-').padEnd(48, '0');

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Morning brief page (EA-07) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/morning-brief', html: 'morning-brief.html', dataGlobal: 'morningBriefData' },
      seed: async (cloud) => {
        const req = (method: 'POST' | 'PUT', path: string, body: unknown, key: string) => ok(cloud.request({ method, path, userId: OWNER, idempotencyKey: key, body }), key);
        await req('PUT', '/v1/platform/setup/locale.time_zone', { value: 'UTC' }, 'tz');
        const today = new Date().toISOString().slice(0, 10);
        await req('POST', '/v1/sales', {
          saleId: 'S-brief', receiptNumber: 'R-1', laneId: 'lane-1', locationId: 'br-1', cashierId: OWNER, tradingDay: today,
          committedAt: new Date().toISOString(), totalMinor: 123_400, currency: 'INR', packVersion: 1,
          lines: [{ productId: 'P-X', quantityMinor: 1, uom: 'ea', unitPriceMinor: 123_400, lineTotalMinor: 123_400 }], tenders: [{ kind: 'cash', amountMinor: 123_400 }],
        }, 'sale');
        await req('POST', '/v1/reporting/brief-schedule', { dueAt: [0, 0] }, 'schedule');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await shop?.stop();
  });

  it('a run prepares the brief and sends nothing; the page shows it and says "Not sent" — sending switched off', async () => {
    // The scheduler's pass, as the worker runs it: prepared, not sent.
    const run = (await shop.cloud().request({ method: 'POST', path: '/v1/reporting/brief-schedule/run', userId: OWNER, idempotencyKey: 'run', body: {} })).body as { ran: { outcome: string }[] };
    expect(run.ran.map((r) => r.outcome)).toEqual(['composed_not_sent']);

    const context = await browser.newContext();
    const errors: string[] = [];
    try {
      await shop.signIn(context, OWNER);
      const page = await context.newPage();
      page.on('pageerror', (e) => { errors.push(String(e)); });
      await page.goto(`${shop.base}/morning-brief`, { waitUntil: 'load' });
      await page.locator('#brief-section:not([hidden])').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#sent-v')).toBe('Not sent');
      expect(await page.getAttribute('#sent-detail', 'data-sending')).toBe('switched_off');
      expect(await page.textContent('#sent-detail')).toMatch(/Prepared, NOT sent: sending is switched off \(OB-222\)/);
      expect(await page.locator('#lines li').count()).toBeGreaterThan(0);
      expect(await page.textContent('#lines')).toMatch(/1,234/);
      await page.click('#lang');
      expect(await page.textContent('#sent-v')).toBe('அனுப்பப்படவில்லை');
      expect(errors).toEqual([]);
    } finally { await context.close(); }

    // The day was not marked sent.
    const schedule = (await shop.cloud().request({ method: 'GET', path: '/v1/reporting/brief-schedule', userId: OWNER })).body as { schedule: { sentDays: string[] } };
    expect(schedule.schedule.sentDays).toEqual([]);
    // A manager does not read the owner's brief.
    expect((await shop.cloud().request({ method: 'GET', path: '/v1/reporting/brief-today', userId: MGR })).status).toBe(403);
  }, 180_000);
});
