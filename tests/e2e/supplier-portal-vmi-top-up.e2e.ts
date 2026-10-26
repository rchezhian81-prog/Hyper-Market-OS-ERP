import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

/**
 * **OB-389 — the supplier portal's "Top-up proposal" form (D03-FR-04 vendor-managed inventory), in a real browser.**
 *
 *   • the supplier sees ITS OWN stocked items at a store — the buyer's minimum and maximum, on hand, on order, the room
 *     left, and "Below the minimum" as an icon AND a word; the send button carries an icon beside its word;
 *   • past the room it is refused ON THE PAGE and nothing is sent; inside the room exactly ONE POST goes to
 *     `/v1/supplier-portal/me/vmi/proposals/<id>` carrying `{ storeId, lines, note }` — no supplier named — with an
 *     idempotency-key, and the page says "waits for a buyer" only after head office answered; the proposal then reads
 *     "Waiting for a buyer";
 *   • head office's refusal is shown in its words; a login without the submit grant is told it cannot propose and gets
 *     no form; the page reads in Tamil.
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const WEB_DIR = 'apps/supplier-app/web';

interface Shop {
  supplierData: Record<string, unknown>;
  /** The answer the proposal POST gets. */
  postStatus: number;
  postBody: unknown;
  proposals: Record<string, unknown>[];
  readonly requests: { method: string; path: string; idem: string | undefined; body: unknown }[];
}

const ITEMS = [
  { storeId: 'br-1', productId: 'p-rice', minQty: 20, maxQty: 50, uom: 'ea', onHand: 15, onOrder: 0, room: 35, belowMinimum: true, asAt: '2026-10-26T09:00:00.000Z' },
  { storeId: 'br-1', productId: 'p-oil', minQty: 4, maxQty: 12, uom: 'ea', onHand: 10, onOrder: 0, room: 2, belowMinimum: false, asAt: '2026-10-26T09:00:00.000Z' },
];

async function startPortal(shop: Shop): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (path.startsWith('/v1/')) {
        let raw = '';
        for await (const c of req) raw += String(c);
        const idem = req.headers['idempotency-key'];
        shop.requests.push({ method: req.method ?? 'GET', path, idem: Array.isArray(idem) ? idem[0] : idem, body: raw === '' ? undefined : JSON.parse(raw) });
        if (req.method === 'GET' && path === '/v1/supplier-portal/me/submissions') return json(200, { submissions: [] });
        if (req.method === 'GET' && path === '/v1/supplier-portal/me/statement') return json(200, { partnerId: 'sup-1', accessible: false });
        if (req.method === 'GET' && path === '/v1/supplier-portal/me/orders') return json(200, { ordersKnown: true, orders: [], mayUpdate: false });
        if (req.method === 'GET' && path === '/v1/supplier-portal/me/vmi') return json(200, { partnerId: 'sup-1', items: ITEMS, proposals: shop.proposals, asAt: '2026-10-26T09:00:00.000Z' });
        if (req.method === 'POST' && path.startsWith('/v1/supplier-portal/me/vmi/proposals/')) {
          if (shop.postStatus < 300) {
            const b = JSON.parse(raw) as { storeId: string; lines: unknown[] };
            shop.proposals.push({ proposalId: decodeURIComponent(path.split('/').pop() ?? ''), storeId: b.storeId, lines: b.lines, note: '', proposedAt: '2026-10-26T09:05:00.000Z', status: 'awaiting_buyer', reason: null, decidedAt: null });
          }
          return json(shop.postStatus, shop.postBody);
        }
        return json(404, { error: { code: 'not_found' } });
      }
      const file = path === '/' ? 'index.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) body = body.replace('<!--SCREEN-DATA-->', `<script>window.supplierData = ${JSON.stringify(shop.supplierData)};</script>`);
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(body);
      } catch { res.writeHead(404); res.end('not found'); }
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

const supplier = (permissions: string[]) => ({ userId: 'u-sup1', permissions });
const FULL = ['supplier.portal.self', 'supplier.portal.self.submit'];

describe.skipIf(!existsSync(CHROMIUM))('OB-389: a supplier sends a top-up proposal from the portal, in a real browser', () => {
  let browser: Browser;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'supplier-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);
  afterAll(async () => { await browser?.close(); });

  const open = async (shop: Shop) => {
    const srv = await startPortal(shop);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    return { page, teardown: async () => { await context.close(); await srv.stop(); } };
  };
  const proposalPosts = (shop: Shop) => shop.requests.filter((r) => r.method === 'POST');

  it('sees its own items with the room; past the room nothing is sent; inside it ONE keyed POST, then "Waiting for a buyer"; Tamil', async () => {
    const shop: Shop = { supplierData: supplier(FULL), postStatus: 201, postBody: { status: 'awaiting_buyer' }, proposals: [], requests: [] };
    const { page, teardown } = await open(shop);
    try {
      await page.waitForSelector('#vmi:not([hidden]) li[data-product="p-rice"]', { timeout: 10_000 });
      await waitForWords(page, '#vmi-h', 'Top-up proposal');
      await waitForWords(page, '#vmi-items li[data-product="p-rice"] .facts', 'min 20 · max 50 · on hand 15 · on order 0 · room 35 ea');
      await waitForWords(page, '#vmi-items li[data-product="p-rice"] .status', 'Below the minimum');
      expect(await page.locator('#vmi-items li[data-product="p-rice"] .status .icon').textContent()).toBe('⚠');
      expect(await page.locator('#vmi-send svg').count()).toBeGreaterThan(0);
      await waitForWords(page, '#vmi-send', 'Send the top-up proposal');

      // Past the room on oil (room 2): refused on the page, nothing sent.
      await page.fill('#vmi-items li[data-product="p-oil"] input', '3');
      await page.click('#vmi-send');
      await waitForWords(page, '#vmi-result', 'more than the room');
      expect(proposalPosts(shop)).toEqual([]);

      // Inside the room: one keyed POST with exactly { storeId, lines, note }.
      await page.fill('#vmi-items li[data-product="p-oil"] input', '');
      await page.fill('#vmi-items li[data-product="p-rice"] input', '30');
      await page.fill('#vmi-note', 'weekly top-up');
      await page.click('#vmi-send');
      await waitForWords(page, '#vmi-result', 'waits for a buyer');
      const posts = proposalPosts(shop);
      expect(posts.length).toBe(1);
      expect(posts[0]!.path).toMatch(/^\/v1\/supplier-portal\/me\/vmi\/proposals\/vmi-br-1-/);
      expect(posts[0]!.body).toEqual({ storeId: 'br-1', lines: [{ productId: 'p-rice', quantity: 30 }], note: 'weekly top-up' });
      expect((posts[0]!.idem ?? '').length).toBeGreaterThan(0);
      await waitForWords(page, '#vmi-proposals', 'Waiting for a buyer');
      await waitForWords(page, '#vmi-proposals', 'p-rice × 30');

      await page.click('#lang');
      await waitForWords(page, '#vmi-h', 'இருப்பு நிரப்பும் முன்மொழிவு');
      await waitForWords(page, '#vmi-proposals', 'வாங்குபவருக்காகக் காத்திருக்கிறது');
    } finally {
      await teardown();
    }
  });

  it('head office refuses it: its words are shown and nothing is said to be waiting', async () => {
    const shop: Shop = {
      supplierData: supplier(FULL), postStatus: 422, proposals: [], requests: [],
      postBody: { error: { code: 'outside_the_agreed_limits', whatHappened: '30 ea of p-rice would take the store past its maximum of 50; at most 5 may be proposed.' } },
    };
    const { page, teardown } = await open(shop);
    try {
      await page.waitForSelector('#vmi-items li[data-product="p-rice"] input', { timeout: 10_000 });
      await page.fill('#vmi-items li[data-product="p-rice"] input', '30');
      await page.click('#vmi-send');
      await waitForWords(page, '#vmi-result', 'at most 5 may be proposed');
      expect(proposalPosts(shop).length).toBe(1);
      expect(await page.locator('#vmi-proposals li').count()).toBe(0);
    } finally {
      await teardown();
    }
  });

  it('a login without the submit grant is told it cannot propose, and gets no form', async () => {
    const shop: Shop = { supplierData: supplier(['supplier.portal.self']), postStatus: 201, postBody: {}, proposals: [], requests: [] };
    const { page, teardown } = await open(shop);
    try {
      await waitForWords(page, '#vmi-said', 'cannot send top-up proposals');
      expect(await page.isHidden('#vmi-form')).toBe(true);
      expect(await page.isHidden('#vmi-send')).toBe(true);
      expect(proposalPosts(shop)).toEqual([]);
    } finally {
      await teardown();
    }
  });
});
