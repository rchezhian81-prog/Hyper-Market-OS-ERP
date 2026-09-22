import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The loss manager reads the stored-value exposure and reconciles the books, in a real browser (M17-FR-03/04 · API-06 · P-03 · P-04 — the E2E matrix).**
 *
 * Every layer of the stored-value oversight desk — the tested `createStoredValueOversightSession` fold, the
 * worst-first sort, the browser-entry read ports — is unit- and integration-tested. The one thing units cannot
 * prove is that a loss manager, in an ACTUAL browser, opening the desk sees the real exposure worst-first, looks
 * up a household's double-spend, and enters the books figure to reconcile the liability — all reading LIVE from
 * the cloud, under their own session, and the screen never writing a thing. This drives headless Chromium against
 * a stub cloud to prove exactly that end to end:
 *
 *   • an authorised loss manager (lp.case.read) → on load the velocity watch is read live (one GET) and shows the
 *     fastest-draining card at the TOP; a customer reference looks up that household's double-spends (a GET) and
 *     the biggest overspend sits at the TOP (worst-first, P-03); entering the books' posted figure reconciles the
 *     cards against it (a GET) — a figure that does NOT match reads "unrecorded debt" (error), the exact figure
 *     reads "reconciled" (ok), so the gate reflects the number entered, never a guess. Across the whole session
 *     NOT ONE write verb leaves the screen (it reads and reports; it commits nothing);
 *   • a user WITHOUT lp.case.read → sees the not-permitted state and NONE of the loss / gap / watch data, even
 *     though the feeds exist (P-04 least privilege: the screen refuses to show loss oversight it may not read, and
 *     the server re-checks too — it answers 403).
 *
 * The three feeds are read exactly as in production — `GET /v1/stored-value/velocity`,
 * `…/households/:ownerRef/double-spends`, `…/liability?posted=<minor>` — over `credentials: 'same-origin'` on the
 * same origin that serves the shell. The browser binary is the environment's pre-installed Chromium; where none is
 * present the suite SKIPS rather than failing, like the sibling suites.
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

/** Two cards draining unusually fast — the bigger-value one must sort to the top of the watch (worst-first). */
const VELOCITY = [
  { instrumentId: 'GC-FAST-BIG', count: 7, valueMinor: 800_000, windowMinutes: 30, detail: 'GC-FAST-BIG redeemed 7 times in 30 min' },
  { instrumentId: 'GC-FAST-SML', count: 4, valueMinor: 150_000, windowMinutes: 30, detail: 'GC-FAST-SML redeemed 4 times in 30 min' },
];

/** One household's two cards spent past zero across channels — the bigger overspend must sort to the top. */
const OWNER_REF = 'HH-9';
const DOUBLE_SPENDS = [
  { instrumentId: 'GC-DBL-BIG', ownerRef: OWNER_REF, overspentMinor: 500_000, channels: ['store', 'app'], detail: 'GC-DBL-BIG went ₹5000 past zero across store + app' },
  { instrumentId: 'GC-DBL-SML', ownerRef: OWNER_REF, overspentMinor: 120_000, channels: ['store', 'web'], detail: 'GC-DBL-SML went ₹1200 past zero across store + web' },
];

/** The cards' outstanding balance, folded from movements. The books figure the manager types is compared against
 *  THIS exactly: a matching figure reconciles, anything else is a signed gap (unrecorded debt). */
const OUTSTANDING_MINOR = 650_000;
const ISSUED_MINOR = 900_000;
const REDEEMED_MINOR = 240_000;
const EXPIRED_MINOR = 10_000;

interface Recorder {
  storedValueData: Record<string, unknown>;
  mayRead: boolean;
  readonly requests: { method: string; path: string; query: string }[];
}

/** A server that BOTH serves the shell (GET, manager context injected) AND answers the three read-only feeds the
 *  desk touches — velocity, a household's double-spends, and the liability reconciliation (posted figure in the
 *  query) — on the SAME origin, so `credentials: 'same-origin'` and a relative `/v1/...` reach it exactly as in
 *  production. A user without the loss/books gate is refused (403), the same re-check the real server runs. */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/', query = ''] = (req.url ?? '/').split('?');
      const record = () => rec.requests.push({ method: req.method ?? 'GET', path, query });

      // Stored-value feeds — all GET, all on the loss/books gate the server re-checks (P-04).
      const feed = (payload: unknown) => {
        record();
        if (!rec.mayRead) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'forbidden' } })); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (req.method === 'GET' && path === '/v1/stored-value/velocity') {
        feed({ flags: VELOCITY, asAt: '2026-09-22T00:00:00.000Z' });
        return;
      }
      const dbl = /^\/v1\/stored-value\/households\/([^/]+)\/double-spends$/.exec(path);
      if (req.method === 'GET' && dbl) {
        const owner = decodeURIComponent(dbl[1] ?? '');
        feed({ doubleSpends: owner === OWNER_REF ? DOUBLE_SPENDS : [], asAt: '2026-09-22T00:00:00.000Z' });
        return;
      }
      if (req.method === 'GET' && path === '/v1/stored-value/liability') {
        const posted = Number(new URLSearchParams(query).get('posted') ?? '0');
        const differenceMinor = posted - OUTSTANDING_MINOR; // posted − outstanding, signed
        feed({
          outstandingMinor: OUTSTANDING_MINOR, issuedMinor: ISSUED_MINOR, redeemedMinor: REDEEMED_MINOR,
          expiredMinor: EXPIRED_MINOR, postedLiabilityMinor: posted, differenceMinor,
          reconciles: differenceMinor === 0,
          detail: differenceMinor === 0 ? 'Cards reconcile with the books' : `Books off by ${differenceMinor} minor`,
        });
        return;
      }

      const file = path === '/' || path === '/stored-value' ? 'stored-value.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.webmanifest') ? 'application/manifest+json' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.storedValueData = ${JSON.stringify(rec.storedValueData).replace(/</g, '\\u003c')};</script>`;
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

const manager = (userId: string, permissions: readonly string[]): Record<string, unknown> => ({ userId, permissions });

describe.skipIf(!HAVE_BROWSER)('the loss manager reads stored-value exposure and reconciles the books, end to end in a real browser (M17-FR-03/04)', () => {
  let browser: Browser;

  beforeAll(async () => {
    // Build the CURRENT web-erp bundle so the browser runs this branch's code, not a stale artifact.
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('an authorised loss manager sees the watch worst-first, looks up a double-spend worst-first, reconciles the books — and writes nothing', async () => {
    const rec: Recorder = { storedValueData: manager('u-lp', ['lp.case.read']), mayRead: true, requests: [] };
    const srv = await startShellAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });

      // The velocity watch is read LIVE on load (one GET), so the cards only appear once that read resolves.
      await page.waitForFunction(
        () => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#watch li.row').length > 0,
        undefined, { timeout: 10_000 },
      );
      expect(await page.locator('#watch li.row').count()).toBe(2);
      // Worst-first: the biggest-value drain sits at the top (the screen guarantees the order, not the engine).
      expect(await page.locator('#watch li.row').first().innerText()).toContain('GC-FAST-BIG');

      // A customer reference looks up that household's double-spends (a GET), biggest overspend at the top.
      await page.fill('#owner-ref', OWNER_REF);
      await page.click('#lookup-btn');
      await page.waitForFunction(
        () => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#losses li.row').length > 0,
        undefined, { timeout: 10_000 },
      );
      expect(await page.locator('#losses li.row').count()).toBe(2);
      expect(await page.locator('#losses li.row').first().innerText()).toContain('GC-DBL-BIG');

      // Enter a books figure that does NOT match the cards → the gap reads as unrecorded debt (error tone).
      await page.fill('#posted-figure', String(OUTSTANDING_MINOR - 10_000));
      await page.click('#reconcile-btn');
      await page.waitForFunction(
        () => (globalThis as unknown as BrowserGlobals).document.getElementById('gap-panel')?.hidden === false,
        undefined, { timeout: 10_000 },
      );
      expect(await page.locator('#gap-panel').getAttribute('class')).toContain('tone-error');
      expect(await page.locator('#gap-needs').getAttribute('hidden')).not.toBeNull(); // the "enter a figure" prompt is gone

      // Enter the EXACT figure → the same reconcile now reads reconciled (ok tone). The gate reflects the number.
      await page.fill('#posted-figure', String(OUTSTANDING_MINOR));
      await page.click('#reconcile-btn');
      await page.waitForFunction(
        () => {
          const p = (globalThis as unknown as { document: { getElementById(id: string): { className: string } | null } }).document.getElementById('gap-panel');
          return p !== null && p.className.includes('tone-ok');
        },
        undefined, { timeout: 10_000 },
      );
      expect(await page.locator('#gap-panel').getAttribute('class')).toContain('tone-ok');

      // Every request the desk made was a READ. Not one write verb left the screen (it commits nothing).
      expect(rec.requests.length).toBeGreaterThan(0);
      expect(rec.requests.every((r) => r.method === 'GET')).toBe(true);
      // The three feeds were each read live from the cloud, exactly as in production.
      expect(rec.requests.some((r) => r.path === '/v1/stored-value/velocity')).toBe(true);
      expect(rec.requests.some((r) => r.path === `/v1/stored-value/households/${OWNER_REF}/double-spends`)).toBe(true);
      expect(rec.requests.some((r) => r.path === '/v1/stored-value/liability' && new URLSearchParams(r.query).get('posted') === String(OUTSTANDING_MINOR))).toBe(true);
    } finally {
      await context.close();
      await srv.stop();
    }
  });

  it('a user without lp.case.read sees the loss oversight refused — no exposure, and the server answers 403', async () => {
    const rec: Recorder = { storedValueData: manager('u-cashier', []), mayRead: false, requests: [] };
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
      // None of the loss / gap / watch data is shown — the sections are hidden for someone who may not read them.
      expect(await page.locator('#losses li.row').count()).toBe(0);
      expect(await page.locator('#watch li.row').count()).toBe(0);
      expect(await page.locator('#gap-panel').getAttribute('hidden')).not.toBeNull();
      // The server also re-checked and refused (defence in depth); nothing the screen sent was a write.
      expect(rec.requests.every((r) => r.method === 'GET')).toBe(true);
    } finally {
      await context.close();
      await srv.stop();
    }
  });
});
