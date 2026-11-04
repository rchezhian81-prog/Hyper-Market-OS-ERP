import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import { CHROMIUM, CONNECTED, OWNER, ok, startBoxPageOnCloud, type BoxCloudShop } from './lib/box-page-on-cloud';
import { says } from './lib/r4c-box-page';
import { startCustomerShopOnCloud, inviteAppCustomer, type CloudCustomerShop } from './lib/customer-shop-on-cloud';
import { setUpPracticeStores } from '../support/real-store';
import { onlineReady, sellOnline } from '../support/sell-online';
import { signInOnPhonePage } from '../support/phone-sign-in-page';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **W6 · OB-687 (owner, 4 Nov 2026: "a substitute that needs the customer's yes is answered by the customer in the app") ·
 * FUL-14 · M19-FR-02 — ONE connected run: the REAL picker phone page (enrolled on a real store computer's device socket),
 * the REAL customer app, the Online orders page served by the same store computer, and head office the PRODUCTION API on
 * real PostgreSQL.** Synthetic data only; the customer's sign-in goes through the product's own one-time-code service with the
 * recording stub SMS port (nothing is sent anywhere); the phones never talk to head office themselves (P-01).
 *
 *   • YES — the owner sets how long the picker waits on the Online orders page (it read "NOT SET" first). The picker finds no
 *     milk on a line whose customer asked to be asked first, scans the organic milk and says why; the phone says it asked
 *     and waits. The store computer carries the proposal to head office. In the app the customer sees the swap — the
 *     product, its price and why — and taps yes. The phone reads the yes back through the store computer, says so, and the
 *     crate is packed with the swap; head office holds it on the ORDER through the substitution path (charged at the original
 *     price) and the order's pack carries the organic milk.
 *   • NO / TIMEOUT — the owner shortens the wait to one minute. Two lines are put to the customer; she rings the shop and a
 *     store manager records her NO on the Online orders page, naming the call; the other gets no answer in time. The phone
 *     packs both short, by the answer and by the owner's clock; head office records one DECLINED and one NO ANSWER on the
 *     orders, charged nothing, and the app has nothing left for her to answer.
 * Needs DATABASE_URL and Chromium; else it SKIPS.
 */

const STORE = 'br-1';
const BOX = 'u-box';
const PICKER = 'u-picker';
/** The second wave goes to a second picker, so each phone is handed its own wave (DF-3-c). */
const PICKER_2 = 'u-picker-2';
const MGR = 'u-mgr';
const PHONE = '+919000000687';
const SUBJECT = 'cust-w6-swap';
const STORE_AT = { lat: 11.0168, lon: 76.9558 };
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: STORE };
type Doc = { document: { getElementById(id: string): { hidden: boolean } | null } };
interface PhoneWindow { pickSession?: { work(): { lineId: string; state: string }[] }; location: { pathname: string } }

describe.skipIf(!CONNECTED)('W6 · OB-687 connected: the picker proposes a swap, the customer answers it in the app, the crate is what was agreed — on PostgreSQL', () => {
  let shop: BoxCloudShop;
  let app: CloudCustomerShop;
  let browser: Browser;
  const codes: Record<string, string> = {};

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'picker-app'], { stdio: 'ignore' });
    execFileSync('node', ['scripts/build-app.mjs', 'customer-app'], { stdio: 'ignore' });
    shop = await startBoxPageOnCloud({
      name: 'w6-swaps', store: STORE,
      people: [{ userId: OWNER }, { userId: MGR, branchId: STORE }],
      link: { boxUser: BOX, storePackFromHeadOffice: true },
      phones: { pins: [PICKER, PICKER_2] },
      seed: async (cloud) => {
        const req = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, userId = OWNER) => cloud.request({ method, path, userId, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
        await setUpPracticeStores(cloud, OWNER, [STORE]);
        await ok(req('POST', `/v1/stores/${STORE}/settings`, SETTINGS), 'store settings');
        for (const f of ['customer_app', 'delivery']) await ok(req('PUT', `/v1/platform/entitlements/${f}`, { enabled: true }), `feature ${f}`);
        await cloud.grant(BOX, 'store_computer', undefined, [STORE]);
        for (const who of [PICKER, PICKER_2]) await cloud.grant(who, 'store_manager', undefined, [STORE]);
        await cloud.grant(MGR, 'store_manager', undefined, [STORE]);
        const today = shopDateIn(new Date().toISOString());
        await ok(req('POST', '/v1/catalogue/tax-classes/0401/rates/2017-07-01', { rateBps: 0 }), 'tax');
        for (const [productId, name, priceMinor, brand] of [['MILK', 'Aavin Milk 1L', 60_00, 'aavin'], ['MILK-ORG', 'Organic Milk 1L', 75_00, 'arokya']] as const) {
          await ok(req('POST', `/v1/catalogue/products/${productId}/publish`, {
            product: { sku: `${productId}-SKU`, name, baseUom: 'each', primaryCategoryId: 'dairy-test', taxClass: '0401', lifecycle: 'active', handling: 'ambient', brand, ...onlineReady(priceMinor) },
            categories: [{ categoryId: 'dairy-test', name: 'Dairy (test)', parentId: null }],
          }), `publish ${productId}`);
          await ok(req('POST', `/v1/prices/list/${productId}/entries/e1`, { scope: 'store', scopeRef: STORE, priceMinor, mrpMinor: priceMinor, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: today }), `price ${productId}`);
          await ok(req('POST', '/v1/inventory/movements', { movementId: `rcv-${productId}`, productId, locationId: STORE, kind: 'received', quantityMinor: 50, uom: 'each', unitCostMinor: 40_00, occurredAt: new Date().toISOString(), enteredBy: OWNER }), `receive ${productId}`);
        }
        await ok(req('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: today }), 'catalogue pack');
        await ok(req('POST', '/v1/serviceability/periods/2025-01-01', { radiusMetres: 10_000, deliveryFeeMinor: 0 }), 'no delivery fee');
        await sellOnline((path, body) => req('POST', path, body), ['MILK']);
        await inviteAppCustomer(cloud, { customerId: SUBJECT, displayName: 'Meena Raman (synthetic)', inviter: MGR, inviterBranch: STORE, approver: OWNER });
        // The customer's own standing rule, from her app: ask me first before any swap (FUL-14).
        await ok(req('PUT', '/v1/storefront/substitution-preferences', { rules: { preference: 'contact_me' } }, SUBJECT), 'her rule');
        for (const deviceId of ['hh-pick-1', 'hh-pick-2']) {
          await ok(req('POST', `/v1/platform/devices/${deviceId}/register`, { branchId: STORE, kind: 'handheld', label: `Picker phone ${deviceId}` }), `register ${deviceId}`);
          codes[deviceId] = String(((await ok(req('POST', `/v1/platform/devices/${deviceId}/enrolment`, {}), `enrol ${deviceId}`)) as { code: string }).code);
        }
      },
    });
    expect(['updated', 'renewed']).toContain((await shop.edge.refreshStorePack!()).status);
    const pack = (await ok(shop.call('GET', '/v1/catalogue/pack', OWNER), 'pack')) as { snapshot: { version: number; products: { productId: string; name: string; unitPriceMinor: number; baseUom: string }[] } };
    app = await startCustomerShopOnCloud({
      cloud: () => shop.cloud, subject: SUBJECT,
      shopData: async () => ({
        tenantId: shop.cloud.tenantId, customerRef: 'guest', packVersion: pack.snapshot.version, locationId: STORE,
        products: pack.snapshot.products.map((p) => ({ productId: p.productId, name: p.name, categoryId: 'x', unitPriceMinor: p.unitPriceMinor, uom: p.baseUom, barcodes: [], status: 'active', availableMinor: 5, availabilityAgeMinutes: 1 })),
        slots: [], storeLocation: STORE_AT, policy: { radiusMetres: 10_000, deliveryFeeMinor: 0 }, deliveryFeeMinor: 0, consentPurposes: [],
      }),
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await app?.stop(); await shop?.stop(); });

  const call = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, who = OWNER) => shop.call(method, path, who, body);
  const scan = async (page: Page, code: string) => { await page.keyboard.type(code); await page.keyboard.press('Enter'); };

  /** The customer orders milk for collection (as her app does); head office hands the wave to the picker; the box pulls it. */
  async function waveOf(waveId: string, orderIds: readonly string[], pickerId: string): Promise<void> {
    for (const orderId of orderIds) await ok(call('POST', `/v1/storefront/orders/${orderId}`, { lines: [{ productId: 'MILK', quantityMinor: orderIds.length === 1 ? 2 : 1 }], locationId: STORE, fulfilment: 'pickup' }, SUBJECT), `place ${orderId}`);
    await ok(call('POST', `/v1/fulfilment/waves/${waveId}/assignment`, {
      storeId: STORE, pickerId,
      lines: orderIds.map((o) => ({ lineId: `${o}:MILK`, orderRef: o, productId: 'MILK', description: 'Aavin Milk 1L', bin: 'C-01', requiredQty: orderIds.length === 1 ? 2 : 1, uom: 'each', unitPriceMinor: 60_00 })),
    }), `assign ${waveId}`);
    expect(['updated', 'unchanged']).toContain((await shop.edge.refreshAssignmentsFeed!()).status);
  }

  /** Enrol the phone with head office's one-time code; the picker signs in with their own PIN (DF-3-c). */
  async function pickerPhone(deviceId: string, pickerId: string) {
    const p = await shop.phone('/picker/');
    await p.page.waitForFunction(() => (globalThis as unknown as PhoneWindow).location.pathname === '/device/enrol', undefined, { timeout: 15_000 });
    await p.page.fill('#deviceId', deviceId);
    await p.page.fill('#code', codes[deviceId]!);
    await p.page.click('button[type="submit"]');
    await signInOnPhonePage(p.page, 'picker', pickerId);
    await p.page.waitForFunction(() => (globalThis as unknown as PhoneWindow).pickSession !== undefined, undefined, { timeout: 15_000 });
    return p;
  }

  /** On the phone: scan the bin, choose Substitute at the item, scan the swap, say why — the swap is put to the customer. */
  async function propose(page: Page, lineId: string, why: 'None on the shelf' | 'Cannot find it') {
    await scan(page, 'C-01');
    await page.locator('#scan-title', { hasText: 'Scan the item — Aavin Milk 1L' }).waitFor({ timeout: 15_000 });
    await page.click('#scan-substitute');
    await page.locator('#scan-title', { hasText: 'Scan the item you are swapping in' }).waitFor({ timeout: 15_000 });
    await scan(page, 'MILK-ORG');
    await page.locator('#sheet-title', { hasText: 'Why are you offering a swap?' }).waitFor({ timeout: 15_000 });
    await page.locator('#choices button', { hasText: why }).click();
    await page.locator('#banner-title', { hasText: 'Asked the customer' }).waitFor({ timeout: 15_000 });
    await page.click('#banner-ok');
    await page.waitForSelector(`#lines .line[data-line="${lineId}"][data-state="awaiting_customer"]`, { timeout: 15_000 });
    await page.waitForSelector(`#sent-work .sent[data-kind="proposal"][data-id="${lineId}"][data-state="handed_to_box"]`, { timeout: 15_000 });
  }

  /** The customer's app, signed in through the shop's own one-time code, on "My order". */
  async function customerApp(): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
    const page = await ctx.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${app.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as Doc).document.getElementById('sample')?.hidden === true, undefined, { timeout: 10_000 });
    await page.click('#tab-basket');
    await page.fill('#si-phone', PHONE);
    await page.click('#si-send');
    await page.waitForSelector('#si-step-code:not([hidden])');
    const code = app.sms.codeFor(PHONE);
    expect(code, 'the stub SMS port recorded a one-time code').toMatch(/^\d{4,8}$/);
    await page.fill('#si-code', code!);
    await page.click('#si-verify');
    await page.waitForSelector('#si-step-in:not([hidden])');
    await page.click('#tab-order');
    return { ctx, page, errors };
  }

  async function packAndSend(page: Page, seal: string, waveId: string) {
    await page.locator('#step', { hasText: 'Every line is resolved' }).waitFor({ timeout: 15_000 });
    await page.click('#pack');
    await page.locator('#sheet-title', { hasText: 'Cold-chain temperature in °C' }).waitFor({ timeout: 15_000 });
    await page.click('#sheet-ok');
    await page.locator('#scan-title', { hasText: 'Scan the tamper seal' }).waitFor({ timeout: 15_000 });
    await scan(page, seal);
    await page.locator('#banner-title', { hasText: 'Crate packed' }).waitFor({ timeout: 15_000 });
    await page.click('#banner-ok');
    await page.waitForSelector(`#sent-work .sent[data-kind="pack"][data-id="${waveId}"][data-state="handed_to_box"]`, { timeout: 15_000 });
    const pass = await shop.edge.syncOnce!();
    expect(pass.dead, JSON.stringify(pass)).toBe(0);
  }

  it('YES: the owner sets the wait; the picker proposes; the customer says yes in the app; the crate and the order carry the swap', async () => {
    // The owner, on the Online orders page the store computer serves: the wait is HIS number — "NOT SET" until he sets it.
    const o = await shop.open(OWNER, '/online-orders');
    try {
      expect(o.writes).toEqual([]);
      await o.page.click('#cd-wait-go');
      await says(o.page, '#cd-wait-now', /^NOT SET by the owner — the picker does not wait/);
      await o.page.fill('#cd-wait-minutes', '15');
      await o.page.fill('#cd-wait-reason', 'synthetic test wait');
      await o.page.click('#cd-wait-form-go');
      await says(o.page, '#cd-wait-set-status', /^Saved\. The picker phones get it with their next wave\.$/);
      await says(o.page, '#cd-wait-now', /^The picker waits 15 minute\(s\) · set by u-owner/);
      await o.page.click('#lang');
      await says(o.page, '#desk-swap-wait-h', /^வாடிக்கையாளருக்காக எடுப்பவர் எவ்வளவு நேரம் காத்திருப்பார்$/);
      expect(o.writes).toEqual(['POST /v1/fulfilment/substitution-wait']);
      expect(o.errors).toEqual([]);
    } finally { await o.close(); }

    await waveOf('W-Y', ['ORD-Y'], PICKER);
    const p = await pickerPhone('hh-pick-1', PICKER);
    try {
      await propose(p.page, 'ORD-Y:MILK', 'None on the shelf');
      expect(await p.page.locator('#lines .line[data-line="ORD-Y:MILK"] .waiting-customer').innerText()).toMatch(/^Waiting for the customer until \d{2}:\d{2} · MILK-ORG$/);
      // The store computer carries the proposal to head office.
      const pass = await shop.edge.syncOnce!();
      expect(pass.dead, JSON.stringify(pass)).toBe(0);
      const held = (await ok(call('GET', '/v1/orders/ORD-Y/substitution-proposals'), 'proposals')) as { proposals: Record<string, unknown>[] };
      expect(held.proposals).toEqual([expect.objectContaining({ lineId: 'ORD-Y:MILK', substituteName: 'Organic Milk 1L', substituteUnitPriceMinor: 75_00, state: 'waiting', why: 'out_of_stock' })]);

      // The customer, in her app: the product offered, its price and why — and she taps yes.
      const c = await customerApp();
      try {
        const row = c.page.locator('#swaps .row.swap[data-order="ORD-Y"][data-line="ORD-Y:MILK"]');
        await row.waitFor({ timeout: 15_000 });
        expect(await row.locator('.name').innerText()).toBe('We could not supply Aavin Milk 1L. We can send Organic Milk 1L instead, at ₹75.00 each.');
        expect(await row.locator('.why').innerText()).toBe('We have none left on the shelf.');
        await row.locator('.swap-yes').click();
        await says(c.page, '#swaps-say', /^Thank you — we will send Organic Milk 1L\.$/);
        expect(app.writes.filter((w) => w.path.includes('/substitutions/'))).toEqual([{ method: 'POST', path: '/v1/storefront/orders/ORD-Y/substitutions/ORD-Y%3AMILK' }]);
        await c.page.click('#lang');
        await says(c.page, '#swaps-title', /^உங்கள் பதிலுக்குக் காத்திருக்கும் மாற்றங்கள்$/);
        expect(c.errors).toEqual([]);
      } finally { await c.ctx.close(); }

      // The phone reads the yes back through the store computer (its own ten-second beat) and says what to put in the crate.
      await p.page.locator('#banner-title', { hasText: 'The customer said yes' }).waitFor({ timeout: 45_000 });
      expect(await p.page.textContent('#banner-text')).toBe('Put Organic Milk 1L in the crate in place of Aavin Milk 1L.');
      await p.page.click('#banner-ok');
      await p.page.waitForSelector('#lines .line[data-line="ORD-Y:MILK"][data-state="substituted"]', { timeout: 15_000 });
      await packAndSend(p.page, 'SEAL-W6-Y', 'W-Y');
      expect(p.errors).toEqual([]);
    } finally { await p.close(); }

    // Head office, on PostgreSQL: the swap is on the ORDER through the substitution path, at the original price; the pack carries it.
    await expect.poll(async () => ((await call('GET', '/v1/orders/ORD-Y/substitution-proposals')).body as { proposals: { settled?: unknown }[] }).proposals[0]?.settled, { timeout: 15_000 })
      .toEqual({ packed: 'swapped', decision: 'confirmed', onOrder: true, onOrderAs: { outcome: 'substituted', pickProductId: 'MILK-ORG', pickQuantityMinor: 2, chargeMinor: 120_00, refundMinor: 0 }, refusal: null });
    const pack = (await ok(call('GET', '/v1/fulfilment/orders/ORD-Y/pack'), 'pack')) as { lines: { productId: string; packedMinor: number }[] };
    expect(pack.lines.map((l) => [l.productId, l.packedMinor])).toEqual([['MILK-ORG', 2]]);
  }, 300_000);

  it('NO / TIMEOUT: a no told to staff by phone and a swap nobody answers in the owner\'s minute — both packed short, declined and no answer on the orders', async () => {
    const o = await shop.open(OWNER, '/online-orders');
    try {
      await o.page.fill('#cd-wait-minutes', '1');
      await o.page.click('#cd-wait-form-go');
      await says(o.page, '#cd-wait-now', /^The picker waits 1 minute\(s\)/);
    } finally { await o.close(); }

    await waveOf('W-N', ['ORD-N1', 'ORD-N2'], PICKER_2);
    const p = await pickerPhone('hh-pick-2', PICKER_2);
    try {
      await propose(p.page, 'ORD-N1:MILK', 'Cannot find it');
      await propose(p.page, 'ORD-N2:MILK', 'None on the shelf');
      const pass = await shop.edge.syncOnce!();
      expect(pass.dead, JSON.stringify(pass)).toBe(0);

      // She rings the shop: a store manager records her NO on the Online orders page, naming the call. He cannot set the wait.
      const m = await shop.open(MGR, '/online-orders');
      try {
        expect(await m.page.locator('#cd-wait-form').count(), 'the wait is the owner\'s number').toBe(0);
        await m.page.fill('#cd-swap-order', 'ORD-N1');
        await m.page.click('#cd-swap-form-go');
        await says(m.page, '#cd-swap-list li[data-line="ORD-N1:MILK"]', /^Organic Milk 1L for Aavin Milk 1L · ₹75\.00 each — waiting for the customer · answer by /);
        await m.page.selectOption('#cd-swap-line', 'ORD-N1:MILK');
        await m.page.selectOption('#cd-swap-decision', 'declined');
        await m.page.selectOption('#cd-swap-method', 'phone');
        await m.page.fill('#cd-swap-ref', 'CALL-0687');
        await m.page.click('#cd-swap-answer-go');
        await says(m.page, '#cd-swap-answer-status', /^Recorded\. The picker will be told through the store computer\.$/);
        await says(m.page, '#cd-swap-list li[data-line="ORD-N1:MILK"]', /the customer said NO \(told to staff: phone CALL-0687\)/);
        expect(m.writes).toEqual(['POST /v1/orders/ORD-N1/substitution-proposals/ORD-N1%3AMILK/answer']);
        expect(m.errors).toEqual([]);
      } finally { await m.close(); }

      // The phone: the NO comes back and that line goes short; the other goes short when the owner's minute runs out.
      await p.page.waitForSelector('#lines .line[data-line="ORD-N1:MILK"][data-state="short"]', { timeout: 45_000 });
      await p.page.waitForSelector('#lines .line[data-line="ORD-N2:MILK"][data-state="short"]', { timeout: 120_000 });
      expect(await p.page.textContent('#banner-title')).toMatch(/^(No answer from the customer in time|Answers from customers)$/);
      await p.page.click('#banner-ok');
      await packAndSend(p.page, 'SEAL-W6-N', 'W-N');
      expect(p.errors).toEqual([]);
    } finally { await p.close(); }

    // Head office: one declined (her no), one no answer — each short on the order, charged nothing.
    const settledOf = async (orderId: string) => ((await call('GET', `/v1/orders/${orderId}/substitution-proposals`)).body as { proposals: { state: string; settled?: { decision: string; onOrder: boolean; onOrderAs?: { chargeMinor: number } } }[] }).proposals[0];
    await expect.poll(async () => (await settledOf('ORD-N1'))?.settled?.decision, { timeout: 15_000 }).toBe('declined');
    expect(await settledOf('ORD-N1')).toMatchObject({ state: 'no', settled: { onOrder: true, onOrderAs: { chargeMinor: 0 } } });
    await expect.poll(async () => (await settledOf('ORD-N2'))?.settled?.decision, { timeout: 15_000 }).toBe('no_answer');
    expect(await settledOf('ORD-N2')).toMatchObject({ state: 'too_late', settled: { onOrder: true, onOrderAs: { chargeMinor: 0 } } });

    // Her app: nothing is left for her to answer, and a late tap would be refused by head office (answer_too_late).
    const c = await customerApp();
    try {
      await says(c.page, '#swaps-say', /^Nothing is waiting for your answer\.$/);
      expect(await c.page.locator('#swaps .row.swap').count()).toBe(0);
      expect(c.errors).toEqual([]);
    } finally { await c.ctx.close(); }
    const late = await call('POST', '/v1/storefront/orders/ORD-N2/substitutions/ORD-N2:MILK', { substituteProductId: 'MILK-ORG', decision: 'confirmed' }, SUBJECT);
    expect((late.body as { error?: { code?: string } }).error?.code).toBe('answer_too_late');
  }, 300_000);
});
