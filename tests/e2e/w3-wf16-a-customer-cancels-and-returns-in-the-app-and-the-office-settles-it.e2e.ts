import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { startCustomerShopOnCloud, inviteAppCustomer, type CloudCustomerShop } from './lib/customer-shop-on-cloud';
import { seedOnlineCatalogue, listShopOnline, type ShopCalls, type Res } from '../support/online-shop';
import type { RealCloud } from '../support/real-store';
import { actionDetails } from '../../services/identity/src/approval-requests';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import { shiftDate } from '../../packages/calendar/src/trading-day';

/**
 * **W3 · WF-16 (customer cancels / raises a return) · M18-FR-04 · D05-FR-03 — ONE connected run: the customer app and the
 * office pages in real browsers, on the PRODUCTION API over real PostgreSQL.**
 *
 *   1. The office keeps BROOM back for shoppers in the store (the online buffer, set on the Online orders desk). The customer
 *      orders two in the app; head office can hold only one, so nothing is charged and the app asks; the customer CANCELS in
 *      the app. The desk then reads that order cancelled with no stock held — the hold was given back in the same step.
 *   2. The customer orders MILK and pays. No live payment provider is connected (EX-03), so the payment waits for the bank;
 *      the desk settles it from the statement line, then moves the order step by step to delivered.
 *   3. The customer RAISES A RETURN in the app. The office's Online store page receives it: books the collection, marks it
 *      collected, counts it in, decides where the stock goes (back to sellable — the shelf gains it), and refunds what came
 *      back to the order's own payment token after a second person approves exactly that refund. With no live provider the
 *      refund WAITS for the bank (never shown as done) until the statement line is recorded on the Order refunds worklist.
 *      The app shows each step.
 *
 * The return windows are SYNTHETIC DEMO SETTINGS laid down by this test only (the owner has not given his, OB-213/OB-227);
 * the product's own defaults are untouched. Synthetic data only. Needs DATABASE_URL and Chromium; else it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['w3', 'wf16', 'connected', 'key'].join('-').padEnd(48, '0');
const PHONE = '+919000000316';
const SUBJECT = 'cust-phone-wf16';
const PAY_REF = 'tok_w3_wf16';
const STORE_AT = { lat: 11.0168, lon: 76.9558 };
const NEARBY = { latitude: 11.02, longitude: 76.96 };
interface Doc { getElementById(id: string): { hidden: boolean } | null }

const callsOn = (cloud: () => RealCloud): ShopCalls => {
  const req = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, userId = OWNER, query?: Record<string, string>): Promise<Res> =>
    cloud().request({ method, path: query === undefined ? path : `${path}?${new URLSearchParams(query).toString()}`, userId, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
  const okc = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r; };
  return { req, ok: okc };
};

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('WF-16: a customer cancels and returns in the app, and the office settles it — one connected run', () => {
  let browser: Browser;
  let shop: InboxShop;
  let app: CloudCustomerShop;
  const tomorrow = shiftDate(shopDateIn(new Date().toISOString()), 1);

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    execFileSync('node', ['scripts/build-app.mjs', 'customer-app'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/online-orders', html: 'online-orders.html', dataGlobal: 'onlineOrdersData' },
      alsoPages: [{ path: '/online-store', html: 'online-store.html', dataGlobal: 'onlineStoreData' }, { path: '/order-refunds', html: 'order-refunds.html', dataGlobal: 'orderRefundsData' }],
      seed: async (cloud) => {
        const c = callsOn(() => cloud);
        for (const f of ['customer_app', 'delivery', 'loyalty']) await c.ok(c.req('PUT', `/v1/platform/entitlements/${f}`, { enabled: true }), `feature ${f}`);
        await seedOnlineCatalogue(c, 'br-1');
        await listShopOnline(c);
        await c.ok(c.req('PUT', '/v1/serviceability/delivery-service', { storeLocation: STORE_AT, slotsPerDay: 6, windowOpen: '09:00', windowClose: '21:00', capacityPerSlot: 10, leadMinutes: 60 }), 'delivery service');
        // SYNTHETIC DEMO return windows for this test's shop only (OB-213 is the owner's to give; nothing else changes).
        // The app customer's login, the governed way (OB-76): invited by the store manager, approved by the owner.
        await inviteAppCustomer(cloud, { customerId: SUBJECT, displayName: 'Kavya Iyer', inviter: MGR, inviterBranch: 'br-1', approver: OWNER });
        await c.ok(c.req('POST', '/v1/online-returns/policy', { windowDaysByCategory: { dairy: 2, household: 7 }, nonReturnable: [], reason: 'synthetic demo windows for this test only' }), 'return windows (synthetic)');
      },
    });
    const c = callsOn(() => shop.cloud());
    const pack = (await c.ok(c.req('GET', '/v1/catalogue/pack'), 'pack')).body as { snapshot: { version: number; products: { productId: string; name: string; unitPriceMinor: number; baseUom: string }[] } };
    const slot = ((await c.ok(c.req('GET', '/v1/serviceability/delivery-service', undefined, OWNER, { day: tomorrow }), 'slots')).body as { slots: { startsAt: string; endsAt: string }[] }).slots[0]!;
    app = await startCustomerShopOnCloud({
      cloud: () => shop.cloud(), subject: SUBJECT,
      shopData: async () => ({
        tenantId: shop.cloud().tenantId, customerRef: 'guest', packVersion: pack.snapshot.version, locationId: 'br-1',
        products: pack.snapshot.products.map((p) => ({ productId: p.productId, name: p.name, categoryId: 'x', unitPriceMinor: p.unitPriceMinor, uom: p.baseUom, barcodes: [], status: 'active', availableMinor: 5, availabilityAgeMinutes: 1 })),
        slots: [{ slotId: 'tomorrow', startsAt: slot.startsAt, endsAt: slot.endsAt, capacity: 10, booked: 0, kind: 'delivery' }],
        storeLocation: STORE_AT, policy: { radiusMetres: 10_000, deliveryFeeMinor: 40_00 }, deliveryFeeMinor: 40_00,
      }),
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await app?.stop(); await shop?.stop(); });

  const myOrders = async (): Promise<{ orderId: string; state: string }[]> =>
    ((await shop.cloud().request({ method: 'GET', path: '/v1/storefront/orders', userId: SUBJECT })).body as { orders: { orderId: string; state: string }[] }).orders;

  /** The customer, in the app: basket → check → slot → location → sign in by one-time code → pay. */
  async function checkout(page: Page, product: string, times: number): Promise<void> {
    await page.goto(`${app.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as { document: Doc }).document.getElementById('sample')?.hidden === true, undefined, { timeout: 10_000 });
    await page.fill('#search', product.split(' ').at(-1)!.toLowerCase());
    for (let i = 0; i < times; i += 1) await page.click(`button[aria-label="Add ${product}"]`);
    await page.click('#tab-basket');
    await page.click('#review');
    await page.click('#banner-ok');
    await page.locator('#slots .row button').first().click();
    await page.click('#banner-ok');
    await page.click('#locate');
    await page.locator('#banner-title', { hasText: 'Use my location' }).waitFor({ timeout: 10_000 });
    await page.click('#banner-ok');
    if (await page.isVisible('#si-phone')) {
      await page.fill('#si-phone', PHONE);
      await page.click('#si-send');
      await page.waitForSelector('#si-step-code:not([hidden])', { timeout: 10_000 });
      await page.fill('#si-code', app.sms.codeFor(PHONE) ?? '');
      await page.click('#si-verify');
      await page.waitForSelector('#si-step-in:not([hidden])', { timeout: 15_000 });
    }
    await page.click('#pay');
  }

  async function customerContext(): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
    const ctx = await browser.newContext({ geolocation: NEARBY, permissions: ['geolocation'] });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript((ref) => { (globalThis as unknown as { shopPaymentRef?: string }).shopPaymentRef = ref; }, PAY_REF);
    return { ctx, page, errors };
  }

  it('the app cancels a short order and the desk sees its stock given back; a paid order is settled, delivered, returned in the app, received, restocked and refunded to its token', async () => {
    const office = await browser.newContext();
    await shop.signIn(office, MGR, 'br-1');
    const desk = await office.newPage();
    const officeErrors: string[] = [];
    desk.on('pageerror', (e) => officeErrors.push(String(e)));
    try {
      // ── 1. The desk keeps nine of the ten brooms back for the shop floor (D05-FR-03) ──
      await desk.goto(`${shop.base}/online-orders`, { waitUntil: 'load' });
      await desk.fill('#buf-store', 'br-1');
      await desk.fill('#buf-product', 'BROOM');
      await desk.fill('#buf-units', '9');
      await desk.fill('#buf-reason', 'Brooms sell on the floor at Deepavali (synthetic)');
      await desk.click('#set-buffer');
      await desk.locator('#buf-status', { hasText: '✓ Buffer saved: BROOM — 9' }).waitFor({ timeout: 15_000 });

      // The customer orders two brooms: head office holds one, charges nothing and asks; the customer cancels in the app.
      const first = await customerContext();
      try {
        await checkout(first.page, 'Synthetic Broom', 2);
        await first.page.locator('#cancel-order:not([hidden])').waitFor({ timeout: 15_000 });
        expect(await first.page.textContent('#banner-title')).toBe('Not everything is in stock');
        expect(await first.page.textContent('#banner-text')).toMatch(/^Synthetic Broom: you asked for 2, the shop can send 1\./);
        const short = (await myOrders())[0]!;
        expect(short.state).toBe('placed');
        const before = (await shop.cloud().request({ method: 'GET', path: '/v1/orders/reservations?locationId=br-1', userId: MGR, branchId: 'br-1' })).body as { outstanding: { orderId: string; quantityMinor: number }[] };
        expect(before.outstanding.filter((r) => r.orderId === short.orderId).map((r) => r.quantityMinor)).toEqual([1]);
        await first.page.click('#cancel-order');
        await first.page.locator('#cancel-order[hidden]').waitFor({ state: 'attached', timeout: 15_000 });
        expect((await myOrders()).find((o) => o.orderId === short.orderId)?.state).toBe('cancelled');
        expect(first.errors).toEqual([]);

        // The office receives it: the desk reads the order cancelled, nothing held, no step left.
        await desk.fill('#order-id', short.orderId);
        await desk.click('#show-order');
        const row = desk.locator(`#order li[data-order="${short.orderId}"][data-state="cancelled"]`);
        await row.waitFor({ timeout: 15_000 });
        expect(await row.locator('.held').textContent()).toBe('No stock is held for it.');
        expect(await row.locator('.lines').textContent()).toBe('Ordered: 2 × BROOM');
        expect(await row.locator('.steps').textContent()).toBe('This order is finished — no step is left.');
      } finally { await first.ctx.close(); }

      // ── 2. The customer orders MILK and pays; the bank's answer waits; the desk settles it and delivers ──
      const second = await customerContext();
      try {
        await checkout(second.page, 'Synthetic Milk 1L', 1);
        await second.page.locator('#check-payment:not([hidden])').waitFor({ timeout: 15_000 });
        const milk = (await myOrders()).find((o) => o.state !== 'cancelled')!;
        await desk.click('#show-pay');
        const waiting = desk.locator(`#pay li[data-payment="${milk.orderId}"]`);
        await waiting.waitFor({ timeout: 15_000 });
        expect(await waiting.locator('strong').textContent()).toBe(`⏱ Waiting for the bank — ${milk.orderId} · ₹100.00`);
        await waiting.locator('input.statement').fill('STMT-WF16-0001');
        await waiting.locator('button.settle-authorised').click();
        await desk.locator('#pay-status', { hasText: `✓ Recorded from the statement: ${milk.orderId} — paid` }).waitFor({ timeout: 15_000 });
        await desk.fill('#order-id', milk.orderId);
        await desk.click('#show-order');
        for (const [ev, to] of [['confirm', 'confirmed'], ['pick', 'picking'], ['pack', 'packed'], ['dispatch', 'dispatched'], ['deliver', 'delivered']] as const) {
          await desk.locator(`#order button.step-${ev}`).click();
          await desk.locator(`#order li[data-order="${milk.orderId}"][data-state="${to}"]`).waitFor({ timeout: 15_000 });
        }

        // ── 3. The customer raises a return in the app ──
        await second.page.click('#tab-order');
        await second.page.waitForSelector('#return-policy-say:has-text("dairy")', { timeout: 15_000 });
        await second.page.fill('#return-lines input[data-product-id="MILK"]', '1');
        await second.page.fill('#return-reason', 'it was sour (synthetic)');
        await second.page.click('#return-send');
        await second.page.locator('#help-say', { hasText: 'r-' }).waitFor({ timeout: 15_000 });
        await second.page.locator('#my-returns .row[data-stage="requested"]').waitFor({ timeout: 15_000 });
        const returnId = (await second.page.locator('#my-returns .row').first().getAttribute('data-return-id'))!;

        // The office receives it on the Online store page: book, collected, counted in, back to sellable, refunded.
        const before = ((await shop.cloud().request({ method: 'GET', path: '/v1/inventory/online-availability?locationId=br-1', userId: MGR, branchId: 'br-1' })).body as { rows: { productId: string; onHandMinor: number }[] }).rows.find((r) => r.productId === 'MILK')!.onHandMinor;
        const store = await office.newPage();
        store.on('pageerror', (e) => officeErrors.push(String(e)));
        await store.goto(`${shop.base}/online-store`, { waitUntil: 'load' });
        const ret = (stage: string) => store.locator(`#returns .row[data-return="${returnId}"][data-stage="${stage}"]`);
        await ret('requested').waitFor({ timeout: 15_000 });
        await ret('requested').locator('input.collect-on').fill(tomorrow);
        await ret('requested').locator('button.book').click();
        await ret('collection_scheduled').waitFor({ timeout: 15_000 });
        await ret('collection_scheduled').locator('button.collected').click();
        await ret('collected').waitFor({ timeout: 15_000 });
        expect(await ret('collected').locator('input.count').inputValue()).toBe('1');
        await ret('collected').locator('button.receive').click();
        await ret('received').waitFor({ timeout: 15_000 });
        await ret('received').locator('select.disposition').selectOption('sellable');
        await ret('received').locator('button.dispose').click();
        await store.locator(`#returns .row[data-return="${returnId}"] .facts`, { hasText: 'MILK: 1 → 1 (Back to sellable)' }).waitFor({ timeout: 15_000 });
        const after = ((await shop.cloud().request({ method: 'GET', path: '/v1/inventory/online-availability?locationId=br-1', userId: MGR, branchId: 'br-1' })).body as { rows: { productId: string; onHandMinor: number }[] }).rows.find((r) => r.productId === 'MILK')!.onHandMinor;
        expect(after - before, 'the returned milk is back on the shelf').toBe(1);

        // A refund with no second person is refused by head office; nothing moves.
        await ret('received').locator('input.refund-id').fill('rf-wf16-1');
        await ret('received').locator('button.refund').click();
        await store.locator('#result', { hasText: 'Not recorded' }).waitFor({ timeout: 15_000 });
        // The manager asks for exactly this refund; the owner approves it in his own session; the manager issues it.
        const asked = await shop.cloud().request({ method: 'POST', path: '/v1/approvals/requests', userId: MGR, branchId: 'br-1', idempotencyKey: `ask-${randomUUID()}`, body: {
          kind: 'order_refund', subjectRef: `${milk.orderId}/rf-wf16-1`, details: actionDetails({ refundId: 'rf-wf16-1' }, { returnId }), valueMinor: 60_00,
          summary: `Refund the returned milk on ${milk.orderId}`, reason: 'it came back sour (synthetic)',
        } });
        expect(asked.status, JSON.stringify(asked.body)).toBe(201);
        const requestId = (asked.body as { requestId: string }).requestId;
        await ok(shop.cloud().request({ method: 'POST', path: `/v1/approvals/requests/${requestId}/decide`, userId: OWNER, idempotencyKey: `decide-${requestId}`, body: { decision: 'approved', reason: 'checked the return (synthetic)' } }), 'owner approves');
        await store.reload({ waitUntil: 'load' });
        await ret('received').locator('input.refund-id').fill('rf-wf16-1');
        await ret('received').locator('input.approval-id').fill(requestId);
        await ret('received').locator('button.refund').click();
        // No live payment provider is connected (EX-03): the refund goes to the order's token and WAITS for the bank —
        // never shown as done (M18-FR-04 "no fake refund").
        await ret('refund_waiting').waitFor({ timeout: 15_000 });
        expect(await store.textContent('#result')).toBe('Recorded');
        expect(await ret('refund_waiting').locator('.state').textContent()).toBe('Refund waiting for the bank');

        // The bank's statement says it was refunded: recorded on the Order refunds worklist, with the statement line.
        const refunds = await office.newPage();
        refunds.on('pageerror', (e) => officeErrors.push(String(e)));
        await refunds.goto(`${shop.base}/order-refunds`, { waitUntil: 'load' });
        await refunds.click('#show-pending');
        const owed = refunds.locator(`#pending li[data-order="${milk.orderId}"]`);
        await owed.waitFor({ timeout: 15_000 });
        expect(await owed.locator('strong').textContent()).toBe(`Waiting Refund not confirmed by the bank — ${milk.orderId} · ₹60.00`) // U5: the chrome's "Waiting" chip, then the words;
        await owed.locator('input.statement').fill('STMT-WF16-0002');
        await owed.locator('button.outcome-refunded').click();
        await refunds.locator('#pending li', { hasText: 'Nothing is waiting on the bank.' }).waitFor({ timeout: 15_000 });
        await store.reload({ waitUntil: 'load' });
        await ret('refunded').waitFor({ timeout: 15_000 });

        // Head office refunded to the order's own token, after the second person; the app shows every step.
        const money = (await shop.cloud().request({ method: 'GET', path: `/v1/orders/${milk.orderId}/refunds`, userId: MGR, branchId: 'br-1' })).body as { payment: { state: string; providerRef?: string }; position: { refundedMinor: number; refunds: { refundId: string; basis: string; approvedBy?: string }[] } };
        expect(money.position.refundedMinor).toBe(60_00);
        expect(money.position.refunds.map((r) => [r.refundId, r.basis, r.approvedBy])).toEqual([['rf-wf16-1', 'return', OWNER]]);
        await second.page.click('#tab-shop');
        await second.page.click('#tab-order');
        const mine = second.page.locator(`#my-returns .row[data-return-id="${returnId}"][data-stage="refunded"]`);
        await mine.waitFor({ timeout: 15_000 });
        expect(await mine.locator('.step').allTextContents()).toEqual([
          'Return asked for: 1 × MILK', `Collection booked for ${tomorrow}`, 'Collected from you', 'Received back at the shop: 1 × MILK', 'Refunded ₹60.00 to the way you paid',
        ]);
        expect(second.errors).toEqual([]);
      } finally { await second.ctx.close(); }
      expect(officeErrors).toEqual([]);
    } finally { await office.close(); }
  }, 300_000);
});
