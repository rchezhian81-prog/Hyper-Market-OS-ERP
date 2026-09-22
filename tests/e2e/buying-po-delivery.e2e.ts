import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The buyer raises a purchase order, in a real browser (M06-FR-02 · §28 · P-08 — the E2E write-path).**
 *
 * Every layer of "a buyer raises an order, and it is PROPOSED at head office, as themselves, with no
 * self-approval" is unit-tested — the session's `proposeToCloud`, the browser's `openProposePurchaseOrderPort`,
 * the cloud's `POST /v1/purchase/orders/:poId` route (requisitioner attributed to the authenticated caller,
 * issuing a separate second-person act). The one thing units cannot prove is that a person filling the
 * *Raise an order* form in an ACTUAL browser, pressing **Raise the order**, makes that order reach the cloud —
 * keyed for idempotency, under that buyer's own session, carrying no approver — and that the screen then shows
 * exactly what the cloud decided and invents no "raised" of its own. This drives headless Chromium against a
 * stub cloud on ONE origin to prove that end to end:
 *
 *   • a CLEAN order → PROPOSES: the POST carries `{ supplierId, lines[unitCost:{minor,currency}] }` and NO
 *     approver, keyed by the PO id; the banner says it was proposed and waits for a second person (§28);
 *   • the cloud REFUSES (422) → the screen surfaces the reason verbatim and NEVER claims a raise (P-08);
 *   • an EMPTY order → refused on the screen before anything is sent (nothing leaves the box).
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

/** The slice of the browser's globals these callbacks touch, cast structurally inside each evaluate. */
interface BrowserGlobals {
  readonly buyingSession?: { readonly canProposeToCloud: boolean };
}

interface OrderRequest {
  readonly method: string;
  readonly path: string;
  readonly idempotencyKey: string | undefined;
  readonly body: unknown;
}

interface Recorder {
  buyingData: Record<string, unknown>;
  orderStatus: number;
  orderBody: Record<string, unknown>;
  readonly requests: OrderRequest[];
}

/** A server that serves the buying shell (GET, buyer context injected) AND answers the PO route the buyer-session
 *  port POSTs to — same origin, so `credentials:'same-origin'` and a relative `/v1/...` reach it exactly as in
 *  production. The PO id is a path segment (`/v1/purchase/orders/PO-XXXX`), so the handler matches the prefix. */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (req.method === 'POST' && path.startsWith('/v1/purchase/orders/')) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        const key = req.headers['idempotency-key'];
        rec.requests.push({
          method: 'POST', path,
          idempotencyKey: typeof key === 'string' ? key : undefined,
          body: raw === '' ? undefined : JSON.parse(raw),
        });
        res.writeHead(rec.orderStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify(rec.orderBody));
        return;
      }
      const file = path === '/' || path === '/buying' ? 'buying.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.buyingData = ${JSON.stringify(rec.buyingData).replace(/</g, '\\u003c')};</script>`;
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

/** A buyer, with a couple of product codes the box knows about. */
const buyingContext = (): Record<string, unknown> => ({ buyerId: 'u-buyer', productIds: ['p1', 'p2'] });

describe.skipIf(!HAVE_BROWSER)('buyer PO-propose delivery, end to end in a real browser (M06-FR-02)', () => {
  let browser: Browser;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** Open the buying screen on the Raise-an-order tab with the buyer wired to the cloud. */
  const openPoTab = async (rec: Recorder) => {
    const srv = await startShellAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(
      () => (globalThis as unknown as BrowserGlobals).buyingSession?.canProposeToCloud === true,
      undefined, { timeout: 10_000 },
    );
    await page.click('#tab-po');
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  /** Add one order line: supplier, item, quantity and agreed unit price (in rupees). */
  const addLine = async (page: import('playwright-core').Page, supplier: string, item: string, qty: string, rupees: string) => {
    await page.fill('#po-supplier', supplier);
    await page.fill('#po-product', item);
    await page.fill('#po-qty', qty);
    await page.fill('#po-cost', rupees);
    await page.click('#add-po-line');
  };

  const bannerIsGood = (page: import('playwright-core').Page) =>
    page.evaluate(() => {
      const el = (globalThis as unknown as { document: { getElementById(id: string): { classList?: { contains(c: string): boolean } } | null } })
        .document.getElementById('banner');
      return el?.classList?.contains('good') ?? false;
    });

  it('a clean order PROPOSES: the POST carries { supplierId, lines[unitCost] } and NO approver, keyed by the PO id (§28)', async () => {
    const rec: Recorder = {
      buyingData: buyingContext(), orderStatus: 201,
      orderBody: { order: { status: 'proposed', requisitionedBy: 'u-buyer', totalMinor: 50000 }, openCommitment: null }, requests: [],
    };
    const { page, teardown } = await openPoTab(rec);
    try {
      await addLine(page, 'sup-1', 'p1', '10', '50'); // 10 × ₹50 = ₹500
      await page.click('#raise-po');
      await page.waitForSelector('#banner:not([hidden])', { timeout: 10_000 });

      const orderReq = rec.requests.find((r) => r.path.startsWith('/v1/purchase/orders/'));
      expect(orderReq, 'the PO was not POSTed').toBeDefined();
      // The PO id is both the last path segment and the idempotency key — a re-click collapses to one order.
      const poId = orderReq!.path.split('/').at(-1);
      expect(poId).toBeTruthy();
      expect(orderReq!.idempotencyKey).toBe(poId);
      const body = orderReq!.body as { supplierId?: string; lines?: { productId?: string; orderedQty?: number; unitCost?: { minor?: number; currency?: string } }[] };
      expect(body.supplierId).toBe('sup-1');
      expect(body.lines).toEqual([{ productId: 'p1', orderedQty: 10, unitCost: { minor: 5000, currency: 'INR' } }]);
      // No approver rides with a proposal — issuing is a separate second person's act (§28).
      expect(JSON.stringify(body)).not.toContain('approv');

      // The banner reports a PROPOSAL awaiting a second person, and it is the "good" banner.
      expect((await page.textContent('#banner-title')) ?? '').toMatch(/proposed/i);
      expect(await bannerIsGood(page)).toBe(true);
    } finally {
      await teardown();
    }
  });

  it('the cloud refuses (422): the screen shows the reason verbatim and never claims a raise (P-08)', async () => {
    const rec: Recorder = {
      buyingData: buyingContext(), orderStatus: 422,
      orderBody: { code: 'purchase_order_currency_mismatch', whatHappened: 'Every line on a purchase order must be priced in one known currency.' }, requests: [],
    };
    const { page, teardown } = await openPoTab(rec);
    try {
      await addLine(page, 'sup-1', 'p1', '10', '50');
      await page.click('#raise-po');
      await page.waitForSelector('#banner:not([hidden])', { timeout: 10_000 });

      // The cloud WAS asked (the write-path reached it), and refused.
      expect(rec.requests.some((r) => r.path.startsWith('/v1/purchase/orders/'))).toBe(true);
      // The screen shows the cloud's reason, and it is NOT the "good" banner — no false raise.
      expect((await page.textContent('#banner-text')) ?? '').toContain('one known currency');
      expect(await bannerIsGood(page)).toBe(false);
    } finally {
      await teardown();
    }
  });

  it('an empty order is refused on the screen before anything is sent (nothing leaves the box)', async () => {
    const rec: Recorder = {
      buyingData: buyingContext(), orderStatus: 201,
      orderBody: { order: { status: 'proposed', requisitionedBy: 'u-buyer', totalMinor: 0 }, openCommitment: null }, requests: [],
    };
    const { page, teardown } = await openPoTab(rec);
    try {
      // No line added — pressing Raise must refuse locally and POST nothing.
      await page.click('#raise-po');
      await page.waitForSelector('#banner:not([hidden])', { timeout: 10_000 });
      expect(rec.requests).toHaveLength(0);
      expect(await bannerIsGood(page)).toBe(false);
    } finally {
      await teardown();
    }
  });

  // ── The OTHER buyer write-path on this screen: bulk invoice capture (A-03, §28) ──────────────────
  //
  // The screen's headline is killing the eighty-line retype: paste the supplier's file, type the total off
  // the paper, and capture it — atomically, only when it reconciles, and only with a SECOND person's
  // approval. Capture commits to the box's own store (offline-first, P-01), so it makes no network call;
  // the sync to the cloud is a separate wire. These prove that write-path end to end in a real browser.

  /** Open the buying screen on the (default) Supplier-invoice tab with the given buyer + approver list. */
  const openInvoiceTab = async (rec: Recorder) => {
    const srv = await startShellAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(
      () => (globalThis as unknown as BrowserGlobals).buyingSession?.canProposeToCloud === true,
      undefined, { timeout: 10_000 },
    );
    await page.click('#tab-invoice');
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  // A clean two-line file: 10×₹100 and 5×₹50 = ₹1,250.00, reconciling to the printed total.
  const CLEAN_FILE = ['productId,quantity,unitPriceMinor,lineTotalMinor', 'p1,10,10000,100000', 'p2,5,5000,25000'].join('\n');

  const fillInvoice = async (page: import('playwright-core').Page, supplier: string) => {
    await page.fill('#invoice-id', 'INV-1');
    await page.fill('#supplier-id', supplier);
    await page.fill('#declared-total', '1250');
    await page.fill('#file-text', CLEAN_FILE);
    await page.click('#preview');
    await page.waitForSelector('#capture:not([hidden])', { timeout: 10_000 });
  };

  it('a reconciling invoice captures atomically with a SECOND person’s approval, and makes no network call (A-03, §28, P-01)', async () => {
    const rec: Recorder = {
      buyingData: { buyerId: 'u-buyer', productIds: ['p1', 'p2'], approvers: ['u-manager'] },
      orderStatus: 201, orderBody: {}, requests: [],
    };
    const { page, teardown } = await openInvoiceTab(rec);
    try {
      await fillInvoice(page, 'sup-1');
      await page.click('#capture');
      // The on-screen approver panel opens (never a browser prompt); the only choice is u-manager (§28).
      await page.waitForSelector('#sheet:not([hidden])', { timeout: 10_000 });
      await page.click('#choices button');
      await page.waitForSelector('#banner:not([hidden])', { timeout: 10_000 });

      // Captured: the "good" banner, and — offline-first — nothing was POSTed anywhere.
      expect(await bannerIsGood(page)).toBe(true);
      expect(rec.requests).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it('the buyer cannot approve their own capture: the model refuses even if their name reaches the sheet (§28)', async () => {
    const rec: Recorder = {
      // Defense in depth: the box normally strips the buyer from the approver list; even if it did not,
      // the model must refuse a self-approval. Offer only the buyer's own name and prove it is refused.
      buyingData: { buyerId: 'u-buyer', productIds: ['p1', 'p2'], approvers: ['u-buyer'] },
      orderStatus: 201, orderBody: {}, requests: [],
    };
    const { page, teardown } = await openInvoiceTab(rec);
    try {
      await fillInvoice(page, 'sup-1');
      await page.click('#capture');
      await page.waitForSelector('#sheet:not([hidden])', { timeout: 10_000 });
      await page.click('#choices button'); // the only name offered is the buyer's own
      await page.waitForSelector('#banner:not([hidden])', { timeout: 10_000 });

      // Refused as a self-approval — not the "good" banner, and still nothing written.
      expect(await bannerIsGood(page)).toBe(false);
      expect((await page.textContent('#banner-text')) ?? '').toMatch(/cannot also approve|cannot approve your own/i);
    } finally {
      await teardown();
    }
  });
});
