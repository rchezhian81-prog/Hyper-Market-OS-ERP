import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The accountant posts a trading day into the accounts, in a real browser (M23-FR-01 · API-09 · §28 — the E2E matrix).**
 *
 * Every layer of the day book — the tested buildDayBook / postDayBook engine, the routes, the session model, the
 * post port — is unit- and integration-tested. The one thing units cannot prove is that an accountant, in an
 * actual browser, choosing a day and clicking **"Post this day to the accounts"** makes the posting reach the cloud
 * under their own session, and that the journals then appear because the day was re-read. This drives headless
 * Chromium against a stub cloud to prove exactly that end to end:
 *
 *   • an accountant (finance.period.read + finance.journal.post) → the day first reads as "nothing posted", the
 *     click POSTs to /v1/finance/day-book/2026-09-28/post under their own session with an idempotency key, the
 *     day is re-read (a GET) and the journals, the accounts and the exceptions appear — the open one as an error;
 *   • a store manager (finance.period.read only) → the post button is not even rendered, and NOTHING is sent;
 *   • the cloud answers 409 posting_map_not_defined → the screen says the posting map must be defined first, and
 *     the day stays unposted.
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
    getElementById(id: string): { readonly hidden: boolean; readonly textContent: string | null } | null;
  };
}

const DAY = '2026-09-28';
const JOURNALS = [
  { entryId: `daybook:${DAY}:sale:1`, kind: 'sale', sourceKind: 'sale', sources: 12, period: '2026-09', documentDate: DAY, components: { total: 4_500_00, net: 4_285_72, tax: 214_28, cgst: 107_14, sgst: 107_14 }, lines: [{ accountCode: '1210', debitMinor: 4_500_00, creditMinor: 0 }, { accountCode: '4000', debitMinor: 0, creditMinor: 4_285_72 }, { accountCode: '2310', debitMinor: 0, creditMinor: 214_28 }], postedBy: 'u-acct', narrative: `Day book ${DAY} — sale` },
  { entryId: `daybook:${DAY}:tender:cash:1`, kind: 'tender:cash', sourceKind: 'sale', sources: 12, period: '2026-09', documentDate: DAY, components: { amount: 4_500_00 }, lines: [{ accountCode: '1000', debitMinor: 4_500_00, creditMinor: 0 }, { accountCode: '1210', debitMinor: 0, creditMinor: 4_500_00 }], postedBy: 'u-acct', narrative: `Day book ${DAY} — tender:cash` },
];
const ACCOUNTS = [
  { accountCode: '1000', debitMinor: 4_500_00, creditMinor: 0, balanceMinor: 4_500_00 },
  { accountCode: '1210', debitMinor: 4_500_00, creditMinor: 4_500_00, balanceMinor: 0 },
  { accountCode: '2310', debitMinor: 0, creditMinor: 214_28, balanceMinor: -214_28 },
  { accountCode: '4000', debitMinor: 0, creditMinor: 4_285_72, balanceMinor: -4_285_72 },
];
const EXCEPTION = { exceptionId: `${DAY}:tax_rate_unknown:sale:ab12`, tradingDay: DAY, sourceKind: 'sale', sourceIds: ['S-0031'], reason: 'tax_rate_unknown', detail: 'S-0031 line 2: tax rate for P-77 unknown', raisedAt: '2026-09-29T02:00:00.000Z', raisedBy: 'u-acct' };
const UNPOSTED = { tradingDay: DAY, journals: [], accounts: [], covered: 0, exceptions: [], open: 0, asAt: '2026-09-29T09:00:00.000Z' };
const POSTED_READ = { tradingDay: DAY, journals: JOURNALS, accounts: ACCOUNTS, covered: 12, exceptions: [{ ...EXCEPTION, state: 'open' }], open: 1, asAt: '2026-09-29T09:01:00.000Z' };
const POST_BODY = { tradingDay: DAY, postedTo: '2026-09', journals: JOURNALS, exceptions: [EXCEPTION], skipped: 0, zeroValue: [], counted: { sales: 13, returns: 0 } };

interface Recorder {
  screenData: Record<string, unknown>;
  /** What the cloud answers to the POST: 201 posted, or 409 no posting map. */
  postAnswer: 'posted' | 'no_map';
  posted: boolean;
  readonly requests: { method: string; path: string; headers: Record<string, string | string[] | undefined> }[];
}

/** A server that BOTH serves the shell (GET, the accountant's context injected) AND answers the two routes the
 *  screen touches — the post POST and the day-book GET — on the SAME origin, so `credentials: 'same-origin'` and a
 *  relative `/v1/...` reach it exactly as in production. */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const post = /^\/v1\/finance\/day-book\/(\d{4}-\d{2}-\d{2})\/post$/.exec(path);
      if (req.method === 'POST' && post !== null) {
        for await (const chunk of req) void chunk; // the route reads no body; drain it
        rec.requests.push({ method: 'POST', path, headers: req.headers });
        if (rec.postAnswer === 'no_map') {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'posting_map_not_defined', whatHappened: 'no posting map', wasItSaved: 'not_saved', nextSafeAction: 'define it', traceId: 't' } }));
          return;
        }
        rec.posted = true;
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify(POST_BODY));
        return;
      }
      const read = /^\/v1\/finance\/day-book\/(\d{4}-\d{2}-\d{2})$/.exec(path);
      if (req.method === 'GET' && read !== null) {
        rec.requests.push({ method: 'GET', path, headers: req.headers });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(rec.posted ? POSTED_READ : { ...UNPOSTED, tradingDay: read[1] }));
        return;
      }
      const file = path === '/' || path === '/day-book' ? 'day-book.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.dayBookData = ${JSON.stringify(rec.screenData).replace(/</g, '\\u003c')};</script>`;
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
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

const user = (userId: string, permissions: readonly string[]): Record<string, unknown> => ({ userId, tenantId: 't1', permissions });

describe.skipIf(!HAVE_BROWSER)('the accountant posts a trading day, end to end in a real browser (M23-FR-01)', () => {
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
    // Choose the day under test and read it: the screen defaults to yesterday, the stub answers any day.
    await page.fill('#day', DAY);
    await page.click('#load');
    await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.getElementById('posted-state')?.textContent !== '', undefined, { timeout: 10_000 });
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  it('an accountant: the day reads as unposted, the click POSTs under their own session, and the re-read shows the journals, accounts and the open exception', async () => {
    const rec: Recorder = { screenData: user('u-acct', ['finance.period.read', 'finance.journal.post']), postAnswer: 'posted', posted: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      expect(await page.locator('#journals li.row').count()).toBe(0);
      expect(await page.locator('#posted-state').innerText()).toContain('Nothing posted');
      expect(await page.locator('#post').getAttribute('hidden')).toBeNull(); // the posting act is offered

      await page.click('#post');

      // The journals appear because the day was re-READ (server re-derive), not drawn from the POST reply.
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#journals li.row').length === 2, undefined, { timeout: 10_000 });
      const post = rec.requests.find((r) => r.method === 'POST');
      expect(post?.path).toBe(`/v1/finance/day-book/${DAY}/post`);
      expect(typeof post?.headers['idempotency-key']).toBe('string');
      expect(rec.requests.filter((r) => r.method === 'GET' && r.path === `/v1/finance/day-book/${DAY}`).length).toBeGreaterThanOrEqual(2);

      expect(await page.locator('#journals li.row').first().innerText()).toContain('₹4,500.00');
      expect(await page.locator('#accounts tbody tr').count()).toBe(4);
      expect(await page.locator('#exceptions li.row').count()).toBe(1);
      expect(await page.locator('#exceptions li.row').first().getAttribute('class')).toContain('tone-error');
      expect(await page.locator('#open-count').innerText()).toContain('1');
      expect(await page.locator('#result').getAttribute('class')).toContain('tone-ok');
      expect(await page.locator('#result').innerText()).toContain('2 journals posted');
    } finally {
      await teardown();
    }
  });

  it('a store manager with read only sends NOTHING — the post button is not rendered', async () => {
    const rec: Recorder = { screenData: user('u-mgr', ['finance.period.read']), postAnswer: 'posted', posted: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      expect(await page.locator('#post').getAttribute('hidden')).not.toBeNull();
      expect(rec.requests.some((r) => r.method === 'POST')).toBe(false);
      expect(rec.requests.every((r) => r.method === 'GET')).toBe(true);
    } finally {
      await teardown();
    }
  });

  it('when the posting map is not defined the cloud refuses (409) and the screen says so — the day stays unposted', async () => {
    const rec: Recorder = { screenData: user('u-acct', ['finance.period.read', 'finance.journal.post']), postAnswer: 'no_map', posted: false, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      await page.click('#post');
      await page.waitForSelector('#result:not([hidden])', { timeout: 10_000 });
      expect(await page.locator('#result').getAttribute('class')).toContain('tone-error');
      expect(await page.locator('#result').innerText()).toContain('posting map is not defined');
      expect(await page.locator('#journals li.row').count()).toBe(0);
      expect(rec.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    } finally {
      await teardown();
    }
  });
});
