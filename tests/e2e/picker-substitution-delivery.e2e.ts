import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

/**
 * **The picker HANDHELD records a substitution, in a real browser (M19-FR-01 / A04 / P-08).**
 *
 * The substitution rule lives in the tested `PickSession` and is wired to the screen via
 * `apps/picker-app/src/browser-entry.ts` (`window.pickSession`). What units cannot prove is that a
 * picker at the ACTUAL screen — where a scan is a keyboard typing a code and pressing Enter, and there
 * is deliberately no text box to type a "yes" into — makes an agreed swap land DURABLY in the device
 * outbox, and that a swap WITHOUT the customer's confirmation reference is refused on screen with
 * nothing queued. This drives headless Chromium against the built bundle:
 *
 *   • SWAP WITH A REFERENCE: scan the substitute item, then scan the customer's confirmation
 *     reference → the line becomes `substituted` and a `PickLineResolved` event lands in the device
 *     outbox (§31/P-01 — the handheld works offline, the queue drains later);
 *   • SWAP WITHOUT A REFERENCE (A04): cancel the reference scan → the swap is refused on screen and
 *     NOTHING is queued. A substitution is never the picker's silent choice.
 *
 * The writes are offline-first (device outbox, not a network call), so this asserts the queued events.
 * Self-skips where no browser is present, like every other e2e.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/picker-app/web';

interface BrowserGlobals {
  readonly pickSession?: unknown;
  readonly pickerOutbox?: { unsentCount(): number };
}

/** A cached wave with one pending line the picker can swap. */
const wave = (): Record<string, unknown> => ({
  waveId: 'W-1',
  pickerId: 'u-picker',
  lines: [
    {
      lineId: 'l1',
      orderRef: 'ORD-1',
      productId: 'MILK',
      description: 'Milk 1L',
      bin: 'A-01',
      requiredQty: 2,
      uom: 'ea',
      unitPrice: { minor: 5000, currency: 'INR' },
    },
  ],
});

async function startShell(data: Record<string, unknown>): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const file = path === '/' || path === '/picker' ? 'index.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html'
          : file.endsWith('.js') ? 'text/javascript'
            : file.endsWith('.webmanifest') ? 'application/manifest+json'
              : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.pickerData = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>`;
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

describe.skipIf(!HAVE_BROWSER)('picker handheld substitution, end to end in a real browser (M19-FR-01 / A04)', () => {
  let browser: Browser;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'picker-app'], { stdio: 'ignore' });
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
      () => (globalThis as unknown as BrowserGlobals).pickSession != null,
      undefined, { timeout: 10_000 },
    );
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  const unsent = (page: Page) =>
    page.evaluate(() => (globalThis as unknown as BrowserGlobals).pickerOutbox?.unsentCount() ?? -1);

  /**
   * A shop scanner is a keyboard that emits `keydown` events on the window and finishes with Enter —
   * which is exactly what the screen's global scan listener reads. We drive that hardware faithfully by
   * dispatching the same keydown events, rather than through synthetic focus-dependent typing, so the
   * scan reaches the listener deterministically in headless Chromium.
   */
  const scan = async (page: Page, code: string) => {
    await page.waitForSelector('#scan:not([hidden])', { timeout: 10_000 });
    await page.evaluate((c: string) => {
      // Reached through globalThis (the DOM lib is not in the test tsconfig): a barcode scanner is a
      // keyboard, and this dispatches the same window keydown events the screen's scan listener reads.
      const w = globalThis as unknown as {
        dispatchEvent(e: unknown): boolean;
        KeyboardEvent: new (type: string, init: { key: string; bubbles: boolean }) => unknown;
      };
      for (const ch of c) w.dispatchEvent(new w.KeyboardEvent('keydown', { key: ch, bubbles: true }));
      w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }, code);
  };

  /** Tapping a line starts its pick (bin scan); cancel it so the line stays SELECTED for a swap. */
  const selectLine = async (page: Page) => {
    await page.locator('.line').first().click();
    await page.waitForSelector('#scan:not([hidden])', { timeout: 10_000 });
    await page.click('#scan-cancel');
    await page.waitForSelector('#scan', { state: 'hidden', timeout: 10_000 });
  };

  it('a swap with the customer’s confirmation reference lands in the device outbox (§31/P-01)', async () => {
    const { page, teardown } = await open(wave());
    try {
      expect(await unsent(page)).toBe(0);
      await selectLine(page);
      await page.click('#substitute');
      await scan(page, 'SUB-999'); // the substitute item
      await scan(page, 'REF-123'); // the customer's confirmation reference — not a tick box
      await page.waitForSelector('.line.substituted', { timeout: 10_000 });
      await page.waitForFunction(
        () => ((globalThis as unknown as BrowserGlobals).pickerOutbox?.unsentCount() ?? 0) >= 1,
        undefined, { timeout: 10_000 },
      );
      expect(await unsent(page)).toBe(1);
    } finally {
      await teardown();
    }
  });

  it('a swap WITHOUT the customer’s reference is refused on screen — nothing queued (A04 / P-08)', async () => {
    const { page, teardown } = await open(wave());
    try {
      await selectLine(page);
      await page.click('#substitute');
      await scan(page, 'SUB-999'); // the substitute item
      // The reference scan is where the customer's confirmation must come from. Cancel it: no reference.
      await page.waitForSelector('#scan:not([hidden])', { timeout: 10_000 });
      await page.click('#scan-cancel');
      // The refusal is felt on screen; the durable outbox stays empty and the line is not substituted.
      await page.waitForSelector('#banner:not([hidden])', { timeout: 10_000 }).catch(() => undefined);
      expect(await unsent(page)).toBe(0);
      expect(await page.locator('.line.substituted').count()).toBe(0);
    } finally {
      await teardown();
    }
  });
});
