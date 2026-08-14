import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';
import { startScreenServer, SCREEN_HOST, type ScreenServer } from '../../edge/store-edge/src/screen-server';
import { emptyPack } from '../../edge/store-edge/src/store-pack';
import type { ScreenInput } from '../../edge/store-edge/src/screen-data';
import { SyncOutbox } from '../../packages/sync/src/index';

/**
 * **Every screen opens with the network cut** (SYNC-06 / TEST-02, P-01, hard rule #1).
 *
 * The static guardrail (`every-screen-opens-without-a-network`) proves each shell REGISTERS a
 * service worker and caches its shell. This proves the property the shop actually depends on, in a
 * REAL headless browser: load a screen, let its service worker cache the shell, then **cut the
 * network entirely and reload** — the screen still opens, served from the cache, and says so
 * (`window.shellCachedAt`), rather than showing the browser's "no internet" page. A cashier must be
 * able to open the till and keep billing through an outage; this is that, mechanically checked.
 *
 * The browser binary is provided by the environment, not downloaded (`playwright-core` +
 * `executablePath`). Where none is present — a CI runner without one — the suite SKIPS rather than
 * failing, the same way the real-PostgreSQL suites skip without a database.
 */

// The environment's pre-installed Chromium (see the run notes: launch it, never `playwright install`).
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);

/** One representative screen per distinct app/service-worker, so every offline contract is exercised. */
const SCREENS_UNDER_TEST = ['pos', 'manager', 'owner', 'picker', 'driver', 'customer', 'warehouse'] as const;

/** A minimal but valid box snapshot — the shells open on an empty pack (into their honest stand-in). */
const snapshot = (): ScreenInput => ({
  pack: emptyPack(), sales: [], unreadableRecords: 0, outbox: new SyncOutbox(),
  now: '2026-08-09T12:00:00.000Z', tradingDay: '2026-08-09',
});

/**
 * The browser globals these checks touch — cast structurally (`globalThis as unknown as
 * BrowserWindow`) INSIDE each `page.evaluate`, so the callback references no Node-scope helper (it
 * runs in the browser) and the test file needs no DOM lib. The cast is erased at compile time, so
 * the browser receives plain `globalThis.navigator` / `globalThis.shellCachedAt`.
 */
interface BrowserWindow {
  readonly navigator: {
    readonly onLine: boolean;
    readonly serviceWorker: { ready: Promise<unknown>; controller: unknown };
  };
  readonly shellCachedAt?: unknown;
}

/** The tiny slice of the DOM the accessibility check touches, cast structurally like `BrowserWindow`. */
interface A11yEl {
  getAttribute(name: string): string | null;
  readonly textContent: string | null;
  querySelector(selector: string): A11yEl | null;
}
interface A11yDoc {
  getElementById(id: string): A11yEl | null;
  querySelectorAll(selector: string): ArrayLike<A11yEl>;
}

describe.skipIf(!HAVE_BROWSER)('every screen opens with the network cut (SYNC-06)', () => {
  let browser: Browser;
  let server: ScreenServer;
  let base: string;

  beforeAll(async () => {
    server = await startScreenServer({ port: 0, appsDir: 'apps', snapshot });
    base = `http://${SCREEN_HOST}:${server.port}`;
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
  });

  it.each(SCREENS_UNDER_TEST)('the %s screen still opens from cache after the network is cut', async (screen) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();

      // 1. First load registers the service worker, which on INSTALL caches the shell AND this page
      //    (stamped) — so the screen survives an outage that starts before its second open.
      await page.goto(`${base}/${screen}`, { waitUntil: 'load' });
      await page.evaluate(() => (globalThis as unknown as BrowserWindow).navigator.serviceWorker.ready.then(() => true));
      // Wait until the worker CONTROLS this page (it claims clients on activate), so the reload below
      // is served by it and not straight off the network.
      await page.waitForFunction(() => (globalThis as unknown as BrowserWindow).navigator.serviceWorker.controller !== null, { timeout: 15_000 });

      // 2. Cut the network entirely and reload. The shell must still open — served from the cache.
      await context.setOffline(true);
      await page.reload({ waitUntil: 'domcontentloaded' });

      // It is genuinely offline, the shell rendered (a real page, not the browser's error), and the
      // copy came from the service-worker cache (stamped), never a live fetch that cannot have happened.
      expect(await page.evaluate(() => (globalThis as unknown as BrowserWindow).navigator.onLine), `${screen} was not offline`).toBe(false);
      expect((await page.title()).trim().length, `${screen} showed no page offline`).toBeGreaterThan(0);
      expect(await page.evaluate(() => typeof (globalThis as unknown as BrowserWindow).shellCachedAt === 'string'), `${screen} was not served from cache`).toBe(true);
      expect(((await page.textContent('body')) ?? '').trim().length, `${screen} rendered an empty body`).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });

  it('the GST reconciliation screen opens offline AND is accessible (item 3 inc3)', async () => {
    // A web-erp shell shares the manager service worker, so the SW contract is exercised by 'manager'
    // above. This proves the NEW shell in particular opens with the cable out and — the point of the
    // whole design-system foundation — that what it renders is accessible: colour is never the only
    // signal (every status carries a word and a screen-reader announcement), and the chrome is labelled.
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${base}/gst-reconciliation`, { waitUntil: 'load' });
      await page.evaluate(() => (globalThis as unknown as BrowserWindow).navigator.serviceWorker.ready.then(() => true));
      await page.waitForFunction(() => (globalThis as unknown as BrowserWindow).navigator.serviceWorker.controller !== null, { timeout: 15_000 });

      await context.setOffline(true);
      await page.reload({ waitUntil: 'domcontentloaded' });

      // Offline, opened from cache, and not empty.
      expect(await page.evaluate(() => (globalThis as unknown as BrowserWindow).navigator.onLine)).toBe(false);
      expect(await page.title()).toContain('GST reconciliation');
      expect(await page.evaluate(() => typeof (globalThis as unknown as BrowserWindow).shellCachedAt === 'string')).toBe(true);
      expect(((await page.textContent('body')) ?? '').trim().length).toBeGreaterThan(0);

      // Accessible: the language toggle and the queue list are labelled, and EVERY rendered status
      // carries a screen-reader announcement, a visible word (not colour alone), and an aria-hidden icon.
      const a11y = await page.evaluate(() => {
        const doc = (globalThis as unknown as { document: A11yDoc }).document;
        const nonEmpty = (v: string | null) => typeof v === 'string' && v.trim().length > 0;
        const statuses = Array.from(doc.querySelectorAll('.status'));
        return {
          langLabelled: nonEmpty(doc.getElementById('lang')?.getAttribute('aria-label') ?? null),
          listLabelled: nonEmpty(doc.getElementById('rows')?.getAttribute('aria-label') ?? null),
          statusCount: statuses.length,
          everyStatusAnnounced: statuses.every((s) => nonEmpty(s.getAttribute('aria-label'))),
          everyStatusHasWord: statuses.every((s) => nonEmpty(s.textContent)),
          everyIconHidden: statuses.every((s) => s.querySelector('.icon')?.getAttribute('aria-hidden') === 'true'),
        };
      });
      expect(a11y.langLabelled, 'language toggle has no aria-label').toBe(true);
      expect(a11y.listLabelled, 'queue list has no aria-label').toBe(true);
      expect(a11y.statusCount, 'no status rows rendered to check').toBeGreaterThan(0);
      expect(a11y.everyStatusAnnounced, 'a status has no screen-reader announcement').toBe(true);
      expect(a11y.everyStatusHasWord, 'a status conveys state by colour alone').toBe(true);
      expect(a11y.everyIconHidden, 'a status icon is not hidden from screen readers').toBe(true);
    } finally {
      await context.close();
    }
  });

  it('the category-rules screen opens offline AND is accessible (M03-FR-01)', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${base}/category-policy`, { waitUntil: 'load' });
      await page.evaluate(() => (globalThis as unknown as BrowserWindow).navigator.serviceWorker.ready.then(() => true));
      await page.waitForFunction(() => (globalThis as unknown as BrowserWindow).navigator.serviceWorker.controller !== null, { timeout: 15_000 });

      await context.setOffline(true);
      await page.reload({ waitUntil: 'domcontentloaded' });

      expect(await page.evaluate(() => (globalThis as unknown as BrowserWindow).navigator.onLine)).toBe(false);
      expect(await page.title()).toContain('Category rules');
      expect(await page.evaluate(() => typeof (globalThis as unknown as BrowserWindow).shellCachedAt === 'string')).toBe(true);
      expect(((await page.textContent('body')) ?? '').trim().length).toBeGreaterThan(0);

      const a11y = await page.evaluate(() => {
        const doc = (globalThis as unknown as { document: A11yDoc }).document;
        const nonEmpty = (v: string | null) => typeof v === 'string' && v.trim().length > 0;
        const statuses = Array.from(doc.querySelectorAll('.status'));
        return {
          langLabelled: nonEmpty(doc.getElementById('lang')?.getAttribute('aria-label') ?? null),
          listLabelled: nonEmpty(doc.getElementById('rows')?.getAttribute('aria-label') ?? null),
          statusCount: statuses.length,
          everyStatusAnnounced: statuses.every((s) => nonEmpty(s.getAttribute('aria-label'))),
          everyStatusHasWord: statuses.every((s) => nonEmpty(s.textContent)),
          everyIconHidden: statuses.every((s) => s.querySelector('.icon')?.getAttribute('aria-hidden') === 'true'),
        };
      });
      expect(a11y.langLabelled).toBe(true);
      expect(a11y.listLabelled).toBe(true);
      expect(a11y.statusCount).toBeGreaterThan(0);
      expect(a11y.everyStatusAnnounced).toBe(true);
      expect(a11y.everyStatusHasWord).toBe(true);
      expect(a11y.everyIconHidden).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('the GST-returns screen opens offline AND is accessible (item 3, 4th domain; M23)', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${base}/gst-returns`, { waitUntil: 'load' });
      await page.evaluate(() => (globalThis as unknown as BrowserWindow).navigator.serviceWorker.ready.then(() => true));
      await page.waitForFunction(() => (globalThis as unknown as BrowserWindow).navigator.serviceWorker.controller !== null, { timeout: 15_000 });

      await context.setOffline(true);
      await page.reload({ waitUntil: 'domcontentloaded' });

      expect(await page.evaluate(() => (globalThis as unknown as BrowserWindow).navigator.onLine)).toBe(false);
      expect(await page.title()).toContain('GST returns');
      expect(await page.evaluate(() => typeof (globalThis as unknown as BrowserWindow).shellCachedAt === 'string')).toBe(true);
      expect(((await page.textContent('body')) ?? '').trim().length).toBeGreaterThan(0);

      const a11y = await page.evaluate(() => {
        const doc = (globalThis as unknown as { document: A11yDoc }).document;
        const nonEmpty = (v: string | null) => typeof v === 'string' && v.trim().length > 0;
        const statuses = Array.from(doc.querySelectorAll('.status'));
        return {
          langLabelled: nonEmpty(doc.getElementById('lang')?.getAttribute('aria-label') ?? null),
          listLabelled: nonEmpty(doc.getElementById('rows')?.getAttribute('aria-label') ?? null),
          statusCount: statuses.length,
          everyStatusAnnounced: statuses.every((s) => nonEmpty(s.getAttribute('aria-label'))),
          everyStatusHasWord: statuses.every((s) => nonEmpty(s.textContent)),
          everyIconHidden: statuses.every((s) => s.querySelector('.icon')?.getAttribute('aria-hidden') === 'true'),
        };
      });
      expect(a11y.langLabelled).toBe(true);
      expect(a11y.listLabelled).toBe(true);
      expect(a11y.statusCount).toBeGreaterThan(0);
      expect(a11y.everyStatusAnnounced).toBe(true);
      expect(a11y.everyStatusHasWord).toBe(true);
      expect(a11y.everyIconHidden).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('the till specifically boots its own shell offline, not a browser error page', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${base}/pos`, { waitUntil: 'load' });
      await page.evaluate(() => (globalThis as unknown as BrowserWindow).navigator.serviceWorker.ready.then(() => true));
      await page.waitForFunction(() => (globalThis as unknown as BrowserWindow).navigator.serviceWorker.controller !== null, { timeout: 15_000 });
      await context.setOffline(true);
      await page.reload({ waitUntil: 'domcontentloaded' });

      expect(await page.title()).toContain('SRE POS');
      expect(await page.textContent('#empty')).toMatch(/scan an item to begin/i);
    } finally {
      await context.close();
    }
  });
});
