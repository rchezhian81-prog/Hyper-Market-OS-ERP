import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { startCustomerShopOnCloud, inviteAppCustomer, type CloudCustomerShop } from './lib/customer-shop-on-cloud';
import { seedOnlineCatalogue, listShopOnline, type ShopCalls, type Res } from '../support/online-shop';
import { sellOnline } from '../support/sell-online';
import type { RealCloud } from '../support/real-store';
import { AI_SUGGESTION_NOTICE } from '../../services/ai/src/control';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import { shiftDate } from '../../packages/calendar/src/trading-day';

/**
 * **W4 · A04 Customer Shopping agent (§7 "search, list-to-cart, alternatives and guided shopping" · OB-674 · AI-NFR-11 · M20
 * "the customer always confirms the cart" · hard rule #5) — ONE connected run: the customer app in a real browser, on the
 * PRODUCTION API over real PostgreSQL.** OB-674 (owner, 2 Nov 2026, in writing): the app's own search and saved lists are
 * A04's search and list-to-cart legs; AI-chat guided shopping is DEFERRED to R8 (OB-382) and is not built here.
 *   • SEARCH: the customer searches "milk" and finds both milks — nothing on the shop page is marked as AI, and the AI notice
 *     is not shown (nobody asked for a suggestion);
 *   • LIST-TO-CART: she signs in by one-time code, saves her basket as "Weekly" (kept on PostgreSQL), empties the basket, and
 *     puts the list back on her own tap;
 *   • ALTERNATIVES: only when she presses "Show ideas" does the app show A04's in-stock alternative for the milk that ran out
 *     — marked ✦ with the plain "Suggested by AI" notice — and asking wrote nothing anywhere; she taps Add and the
 *     ALTERNATIVE goes in her basket (never the milk that ran out — the bug this run found); she takes the sold-out milk out;
 *   • CONFIRMS: she checks the basket and pays; head office's order holds exactly what she chose. The agent changed nothing:
 *     its proposal says it committed nothing, and the only writes the app made were her own acts.
 * Synthetic data only. Needs DATABASE_URL and Chromium; else it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['w4', 'a04', 'connected', 'key'].join('-').padEnd(48, '0');
const PHONE = '+919000000404';
const SUBJECT = 'cust-phone-a04';
const PAY_REF = 'tok_w4_a04';
const STORE = 'br-1';
const STORE_AT = { lat: 11.0168, lon: 76.9558 };
const NEARBY = { latitude: 11.02, longitude: 76.96 };
interface Doc { getElementById(id: string): { hidden: boolean } | null }

const callsOn = (cloud: () => RealCloud): ShopCalls => {
  const req = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, userId = OWNER, query?: Record<string, string>): Promise<Res> =>
    cloud().request({ method, path: query === undefined ? path : `${path}?${new URLSearchParams(query).toString()}`, userId, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
  const okc = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r; };
  return { req, ok: okc };
};

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('A04 connected: a customer searches, uses a saved list and confirms the cart; the AI marks only what she asked for', () => {
  let browser: Browser;
  let shop: InboxShop;
  let app: CloudCustomerShop;
  const tomorrow = shiftDate(shopDateIn(new Date().toISOString()), 1);

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'customer-app'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/online-orders', html: 'online-orders.html', dataGlobal: 'onlineOrdersData' },
      seed: async (cloud) => {
        const c = callsOn(() => cloud);
        for (const f of ['customer_app', 'delivery']) await c.ok(c.req('PUT', `/v1/platform/entitlements/${f}`, { enabled: true }), `feature ${f}`);
        await seedOnlineCatalogue(c, STORE);
        // A second milk in the same category, in stock — and the first milk SOLD OUT at br-1 (all 20 sold).
        const today = shopDateIn(new Date().toISOString());
        await c.ok(c.req('POST', '/v1/catalogue/products/MILK2/publish', { product: { sku: 'MILK2-1L', name: 'Synthetic Toned Milk 1L', baseUom: 'ea', primaryCategoryId: 'dairy', taxClass: '0401', lifecycle: 'active', mrpHistory: [{ value: { minor: 70_00, currency: 'INR' }, effectiveFrom: '2026-01-01' }], safety: { allergens: ['milk'], countryOfOrigin: 'India' } } }), 'publish MILK2');
        await c.ok(c.req('POST', '/v1/prices/list/MILK2/entries/e1', { scope: 'store', scopeRef: STORE, priceMinor: 58_00, mrpMinor: 70_00, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: today }), 'price MILK2');
        await c.ok(c.req('POST', '/v1/inventory/movements', { movementId: 'rx-milk2', productId: 'MILK2', locationId: STORE, kind: 'received', quantityMinor: 12, uom: 'ea', occurredAt: new Date(Date.now() - 3_600_000).toISOString(), enteredBy: OWNER, batchId: 'M2-01', expiry: '2099-12-31', unitCostMinor: 40_00 }), 'receive MILK2');
        await c.ok(c.req('POST', '/v1/inventory/movements', { movementId: 'sold-milk', productId: 'MILK', locationId: STORE, kind: 'sold', quantityMinor: 20, uom: 'ea', occurredAt: new Date(Date.now() - 1_800_000).toISOString(), enteredBy: OWNER }), 'MILK sold out');
        await c.ok(c.req('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: today }), 'pack with MILK2');
        await listShopOnline(c);
        await sellOnline((path, body) => c.req('POST', path, body), ['MILK2']);
        await c.ok(c.req('PUT', '/v1/serviceability/delivery-service', { storeLocation: STORE_AT, slotsPerDay: 6, windowOpen: '09:00', windowClose: '21:00', capacityPerSlot: 10, leadMinutes: 60 }), 'delivery service');
        await inviteAppCustomer(cloud, { customerId: SUBJECT, displayName: 'Meena Raman', inviter: MGR, inviterBranch: STORE, approver: OWNER });
      },
    });
    // The owner switches A04 on by name (the kill switch is already off) — it drafts; the customer decides.
    await ok(shop.cloud().request({ method: 'PUT', path: '/v1/ai/agents/enabled', userId: OWNER, idempotencyKey: 'enable-a04', body: { expected: ['A06', 'A08', 'A10'], agents: ['A04', 'A06', 'A08', 'A10'] } }), 'enable A04');
    const c = callsOn(() => shop.cloud());
    const pack = (await c.ok(c.req('GET', '/v1/catalogue/pack'), 'pack')).body as { snapshot: { version: number; products: { productId: string; name: string; unitPriceMinor: number; baseUom: string }[] } };
    const slot = ((await c.ok(c.req('GET', '/v1/serviceability/delivery-service', undefined, OWNER, { day: tomorrow }), 'slots')).body as { slots: { startsAt: string; endsAt: string }[] }).slots[0]!;
    const onHand = async (productId: string): Promise<number> => ((await c.ok(c.req('GET', '/v1/inventory/availability', undefined, OWNER, { productId }), `stock ${productId}`)).body as { rows?: { locationId: string; onHandMinor: number }[] }).rows?.find((r) => r.locationId === STORE)?.onHandMinor ?? 0;
    const stock = new Map<string, number>();
    for (const p of pack.snapshot.products) stock.set(p.productId, await onHand(p.productId));
    app = await startCustomerShopOnCloud({
      cloud: () => shop.cloud(), subject: SUBJECT,
      // What the store box hands the app: the signed pack's products, and the stock head office reports for this store.
      shopData: async () => ({
        tenantId: shop.cloud().tenantId, customerRef: 'guest', packVersion: pack.snapshot.version, locationId: STORE,
        products: pack.snapshot.products.filter((p) => p.productId !== 'SAREE').map((p) => ({ productId: p.productId, name: p.name, categoryId: 'x', unitPriceMinor: p.unitPriceMinor, uom: p.baseUom, barcodes: [], status: 'active', availableMinor: stock.get(p.productId) ?? 0, availabilityAgeMinutes: 1 })),
        slots: [{ slotId: 'tomorrow', startsAt: slot.startsAt, endsAt: slot.endsAt, capacity: 10, booked: 0, kind: 'delivery' }],
        storeLocation: STORE_AT, policy: { radiusMetres: 10_000, deliveryFeeMinor: 40_00 }, deliveryFeeMinor: 40_00,
      }),
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await app?.stop(); await shop?.stop(); });

  const qtyIn = (page: Page, name: string) => page.locator('#basket-lines .row', { has: page.locator('.name', { hasText: new RegExp(`^${name}$`) }) }).locator('.n').textContent();
  /** What is in the basket now (name×quantity, sorted) — lines at nought are not in it. */
  const inBasket = async (page: Page): Promise<string[]> => (await page.locator('#basket-lines .row').evaluateAll((rows) => rows.map((r) => {
    const el = r as unknown as { querySelector(s: string): { textContent: string | null } | null };
    return `${el.querySelector('.name')?.textContent ?? ''}×${el.querySelector('.n')?.textContent ?? ''}`;
  }))).filter((x) => !x.endsWith('×0')).sort();

  it('search, a saved list put back, an AI alternative only when asked, and the cart she confirms is exactly what she chose', async () => {
    const ctx = await browser.newContext({ geolocation: NEARBY, permissions: ['geolocation'] });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript((ref) => { (globalThis as unknown as { shopPaymentRef?: string }).shopPaymentRef = ref; }, PAY_REF);
    try {
      await page.goto(`${app.base}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { document: Doc }).document.getElementById('sample')?.hidden === true, undefined, { timeout: 10_000 });

      // ── SEARCH: both milks found; nothing marked as AI; no AI notice (nobody asked) ──
      await page.fill('#search', 'milk');
      await page.locator('#results .row', { hasText: 'Synthetic Toned Milk 1L' }).waitFor({ timeout: 10_000 });
      expect(await page.locator('#results .row', { hasText: 'Synthetic Milk 1L' }).count()).toBeGreaterThan(0);
      expect(await page.locator('#results').textContent()).not.toContain('✦');
      expect(await page.isHidden('#ai-notice')).toBe(true);
      await page.click('button[aria-label="Add Synthetic Milk 1L"]');
      await page.fill('#search', 'broom');
      await page.click('button[aria-label="Add Synthetic Broom"]');

      // ── Sign in by one-time code in the basket (the check → slot → location → code) ──
      await page.click('#tab-basket');
      await page.click('#review');
      await page.click('#banner-ok');
      await page.locator('#slots .row button').first().click();
      await page.click('#banner-ok');
      await page.click('#locate');
      await page.locator('#banner-title', { hasText: 'Use my location' }).waitFor({ timeout: 10_000 });
      await page.click('#banner-ok');
      await page.fill('#si-phone', PHONE);
      await page.click('#si-send');
      await page.waitForSelector('#si-step-code:not([hidden])', { timeout: 10_000 });
      await page.fill('#si-code', app.sms.codeFor(PHONE) ?? '');
      await page.click('#si-verify');
      await page.waitForSelector('#si-step-in:not([hidden])', { timeout: 15_000 });

      // ── LIST-TO-CART: the basket saved as "Weekly" on the shop (PostgreSQL), emptied, and put back on her own tap ──
      await page.fill('#list-name', 'Weekly');
      await page.click('#save-list');
      await page.locator('#list-say', { hasText: 'Saved as a list on the shop.' }).waitFor({ timeout: 10_000 });
      const lists = (await shop.cloud().request({ method: 'GET', path: '/v1/me/lists', userId: SUBJECT })).body as { lists: { name: string; items: { productId: string; quantityMinor: number }[] }[] };
      expect(lists.lists.map((l) => [l.name, l.items.map((i) => `${i.productId}×${i.quantityMinor}`).sort()])).toEqual([['Weekly', ['BROOM×1', 'MILK×1']]]);
      await page.click('#basket-lines button[aria-label="Remove Synthetic Milk 1L"]');
      await page.click('#basket-lines button[aria-label="Remove Synthetic Broom"]');
      await expect.poll(() => inBasket(page), { timeout: 10_000 }).toEqual([]);
      await page.click('#tab-shop');
      await page.locator('#mylists .row', { hasText: 'Weekly — 2 item(s)' }).waitFor({ timeout: 10_000 });
      await page.click('#mylists .row button');
      await page.locator('#mine-say', { hasText: 'Added to your basket — check it before you pay.' }).waitFor({ timeout: 10_000 });
      await page.click('#tab-basket');
      await expect.poll(() => qtyIn(page, 'Synthetic Milk 1L'), { timeout: 10_000 }).toBe('1');
      expect(await qtyIn(page, 'Synthetic Broom')).toBe('1');

      // ── ALTERNATIVES: nothing marked until she asks; asking writes nothing; the ✦ row is the in-stock milk ──
      expect(await page.locator('#ideas-list .row').count()).toBe(0);
      expect(await page.isHidden('#ai-notice')).toBe(true);
      const writesBefore = app.writes.length;
      await page.click('#ideas');
      const alt = page.locator('#ideas-list .row[data-kind="ai"]');
      await alt.first().waitFor({ timeout: 15_000 });
      await page.locator('#ai-notice:not([hidden])').waitFor({ timeout: 10_000 });
      expect(await page.textContent('#ai-notice')).toBe(AI_SUGGESTION_NOTICE.en);
      expect(await alt.count()).toBe(1);
      expect(await alt.getAttribute('data-product-id')).toBe('MILK2');
      expect(await alt.locator('.name').textContent()).toBe('✦ Synthetic Toned Milk 1L');
      expect(await alt.locator('.note').textContent()).toBe('In stock, instead of Synthetic Milk 1L');
      expect(app.writes.length, 'asking for ideas writes nothing').toBe(writesBefore);
      await alt.locator('button').click();
      await page.click('#tab-basket');
      await expect.poll(() => qtyIn(page, 'Synthetic Toned Milk 1L'), { timeout: 10_000 }).toBe('1');
      expect(await qtyIn(page, 'Synthetic Milk 1L'), 'Add put the alternative in — the sold-out milk is still one').toBe('1');
      // She takes the sold-out milk out herself.
      await page.click('#basket-lines button[aria-label="Remove Synthetic Milk 1L"]');
      await expect.poll(() => inBasket(page), { timeout: 10_000 }).toEqual(['Synthetic Broom×1', 'Synthetic Toned Milk 1L×1']);

      // ── CONFIRMS: she checks the basket and pays; head office's order is exactly what she chose ──
      // A changed basket is checked again, with its time and place, before anything is paid.
      await page.click('#review');
      await page.click('#banner-ok');
      await page.locator('#slots .row button').first().click();
      await page.click('#banner-ok');
      await page.click('#locate');
      await page.locator('#banner-title', { hasText: 'Use my location' }).waitFor({ timeout: 10_000 });
      await page.click('#banner-ok');
      await page.click('#pay');
      await expect.poll(async () => ((await shop.cloud().request({ method: 'GET', path: '/v1/storefront/orders', userId: SUBJECT })).body as { orders: unknown[] }).orders.length, { timeout: 15_000 }).toBe(1);
      const order = ((await shop.cloud().request({ method: 'GET', path: '/v1/storefront/orders', userId: SUBJECT })).body as { orders: { lines: { productId: string; quantityMinor: number }[] }[] }).orders[0]!;
      expect(order.lines.map((l) => `${l.productId}×${l.quantityMinor}`).sort()).toEqual(['BROOM×1', 'MILK2×1']);
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }

    // The agent changed nothing (hard rule #5): its drafts say so, and every write the app made was the customer's own act.
    const mine = (await shop.cloud().request({ method: 'GET', path: `/v1/me/ai-suggestions?locationId=${STORE}&productId=MILK`, userId: SUBJECT })).body as { committedAnything: boolean; alternatives: { productIds: string[]; suggestedByAi: boolean }[] };
    expect(mine).toMatchObject({ committedAnything: false, alternatives: [{ productIds: ['MILK2'], suggestedByAi: true }] });
    const run = (await shop.cloud().request({ method: 'POST', path: '/v1/ai/agents/A04/runs', userId: OWNER, idempotencyKey: 'run-a04-after' })).body as { committedAnything: boolean; proposals: { committed: boolean }[] };
    expect(run.committedAnything).toBe(false);
    expect(run.proposals.every((p) => p.committed === false)).toBe(true);
    expect(app.writes.every((w) => !w.path.startsWith('/v1/ai/'))).toBe(true);
  }, 240_000);
});
