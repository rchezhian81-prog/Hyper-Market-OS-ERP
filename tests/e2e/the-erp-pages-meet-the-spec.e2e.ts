import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage, type A11yFinding } from './lib/a11y-audit';

/**
 * **The ERP's forty-six pages, one product, audited on the rendered page (Stage G slice 5a · design system §1 rules
 * 4 · 6 · 7 · 8, §5, §7 · NFR-07 / NFR-08).**
 *
 * Every page the store computer serves to the office, opened in real Chromium at a desk (1280) and on a phone (360),
 * in English and — where the page has the toggle — in Tamil, and put through the same audit as the till, the
 * customer app and the handhelds: contrast, targets, names, labels, the page language, one heading, no sideways
 * scroll. Zero findings on all of them. Then the chrome itself, on a page: the badge says "not connected" with no
 * store computer named, "Connected · last contact HH:MM" when one answers, "not answering" when it stops; the cache
 * strip appears with the time when the service worker stamps the page; the toggle says what you get, in the other
 * language; all in Tamil too.
 *
 * Served statically with no store computer — every page then runs on its announced sample data — because the audit
 * is of the page's own words and controls; the payloads' truth is each page's own e2e.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';
const PAGES = readdirSync(WEB_DIR).filter((f) => f.endsWith('.html')).sort();
const DESK = { viewport: { width: 1280, height: 800 } };
const PHONE = { viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true };

/** The store box's proxy, minus the box: the page's files, with an optional store-computer address named. */
async function serve(laneWriteBase?: string): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const file = path === '/' ? 'index.html' : path.replace(/^\//, '');
      try {
        let text = (await readFile(join(WEB_DIR, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.webmanifest') ? 'application/manifest+json' : 'application/octet-stream';
        if (file.endsWith('.html') && laneWriteBase !== undefined) text = text.replace('<!--SCREEN-DATA-->', `<script>window.laneWriteBase = ${JSON.stringify(laneWriteBase)};</script>`);
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(text);
      } catch {
        res.writeHead(404); res.end('not found');
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

/** A stand-in for the store computer's `GET /lane/sync-status` — the route the till badge is proven against. */
async function laneStub(): Promise<{ base: string; stop: () => Promise<void> }> {
  const at = new Date(Date.now() - 120_000).toISOString();
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ cloud: 'online', unsent: 0, deadLettered: 0, lastSentAt: at, lastContactAt: at, now: new Date().toISOString(), staffMessage: '' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

describe.skipIf(!HAVE_BROWSER)('the ERP\'s forty-six pages, audited on the rendered page', () => {
  let browser: Browser;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  // Torn down in REVERSE order: the browser context first, then the servers it was talking to. A stub server
  // closed while Chromium still holds a keep-alive connection to it waits for that connection — once, in a full
  // gate, for longer than the hook timeout — so the client goes first and any lingering socket is closed outright.
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  async function open(file: string, device: typeof DESK | typeof PHONE, laneWriteBase?: string): Promise<Page> {
    const srv = await serve(laneWriteBase);
    stops.push(srv.stop);
    const context = await browser.newContext(device);
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${srv.base}/${file}`, { waitUntil: 'load' });
    await page.waitForFunction('globalThis.sreChrome !== undefined', undefined, { timeout: 15_000 });
    expect(errors, `${file} threw while opening`).toEqual([]);
    return page;
  }

  it('every page passes at a desk and on a phone, in English and in Tamil — zero findings', async () => {
    const found: Record<string, A11yFinding[]> = {};
    for (const device of [DESK, PHONE]) {
      const srv = await serve();
      const context = await browser.newContext(device);
      const width = device.viewport.width;
      for (const file of PAGES) {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`${srv.base}/${file}`, { waitUntil: 'load' });
        await page.waitForFunction('globalThis.sreChrome !== undefined', undefined, { timeout: 15_000 });
        const en = await auditPage(page, { expectLang: 'en' });
        if (errors.length > 0) en.push({ rule: 'pageerror', selector: file, detail: errors.join(' | ') });
        if (en.length > 0) found[`${file}@${width}`] = en;
        if ((await page.$('#lang')) !== null) {
          await page.click('#lang');
          await page.waitForFunction('document.documentElement.lang === "ta"', undefined, { timeout: 5_000 });
          const ta = await auditPage(page, { expectLang: 'ta' });
          if (ta.length > 0) found[`${file}@${width}/ta`] = ta;
          // The toggle now offers the way back, in the language just left.
          expect(await page.textContent('#lang'), `${file}: the toggle after switching to Tamil`).toBe('English');
        }
        await page.close();
      }
      await context.close();
      await srv.stop();
    }
    expect(found).toEqual({});
  }, 300_000);

  it('the badge tells the truth on an ERP page: not connected · connected with last contact · not answering — and in Tamil', async () => {
    const alone = await open('counts.html', DESK);
    expect(await alone.textContent('#conn-text')).toBe('Not connected to the store computer');
    expect(await alone.getAttribute('#conn-dot', 'class')).toContain('idle');

    const lane = await laneStub();
    stops.push(lane.stop);
    const page = await open('counts.html', DESK, lane.base);
    await page.waitForFunction('document.getElementById("conn-text").textContent.startsWith("Connected")');
    expect(await page.textContent('#conn-text')).toMatch(/^Connected · last contact \d{2}:\d{2}/);
    expect(await page.getAttribute('#conn-dot', 'class')).not.toMatch(/error|idle|degraded/);

    await page.evaluate('globalThis.laneWriteBase = "http://127.0.0.1:1"');
    await page.evaluate('globalThis.sreChrome.badge.refresh()');
    expect(await page.textContent('#conn-text')).toBe('Store computer not answering');
    expect(await page.getAttribute('#conn-dot', 'class')).toContain('error');

    await page.click('#lang');
    await page.waitForFunction('document.documentElement.lang === "ta"');
    expect(await page.textContent('#conn-text')).toBe('கடை கணினி பதிலளிக்கவில்லை');
    expect(await page.textContent('#lang')).toBe('English');
  });

  it('a page served from the device\'s cache says so, with the time, in both languages — and the manager\'s says not to close the day on it', async () => {
    const page = await open('waste.html', PHONE);
    expect(await page.evaluate('document.getElementById("stale").hidden')).toBe(true);
    await page.evaluate('globalThis.shellCachedAt = "2026-09-30T08:15:00Z"; globalThis.sreChrome.repaint()');
    expect(await page.evaluate('document.getElementById("stale").hidden')).toBe(false);
    expect(await page.textContent('#stale')).toMatch(/^No connection to the store computer\. This page is what it was last told, at .+/);
    await page.click('#lang');
    await page.waitForFunction('document.documentElement.lang === "ta"');
    expect(await page.textContent('#stale')).toMatch(/^கடை கணினியுடன் இணைப்பு இல்லை\./);

    const manager = await open('index.html', DESK);
    await manager.evaluate('globalThis.shellCachedAt = "2026-09-30T08:15:00Z"; globalThis.sreChrome.repaint()');
    expect(await manager.textContent('#stale')).toMatch(/do not close the day on it/);
  });
});
