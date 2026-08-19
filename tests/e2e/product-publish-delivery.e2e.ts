import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { buildProductPublishCommand, type ProductPublishBarcode } from '../../apps/web-erp/src/catalogue-publish-command';
import type { ProductRecord, Category } from '../../packages/product/src/index';

/**
 * **The operator publishes, in a real browser (ADR-0013 slice 7 — the E2E matrix).**
 *
 * Every layer of "the signed-in operator delivers a queued product publish, as themselves" is unit-tested; the
 * one thing units cannot prove is that a person pressing **Publish** in an actual browser makes the product
 * master AND its barcodes reach the cloud, under that operator's own session, and that the durable queue then
 * transitions honestly. This drives headless Chromium against a stub cloud to prove exactly that end to end:
 *
 *   • an authorised operator → the product-master POST then the barcode POST both arrive (each keyed off the
 *     command so a retry cannot duplicate), the result strip says "published", and the outbox item clears;
 *   • a no-permission operator → the Publish button is disabled and NOTHING is sent (the client cannot publish
 *     under a grant it does not hold — the cloud would refuse it anyway, but it never even asks);
 *   • a barcode already owned by another product (409) → the whole command dead-letters, VISIBLE for a person,
 *     never silently dropped (hard rule #6).
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS rather
 * than failing, exactly like the offline-open suite.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';
const OUTBOX_KEY = 'sre.catalogue-outbox';

/**
 * The slice of the browser's globals these callbacks touch, cast structurally (`globalThis as unknown as
 * BrowserGlobals`) INSIDE each `page.evaluate`/`addInitScript` — so the callback references no DOM lib and this
 * test file needs none. The cast is erased at compile time; the browser receives plain `globalThis`.
 */
interface BrowserGlobals {
  readonly localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  readonly document: {
    querySelectorAll(selector: string): { readonly length: number };
    getElementById(id: string): { readonly disabled?: boolean } | null;
  };
}

const GROCERY: Category = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const SALT: ProductRecord = {
  productId: 'p-salt', tenantId: 't1', sku: 'SKU-SALT', name: 'Tata Salt 1kg',
  baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'new',
};
const BARCODE: ProductPublishBarcode = { code: '8901058000108', kind: 'ean' };

/** One pending publish command, in the exact device-outbox shape the boot restores from localStorage. */
function seededOutbox(): string {
  const event = buildProductPublishCommand({
    record: SALT, categories: [GROCERY], barcodes: [BARCODE], requestedBy: 'u-owner', at: '2026-08-18T06:00:00.000Z',
  });
  return JSON.stringify([{ key: event.idempotencyKey, event, state: 'pending', attempts: 0, reason: null }]);
}

/** What the ERP would inject about the signed-in operator, mutated per scenario. */
interface Recorder {
  reviewData: Record<string, unknown>;
  publishStatus: number;
  barcodeStatus: number;
  readonly requests: { method: string; path: string; body: unknown }[];
}

/** A server that BOTH serves the shell (GET, with the operator context injected) AND answers the two cloud
 *  routes the operator-session delivery port POSTs to — the same origin, so `credentials: 'same-origin'` and a
 *  relative `/v1/...` reach it exactly as they do in production. */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        rec.requests.push({ method: 'POST', path, body: raw === '' ? undefined : JSON.parse(raw) });
        const status = path.includes('/barcodes/') ? rec.barcodeStatus : rec.publishStatus;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: status < 400 }));
        return;
      }
      const file = path === '/' || path === '/product-publish-review' ? 'product-publish-review.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.productPublishReviewData = ${JSON.stringify(rec.reviewData).replace(/</g, '\\u003c')};</script>`;
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

const authorised = (): Record<string, unknown> => ({
  userId: 'u-owner', tenantId: 't1', permissions: ['catalogue.pack.publish'], sessionActive: true, tenantMember: true,
});

describe.skipIf(!HAVE_BROWSER)('operator publish delivery, end to end in a real browser (ADR-0013)', () => {
  let browser: Browser;

  beforeAll(async () => {
    // Build the CURRENT web-erp bundle so the browser runs this branch's code, not a stale artifact.
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** Open the review screen with the outbox seeded and the given operator context. */
  const openScreen = async (rec: Recorder) => {
    const srv = await startShellAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(([key, json]) => { (globalThis as unknown as BrowserGlobals).localStorage.setItem(key, json); }, [OUTBOX_KEY, seededOutbox()] as const);
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('.status').length > 0, undefined, { timeout: 10_000 });
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  const storedOutbox = (page: import('playwright-core').Page) =>
    page.evaluate((key) => JSON.parse((globalThis as unknown as BrowserGlobals).localStorage.getItem(key) ?? '[]') as { state: string }[], OUTBOX_KEY);

  const deliverDisabled = (page: import('playwright-core').Page) =>
    page.evaluate(() => Boolean((globalThis as unknown as BrowserGlobals).document.getElementById('deliver')?.disabled));

  it('an authorised operator publishes: the product master THEN its barcode reach the cloud, and the queue clears', async () => {
    const rec: Recorder = { reviewData: authorised(), publishStatus: 201, barcodeStatus: 201, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      // The ready item shows a Publish button that is enabled.
      expect(await deliverDisabled(page)).toBe(false);

      await page.click('#deliver');
      await page.waitForSelector('#result:not([hidden])', { timeout: 10_000 });

      // Both legs reached the cloud, product FIRST then barcode, each under the operator's own session.
      const publishReq = rec.requests.find((r) => r.path === '/v1/catalogue/products/p-salt/publish');
      const barcodeReq = rec.requests.find((r) => r.path === '/v1/catalogue/products/p-salt/barcodes/8901058000108');
      expect(publishReq, 'the product master was not POSTed').toBeDefined();
      expect(barcodeReq, 'the barcode was not POSTed').toBeDefined();
      expect(rec.requests.indexOf(publishReq!)).toBeLessThan(rec.requests.indexOf(barcodeReq!)); // product before barcode
      expect((publishReq!.body as { product?: { sku?: string } }).product?.sku).toBe('SKU-SALT');
      expect((barcodeReq!.body as { kind?: string }).kind).toBe('ean');

      // The result strip reports the outcome, and the durable queue cleared (acknowledged).
      expect(((await page.textContent('#result-text')) ?? '').toLowerCase()).toContain('publish');
      const items = await storedOutbox(page);
      expect(items[0]?.state).toBe('acknowledged');
    } finally {
      await teardown();
    }
  });

  it('a no-permission operator sends NOTHING — the Publish button is disabled and the queue is untouched', async () => {
    const rec: Recorder = {
      reviewData: { userId: 'u-owner', tenantId: 't1', permissions: [], sessionActive: true, tenantMember: true },
      publishStatus: 201, barcodeStatus: 201, requests: [],
    };
    const { page, teardown } = await openScreen(rec);
    try {
      // The item is routed for someone with authority; the button cannot publish.
      expect(await deliverDisabled(page)).toBe(true);
      // Nothing was sent to the cloud, and the item stays pending — never published under a grant not held.
      expect(rec.requests).toHaveLength(0);
      const items = await storedOutbox(page);
      expect(items[0]?.state).toBe('pending');
    } finally {
      await teardown();
    }
  });

  it('a barcode already owned by another product (409) dead-letters the whole command — visible, never dropped', async () => {
    const rec: Recorder = { reviewData: authorised(), publishStatus: 201, barcodeStatus: 409, requests: [] };
    const { page, teardown } = await openScreen(rec);
    try {
      await page.click('#deliver');
      await page.waitForSelector('#result:not([hidden])', { timeout: 10_000 });

      // The product went in (idempotent), the barcode conflicted, and the command is dead-lettered for a person.
      expect(rec.requests.some((r) => r.path === '/v1/catalogue/products/p-salt/publish')).toBe(true);
      expect(rec.requests.some((r) => r.path.startsWith('/v1/catalogue/products/p-salt/barcodes/'))).toBe(true);
      const items = await storedOutbox(page);
      expect(items[0]?.state).toBe('dead_letter');
    } finally {
      await teardown();
    }
  });
});
