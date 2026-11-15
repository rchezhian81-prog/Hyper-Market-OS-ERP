import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

/**
 * **D-11 and D-10 (pilot-first audit · OB-739 / OB-773 · P-08 · P-07): a page showing SAMPLE figures offers no real
 * action, and says ONE true thing about where its figures came from.**
 *
 * D-11: when the store pack lacked a page's section, Cash over/short, Day book and Reopen a locked day showed sample
 * figures WITH "Sign it off", "Post this day to the accounts" and "Reopen the day" live. The rule, one for every office
 * page, kept by the shared chrome: while the "Sample data" strip shows, every button in the page's `main` is switched off
 * (only a filter, a column sort, a tab or "back to the list" — which change what is looked at — stay), and the line under
 * the strip says so in words. When live figures arrive and the strip goes, the buttons come back.
 *
 * D-10: on a pack without the page's section, Reports said "Sample data — this is not your shop", "as head office last
 * sent it … (just now)" and "Head office has never sent anything", all at once; Expiry also said it had "not been told
 * who is using this screen" with the manager signed in. Now a box-served sample page says the section was not sent and
 * the figures are a sample — no freshness line claiming "just now" — and the header names the signed-in person.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';
/** Every office page that carries the "Sample data" strip. */
const SAMPLE_PAGES = readdirSync(WEB_DIR).filter((f) => f.endsWith('.html') && readFileSync(join(WEB_DIR, f), 'utf8').includes('id="sample"')).sort();
/** The controls that only change what is LOOKED at — the same list the chrome keeps (sre-chrome.js `SAMPLE_KEEP`). */
const LOOK_ONLY = '.filter, .sre-sort, [role="tab"], #back, #back-to-items, [data-sample-ok]';
/** What the store computer injects on every office page it serves (screen-server.ts): the store copy and the menu. */
const FROM_THE_BOX = {
  storeCopy: { receivedAt: '2026-11-15T03:00:00.000Z', shownAt: '15 Nov 2026, 08:30', ageMinutes: 0 },
  sreNavigation: { userId: 'u-mgr', branchId: 'S1', person: { name: 'u-mgr', role: 'Store manager' }, branch: { name: 'SRE Hyper Market' }, why: null, groups: [] },
};

async function serve(extra: Record<string, unknown> = {}): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const file = path === '/' ? 'index.html' : path.replace(/^\//, '');
      try {
        let text = (await readFile(join(WEB_DIR, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        if (file.endsWith('.html')) {
          const tags = Object.entries(extra).map(([name, value]) => `<script>window.${name} = ${JSON.stringify(value).replace(/</g, '\\u003c')};</script>`).join('');
          text = text.replace('<!--SCREEN-DATA-->', tags);
        }
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

const enabledActions = (page: Page): Promise<string[]> => page.evaluate(`[...document.querySelectorAll('main button, main input[type="submit"], main input[type="button"]')]
  .filter((b) => !b.disabled && !b.matches(${JSON.stringify(LOOK_ONLY)}))
  .map((b) => (b.id || b.className) + ' "' + b.textContent.trim().slice(0, 40) + '"')`) as Promise<string[]>;

describe.skipIf(!HAVE_BROWSER)('a page showing sample figures offers no action and says one true thing (D-11 · D-10)', () => {
  let browser: Browser;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  async function open(file: string, extra: Record<string, unknown> = {}): Promise<Page> {
    const srv = await serve(extra);
    stops.push(srv.stop);
    const context = await browser.newContext({ serviceWorkers: 'block' });
    stops.push(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${srv.base}/${file}`, { waitUntil: 'load' });
    await page.waitForFunction('globalThis.sreChrome !== undefined');
    await page.waitForTimeout(150); // the page's own late paints (the rule follows them)
    return page;
  }

  it('the rule is kept on every office page: in sample mode no enabled action button, and the reason in words', async () => {
    const offending: Record<string, string[]> = {};
    let sampled = 0;
    const srv = await serve();
    stops.push(srv.stop);
    const context = await browser.newContext({ serviceWorkers: 'block' });
    stops.push(() => context.close());
    for (const file of SAMPLE_PAGES) {
      const page = await context.newPage();
      await page.goto(`${srv.base}/${file}`, { waitUntil: 'load' });
      await page.waitForFunction('globalThis.sreChrome !== undefined', undefined, { timeout: 15_000 });
      await page.waitForTimeout(150);
      if (!(await page.isVisible('#sample'))) { await page.close(); continue; }
      sampled++;
      const live = await enabledActions(page);
      if (live.length > 0) offending[file] = live;
      expect(await page.textContent('#sre-sample-why'), file).toContain('Its buttons are switched off, because nothing can be saved from a sample.');
      await page.close();
    }
    expect(sampled).toBeGreaterThan(30);
    expect(offending).toEqual({});
  }, 300_000);

  it('the three pages the audit named: no "Sign it off", "Post this day to the accounts" or "Reopen the day" to press', async () => {
    for (const [file, id] of [['cash-office.html', '#sign'], ['day-book.html', '#post'], ['day-reopen.html', '#do-reopen']] as const) {
      const page = await open(file);
      expect(await page.isVisible('#sample'), file).toBe(true);
      expect(await page.isEnabled(id), `${file} ${id}`).toBe(false);
    }
  });

  it('when live figures arrive and the strip goes, the buttons come back', async () => {
    const page = await open('cash-office.html');
    expect(await page.isEnabled('#sign')).toBe(false);
    await page.evaluate('document.getElementById("sample").hidden = true');
    await page.waitForFunction('document.getElementById("sign").disabled === false');
    expect(await page.isVisible('#sre-sample-why')).toBe(false);
  });

  it('Reports served by the store computer without its section: one true thing — not sent, a sample — no "just now", no "never sent anything"', async () => {
    const page = await open('reporting.html', FROM_THE_BOX);
    expect(await page.isVisible('#sample')).toBe(true);
    expect(await page.textContent('#sre-sample-why')).toMatch(/^Head office has not sent this page's part of the store setup to the store computer, so the figures here are a sample/);
    expect(await page.isVisible('#store-copy')).toBe(false);
    expect(await page.isVisible('#freshness')).toBe(false);
    const shown = await page.evaluate('document.body.innerText') as string;
    expect(shown).not.toContain('just now');
    expect(shown).not.toContain('Head office has never sent anything');
    expect(await page.textContent('#whoami')).toBe('u-mgr');
    await page.click('#lang');
    await page.waitForFunction('document.documentElement.lang === "ta"');
    expect(await page.textContent('#sre-sample-why')).toMatch(/^இந்தப் பக்கத்துக்கான கடை அமைப்புப் பகுதியைத் தலைமை அலுவலகம் கடைக் கணினிக்கு அனுப்பவில்லை/);
    expect(await page.isVisible('#store-copy')).toBe(false);
  });

  it('Expiry served by the store computer without its section: no "not been told who is using this screen" over the signed-in manager', async () => {
    const page = await open('expiry.html', FROM_THE_BOX);
    expect(await page.isVisible('#sample')).toBe(true);
    expect(await page.isVisible('#nobody')).toBe(false);
    expect(await page.textContent('#whoami')).toBe('u-mgr');
    expect(await page.isVisible('#store-copy')).toBe(false);
    const shown = await page.evaluate('document.body.innerText') as string;
    expect(shown).not.toContain('has not been told who is using this screen');
    expect(shown).not.toContain('just now');
    expect(await page.textContent('#sre-sample-why')).toMatch(/^Head office has not sent this page's part/);
  });

  it('a page opened off the store computer says THAT, not that head office sent nothing', async () => {
    const page = await open('reporting.html');
    expect(await page.textContent('#sre-sample-why')).toMatch(/^This page was not opened from the store computer, so the figures here are a sample/);
  });
});
