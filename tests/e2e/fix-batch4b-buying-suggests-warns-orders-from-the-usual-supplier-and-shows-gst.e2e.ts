import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import type { RealCloud } from '../support/real-store';

/**
 * **Fix batch 4b (OB-800 THE PLAN) — D-038, D-039, D-040, D-041 on the Buying page, in a real browser, on the PRODUCTION API
 * over real PostgreSQL.**
 *
 * The walkthrough's purchase person: no reorder settings for any item (each typed one by one, items as codes, the store as
 * "pilot-demo-branch"); "Most to hold" 48200 accepted for 48 and then 48,112 packs proposed; ticking a suggestion made a
 * requisition, not an order; "Raise an order" showed codes and no GST. Now, through Chromium:
 *   • D-038 the Reorder tab's store is this store; "Suggest figures for every item from recent sales" reads head office's
 *     sales history and suggests 7 days' sales to reorder at and 14 to hold for every item that sold, by NAME, an item that
 *     did not sell named apart — nothing is written until the person ticks and saves; head office keeps them as versions;
 *   • D-039 "Most to hold" 48200 where 28 is in force is NOT saved: the page says it is more than 5 times and asks again;
 *     the second press saves it;
 *   • D-040 "Order these from the usual supplier" proposes ONE order per supplier, at the price of the latest issued order,
 *     in the manager's name, waiting for a second person (head office says "proposed"); an item with no earlier order is
 *     named and left out;
 *   • D-041 "Raise an order" names the supplier, store and items, says the price is before GST, and shows each line's GST
 *     at the item's held rate and the total with GST; an item with no rate is named, its GST not guessed. The order itself
 *     is raised at the price before GST, exactly as before.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['batch4b', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const ACCT = 'u-acct-b4b';
const NAMES = { BISCUIT: 'Marie biscuits (synthetic)', RICE: 'Ponni rice 1kg (synthetic)', SALT: 'Crystal salt (synthetic)' };
const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

interface Order { poId: string; status: string; supplierId: string; requisitionedBy: string; deliverToLocationId?: string; lines: { productId: string; orderedQty: number; unitCost: { minor: number } }[] }

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('fix batch 4b: the Buying page suggests, warns, orders from the usual supplier and shows GST (D-038 – D-041)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const as = (c: RealCloud, userId: string, path: string, body: unknown, key: string, branchId?: string) =>
    c.request({ method: 'POST', path, userId, body, idempotencyKey: key, ...(branchId === undefined ? {} : { branchId }) });
  const orders = async (): Promise<Order[]> => ((await shop.cloud().request({ method: 'GET', path: '/v1/purchase/orders', userId: OWNER })).body as { orders: Order[] }).orders;
  const settings = async (): Promise<{ current: { productId: string; maxLevel: number; reorderPoint?: number; version: number } }[]> =>
    ((await shop.cloud().request({ method: 'GET', path: '/v1/replenishment/parameters?storeId=br-1', userId: OWNER })).body as { products: { current: { productId: string; maxLevel: number; reorderPoint?: number; version: number } }[] }).products;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      // What the store computer injects for the Buying page from its pack: the signed-in buyer, each item's unit, name and
      // GST rate (SALT has none held).
      page: {
        path: '/buying', html: 'buying.html', dataGlobal: 'buyingData',
        extraData: async (api) => ({
          buyerId: ((await api('/v1/identity/me')) as { userId: string }).userId,
          productUoms: { BISCUIT: 'ea', RICE: 'ea', SALT: 'ea' }, productNames: NAMES, productTaxBps: { BISCUIT: 1_800, RICE: 500 },
        }),
      },
      seed: async (c) => {
        await c.grant(ACCT, 'accountant', undefined, 'all');
        await ok(as(c, OWNER, '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' }, 'org-c1'), 'company');
        await ok(as(c, OWNER, '/v1/org/nodes/br-1', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }, 'org-br1'), 'branch');
        for (const [id, name] of [['sup-1', 'Sri Foods (synthetic)'], ['sup-2', 'Grain House (synthetic)']] as const) {
          await ok(as(c, MGR, `/v1/purchase/suppliers/${id}`, { name }, `sup-${id}`, 'br-1'), `supplier ${id}`);
          await ok(as(c, ACCT, `/v1/purchase/suppliers/${id}/approval`, { reason: 'documents checked' }, `sup-ok-${id}`), `supplier ${id} approved`);
        }
        await ok(as(c, OWNER, '/v1/catalogue/tax-classes/1006/rates/2017-07-01', { rateBps: 500 }, 'tax'), 'tax');
        for (const [id, name] of Object.entries(NAMES)) {
          await ok(as(c, OWNER, `/v1/catalogue/products/${id}/publish`, {
            product: { sku: `SKU-${id}`, name, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active' },
            categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
          }, `pub-${id}`), `publish ${id}`);
        }
        // Four weeks of sales: 56 biscuits (2 a day) and 28 rice packs (1 a day); no salt sold.
        let n = 0;
        for (const [productId, qty] of [['BISCUIT', 28], ['BISCUIT', 28], ['RICE', 14], ['RICE', 14]] as const) {
          n += 1;
          const day = daysAgo(2 + n);
          await ok(c.request({
            method: 'POST', path: '/v1/sales', userId: OWNER, idempotencyKey: `sale-${n}`,
            body: {
              saleId: `S-B4B-${n}`, receiptNumber: `R-B4B-${n}`, laneId: 'lane-1', cashierId: OWNER, tradingDay: day, committedAt: `${day}T06:00:00Z`,
              totalMinor: qty * 100, currency: 'INR', packVersion: 1,
              lines: [{ productId, quantityMinor: qty, uom: 'each', unitPriceMinor: 100, lineTotalMinor: qty * 100 }],
              tenders: [{ kind: 'cash', amountMinor: qty * 100 }],
            },
          }), `sale ${n}`);
        }
        // Biscuits already have reorder figures (48 / 12), as the walkthrough found them.
        await ok(as(c, OWNER, '/v1/replenishment/parameters/br-1/BISCUIT', { maxLevel: 48, reorderPoint: 12, reason: 'first figures' }, 'rp-biscuit-1'), 'biscuit settings');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who, who === MGR ? 'br-1' : undefined);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname.replace(/PO-[A-Z0-9]+/, 'PO-…')}`); });
    await page.goto(`${shop.base}/buying`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };
  const says = async (page: Page, selector: string, expected: RegExp): Promise<void> => {
    try {
      await page.waitForFunction(([sel, source]) => new RegExp(source!).test((globalThis as unknown as { document: { querySelector(x: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''), [selector, expected.source], { timeout: 15_000 });
    } catch (e) {
      throw new Error(`${selector} never said ${String(expected)} — it says "${await page.locator(selector).first().textContent()}"`, { cause: e });
    }
  };

  it('D-038 suggests figures for every item from recent sales, saved only when ticked; D-039 asks again before saving 48200 for 28', async () => {
    const s = await open(MGR);
    try {
      await s.page.click('#tab-reorder');
      await s.page.fill('#reorder-store', 'br-1');
      await s.page.click('#suggest-read');
      const biscuit = s.page.locator('#suggest-rows tr[data-product="BISCUIT"]');
      await biscuit.waitFor({ timeout: 15_000 });
      expect(await biscuit.innerText()).toMatch(/Marie biscuits \(synthetic\)\s+14\s+14 \(Now 12\)\s+28 \(Now 48\)/);
      expect(await s.page.locator('#suggest-rows tr[data-product="RICE"]').innerText()).toMatch(/Ponni rice 1kg \(synthetic\)\s+7\s+7\s+14/);
      expect(await biscuit.locator('input.tick').isChecked(), 'an item with figures already is left for the person to choose').toBe(false);
      expect(await s.page.locator('#suggest-rows tr[data-product="RICE"] input.tick').isChecked(), 'an item with none is ticked for them').toBe(true);
      expect(await s.page.locator('#suggest-left').innerText()).toMatch(/Crystal salt \(synthetic\): No sales in this window — set by hand/);
      expect(await s.page.locator('#suggest-lead').innerText()).toMatch(/last 28 days/);
      expect(s.writes, 'suggesting writes nothing').toEqual([]);

      await biscuit.locator('input.tick').check();
      await s.page.click('#suggest-save');
      await says(s.page, '#suggest-save-status', /^Saved for 2 item\(s\)/);
      const after = await settings();
      expect(after.find((p) => p.current.productId === 'BISCUIT')?.current).toMatchObject({ maxLevel: 28, reorderPoint: 14, version: 2 });
      expect(after.find((p) => p.current.productId === 'RICE')?.current).toMatchObject({ maxLevel: 14, reorderPoint: 7, version: 1 });

      // D-039: 48200 typed where 28 is in force — warned, nothing sent; the second press saves it.
      await s.page.fill('#rp-productId', 'BISCUIT');
      await s.page.fill('#rp-maxLevel', '48200');
      await s.page.fill('#rp-reorderPoint', '14');
      await s.page.fill('#rp-reason', 'festival');
      const before = s.writes.length;
      await s.page.click('#rp-save');
      await says(s.page, '#rp-status', /more than 5 times[\s\S]*Marie biscuits \(synthetic\): Most to hold from 28 to 48200/);
      expect(s.writes.length, 'the slip was not sent').toBe(before);
      expect(await s.page.locator('#rp-save').innerText()).toBe('Yes, save these figures');
      await s.page.click('#rp-save');
      await says(s.page, '#rp-status', /^Saved/);
      expect((await settings()).find((p) => p.current.productId === 'BISCUIT')?.current).toMatchObject({ maxLevel: 48_200, version: 3 });
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 180_000);

  it('D-040 proposes one order per usual supplier at the last agreed price, waiting for a second person; an item with no earlier order is named', async () => {
    // Earlier orders, issued by a second person: biscuits from Sri Foods at ₹25, rice from Grain House at ₹45.
    for (const [po, sup, productId, qty, price] of [['PO-OLD-1', 'sup-1', 'BISCUIT', 48, 2_500], ['PO-OLD-2', 'sup-2', 'RICE', 10, 4_500]] as const) {
      await ok(shop.cloud().request({ method: 'POST', path: `/v1/purchase/orders/${po}`, userId: MGR, branchId: 'br-1', idempotencyKey: `raise-${po}`, body: { supplierId: sup, deliverToLocationId: 'br-1', lines: [{ productId, orderedQty: qty, unitCost: { minor: price, currency: 'INR' } }] } }), `raise ${po}`);
      await ok(shop.cloud().request({ method: 'POST', path: `/v1/purchase/orders/${po}/approval`, userId: OWNER, idempotencyKey: `issue-${po}`, body: { reason: 'weekly order' } }), `issue ${po}`);
    }
    for (const [id, max, rp] of [['BISCUIT', 100, 60], ['RICE', 30, 20], ['SALT', 10, 5]] as const) {
      await ok(shop.cloud().request({ method: 'POST', path: `/v1/replenishment/parameters/br-1/${id}`, userId: OWNER, idempotencyKey: `rp2-${id}`, body: { maxLevel: max, reorderPoint: rp, reason: 'for the order test' } }), `settings ${id}`);
    }
    const before = (await orders()).length;
    const s = await open(MGR);
    try {
      await s.page.click('#tab-reorder');
      await s.page.fill('#reorder-store', 'br-1');
      await s.page.click('#reorder-read');
      for (const id of ['BISCUIT', 'RICE', 'SALT']) {
        const row = s.page.locator(`#reorder-proposal tr[data-product="${id}"]`);
        await row.waitFor({ timeout: 15_000 });
        await row.locator('input.tick').check();
      }
      await s.page.click('#reorder-usual');
      await says(s.page, '#reorder-usual-status', /^Proposed 2 order\(s\), one per supplier, at the last agreed price/);
      const text = await s.page.locator('#reorder-usual-status').innerText();
      expect(text).toMatch(/Sri Foods \(synthetic\) · PO-[A-Z0-9-]+ · ₹1,300\.00/); // 52 × ₹25
      expect(text).toMatch(/Grain House \(synthetic\) · PO-[A-Z0-9-]+ · ₹900\.00/); // 20 × ₹45
      expect(text).toMatch(/Left out[\s\S]*Crystal salt \(synthetic\) \(no earlier issued order/);
      expect(s.writes.filter((w) => !w.endsWith('/stored-proposal')), 'two proposals, nothing issued, no requisition').toEqual(['POST /v1/purchase/orders/PO-…', 'POST /v1/purchase/orders/PO-…']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const now = await orders();
    const fresh = now.filter((o) => o.status === 'proposed');
    expect(now.length - before).toBe(2);
    expect(fresh.map((o) => [o.supplierId, o.requisitionedBy, o.deliverToLocationId, o.lines.map((l) => [l.productId, l.orderedQty, l.unitCost.minor])]).sort()).toEqual([
      ['sup-1', MGR, 'br-1', [['BISCUIT', 52, 2_500]]],
      ['sup-2', MGR, 'br-1', [['RICE', 20, 4_500]]],
    ]);
  }, 180_000);

  it('D-041 Raise an order names the supplier, store and items, prices before GST, and shows the GST and the total with GST', async () => {
    const before = (await orders()).length;
    const s = await open(MGR);
    try {
      await s.page.click('#tab-po');
      await s.page.fill('#po-supplier', 'sup-1');
      await s.page.locator('#po-supplier').dispatchEvent('change');
      await says(s.page, '#po-supplier-name', /^Sri Foods \(synthetic\) \(sup-1\)$/);
      if ((await s.page.inputValue('#po-store')) === '') await s.page.fill('#po-store', 'br-1');
      for (const [id, qty, price] of [['BISCUIT', '10', '25'], ['RICE', '2', '45'], ['SALT', '1', '10']] as const) {
        await s.page.fill('#po-product', id);
        expect(await s.page.locator('#po-cost-label').innerText()).toBe('Agreed price per item, before GST (in rupees)');
        await s.page.fill('#po-qty', qty);
        await s.page.fill('#po-cost', price);
        await s.page.click('#add-po-line');
      }
      const table = s.page.locator('#po-lines-table');
      expect(await table.locator('tr[data-product="BISCUIT"]').innerText()).toMatch(/Marie biscuits \(synthetic\)\s+10\s+₹25\.00\s+₹250\.00\s+18%\s+₹45\.00/);
      expect(await table.locator('tr[data-product="RICE"]').innerText()).toMatch(/Ponni rice 1kg \(synthetic\)\s+2\s+₹45\.00\s+₹90\.00\s+5%\s+₹4\.50/);
      expect(await table.locator('tr[data-product="SALT"]').innerText()).toMatch(/Crystal salt \(synthetic\)\s+1\s+₹10\.00\s+₹10\.00\s+not held\s+—/);
      expect(await s.page.locator('#po-gst-totals').innerText()).toBe('Before GST: ₹350.00 · GST: ₹49.50 · Total with GST: ₹399.50');
      expect(await s.page.locator('#po-gst-no-rate').innerText()).toMatch(/^No GST rate is held for Crystal salt \(synthetic\) — its GST is not in the total/);
      expect(s.writes, 'adding lines writes nothing').toEqual([]);
      await s.page.click('#raise-po');
      await says(s.page, '#banner-title', /^Order proposed — waiting for a second person to approve it$/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const now = await orders();
    expect(now.length - before).toBe(1);
    const raised = now.find((o) => o.status === 'proposed' && o.lines.some((l) => l.productId === 'SALT'));
    expect(raised?.lines.map((l) => [l.productId, l.orderedQty, l.unitCost.minor]), 'raised at the price before GST, as always').toEqual([['BISCUIT', 10, 2_500], ['RICE', 2, 4_500], ['SALT', 1, 1_000]]);
  }, 180_000);
});
