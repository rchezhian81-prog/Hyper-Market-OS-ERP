import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';

/**
 * Audit row 6 (P-08 · P-03) in real Chromium: when the store computer's own check says something is wrong — the last
 * backup over 2 hours old, till items stuck, a dead letter, the disk 85% full, a container down, or the check itself not
 * running — the store manager's / owner's HOME page (and every office page, through the shared chrome) shows a RED banner,
 * in English and in Tamil, with the words, the shape and the colour; it cannot be dismissed, and it goes only when the
 * store computer says all is well. The page reads it from the store computer's own sync status (GET /lane/sync-status),
 * so it works with no internet. Served statically here, with a stand-in for the store computer's lane socket.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);

async function serve(dir: string, globals: Record<string, unknown>): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const file = path === '/' ? 'index.html' : path.replace(/^\//, '');
      try {
        let text = (await readFile(join(dir, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        if (file.endsWith('.html')) text = text.replace('<!--SCREEN-DATA-->', Object.entries(globals).map(([n, v]) => `<script>window.${n} = ${JSON.stringify(v).replace(/</g, '\\u003c')};</script>`).join(''));
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(text);
      } catch { res.writeHead(404); res.end('not found'); }
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      const port = typeof a === 'object' && a !== null ? a.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

/** The store computer's lane socket: its sync status, with whatever its own check said. */
async function laneStub(state: { storeComputer: unknown }): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    const at = new Date(Date.now() - 60_000).toISOString();
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ cloud: 'online', unsent: 0, deadLettered: 0, lastSentAt: at, lastContactAt: at, now: new Date().toISOString(), staffMessage: '', ...(state.storeComputer === undefined ? {} : { storeComputer: state.storeComputer }) }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      const port = typeof a === 'object' && a !== null ? a.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

const RED = {
  known: true, checkedAt: new Date().toISOString(), stale: false, overall: 'red',
  alerts: [
    { code: 'backup_old', en: 'The last backup was 3 h 5 min ago — more than 2 hours. Check the backup drive is plugged in.', ta: 'கடைசி காப்புப் பிரதி 3 மணி 5 நிமிடம் முன்பு — 2 மணி நேரத்துக்கு மேல். காப்புப் பிரதி டிரைவ் இணைக்கப்பட்டுள்ளதா எனப் பாருங்கள்.' },
    { code: 'dead_letters', en: '2 item(s) the books refused are waiting for a person to look at them.', ta: 'கணக்குகள் மறுத்த 2 பதிவு(கள்) ஒருவர் பார்க்கக் காத்திருக்கின்றன.' },
  ],
};
const OK = { known: true, checkedAt: new Date().toISOString(), stale: false, overall: 'ok', alerts: [] };

describe.skipIf(!HAVE_BROWSER)("the store computer's red light on the office home page (audit row 6)", () => {
  let browser: Browser;
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  async function home(state: { storeComputer: unknown }): Promise<{ page: Page; errors: string[] }> {
    const lane = await laneStub(state);
    stops.push(lane.stop);
    const srv = await serve('apps/web-erp/web', { laneWriteBase: lane.base });
    stops.push(srv.stop);
    const context = await browser.newContext({ viewport: { width: 1366, height: 860 }, serviceWorkers: 'block' });
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error' || /favicon\.ico/.test(m.location().url)) return;
      if (/status of 404/.test(m.text()) && new URL(m.location().url).pathname.startsWith('/v1/')) return;
      errors.push(`console: ${m.text()}`);
    });
    await page.goto(`${srv.base}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction('globalThis.sreChrome !== undefined', undefined, { timeout: 15_000 });
    return { page, errors };
  }

  it('red: a banner at the top of the home page, every alert in words, a shape beside the title, an alert to a screen reader — then in Tamil', async () => {
    const { page, errors } = await home({ storeComputer: RED });
    const alarm = page.locator('#sre-store-alarm');
    await alarm.waitFor({ state: 'visible', timeout: 15_000 });
    expect(await alarm.getAttribute('role')).toBe('alert');
    expect(await alarm.locator('strong').innerText()).toBe('The store computer needs you');
    expect(await alarm.locator('li').allInnerTexts()).toEqual([RED.alerts[0]!.en, RED.alerts[1]!.en]);
    expect(await alarm.locator('svg[data-icon="triangle-alert"]').count()).toBe(1);
    // Red under white words — never colour alone, and readable.
    const colours = await page.evaluate(`(() => { const s = getComputedStyle(document.getElementById('sre-store-alarm')); return { bg: s.backgroundColor, fg: s.color }; })()`) as { bg: string; fg: string };
    expect(colours.bg).not.toBe(colours.fg);
    expect(colours.bg).toMatch(/^rgb\((1[5-9]\d|2\d\d), \d{1,2}, \d{1,2}\)$/);
    // It sits above the page's own content and has no button to dismiss it.
    expect(await alarm.locator('button').count()).toBe(0);
    expect(await page.evaluate(`Boolean(document.getElementById('sre-store-alarm').compareDocumentPosition(document.querySelector('main')) & Node.DOCUMENT_POSITION_FOLLOWING)`)).toBe(true);
    expect(await auditPage(page)).toEqual([]);
    // Tamil: the page's own toggle switches the banner's words too.
    await page.click('#lang');
    await page.waitForFunction('document.documentElement.lang === "ta"');
    await page.waitForFunction(`document.querySelector('#sre-store-alarm strong')?.textContent === 'கடை கணினிக்கு உங்கள் கவனம் தேவை'`);
    expect(await alarm.locator('li').allInnerTexts()).toEqual([RED.alerts[0]!.ta, RED.alerts[1]!.ta]);
    expect(await auditPage(page, { expectLang: 'ta' })).toEqual([]);
    expect(errors).toEqual([]);
  }, 60_000);

  it('all well: no banner; a box that reports no store-computer check: no banner; and red turns to nothing once the store computer says it is fixed', async () => {
    const state: { storeComputer: unknown } = { storeComputer: OK };
    const { page, errors } = await home(state);
    await page.waitForFunction('document.querySelector(".sre-badge") !== null', undefined, { timeout: 15_000 });
    await page.waitForTimeout(500);
    expect(await page.locator('#sre-store-alarm:visible').count()).toBe(0);
    const none = await home({ storeComputer: undefined });
    await none.page.waitForTimeout(500);
    expect(await none.page.locator('#sre-store-alarm:visible').count()).toBe(0);
    // Red, then fixed: the next poll (every 10 seconds) takes it away.
    state.storeComputer = RED;
    await page.locator('#sre-store-alarm').waitFor({ state: 'visible', timeout: 15_000 });
    state.storeComputer = OK;
    await page.locator('#sre-store-alarm').waitFor({ state: 'hidden', timeout: 15_000 });
    expect([...errors, ...none.errors]).toEqual([]);
  }, 60_000);
});
