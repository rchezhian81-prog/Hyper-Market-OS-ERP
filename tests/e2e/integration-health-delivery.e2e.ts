import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The admin reads which outside connections are alive, in a real browser (M32-FR-04 · API-11 · P-03 · P-08 · hard rule #1 — the E2E matrix).**
 *
 * Every layer of the integration-health desk — the tested `integrationHealth` fold, the session model, the read
 * port — is unit- and integration-tested. The one thing units cannot prove is that an admin, in an ACTUAL browser,
 * opening the desk sees the connection that has gone quiet at the TOP, reads the reassurance that the till never
 * stops, and that the screen never writes a thing. This drives headless Chromium against a stub cloud to prove
 * exactly that end to end:
 *
 *   • an authorised admin (platform.health.read) → the adapter health picture is read LIVE on load (one GET), the
 *     connection that has gone SILENT sits at the TOP of the "needs a look" list (worst-first, judged by when it
 *     last worked, not by whether it is switched on), the till-safe reassurance is shown (`posUnaffected`, hard
 *     rule #1 — a red row is a queue to clear, never a shop that cannot sell), and across the whole session NOT
 *     ONE write verb (POST/PUT/PATCH/DELETE) leaves the screen (it reads and reports; it commits nothing);
 *   • a user WITHOUT platform.health.read → sees the not-permitted state and NONE of the health data, even though
 *     the feed exists (the server also answers 403 — defence in depth, P-04).
 *
 * The health picture is read exactly as in production — `GET /v1/integration/health` — over
 * `credentials: 'same-origin'` on the same origin that serves the shell. The browser binary is the environment's
 * pre-installed Chromium; where none is present the suite SKIPS rather than failing, like the sibling suites.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

interface BrowserGlobals {
  readonly document: {
    querySelectorAll(selector: string): { readonly length: number };
    getElementById(id: string): { readonly hidden: boolean } | null;
  };
}

/** A silent connection (never reported a success) must sort to the TOP; a degraded one below it; the healthy and
 *  switched-off ones are the calm remainder. Fed deliberately best-first so the screen's worst-first sort shows. */
const ADAPTERS = [
  { adapterId: 'gst-portal', category: 'tax', state: 'healthy', minutesSinceLastSuccess: 3, consecutiveFailures: 0, shopKeepsTrading: true, detail: 'GST portal working' },
  { adapterId: 'whatsapp', category: 'messaging', state: 'disabled', minutesSinceLastSuccess: 'never', consecutiveFailures: 0, shopKeepsTrading: true, detail: 'switched off' },
  { adapterId: 'razorpay', category: 'payment', state: 'degraded', minutesSinceLastSuccess: 12, consecutiveFailures: 1, shopKeepsTrading: true, detail: 'one recent failure' },
  { adapterId: 'tally', category: 'accounting', state: 'silent', minutesSinceLastSuccess: 'never', consecutiveFailures: 0, shopKeepsTrading: true, detail: 'Tally has NEVER reported a success — this is how an integration dies quietly' },
];

interface Recorder {
  integrationHealthData: Record<string, unknown>;
  mayRead: boolean;
  readonly requests: { method: string; path: string }[];
}

/** A server that BOTH serves the shell (GET, admin context injected) AND answers the read-only health feed on the
 *  SAME origin, so `credentials: 'same-origin'` and a relative `/v1/...` reach it exactly as in production. A user
 *  without the platform.health.read gate is refused (403), the same re-check the real server runs. */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');

      if (req.method === 'GET' && path === '/v1/integration/health') {
        rec.requests.push({ method: 'GET', path });
        if (!rec.mayRead) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'forbidden' } })); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ tenantId: 't-1', asAt: '2026-09-22T00:00:00.000Z', adapters: ADAPTERS, posUnaffected: true, detail: 'read-only health picture' }));
        return;
      }
      if (req.method !== 'GET') rec.requests.push({ method: req.method ?? '?', path }); // any write would be caught here

      const file = path === '/' || path === '/integration-health' ? 'integration-health.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.webmanifest') ? 'application/manifest+json' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.integrationHealthData = ${JSON.stringify(rec.integrationHealthData).replace(/</g, '\\u003c')};</script>`;
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

const admin = (userId: string, permissions: readonly string[]): Record<string, unknown> => ({ userId, permissions });

describe.skipIf(!HAVE_BROWSER)('the admin reads integration health end to end in a real browser (M32-FR-04)', () => {
  let browser: Browser;

  beforeAll(async () => {
    // Build the CURRENT web-erp bundle so the browser runs this branch's code, not a stale artifact.
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('an authorised admin sees the silent connection at the top and the till-safe reassurance — and writes nothing', async () => {
    const rec: Recorder = { integrationHealthData: admin('u-admin', ['platform.health.read']), mayRead: true, requests: [] };
    const srv = await startShellAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });

      // The health picture is read LIVE on load (one GET), so the rows only appear once that read resolves.
      await page.waitForFunction(
        () => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#attention li.row').length > 0,
        undefined, { timeout: 10_000 },
      );
      // Worst-first: the connection that went SILENT (never worked) leads — that is the one a config dashboard hides.
      expect(await page.locator('#attention li.row').first().innerText()).toContain('tally');
      // silent + degraded both need a look; the healthy + disabled ones are the calm remainder.
      expect(await page.locator('#attention li.row').count()).toBe(2);
      expect(await page.locator('#calm li.row').count()).toBe(2);

      // The reassurance that matters most is shown: the till keeps trading regardless (hard rule #1).
      expect(await page.locator('#till-safe').getAttribute('hidden')).toBeNull();
      expect((await page.locator('#till-safe-text').innerText()).length).toBeGreaterThan(0);

      // Every request the desk made was a READ. Not one write verb left the screen (it commits nothing).
      expect(rec.requests.length).toBeGreaterThan(0);
      expect(rec.requests.every((r) => r.method === 'GET')).toBe(true);
      expect(rec.requests.some((r) => r.path === '/v1/integration/health')).toBe(true);
    } finally {
      await context.close();
      await srv.stop();
    }
  });

  it('a user without platform.health.read sees the health refused — no connections, and the server answers 403', async () => {
    const rec: Recorder = { integrationHealthData: admin('u-cashier', []), mayRead: false, requests: [] };
    const srv = await startShellAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });
      // The screen refuses on first paint (client-side mayRead is false); it stays refused after the load read.
      await page.waitForFunction(
        () => (globalThis as unknown as BrowserGlobals).document.getElementById('state')?.hidden === false,
        undefined, { timeout: 10_000 },
      );
      expect(await page.locator('#state').getAttribute('class')).toContain('tone-error');
      // None of the health data is shown — the lists and the reassurance are hidden for someone who may not read it.
      expect(await page.locator('#attention li.row').count()).toBe(0);
      expect(await page.locator('#calm li.row').count()).toBe(0);
      expect(await page.locator('#till-safe').getAttribute('hidden')).not.toBeNull();
      // Nothing the screen sent was a write.
      expect(rec.requests.every((r) => r.method === 'GET')).toBe(true);
    } finally {
      await context.close();
      await srv.stop();
    }
  });
});
