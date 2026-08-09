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
