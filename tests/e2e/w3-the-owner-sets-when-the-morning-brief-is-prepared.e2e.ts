import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { openAs } from './lib/w3-page';
import { says } from './lib/r4c-box-page';

/**
 * **W3 · D13-FR-01..06 (EA-07 · OB-222): the owner sets when the morning brief is prepared, on the Morning brief page, in a
 * real browser, on the PRODUCTION API over real PostgreSQL.** Before anyone sets it the page says no schedule is set —
 * never a made-up time; a time that is not a time is refused before anything is sent; the owner sets 07:30, in Tamil, with
 * a 90-minute stale warning; head office holds exactly that, and the page reads it back after a reload. Sending to a phone
 * stays switched off (OB-222), and the page says so.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['w3', 'brief', 'key'].join('-').padEnd(48, '0');

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Morning brief schedule (D13) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/morning-brief', html: 'morning-brief.html', dataGlobal: 'morningBriefData' },
      seed: async () => {},
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('not set until the owner sets it; 07:30 in Tamil with a 90-minute warning is what head office then holds', async () => {
    const s = await openAs(shop, browser, OWNER, '/morning-brief');
    try {
      await says(s.page, '#schedule-now', /^No schedule is set yet — choose a time and save\.$/);
      await says(s.page, '#schedule-note', /nothing is sent until then/);
      await s.page.fill('#sch-stale', 'soon');
      await s.page.fill('#sch-time', '07:30');
      await s.page.click('#sch-save');
      await says(s.page, '#schedule-status', /^Type the minutes as a whole number above 0/);
      expect(s.writes).toEqual([]);
      await s.page.selectOption('#sch-lang', 'ta'); await s.page.fill('#sch-stale', '90');
      await s.page.click('#sch-save');
      await says(s.page, '#schedule-status', /^Saved\. The brief is prepared at 07:30\.$/);
      await says(s.page, '#schedule-now', /^Set to 07:30 · Tamil · 90 min · 0 days already sent$/);
      expect(s.writes).toEqual(['POST /v1/reporting/brief-schedule']);
      await s.page.reload({ waitUntil: 'load' });
      await says(s.page, '#schedule-now', /^Set to 07:30 · Tamil · 90 min/);
      expect(await s.page.inputValue('#sch-time')).toBe('07:30');
      await s.page.click('#lang');
      await says(s.page, '#schedule-h', /^சுருக்கம் தயாராகும் நேரம்$/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const held = (await shop.cloud().request({ method: 'GET', path: '/v1/reporting/brief-schedule', userId: OWNER })).body as { schedule: { dueAt: number[]; language: string; staleAfterMinutes: number } };
    expect(held.schedule).toMatchObject({ dueAt: [7, 30], language: 'ta', staleAfterMinutes: 90 });
  }, 240_000);
});
