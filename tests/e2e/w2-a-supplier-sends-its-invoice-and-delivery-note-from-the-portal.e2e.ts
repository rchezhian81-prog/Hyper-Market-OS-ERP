import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';

/**
 * **OB-624 (owner, 1 Nov 2026, in writing: "allow both") — the supplier portal's Invoice and Delivery note (ASN) forms, in
 * a real browser, over the REAL head office** (the API harness: the real routes, permissions and engines; the page's `/v1`
 * calls are answered by it as the signed-in supplier, exactly as the cloud session does).
 *
 *   • a supplier login with the submit grant sees both forms, its own open orders only, a label on every field and an icon
 *     beside each button's word; a bill whose lines do not add up to its total is refused ON THE PAGE and nothing is sent;
 *   • a good invoice and a good delivery note each go as ONE POST to the supplier's own submissions route; each then shows
 *     as "Waiting on us" — and head office holds no bill and no ASN until a buyer accepts them; once the buyer accepts the
 *     invoice it shows as processed and it is on the bill register;
 *   • a login without the submit grant is told it cannot send, and gets no form; head office refuses a non-supplier login.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const WEB_DIR = 'apps/supplier-app/web';

interface Shop { readonly h: ApiHarness; readonly t: string; readonly writes: { method: string; path: string; body: unknown }[] }

async function aShop(): Promise<Shop> {
  const h = apiHarness();
  const t = randomUUID();
  const call = (method: 'POST', path: string, userId: string, body: unknown) => h.request({ method, path, userId, tenantId: t, body, idempotencyKey: `k-${randomUUID()}` });
  await h.seedOwner(t, 'u-owner');
  await h.provisionRole(t, 'u-buyer', 'store_manager');
  await h.provisionRole(t, 'u-sup', 'supplier');
  await h.provisionRole(t, 'u-b2b', 'b2b_customer');
  await approvedSuppliers(h, t, 'sup-a');
  await deliveryPlaces(h, t, 'S1', 'S1-BACK');
  const ok = async (p: Promise<{ status: number; body: unknown }>) => { const r = await p; if (r.status >= 300) throw new Error(JSON.stringify(r.body)); };
  await ok(call('POST', '/v1/catalogue/products/p-oil/publish', 'u-owner', {
    product: { sku: 'p-oil', name: 'Oil 1L', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1507', lifecycle: 'active', handling: 'ambient' },
    categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
  }));
  await ok(call('POST', '/v1/purchase/orders/po-a', 'u-buyer', { supplierId: 'sup-a', deliverToLocationId: 'S1', lines: [{ productId: 'p-oil', orderedQty: 12, unitCost: { minor: 1_800, currency: 'INR' } }] }));
  await ok(h.request({ method: 'POST', path: '/v1/purchase/orders/po-a/approval', userId: 'u-owner', tenantId: t, body: { reason: 'ok' }, idempotencyKey: 'po-ok' }));
  await ok(call('POST', '/v1/supplier-portal/partners/sup-a', 'u-buyer', { grants: ['view_orders', 'submit_invoice', 'submit_asn'], documents: [], requiredDocuments: [], logins: ['u-sup'] }));
  return { h, t, writes: [] };
}

/** Serve the portal page; answer its `/v1` calls with the real head office, as the supplier the page names. */
async function startPortal(shop: Shop, supplierData: { userId: string; permissions: string[] }): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://portal');
      const path = url.pathname;
      if (path.startsWith('/v1/')) {
        let raw = '';
        for await (const c of req) raw += String(c);
        const body = raw === '' ? undefined : JSON.parse(raw) as unknown;
        const method = (req.method ?? 'GET') as 'GET' | 'POST';
        if (method !== 'GET') shop.writes.push({ method, path, body });
        const idem = req.headers['idempotency-key'];
        const out = await shop.h.request({
          method, path, userId: supplierData.userId, tenantId: shop.t, query: Object.fromEntries(url.searchParams),
          ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: String(Array.isArray(idem) ? idem[0] : idem ?? `k-${randomUUID()}`) }),
        });
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.body));
        return;
      }
      const file = path === '/' ? 'index.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        let text = buf.toString('utf8');
        if (file.endsWith('.html')) text = text.replace('<!--SCREEN-DATA-->', `<script>window.supplierData = ${JSON.stringify(supplierData)}; window.shopTimeZone = 'Asia/Kolkata';</script>`);
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(text);
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

const words = (page: Page, selector: string, text: string) =>
  page.waitForFunction(([s, w]) => ((globalThis as unknown as { document: { querySelector(q: string): { textContent: string | null } | null } }).document.querySelector(s)?.textContent ?? '').includes(w), [selector, text] as const, { timeout: 10_000 });

describe.skipIf(!existsSync(CHROMIUM))('OB-624: a supplier sends its invoice and delivery note from the portal, in a real browser', () => {
  let browser: Browser;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'supplier-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });

  it('refused on the page when the bill does not add up; then ONE invoice and ONE delivery note, each waiting for a buyer until accepted', async () => {
    const shop = await aShop();
    const srv = await startPortal(shop, { userId: 'u-sup', permissions: ['supplier.portal.self', 'supplier.portal.self.submit'] });
    const context = await browser.newContext({ timezoneId: 'America/New_York' });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });
      await page.waitForSelector('#inv-form:not([hidden])', { timeout: 10_000 });
      await words(page, '#inv-h', 'Send an invoice');
      await words(page, '#asn-h', 'Send a delivery note (ASN)');
      await page.waitForSelector('#inv-order option[value="po-a"]', { state: 'attached', timeout: 10_000 });
      // Its own open orders only, plus "not against an order".
      expect(await page.locator('#inv-order option').evaluateAll((os) => os.map((o) => (o as unknown as { value: string }).value))).toEqual(['', 'po-a']);
      for (const id of ['inv-order', 'inv-no', 'inv-total', 'inv-l1-productId', 'inv-l1-quantity', 'inv-l1-uom', 'inv-l1-unitPrice', 'asn-order', 'asn-no', 'asn-expected', 'asn-l1-productId', 'asn-l1-manufacturedOn']) {
        expect(await page.locator(`label[for="${id}"]`).count(), id).toBe(1);
      }
      expect(await page.locator('#inv-send svg').count()).toBe(1);
      expect(await page.locator('#asn-send svg').count()).toBe(1);

      // The invoice: 12 × ₹18.00 = ₹216.00; a total of ₹200 is refused on the page and nothing is sent.
      await page.selectOption('#inv-order', 'po-a');
      await page.fill('#inv-no', 'SUP-INV-7');
      await page.fill('#inv-l1-productId', 'p-oil');
      await page.fill('#inv-l1-quantity', '12');
      await page.fill('#inv-l1-unitPrice', '18');
      await words(page, '#inv-sum', 'The lines add up to ₹216.00.');
      await page.fill('#inv-total', '200');
      await page.click('#inv-send');
      await words(page, '#inv-result', 'The lines add up to ₹216.00 but your total says ₹200.00. Check the lines. Nothing was sent.');
      expect(shop.writes).toEqual([]);
      await page.fill('#inv-total', '216.00');
      await page.click('#inv-send');
      await page.waitForSelector('#inv-result[data-result="sent"]', { timeout: 10_000 });
      await words(page, '#inv-result', 'Sent — it waits for a buyer to check it. Nothing counts until a buyer accepts it.');

      // The delivery note, a second line added and then removed; the arrival typed at the shop's clock.
      await page.selectOption('#asn-order', 'po-a');
      await page.fill('#asn-no', 'ASN-7');
      await page.fill('#asn-expected', '2026-11-03T10:30');
      await page.fill('#asn-l1-productId', 'p-oil');
      await page.fill('#asn-l1-quantity', '12');
      await page.click('#asn-add');
      await page.waitForSelector('#asn-l2-productId');
      await page.click('#asn-lines li[data-line="2"] button.doc-remove');
      expect(await page.locator('#asn-lines > li').count()).toBe(1);
      await page.click('#asn-send');
      await page.waitForSelector('#asn-result[data-result="sent"]', { timeout: 10_000 });

      // Exactly two writes, each to the supplier's own submissions route, kind fixed, no supplier named.
      expect(shop.writes.map((w) => [w.method, w.path, (w.body as { kind: string }).kind])).toEqual([
        ['POST', '/v1/supplier-portal/me/submissions', 'invoice'], ['POST', '/v1/supplier-portal/me/submissions', 'asn'],
      ]);
      expect((shop.writes[0]!.body as { document: unknown }).document).toEqual({ invoiceId: 'SUP-INV-7', poId: 'po-a', declaredTotalMinor: 21_600, lines: [{ productId: 'p-oil', quantity: 12, uom: 'ea', unitPriceMinor: 1_800, lineTotalMinor: 21_600 }] });
      // 10:30 in the shop (India) — whatever the supplier's device clock says.
      expect((shop.writes[1]!.body as { document: { expectedAt: string } }).document.expectedAt).toBe('2026-11-03T05:00:00.000Z');
      for (const w of shop.writes) expect(JSON.stringify(w.body)).not.toMatch(/supplierId|partnerId/);

      // Both wait on us; head office holds no bill and no ASN until a buyer accepts.
      await page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(q: string): { length: number } } }).document.querySelectorAll('#awaiting li.row').length === 2, undefined, { timeout: 10_000 });
      const ho = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) => shop.h.request({ method, path, userId, tenantId: shop.t, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }) });
      expect((await ho('GET', '/v1/purchase/invoices/SUP-INV-7', 'u-buyer')).status).toBe(404);
      const submissions = ((await ho('GET', '/v1/supplier-portal/review-queue', 'u-buyer')).body as { waiting: { submissionId: string; kind: string }[] }).waiting;
      expect(submissions.map((s) => s.kind).sort()).toEqual(['asn', 'invoice']);
      // The buyer accepts the invoice (what the Supplier submissions page sends); the supplier then sees it processed.
      const inv = submissions.find((s) => s.kind === 'invoice')!;
      expect((await ho('POST', `/v1/supplier-portal/partners/sup-a/submissions/${inv.submissionId}/review`, 'u-buyer', { decision: 'accept', reason: 'matches' })).status).toBe(201);
      expect((await ho('GET', '/v1/purchase/invoices/SUP-INV-7', 'u-buyer')).status).toBe(200);
      await page.click('#refresh');
      await page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(q: string): { length: number } } }).document.querySelectorAll('#awaiting li.row').length === 1, undefined, { timeout: 10_000 });
      await words(page, '#processed', 'Invoice');
      await words(page, '#processed', 'Accepted by our buyer — matches');
      // The buyer rejects the delivery note with a reason: the supplier reads it, and nothing reaches the compare.
      const asnRow = submissions.find((s) => s.kind === 'asn')!;
      expect((await ho('POST', `/v1/supplier-portal/partners/sup-a/submissions/${asnRow.submissionId}/review`, 'u-buyer', { decision: 'reject', reason: 'wrong day' })).status).toBe(201);
      await page.click('#refresh');
      await words(page, '#processed', 'Not accepted — wrong day');
      expect(await page.locator('#awaiting li.row').count()).toBe(0);

      // Tamil.
      await page.click('#lang');
      await words(page, '#inv-h', 'விலைப்பட்டியல் அனுப்பு');
      await words(page, '#asn-send-text', 'விநியோகக் குறிப்பை அனுப்பு');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await srv.stop();
    }
  }, 120_000);

  it('a login without the submit grant gets no form; head office refuses a login that is not a supplier\'s', async () => {
    const shop = await aShop();
    const srv = await startPortal(shop, { userId: 'u-sup', permissions: ['supplier.portal.self'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });
      await words(page, '#inv-said', 'Your login cannot send invoices or delivery notes. Ask us to turn it on.');
      await words(page, '#asn-said', 'Your login cannot send invoices or delivery notes. Ask us to turn it on.');
      expect(await page.locator('#inv-form').getAttribute('hidden')).not.toBeNull();
      expect(await page.locator('#asn-form').getAttribute('hidden')).not.toBeNull();
      expect(shop.writes).toEqual([]);
      const refused = await shop.h.request({ method: 'POST', path: '/v1/supplier-portal/me/submissions', userId: 'u-b2b', tenantId: shop.t, idempotencyKey: 'k-b2b', body: { submissionId: 'x', kind: 'invoice', document: { invoiceId: 'X', declaredTotalMinor: 1, lines: [{ productId: 'p', quantity: 1, unitPriceMinor: 1, lineTotalMinor: 1 }] } } });
      expect(refused.status).toBe(403);
    } finally {
      await context.close();
      await srv.stop();
    }
  }, 120_000);
});
