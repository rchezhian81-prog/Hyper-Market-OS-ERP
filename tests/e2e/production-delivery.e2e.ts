import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The QC operator releases a finished batch for sale, in a real browser (M11-FR-03 · API-04 · §28 — the E2E matrix).**
 *
 * Every layer of the production quality-release desk — the tested session model, the release port, the board
 * fold — is unit- and integration-tested. The one thing units cannot prove is that a QC operator, in an ACTUAL
 * browser, seeing a finished batch still in quarantine and clicking **"Release for sale"**, makes that decision
 * reach the cloud under their OWN session, and that the batch then drops off the board. This drives headless
 * Chromium against a stub cloud to prove exactly that end to end:
 *
 *   • an authorised QC operator (production.read + production.release) → clicking Release POSTs
 *     {qcPassed:true} to /v1/production/runs/:runId/release under their own session; the batch then drops off
 *     the board once it is re-READ (the server now folds it released:true — a re-derive, never a client shuffle);
 *   • a read-only user (production.read only) → sees the board but is offered NO release/hold buttons, so no
 *     write can even be started (P-04 least privilege: the server re-checks too, but the screen never offers it).
 *
 * Freshly-made food is not for sale because it exists; it is for sale when a human has looked at it and released
 * it (hard rule #5 — no AI releases food for sale). The board is read live from a single GET
 * (/v1/production/runs), exactly as in production. The browser binary is the environment's pre-installed
 * Chromium; where none is present the suite SKIPS rather than failing, exactly like the rostering delivery suite
 * it mirrors.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

interface BrowserGlobals {
  readonly document: {
    querySelectorAll(selector: string): { readonly length: number };
  };
}

/** One finished bakery batch still in quarantine — a real, releasable run. The board hands back its full shape;
 *  once released, the server folds it `released: true`, so the screen (which shows only un-released runs) drops
 *  it on the next read. */
const RUN_ID = 'run-loaf';
const RUN = {
  runId: RUN_ID, departmentId: 'bakery', outputProductId: 'p-loaf', outputBatchId: 'B-run-loaf',
  outputQuantityMinor: 12000, outputUom: 'ea', expiresAt: '2026-09-28T00:00:00.000Z',
  outputUnitCostMinor: 25000, currency: 'INR', costKnown: true, uncostedProducts: [],
  yieldVerdict: 'as_expected', exceptions: [], released: false,
};

interface Recorder {
  productionData: Record<string, unknown>;
  releaseStatus: number;
  released: boolean;
  readonly requests: { method: string; path: string; body: unknown }[];
}

/** A server that BOTH serves the shell (GET, operator context injected) AND answers the two routes the desk
 *  touches — the release POST (runId in the URL) and the read-only board GET (/v1/production/runs) — on the SAME
 *  origin, so `credentials: 'same-origin'` and a relative `/v1/...` reach it exactly as in production. Once a
 *  release is recorded, the board returns the run folded `released: true`, so a released batch drops off on
 *  re-read (a server re-derive, never a client-side shuffle). */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (req.method === 'POST' && path.startsWith('/v1/production/runs/') && path.endsWith('/release')) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        rec.requests.push({ method: 'POST', path, body: raw === '' ? undefined : JSON.parse(raw) });
        if (rec.releaseStatus >= 200 && rec.releaseStatus < 300) rec.released = true;
        res.writeHead(rec.releaseStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ run: { ...RUN, released: rec.released } }));
        return;
      }
      if (req.method === 'GET' && path === '/v1/production/runs') {
        rec.requests.push({ method: 'GET', path, body: undefined });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ runs: [{ ...RUN, released: rec.released }], asAt: '2026-09-22T00:00:00.000Z' }));
        return;
      }
      const file = path === '/' || path === '/production' ? 'production.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.productionData = ${JSON.stringify(rec.productionData).replace(/</g, '\\u003c')};</script>`;
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

const operator = (userId: string, permissions: readonly string[]): Record<string, unknown> => ({
  userId, permissions,
});

describe.skipIf(!HAVE_BROWSER)('the QC operator releases a batch for sale, end to end in a real browser (M11-FR-03)', () => {
  let browser: Browser;

  beforeAll(async () => {
    // Build the CURRENT web-erp bundle so the browser runs this branch's code, not a stale artifact.
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  const openScreen = async (rec: Recorder) => {
    const srv = await startShellAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    // The board is read live on load (one GET), so the batch only appears once the read resolves.
    await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row').length > 0, undefined, { timeout: 10_000 });
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  it('an authorised QC operator: clicking Release POSTs {qcPassed:true}, and the batch drops off on re-read', async () => {
    const rec: Recorder = { productionData: operator('u-qc', ['production.read', 'production.release']), releaseStatus: 200, released: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      expect(await page.locator('#rows .row').count()).toBe(1);
      // The release/hold buttons are offered (the operator holds production.release).
      expect(await page.locator('#rows button.release').count()).toBe(1);
      expect(await page.locator('#rows button.hold').count()).toBe(1);

      await page.click('#rows button.release');

      // The batch drops off because the board was re-READ (server re-derive: it now folds released:true),
      // not shuffled client-side.
      await page.waitForFunction(
        () => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row').length === 0,
        undefined, { timeout: 10_000 },
      );
      const post = rec.requests.find((r) => r.method === 'POST' && r.path === `/v1/production/runs/${RUN_ID}/release`);
      expect(post, 'the release was not POSTed to the run/release URL').toBeDefined();
      expect((post!.body as { qcPassed?: boolean }).qcPassed).toBe(true);

      // The board read runs at least twice: once on load, once after the release to re-derive.
      expect(rec.requests.filter((r) => r.method === 'GET' && r.path === '/v1/production/runs').length).toBeGreaterThanOrEqual(2);
      expect(await page.locator('#rows .row').count()).toBe(0);
      expect(await page.locator('#result').getAttribute('hidden')).toBeNull();
    } finally {
      await teardown();
    }
  });

  it('a read-only user sends NOTHING — no release/hold buttons are rendered', async () => {
    const rec: Recorder = { productionData: operator('u-readonly', ['production.read']), releaseStatus: 200, released: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      expect(await page.locator('#rows .row').count()).toBe(1); // they can see the board
      expect(await page.locator('#rows button.release').count()).toBe(0); // but no way to release
      expect(await page.locator('#rows button.hold').count()).toBe(0);
      expect(rec.requests.some((r) => r.method === 'POST')).toBe(false);
    } finally {
      await teardown();
    }
  });
});
