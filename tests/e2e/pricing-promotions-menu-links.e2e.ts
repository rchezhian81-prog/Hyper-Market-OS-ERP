import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startScreenServer, SCREEN_HOST, type ScreenServer } from '../../edge/store-edge/src/screen-server';
import { emptyPack } from '../../edge/store-edge/src/store-pack';
import type { ScreenInput } from '../../edge/store-edge/src/screen-data';
import { SyncOutbox } from '../../packages/sync/src/index';

/**
 * **The "Pricing" and "Promotions" menu links open the real screen, in a real browser (M05 · P-07).**
 *
 * The pricing + promotions functionality is the browser-verified "Products and prices" screen
 * (`catalogue`, tabs items/price/promo). The menu carried "Pricing" and "Promotions" as their own items,
 * but the box served no such routes — dead links. They now redirect to the catalogue screen on the right
 * tab. Units prove the redirect strings; this drives real headless Chromium through the box's own router:
 * navigate to `/pricing` and land on the catalogue screen with the PRICE tab active; `/promotions` → the
 * PROMO tab; `/products` → the item list. The browser follows the box's 302 exactly as a shop laptop does.
 *
 * Self-skips where no browser is present, like every other e2e.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);

const snapshot = (): ScreenInput => ({
  pack: emptyPack(), sales: [], unreadableRecords: 0, outbox: new SyncOutbox(),
  now: '2026-08-09T12:00:00.000Z', tradingDay: '2026-08-09',
});

interface BrowserDoc {
  readonly document: { getElementById(id: string): { getAttribute(name: string): string | null } | null };
  readonly location: { readonly pathname: string; readonly search: string };
}

describe.skipIf(!HAVE_BROWSER)('the Pricing/Promotions menu links open the catalogue screen on the right tab (M05 · P-07)', () => {
  let browser: Browser;
  let server: ScreenServer;
  let base: string;

  beforeAll(async () => {
    // Build the CURRENT web-erp bundle so the browser runs this branch's catalogue view, not a stale one.
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    server = await startScreenServer({ port: 0, appsDir: 'apps', snapshot });
    base = `http://${SCREEN_HOST}:${server.port}`;
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
  });

  const openAndReadTab = async (path: string): Promise<{ pathname: string; search: string; active: string | null }> => {
    // Block the service worker: this test is about the ROUTER (redirect → right tab), not offline caching
    // (which `screens-open-offline` covers). A live SW would cache the shell and race the redirected
    // navigation across the three cases, so blocking it makes the routing check deterministic.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      // The browser follows the box's redirect to the catalogue screen, exactly as a shop laptop would.
      await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => (globalThis as unknown as BrowserDoc).document.getElementById('tab-price') !== null,
        undefined, { timeout: 15_000 },
      );
      // Await the read BEFORE the finally closes the context — returning the promise unawaited races
      // the close and throws "Target page … closed".
      const result = await page.evaluate(() => {
        const w = globalThis as unknown as BrowserDoc;
        const activeOf = (id: string) => w.document.getElementById(id)?.getAttribute('aria-current') ?? null;
        // Exactly one of the tabs reads aria-current="page"; return which.
        for (const tab of ['items', 'price', 'shelf', 'promo']) {
          if (activeOf(`tab-${tab}`) === 'page') return { pathname: w.location.pathname, search: w.location.search, active: tab };
        }
        return { pathname: w.location.pathname, search: w.location.search, active: null };
      });
      return result;
    } finally {
      await context.close();
    }
  };

  it('/pricing redirects to the catalogue screen with the PRICE tab active', async () => {
    const r = await openAndReadTab('/pricing');
    expect(r.pathname).toBe('/catalogue/');
    expect(r.search).toContain('tab=price');
    expect(r.active).toBe('price');
  });

  it('/promotions redirects to the catalogue screen with the PROMO tab active', async () => {
    const r = await openAndReadTab('/promotions');
    expect(r.pathname).toBe('/catalogue/');
    expect(r.search).toContain('tab=promo');
    expect(r.active).toBe('promo');
  });

  it('/products redirects to the catalogue screen on the item list', async () => {
    const r = await openAndReadTab('/products');
    expect(r.pathname).toBe('/catalogue/');
    expect(r.active).toBe('items');
  });
});
