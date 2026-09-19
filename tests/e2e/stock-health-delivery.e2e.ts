import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The manager reads stock health, in a real browser (M08, ADR-0013 — the E2E matrix).**
 *
 * Every layer of "a manager opens the stock-health dashboard and sees the store's stock truth, read live" is
 * unit-tested — the session's presenter, the browser's `fetchStockHealth`, the cloud's five inventory reads. The
 * one thing units cannot prove is that a person opening the actual screen in a browser makes those five reads
 * reach the cloud under their own session and render — exceptions first, the honest gaps named, the headline
 * numbers with an "as of" time — and that a reader without the permission is shown a plain not-permitted state
 * and no figures. This drives headless Chromium against a stub cloud to prove exactly that. It is READ-ONLY:
 * there is no write to assert, and none is made.
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

interface BrowserGlobals {
  readonly stockHealthSession?: unknown;
  readonly document: {
    querySelectorAll(selector: string): { readonly length: number };
    getElementById(id: string): { readonly hidden?: boolean; readonly textContent?: string } | null;
  };
}

const AT = '2026-09-19T08:30:00.000Z';

/** The five inventory reads a manager's screen pulls, with a negative-stock exception and the headline figures. */
const CLOUD = {
  availability: { rows: [{ productId: 'p-rice', locationId: 'L1', onHandMinor: 4200 }], asAt: AT },
  exceptions: { negative: [{ productId: 'p-dal', locationId: 'L2', onHandMinor: -900, detail: 'ledger below zero', ownerAction: 'count L2 and post an adjustment' }], asAt: AT },
  valuation: { rows: [{ productId: 'p-rice', value: { minor: 500_00, currency: 'INR' } }], totalValueMinor: 500_00, method: 'weighted_average', asAt: AT },
  ageing: { rows: [], totalValue: { minor: 500_00, currency: 'INR' }, oldestBucketValue: { minor: 120_00, currency: 'INR' }, unvaluedMinor: 30_00, method: 'weighted_average', asAt: AT },
  performance: { turns: { kind: 'ratio', bp: 25_000 }, daysOfCover: { kind: 'ratio', bp: 1_460 }, gmroi: { kind: 'not_meaningful', because: 'a sold product has no known tax rate' }, method: 'weighted_average', asAt: AT },
};

interface Recorder {
  stockHealthData: Record<string, unknown>;
  status: number; // status the inventory GETs answer with (200 authorised, 403 not)
  readonly gets: string[];
}

/** A server that serves the stock-health shell (GET, operator context injected) AND answers the five inventory
 *  reads on the same origin, so `credentials:'same-origin'` and relative `/v1/inventory/...` reach it as in prod. */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const body = (path: string): unknown =>
    path === '/v1/inventory/availability' ? CLOUD.availability
      : path === '/v1/inventory/exceptions' ? CLOUD.exceptions
      : path === '/v1/inventory/valuation' ? CLOUD.valuation
      : path === '/v1/inventory/ageing' ? CLOUD.ageing
      : path === '/v1/inventory/performance' ? CLOUD.performance
      : {};
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (path.startsWith('/v1/inventory/')) {
        rec.gets.push(path);
        res.writeHead(rec.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(rec.status < 400 ? body(path) : { code: 'forbidden' }));
        return;
      }
      const file = path === '/' || path === '/stock-health' ? 'stock-health.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        let html = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.stockHealthData = ${JSON.stringify(rec.stockHealthData).replace(/</g, '\\u003c')};</script>`;
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

describe.skipIf(!HAVE_BROWSER)('manager stock-health read, end to end in a real browser (M08)', () => {
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
    await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).stockHealthSession !== undefined, undefined, { timeout: 10_000 });
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  it('an authorised manager sees the live figures — exceptions first, the honest gaps, and the headline numbers', async () => {
    const rec: Recorder = { stockHealthData: readerWith(['inventory.availability.read']), status: 200, gets: [] };
    const { page, teardown } = await open(rec);
    try {
      // The screen auto-reads the five inventory GETs on load and renders them — wait for the rows to appear.
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row').length > 0, undefined, { timeout: 10_000 });

      // All five reads reached the cloud under the manager's own session.
      for (const p of ['/v1/inventory/availability', '/v1/inventory/exceptions', '/v1/inventory/valuation', '/v1/inventory/ageing', '/v1/inventory/performance']) {
        expect(rec.gets, `${p} was not read`).toContain(p);
      }
      // Exceptions first: the negative-stock signal renders as attention (an error-tone row, not colour alone).
      expect(await page.evaluate(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row.tone-error').length), 'no negative-stock signal rendered').toBeGreaterThan(0);
      // A status carries a word for a screen reader (never colour alone).
      const firstAnnounced = await page.getAttribute('#rows .row .status', 'aria-label');
      expect((firstAnnounced ?? '').length).toBeGreaterThan(0);
      // The headline stock value rendered from the valuation read.
      expect((await page.textContent('#kpis')) ?? '').toContain('₹');
      // Freshness is on the page.
      expect((await page.textContent('#asof')) ?? '').toMatch(/as of/i);
    } finally {
      await teardown();
    }
  });

  it('Refresh re-reads the figures from the cloud (a browser→cloud read, on demand)', async () => {
    const rec: Recorder = { stockHealthData: readerWith(['inventory.availability.read']), status: 200, gets: [] };
    const { page, teardown } = await open(rec);
    try {
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row').length > 0, undefined, { timeout: 10_000 });
      const afterLoad = rec.gets.length;
      expect(afterLoad).toBeGreaterThanOrEqual(5);

      await page.click('#refresh');
      // Poll (node-side) until the click's re-read arrives at the stub, or time out.
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

  it('a reader WITHOUT the permission sees a plain not-permitted state and no figures', async () => {
    const rec: Recorder = { stockHealthData: readerWith([]), status: 403, gets: [] };
    const { page, teardown } = await open(rec);
    try {
      // The state line shows (not-permitted) and no signal rows render, whatever the cloud returned.
      await page.waitForSelector('#state:not([hidden])', { timeout: 10_000 });
      expect(await page.evaluate(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row').length)).toBe(0);
      expect(((await page.textContent('#state-text')) ?? '').toLowerCase()).toContain('permission');
    } finally {
      await teardown();
    }
  });
});
