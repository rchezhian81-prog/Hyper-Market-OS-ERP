import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

/**
 * **The driver's phone records a PARTIAL delivery, in a real browser (M19-FR-01/FR-03 / A3).**
 *
 * The full delivery lifecycle (including `deliverPartial → partially_delivered`) lives in the tested
 * `RouteSession` and is wired to the screen via `apps/delivery-app/src/browser-entry.ts`
 * (`window.routeSession`). What units cannot prove is that a driver at the ACTUAL screen — tapping the
 * new "Partly delivered" button, choosing proof — makes the partial land DURABLY in the device outbox,
 * and that a partial WITHOUT proof is refused on screen with nothing queued (M19-FR-03 / P-08). This
 * drives headless Chromium against the built bundle:
 *
 *   • PARTIAL WITH PROOF: select a stop, tap "Partly delivered", choose a proof kind → the stop becomes
 *     `partially_delivered` and a `DeliveryStopUpdated` event lands in the device outbox (§31/P-01,
 *     offline-first — no network call);
 *   • PARTIAL WITHOUT PROOF: cancel the proof step → refused on screen and NOTHING is queued.
 *
 * Self-skips where no browser is present, like every other e2e.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/delivery-app/web';

interface BrowserGlobals {
  readonly routeSession?: unknown;
  readonly driverOutbox?: { unsentCount(): number };
}

/** A route with one PREPAID stop (codMinor 0) — so the partial flow needs only proof, no cash entry. */
const route = (): Record<string, unknown> => ({
  routeId: 'R-1',
  driverId: 'u-driver',
  stops: [
    { stopId: 's1', orderRef: 'ORD-1', area: 'Anna Nagar', codMinor: 0 },
  ],
});

async function startShell(data: Record<string, unknown>): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const file = path === '/' || path === '/delivery' ? 'index.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html'
          : file.endsWith('.js') ? 'text/javascript'
            : file.endsWith('.webmanifest') ? 'application/manifest+json'
              : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.driverData = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>`;
          body = body.replace('<!--SCREEN-DATA-->', inject);
        }
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); }) });
    });
  });
}

describe.skipIf(!HAVE_BROWSER)('driver partial delivery, end to end in a real browser (M19-FR-01/FR-03 / A3)', () => {
  let browser: Browser;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'delivery-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  const open = async (data: Record<string, unknown>) => {
    const srv = await startShell(data);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(
      () => (globalThis as unknown as BrowserGlobals).routeSession != null,
      undefined, { timeout: 10_000 },
    );
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  const unsent = (page: Page) =>
    page.evaluate(() => (globalThis as unknown as BrowserGlobals).driverOutbox?.unsentCount() ?? -1);

  it('a partial delivery with proof lands in the device outbox (§31/P-01)', async () => {
    const { page, teardown } = await open(route());
    try {
      expect(await unsent(page)).toBe(0);
      await page.locator('.stop').first().click(); // select the stop
      await page.click('#delivered-partial');
      // The proof-kind chooser opens; pick "Photo at the door" (needs no reference, prepaid needs no cash).
      await page.waitForSelector('#sheet:not([hidden])', { timeout: 10_000 });
      await page.locator('#choices button', { hasText: 'Photo at the door' }).click();
      await page.waitForSelector('.stop.partially_delivered', { timeout: 10_000 });
      // An assigned stop auto-departs first, so the queue holds the depart AND the partial — both are
      // real state changes, each durably recorded (§31/P-01). The invariant that matters: the partial
      // reached the device outbox and did not vanish.
      await page.waitForFunction(
        () => ((globalThis as unknown as BrowserGlobals).driverOutbox?.unsentCount() ?? 0) >= 1,
        undefined, { timeout: 10_000 },
      );
      expect(await unsent(page)).toBeGreaterThanOrEqual(1);
    } finally {
      await teardown();
    }
  });

  it('a partial delivery WITHOUT proof is refused on screen — nothing queued (M19-FR-03 / P-08)', async () => {
    const { page, teardown } = await open(route());
    try {
      await page.locator('.stop').first().click();
      await page.click('#delivered-partial');
      // Cancel at the proof step — no proof, so the model would refuse it and the screen records nothing.
      await page.waitForSelector('#sheet:not([hidden])', { timeout: 10_000 });
      await page.click('#sheet-cancel');
      await page.waitForSelector('#sheet', { state: 'hidden', timeout: 10_000 });
      expect(await unsent(page)).toBe(0);
      expect(await page.locator('.stop.partially_delivered').count()).toBe(0);
    } finally {
      await teardown();
    }
  });
});
