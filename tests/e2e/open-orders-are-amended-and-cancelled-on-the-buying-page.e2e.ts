import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import type { RealCloud } from '../support/real-store';

/**
 * **The Buying page's Open orders tab, in a real browser, on the PRODUCTION API over real PostgreSQL (M06-FR-04 "central/local
 * procurement, amendments, cancellations and open-commitment tracking" · OB-289 · OB-31 · hard rule #2).**
 *
 * Before this tab no screen amended or cancelled an order or showed `GET /v1/purchase/commitments/report`. Through Chromium:
 *   • the br-1 manager's order (25 kg of rice, 12 soaps) is issued by the owner; the manager reads what is on order — by
 *     buying scope (a manager's own order to his store is LOCAL), supplier and store, every quantity in its own unit
 *     ("25.000 kg", never 25000) — and is offered no change: he does not approve orders;
 *   • the owner changes the rice to 20 kg at ₹58 a kg (typed in kg); without a reason it is refused before any POST; head
 *     office keeps the change (one amendment, the earlier lines on its ledger) and the open value follows;
 *   • the owner cancels 5 kg of the rice; what is still on order falls by exactly that; head office holds 5000 g cancelled;
 *   • a cashier is told their role cannot read what is on order (head office refuses the cashier's read too).
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['open', 'orders', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const ACCT = 'u-acct-oo'; const SEED_BUYER = 'u-seed-buyer-oo'; const CASHIER = 'u-cash-oo';

interface Order { poId: string; status: string; amendmentCount: number; cancelledByProduct: Record<string, number>; lines: { productId: string; orderedQty: number; unitCost: { minor: number } }[] }

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Open orders tab on the Buying page (M06-FR-04)', () => {
  let browser: Browser;
  let shop: InboxShop;

  const as = (c: RealCloud, userId: string, path: string, body: unknown, key: string, branchId?: string) => c.request({ method: 'POST', path, userId, body, idempotencyKey: key, ...(branchId === undefined ? {} : { branchId }) });
  const orderAtHeadOffice = async (poId: string): Promise<Order> => ((await shop.cloud().request({ method: 'GET', path: `/v1/purchase/orders/${poId}`, userId: OWNER })).body as { order: Order }).order;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/buying', html: 'buying.html', dataGlobal: 'buyingData', extraData: async (api) => ({ buyerId: ((await api('/v1/identity/me')) as { userId: string }).userId }) },
      seed: async (c) => {
        await c.grant(ACCT, 'accountant', undefined, 'all');
        await c.grant(SEED_BUYER, 'store_manager', undefined, 'all');
        await c.grant(CASHIER, 'cashier');
        await ok(as(c, OWNER, '/v1/org/nodes/C-E2E', { kind: 'company', name: 'Synthetic Retail' }, 'org-c'), 'company');
        await ok(as(c, OWNER, '/v1/org/nodes/br-1', { kind: 'branch', name: 'Store One', parentId: 'C-E2E', companyId: 'C-E2E' }, 'org-br1'), 'store');
        await ok(as(c, SEED_BUYER, '/v1/purchase/suppliers/sup-1', { name: 'Synthetic supplier one' }, 'sup'), 'supplier');
        await ok(as(c, ACCT, '/v1/purchase/suppliers/sup-1/approval', { reason: 'documents checked' }, 'sup-ok'), 'supplier approved');
        await ok(as(c, OWNER, '/v1/catalogue/tax-classes/1006/rates/2017-07-01', { rateBps: 500 }, 'tax'), 'tax');
        for (const [id, uom, cat] of [['RICE', 'kg', 'grocery'], ['SOAP', 'ea', 'household']] as const) {
          await ok(as(c, OWNER, `/v1/catalogue/products/${id}/publish`, {
            product: { sku: `SKU-${id}`, name: `${id} (synthetic)`, baseUom: uom, primaryCategoryId: cat, taxClass: '1006', lifecycle: 'active' },
            categories: [{ categoryId: cat, name: cat, parentId: null }],
          }, `pub-${id}`), `publish ${id}`);
        }
        // The br-1 manager orders 25 kg of rice @ ₹60/kg and 12 soaps @ ₹40; the owner issues it.
        await ok(as(c, MGR, '/v1/purchase/orders/po-oo-1', { supplierId: 'sup-1', deliverToLocationId: 'br-1', lines: [
          { productId: 'RICE', orderedQty: 25_000, unitCost: { minor: 6_000, currency: 'INR' } },
          { productId: 'SOAP', orderedQty: 12, unitCost: { minor: 4_000, currency: 'INR' } },
        ] }, 'po-1', 'br-1'), 'propose');
        await ok(as(c, OWNER, '/v1/purchase/orders/po-oo-1/approval', { reason: 'weekly order' }, 'po-1-ok'), 'issue');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who, who === MGR ? 'br-1' : undefined);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/buying`, { waitUntil: 'load' });
    await page.click('#tab-orders');
    return { page, writes, errors, close: () => context.close() };
  };
  const says = async (page: Page, selector: string, expected: RegExp): Promise<void> => {
    try {
      await page.waitForFunction(([sel, source]) => new RegExp(source!).test((globalThis as unknown as { document: { querySelector(x: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''), [selector, expected.source], { timeout: 15_000 });
    } catch (e) {
      throw new Error(`${selector} never said ${String(expected)} — it says "${await page.locator(selector).first().textContent()}"`, { cause: e });
    }
  };

  it('the manager reads what is on order by scope, supplier and store, in each item\'s own unit, and is offered no change', async () => {
    const s = await open(MGR);
    try {
      await s.page.click('#orders-read');
      await s.page.locator('#orders-list .open-order[data-po="po-oo-1"]').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#orders-by-scope').innerText()).toMatch(/Local — bought by the store\s+1 orders · 2 lines · ₹1,980\.00/);
      expect(await s.page.locator('#orders-by-supplier').innerText()).toMatch(/sup-1\s+1 orders · 2 lines · ₹1,980\.00/);
      expect(await s.page.locator('#orders-by-store').innerText()).toMatch(/br-1/);
      const rice = await s.page.locator('.open-order[data-po="po-oo-1"] table.open-lines tr[data-product="RICE"]').innerText();
      expect(rice).toMatch(/RICE\s+25\.000 kg\s+0\.000 kg\s+0\.000 kg\s+25\.000 kg\s+₹1,500\.00/);
      expect(await s.page.locator('.open-order details').count(), 'a manager does not approve orders, so is offered no change').toBe(0);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);

  it('the owner changes the rice to 20 kg at ₹58 (typed in kg), then cancels 5 kg; head office keeps both and what is on order follows', async () => {
    const s = await open(OWNER);
    try {
      await s.page.click('#orders-read');
      const box = s.page.locator('.open-order[data-po="po-oo-1"]');
      await box.waitFor({ timeout: 15_000 });
      await box.locator('details.amend summary').click();
      expect(await box.locator('details.amend tr[data-product="RICE"] input.amend-qty').inputValue()).toBe('25.000');
      await box.locator('details.amend tr[data-product="RICE"] input.amend-qty').fill('20');
      await box.locator('details.amend tr[data-product="RICE"] input.amend-price').fill('58');
      await box.locator('button[data-act="amend"]').click();
      await says(s.page, '.open-order[data-po="po-oo-1"] details.amend p.otb-status', /^Write why first\.$/);
      expect(s.writes).toEqual([]);
      await box.locator('input.amend-reason').fill('supplier can only send 20 kg this week');
      await box.locator('button[data-act="amend"]').click();
      await says(s.page, '#orders-status', /^Changed — head office kept the earlier lines on its record\.$/);
      await says(s.page, '#orders-by-scope', /2 lines · ₹1,640\.00/);
      expect(await s.page.locator('.open-order[data-po="po-oo-1"] .what').innerText()).toContain('1 times changed');

      const again = s.page.locator('.open-order[data-po="po-oo-1"]');
      await again.locator('details.cancel summary').click();
      await again.locator('details.cancel tr[data-product="RICE"] input.cancel-qty').fill('5');
      await again.locator('input.cancel-reason').fill('shelf full');
      await again.locator('button[data-act="cancel"]').click();
      await says(s.page, '#orders-status', /^Cancelled — what is still on order went down by that\.$/);
      await says(s.page, '.open-order[data-po="po-oo-1"] table.open-lines tr[data-product="RICE"]', /20\.000 kg\s*0\.000 kg\s*5\.000 kg\s*15\.000 kg\s*₹870\.00/);
      await s.page.click('#lang');
      await says(s.page, '#orders-title', /^திறந்த ஆணைகள்$/);
      expect(s.writes).toEqual(['POST /v1/purchase/orders/po-oo-1/amendments', 'POST /v1/purchase/orders/po-oo-1/cancellations']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const o = await orderAtHeadOffice('po-oo-1');
    expect(o.amendmentCount).toBe(1);
    expect(o.lines.find((l) => l.productId === 'RICE')).toMatchObject({ orderedQty: 20_000, unitCost: { minor: 5_800 } });
    expect(o.cancelledByProduct).toEqual({ RICE: 5_000 });
  }, 120_000);

  it('a cashier is told their role cannot read what is on order, and head office refuses the read too', async () => {
    expect((await shop.cloud().request({ method: 'GET', path: '/v1/purchase/commitments/report', userId: CASHIER })).status).toBe(403);
    const s = await open(CASHIER);
    try {
      await says(s.page, '#orders-status', /^Your role cannot read what is on order\.$/);
      await s.page.click('#orders-read');
      await says(s.page, '#orders-status', /^Your role cannot read what is on order\.$/);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 60_000);
});
