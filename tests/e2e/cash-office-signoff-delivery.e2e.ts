import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The cash office signs off an over/short, in a real browser (M14-FR-02 · API-05 · §28 — the E2E matrix).**
 *
 * Every layer of the over/short desk — the tested assessOverShortReview, the session model, the sign-off port —
 * is unit- and integration-tested. The one thing units cannot prove is that a supervisor, in an ACTUAL browser,
 * picking a shift + a finding + a note and clicking **"Sign it off"** makes their decision reach the cloud under
 * their own session, and that the shift then drops off. This drives headless Chromium against a stub cloud to
 * prove exactly that end to end:
 *
 *   • an authorised reviewer (till.shift.read + till.overshort.review) → the sign-off POSTs {disposition, note}
 *     to /v1/shifts/:shiftId/over-short/review under their own session, the result strip shows, and the shift
 *     drops off once the worklist is re-read (a read, never a client-side move);
 *   • a read-only reviewer (till.shift.read only) → the sign-off form is not even rendered, and NOTHING is sent;
 *   • the reviewer who COUNTED the drawer → refused client-side, nothing sent (§28 separation of duties: a
 *     cashier can never clear their own shortage — the server enforces it too, but the screen never even tries).
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

/** One open over/short — the desk's to account for. The shape `GET /v1/shifts/over-short` hands each row over,
 *  carrying the cashier id (for the §28 check) and the `reviewed` flag the screen filters on. */
const CASHIER = 'u-cashier';
const OPEN_ROW = {
  shiftId: 'shift-till-3', tillId: 'till-3', cashierId: CASHIER, tradingDay: '2026-09-17',
  varianceMinor: -120000, reasonCode: 'gave_wrong_change',
};

interface Recorder {
  cashOfficeData: Record<string, unknown>;
  reviewStatus: number;
  signed: boolean;
  readonly requests: { method: string; path: string; body: unknown }[];
}

/** A server that BOTH serves the shell (GET, reviewer context injected) AND answers the two routes the desk
 *  touches — the sign-off POST (shiftId in the URL) and the over/short worklist GET — on the SAME origin, so
 *  `credentials: 'same-origin'` and a relative `/v1/...` reach it exactly as in production. The GET returns the
 *  row with `reviewed` reflecting whether it has been signed off, so a signed-off shift drops off on re-read. */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (req.method === 'POST' && path.startsWith('/v1/shifts/') && path.endsWith('/over-short/review')) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        rec.requests.push({ method: 'POST', path, body: raw === '' ? undefined : JSON.parse(raw) });
        if (rec.reviewStatus >= 200 && rec.reviewStatus < 300) rec.signed = true;
        res.writeHead(rec.reviewStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ shiftId: OPEN_ROW.shiftId, reviewed: rec.reviewStatus < 400 }));
        return;
      }
      if (req.method === 'GET' && path === '/v1/shifts/over-short') {
        rec.requests.push({ method: 'GET', path, body: undefined });
        const row = { ...OPEN_ROW, denominations: null, reviewed: rec.signed, reviewedBy: rec.signed ? 'u-cashoffice' : null, disposition: rec.signed ? 'miscount' : null, reviewedAt: rec.signed ? '2026-09-17T10:00:00.000Z' : null };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ overShort: [row], totalVarianceMinor: OPEN_ROW.varianceMinor, openCount: rec.signed ? 0 : 1, asAt: '2026-09-17T10:00:00.000Z' }));
        return;
      }
      const file = path === '/' || path === '/cash-office' ? 'cash-office.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.cashOfficeData = ${JSON.stringify(rec.cashOfficeData).replace(/</g, '\\u003c')};</script>`;
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

const reviewer = (userId: string, permissions: readonly string[]): Record<string, unknown> => ({
  userId, tenantId: 't1', permissions,
});

describe.skipIf(!HAVE_BROWSER)('the cash office signs off an over/short, end to end in a real browser (M14-FR-02)', () => {
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
    // The worklist is read live on load (GET), so the row only appears once the read resolves.
    await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row').length > 0, undefined, { timeout: 10_000 });
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  it('an authorised reviewer: picking a shift + finding + note and clicking sign-off POSTs it, and the shift drops off', async () => {
    const rec: Recorder = { cashOfficeData: reviewer('u-cashoffice', ['till.shift.read', 'till.overshort.review']), reviewStatus: 201, signed: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      expect(await page.locator('#rows .row').count()).toBe(1);
      // The sign-off form is offered (the reviewer holds till.overshort.review).
      expect(await page.locator('#signer').getAttribute('hidden')).toBeNull();

      await page.selectOption('#sign-shift', 'shift-till-3');
      await page.selectOption('#sign-disposition', 'change_error');
      await page.fill('#sign-note', 'gave a ₹500 note as change — matched the till roll');
      await page.click('#sign');

      // The shift drops off because the worklist was re-READ (server re-derive), not shuffled client-side.
      await page.waitForFunction(
        () => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row').length === 0,
        undefined, { timeout: 10_000 },
      );
      const post = rec.requests.find((r) => r.method === 'POST' && r.path === '/v1/shifts/shift-till-3/over-short/review');
      expect(post, 'the sign-off was not POSTed to the shift URL').toBeDefined();
      expect((post!.body as { disposition?: string }).disposition).toBe('change_error');
      expect((post!.body as { note?: string }).note).toBe('gave a ₹500 note as change — matched the till roll');

      expect(rec.requests.filter((r) => r.method === 'GET' && r.path === '/v1/shifts/over-short').length).toBeGreaterThanOrEqual(2);
      expect(await page.locator('#rows .row').count()).toBe(0);
      expect(await page.locator('#result').getAttribute('hidden')).toBeNull();
    } finally {
      await teardown();
    }
  });

  it('a read-only reviewer sends NOTHING — the sign-off form is not rendered', async () => {
    const rec: Recorder = { cashOfficeData: reviewer('u-readonly', ['till.shift.read']), reviewStatus: 201, signed: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      expect(await page.locator('#rows .row').count()).toBe(1);
      expect(await page.locator('#signer').getAttribute('hidden')).not.toBeNull(); // the form is hidden
      expect(rec.requests.some((r) => r.method === 'POST')).toBe(false);
    } finally {
      await teardown();
    }
  });

  it('the reviewer who counted the drawer is refused client-side (§28) — nothing is sent and the shift stays open', async () => {
    // The logged-in reviewer IS the cashier of the shift — a self-review the screen refuses before any POST.
    const rec: Recorder = { cashOfficeData: reviewer(CASHIER, ['till.shift.read', 'till.overshort.review']), reviewStatus: 201, signed: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      // The form is offered (they hold the permission), but the row is flagged as their own drawer.
      expect(await page.locator('#signer').getAttribute('hidden')).toBeNull();
      await page.selectOption('#sign-shift', 'shift-till-3');
      await page.selectOption('#sign-disposition', 'miscount');
      await page.click('#sign');
      await page.waitForSelector('#result:not([hidden])', { timeout: 10_000 });
      expect(rec.requests.some((r) => r.method === 'POST'), 'a self-review must not be POSTed').toBe(false);
      expect(await page.locator('#rows .row').count()).toBe(1);
    } finally {
      await teardown();
    }
  });
});
