import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';

/**
 * **U6 — the three stock pages (Stock ledger, Quarantine, Adjust a quantity) switch to Tamil without a page error and fit
 * the screen, served exactly as the rendered sweep serves every office page (tests/e2e/the-erp-pages-meet-the-spec.e2e.ts):
 * the page's own files, with NO screen data, then with a signed-in manager's identity (design system §1 rules 6–8 · NFR-08).**
 *
 * Found by Group P3's sweep (12 Nov 2026): with no screen data the pages had no session, so the toggle had no listener (the
 * sweep timed out waiting for Tamil) and the bilingual helper read a null session (a page error); and the adjustment page
 * measured wider than the desk. At 1280px and at 360px: no page error, the toggle reaches Tamil and offers "English", and
 * nothing reaches past the viewport. Without a browser binary it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const WEB = 'apps/web-erp/web';
const PAGES = ['stock-ledger.html', 'quarantine.html', 'stock-adjustments.html'] as const;
const DATA: Record<string, string> = { 'stock-ledger.html': 'stockLedgerData', 'quarantine.html': 'quarantineData', 'stock-adjustments.html': 'stockAdjustmentsData' };
const MANAGER = { userId: 'u-mgr', permissions: ['inventory.availability.read', 'inventory.movement.append', 'inventory.adjustment.approve', 'quality.hold.manage', 'quality.hold.release'] };

function serve(withViewer: boolean): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const file = (req.url ?? '/').split('?')[0]!.replace(/^\//, '');
      try {
        let text = (await readFile(join(WEB, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        if (file.endsWith('.html')) text = text.replace('<!--SCREEN-DATA-->', withViewer ? `<script>window.${DATA[file]} = ${JSON.stringify(MANAGER)};</script>` : '');
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' }); res.end(text);
      } catch { res.writeHead(404); res.end('not found'); }
    })();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const a = server.address(); const port = typeof a === 'object' && a !== null ? a.port : 0;
    resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((d) => { server.close(() => d()); server.closeAllConnections(); }) });
  }));
}

const overflow = `(() => {
  const w = document.documentElement.clientWidth;
  const out = document.documentElement.scrollWidth > w + 1 ? ['document scrollWidth=' + document.documentElement.scrollWidth] : [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.sre-scroll-x')) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > w + 1 && !Array.from(el.children).some((c) => c.getBoundingClientRect().right > w + 1)) out.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' right=' + Math.round(r.right));
  }
  return out.slice(0, 8);
})()`;

describe.skipIf(!existsSync(CHROMIUM))('the three stock pages switch to Tamil and fit, with or without a viewer (U6)', () => {
  let browser: Browser;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });

  for (const withViewer of [false, true]) {
    for (const width of [1280, 360]) {
      it(`${withViewer ? 'a signed-in manager' : 'no screen data'} at ${width}px: no page error, Tamil on the toggle, nothing past the viewport`, async () => {
        const srv = await serve(withViewer);
        const context = await browser.newContext({ viewport: { width, height: 800 } });
        try {
          for (const file of PAGES) {
            const page = await context.newPage();
            const errors: string[] = [];
            page.on('pageerror', (e) => errors.push(e.message));
            await page.goto(`${srv.base}/${file}`, { waitUntil: 'load' });
            await page.waitForFunction('globalThis.sreChrome !== undefined', undefined, { timeout: 15_000 });
            expect(await page.evaluate(overflow), `${file} at ${width}px in English`).toEqual([]);
            await page.click('#lang');
            await page.waitForFunction('document.documentElement.lang === "ta"', undefined, { timeout: 5_000 });
            expect(await page.textContent('#lang'), `${file}: the toggle offers the way back`).toBe('English');
            expect(await page.evaluate(overflow), `${file} at ${width}px in Tamil`).toEqual([]);
            expect(errors, `${file} threw`).toEqual([]);
            await page.close();
          }
        } finally { await context.close(); await srv.stop(); }
      }, 120_000);
    }
  }
});
