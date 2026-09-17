import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The manager closes an investigation, in a real browser (M15-FR-04 · API-05 · §28 — the E2E matrix).**
 *
 * Every layer of the loss-prevention inbox — the tested buildOpenCaseWorklist, the session model, the close
 * port — is unit- and integration-tested. The one thing units cannot prove is that a manager, in an actual
 * browser, picking a case + an outcome + a note and clicking **"Close the case"** makes their decision reach the
 * cloud under their own session, and that the case then drops off. This drives headless Chromium against a stub
 * cloud to prove exactly that end to end:
 *
 *   • an authorised manager (lp.case.read + lp.case.manage) → the close POSTs {outcome, note} to
 *     /v1/loss-prevention/cases/:caseId/close under their own session, the result strip shows, and the case
 *     drops off once the worklist is re-read (a read, never a client-side move);
 *   • a read-only manager (lp.case.read only) → the close form is not even rendered, and NOTHING is sent;
 *   • an empty note → refused client-side, nothing sent (a close with no note is not a record — hard rule #6).
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS rather
 * than failing, exactly like the operations dismiss-delivery suite it mirrors.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

interface BrowserGlobals {
  readonly document: {
    querySelectorAll(selector: string): { readonly length: number };
    querySelector(selector: string): { readonly value?: string } | null;
  };
}

/** One open investigation — the manager's to work. A summary shape as `GET /v1/loss-prevention/cases` hands it
 *  over; the subject is an opaque reference, never a name (P-04). */
const ONE_CASE = {
  caseId: 'lp-till-3',
  subjectRef: 'SUBJ-till-3',
  assignedTo: 'u-mgr',
  summary: 'Till 3 came up short at close',
  valueMinor: 120000,
  raisedFromRef: 'shift-close:2026-09-16:till-3',
  openedBy: 'system',
  openedAt: '2026-09-16T21:00:00.000Z',
  evidenceCount: 0,
};
const OPEN_WORKLIST = { openCount: 1, totalValueMinor: 120000, cases: [ONE_CASE] };
const CLOSED_WORKLIST = { openCount: 0, totalValueMinor: 0, cases: [] };

interface Recorder {
  inboxData: Record<string, unknown>;
  closeStatus: number;
  closed: boolean;
  readonly requests: { method: string; path: string; body: unknown }[];
}

/** A server that BOTH serves the shell (GET, manager context injected) AND answers the two routes the inbox
 *  touches — the close POST (caseId in the URL) and the worklist GET — on the SAME origin, so
 *  `credentials: 'same-origin'` and a relative `/v1/...` reach it exactly as in production. */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (req.method === 'POST' && path.startsWith('/v1/loss-prevention/cases/') && path.endsWith('/close')) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        rec.requests.push({ method: 'POST', path, body: raw === '' ? undefined : JSON.parse(raw) });
        if (rec.closeStatus >= 200 && rec.closeStatus < 300) rec.closed = true;
        res.writeHead(rec.closeStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: rec.closeStatus < 400 }));
        return;
      }
      if (req.method === 'GET' && path === '/v1/loss-prevention/cases') {
        rec.requests.push({ method: 'GET', path, body: undefined });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(rec.closed ? CLOSED_WORKLIST : OPEN_WORKLIST));
        return;
      }
      const file = path === '/' || path === '/loss-prevention' ? 'loss-prevention.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.lossPreventionInboxData = ${JSON.stringify(rec.inboxData).replace(/</g, '\\u003c')};</script>`;
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

const manager = (permissions: readonly string[]): Record<string, unknown> => ({
  userId: 'u-mgr', tenantId: 't1', permissions, worklist: OPEN_WORKLIST,
});

describe.skipIf(!HAVE_BROWSER)('the manager closes an investigation, end to end in a real browser (M15-FR-04)', () => {
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
    await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row').length > 0, undefined, { timeout: 10_000 });
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  it('an authorised manager: picking a case + outcome + note and clicking close POSTs it, and the case drops off', async () => {
    const rec: Recorder = { inboxData: manager(['lp.case.read', 'lp.case.manage']), closeStatus: 200, closed: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      expect(await page.locator('#rows .row').count()).toBe(1);
      // The close form is offered (the manager holds lp.case.manage).
      expect(await page.locator('#closer').getAttribute('hidden')).toBeNull();

      await page.selectOption('#close-case', 'lp-till-3');
      await page.selectOption('#close-outcome', 'unfounded');
      await page.fill('#close-note', 'reviewed the CCTV and the till roll — a mis-keyed refund, not a theft');
      await page.click('#close');

      // The case drops off because the worklist was re-READ (server re-derive), not shuffled client-side.
      await page.waitForFunction(
        () => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows .row').length === 0,
        undefined, { timeout: 10_000 },
      );
      const post = rec.requests.find((r) => r.method === 'POST' && r.path === '/v1/loss-prevention/cases/lp-till-3/close');
      expect(post, 'the close was not POSTed to the case URL').toBeDefined();
      expect((post!.body as { outcome?: string }).outcome).toBe('unfounded');
      expect((post!.body as { note?: string }).note).toBe('reviewed the CCTV and the till roll — a mis-keyed refund, not a theft');

      expect(rec.requests.filter((r) => r.method === 'GET' && r.path === '/v1/loss-prevention/cases').length).toBeGreaterThanOrEqual(1);
      expect(await page.locator('#rows .row').count()).toBe(0);
      expect(await page.locator('#result').getAttribute('hidden')).toBeNull();
    } finally {
      await teardown();
    }
  });

  it('a read-only manager sends NOTHING — the close form is not rendered', async () => {
    const rec: Recorder = { inboxData: manager(['lp.case.read']), closeStatus: 200, closed: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      expect(await page.locator('#rows .row').count()).toBe(1);
      expect(await page.locator('#closer').getAttribute('hidden')).not.toBeNull(); // the form is hidden
      expect(rec.requests.some((r) => r.method === 'POST')).toBe(false);
    } finally {
      await teardown();
    }
  });

  it('an empty note is refused client-side — nothing is sent and the case stays open', async () => {
    const rec: Recorder = { inboxData: manager(['lp.case.read', 'lp.case.manage']), closeStatus: 200, closed: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      await page.selectOption('#close-outcome', 'unfounded');
      // Leave the note empty.
      await page.click('#close');
      await page.waitForSelector('#result:not([hidden])', { timeout: 10_000 });
      expect(rec.requests.some((r) => r.method === 'POST')).toBe(false);
      expect(await page.locator('#rows .row').count()).toBe(1);
    } finally {
      await teardown();
    }
  });
});
