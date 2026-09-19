import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The operator changes a price, in a real browser (M05-FR-02, ADR-0013 — the E2E matrix).**
 *
 * Every layer of "a person changes a price, and it is RECORDED at head office, as themselves, under the guard"
 * is unit-tested — the session's `changePriceInCloud` (which assembles the MRP/cost/floor), the browser's
 * `openPriceChangePort`, the cloud's `/v1/prices/changes` route with its `checkPrice` + §28 re-check. The one
 * thing units cannot prove is that a person filling the *Change a price* form in an actual browser, pressing
 * **Save**, makes that change reach the cloud, keyed for idempotency, under that operator's own session — and
 * that the screen then shows exactly what the cloud decided and invents no verdict of its own. This drives
 * headless Chromium against a stub cloud to prove that end to end:
 *
 *   • a CLEAN price (below MRP, above the margin floor) → saves with nobody's signature; the POST carries the
 *     raw figures (price, MRP, cost, floor); the banner says it changed and the button hides;
 *   • a BELOW-COST price → the screen asks for a §28 approver on-screen (a DIFFERENT person, with a written
 *     reason), and the save POST then carries that approver + reason for the cloud to verify;
 *   • the cloud REFUSES (422 — the named approver does not actually hold the authority) → the screen surfaces
 *     the reason verbatim and NEVER claims a change (P-08); the button stays, so the person can fix it.
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

/** The slice of the browser's globals these callbacks touch, cast structurally inside each evaluate. */
interface BrowserGlobals {
  readonly catalogueSession?: { readonly canChangePriceInCloud: boolean };
}

interface Recorder {
  catalogueData: Record<string, unknown>;
  changeStatus: number;
  changeBody: Record<string, unknown>;
  readonly requests: { method: string; path: string; body: unknown }[];
}

/** A server that serves the catalogue shell (GET, operator context injected) AND answers the price-change route
 *  the operator-session port POSTs to — same origin, so `credentials:'same-origin'` and a relative `/v1/...`
 *  reach it exactly as in production. */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        rec.requests.push({ method: 'POST', path, body: raw === '' ? undefined : JSON.parse(raw) });
        res.writeHead(rec.changeStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify(rec.changeBody));
        return;
      }
      const file = path === '/' || path === '/catalogue' ? 'catalogue.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.catalogueData = ${JSON.stringify(rec.catalogueData).replace(/</g, '\\u003c')};</script>`;
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

/** A pricing operator, a product with an MRP and a landed cost, a margin floor, and a DIFFERENT approver (§28). */
const pricingContext = (): Record<string, unknown> => ({
  userId: 'u-pricing', storeId: 'store-1', today: '2026-09-18',
  marginFloorBps: 2000, approvers: ['u-owner'],
  categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
  products: [{
    productId: 'p1', tenantId: 't1', sku: 'SKU-DAL', name: 'Toor dal 1kg', brand: 'Aachi',
    primaryCategoryId: 'grocery', baseUom: 'ea', taxClass: '0713', attributes: {},
    mrpHistory: [{ value: { minor: 160_00, currency: 'INR' }, effectiveFrom: '2026-01-01' }],
    lifecycle: 'active',
  }],
  costsMinor: { p1: 100_00 },
});

describe.skipIf(!HAVE_BROWSER)('operator price-change delivery, end to end in a real browser (M05-FR-02)', () => {
  let browser: Browser;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** Open the catalogue screen on the Change-a-price tab with the given operator context. */
  const openPriceTab = async (rec: Recorder) => {
    const srv = await startShellAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(
      () => (globalThis as unknown as BrowserGlobals).catalogueSession?.canChangePriceInCloud === true,
      undefined, { timeout: 10_000 },
    );
    await page.click('#tab-price');
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  /** Fill the price form and check it, so the Save button appears. */
  const checkPrice = async (page: import('playwright-core').Page, sku: string, rupees: string) => {
    await page.fill('#price-item', sku);
    await page.fill('#new-price', rupees);
    await page.fill('#price-from', '2026-09-18');
    await page.click('#check-price');
    await page.waitForSelector('#save-price:not([hidden])', { timeout: 10_000 });
  };

  const saveHidden = (page: import('playwright-core').Page) =>
    page.evaluate(() => {
      const el = (globalThis as unknown as { document: { getElementById(id: string): { hidden?: boolean } | null } })
        .document.getElementById('save-price');
      return el === null ? true : Boolean(el.hidden);
    });

  it('a clean price saves with nobody’s signature: the POST carries the raw figures (price, MRP, cost, floor)', async () => {
    const rec: Recorder = {
      catalogueData: pricingContext(), changeStatus: 201,
      changeBody: { productId: 'p1', priceMinor: 150_00, verdict: 'improves_margin', approvedBy: null }, requests: [],
    };
    const { page, teardown } = await openPriceTab(rec);
    try {
      await checkPrice(page, 'SKU-DAL', '150'); // below MRP 160, above the 20% floor at cost 100
      await page.click('#save-price');
      await page.waitForSelector('#banner:not([hidden])', { timeout: 10_000 });

      const changeReq = rec.requests.find((r) => r.path === '/v1/prices/changes');
      expect(changeReq, 'the price change was not POSTed').toBeDefined();
      const body = changeReq!.body as { productId?: string; priceMinor?: number; mrpMinor?: number; costMinor?: number; marginFloorBps?: number; approval?: unknown };
      // The screen sends the figures the cloud re-runs the guard over — never a client verdict.
      expect(body.productId).toBe('p1');
      expect(body.priceMinor).toBe(150_00);
      expect(body.mrpMinor).toBe(160_00);
      expect(body.costMinor).toBe(100_00);
      expect(body.marginFloorBps).toBe(2000);
      expect(body.approval).toBeUndefined(); // a clean price needs no approver

      expect(await saveHidden(page)).toBe(true);
    } finally {
      await teardown();
    }
  });

  it('a below-cost price asks for a §28 approver on screen, and the save carries that approver + reason', async () => {
    const rec: Recorder = {
      catalogueData: pricingContext(), changeStatus: 201,
      changeBody: { productId: 'p1', priceMinor: 90_00, verdict: 'below_cost', approvedBy: 'u-owner' }, requests: [],
    };
    const { page, teardown } = await openPriceTab(rec);
    try {
      await checkPrice(page, 'SKU-DAL', '90'); // below the 100 cost — a deliberate loss that needs approval
      await page.click('#save-price');

      // The on-screen approver panel opens (never a browser prompt); nothing has been sent yet.
      await page.waitForSelector('#sheet:not([hidden])', { timeout: 10_000 });
      expect(rec.requests).toHaveLength(0);

      await page.fill('#sheet-reason', 'clearing short-dated stock before it is written off');
      await page.click('#choices button'); // the only choice is u-owner (me is filtered out)
      await page.waitForSelector('#banner:not([hidden])', { timeout: 10_000 });

      const changeReq = rec.requests.find((r) => r.path === '/v1/prices/changes');
      expect(changeReq, 'the price change was not POSTed').toBeDefined();
      const body = changeReq!.body as { approval?: { decidedBy?: string; reason?: string } };
      // The screen's approver becomes the route's {decidedBy, reason}; the cloud verifies the authority.
      expect(body.approval?.decidedBy).toBe('u-owner');
      expect(body.approval?.reason).toBe('clearing short-dated stock before it is written off');
      expect(await saveHidden(page)).toBe(true);
    } finally {
      await teardown();
    }
  });

  it('the cloud refuses an unauthorised approver (422): the screen shows the reason and never claims a change', async () => {
    const rec: Recorder = {
      catalogueData: pricingContext(), changeStatus: 422,
      changeBody: { code: 'price_below_cost', whatHappened: 'u-owner does not hold price.change.approve, so their approval does not count.' }, requests: [],
    };
    const { page, teardown } = await openPriceTab(rec);
    try {
      await checkPrice(page, 'SKU-DAL', '90');
      await page.click('#save-price');
      await page.waitForSelector('#sheet:not([hidden])', { timeout: 10_000 });
      await page.fill('#sheet-reason', 'clearing short-dated stock before it is written off');
      await page.click('#choices button');
      await page.waitForSelector('#banner:not([hidden])', { timeout: 10_000 });

      // The cloud was asked, and refused; the screen shows its reason and does NOT report a change.
      expect(rec.requests.some((r) => r.path === '/v1/prices/changes')).toBe(true);
      expect((await page.textContent('#banner-text')) ?? '').toContain('does not hold price.change.approve');
      // The button stays, so the person can name a genuine approver and try again.
      expect(await saveHidden(page)).toBe(false);
    } finally {
      await teardown();
    }
  });
});
