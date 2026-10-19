import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { beginOtpChallenge, verifyOtp, type OtpChallenge } from '../../packages/identity/src/index';
import { createOtpSimulator } from '../support/otp-simulator';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { testModePaymentProvider, type TestModePaymentProvider } from '../../packages/orders/src/payment-verification';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **A real customer, in a real browser, places a real order that the cloud then holds** (M20-FR-03,
 * §31 customer row, hard rules #3 #4 — Stage C, M20 slice 2).
 *
 * Everything below the browser is unit- and integration-tested: the session's rules, the transport's
 * request, the storefront route, the reservation. What only a browser can prove is the whole hop as a
 * customer lives it: search → basket → check → slot → location → sign in by one-time code → pay → the
 * order screen says CONFIRMED because the shop said so — and, with the connection cut at the moment
 * of paying, the screen says NOT SENT, nothing is charged, and the same order goes once, by itself,
 * when the connection returns.
 *
 * One Node server plays the store's reverse proxy: it serves the app's own files with `window.shopData`
 * injected the way the store box does, plays the auth backend with the production OTP engines and the
 * local test IdP (a minter never enters the page), and hands `/v1/*` straight to the REAL API kernel.
 * On a verified first sign-in the auth backend also registers the customer — grants the `customer`
 * role — which is the backend's second duty and the reason the shop then knows whose order it is.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/customer-app/web';
const DATA_MARKER = '<!--SCREEN-DATA-->';

// `let`: the OB-77 test gives each PostgreSQL run its own shop, so a re-run never meets the last run's records.
let T = 'ab000000-0000-4000-8000-000000000049';
const OWNER = 'u-owner';
const PHONE = '+919000000001';
const SUBJECT = 'cust-phone-1';
const AT = '2026-10-10T10:00:00.000Z';

const STORE = { lat: 11.0168, lon: 76.9558 };
const NEARBY = { latitude: 11.02, longitude: 76.96 };

// FUL-03: the slot the app offers is one HEAD OFFICE's own delivery service runs (set in `seededApi`) — the shop judges it.
let heldSlot = { startsAt: new Date(Date.now() + 3 * 3_600_000).toISOString(), endsAt: new Date(Date.now() + 5 * 3_600_000).toISOString() };
function shopData(): Record<string, unknown> {
  const starts = new Date(heldSlot.startsAt);
  const ends = new Date(heldSlot.endsAt);
  return {
    tenantId: T, customerRef: 'guest', packVersion: 3, locationId: 'L1',
    products: [{
      productId: 'MILK', name: 'Aavin Milk 1L', categoryId: 'dairy', unitPriceMinor: 60_00, uom: 'each',
      barcodes: ['8901234567891'], status: 'active', availableMinor: 5, availabilityAgeMinutes: 1,
    }],
    slots: [{ slotId: 'this-evening', startsAt: starts.toISOString(), endsAt: ends.toISOString(), capacity: 4, booked: 0, kind: 'delivery' }],
    storeLocation: STORE, policy: { radiusMetres: 10_000, deliveryFeeMinor: 40_00 }, deliveryFeeMinor: 40_00,
  };
}

interface Recorder {
  readonly apiCalls: { method: string; path: string; auth: boolean }[];
  /** FUL-06: after sign-in the app reads the customer's own privacy choices — kept apart from the order traffic. */
  privacyReads?: { auth: boolean }[];
  grantedCustomerRole: number;
}

async function startStore(h: ApiHarness, rec: Recorder): Promise<{ base: string; sms: ReturnType<typeof createOtpSimulator>; stop: () => Promise<void> }> {
  const sms = createOtpSimulator();
  const challenges = new Map<string, OtpChallenge>();
  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => { data += String(c); });
      req.on('end', () => { try { resolve(JSON.parse(data || '{}') as Record<string, unknown>); } catch { resolve({}); } });
    });
  const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body ?? null));
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');

      // ── The auth backend: production OTP engines, local test IdP, and the customer's registration ──
      if (req.method === 'POST' && path === '/auth/otp/begin') {
        const body = await readBody(req);
        const challengeId = `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const begun = beginOtpChallenge({ challengeId, tenantId: T, phoneNumber: String(body['phoneNumber'] ?? ''), purpose: 'login', now: new Date().toISOString() });
        challenges.set(challengeId, begun.challenge);
        sms.send({ phoneNumber: begun.challenge.phoneNumber, code: begun.code, purpose: 'login', tenantId: T });
        sendJson(res, 200, { ok: true, challengeId });
        return;
      }
      if (req.method === 'POST' && path === '/auth/otp/verify') {
        const body = await readBody(req);
        const challenge = challenges.get(String(body['challengeId'] ?? ''));
        if (challenge === undefined) { sendJson(res, 200, { ok: false, reason: 'unknown_challenge' }); return; }
        const v = verifyOtp({ challenge, tenantId: T, submittedCode: String(body['code'] ?? ''), now: new Date().toISOString() });
        if (!v.verified) { sendJson(res, 200, { ok: false, reason: v.outcome }); return; }
        challenges.set(challenge.challengeId, v.challenge);
        // The backend's second duty: a verified customer holds the `customer` role in this shop.
        await h.provisionRole(T, SUBJECT, 'customer');
        rec.grantedCustomerRole += 1;
        const token = TEST_IDP.issue({ sub: SUBJECT, tenantId: T, amr: ['otp'] });
        sendJson(res, 200, { ok: true, token, sessionId: `s-${Date.now()}` });
        return;
      }
      if (req.method === 'POST' && path === '/auth/signout') { sendJson(res, 200, { ok: true }); return; }

      // ── The API, behind the same origin — every call the app makes to the shop passes here ──
      if (path.startsWith('/v1/')) {
        const auth = req.headers['authorization'] ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
        const key = req.headers['idempotency-key'];
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        // Round 8: the customer's own reads after sign-in (privacy, favourites, lists, cases) are kept apart from the order traffic.
        if (req.method === 'GET' && path.startsWith('/v1/me/')) (rec.privacyReads ??= []).push({ auth: token !== undefined });
        else rec.apiCalls.push({ method: req.method ?? '?', path, auth: token !== undefined });
        const out = await h.raw({
          method: (req.method ?? 'GET') as 'GET' | 'POST', path,
          ...(token === undefined ? {} : { token }),
          ...(body === undefined ? {} : { body }),
          ...(typeof key === 'string' ? { idempotencyKey: key } : {}),
        });
        sendJson(res, out.status, out.body);
        return;
      }

      // ── The app's own files, with the screen's data injected the way the store box does ──
      const file = path === '/' || path === '/index.html' ? 'index.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.webmanifest') ? 'application/manifest+json' : 'application/octet-stream';
        let text = buf.toString('utf8');
        if (file === 'index.html') {
          text = text.replace(DATA_MARKER, `<script>window.shopData = ${JSON.stringify(shopData()).replace(/</g, '\\u003c')};</script>`);
        }
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(text);
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
      resolve({ base: `http://127.0.0.1:${port}`, sms, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

// FUL-03: the test-mode payment provider. The provider's sheet in the browser hands the app a token (`shopPaymentRef`);
// the test, standing in for the bank, registers the capture — the app's own "authorised" never makes it paid.
let provider: TestModePaymentProvider;
const PAY_REF = 'tok_e2e_1';
async function seededApi(capacityPerSlot = 10, make?: (p: TestModePaymentProvider) => ApiHarness): Promise<ApiHarness> {
  provider = testModePaymentProvider();
  const h = make === undefined ? apiHarness({ paymentVerifier: provider }) : make(provider);
  await h.seedOwner(T, OWNER);
  await h.enableFeature(T, 'customer_app');
  await h.request({ method: 'POST', path: '/v1/inventory/movements', userId: OWNER, tenantId: T, idempotencyKey: 'mv-1', body: { movementId: 'mv-1', productId: 'MILK', locationId: 'L1', kind: 'received', quantityMinor: 5, uom: 'each', occurredAt: AT, enteredBy: OWNER } });
  // The shop's own figures its quote is made from (FUL-03): milk at ₹60 for L1, and a ₹40 delivery fee.
  const today = new Date().toISOString().slice(0, 10);
  const ok = async (path: string, body: unknown, key: string) => expect((await h.request({ method: 'POST', path, userId: OWNER, tenantId: T, idempotencyKey: key, body })).status, path).toBeLessThan(300);
  await ok('/v1/catalogue/tax-classes/0401/rates/2017-07-01', { rateBps: 0 }, 'tax');
  await ok('/v1/catalogue/products/MILK/publish', { product: { sku: 'MILK-1L', name: 'Aavin Milk 1L', baseUom: 'each', primaryCategoryId: 'dairy', taxClass: '0401', lifecycle: 'active' }, categories: [{ categoryId: 'dairy', name: 'Dairy', parentId: null }] }, 'pub');
  await ok('/v1/prices/list/MILK/entries/e1', { scope: 'store', scopeRef: 'L1', priceMinor: 60_00, mrpMinor: 70_00, costMinor: 40_00, marginFloorBps: 0, currency: 'INR', effectiveFrom: today }, 'price');
  await ok('/v1/catalogue/pack', { storeId: 'L1', asOf: today }, 'pack');
  await ok('/v1/serviceability/periods/2026-01-01', { radiusMetres: 10_000, deliveryFeeMinor: 40_00 }, 'svc');
  // FUL-03: how the store delivers, held at head office (OA-11: the main store, 8 slots 9 am–9 pm).
  expect((await h.request({ method: 'PUT', path: '/v1/serviceability/delivery-service', userId: OWNER, tenantId: T, idempotencyKey: 'dsvc', body: { storeLocation: STORE, slotsPerDay: 8, windowOpen: '09:00', windowClose: '21:00', capacityPerSlot, leadMinutes: 60 } })).status).toBe(200);
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  heldSlot = ((await h.request({ method: 'GET', path: '/v1/serviceability/delivery-service', userId: OWNER, tenantId: T, query: { day: tomorrow } })).body as { slots: { startsAt: string; endsAt: string }[] }).slots[0]!;
  return h;
}

const ordersOf = async (h: ApiHarness) =>
  ((await h.request({ method: 'GET', path: '/v1/storefront/orders', userId: SUBJECT, tenantId: T })).body as { orders: { orderId: string; payment: { state: string; paidMinor: number } }[] }).orders;

/** Drive the customer up to the moment of paying: one milk in the basket, checked, slot chosen, located, signed in. */
async function readyToPay(page: Page, base: string, sms: ReturnType<typeof createOtpSimulator>): Promise<void> {
  // The provider's own payment sheet gives the app its token (no card data ever touches the app — hard rule #3).
  await page.addInitScript((ref) => { (globalThis as unknown as { shopPaymentRef?: string }).shopPaymentRef = ref; }, PAY_REF);
  await page.goto(`${base}/`, { waitUntil: 'load' });
  // The real shop (not the sample) — the bundle read `window.shopData` and attached `window.shop`.
  await page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(id: string): { hidden: boolean } | null } }).document.getElementById('sample')?.hidden === true, undefined, { timeout: 10_000 });
  await page.fill('#search', 'milk');
  await page.click('button[aria-label="Add Aavin Milk 1L"]');
  await page.click('#tab-basket');
  await page.click('#review');
  await page.click('#banner-ok');
  await page.locator('#slots .row button').first().click();
  await page.click('#banner-ok');
  await page.click('#locate');
  await page.locator('#banner-title', { hasText: 'Use my location' }).waitFor({ timeout: 10_000 });
  await page.click('#banner-ok');
  // Sign in by one-time code, right there in the basket.
  await page.fill('#si-phone', PHONE);
  await page.click('#si-send');
  await page.waitForSelector('#si-step-code:not([hidden])', { timeout: 10_000 });
  const code = sms.codeFor(PHONE);
  expect(code).toBeTruthy();
  await page.fill('#si-code', code ?? '');
  await page.click('#si-verify');
  await page.waitForSelector('#si-step-in:not([hidden])', { timeout: 10_000 });
  expect(await page.locator('#si-who').textContent()).toContain(PHONE);
}

describe.skipIf(!HAVE_BROWSER)('a customer orders in a real browser and the cloud holds the order (M20-FR-03, slice 2)', () => {
  let browser: Browser;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'customer-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });

  it('search → basket → check → slot → location → sign in by OTP → pay: the screen says CONFIRMED because the shop has it, with the payment and the stock reserved', async () => {
    const h = await seededApi();
    const rec: Recorder = { apiCalls: [], grantedCustomerRole: 0 };
    const store = await startStore(h, rec);
    const context: BrowserContext = await browser.newContext({ geolocation: NEARBY, permissions: ['geolocation'] });
    const page = await context.newPage();
    try {
      await readyToPay(page, store.base, store.sms);
      expect(rec.grantedCustomerRole).toBe(1);
      expect(rec.apiCalls).toHaveLength(0); // nothing has gone to the shop before Pay
      // FUL-06: the only read before Pay is the customer's own privacy choices, as the signed-in customer.
      expect(rec.privacyReads?.length ?? 0).toBeGreaterThanOrEqual(1);
      expect(rec.privacyReads?.every((r) => r.auth)).toBe(true);

      provider.capture(PAY_REF, 60_00 + 40_00); // the bank captured exactly the shop's quote
      await page.click('#pay');
      await page.waitForSelector('#view-order:not([hidden])', { timeout: 15_000 });
      const said = await page.locator('#order-say').textContent();
      expect(said).toMatch(/confirmed and will be picked/);
      expect(await page.locator('#send-now').getAttribute('hidden')).not.toBeNull(); // nothing waiting to go

      // One authenticated POST to the storefront route — the whole of what left the phone.
      expect(rec.apiCalls).toEqual([{ method: 'POST', path: expect.stringMatching(/^\/v1\/storefront\/orders\/ORD-/), auth: true }]);
      // The cloud holds it FOR this customer, with the checkout's payment: 1 × ₹60 + ₹40 delivery.
      const orders = await ordersOf(h);
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({ payment: { state: 'authorised', paidMinor: 60_00 + 40_00 } });
      expect(said).toContain(orders[0]!.orderId);
      // And the stock is really set aside: 5 on hand, 1 reserved → the next customer is promised 4 of 5.
      await h.provisionRole(T, 'cust-other', 'customer');
      const next = await h.request({ method: 'POST', path: '/v1/storefront/orders/so-next', userId: 'cust-other', tenantId: T, idempotencyKey: 'so-next', body: { lines: [{ productId: 'MILK', quantityMinor: 5 }], locationId: 'L1' } });
      expect((next.body as { promise: { lines: { promisedMinor: number }[] } }).promise.lines[0]!.promisedMinor).toBe(4);

      // A second tap of Pay does not place it twice. (Dismiss the order banner first — it sits over
      // the bottom of the screen, where the Pay button is, and a real thumb would have to as well.)
      await page.click('#banner-ok');
      await page.click('#tab-basket');
      await page.click('#pay');
      await page.locator('#banner').waitFor({ state: 'visible', timeout: 10_000 });
      expect(rec.apiCalls.filter((c) => c.method === 'POST')).toHaveLength(1);
      expect(await ordersOf(h)).toHaveLength(1);
    } finally {
      await context.close();
      await store.stop();
    }
  }, 60_000);

  it('FUL-03/FUL-07: the app\'s own "paid" is not enough — the screen says WAITING until the provider confirms, and "Check my payment" shows the shop\'s answer', async () => {
    const h = await seededApi();
    const rec: Recorder = { apiCalls: [], grantedCustomerRole: 0 };
    const store = await startStore(h, rec);
    const context: BrowserContext = await browser.newContext({ geolocation: NEARBY, permissions: ['geolocation'] });
    const page = await context.newPage();
    try {
      await readyToPay(page, store.base, store.sms);
      await page.click('#pay'); // the provider has captured nothing
      await page.waitForSelector('#view-order:not([hidden])', { timeout: 15_000 });
      expect(await page.locator('#order-say').textContent()).toMatch(/waiting on your bank/);
      expect(await page.locator('#order-say').textContent()).not.toMatch(/confirmed and will be picked/);
      expect((await ordersOf(h))[0]).toMatchObject({ payment: { state: 'pending', paidMinor: 0 } });
      await page.click('#banner-ok');
      provider.capture(PAY_REF, 60_00 + 40_00);
      await page.click('#check-payment');
      await page.locator('#order-say', { hasText: 'confirmed and will be picked' }).waitFor({ timeout: 15_000 });
      expect((await ordersOf(h))[0]).toMatchObject({ payment: { state: 'authorised', paidMinor: 60_00 + 40_00 } });
    } finally {
      await context.close();
      await store.stop();
    }
  }, 60_000);

  it('with the connection cut at the moment of paying: NOT SENT, nothing charged — and the same order goes once, by itself, when the connection returns', async () => {
    const h = await seededApi();
    const rec: Recorder = { apiCalls: [], grantedCustomerRole: 0 };
    const store = await startStore(h, rec);
    const context: BrowserContext = await browser.newContext({ geolocation: NEARBY, permissions: ['geolocation'] });
    const page = await context.newPage();
    try {
      await readyToPay(page, store.base, store.sms);
      await context.setOffline(true);
      await page.click('#pay');
      await page.waitForSelector('#view-order:not([hidden])', { timeout: 15_000 });
      const said = await page.locator('#order-say').textContent();
      expect(said).toMatch(/NOT been sent/);
      expect(said).toMatch(/nothing has been charged/i);
      expect(said).not.toMatch(/confirmed/i);
      expect(await page.locator('#send-now').getAttribute('hidden')).toBeNull(); // one tap would re-send
      expect(rec.apiCalls).toHaveLength(0); // nothing reached the shop
      expect(await ordersOf(h)).toHaveLength(0);
      provider.capture(PAY_REF, 60_00 + 40_00);

      // The connection returns: the prepared basket goes by itself — once.
      await context.setOffline(false);
      await page.locator('#order-say', { hasText: 'confirmed and will be picked' }).waitFor({ timeout: 15_000 });
      expect(rec.apiCalls.filter((c) => c.method === 'POST')).toHaveLength(1);
      const orders = await ordersOf(h);
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({ payment: { state: 'authorised', paidMinor: 60_00 + 40_00 } });
      expect(await page.locator('#send-now').getAttribute('hidden')).not.toBeNull();
    } finally {
      await context.close();
      await store.stop();
    }
  }, 60_000);

  it('FUL-03: the slot the customer chose filled up at the shop while they were paying — the shop refuses it, the screen says so, nothing is charged or reserved', async () => {
    const h = await seededApi(1);
    const rec: Recorder = { apiCalls: [], grantedCustomerRole: 0 };
    const store = await startStore(h, rec);
    const context: BrowserContext = await browser.newContext({ geolocation: NEARBY, permissions: ['geolocation'] });
    const page = await context.newPage();
    try {
      await readyToPay(page, store.base, store.sms);
      // Another customer takes the slot's only place first.
      await h.provisionRole(T, 'cust-first', 'customer');
      const first = await h.request({ method: 'POST', path: '/v1/storefront/orders/so-first', userId: 'cust-first', tenantId: T, idempotencyKey: 'so-first', body: { lines: [{ productId: 'MILK', quantityMinor: 1 }], locationId: 'L1', fulfilment: 'delivery', deliverySlot: { startsAt: heldSlot.startsAt }, deliveryLocation: { lat: NEARBY.latitude, lon: NEARBY.longitude } } });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      provider.capture(PAY_REF, 60_00 + 40_00);
      await page.click('#pay');
      await page.locator('#banner-text', { hasText: 'full' }).waitFor({ timeout: 15_000 });
      expect(await ordersOf(h)).toHaveLength(0);
    } finally {
      await context.close();
      await store.stop();
    }
  }, 60_000);

  it('D08-FR-02/05/06 (round 8): a favourite, a saved list, a voice search through the fake engine, and a complaint that reaches the desk — in English and Tamil', async () => {
    const h = await seededApi();
    const rec: Recorder = { apiCalls: [], grantedCustomerRole: 0 };
    const store = await startStore(h, rec);
    const context: BrowserContext = await browser.newContext({ geolocation: NEARBY, permissions: ['geolocation'] });
    const page = await context.newPage();
    // The fake speech engine (no engine is chosen — the owner's decision): it "hears" one phrase. R4 · D08 (OB-222): the
    // voice link is switched off in the product; a test puts its stand-in behind the link as `shopVoiceStandIn`.
    await page.addInitScript(() => {
      (globalThis as unknown as { shopVoiceStandIn: unknown }).shopVoiceStandIn = { name: 'fake voice engine (e2e)', available: () => true, listen: async () => ({ heard: true, transcript: 'Please, Aavin MILK!' }) };
    });
    try {
      await readyToPay(page, store.base, store.sms);
      // A favourite, kept on the shop.
      await page.click('#tab-shop');
      await page.fill('#search', 'milk');
      await page.click('#results .row button.fav');
      await page.waitForSelector('#results .row button.fav[aria-pressed="true"]', { timeout: 10_000 });
      const favs = (await h.request({ method: 'GET', path: '/v1/me/favourites', userId: SUBJECT, tenantId: T })).body as { favourites: { productId: string }[] };
      expect(favs.favourites.map((f) => f.productId)).toEqual(['MILK']);
      await page.waitForSelector('#favourites .row', { timeout: 10_000 });
      expect(await page.textContent('#favourites .row .name')).toBe('Aavin Milk 1L');

      // The basket saved as a list, then offered back in one tap.
      await page.click('#tab-basket');
      await page.fill('#list-name', 'Weekly');
      await page.click('#save-list');
      await page.locator('#list-say', { hasText: 'Saved as a list on the shop.' }).waitFor({ timeout: 10_000 });
      await page.click('#tab-shop');
      await page.waitForSelector('#mylists .row', { timeout: 10_000 });
      expect(await page.textContent('#mylists .row .name')).toBe('Weekly — 1 item(s)');

      // Voice search: what was heard becomes the search, shown — nothing goes in the basket by voice.
      await page.fill('#search', '');
      await page.click('#voice');
      await page.locator('#voice-say', { hasText: 'We heard: aavin milk' }).waitFor({ timeout: 10_000 });
      expect(await page.inputValue('#search')).toBe('aavin milk');

      // A complaint from the app reaches the shop's service desk.
      await page.click('#tab-order');
      await page.fill('#complaint-text', 'The milk was sour');
      await page.click('#complain');
      await page.locator('#help-say', { hasText: 'Reference: app-' }).waitFor({ timeout: 10_000 });
      await page.waitForSelector('#my-cases .row', { timeout: 10_000 });
      const desk = (await h.request({ method: 'GET', path: '/v1/service/cases', userId: OWNER, tenantId: T })).body as { cases: { caseId: string; kind: string; state: string }[] };
      expect(desk.cases).toEqual([expect.objectContaining({ kind: 'complaint', state: 'open' })]);
      expect(desk.cases[0]!.caseId).toMatch(/^app-/);

      // Tamil follows the one toggle — the new sections too.
      await page.click('#lang');
      expect(await page.textContent('#cases-title')).toBe('என் கேள்விகளும் புகார்களும்');
      expect(await page.textContent('#help-title')).toBe('ஏதாவது தவறா?');
      await page.click('#tab-shop');
      expect(await page.textContent('#fav-title')).toBe('எனக்குப் பிடித்தவை');
      expect(await page.textContent('#voice')).toBe('குரல் மூலம் தேடு');
    } finally {
      await context.close();
      await store.stop();
    }
  }, 60_000);

  it('OB-77: the driver\'s delivery status and its as-of time reach the customer\'s screen — on its way, could not deliver — read back after a head-office restart, in English and Tamil', async () => {
    // On real PostgreSQL when DATABASE_URL is set (its own shop per run), otherwise the in-memory store; either way the restart
    // is a second head-office instance over the same records.
    const url = process.env['DATABASE_URL'];
    const pool = url === undefined ? undefined : new Pool({ connectionString: url, max: 4, options: '-c app.tenant_id=*' });
    const savedT = T;
    if (pool !== undefined) {
      T = randomUUID();
      const dir = 'db/migrations';
      await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
    }
    let current: ApiHarness | undefined;
    const make = (p: TestModePaymentProvider): ApiHarness => pool === undefined
      ? apiHarness({ paymentVerifier: p, ...(current === undefined ? {} : { store: current.store }) })
      : apiHarness({ store: new SqlEventStore(pgPoolClient(pool)), idempotency: new SqlIdempotencyStore(pgPoolClient(pool)), paymentVerifier: p });
    current = await seededApi(10, make);
    await current.enableFeature(T, 'delivery');
    await current.provisionRole(T, 'u-mgr', 'store_manager');
    // The packer needs the product's handling class on the product master (never guessed from its name).
    for (const [path, body] of [
      ['/v1/catalogue/products/MILK/publish', { product: { sku: 'MILK-1L', name: 'Aavin Milk 1L', baseUom: 'each', primaryCategoryId: 'dairy', taxClass: '0401', lifecycle: 'active', handling: 'ambient' }, categories: [{ categoryId: 'dairy', name: 'Dairy', parentId: null }] }],
      ['/v1/catalogue/pack', { storeId: 'L1', asOf: new Date().toISOString().slice(0, 10) }],
    ] as const) expect((await current.request({ method: 'POST', path, userId: OWNER, tenantId: T, idempotencyKey: `ob77-${path}`, body })).status, path).toBeLessThan(300);
    // The store's reverse proxy always talks to whichever head-office instance is running now.
    const live = { raw: (i: Parameters<ApiHarness['raw']>[0]) => current!.raw(i), provisionRole: (...a: Parameters<ApiHarness['provisionRole']>) => current!.provisionRole(...a) } as unknown as ApiHarness;
    const rec: Recorder = { apiCalls: [], grantedCustomerRole: 0 };
    const store = await startStore(live, rec);
    const context: BrowserContext = await browser.newContext({ geolocation: NEARBY, permissions: ['geolocation'] });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const staff = async (path: string, userId: string, body: unknown) => {
      const r = await current!.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: `${path}-${JSON.stringify(body)}`, body });
      expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
    };
    try {
      await readyToPay(page, store.base, store.sms);
      provider.capture(PAY_REF, 60_00 + 40_00);
      await page.click('#pay');
      await page.waitForSelector('#view-order:not([hidden])', { timeout: 15_000 });
      await page.locator('#order-say', { hasText: 'confirmed and will be picked' }).waitFor({ timeout: 15_000 });
      await page.click('#banner-ok');
      const orderId = (await ordersOf(current)).at(0)!.orderId;
      // Asking where it is writes nothing: the only new call is one authenticated GET of the customer's own order.
      const posts = rec.apiCalls.filter((c) => c.method === 'POST').length;
      await page.click('#track-order');
      await page.locator('#delivery-say', { hasText: 'No driver has your order yet' }).waitFor({ timeout: 10_000 });
      expect(rec.apiCalls.filter((c) => c.method === 'POST')).toHaveLength(posts);
      expect(rec.apiCalls.at(-1)).toEqual({ method: 'GET', path: `/v1/storefront/orders/${orderId}`, auth: true });

      // The store confirms, packs and dispatches it; the driver sets off.
      await staff(`/v1/orders/${orderId}/transition`, OWNER, { event: 'confirm' });
      await staff(`/v1/fulfilment/orders/${orderId}/pack`, 'u-mgr', { lines: [{ productId: 'MILK', pickedMinor: 1 }], crateAssignment: { MILK: 'c1' } });
      await staff(`/v1/fulfilment/orders/${orderId}/dispatch`, 'u-mgr', { manifestId: `m-${orderId}`, locationId: 'L1', seals: { c1: 's1' } });
      await staff(`/v1/delivery/orders/${orderId}/transition`, OWNER, { event: 'depart' });
      await page.click('#track-order');
      await page.locator('#delivery-say[data-status="out_for_delivery"]', { hasText: 'Your order is on its way.' }).waitFor({ timeout: 10_000 });
      const steps = async () => ((await current!.request({ method: 'GET', path: `/v1/delivery/orders/${orderId}`, userId: OWNER, tenantId: T })).body as { history: { at: string }[] }).history;
      expect(await page.getAttribute('#delivery-say', 'data-as-of')).toBe((await steps()).at(-1)!.at);
      expect(await page.textContent('#delivery-say')).toContain('(as of ');

      // The door: the driver could not deliver. The customer's screen says so, with the time the driver said it.
      await staff(`/v1/delivery/orders/${orderId}/transition`, OWNER, { event: 'arrive' });
      await staff(`/v1/delivery/orders/${orderId}/transition`, OWNER, { event: 'fail' });
      const failedAt = (await steps()).at(-1)!.at;

      // Head office restarts: a second instance over the same records answers the next tap.
      current = make(provider);
      await page.click('#track-order');
      await page.locator('#delivery-say[data-status="failed"]', { hasText: 'The driver could not deliver your order.' }).waitFor({ timeout: 10_000 });
      expect(await page.getAttribute('#delivery-say', 'data-as-of')).toBe(failedAt);
      expect(await page.getAttribute('#delivery-say', 'class')).toContain('stop');

      // Tamil follows the one toggle — the driver's status and the button in the reader's language.
      await page.click('#lang');
      expect(await page.textContent('#track-order')).toBe('என் ஆர்டர் எங்கே?');
      expect(await page.textContent('#delivery-say')).toContain('ஓட்டுநரால் உங்கள் ஆர்டரை டெலிவரி செய்ய முடியவில்லை.');
      await page.click('#lang');

      // No signal: the screen says it could not ask — it never passes the last answer off as current.
      await context.setOffline(true);
      await page.click('#track-order');
      await page.locator('#delivery-say', { hasText: 'Could not reach the shop to ask' }).waitFor({ timeout: 10_000 });
      await context.setOffline(false);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await store.stop();
      T = savedT;
      await pool?.end();
    }
  }, 90_000);
});
