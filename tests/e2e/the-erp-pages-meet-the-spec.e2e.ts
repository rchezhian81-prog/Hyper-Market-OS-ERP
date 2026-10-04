import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage, type A11yFinding } from './lib/a11y-audit';
import { startScreenServer, SCREEN_HOST } from '../../edge/store-edge/src/screen-server';
import { emptyPack, known, type StorePack } from '../../edge/store-edge/src/store-pack';
import type { ScreenInput } from '../../edge/store-edge/src/screen-data';
import { SyncOutbox } from '../../packages/sync/src/index';

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
async function serve(laneWriteBase?: string, extra: Record<string, unknown> = {}): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const file = path === '/' ? 'index.html' : path.replace(/^\//, '');
      try {
        let text = (await readFile(join(WEB_DIR, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.webmanifest') ? 'application/manifest+json' : 'application/octet-stream';
        if (file.endsWith('.html')) {
          const globals = { ...(laneWriteBase === undefined ? {} : { laneWriteBase }), ...extra };
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

  async function open(file: string, device: typeof DESK | typeof PHONE, laneWriteBase?: string, extra: Record<string, unknown> = {}): Promise<Page> {
    const srv = await serve(laneWriteBase, extra);
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

  // ── The menu (Stage G slice 5b · §27 role surfaces · P-07) ────────────────────────────────────────────────────
  /** What the store computer would inject for a floor manager on the counts screen. */
  const MENU = {
    userId: 'u-mgr', branchId: 'b1', why: null,
    groups: [
      { group: { en: 'Overview', ta: 'கண்ணோட்டம்' }, items: [{ id: 'dashboard', label: { en: 'Dashboard', ta: 'முகப்பு' }, path: '/manager/', current: false }] },
      { group: { en: 'Inventory', ta: 'சரக்கு' }, items: [
        { id: 'counts', label: { en: 'Stock counts', ta: 'சரக்கு எண்ணிக்கை' }, path: '/counts/', current: true },
        { id: 'stock-health', label: { en: 'Stock health', ta: 'சரக்கு நிலை' }, path: '/stock-health/', current: false },
      ] },
      { group: { en: 'Administration', ta: 'நிர்வாகம்' }, items: [
        { id: 'users', label: { en: 'Users & roles', ta: 'பயனர்களும் பங்குகளும்' }, path: '/admin/?tab=people', current: false },
        { id: 'audit', label: { en: 'Audit log', ta: 'தணிக்கைப் பதிவு' }, path: '/admin/?tab=records', current: false },
      ] },
    ],
  };
  const texts = (page: Page, selector: string): Promise<string[]> =>
    page.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent.trim())`) as Promise<string[]>;

  it('the menu: a button that says what it opens, the person\'s screens grouped, the served screen current, keyboard-closable, audited open at a desk and on a phone, in Tamil too', async () => {
    for (const device of [DESK, PHONE]) {
      const page = await open('counts.html', device, undefined, { sreNavigation: MENU });
      const desk = device === DESK;
      if (desk) {
        // At a desk the rail of the owner's look stands open beside the page (OB-13, UX-1a): nothing to press,
        // nothing to dismiss, the page wrapped once beside it.
        expect(await page.evaluate('document.getElementById("sre-menu-button").hidden')).toBe(true);
        expect(await page.evaluate('document.getElementById("sre-menu").hidden')).toBe(false);
        expect(await page.evaluate('document.body.classList.contains("sre-shell")')).toBe(true);
        expect(await page.evaluate('document.body.firstElementChild.id')).toBe('sre-menu');
        expect(await page.evaluate('document.getElementById("sre-page").contains(document.querySelector("main"))')).toBe(true);
      } else {
        expect(await page.textContent('#sre-menu-button')).toBe('☰ Screens');
        expect(await page.getAttribute('#sre-menu-button', 'aria-expanded')).toBe('false');
        expect(await page.evaluate('document.getElementById("sre-menu").hidden')).toBe(true);
        await page.click('#sre-menu-button');
        expect(await page.getAttribute('#sre-menu-button', 'aria-expanded')).toBe('true');
        expect(await page.evaluate('document.getElementById("sre-menu").hidden')).toBe(false);
      }
      expect(await page.getAttribute('#sre-menu', 'aria-label')).toBe('Screens');
      expect(await page.textContent('#sre-menu .who-can')).toBe('Screens for u-mgr');
      expect(await page.textContent('#sre-menu .brand small')).toBe('Store workspace');
      expect(await texts(page, '#sre-menu .group')).toEqual(['Overview', 'Inventory', 'Administration']);
      expect(await texts(page, '#sre-menu a')).toEqual(['Dashboard', 'Stock counts', 'Stock health', 'Users & roles', 'Audit log']);
      expect(await texts(page, '#sre-menu a[aria-current="page"]')).toEqual(['Stock counts']);
      expect(await page.getAttribute('#sre-menu a[aria-current="page"]', 'href')).toMatch(/\/counts\/$/);
      // On a phone, opening put focus on the current screen's link; Escape closes and hands focus back to the button.
      if (!desk) expect(await page.evaluate('document.activeElement.textContent')).toBe('Stock counts');
      const withMenuOpen = await auditPage(page, { expectLang: 'en' });
      expect(withMenuOpen, `menu open at ${device.viewport.width}`).toEqual([]);
      if (!desk) {
        await page.keyboard.press('Escape');
        expect(await page.evaluate('document.getElementById("sre-menu").hidden')).toBe(true);
        expect(await page.evaluate('document.activeElement.id')).toBe('sre-menu-button');
      }

      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "ta"');
      if (!desk) {
        expect(await page.textContent('#sre-menu-button')).toBe('☰ திரைகள்');
        await page.click('#sre-menu-button');
      }
      expect(await page.textContent('#sre-menu .who-can')).toBe('இவருக்கான திரைகள் u-mgr');
      expect(await page.textContent('#sre-menu .brand small')).toBe('கடை பணியிடம்');
      expect(await texts(page, '#sre-menu .group')).toEqual(['கண்ணோட்டம்', 'சரக்கு', 'நிர்வாகம்']);
      expect(await texts(page, '#sre-menu a[aria-current="page"]')).toEqual(['சரக்கு எண்ணிக்கை']);
      expect(await auditPage(page, { expectLang: 'ta' }), `menu open in Tamil at ${device.viewport.width}`).toEqual([]);
    }
  }, 60_000);

  it('the menu says why it is empty — nobody named, or no role register — and draws nothing at all off the box', async () => {
    const nobody = await open('waste.html', DESK, undefined, { sreNavigation: { userId: null, branchId: 'b1', why: 'no_user', groups: [] } });
    // a desk's rail is open already; the reason stands where the screens would
    expect(await nobody.textContent('#sre-menu .who-can')).toBe('Nobody is named on this screen, so no other screens can be offered.');
    expect(await nobody.$$('#sre-menu a')).toEqual([]);
    await nobody.click('#lang');
    await nobody.waitForFunction('document.documentElement.lang === "ta"');
    expect(await nobody.textContent('#sre-menu .who-can')).toBe('இந்தத் திரையில் யாரும் பெயரிடப்படவில்லை, எனவே வேறு திரைகள் வழங்க முடியாது.');

    const noRoles = await open('waste.html', PHONE, undefined, { sreNavigation: { userId: 'u-mgr', branchId: 'b1', why: 'no_roles', groups: [] } });
    await noRoles.click('#sre-menu-button');
    expect(await noRoles.textContent('#sre-menu .who-can')).toBe('This store computer has no role register, so no screens can be offered.');

    const offBox = await open('waste.html', DESK);
    expect(await offBox.$('#sre-menu-button')).toBeNull();
    expect(await offBox.$('#sre-menu')).toBeNull();
  });

  it('a menu link that names a tab opens the page on that tab, and only the matching tab\'s item is current', async () => {
    const manager = await open('index.html?tab=approvals', DESK);
    expect(await manager.getAttribute('#tab-approvals', 'aria-current')).toBe('page');
    expect(await manager.evaluate('document.getElementById("view-approvals").hidden')).toBe(false);
    expect(await manager.evaluate('document.getElementById("view-home").hidden')).toBe(true);

    const bothCurrent = { ...MENU, groups: [{ group: MENU.groups[2]!.group, items: MENU.groups[2]!.items.map((i) => ({ ...i, current: true })) }] };
    const admin = await open('admin.html?tab=records', DESK, undefined, { sreNavigation: bothCurrent });
    expect(await admin.getAttribute('#tab-records', 'aria-current')).toBe('page');
    expect(await texts(admin, '#sre-menu a[aria-current="page"]')).toEqual(['Audit log']);
  });

  it('on the REAL store computer: the box works the menu out from its role register, a link opens a served screen, and that screen\'s menu marks itself current', async () => {
    const policies: StorePack['policies'] = known({ storeId: 'store-1', branchId: 'b1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 30, warehouseId: 'wh-1' });
    const pack: StorePack = {
      ...emptyPack('this test pulled nothing else'),
      policies,
      roles: known([{ id: 'floor', name: 'Floor manager', permissions: ['count.view', 'inventory.availability.read'] }]),
      roleAssignments: known([{ userId: 'u-mgr', roleId: 'floor', branchScope: ['b1'] }]),
      countsPolicy: known({ userId: 'u-mgr', permissions: ['count.view'] }),
      stockHealthPolicy: known({ userId: 'u-mgr', permissions: ['inventory.availability.read'] }),
    };
    const snapshot = (): ScreenInput => ({ pack, sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: '2026-09-30T09:00:00.000Z', tradingDay: '2026-09-30' });
    const box = await startScreenServer({ port: 0, appsDir: 'apps', snapshot });
    stops.push(() => box.stop());
    const context = await browser.newContext(DESK);
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://${SCREEN_HOST}:${box.port}/counts/`, { waitUntil: 'load' });
    await page.waitForFunction('globalThis.sreChrome !== undefined', undefined, { timeout: 15_000 });

    // At a desk the rail stands open (OB-13): the person's screens are simply there.
    expect(await page.evaluate('document.getElementById("sre-menu").hidden')).toBe(false);
    expect(await page.textContent('#sre-menu .who-can')).toBe('Screens for u-mgr');
    // SP-8c-ii: "Products nobody can sell" is gated on the same availability read as stock health, so this reader sees it too.
    expect(await texts(page, '#sre-menu a')).toEqual(['Goods receipt review', 'Stock counts', 'Stock health', 'Products nobody can sell', 'Warehouse']);
    expect(await texts(page, '#sre-menu a[aria-current="page"]')).toEqual(['Stock counts']);

    await page.click('#sre-menu a:has-text("Stock health")');
    await page.waitForURL(/\/stock-health\/$/);
    await page.waitForFunction('globalThis.sreChrome !== undefined', undefined, { timeout: 15_000 });
    expect(await texts(page, '#sre-menu a[aria-current="page"]')).toEqual(['Stock health']);
    expect(await auditPage(page, { expectLang: 'en' })).toEqual([]);
    expect(errors).toEqual([]);
  }, 60_000);
});
