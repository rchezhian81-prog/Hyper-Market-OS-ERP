import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';

/**
 * **UX-1b on the RENDERED page: the till and a handheld wear the one light look, and say a new version the way the
 * back office does (OB-13 "A", OB-14 "c"; P-08; design system §3.2).**
 *
 * The static guardrail (tests/guardrails/every-shell-outside-the-back-office-wears-the-look.test.ts) proves the files;
 * this proves what a cashier and a picker SEE in real Chromium, at the till's and a cheap phone's size:
 *
 *   • the page is on the light canvas (`--bg`, rgb(243, 245, 244)) with no theme pin, and its words are the dark ink;
 *   • nothing on the page fails WCAG AA at the shell's own target bar — the palette moved, the targets did not;
 *   • the "new version" strip is NOT shown on the first controller (a first install is not news), IS shown on the
 *     next, says it in English and then in Tamil when the language flips, carries a button at the shell's target
 *     height, and the whole page still passes the audit with the strip on it;
 *   • the strip is a status region, so a screen reader hears it without the page moving.
 *
 * The service worker is blocked in this context, so the two controller changes are dispatched by hand — the same
 * event the browser fires when a new worker takes over.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const LIGHT_CANVAS = 'rgb(243, 245, 244)';
const INK = 'rgb(37, 54, 46)';

interface Shell { readonly app: string; readonly viewport: { width: number; height: number }; readonly target: number; readonly inject?: string }

const TILL: Shell = { app: 'pos', viewport: { width: 1024, height: 768 }, target: 56 };
const PICKER: Shell = {
  app: 'picker-app', viewport: { width: 360, height: 640 }, target: 56,
  inject: `<script>window.pickerData = ${JSON.stringify({
    waveId: 'W-1', pickerId: 'u-picker', orderedBy: 'shelf order',
    lines: [{ lineId: 'l1', orderRef: 'ORD-1', productId: 'MILK', description: 'Aavin Milk 1L', bin: 'A-01', requiredQty: 2, uom: 'ea', unitPrice: { minor: 6000, currency: 'INR' } }],
  })};</script>`,
};

async function serve(shell: Shell): Promise<{ base: string; stop: () => Promise<void> }> {
  const dir = join('apps', shell.app, 'web');
  const server: Server = createServer((req, res) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const file = path === '/' || path === '/index.html' ? 'index.html' : path.replace(/^\//, '');
      try {
        let text = (await readFile(join(dir, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.webmanifest') ? 'application/manifest+json' : 'application/octet-stream';
        if (file === 'index.html' && shell.inject !== undefined) text = text.replace('<!--SCREEN-DATA-->', shell.inject);
        res.writeHead(200, { 'content-type': type });
        res.end(text);
      } catch {
        res.writeHead(404);
        res.end();
      }
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

describe.skipIf(!HAVE_BROWSER)('the till and a handheld wear the light look and say a new version (UX-1b)', () => {
  let browser: Browser;
  const open: { ctx: BrowserContext; stop: () => Promise<void> }[] = [];

  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: CHROMIUM }); });
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const o of open.splice(0)) { await o.ctx.close(); await o.stop(); } });

  async function openShell(shell: Shell): Promise<Page> {
    const srv = await serve(shell);
    const ctx = await browser.newContext({ viewport: shell.viewport, hasTouch: shell.viewport.width < 600, serviceWorkers: 'block' });
    open.push({ ctx, stop: srv.stop });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    expect(errors, `${shell.app} threw on load`).toEqual([]);
    return page;
  }

  const controllerChange = (page: Page) => page.evaluate('navigator.serviceWorker.dispatchEvent(new Event("controllerchange"))');

  for (const shell of [TILL, PICKER]) {
    it(`${shell.app} — on the light canvas with no pin, AA-clean at its own ${shell.target}px bar; the strip shows on the SECOND controller, in both languages, and keeps the page AA-clean`, async () => {
      const page = await openShell(shell);
      expect(await page.evaluate('document.documentElement.getAttribute("data-theme")')).toBeNull();
      expect(await page.evaluate('getComputedStyle(document.body).backgroundColor')).toBe(LIGHT_CANVAS);
      expect(await page.evaluate('getComputedStyle(document.body).color')).toBe(INK);
      expect(await auditPage(page, { minTarget: shell.target }), `${shell.app} before the strip`).toEqual([]);

      // the first controller is the first install — not news
      await controllerChange(page);
      expect(await page.locator('#sre-update').count(), 'no strip on the first controller').toBe(0);
      // the second is a new version taking over the open page — said, not done
      await controllerChange(page);
      const strip = page.locator('#sre-update');
      await expect.poll(() => strip.count()).toBe(1);
      expect(await strip.getAttribute('role')).toBe('status');
      expect(await strip.locator('span').textContent()).toBe('A newer version of this screen has arrived. Reload when you are ready.');
      expect(await strip.locator('button').textContent()).toBe('Reload');
      const button = await strip.locator('button').boundingBox();
      expect(button!.height, 'the Reload button is a real target').toBeGreaterThanOrEqual(shell.target - 0.5);
      expect(await auditPage(page, { minTarget: shell.target }), `${shell.app} with the strip`).toEqual([]);

      // the language switch flips <html lang>; the strip follows without a reload
      await page.evaluate('document.documentElement.lang = "ta"');
      await expect.poll(() => strip.locator('button').textContent()).toBe('மீண்டும் ஏற்று');
      expect(await strip.locator('span').textContent()).toBe('இந்தத் திரையின் புதிய பதிப்பு வந்துள்ளது. தயாரானதும் மீண்டும் ஏற்றவும்.');

      // the page did not reload by itself: the strip is still there and the URL is unchanged
      expect(await page.evaluate('performance.getEntriesByType("navigation").length')).toBe(1);
    });
  }

  it('the Reload button reloads — the person chooses the moment', async () => {
    const page = await openShell(TILL);
    await controllerChange(page);
    await controllerChange(page);
    await expect.poll(() => page.locator('#sre-update').count()).toBe(1);
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.locator('#sre-update button').click()]);
    expect(await page.locator('#sre-update').count(), 'a fresh load has no strip').toBe(0);
    expect(await page.evaluate('getComputedStyle(document.body).backgroundColor')).toBe(LIGHT_CANVAS);
  });
});
