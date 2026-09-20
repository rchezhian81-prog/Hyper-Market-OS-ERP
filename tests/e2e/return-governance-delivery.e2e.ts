import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The owner/manager reviews the refund exceptions, in a real browser (M13-FR-01/03 · M17 · API-05 — the E2E matrix).**
 *
 * Every layer of the refund-exceptions screen — the tested session model, the exhaustive flag labels, the live
 * fetch — is unit- and integration-tested. The one thing units cannot prove is that an authorised person, in an
 * actual browser, OPENS `/return-governance` and SEES the flagged refunds (read live from the cloud) with WHAT
 * BROKE spelled out — and, because this is a governance/loss VIEW, that the screen never writes anything (the
 * money already moved at the lane; a breach is worked out of band). This drives headless Chromium against a stub
 * cloud to prove exactly that end to end:
 *
 *   • an authorised reviewer (lp.case.read) → the flagged refund renders from the LIVE GET, its governance flag
 *     shown in words, and NOT ONE write verb (POST/PUT/PATCH/DELETE) is ever sent — read-only, proven;
 *   • a user without lp.case.read → no exception rows are shown, and still nothing is sent.
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS rather
 * than failing, exactly like the loss-prevention close-delivery suite it mirrors.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

interface BrowserGlobals {
  readonly document: {
    querySelectorAll(selector: string): { readonly length: number };
  };
}

/** One flagged refund as `GET /v1/pos/return-governance-exceptions` hands it over — a store credit taken at the
 *  lane that exceeded the owner's cap (the money already moved, so it is recorded and flagged, never rejected). */
const ONE_EXCEPTION = {
  returnId: 'RT-9', originalSaleId: 'S-9', laneId: 'lane-1', processedBy: 'u-lanecash', approvedBy: 'u-mgr',
  customerRef: 'c-asha', reasonCode: 'customer_changed_mind', refundMinor: 50000, refundTender: 'store_credit',
  refundStatus: 'settled', processedAt: '2026-09-18T10:00:00.000Z',
  lines: [{ productId: 'P1', uom: 'each', quantityMinor: 1, disposition: 'resell' }],
  governanceFlags: ['store_credit_over_cap'],
};
const EXCEPTIONS = { count: 1, exceptions: [ONE_EXCEPTION], asAt: '2026-09-18T12:00:00.000Z' };

interface Recorder {
  data: Record<string, unknown>;
  readonly requests: { method: string; path: string }[];
}

/** A server that BOTH serves the shell (GET, reviewer context injected) AND answers the one route the screen
 *  touches — the exceptions GET — on the SAME origin, so `credentials: 'same-origin'` and a relative `/v1/...`
 *  reach it exactly as in production. It records EVERY request so the test can prove no write was ever made. */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      rec.requests.push({ method: req.method ?? 'GET', path });
      if (req.method === 'GET' && path === '/v1/pos/return-governance-exceptions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(EXCEPTIONS));
        return;
      }
      const file = path === '/' || path === '/return-governance' ? 'return-governance.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.returnGovernanceData = ${JSON.stringify(rec.data).replace(/</g, '\\u003c')};</script>`;
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

const reviewer = (permissions: readonly string[]): Record<string, unknown> => ({ userId: 'u-owner', tenantId: 't1', permissions });

describe.skipIf(!HAVE_BROWSER)('the refund exceptions are reviewed, end to end in a real browser (M13-FR-01/03)', () => {
  let browser: Browser;

  beforeAll(async () => {
    // Build the CURRENT web-erp bundle so the browser runs this branch's code, not a stale artifact.
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('an authorised reviewer sees the flagged refund from the live read, with what broke in words — and nothing is written', async () => {
    const rec: Recorder = { data: reviewer(['lp.case.read']), requests: [] };
    const srv = await startShellAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });
      // The row appears only after the LIVE GET returns the exception and the screen re-presents it.
      await page.waitForFunction(
        () => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row').length > 0,
        undefined, { timeout: 10_000 },
      );
      expect(await page.locator('#rows .row').count()).toBe(1);
      // The refund amount and WHAT BROKE are both on screen, in words.
      expect(await page.locator('#rows .row .value').textContent()).toBe('₹500.00');
      expect(await page.locator('#rows .row .chip').textContent()).toBe('Store credit above your cap (or no cap set)');
      // The live read happened.
      expect(rec.requests.some((r) => r.method === 'GET' && r.path === '/v1/pos/return-governance-exceptions')).toBe(true);
      // READ-ONLY, end to end: not one write verb was ever sent.
      const writes = rec.requests.filter((r) => r.method !== 'GET' && r.method !== 'HEAD');
      expect(writes, `a write reached the server: ${writes.map((w) => `${w.method} ${w.path}`).join(', ')}`).toEqual([]);
    } finally {
      await context.close();
      await srv.stop();
    }
  });

  it('a user without lp.case.read is shown no exceptions — and still nothing is written', async () => {
    const rec: Recorder = { data: reviewer([]), requests: [] };
    const srv = await startShellAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });
      // Give the shell a moment to boot and (if it were going to) render.
      await page.waitForSelector('#state:not([hidden])', { timeout: 10_000 });
      expect(await page.locator('#rows .row').count()).toBe(0);
      const writes = rec.requests.filter((r) => r.method !== 'GET' && r.method !== 'HEAD');
      expect(writes).toEqual([]);
    } finally {
      await context.close();
      await srv.stop();
    }
  });
});
