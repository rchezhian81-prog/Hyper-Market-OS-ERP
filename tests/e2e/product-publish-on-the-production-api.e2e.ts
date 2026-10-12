import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { buildProductPublishCommand, type ProductPublishBarcode } from '../../apps/web-erp/src/catalogue-publish-command';
import type { ProductRecord, Category } from '../../packages/product/src/index';

/**
 * **Products to publish, in a real browser, on the PRODUCTION API over real PostgreSQL (M03-FR-01/03 · WF-01 · ADR-0013).**
 *
 * `product-publish-delivery.e2e.ts` proves the screen against a stub cloud. This is the connected proof: the page is
 * served in front of the real API (no stub), who is looking comes from head office's own `GET /v1/identity/me`, and
 * every `/v1` call goes to the API under the signed-in person's token. Through Chromium:
 *
 *   • nothing is sent on open; the owner presses Publish on the queued product: head office keeps the product master
 *     AND its barcode (read back from head office, not the page) and the queue item is acknowledged;
 *   • a barcode head office already holds for ANOTHER product is refused by head office: the command dead-letters on the
 *     device, visible for a person, never dropped; the other product keeps its code;
 *   • a cashier (no publish right) is offered no Publish and sends nothing;
 *   • after a RESTART of the API, head office still has the product and the code; the page reads in Tamil; no errors.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['publish', 'e2e', 'production', 'signing', 'key'].join('-').padEnd(48, '0');
const OUTBOX_KEY = 'sre.catalogue-outbox';
const CASHIER = 'u-cash-br1';
const TENANT = randomUUID();

interface BrowserGlobals {
  readonly localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  readonly document: { querySelectorAll(selector: string): { readonly length: number }; getElementById(id: string): { readonly disabled?: boolean } | null };
}

const GROCERY: Category = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const product = (productId: string, sku: string, name: string): ProductRecord => ({
  productId, tenantId: TENANT, sku, name, baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'new',
});
/** One pending publish command, in the exact device-outbox shape the boot restores from localStorage. */
const outboxWith = (record: ProductRecord, barcode: ProductPublishBarcode): string => {
  const event = buildProductPublishCommand({ record, categories: [GROCERY], barcodes: [barcode], requestedBy: OWNER, at: new Date().toISOString() });
  return JSON.stringify([{ key: event.idempotencyKey, event, state: 'pending', attempts: 0, reason: null }]);
};

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('products to publish on the production API, in a real browser (M03-FR-01/03)', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: TENANT, signingKey: KEY,
      page: {
        path: '/product-publish-review', html: 'product-publish-review.html', dataGlobal: 'productPublishReviewData',
        // What the store computer also tells this screen: the tenant, and that the session and membership are live.
        extraData: async () => ({ tenantId: TENANT, sessionActive: true, tenantMember: true }),
      },
      seed: async (cloud) => {
        await ok(cloud.request({ method: 'POST', path: '/v1/catalogue/tax-classes/25010020/rates/2017-07-01', userId: OWNER, idempotencyKey: 'tax', body: { rateBps: 500 } }), 'tax rate');
        // Another product already holds the code the second command will ask for.
        await ok(cloud.request({ method: 'POST', path: '/v1/catalogue/products/p-rock/publish', userId: OWNER, idempotencyKey: 'pub-rock', body: { product: { sku: 'SKU-ROCK', name: 'Rock salt 1kg', baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'active' }, categories: [GROCERY] } }), 'publish rock salt');
        await ok(cloud.request({ method: 'POST', path: '/v1/catalogue/products/p-rock/barcodes/8901058000999', userId: OWNER, idempotencyKey: 'bc-rock', body: { kind: 'ean' } }), 'rock salt barcode');
        const gid = `grant-${CASHIER}`;
        await ok(cloud.request({ method: 'POST', path: '/v1/identity/grants', userId: 'u-hr', idempotencyKey: `${gid}-ask`, body: { grantId: gid, userId: CASHIER, roleId: 'cashier', branchScope: ['br-1'], reason: 'till at br-1' } }), 'ask cashier grant');
        await ok(cloud.request({ method: 'POST', path: `/v1/identity/grants/${gid}/approve`, userId: OWNER, idempotencyKey: `${gid}-approve`, body: {} }), 'approve cashier grant');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string, outbox: string, branch?: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who, branch);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.addInitScript(([key, json]) => { (globalThis as unknown as BrowserGlobals).localStorage.setItem(key, json); }, [OUTBOX_KEY, outbox] as const);
    await page.goto(`${shop.base}/product-publish-review`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('.status').length > 0, undefined, { timeout: 15_000 });
    return { page, writes, errors, close: async () => { await page.waitForLoadState('networkidle').catch(() => {}); await context.close(); } }; // settle in-flight reads before the API restarts
  };
  const stored = (page: Page) => page.evaluate((key) => JSON.parse((globalThis as unknown as BrowserGlobals).localStorage.getItem(key) ?? '[]') as { state: string }[], OUTBOX_KEY);
  const atHeadOffice = (path: string) => shop.cloud().request({ method: 'GET', path, userId: OWNER });

  it('the owner publishes: head office keeps the product AND its barcode, the queue clears, and a restart still has both', async () => {
    const s = await open(OWNER, outboxWith(product('p-salt', 'SKU-SALT', 'Tata Salt 1kg'), { code: '8901058000108', kind: 'ean' }));
    try {
      expect(s.writes, 'nothing is sent on open').toEqual([]);
      expect((await atHeadOffice('/v1/catalogue/products/p-salt')).status).toBe(404);
      await s.page.click('#deliver');
      await s.page.waitForSelector('#result:not([hidden])', { timeout: 15_000 });
      expect(s.writes).toEqual(['POST /v1/catalogue/products/p-salt/publish', 'POST /v1/catalogue/products/p-salt/barcodes/8901058000108']);
      expect((await stored(s.page))[0]?.state).toBe('acknowledged');
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    await shop.restart();
    expect((await atHeadOffice('/v1/catalogue/products/p-salt')).body).toMatchObject({ product: { productId: 'p-salt', sku: 'SKU-SALT', name: 'Tata Salt 1kg', taxClass: '25010020' } });
    expect((await atHeadOffice('/v1/catalogue/barcodes/8901058000108')).body).toMatchObject({ barcode: { productId: 'p-salt' } });
  }, 120_000);

  it('a barcode head office holds for another product is refused there: the command dead-letters, visible; the other product keeps its code', async () => {
    const s = await open(OWNER, outboxWith(product('p-salt-2', 'SKU-SALT-2', 'Salt 500g'), { code: '8901058000999', kind: 'ean' }));
    try {
      await s.page.click('#deliver');
      await s.page.waitForSelector('#result:not([hidden])', { timeout: 15_000 });
      expect(s.writes).toContain('POST /v1/catalogue/products/p-salt-2/barcodes/8901058000999');
      expect((await stored(s.page))[0]?.state).toBe('dead_letter');
      expect(((await s.page.textContent('#result-text')) ?? '').length).toBeGreaterThan(0);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect((await atHeadOffice('/v1/catalogue/barcodes/8901058000999')).body).toMatchObject({ barcode: { productId: 'p-rock' } });
  }, 60_000);

  it('a cashier is offered no Publish and sends nothing; the page reads in Tamil', async () => {
    const s = await open(CASHIER, outboxWith(product('p-salt-3', 'SKU-SALT-3', 'Salt 250g'), { code: '8901058000555', kind: 'ean' }), 'br-1');
    try {
      expect(await s.page.evaluate(() => Boolean((globalThis as unknown as BrowserGlobals).document.getElementById('deliver')?.disabled))).toBe(true);
      expect(s.writes).toEqual([]);
      expect((await stored(s.page))[0]?.state).toBe('pending');
      expect((await atHeadOffice('/v1/catalogue/products/p-salt-3')).status).toBe(404);
      expect(await s.page.locator('#title').innerText()).toBe('Products waiting to publish');
      await s.page.click('#lang');
      await s.page.waitForFunction(() => /[஀-௿]/.test((globalThis as unknown as { document: { getElementById(x: string): { textContent: string | null } | null } }).document.getElementById('title')?.textContent ?? ''), undefined, { timeout: 10_000 });
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 60_000);
});
