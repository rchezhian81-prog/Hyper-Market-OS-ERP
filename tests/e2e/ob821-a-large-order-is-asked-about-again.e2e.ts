import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import type { RealCloud } from '../support/real-store';

/**
 * **OB-821 B (owner, 16 Nov 2026, in writing) · daily-work defect D-039 — a purchase order worth more than ₹1,00,000 before
 * GST is asked about again before it is raised. In a real browser, on the PRODUCTION API over real PostgreSQL.**
 *
 *   • Raise an order: 50 biscuits at ₹2,500 (₹1,25,000 before GST) — the first press says it is over ₹1,00,000, names the total
 *     and the limit, and sends NOTHING; the button reads "Yes, raise this order"; the second press raises it (proposed,
 *     waiting for a second person, exactly as before).
 *   • Order these from the usual supplier: rice from Grain House would come to ₹1,12,050 (2,490 still to order × ₹45) — held
 *     and named, NOT proposed, while the biscuits from Sri Foods (90 × ₹25 = ₹2,250) go ahead at once; the second press
 *     proposes exactly the rice order, nothing twice.
 *   • Nothing is issued here: every order still waits for a second person.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['ob821', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const ACCT = 'u-acct-ob821';
const NAMES = { BISCUIT: 'Marie biscuits (synthetic)', RICE: 'Ponni rice 1kg (synthetic)' };

interface Order { poId: string; status: string; supplierId: string; lines: { productId: string; orderedQty: number; unitCost: { minor: number } }[] }

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('OB-821 B: a purchase order over ₹1,00,000 before GST is asked about again (D-039)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const as = (c: RealCloud, userId: string, path: string, body: unknown, key: string, branchId?: string) =>
    c.request({ method: 'POST', path, userId, body, idempotencyKey: key, ...(branchId === undefined ? {} : { branchId }) });
  const orders = async (): Promise<Order[]> => ((await shop.cloud().request({ method: 'GET', path: '/v1/purchase/orders', userId: OWNER })).body as { orders: Order[] }).orders;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: {
        path: '/buying', html: 'buying.html', dataGlobal: 'buyingData',
        extraData: async (api) => ({
          buyerId: ((await api('/v1/identity/me')) as { userId: string }).userId,
          productUoms: { BISCUIT: 'ea', RICE: 'ea' }, productNames: NAMES, productTaxBps: { BISCUIT: 1_800, RICE: 500 },
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
        // Earlier orders issued by a second person: biscuits from Sri Foods at ₹25, rice from Grain House at ₹45.
        for (const [po, sup, productId, price] of [['PO-OLD-1', 'sup-1', 'BISCUIT', 2_500], ['PO-OLD-2', 'sup-2', 'RICE', 4_500]] as const) {
          await ok(c.request({ method: 'POST', path: `/v1/purchase/orders/${po}`, userId: MGR, branchId: 'br-1', idempotencyKey: `raise-${po}`, body: { supplierId: sup, deliverToLocationId: 'br-1', lines: [{ productId, orderedQty: 10, unitCost: { minor: price, currency: 'INR' } }] } }), `raise ${po}`);
          await ok(c.request({ method: 'POST', path: `/v1/purchase/orders/${po}/approval`, userId: OWNER, idempotencyKey: `issue-${po}`, body: { reason: 'weekly order' } }), `issue ${po}`);
        }
        // Reorder settings: biscuits want 100, rice wants 2,500 (a big festival stock-up). With 10 of each already on order,
        // head office proposes 90 biscuits (₹2,250) and 2,490 rice (₹1,12,050 — over the limit).
        for (const [id, max, rp] of [['BISCUIT', 100, 60], ['RICE', 2_500, 2_000]] as const) {
          await ok(as(c, OWNER, `/v1/replenishment/parameters/br-1/${id}`, { maxLevel: max, reorderPoint: rp, reason: 'for the OB-821 test' }, `rp-${id}`), `settings ${id}`);
        }
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async () => {
    const context = await browser.newContext();
    await shop.signIn(context, MGR, 'br-1');
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname.replace(/PO-[A-Z0-9-]+/, 'PO-…')}`); });
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

  it('Raise an order: ₹1,25,000 before GST is warned about with nothing sent; the second press raises it, waiting for a second person', async () => {
    const before = (await orders()).length;
    const s = await open();
    try {
      await s.page.click('#tab-po');
      await s.page.fill('#po-supplier', 'sup-1');
      await s.page.locator('#po-supplier').dispatchEvent('change');
      if ((await s.page.inputValue('#po-store')) === '') await s.page.fill('#po-store', 'br-1');
      await s.page.fill('#po-product', 'BISCUIT');
      await s.page.fill('#po-qty', '50');
      await s.page.fill('#po-cost', '2500');
      await s.page.click('#add-po-line');
      await s.page.click('#raise-po');
      await says(s.page, '#banner-text', /^Not raised yet — this order is worth ₹1,25,000\.00 before GST, more than ₹1,00,000\.00 \(the owner's limit, OB-821\)/);
      expect(s.writes, 'the first press sends nothing').toEqual([]);
      expect(await s.page.locator('#raise-po').innerText()).toBe('Yes, raise this order');
      await s.page.click('#banner-ok');
      await s.page.click('#raise-po');
      await says(s.page, '#banner-title', /^Order proposed — waiting for a second person to approve it$/);
      expect(s.writes).toEqual(['POST /v1/purchase/orders/PO-…']);
      expect(await s.page.locator('#raise-po').innerText(), 'the button is ordinary again for the next order').not.toBe('Yes, raise this order');
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const now = await orders();
    expect(now.length - before).toBe(1);
    const raised = now.find((o) => o.status === 'proposed' && o.lines.some((l) => l.productId === 'BISCUIT' && l.orderedQty === 50));
    expect(raised?.lines.map((l) => [l.productId, l.orderedQty, l.unitCost.minor]), 'proposed, not issued, at the price before GST').toEqual([['BISCUIT', 50, 250_000]]);
  }, 180_000);

  it('Order these from the usual supplier: the ₹1,12,050 rice order is held and named while the biscuits go ahead; the second press proposes only the rice', async () => {
    const before = (await orders()).filter((o) => o.status === 'proposed').length;
    const s = await open();
    try {
      await s.page.click('#tab-reorder');
      await s.page.fill('#reorder-store', 'br-1');
      await s.page.click('#reorder-read');
      for (const id of ['BISCUIT', 'RICE']) {
        const row = s.page.locator(`#reorder-proposal tr[data-product="${id}"]`);
        await row.waitFor({ timeout: 15_000 });
        await row.locator('input.tick').check();
      }
      await s.page.click('#reorder-usual');
      await says(s.page, '#reorder-usual-big', /^Not raised yet — 1 order\(s\) are worth more than ₹1,00,000\.00 before GST[\s\S]*Grain House \(synthetic\): ₹1,12,050\.00 before GST/);
      await says(s.page, '#reorder-usual-status', /^Proposed 1 order\(s\)[\s\S]*Sri Foods \(synthetic\) · PO-[A-Z0-9-]+ · ₹2,250\.00/);
      expect(s.writes.filter((w) => !w.endsWith('/stored-proposal')), 'only the biscuits order went').toEqual(['POST /v1/purchase/orders/PO-…']);
      expect(await s.page.locator('#reorder-usual').innerText()).toBe('Yes, raise this order');

      await s.page.click('#reorder-usual');
      await says(s.page, '#reorder-usual-status', /^Proposed 1 order\(s\)[\s\S]*Grain House \(synthetic\) · PO-[A-Z0-9-]+ · ₹1,12,050\.00/);
      expect(s.writes.filter((w) => !w.endsWith('/stored-proposal')), 'the rice order on yes, nothing twice').toEqual(['POST /v1/purchase/orders/PO-…', 'POST /v1/purchase/orders/PO-…']);
      expect(await s.page.locator('#reorder-usual').innerText()).toBe('Order these from the usual supplier');
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const fresh = (await orders()).filter((o) => o.status === 'proposed');
    expect(fresh.length - before).toBe(2);
    expect(fresh.some((o) => o.supplierId === 'sup-2' && o.lines.some((l) => l.productId === 'RICE' && l.orderedQty === 2_490 && l.unitCost.minor === 4_500))).toBe(true);
  }, 180_000);
});
