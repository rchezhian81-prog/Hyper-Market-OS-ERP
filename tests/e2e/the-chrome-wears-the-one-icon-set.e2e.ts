import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import { ERP_NAVIGATION, NAV_GROUP_LABELS } from '../../apps/web-erp/src/navigation';

/**
 * **The shared look, rendered: every icon from the one set, every icon beside its word, no console error, and no motion
 * on the till (OB-201 · design system §3.4 · NFR-07 · hard rule 1).**
 *
 * In real Chromium: the back office's chrome with the WHOLE menu the store computer can serve (every box-served item
 * of `apps/web-erp/src/navigation.ts`), on the store home, a register page and the GST returns page, at a desk and on
 * a phone, in English and Tamil. It proves that every screen on the rail wears its own shape from the set, that every
 * SVG on the page is hidden from a screen reader and sits inside an element that has words, that the badge is a chip
 * in its tone with the state's shape, that the page logs no error, that a person who asked for less motion gets none,
 * and that the audit (contrast, targets, names, reflow) stays clean. Then the till: its status dot wears its shape,
 * and ringing items starts no animation anywhere on the screen. Then a handheld at phone width.
 *
 * Served statically, like the ERP spec suite, with the menu and figures the store computer would inject.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const DESK: BrowserContextOptions = { viewport: { width: 1366, height: 860 } };
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

/** What the store computer would inject for an owner who may open every screen it serves, on screen `currentId`. */
function menuFor(currentId: string): Record<string, unknown> {
  const groups: { group: { en: string; ta: string }; items: unknown[] }[] = [];
  for (const item of ERP_NAVIGATION) {
    if ((item.served ?? 'box') !== 'box') continue;
    const label = NAV_GROUP_LABELS[item.group]!;
    let g = groups.find((x) => x.group.en === label.en);
    if (!g) { g = { group: label, items: [] }; groups.push(g); }
    g.items.push({ id: item.id, label: { en: item.label, ta: item.labelTa }, path: item.path, current: item.id === currentId });
  }
  return { userId: 'u-owner', branchId: 'b1', person: { name: 'Meena Raghavan', role: 'Owner' }, branch: { name: 'Main store' }, why: null, groups };
}
const SERVED_ITEMS = ERP_NAVIGATION.filter((i) => (i.served ?? 'box') === 'box').length;

async function serve(dir: string, globals: Record<string, unknown> = {}): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const file = path === '/' ? 'index.html' : path.replace(/^\//, '');
      try {
        let text = (await readFile(join(dir, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.webmanifest') ? 'application/manifest+json' : 'application/octet-stream';
        if (file.endsWith('.html')) {
          const tags = Object.entries(globals).map(([name, value]) => `<script>window.${name} = ${JSON.stringify(value).replace(/</g, '\\u003c')};</script>`).join('');
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

/** A stand-in for the store computer's `GET /lane/sync-status`, answering "online". */
async function laneStub(): Promise<{ base: string; stop: () => Promise<void> }> {
  const at = new Date(Date.now() - 60_000).toISOString();
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

/**
 * Every SVG on the page, judged in the page: from the one set (class and `data-icon`), hidden from a screen reader,
 * unfocusable — and inside an element that carries words (a link, a button, the badge, a chip, a strip, a tile, the
 * branch card), or, for the search field's magnifier, beside a field that has its own name. Returns the offenders.
 */
const ICON_OFFENDERS = String.raw`(() => {
  const bad = [];
  const hosts = 'a, button, [role="button"], .sre-badge, .sre-chip, .sre-with-icon, p, li, label, .tile, .branch, .sre-find-wrap, .sre-update';
  for (const svg of document.querySelectorAll('svg')) {
    const where = (svg.parentElement && (svg.parentElement.id || svg.parentElement.className)) || '?';
    if (!svg.classList.contains('sre-icon') || !svg.getAttribute('data-icon')) { bad.push('not from the set: ' + where); continue; }
    if (svg.getAttribute('aria-hidden') !== 'true' || svg.getAttribute('focusable') !== 'false') bad.push('announced or focusable: ' + where);
    // a status dot's words are the ones beside it: judge the element that holds the dot and its words
    const base = svg.parentElement && svg.parentElement.classList.contains('dot') ? svg.parentElement.parentElement : svg;
    const host = base === svg ? svg.closest(hosts) : (base.closest(hosts) || base);
    if (!host) { bad.push('no host with words: ' + svg.getAttribute('data-icon') + ' in ' + where); continue; }
    if (host.classList.contains('sre-find-wrap')) {
      const field = host.querySelector('input');
      if (!field || !(field.getAttribute('aria-label') || '').trim()) bad.push('magnifier beside an unnamed field');
      continue;
    }
    // the dot's words are its badge's; anything else must have words of its own
    const words = (host.closest('.sre-badge') || host).textContent.trim();
    if (words === '') bad.push('icon-only: ' + svg.getAttribute('data-icon') + ' in ' + where);
  }
  return bad;
})()`;

describe.skipIf(!HAVE_BROWSER)('the shared look in a real browser: the one icon set, always with its word (OB-201)', () => {
  let browser: Browser;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    execFileSync('node', ['scripts/build-app.mjs', 'warehouse-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  /** Open a page; collect page errors and console errors (a failed network fetch the page did not make counts too). */
  async function open(dir: string, file: string, device: BrowserContextOptions, globals: Record<string, unknown> = {}): Promise<{ page: Page; errors: string[] }> {
    const srv = await serve(dir, globals);
    stops.push(srv.stop);
    const context = await browser.newContext({ ...device, serviceWorkers: 'block' });
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon\.ico/.test(m.location().url)) errors.push(`console: ${m.text()} (${m.location().url})`); });
    await page.goto(`${srv.base}/${file}`, { waitUntil: 'load' });
    return { page, errors };
  }

  for (const [file, current] of [['index.html', 'dashboard'], ['goods-receipt.html', 'goods-receipt'], ['gst-returns.html', 'gst-returns']] as const) {
    it(`${file}: every screen on the rail wears its own shape beside its name; every icon has its words; no console error; audit clean, desk and phone, English and Tamil`, async () => {
      for (const device of [DESK, PHONE]) {
        const { page, errors } = await open('apps/web-erp/web', file, device, { sreNavigation: menuFor(current) });
        await page.waitForFunction('globalThis.sreChrome !== undefined && typeof globalThis.sreIcon === "function"', undefined, { timeout: 15_000 });
        const desk = device === DESK;
        if (!desk) await page.click('#sre-menu-button'); // on a phone the rail is a drawer: open it to judge it

        // the rail: one link per served screen, each with exactly one icon of the set and its name as the whole text
        const links = await page.evaluate(`[...document.querySelectorAll('#sre-menu a')].map((a) => ({ text: a.textContent.trim(), icons: [...a.querySelectorAll('svg')].map((s) => s.getAttribute('data-icon')) }))`) as { text: string; icons: string[] }[];
        expect(links.length).toBe(SERVED_ITEMS);
        for (const l of links) {
          expect(l.text, 'a rail link has words').not.toBe('');
          expect(l.icons.length, `${l.text} wears one icon`).toBe(1);
        }
        const mapping = await page.evaluate('globalThis.sreChrome.icons.item') as Record<string, string>;
        const railOrder = (menuFor(current)['groups'] as { items: { id: string }[] }[]).flatMap((g) => g.items.map((i) => i.id));
        const expected = railOrder.map((id) => mapping[id]);
        expect(links.map((l) => l.icons[0])).toEqual(expected);
        // the workspace headings are words alone: one icon per row, never two stacked
        expect(await page.evaluate(`document.querySelectorAll('#sre-menu .group svg').length`)).toBe(0);

        // the header: the search field's magnifier, the language toggle's globe, the badge as a chip with its shape
        expect(await page.getAttribute('#sre-find-wrap svg', 'data-icon')).toBe('search');
        expect(await page.getAttribute('#lang svg', 'data-icon')).toBe('globe');
        expect(await page.textContent('#lang')).toBe('தமிழ்');
        expect(await page.getAttribute('#sre-badge', 'data-tone')).toBe(file === 'index.html' ? 'degraded' : 'idle');
        expect(await page.getAttribute('#conn-dot svg', 'data-icon')).toBe(file === 'index.html' ? 'clock' : 'pause');
        expect(await page.getAttribute('#sre-menu .branch .mark svg', 'data-icon')).toBe('store');

        expect(await page.evaluate(ICON_OFFENDERS), `${file} at ${desk ? 'desk' : 'phone'}`).toEqual([]);
        expect(await auditPage(page, { expectLang: 'en' }), `${file} at ${desk ? 'desk' : 'phone'}`).toEqual([]);

        // in Tamil: the same shapes, the words in Tamil, the toggle naming English (on a phone, close the drawer first —
        // its scrim covers the header, as it should)
        if (!desk) await page.evaluate('globalThis.sreChrome.menu.toggle(false)');
        await page.click('#lang');
        await page.waitForFunction('document.documentElement.lang === "ta"');
        expect(await page.textContent('#lang')).toBe('English');
        expect(await page.getAttribute('#lang svg', 'data-icon')).toBe('globe');
        if (!desk && await page.evaluate('document.getElementById("sre-menu").hidden')) await page.click('#sre-menu-button');
        expect(await page.evaluate(ICON_OFFENDERS), `${file} in Tamil`).toEqual([]);
        expect(await auditPage(page, { expectLang: 'ta' }), `${file} in Tamil at ${desk ? 'desk' : 'phone'}`).toEqual([]);
        expect(errors, `${file} logged an error`).toEqual([]);
      }
    }, 90_000);
  }

  it('the badge follows the store computer: a connected box is a green chip with the tick, the words unchanged', async () => {
    const lane = await laneStub();
    stops.push(lane.stop);
    const { page, errors } = await open('apps/web-erp/web', 'suppliers.html', DESK, { sreNavigation: menuFor('suppliers'), laneWriteBase: lane.base });
    await page.waitForFunction('document.getElementById("sre-badge")?.dataset.tone === "ok"', undefined, { timeout: 15_000 });
    expect(await page.textContent('#conn-text')).toMatch(/^Connected · last contact \d{2}:\d{2}/);
    expect(await page.getAttribute('#conn-dot svg', 'data-icon')).toBe('check');
    expect(await page.textContent('#sre-badge')).toMatch(/^Connected/); // the dot adds a shape, never a word
    expect(await auditPage(page, { expectLang: 'en' })).toEqual([]);
    expect(errors).toEqual([]);
  }, 60_000);

  it('a person who asked for less motion gets none; everyone else gets short, ease-out motion', async () => {
    const calm = await open('apps/web-erp/web', 'index.html', { ...DESK, reducedMotion: 'reduce' }, { sreNavigation: menuFor('dashboard') });
    expect(await calm.page.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--dur").trim()')).toBe('0ms');
    const usual = await open('apps/web-erp/web', 'index.html', { ...DESK, reducedMotion: 'no-preference' }, { sreNavigation: menuFor('dashboard') });
    expect(await usual.page.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--dur").trim()')).toBe('160ms');
    // the shared shapes on the Today page's figure tiles and workspace tiles come from the same set
    expect(await usual.page.evaluate(`[...document.querySelectorAll('#tiles .tile svg')].every((s) => s.classList.contains('sre-icon'))`)).toBe(true);
    expect(await usual.page.evaluate(ICON_OFFENDERS)).toEqual([]);
    expect(calm.errors).toEqual([]);
    expect(usual.errors).toEqual([]);
  }, 60_000);

  it('the till: its dot wears the state\'s shape; ringing items starts no animation anywhere on the screen (hard rule 1)', async () => {
    const { page, errors } = await open('apps/pos/web', 'index.html', { viewport: { width: 1366, height: 768 } });
    await page.waitForFunction('globalThis.posSession !== undefined && typeof globalThis.sreIcon === "function"', undefined, { timeout: 15_000 });
    expect(await page.getAttribute('#conn-dot', 'data-sre-status')).toBe('');
    expect(await page.evaluate('document.querySelector("#conn-dot svg")?.getAttribute("data-icon") ?? null')).not.toBeNull();
    const ring = await page.evaluate(`(() => { const t0 = performance.now();
      for (let i = 0; i < 20; i++) globalThis.posSession.scan({ productId: 'P' + (i % 4), description: 'Toor dal 1kg', unitPriceMinor: 14500, qty: 1 });
      return { ms: performance.now() - t0 }; })()`) as { ms: number };
    // the shell draws the bill on its own events; a language switch there and back redraws it with the twenty lines
    await page.click('#lang');
    await page.click('#lang');
    expect(await page.evaluate('document.querySelectorAll("#lines tr").length')).toBeGreaterThan(0);
    expect(await page.textContent('#total')).not.toBe('₹0.00');
    await page.waitForTimeout(250);
    expect(await page.evaluate('document.getAnimations().length'), 'something animates on the till').toBe(0);
    expect(await page.evaluate('document.querySelectorAll("svg:not(.sre-icon)").length')).toBe(0);
    expect(ring.ms, 'twenty scans').toBeLessThan(1000);
    // the till's own page errors only; it asks its own store computer, which is not running in this test
    expect(errors.filter((e) => e.startsWith('pageerror'))).toEqual([]);
  }, 60_000);

  it('a handheld at phone width: the warehouse dot wears its shape, the layout and the 64px targets untouched', async () => {
    const { page, errors } = await open('apps/warehouse-app/web', 'index.html', PHONE);
    await page.waitForFunction('typeof globalThis.sreIcon === "function"', undefined, { timeout: 15_000 });
    expect(await page.evaluate('document.querySelector("#queue-dot svg")?.getAttribute("data-icon") ?? null')).toBe('pause');
    expect(await page.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--tap").trim()')).toBe('64px');
    expect(await page.evaluate(ICON_OFFENDERS)).toEqual([]);
    expect(errors.filter((e) => e.startsWith('pageerror'))).toEqual([]);
  }, 60_000);
});
