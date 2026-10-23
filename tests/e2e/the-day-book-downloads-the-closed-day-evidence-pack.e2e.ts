import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { sealedDayReopen } from '../support/store-seal';
import { auditPage } from './lib/a11y-audit';

/**
 * **M14-FR-04 — the accountant's day-book screen downloads the closed-day evidence pack for the CA, in a real browser, on
 * the PRODUCTION API over real PostgreSQL.**
 *
 *   • the day closed at store br-1 shows "Closed and locked" with two buttons, each an icon beside its word;
 *   • "Download CSV for the CA" saves a CSV whose last row is the seal head office computed (the same hash its own read
 *     gives) and whose cash rows carry the till's short; "Download JSON" saves the sealed pack itself;
 *   • a day reopened and not closed again shows "Reopened — not final", and its download says NOT FINAL;
 *   • a day nobody closed says so; the Tamil words show.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const SIGN = ['day', 'evidence', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const B1 = 'br-1';
const DAY = '2026-10-20';
const REOPENED_DAY = '2026-10-21';
type Doc = { document: { getElementById(i: string): { textContent: string | null } | null } };

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the day book downloads the closed-day evidence pack (M14-FR-04)', () => {
  let browser: Browser;
  let shop: InboxShop;
  let tenantId: string;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    tenantId = randomUUID();
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId, signingKey: SIGN,
      page: { path: '/day-book', html: 'day-book.html', dataGlobal: 'dayBookData' },
      seed: async (cloud) => {
        // Lane-1's shift closed ₹5 short with a reason, then the day closed; another day closed and was reopened.
        await ok(cloud.request({ method: 'POST', path: '/v1/shifts/SH-1/close/synced', userId: OWNER, idempotencyKey: 'sh-1', body: {
          tillId: 'lane-1', laneId: 'lane-1', cashierId: 'u-cash', tradingDay: DAY, storeId: B1, openedAt: `${DAY}T03:00:00.000Z`, closedAt: `${DAY}T15:00:00.000Z`,
          openingFloatMinor: 50_000, cashSalesMinor: 10_000, pickupsMinor: 0, cashRefundsMinor: 0, toleranceMinor: 100, reasonCode: 'counting_error',
          countedMinor: 59_500, expectedMinor: 60_000, varianceMinor: -500, exceptionRaised: true,
        } }), 'shift close');
        for (const [id, day, at] of [['dc-20', DAY, `${DAY}T18:00:00.000Z`], ['dc-21', REOPENED_DAY, `${REOPENED_DAY}T18:00:00.000Z`]] as const) {
          await ok(cloud.request({ method: 'POST', path: `/v1/pos/day-close/${id}/synced`, userId: OWNER, idempotencyKey: id, body: { storeId: B1, tradingDay: day, closedBy: OWNER, closedAt: at } }), `close ${id}`);
        }
        await ok(cloud.request({ method: 'POST', path: '/v1/pos/day-close/dc-21/reopen/synced', userId: OWNER, idempotencyKey: 'reopen-21', body: sealedDayReopen(tenantId, 'dc-21', { reopenedBy: OWNER, approvedBy: 'u-acct', reason: 'late supplier credit note' }) }), 'reopen');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const says = (page: Page, id: string, re: RegExp) => page.waitForFunction(([i, src]) => new RegExp(src!).test((globalThis as unknown as Doc).document.getElementById(i!)?.textContent ?? ''), [id, re.source], { timeout: 15_000 });
  const showDay = async (page: Page, day: string) => { await page.fill('#day', day); await page.click('#load'); };

  it('locked day: CSV and JSON downloads carry head office\'s seal; a reopened day is NOT FINAL; an unclosed day says so; Tamil', async () => {
    const context = await browser.newContext({ acceptDownloads: true });
    await shop.signIn(context, OWNER);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${shop.base}/day-book`, { waitUntil: 'load' });
      await showDay(page, DAY);
      await page.locator('#ev-dc-20').waitFor({ timeout: 15_000 });
      await says(page, 'evidence-heading', /Evidence pack for the CA/);
      expect(await page.locator('#ev-dc-20').textContent()).toContain('Closed and locked');
      for (const id of ['#ev-csv-dc-20', '#ev-json-dc-20']) expect(await page.locator(`${id} svg`).count(), `${id} has its icon beside the word`).toBe(1);
      expect(await page.locator('#ev-csv-dc-20').textContent()).toBe('Download CSV for the CA');

      const sealed = (await shop.cloud().request({ method: 'GET', path: '/v1/pos/day-close/dc-20/evidence-pack', userId: OWNER })).body as { pack: { contentHash: string } };
      const [csv] = await Promise.all([page.waitForEvent('download'), page.click('#ev-csv-dc-20')]);
      expect(csv.suggestedFilename()).toBe(`day-evidence-${B1}-${DAY}-${sealed.pack.contentHash.slice(0, 12)}.csv`);
      const csvText = readFileSync((await csv.path())!, 'utf8');
      expect(csvText).toContain('cash,over/short,-5.00,');
      expect(csvText.trimEnd().split('\r\n').at(-1)).toBe(`seal,sha256,,${sealed.pack.contentHash}`);
      await says(page, 'evidence-state-text', /^Downloaded: day-evidence-br-1-2026-10-20-[0-9a-f]{12}\.csv · Seal [0-9a-f]{12}…$/);
      const [json] = await Promise.all([page.waitForEvent('download'), page.click('#ev-json-dc-20')]);
      expect((JSON.parse(readFileSync((await json.path())!, 'utf8')) as { contentHash: string }).contentHash).toBe(sealed.pack.contentHash);
      expect(await auditPage(page, { expectLang: 'en' }), 'the day book with the evidence pack').toEqual([]);

      await showDay(page, REOPENED_DAY);
      await page.locator('#ev-dc-21').waitFor({ timeout: 15_000 });
      expect(await page.locator('#ev-dc-21').textContent()).toContain('Reopened — not final');
      await Promise.all([page.waitForEvent('download'), page.click('#ev-csv-dc-21')]);
      await says(page, 'evidence-state-text', /NOT FINAL — the day was reopened and not closed again/);

      await showDay(page, '2026-10-22');
      await says(page, 'evidence-state-text', /No store has closed this day yet/);
      await page.click('#lang');
      await says(page, 'evidence-heading', /பட்டயக் கணக்காளருக்கான சான்று தொகுப்பு/);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 120_000);
});
