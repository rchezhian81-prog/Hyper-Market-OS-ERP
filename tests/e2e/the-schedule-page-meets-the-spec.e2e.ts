import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';

/**
 * D-9 (R3, OB-142 "A", OB-181) — the Staff schedule page, in a real browser, on the PRODUCTION API over real PostgreSQL:
 * staff needed per hour from eight weeks of the shop's own hourly sales; the Shops Act limits shown — two filled by the CA
 * and in force, the rest "not filled in yet — not checked" (never a made-up number); a draft roster within those limits
 * with every uncovered slot by name; the labour cost reported (a person with no rate named, not costed at zero) and never
 * capped; the manager's commit; and actual attendance against the roster. A week that is not a Monday is refused.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['schedule', 'e2e', 'key'].join('-').padEnd(48, '0');
const WEEK = '2026-10-05';
const IST = 330;
const at = (date: string, hhmm: string) => new Date(Date.parse(`${date}T${hhmm}:00Z`) - IST * 60_000).toISOString();
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Staff schedule page (D-9) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/schedule', html: 'schedule.html', dataGlobal: 'scheduleData' },
      seed: async (cloud) => {
        const post = (path: string, body: unknown, key: string) => ok(cloud.request({ method: 'POST', path, userId: OWNER, idempotencyKey: key, body }), key);
        for (const [id, name, rate] of [['u-anu', 'Anu', 10_000], ['u-bala', 'Bala', undefined], ['u-chitra', 'Chitra', 12_000]] as const) {
          await post(`/v1/hr/workforce/employees/${id}`, { name, branchId: 'S1', roles: ['cashier'], active: true, ...(rate === undefined ? {} : { hourlyRateMinor: rate }) }, `emp-${id}`);
        }
        let n = 0;
        for (let i = 56; i >= 1; i--) {
          const day = addDays(WEEK, -i);
          for (const hhmm of ['10:15', '18:05', '18:40']) {
            n += 1;
            await post('/v1/sales', {
              saleId: `S-${n}`, receiptNumber: `R-${n}`, laneId: 'lane-1', locationId: 'S1', cashierId: OWNER, tradingDay: day, committedAt: at(day, hhmm),
              totalMinor: 1_000, currency: 'INR', packVersion: 1,
              lines: [{ productId: 'p-tea', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1_000, lineTotalMinor: 1_000 }], tenders: [{ kind: 'cash', amountMinor: 1_000 }],
            }, `sale-${n}`);
          }
        }
        await post('/v1/hr/workforce/labour-standards/cashier', { billsPerStaffHour: 1 }, 'std-cashier');
        for (const [k, v] of [['weeklyHolidayMinDays', 1], ['maxWeeklyWorkMinutes', 300]] as const) {
          await post(`/v1/hr/compliance/working-time/settings/${k}`, { value: v, source: 'synthetic provision', confirmation: 'synthetic CA reference' }, `limit-${k}`);
        }
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await shop?.stop();
  });

  it('forecast → limits (in force / not checked) → draft with named gaps and reported cost → manager commits → actual against roster', async () => {
    const context = await browser.newContext();
    const errors: string[] = [];
    try {
      await shop.signIn(context, OWNER);
      const page = await context.newPage();
      page.on('pageerror', (e) => { errors.push(String(e)); });
      await page.goto(`${shop.base}/schedule`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { schedule?: unknown }).schedule !== undefined);
      expect(await page.isHidden('#draft-section')).toBe(true); // nothing drafted on open

      // A week that is not a Monday is refused before anything is sent.
      await page.fill('#branch', 'S1');
      await page.fill('#week', '2026-10-06');
      await page.click('#show');
      await expect.poll(() => page.textContent('#page-status')).toMatch(/pick a Monday/);

      await page.fill('#week', WEEK);
      await page.click('#show');
      await page.locator('#hours .panel[data-role="cashier"]').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#hours .panel[data-role="cashier"] .v')).toBe('21 staff hours');
      expect(await page.locator(`#demand-rows tr[data-date="${WEEK}"][data-hour="18"] td`).nth(3).textContent()).toBe('2');
      // The limits: two in force, the rest said as not filled in — never given a number.
      expect(await page.getAttribute('#limits li[data-key="maxWeeklyWorkMinutes"]', 'data-status')).toBe('in_force');
      expect(await page.getAttribute('#limits li[data-key="maxDailyWorkMinutes"]', 'data-status')).toBe('pending');
      expect(await page.textContent('#limits li[data-key="maxDailyWorkMinutes"]')).toMatch(/not filled in yet — not checked/);

      await page.click('#draft');
      await page.locator('#draft-section:not([hidden])').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#draft-state')).toMatch(/Nothing is rostered until a manager commits it/);
      expect(await page.locator('#uncovered li[data-uncovered]').count()).toBe(6);
      expect(await page.locator('#uncovered li[data-uncovered]').first().textContent()).toMatch(/needs one more cashier/);
      expect(await page.textContent('#breaches li')).toBe('No rule is broken.');
      expect(await page.getAttribute('#cost li[data-employee="u-bala"]', 'data-costed')).toBe('false');
      expect(await page.textContent('#cost li[data-employee="u-bala"]')).toMatch(/no hourly rate on file — not costed/);
      expect(await page.textContent('#cost li[data-employee="u-anu"]')).toMatch(/₹500\.00/);
      // The draft rostered nobody yet.
      expect(((await shop.cloud().request({ method: 'GET', path: '/v1/hr/workforce/roster', userId: OWNER })).body as { assignments: unknown[] }).assignments).toEqual([]);

      await page.click('#commit');
      await expect.poll(() => page.textContent('#commit-status')).toMatch(/Committed to the roster by u-owner/);
      expect(await page.isDisabled('#commit')).toBe(true);
      expect(((await shop.cloud().request({ method: 'GET', path: '/v1/hr/workforce/roster', userId: OWNER })).body as { assignments: unknown[] }).assignments).toHaveLength(15);

      await page.click('#actuals');
      await page.locator('#actuals-section:not([hidden])').waitFor({ timeout: 15_000 });
      expect(await page.locator('#actual-rows tr[data-status="not_recorded"]').count()).toBe(15);
      expect(await page.locator('#actual-rows tr[data-status="not_recorded"]').first().textContent()).toMatch(/not recorded/);

      await page.click('#lang');
      expect(await page.textContent('#page-h')).toBe('பணியாளர் அட்டவணை');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 180_000);
});
