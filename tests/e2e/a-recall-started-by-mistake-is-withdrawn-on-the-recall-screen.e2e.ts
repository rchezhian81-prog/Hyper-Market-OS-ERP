import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';


/**
 * **OB-383 on the recall screen, in a real browser: a recall started by mistake is withdrawn — only before anyone is told
 * or anything thrown away; after that it is closed with evidence.**
 *
 *   • the person writes why and ticks "No customer has been phoned" → a POST reaches
 *     `/v1/quality/recalls/<batch>/withdrawal` carrying `{ reason, noCustomerPhoned: true }` and an idempotency-key, and
 *     the screen says "withdrawn — started by mistake" only after head office saved it;
 *   • without the tick nothing is sent and the screen says why;
 *   • head office refuses it BY NAME (a customer already contacted) → the screen says so in words, and the recall stays
 *     OPEN with its Close button, to be closed with evidence.
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
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
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
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
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
describe.skipIf(!HAVE_BROWSER)('OB-383: a recall started by mistake is withdrawn on the recall screen, in a real browser', () => {
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

  const openRecall = {
    recallId: 'RC-1', batchId: 'B-1', productId: 'p1', reason: 'typed the wrong batch code',
    startedBy: 'u-qc', startedAt: '2026-08-06T09:00:00.000Z',
  };
  /** Wait for words to appear — never read the text in the same tick as the click that changes it. */
  const waitForWords = (page: import('playwright-core').Page, selector: string, words: string) =>
    page.waitForFunction(([s, w]) => ((globalThis as unknown as { document: { querySelector(q: string): { textContent: string | null } | null } }).document.querySelector(s)?.textContent ?? '').includes(w), [selector, words] as const, { timeout: 10_000 });

  it('withdrawn with a reason and the no-phone-call tick: the POST carries both, keyed; the screen says withdrawn only after head office saved it', async () => {
    const rec: Recorder = {
      expiryData: operator({ recalls: [openRecall] }), status: 200,
      body: { recall: { batchId: 'B-1', status: 'withdrawn' } }, requests: [],
    };
    const { page, teardown } = await openRecallTab(rec);
    try {
      await page.click('#withdraw-open-RC-1');
      await page.waitForSelector('#withdraw-reason-RC-1', { timeout: 10_000 });
      await page.fill('#withdraw-reason-RC-1', 'typed B-1 instead of B-11');
      await page.check('#withdraw-nophone-RC-1');
      await page.click('#withdraw-RC-1');
      await waitForWords(page, '#banner-text', 'withdrawn — started by mistake');

      const req = rec.requests.find((r) => r.path === '/v1/quality/recalls/B-1/withdrawal');
      expect(req, 'the withdrawal was not POSTed').toBeDefined();
      expect(req!.body).toEqual({ reason: 'typed B-1 instead of B-11', noCustomerPhoned: true });
      expect((req!.idem ?? '').length, 'no idempotency-key was sent').toBeGreaterThan(0);
      await waitForWords(page, '#banner-title', 'Done');
      // The list now shows it withdrawn, not open.
      await waitForWords(page, '#recall-RC-1', 'withdrawn');
    } finally {
      await teardown();
    }
  });

  it('without the no-phone-call tick nothing is sent, and the screen says why', async () => {
    const rec: Recorder = { expiryData: operator({ recalls: [openRecall] }), status: 200, body: { recall: { status: 'withdrawn' } }, requests: [] };
    const { page, teardown } = await openRecallTab(rec);
    try {
      await page.click('#withdraw-open-RC-1');
      await page.waitForSelector('#withdraw-reason-RC-1', { timeout: 10_000 });
      await page.fill('#withdraw-reason-RC-1', 'typed B-1 instead of B-11');
      await page.click('#withdraw-RC-1');
      await waitForWords(page, '#banner-text', 'only before any customer is called');
      expect(rec.requests.filter((r) => r.path.endsWith('/withdrawal'))).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('head office refuses it by name (a customer already contacted): the screen says so, the recall stays OPEN to be closed with evidence', async () => {
    const rec: Recorder = {
      expiryData: operator({ recalls: [openRecall] }), status: 409,
      body: { error: { code: 'recall_customers_already_contacted', whatHappened: 'Recall on batch "B-1" cannot be withdrawn: 1 customer(s) have already been contacted about it.', wasItSaved: 'not_saved' } },
      requests: [],
    };
    const { page, teardown } = await openRecallTab(rec);
    try {
      await page.click('#withdraw-open-RC-1');
      await page.waitForSelector('#withdraw-reason-RC-1', { timeout: 10_000 });
      await page.fill('#withdraw-reason-RC-1', 'typed B-1 instead of B-11');
      await page.check('#withdraw-nophone-RC-1');
      await page.click('#withdraw-RC-1');
      await waitForWords(page, '#banner-text', 'A customer has already been contacted');
      await waitForWords(page, '#banner-text', 'have already been contacted about it');
      await waitForWords(page, '#banner-title', 'Head office said no');
      expect(rec.requests.some((r) => r.path === '/v1/quality/recalls/B-1/withdrawal')).toBe(true);
      // Still open, and the Close button is still there.
      await waitForWords(page, '#recall-RC-1', 'OPEN');
      expect(await page.locator('#recall-RC-1 button', { hasText: 'Close this recall' }).count()).toBeGreaterThan(0);
    } finally {
      await teardown();
    }
  });
});
