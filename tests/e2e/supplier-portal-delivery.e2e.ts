import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **A supplier reads its own account, in a real browser (M24-FR-01 · API-03 · §35 — the E2E matrix).**
 *
 * Every layer of the supplier portal — the tested `createSupplierPortalSession`, the served page, the browser
 * read fetches — is unit- and integration-tested. The one thing units cannot prove is that a supplier, in an
 * ACTUAL browser, opening the portal sees what it sent us still WAITING on us at the top, sees its statement,
 * and that the screen never writes a thing. This drives headless Chromium against a stub cloud to prove exactly
 * that end to end:
 *
 *   • an authorised supplier login (supplier.portal.self) → both feeds read LIVE on load, the submission still
 *     AWAITING our decision leads (never a false "accepted" — §28), the statement panel shows the closing
 *     balance with the disputed amount kept separate, and across the whole session NOT ONE write verb
 *     (POST/PUT/PATCH/DELETE) leaves the screen (a supplier SUBMITS through separate routes; this reads);
 *   • a login WITHOUT supplier.portal.self → sees the not-a-supplier-login state and NONE of the account data,
 *     even though the feeds exist (the server also answers 403 — defence in depth, P-04/§35).
 *
 * The two feeds are read exactly as in production — `GET /v1/supplier-portal/me/{submissions,statement}` — over
 * `credentials: 'same-origin'` on the same origin that serves the page, each scoped to the caller's OWN partner
 * id ON THE SERVER (the browser has no partner id to send). The supplier portal is CLOUD-served (its own app
 * bundle), so the e2e serves apps/supplier-app/web the same way the cloud web tier would. The browser binary is
 * the environment's pre-installed Chromium; where none is present the suite SKIPS rather than failing.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/supplier-app/web';

interface BrowserGlobals {
  readonly document: {
    querySelectorAll(selector: string): { readonly length: number };
    getElementById(id: string): { readonly hidden: boolean } | null;
  };
}

/** What the supplier sent us: one invoice STILL awaiting our decision (must lead), one processed acknowledgement. */
const SUBMISSIONS = [
  { submissionId: 'sub-ack', kind: 'po_acknowledgement', requiresReview: false, receivedAt: '2026-09-18T09:00:00Z' },
  { submissionId: 'sub-inv', kind: 'invoice', requiresReview: true, receivedAt: '2026-09-21T09:00:00Z' },
];

/** The supplier's statement — ₹3,000 outstanding, ₹500 disputed shown separately, reconciling. */
const STATEMENT = {
  partnerId: 'p-acme', accessible: true, openingMinor: 0, invoicedMinor: 500000, debitedMinor: 0,
  creditedMinor: 0, paidMinor: 200000, closingMinor: 300000, disputedMinor: 50000, reconciles: true,
  detail: '300000 outstanding; 50000 disputed shown separately',
};

interface Recorder {
  supplierData: Record<string, unknown>;
  mayRead: boolean;
  readonly requests: { method: string; path: string }[];
}

/** A server that serves the supplier-app page AND answers the two read-only feeds on the SAME origin, so a
 *  relative `/v1/...` with `credentials: 'same-origin'` reaches it exactly as in production. A login without the
 *  supplier.portal.self grant is refused (403), the same re-check the real server runs (§35). */
async function startPageAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const feed = (payload: unknown) => {
        rec.requests.push({ method: req.method ?? 'GET', path });
        if (!rec.mayRead) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'not_a_supplier_login' } })); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'GET' && path === '/v1/supplier-portal/me/submissions') {
        feed({ partnerId: STATEMENT.partnerId, submissions: SUBMISSIONS, asAt: '2026-09-22T00:00:00.000Z' });
        return;
      }
      if (req.method === 'GET' && path === '/v1/supplier-portal/me/statement') {
        feed(STATEMENT);
        return;
      }
      if (req.method !== 'GET') rec.requests.push({ method: req.method ?? '?', path }); // any write would be caught here

      const file = path === '/' || path === '/index.html' ? 'index.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.webmanifest') ? 'application/manifest+json' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.supplierData = ${JSON.stringify(rec.supplierData).replace(/</g, '\\u003c')};</script>`;
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

const login = (userId: string, permissions: readonly string[]): Record<string, unknown> => ({ userId, permissions });

describe.skipIf(!HAVE_BROWSER)('a supplier reads its own account end to end in a real browser (M24-FR-01)', () => {
  let browser: Browser;

  beforeAll(async () => {
    // Build the CURRENT supplier-app bundle so the browser runs this branch's code, not a stale artifact.
    execFileSync('node', ['scripts/build-app.mjs', 'supplier-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('an authorised supplier sees the awaiting submission first and its statement — and writes nothing', async () => {
    const rec: Recorder = { supplierData: login('u-acme', ['supplier.portal.self']), mayRead: true, requests: [] };
    const srv = await startPageAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });

      // The feeds are read LIVE on load, so the rows only appear once those reads resolve.
      await page.waitForFunction(
        () => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#awaiting li.row').length > 0,
        undefined, { timeout: 10_000 },
      );
      // The submission still AWAITING our decision leads — never a false "accepted" (§28).
      expect(await page.locator('#awaiting li.row').count()).toBe(1);
      expect(await page.locator('#awaiting li.row').first().innerText()).toContain('sub-inv');
      expect(await page.locator('#processed li.row').count()).toBe(1); // the acknowledgement we processed

      // The statement panel shows the closing balance and keeps the disputed amount separate.
      expect(await page.locator('#statement').getAttribute('hidden')).toBeNull();
      const statementText = await page.locator('#statement').innerText();
      expect(statementText).toContain('₹3,000.00'); // outstanding
      expect(statementText).toContain('₹500.00');    // disputed, shown separately

      // Every request the portal made was a READ. Not one write verb left the screen.
      expect(rec.requests.length).toBeGreaterThan(0);
      expect(rec.requests.every((r) => r.method === 'GET')).toBe(true);
      expect(rec.requests.some((r) => r.path === '/v1/supplier-portal/me/submissions')).toBe(true);
      expect(rec.requests.some((r) => r.path === '/v1/supplier-portal/me/statement')).toBe(true);
    } finally {
      await context.close();
      await srv.stop();
    }
  });

  it('a login without supplier.portal.self sees the account refused — no data, and the server answers 403', async () => {
    const rec: Recorder = { supplierData: login('u-stranger', []), mayRead: false, requests: [] };
    const srv = await startPageAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });
      // The screen refuses on first paint (client-side mayRead is false); it stays refused after the load reads.
      await page.waitForFunction(
        () => (globalThis as unknown as BrowserGlobals).document.getElementById('state')?.hidden === false,
        undefined, { timeout: 10_000 },
      );
      expect(await page.locator('#state').getAttribute('class')).toContain('tone-error');
      // None of the account data is shown — the lists and the statement are hidden for a non-supplier login.
      expect(await page.locator('#awaiting li.row').count()).toBe(0);
      expect(await page.locator('#processed li.row').count()).toBe(0);
      expect(await page.locator('#statement').getAttribute('hidden')).not.toBeNull();
      // Nothing the screen sent was a write.
      expect(rec.requests.every((r) => r.method === 'GET')).toBe(true);
    } finally {
      await context.close();
      await srv.stop();
    }
  });
});
