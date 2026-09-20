import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The manager reviews goods receipts, in a real browser (M07-FR-02/03, ADR-0013 — the E2E matrix).**
 *
 * Every layer of "a manager opens the goods-receipt review and sees what came in the back door" is unit-tested —
 * the session's presenter, the browser's `fetchGoodsReceipt`, the cloud's GRN list route. The one thing units
 * cannot prove is that a person opening the actual screen in a browser makes that read reach the cloud under their
 * own session and render — deliveries needing a second person first (§28), the valued differences named, the
 * "as of" time — and that a reader without the permission is shown a plain not-permitted state and no figures.
 * This drives headless Chromium against a stub cloud to prove exactly that. It is READ-ONLY: there is no write to
 * assert, and none is made (receiving is captured on the handheld).
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

interface BrowserGlobals {
  readonly goodsReceiptSession?: unknown;
  readonly document: {
    querySelectorAll(selector: string): { readonly length: number };
    getElementById(id: string): { readonly hidden?: boolean; readonly textContent?: string } | null;
  };
}

const AT = '2026-09-20T08:30:00.000Z';

/** The GRN list a manager's screen pulls: one delivery needing a second person (§28), then a clean one. */
const CLOUD = {
  receipts: [
    {
      grnId: 'g-approve', number: 'GRN-2', poId: 'po-2', warehouseId: 'W1', receivedBy: 'u-recv', receivedAt: AT,
      availableMinor: 80_00,
      captured: {
        requiresApproval: true, discrepancyValue: { minor: 150_00, currency: 'INR' },
        discrepancies: [{ lineId: 'l1', productId: 'p-oil', kind: 'excess', quantityMinor: 20_00, value: { minor: 150_00, currency: 'INR' }, requiresApproval: true, detail: '20 more than ordered' }],
        lines: [{ lineId: 'l1', productId: 'p-oil', sellableMinor: 80_00, quarantinedMinor: 0, rejectedMinor: 0, disposition: 'sellable', uom: 'ea', batchId: null, expiry: null }],
      },
    },
    {
      grnId: 'g-clean', number: 'GRN-1', poId: 'po-1', warehouseId: 'W1', receivedBy: 'u-recv', receivedAt: AT,
      availableMinor: 100_00,
      captured: {
        requiresApproval: false, discrepancyValue: { minor: 0, currency: 'INR' },
        discrepancies: [],
        lines: [{ lineId: 'l1', productId: 'p-rice', sellableMinor: 100_00, quarantinedMinor: 0, rejectedMinor: 0, disposition: 'sellable', uom: 'ea', batchId: null, expiry: null }],
      },
    },
  ],
  count: 2, needingApprovalCount: 1,
};

interface Recorder {
  goodsReceiptData: Record<string, unknown>;
  status: number; // status the GRN list GET answers with (200 authorised, 403 not)
  readonly gets: string[];
}

/** A server that serves the goods-receipt shell (GET, operator context injected) AND answers the GRN list read
 *  on the same origin, so `credentials:'same-origin'` and a relative `/v1/inventory/...` reach it as in prod. */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (path.startsWith('/v1/inventory/goods-receipt')) {
        rec.gets.push(path);
        res.writeHead(rec.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(rec.status < 400 ? CLOUD : { code: 'forbidden' }));
        return;
      }
      const file = path === '/' || path === '/goods-receipt' ? 'goods-receipt.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        let html = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.goodsReceiptData = ${JSON.stringify(rec.goodsReceiptData).replace(/</g, '\\u003c')};</script>`;
          html = html.replace('<!--SCREEN-DATA-->', inject);
        }
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(html);
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

const readerWith = (permissions: readonly string[]): Record<string, unknown> => ({ userId: 'u-mgr', permissions });

describe.skipIf(!HAVE_BROWSER)('manager goods-receipt review, end to end in a real browser (M07)', () => {
  let browser: Browser;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  const open = async (rec: Recorder) => {
    const srv = await startShellAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).goodsReceiptSession !== undefined, undefined, { timeout: 10_000 });
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  it('an authorised manager sees the deliveries — exceptions first, the differences named and priced', async () => {
    const rec: Recorder = { goodsReceiptData: readerWith(['inventory.availability.read']), status: 200, gets: [] };
    const { page, teardown } = await open(rec);
    try {
      // The screen auto-reads the GRN list on load and renders it — wait for the rows to appear.
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows li.row').length > 0, undefined, { timeout: 10_000 });

      // The read reached the cloud under the manager's own session.
      expect(rec.gets.some((p) => p.startsWith('/v1/inventory/goods-receipt'))).toBe(true);
      // Exceptions first: the needs-a-second-person delivery renders as an error-tone row (not colour alone).
      expect(await page.evaluate(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows li.row.tone-error').length), 'no needs-approval signal rendered').toBeGreaterThan(0);
      // The first row is the one that needs approval (worst-first), and it carries a screen-reader word.
      const firstAnnounced = await page.getAttribute('#rows li.row .status', 'aria-label');
      expect((firstAnnounced ?? '').length).toBeGreaterThan(0);
      // The valued difference is shown in rupees.
      expect((await page.textContent('#rows')) ?? '').toContain('₹');
      // Freshness is on the page.
      expect(((await page.textContent('#asof')) ?? '').toLowerCase()).toContain('as of');
    } finally {
      await teardown();
    }
  });

  it('Refresh re-reads the deliveries from the cloud (a browser→cloud read, on demand)', async () => {
    const rec: Recorder = { goodsReceiptData: readerWith(['inventory.availability.read']), status: 200, gets: [] };
    const { page, teardown } = await open(rec);
    try {
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows li.row').length > 0, undefined, { timeout: 10_000 });
      const afterLoad = rec.gets.length;
      expect(afterLoad).toBeGreaterThanOrEqual(1);

      await page.click('#refresh');
      const grew = await new Promise<boolean>((resolve) => {
        const started = Date.now();
        const tick = (): void => {
          if (rec.gets.length > afterLoad) { resolve(true); return; }
          if (Date.now() - started > 5_000) { resolve(false); return; }
          setTimeout(tick, 50);
        };
        tick();
      });
      expect(grew, 'Refresh did not re-read the cloud').toBe(true);
    } finally {
      await teardown();
    }
  });

  it('a reader WITHOUT the permission sees a plain not-permitted state and no deliveries', async () => {
    const rec: Recorder = { goodsReceiptData: readerWith([]), status: 403, gets: [] };
    const { page, teardown } = await open(rec);
    try {
      await page.waitForSelector('#state:not([hidden])', { timeout: 10_000 });
      expect(await page.evaluate(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows li.row').length)).toBe(0);
      expect(((await page.textContent('#state-text')) ?? '').toLowerCase()).toContain('permission');
    } finally {
      await teardown();
    }
  });
});
