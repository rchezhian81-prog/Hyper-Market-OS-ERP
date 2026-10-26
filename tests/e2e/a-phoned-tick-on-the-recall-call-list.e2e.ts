import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

/**
 * **OB-387 on the recall screens, in a real browser.**
 *
 *   • Recalls and trace → Call list: each customer shows "Not phoned yet" and a "Phoned — tick" button. A tap POSTs
 *     `/v1/quality/recalls/<batch>/call-list/<customer>/phoned` with an idempotency-key; the row says "Phoned by …" only
 *     after head office answered, and the button is gone. A customer already ticked shows who and when, with no button;
 *     a refusal from head office is shown in its words and the row stays un-ticked.
 *   • The expiry screen's withdrawal: head office refuses it BY NAME because a customer is ticked as phoned → the screen
 *     says so in words and the recall stays OPEN, to be closed with evidence.
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const WEB_DIR = 'apps/web-erp/web';

interface Shop {
  /** Answers by method + path; anything else is 404. */
  readonly answers: Map<string, { status: number; body: unknown }>;
  readonly requests: { method: string; path: string; idem: string | undefined }[];
  readonly page: string;
  readonly inject: string;
}

async function startShop(shop: Shop): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (path.startsWith('/v1/')) {
        req.resume(); await new Promise((done) => { req.on('end', done); });
        const idem = req.headers['idempotency-key'];
        shop.requests.push({ method: req.method ?? 'GET', path, idem: Array.isArray(idem) ? idem[0] : idem });
        const a = shop.answers.get(`${req.method} ${path}`) ?? { status: 404, body: { error: { code: 'not_found', whatHappened: 'not found' } } };
        res.writeHead(a.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(a.body));
        return;
      }
      const file = path === '/' ? shop.page : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) body = body.replace('<!--SCREEN-DATA-->', shop.inject);
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(body);
      } catch {
        res.writeHead(404); res.end('not found');
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

/** Wait for words to appear — never read the text in the same tick as the click that changes it. */
const waitForWords = (page: Page, selector: string, words: string) =>
  page.waitForFunction(([s, w]) => ((globalThis as unknown as { document: { querySelector(q: string): { textContent: string | null } | null } }).document.querySelector(s)?.textContent ?? '').includes(w), [selector, words] as const, { timeout: 10_000 });

const callList = (phonedB: { by: string; at: string } | null) => ({
  batchId: 'B-77', recall: { batchId: 'B-77', status: 'open', reason: 'r', initiatedAt: '2026-10-26T09:00:00.000Z', closedAt: null },
  decisions: ['OB-297', 'OB-328', 'OB-329'], dataLawBasis: { en: 'Data-law basis to be confirmed by your CA or lawyer.', ta: 'x' },
  smsConsentPurpose: 'transactional', anonymousSales: 0, estimatedSales: 0, smsConsented: 0, phonedCount: phonedB === null ? 0 : 1,
  callList: [
    { customerRef: 'cust-A', name: 'Anitha Raman', phoneLast4: '3210', serviceMessagesOn: [], smsAllowed: false, notes: [], noteSay: [], bought: [], phoned: null },
    { customerRef: 'cust-B', name: null, phoneLast4: null, serviceMessagesOn: [], smsAllowed: false, notes: [], noteSay: [], bought: [], phoned: phonedB },
  ],
  messages: { channel: 'sms', switchedOn: false, providerConnected: false, detail: '' },
});

describe.skipIf(!existsSync(CHROMIUM))('OB-387: a "phoned" tick on the recall call list, in a real browser', () => {
  let browser: Browser;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);
  afterAll(async () => { await browser?.close(); });

  const recallTrace = (answers: Shop['answers']): Shop => ({
    answers, requests: [], page: 'recall-trace.html',
    inject: `<script>window.recallTraceData = ${JSON.stringify({ permissions: ['quality.recall.notice.read', 'quality.recall.notice.phoned'] })};</script>`,
  });
  const openCalls = async (shop: Shop) => {
    const srv = await startShop(shop);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.click('#tab-calls');
    await page.fill('#c-batch', 'B-77');
    await page.click('#c-load');
    await page.waitForSelector('#c-rows li[data-customer="cust-A"]', { timeout: 10_000 });
    return { page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  it('ticks a customer as phoned: keyed POST, "Phoned by" shown only after head office answered; an earlier tick shows who, with no button', async () => {
    const shop = recallTrace(new Map([
      ['GET /v1/quality/recalls', { status: 200, body: { recalls: [] } }],
      ['GET /v1/quality/recalls/B-77/notice-list', { status: 200, body: callList({ by: 'u-owner', at: '2026-10-26T10:00:00.000Z' }) }],
      ['POST /v1/quality/recalls/B-77/call-list/cust-A/phoned', { status: 201, body: { batchId: 'B-77', customerRef: 'cust-A', phoned: { by: 'u-mgr', at: '2026-10-26T11:00:00.000Z' }, alreadyTicked: false } }],
    ]));
    const { page, teardown } = await openCalls(shop);
    try {
      const a = '#c-rows li[data-customer="cust-A"]';
      const b = '#c-rows li[data-customer="cust-B"]';
      await waitForWords(page, `${a} .phoned`, 'Not phoned yet');
      await waitForWords(page, `${b} .phoned`, 'Phoned by u-owner');
      expect(await page.locator(`${b} button.tick-phoned`).count()).toBe(0);
      await waitForWords(page, '#c-summary', '1 of 2 ticked as phoned.');
      // The icon sits beside the word.
      expect(await page.locator('#phoned-cust-A svg').count()).toBeGreaterThan(0);
      await waitForWords(page, '#phoned-cust-A', 'Phoned — tick');

      await page.click('#phoned-cust-A');
      await waitForWords(page, `${a} .phoned`, 'Phoned by u-mgr');
      await waitForWords(page, '#result', 'can no longer be withdrawn');
      await waitForWords(page, '#c-summary', '2 of 2 ticked as phoned.');
      expect(await page.locator('#phoned-cust-A').count()).toBe(0);
      const req = shop.requests.find((r) => r.method === 'POST' && r.path === '/v1/quality/recalls/B-77/call-list/cust-A/phoned');
      expect(req, 'the tick was not POSTed').toBeDefined();
      expect((req!.idem ?? '').length).toBeGreaterThan(0);

      // In Tamil.
      await page.click('#lang');
      await waitForWords(page, `${a} .phoned`, 'அழைத்தார்');
    } finally {
      await teardown();
    }
  });

  it('head office refuses the tick: its words are shown, the row stays not phoned and the button stays', async () => {
    const shop = recallTrace(new Map([
      ['GET /v1/quality/recalls', { status: 200, body: { recalls: [] } }],
      ['GET /v1/quality/recalls/B-77/notice-list', { status: 200, body: callList(null) }],
      ['POST /v1/quality/recalls/B-77/call-list/cust-A/phoned', { status: 409, body: { error: { code: 'recall_is_not_open_for_phone_ticks', whatHappened: 'The recall on batch B-77 is closed, so no customer is ticked as phoned on it now.', nextSafeAction: 'Nothing was changed.' } } }],
    ]));
    const { page, teardown } = await openCalls(shop);
    try {
      await page.click('#phoned-cust-A');
      await waitForWords(page, '#result', 'is closed, so no customer is ticked as phoned');
      await waitForWords(page, '#c-rows li[data-customer="cust-A"] .phoned', 'Not phoned yet');
      expect(await page.locator('#phoned-cust-A').count()).toBe(1);
    } finally {
      await teardown();
    }
  });

  it('the expiry screen: head office refuses the withdrawal because a customer is ticked as phoned — said in words, the recall stays OPEN', async () => {
    const operator = {
      userId: 'u-qc', storeId: 'store-1', now: '2026-08-06T14:00:00.000Z', nearExpiryDays: 7,
      batches: [{ batchId: 'B-1', productId: 'p1', qty: 10, expiry: '2026-08-09' }], productNames: { p1: 'Toor dal 1kg' },
      recalls: [{ recallId: 'RC-1', batchId: 'B-1', productId: 'p1', reason: 'typed the wrong batch code', startedBy: 'u-qc', startedAt: '2026-08-06T09:00:00.000Z' }],
    };
    const shop: Shop = {
      answers: new Map([['POST /v1/quality/recalls/B-1/withdrawal', { status: 409, body: { error: { code: 'recall_customers_already_phoned', whatHappened: 'Recall on batch "B-1" cannot be withdrawn: 1 customer(s) on the call list are ticked as phoned about it.', wasItSaved: 'not_saved' } } }]]),
      requests: [], page: 'expiry.html', inject: `<script>window.expiryData = ${JSON.stringify(operator)};</script>`,
    };
    const srv = await startShop(shop);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { expirySession?: unknown }).expirySession !== undefined, undefined, { timeout: 10_000 });
      await page.click('#tab-recall');
      await page.waitForSelector('#view-recall:not([hidden])', { timeout: 10_000 });
      await page.click('#withdraw-open-RC-1');
      await page.waitForSelector('#withdraw-reason-RC-1', { timeout: 10_000 });
      await page.fill('#withdraw-reason-RC-1', 'typed B-1 instead of B-11');
      await page.check('#withdraw-nophone-RC-1');
      await page.click('#withdraw-RC-1');
      await waitForWords(page, '#banner-text', 'A customer on the call list is ticked as phoned');
      await waitForWords(page, '#banner-title', 'Head office said no');
      await waitForWords(page, '#recall-RC-1', 'OPEN');
      expect(shop.requests.some((r) => r.path === '/v1/quality/recalls/B-1/withdrawal')).toBe(true);
    } finally {
      await context.close();
      await srv.stop();
    }
  });
});
