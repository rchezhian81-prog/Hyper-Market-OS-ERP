import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { alertText, alertWords, renderAlert } from '../../packages/ops/src/alert-words';

/**
 * **R3 · P-08 — the Store computers page shows a store computer whose machine keeps another time zone than the shop's, in a
 * real browser.** A stand-in head office answers the page's three reads (bindings, observed health, approvals); its observed
 * health carries each box's `zoneCheck` exactly as head office's real read gives it (proved against the real API in
 * tests/integration/a-store-computer-on-the-wrong-time-zone-is-told-to-head-office.test.ts).
 *
 *   • the summary counts the store computers on the wrong time zone and is marked for attention;
 *   • the Time zone table lists the wrong one FIRST, naming its zone, the shop's, and what to do, with the report's time;
 *   • a store computer that keeps the shop's zone reads "Keeps the shop's zone."; an old report is said to be old news;
 *   • nothing is written on open; Tamil; the page fits a 360 px phone with no sideways page scroll; no page errors.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const WEB_DIR = 'apps/web-erp/web';
const VIEWER = { userId: 'u-owner', permissions: ['platform.health.read', 'platform.alert.manage'] };

// OB-435 · OB-439: a refused report, with its words in both languages exactly as head office's observed read sends them
// (proved on the real API in tests/integration/a-box-cannot-hide-lost-bills-and-only-head-office-clears-a-refusal.test.ts).
const REFUSED_TEXT = alertText('box.refused', { head: alertText('box.refused.anotherStore', { storeId: 'br-1', by: 'u-box-br1', prefix: 'R-9-', through: 40 }), prefix: 'R-9-', others: [] });
const REFUSED = { kind: 'report_refused', prefix: 'R-9-', through: 40, since: '2026-10-26T05:00:00.000Z', detail: renderAlert(REFUSED_TEXT, 'en'), text: REFUSED_TEXT, words: alertWords(REFUSED_TEXT, '') };

const OBSERVED = { observed: { boxes: [
  { storeId: 'br-2', computer: 'u-box-br2', lastReportAt: '2026-10-26T04:59:00.000Z', stale: true, zoneCheck: { verdict: 'in_step', shopTimeZone: 'Asia/Kolkata', shopTimeZoneFrom: 'store_pack', machineTimeZone: 'Asia/Kolkata' } },
  { storeId: 'br-1', computer: 'u-box-br1', lastReportAt: '2026-10-26T05:00:00.000Z', stale: false, billNumberFindings: [REFUSED], zoneCheck: { verdict: 'differs', shopTimeZone: 'Asia/Kolkata', shopTimeZoneFrom: 'store_pack', machineTimeZone: 'UTC' } },
  { storeId: 'br-3', state: 'never_reported', zoneCheck: null },
] } };

describe.skipIf(!existsSync(CHROMIUM))('R3 · P-08: the Store computers page shows a store computer on the wrong time zone, in a real browser', () => {
  let browser: Browser;
  let server: Server;
  let base = '';
  const writes: string[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    server = createServer((req, res) => {
      void (async () => {
        const [path = '/'] = (req.url ?? '/').split('?');
        if (path.startsWith('/v1/')) {
          if (req.method !== 'GET') writes.push(`${req.method} ${path}`);
          const body = path === '/v1/store-computers/prefix-bindings' ? { bindings: [], replacements: [], you: { mayReplace: true, mayAcknowledge: true } }
            : path === '/v1/platform/operational-health/observed' ? OBSERVED
            : path === '/v1/approvals/requests' ? { mine: [] } : { error: { code: 'not_found', whatHappened: 'not here' } };
          res.writeHead(path === '/v1/store-computers/prefix-bindings' || path === '/v1/platform/operational-health/observed' || path === '/v1/approvals/requests' ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body));
          return;
        }
        const file = path === '/' ? 'store-computers.html' : path.replace(/^\//, '');
        try {
          let out = (await readFile(join(WEB_DIR, file))).toString('utf8');
          if (file.endsWith('.html')) out = out.replace('<!--SCREEN-DATA-->', `<script>window.storeComputersData = ${JSON.stringify(VIEWER)};</script>`);
          const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
          res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' }).end(out);
        } catch { res.writeHead(404).end('not found'); }
      })();
    });
    await new Promise<void>((r) => { server.listen(0, '127.0.0.1', () => r()); });
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`;
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); server?.close(); });

  const says = (page: Page, selector: string, words: string) =>
    page.waitForFunction(([s, w]) => ((globalThis as unknown as { document: { querySelector(q: string): { textContent: string | null } | null } }).document.querySelector(s)?.textContent ?? '').includes(w), [selector, words] as const, { timeout: 15_000 });

  it('counts and lists the wrong one first, in words; keeps-the-zone and old news are said; Tamil; fits a phone; writes nothing', async () => {
    const context = await browser.newContext({ viewport: { width: 360, height: 760 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${base}/`, { waitUntil: 'load' });
      await page.locator('#zone-rows tr[data-store="br-1"][data-verdict="differs"]').waitFor({ timeout: 15_000 });
      await says(page, '#v-zones', '1');
      expect(await page.getAttribute('#p-zones', 'class')).toContain('attention');
      const rows = page.locator('#zone-rows tr');
      expect(await rows.count()).toBe(2);
      expect(await rows.first().getAttribute('data-store')).toBe('br-1');
      await says(page, '#zone-rows tr[data-store="br-1"]', 'UTC');
      await says(page, '#zone-rows tr[data-store="br-1"]', 'NOT the shop\'s zone — ask IT to set it to Asia/Kolkata');
      await says(page, '#zone-rows tr[data-store="br-1"]', 'u-box-br1');
      await says(page, '#zone-rows tr[data-store="br-2"]', 'Keeps the shop\'s zone.');
      await says(page, '#zone-rows tr[data-store="br-2"]', 'Old news');
      await says(page, '#zones-h', 'Time zone');
      // OB-435: the "Needs a person" finding reads in English…
      await says(page, '#finding-rows', 'but head office issued R-9- to a till of ANOTHER store');
      expect(writes, 'nothing is written on open').toEqual([]);
      const sideways = await page.evaluate(() => { const d = (globalThis as unknown as { document: { documentElement: { scrollWidth: number; clientWidth: number } } }).document.documentElement; return d.scrollWidth - d.clientWidth; });
      expect(sideways).toBeLessThanOrEqual(0);
      await page.click('#lang');
      await says(page, '#zones-h', 'நேர மண்டலம்');
      await says(page, '#zone-rows tr[data-store="br-1"]', 'கடையின் மண்டலம் அல்ல');
      // …and in Tamil after the language button (OB-439).
      await says(page, '#finding-rows', 'R-9- ஐ வேறு கடையின் கவுண்டருக்கு வழங்கியுள்ளது');
      expect(await page.textContent('#finding-rows')).not.toContain('ANOTHER store');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 60_000);
});
