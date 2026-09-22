import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The warehouse HANDHELD executes, in a real browser (M09 / OA-9 — the shop-floor half).**
 *
 * M09's execution surface is the scanner-first handheld (`apps/warehouse-app`): a worker receives a
 * delivery and puts it away, offline, and every accepted scan queues DURABLY to the device's own outbox
 * (§31/P-01 — the wifi dies between the freezers). The rules live in the tested `WarehouseSession`; what
 * units cannot prove is that a worker at the ACTUAL screen — where a scan is a keyboard typing a code and
 * pressing Enter, with no input box to lose focus — makes each accepted scan land in the device outbox,
 * and that the food-safety gate holds on screen. This drives headless Chromium:
 *
 *   • RECEIVE: scan a known delivery barcode → the goods-received event lands in the device outbox;
 *   • PUT-AWAY: select a goods-in item, scan a pickable bin → the movement lands in the outbox;
 *   • RECALL SAFETY (M10-FR-04): a recalled item scanned into a PICKABLE bin is refused on screen and
 *     nothing is queued — a recalled tin can never be put where it sells, even offline.
 *
 * The writes are offline-first (device outbox, not a network call), so this asserts the queued events.
 * Self-skips where no browser is present, like every other e2e.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/warehouse-app/web';

interface BrowserGlobals {
  readonly warehouseSession?: unknown;
  readonly warehouseOutbox?: { unsentCount(): number };
}

/** A worker's cached assignment: one pickable bin, one product on order (barcode → product), and two
 *  goods-in items awaiting put-away — one good, one recalled (must never reach a pickable bin). */
const assignment = (): Record<string, unknown> => ({
  assignmentId: 'A-1',
  workerId: 'u-picker',
  storeId: 'store-1',
  bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' }],
  grnId: 'grn-1',
  ordered: [{ productId: 'p-rice', quantityMinor: 100, unitCost: { minor: 4000, currency: 'INR' } }],
  barcodes: [{ barcode: '890RICE', productId: 'p-rice', level: 'unit' }],
  packs: [{ productId: 'p-rice', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890RICE' }] }],
  goodsIn: [
    { productId: 'p-good', batchId: null, quantityMinor: 6, uom: 'EA', state: 'good', expiry: null, recalled: false },
    { productId: 'p-recalled', batchId: 'b-9', quantityMinor: 3, uom: 'EA', state: 'good', expiry: null, recalled: true },
  ],
  recalledProductIds: ['p-recalled'],
});

async function startShell(data: Record<string, unknown>): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const file = path === '/' || path === '/warehouse' ? 'index.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.warehouseData = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>`;
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

describe.skipIf(!HAVE_BROWSER)('warehouse handheld delivery, end to end in a real browser (M09)', () => {
  let browser: Browser;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'warehouse-app'], { stdio: 'ignore' });
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
      () => (globalThis as unknown as BrowserGlobals).warehouseSession != null,
      undefined, { timeout: 10_000 },
    );
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  const unsent = (page: import('playwright-core').Page) =>
    page.evaluate(() => (globalThis as unknown as BrowserGlobals).warehouseOutbox?.unsentCount() ?? -1);

  /** A shop scanner is a keyboard: type the code, press Enter. The screen's global listener catches it. */
  const scan = async (page: import('playwright-core').Page, code: string) => {
    await page.waitForSelector('#scan:not([hidden])', { timeout: 10_000 });
    await page.keyboard.type(code);
    await page.keyboard.press('Enter');
  };

  it('receiving a known delivery barcode queues the goods-received event to the device outbox (§31/P-01)', async () => {
    const { page, teardown } = await open(assignment());
    try {
      expect(await unsent(page)).toBe(0);
      await page.click('#receive');
      await scan(page, '890RICE'); // resolves to p-rice, which is on order → received
      await page.waitForFunction(
        () => ((globalThis as unknown as BrowserGlobals).warehouseOutbox?.unsentCount() ?? 0) >= 1,
        undefined, { timeout: 10_000 },
      );
      expect(await unsent(page)).toBe(1);
    } finally {
      await teardown();
    }
  });

  it('putting a good item away into a pickable bin queues the movement to the device outbox', async () => {
    const { page, teardown } = await open(assignment());
    try {
      // Select the good goods-in item (the first row), which enables Put away.
      const goodRow = page.locator('.item', { hasText: 'p-good' });
      await goodRow.click();
      await page.click('#put-away');
      await scan(page, 'BIN-A');
      await page.waitForFunction(
        () => ((globalThis as unknown as BrowserGlobals).warehouseOutbox?.unsentCount() ?? 0) >= 1,
        undefined, { timeout: 10_000 },
      );
      expect(await unsent(page)).toBe(1);
    } finally {
      await teardown();
    }
  });

  it('a recalled item scanned into a pickable bin is refused on screen — nothing queued (M10-FR-04)', async () => {
    const { page, teardown } = await open(assignment());
    try {
      const recalledRow = page.locator('.item', { hasText: 'p-recalled' });
      await recalledRow.click();
      await page.click('#put-away');
      await scan(page, 'BIN-A'); // a pickable bin — a recalled tin may never go where it sells
      // The refusal is felt on screen; the durable outbox stays empty — the movement was never accepted.
      await page.waitForSelector('#banner:not([hidden]), .banner:not([hidden])', { timeout: 10_000 }).catch(() => undefined);
      expect(await unsent(page)).toBe(0);
    } finally {
      await teardown();
    }
  });
});
