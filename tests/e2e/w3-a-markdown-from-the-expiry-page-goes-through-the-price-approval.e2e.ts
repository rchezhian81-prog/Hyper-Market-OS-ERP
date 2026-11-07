import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { says } from './lib/r4c-box-page';
import { STORE_RULES } from '../support/store-rules';
import { theEvening, pinTheEveningClock, pinThePageClock } from '../support/evening-clock';
import { confirmIt } from './lib/confirm-sheet';

/**
 * **W3 (D06-FR-05 "markdown ladder and competitor capture" · D-4 · D-16 · D-18) — a markdown worked out on the Expiry page goes
 * through the existing price approval, in a real browser, on the PRODUCTION API over real PostgreSQL.** No screen reached the
 * markdown, clearance or competitor-rule routes before.
 *   • the bread batch B-7 (100 on hand, 2 days left) is on the Expiry page; the store manager presses "Work out a markdown",
 *     says 10 sell a day, and head office proposes 25% off, ₹50.00 → ₹37.50 (the shelf price was head office's own) — and
 *     changes no price;
 *   • "Send this price for approval" opens Change a price holding the bread at ₹37.50; under the 20% margin floor it needs a
 *     second person: she asks, the OWNER approves in his own session, and only then does her save go through — head office's
 *     price is ₹37.50; nobody's name was typed anywhere;
 *   • the clearance cake's batch is listed as a clearance suggestion, advisory only;
 *   • the owner changes the competitor rule to 7.5% / 10 days with a reason (version 1, nothing repriced); the manager sees
 *     the rule in force and is offered no form, and head office refuses the change to her.
 * Synthetic data, a fresh tenant. Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['w3', 'markdown', 'e2e', 'key'].join('-').padEnd(48, '0');
const STORE = 'br-1';
// The shop's own date at an evening UTC moment (19:30 UTC — already tomorrow in the shop), pinned so the evening case is
// proven whenever this runs: prices and sell-by dates are the shop's days, never the UTC date.
const EVENING = theEvening();
const TODAY = EVENING.shopDate;
const plusDays = (n: number): string => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const BREAD = { sku: 'BREAD-400', name: 'Milk bread 400g', baseUom: 'ea', primaryCategoryId: 'bakery', taxClass: '1905', lifecycle: 'active' };
const CAKE = { sku: 'CAKE-500', name: 'Plum cake 500g', baseUom: 'ea', primaryCategoryId: 'bakery', taxClass: '1905', lifecycle: 'clearance' };

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('a markdown from the Expiry page goes through the price approval (D06-FR-05)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) =>
    shop.cloud().request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: randomUUID() }) });
  const shelf = async (id: string): Promise<number> => ((await call('GET', `/v1/prices/list/${id}/resolve?storeId=${STORE}&at=${encodeURIComponent(new Date().toISOString())}`, OWNER)).body as { priceMinor: number }).priceMinor;

  beforeAll(async () => {
    pinTheEveningClock(EVENING);
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: {
        path: '/expiry', html: 'expiry.html', dataGlobal: 'expiryData',
        // what the store computer tells the Expiry page: its store, its clock, the near-expiry window and the batches
        // (\`now\` is the shop's midday: the Expiry list counts days left from the UTC date of the box's clock — a separate
        // M10 matter, reported — and this journey is about the markdown, not that count.)
        extraData: async () => ({ storeId: STORE, branchId: STORE, now: `${TODAY}T06:30:00.000Z`, tradingDay: TODAY, nearExpiryDays: 3,
          batches: [{ batchId: 'B-7', productId: 'p-bread', qty: 100, expiry: plusDays(2) }], productNames: { 'p-bread': BREAD.name }, productUnits: { 'p-bread': 'ea' } }),
      },
      alsoPages: [{
        path: '/catalogue', html: 'catalogue.html', dataGlobal: 'catalogueData',
        extraData: async (api) => ({ storeId: STORE, today: TODAY, now: new Date().toISOString(), marginFloorBps: 2_000, costsMinor: { 'p-bread': 3_500 },
          products: ((await api('/v1/catalogue/products')) as { products?: unknown[] }).products ?? [] }),
      }],
      seed: async (cloud) => {
        const req = (path: string, body: unknown) => cloud.request({ method: 'POST', path, userId: OWNER, body, idempotencyKey: `seed-${randomUUID()}` });
        await ok(req('/v1/catalogue/tax-classes/1905/rates/2017-07-01', { rateBps: 500 }), 'tax');
        for (const [id, product, cost] of [['p-bread', BREAD, 3_500], ['p-cake', CAKE, 20_000]] as const) {
          await ok(req(`/v1/catalogue/products/${id}/publish`, { product: { ...product, mrpHistory: [{ value: { minor: id === 'p-bread' ? 6_000 : 40_000, currency: 'INR' }, effectiveFrom: '2026-01-01' }] }, categories: [{ categoryId: 'bakery', name: 'Bakery', parentId: null }] }), `publish ${id}`);
          await ok(req(`/v1/prices/list/${id}/entries/e1`, { scope: 'store', scopeRef: STORE, priceMinor: id === 'p-bread' ? 5_000 : 35_000, mrpMinor: id === 'p-bread' ? 6_000 : 40_000, costMinor: cost, marginFloorBps: 0, currency: 'INR', effectiveFrom: TODAY }), `price ${id}`);
        }
        await ok(req('/v1/inventory/movements', { movementId: 'rx-cake', productId: 'p-cake', locationId: STORE, kind: 'received', quantityMinor: 12, uom: 'ea', occurredAt: new Date(Date.now() - 86_400_000).toISOString(), enteredBy: OWNER, unitCostMinor: 20_000, batchId: 'CK-9', expiry: plusDays(1) }), 'cake batch');
        // the owner's margin floor at the store: 20% — the marked-down bread will sit under it
        await ok(req(`/v1/stores/${STORE}/rules`, { ...STORE_RULES, marginFloorBps: 2_000 }), 'rules');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); vi.useRealTimers(); });

  const open = async (who: string, path: string) => {
    const context = await browser.newContext();
    await pinThePageClock(context);
    await shop.signIn(context, who, STORE);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };

  it('work out the bread markdown, send it for approval, a second person approves, and head office charges ₹37.50', async () => {
    const m = await open(MGR, '/expiry');
    await m.page.waitForSelector('#markdown:not([hidden])');
    await m.page.click('#expiry-list .row[data-product="p-bread"] .pick-markdown');
    expect(await m.page.inputValue('#md-product')).toBe('p-bread');
    expect(await m.page.inputValue('#md-batch')).toBe('B-7');
    expect(await m.page.inputValue('#md-qty')).toBe('100');
    expect(await m.page.inputValue('#md-days')).toBe('2');
    await m.page.fill('#md-rate', '10');
    await m.page.click('#md-go');
    await says(m.page, '#md-proposal', /^25% off: ₹50\.00 → ₹37\.50$/);
    await says(m.page, '#md-surplus', /^80 of 100 will not sell in time/);
    expect(await m.page.getAttribute('#md-send', 'href')).toBe('../catalogue/?tab=price&product=p-bread&price=37.50');
    expect(m.writes).toEqual(['POST /v1/pricing/markdown/propose']);
    expect(await shelf('p-bread')).toBe(5_000); // proposing changed no price

    // the clearance cake, advisory only
    await m.page.click('#cl-go');
    await says(m.page, '#cl-list .row[data-product="p-cake"][data-batch="CK-9"]', /p-cake · CK-9.*off: ₹350\.00 →/);
    expect(await shelf('p-cake')).toBe(35_000);
    expect(m.errors).toEqual([]);
    await m.close();

    // ── the link's page: Change a price, holding the bread at ₹37.50 — under the floor, so it needs a second person
    const c = await open(MGR, '/catalogue?tab=price&product=p-bread&price=37.50');
    await c.page.waitForSelector('#view-price:not([hidden])');
    expect(await c.page.inputValue('#price-item')).toBe('BREAD-400');
    expect(await c.page.inputValue('#new-price')).toBe('37.50');
    await c.page.waitForSelector('#price-approval:not([hidden])');
    await c.page.fill('#price-why', 'Batch B-7 has two days left; 80 of 100 will not sell.');
    await c.page.click('#ask-price');
    await says(c.page, '#banner-title', /\S/);
    // The banner speaks as the ask is sent; the request lands a moment later — wait for it in the owner's inbox.
    type Inbox = { waitingForMe: { requestId: string; kind: string; subjectRef: string }[] };
    let asked: Inbox = { waitingForMe: [] };
    await expect.poll(async () => {
      asked = (await call('GET', '/v1/approvals/requests', OWNER)).body as Inbox;
      return asked.waitingForMe.some((r) => r.kind === 'price_change' && r.subjectRef.includes('p-bread'));
    }, { message: 'the price change waits for the owner', timeout: 15_000 }).toBe(true);
    const request = asked.waitingForMe.find((r) => r.kind === 'price_change' && r.subjectRef.includes('p-bread'));
    expect(request, JSON.stringify(asked)).toBeDefined();
    expect(await shelf('p-bread')).toBe(5_000); // asking changed no price either
    await ok(call('POST', `/v1/approvals/requests/${request!.requestId}/decide`, OWNER, { decision: 'approved', reason: 'the batch expires in two days' }), 'owner approves');
    await c.page.click('#banner-ok');
    await c.page.click('#save-price');
    await confirmIt(c.page); // U1 · OB-694: the consequence-and-confirm sheet before the price is saved
    await says(c.page, '#banner-title', /^Price saved$/);
    expect(c.writes).toEqual(['POST /v1/approvals/requests', 'POST /v1/prices/changes']);
    expect(await shelf('p-bread')).toBe(3_750);
    expect(c.errors).toEqual([]);
    await c.close();
  }, 180_000);

  it('the owner changes the competitor rule; the manager sees it and is offered no form', async () => {
    const o = await open(OWNER, '/catalogue?tab=rivals');
    await o.page.waitForSelector('#rule-block:not([hidden])');
    await says(o.page, '#rule-now', /In force: 5\.0% or more below us, seen under 14 days ago \(the agreed starting setting\)/);
    await o.page.fill('#rule-gap', '7.5'); await o.page.fill('#rule-age', '10');
    await o.page.click('#rule-save');
    await says(o.page, '#rule-status', /^Write why the rule changes\.$/);
    expect(o.writes).toEqual([]);
    await o.page.fill('#rule-why', 'Shop A undercuts on staples every week');
    await o.page.click('#rule-save');
    await says(o.page, '#rule-status', /^Saved as version 1\. No price was changed\.$/);
    await says(o.page, '#rule-now', /In force: 7\.5% or more below us, seen under 10 days ago \(your setting, version 1\)/);
    expect(o.writes).toEqual(['POST /v1/prices/competitor-rule']);
    await o.page.click('#lang');
    await says(o.page, '#rule-title', /^போட்டியாளர் விலை மாற்றத்தை எப்போது வரைவு செய்கிறார்$/);
    expect(o.errors).toEqual([]);
    await o.close();

    const m = await open(MGR, '/catalogue?tab=rivals');
    await m.page.waitForSelector('#rule-block:not([hidden])');
    await says(m.page, '#rule-now', /7\.5% or more below us.*Only the owner can change this rule\./);
    expect(await m.page.isVisible('#rule-form')).toBe(false);
    expect(m.writes).toEqual([]);
    await m.close();
    const refused = await call('POST', '/v1/prices/competitor-rule', MGR, { gapBps: 100, maxAgeDays: 1, reason: 'try' });
    expect(refused.status).toBe(403);
  }, 120_000);
});
