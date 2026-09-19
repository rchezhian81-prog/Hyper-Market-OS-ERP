import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **A person starts and closes a product recall, in a real browser (M10-FR-04, ADR-0013 — the E2E matrix).**
 *
 * Every layer of "a recall is RECORDED at head office under the operator's own session" is unit-tested — the
 * session's async `start`/`close`, the browser's `openRecallCloudPort`, the cloud's event-sourced recall routes.
 * The one thing units cannot prove is that a person filling the recall form in an actual browser, pressing
 * **Start the recall**, makes that write reach the cloud, keyed for idempotency, under their own session — and
 * that the screen then reports a recall started/closed ONLY when the cloud saved it, and an honest "not sent"
 * when it did not (P-08, hard rule #6). This drives headless Chromium against a stub cloud to prove:
 *
 *   • an authorised start → a POST reaches `/v1/quality/recalls/<batch>` carrying `{ reason }` and an
 *     idempotency-key, and the screen confirms it and clears the form;
 *   • head office REFUSES the start (403) → the screen surfaces the reason and NEVER claims a start; the form
 *     keeps what was typed, so the person can retry;
 *   • an authorised close of an open recall WITH evidence → a POST reaches `.../closure` carrying the
 *     `{ evidenceRef }`, and the screen confirms it.
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

/** The slice of the browser's globals these callbacks touch, cast structurally inside each evaluate. */
interface BrowserGlobals {
  readonly expirySession?: unknown;
  readonly document: {
    getElementById(id: string): { readonly value?: string } | null;
  };
}

/** What the ERP would inject about the signed-in operator, the shop's batches, and any open recalls. */
interface Recorder {
  expiryData: Record<string, unknown>;
  /** The status + body the recall POSTs (initiate and closure) answer with. */
  status: number;
  body: Record<string, unknown>;
  readonly requests: { method: string; path: string; idem: string | undefined; body: unknown }[];
}

/** A server that serves the expiry shell (GET, operator context injected) AND answers the recall routes the
 *  operator-session port POSTs to — the same origin, so `credentials:'same-origin'` and a relative `/v1/...`
 *  reach it exactly as in production. */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (req.method === 'POST' && path.startsWith('/v1/quality/recalls/')) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        const idem = req.headers['idempotency-key'];
        rec.requests.push({
          method: 'POST', path,
          idem: Array.isArray(idem) ? idem[0] : idem,
          body: raw === '' ? undefined : JSON.parse(raw),
        });
        res.writeHead(rec.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(rec.body));
        return;
      }
      const file = path === '/' || path === '/expiry' ? 'expiry.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        let html = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.expiryData = ${JSON.stringify(rec.expiryData).replace(/</g, '\\u003c')};</script>`;
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

/** A quality operator, the shop's one batch, and (optionally) an open recall already on the box. */
const operator = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  userId: 'u-qc', storeId: 'store-1', now: '2026-08-06T14:00:00.000Z', nearExpiryDays: 7,
  batches: [{ batchId: 'B-1', productId: 'p1', qty: 10, expiry: '2026-08-09' }],
  productNames: { p1: 'Toor dal 1kg' },
  ...over,
});

describe.skipIf(!HAVE_BROWSER)('operator recall delivery, end to end in a real browser (M10-FR-04)', () => {
  let browser: Browser;

  beforeAll(async () => {
    // Build the CURRENT web-erp bundle so the browser runs this branch's code, not a stale artifact.
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** Open the expiry screen on the Recalls tab with the given operator context. */
  const openRecallTab = async (rec: Recorder) => {
    const srv = await startShellAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    // Boot is done once the tested session is wired to the window.
    await page.waitForFunction(
      () => (globalThis as unknown as BrowserGlobals).expirySession !== undefined,
      undefined, { timeout: 10_000 },
    );
    await page.click('#tab-recall');
    await page.waitForSelector('#view-recall:not([hidden])', { timeout: 10_000 });
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  const batchValue = (page: import('playwright-core').Page) =>
    page.evaluate(() => (globalThis as unknown as BrowserGlobals).document.getElementById('batch')?.value ?? '');

  it('an authorised start is recorded at head office: the POST carries { reason } and an idempotency-key', async () => {
    const rec: Recorder = {
      expiryData: operator(), status: 201,
      body: { recall: { batchId: 'B-1', reason: 'supplier notice: glass', status: 'open' } }, requests: [],
    };
    const { page, teardown } = await openRecallTab(rec);
    try {
      await page.fill('#batch', 'B-1');
      await page.fill('#reason', 'supplier notice: glass');
      await page.click('#start');
      await page.waitForSelector('#banner:not([hidden])', { timeout: 10_000 });

      // The recall reached the cloud, at the batch's own route, under the operator's own session.
      const req = rec.requests.find((r) => r.path === '/v1/quality/recalls/B-1');
      expect(req, 'the recall start was not POSTed').toBeDefined();
      expect((req!.body as { reason?: string }).reason).toBe('supplier notice: glass');
      // Keyed for idempotency — a re-send is one effect, not two records.
      expect((req!.idem ?? '').length, 'no idempotency-key was sent').toBeGreaterThan(0);

      // The screen confirms the start (only after the cloud saved it) and clears the form.
      expect(((await page.textContent('#banner-title')) ?? '').toLowerCase()).toContain('done');
      expect(await batchValue(page)).toBe('');
    } finally {
      await teardown();
    }
  });

  it('head office refuses the start (403): the screen surfaces the reason and never claims a start (P-08)', async () => {
    const rec: Recorder = {
      expiryData: operator(), status: 403,
      body: { code: 'forbidden', whatHappened: 'This account does not hold "quality.recall.initiate".', wasItSaved: 'not_saved' },
      requests: [],
    };
    const { page, teardown } = await openRecallTab(rec);
    try {
      await page.fill('#batch', 'B-1');
      await page.fill('#reason', 'supplier notice: glass');
      await page.click('#start');
      await page.waitForSelector('#banner:not([hidden])', { timeout: 10_000 });

      // The cloud WAS asked, and refused.
      expect(rec.requests.some((r) => r.path === '/v1/quality/recalls/B-1')).toBe(true);
      // The screen shows the refusal and does NOT report a start — the title is the "please read", not "done".
      expect(((await page.textContent('#banner-title')) ?? '').toLowerCase()).not.toContain('done');
      expect((await page.textContent('#banner-text')) ?? '').toContain('does not hold');
      // The form keeps what was typed, so the person can retry.
      expect(await batchValue(page)).toBe('B-1');
    } finally {
      await teardown();
    }
  });

  it('an authorised close of an open recall WITH evidence: the POST carries the { evidenceRef }', async () => {
    const openRecall = {
      recallId: 'RC-1', batchId: 'B-1', productId: 'p1', reason: 'supplier notice: glass',
      startedBy: 'u-qc', startedAt: '2026-08-06T09:00:00.000Z',
    };
    const rec: Recorder = {
      expiryData: operator({ recalls: [openRecall] }), status: 200,
      body: { recall: { batchId: 'B-1', status: 'closed' } }, requests: [],
    };
    const { page, teardown } = await openRecallTab(rec);
    try {
      // The open recall is listed with a Close button; open its closure form (never a browser dialog).
      await page.click('#recall-list .row button');
      await page.waitForSelector('#evidence-RC-1', { timeout: 10_000 });
      await page.fill('#evidence-RC-1', 'collected by supplier, note 4471');
      // The store's ledger here carries no sales, so nothing is unaccounted for; close proceeds.
      await page.click('#recall-list button.danger');
      await page.waitForSelector('#banner:not([hidden])', { timeout: 10_000 });

      // The closure reached the cloud at the batch's closure route, keyed, carrying the evidence reference.
      const req = rec.requests.find((r) => r.path === '/v1/quality/recalls/B-1/closure');
      expect(req, 'the closure was not POSTed').toBeDefined();
      expect((req!.body as { evidenceRef?: string }).evidenceRef).toBe('collected by supplier, note 4471');
      expect((req!.idem ?? '').length, 'no idempotency-key was sent').toBeGreaterThan(0);
      expect(((await page.textContent('#banner-title')) ?? '').toLowerCase()).toContain('done');
    } finally {
      await teardown();
    }
  });
});
