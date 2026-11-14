import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';
import { startScreenServer, SCREEN_HOST, type ScreenServer } from '../../edge/store-edge/src/screen-server';
import { emptyPack } from '../../edge/store-edge/src/store-pack';
import type { ScreenInput } from '../../edge/store-edge/src/screen-data';
import { SyncOutbox } from '../../packages/sync/src/index';

/**
 * **The two faces load from the app's own files, with the network cut (OB-728 · P-01).**
 *
 * The owner's check in the store: "Open the till with the internet unplugged. The text is in the new font and Tamil shows
 * no boxes." This does that in a real browser: each store screen opens once (its service worker precaches the shell and
 * the nine font files), then the network is cut entirely and the screen is reloaded — and Plus Jakarta Sans and Anek Tamil
 * are both LOADED (`document.fonts`), from the cache, and the page asked no other origin for anything.
 * The customer app keeps the phone's own faces (OB-729) and is checked to ask for no font file at all.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const STORE_SCREENS = ['pos', 'manager', 'picker', 'warehouse', 'price-kiosk'] as const;

const snapshot = (): ScreenInput => ({
  pack: emptyPack(), sales: [], unreadableRecords: 0, outbox: new SyncOutbox(),
  now: '2026-08-09T12:00:00.000Z', tradingDay: '2026-08-09',
});

interface FontWindow {
  readonly navigator: { readonly serviceWorker: { ready: Promise<unknown>; controller: unknown } };
  readonly document: {
    readonly fonts: { load(font: string, text?: string): Promise<unknown[]>; check(font: string, text?: string): boolean; readonly ready: Promise<unknown> };
    readonly body: unknown;
  };
}

describe.skipIf(!HAVE_BROWSER)('the two faces load from the app\'s own files with the network cut (OB-728)', () => {
  let browser: Browser;
  let server: ScreenServer;
  let base: string;

  beforeAll(async () => {
    server = await startScreenServer({ port: 0, appsDir: 'apps', snapshot });
    base = `http://${SCREEN_HOST}:${server.port}`;
    browser = await chromium.launch({ executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
  });

  it.each(STORE_SCREENS)('%s: Plus Jakarta Sans and Anek Tamil (with the rupee sign) are loaded after an offline reload', async (screen) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const asked: string[] = [];
    page.on('request', (r) => asked.push(r.url()));
    await page.goto(`${base}/${screen}/`);
    await page.evaluate(async () => { await (globalThis as unknown as FontWindow).navigator.serviceWorker.ready; });
    // the worker's install has precached the shell — the fonts included — before it is ready
    await context.setOffline(true);
    await page.reload();
    const faces = await page.evaluate(async () => {
      const d = (globalThis as unknown as FontWindow).document;
      const latin = await d.fonts.load('600 16px "Plus Jakarta Sans"', 'Total');
      const tamil = await d.fonts.load('400 16px "Anek Tamil"', 'மொத்தம் ₹');
      return { latin: latin.length, tamil: tamil.length, latinOk: d.fonts.check('600 16px "Plus Jakarta Sans"', 'Total'), tamilOk: d.fonts.check('400 16px "Anek Tamil"', 'மொத்தம் ₹') };
    });
    expect(faces, screen).toEqual({ latin: 1, tamil: 1, latinOk: true, tamilOk: true });
    // nothing was asked of the internet — no Google Fonts, no CDN (the till's own lane service on this computer is fine)
    expect(asked.filter((u) => !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u) && !u.startsWith('data:'))).toEqual([]);
    expect(asked.filter((u) => /fonts\.(googleapis|gstatic)\.com/.test(u))).toEqual([]);
    await context.close();
  }, 60_000);

  it('the customer app keeps the phone\'s own faces: it asks for no font file at all (OB-729)', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const asked: string[] = [];
    page.on('request', (r) => asked.push(r.url()));
    await page.goto(`${base}/customer/`);
    await page.evaluate(async () => {
      const w = globalThis as unknown as FontWindow;
      await w.navigator.serviceWorker.ready;
      await w.document.fonts.ready;
    });
    expect(asked.filter((u) => /\.woff2$/.test(u))).toEqual([]);
    expect(await page.evaluate(() => {
      const w = globalThis as unknown as { getComputedStyle(el: unknown): { fontFamily: string }; document: { body: unknown } };
      return w.getComputedStyle(w.document.body).fontFamily;
    })).toMatch(/^system-ui/);
    await context.close();
  }, 60_000);
});
