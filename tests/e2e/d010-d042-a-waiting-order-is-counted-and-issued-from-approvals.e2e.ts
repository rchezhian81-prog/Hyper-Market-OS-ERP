import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import type { RealCloud } from '../support/real-store';

/**
 * **Fix batch 4a — D-010 and D-042, in a real browser, on the PRODUCTION API over real PostgreSQL.**
 *
 * The walkthrough: the br-1 manager raised a purchase order; Today said "Approvals waiting 0", and the order could be
 * issued only from the Buying page's Budget tab, where its row showed codes and a total — never what was being bought.
 *
 * Now, through Chromium, with the pages served in front of the real API (what the store computer injects for each page —
 * who is looking and what they hold — read from head office's own `GET /v1/identity/me`):
 *
 *   • the manager's Today counts the waiting order under "Approvals waiting" (D-010);
 *   • the owner's Approvals page lists it with the supplier's name, each item by name, how many, the agreed price, the
 *     line's value and the total (D-042) — opening the page writes nothing;
 *   • the manager who raised it sees it there too, but is offered no Issue button (§28);
 *   • the owner's Issue with no reason sends nothing; with a reason, head office issues it IN THE OWNER'S NAME through the
 *     one issue path (`POST /v1/purchase/orders/:poId/approval`) — read back from head office, not from the page.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['d010', 'd042', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const ACCT = 'u-acct-d042';
const SEED_BUYER = 'u-seed-buyer-d042';
const PO = 'PO-D042-1';

interface Order { poId: string; status: string; requisitionedBy: string; approvedBy?: string | null }

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('D-010 · D-042: a waiting purchase order is counted on Today and issued from Approvals with its lines (M06-FR-02 · §28)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const as = (c: RealCloud, userId: string, path: string, body: unknown, key: string) => c.request({ method: 'POST', path, userId, body, idempotencyKey: key });
  const orderAtHeadOffice = async (): Promise<Order | undefined> => ((await shop.cloud().request({ method: 'GET', path: '/v1/purchase/orders', userId: OWNER })).body as { orders: Order[] }).orders.find((o) => o.poId === PO);

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/approvals', html: 'approvals.html', dataGlobal: 'approvalsData' },
      alsoPages: [{ path: '/manager', html: 'index.html', dataGlobal: 'managerData' }],
      seed: async (c) => {
        await c.grant(ACCT, 'accountant', undefined, 'all');
        await c.grant(SEED_BUYER, 'store_manager', undefined, 'all');
        await ok(as(c, SEED_BUYER, '/v1/purchase/suppliers/sup-1', { name: 'Sri Foods (synthetic)' }, 'sup'), 'supplier');
        await ok(as(c, ACCT, '/v1/purchase/suppliers/sup-1/approval', { reason: 'documents checked' }, 'sup-ok'), 'supplier approved');
        await ok(as(c, OWNER, '/v1/catalogue/tax-classes/1006/rates/2017-07-01', { rateBps: 500 }, 'tax'), 'tax');
        await ok(as(c, OWNER, '/v1/catalogue/products/BISCUIT/publish', {
          product: { sku: 'SKU-BISCUIT', name: 'Marie biscuits (synthetic)', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active' },
          categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
        }, 'pub-biscuit'), 'publish biscuit');
        await ok(as(c, OWNER, '/v1/catalogue/products/RICE/publish', {
          product: { sku: 'SKU-RICE', name: 'Ponni rice (synthetic)', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active' },
          categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
        }, 'pub-rice'), 'publish rice');
      },
    });
    // The br-1 manager raises the order — proposed, waiting for its second person.
    const raised = await shop.cloud().request({
      method: 'POST', path: `/v1/purchase/orders/${PO}`, userId: MGR, branchId: 'br-1', idempotencyKey: 'raise-d042',
      body: { supplierId: 'sup-1', deliverToLocationId: 'br-1', lines: [
        { productId: 'BISCUIT', orderedQty: 48, unitCost: { minor: 3_000, currency: 'INR' } },
        { productId: 'RICE', orderedQty: 10, unitCost: { minor: 12_000, currency: 'INR' } },
      ] },
    });
    if (raised.status >= 300) throw new Error(`raise: ${raised.status} ${JSON.stringify(raised.body)}`);
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string, path: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who, who === MGR ? 'br-1' : undefined);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };
  const orderBox = (page: Page) => page.locator(`#orders li[data-po="${PO}"]`);

  it('Today counts the waiting order under Approvals waiting (D-010)', async () => {
    const s = await open(MGR, '/manager');
    try {
      await s.page.waitForFunction(() => /purchase order\(s\) waiting to be issued by a second person/.test((globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText), undefined, { timeout: 20_000 });
      expect(await s.page.locator('body').innerText()).toMatch(/1 purchase order\(s\) waiting to be issued by a second person — open Approvals/);
      expect(s.writes, 'Today reads only').toEqual([]);
    } finally { await s.close(); }
  });

  it('the owner sees the order\'s supplier, items, quantities and prices on Approvals, and issues it there with a reason (D-042)', async () => {
    // The manager who raised it: listed, but no Issue button — a second person issues it (§28).
    let s = await open(MGR, '/approvals');
    try {
      await orderBox(s.page).waitFor({ timeout: 20_000 });
      expect(await orderBox(s.page).locator('button.issue').count()).toBe(0);
      expect(await orderBox(s.page).innerText()).toMatch(/You raised this order, so a second person must issue it\./);
      expect(s.writes).toEqual([]);
    } finally { await s.close(); }

    s = await open(OWNER, '/approvals');
    try {
      const box = orderBox(s.page);
      await box.waitFor({ timeout: 20_000 });
      const text = await box.innerText();
      expect(text).toMatch(/Sri Foods \(synthetic\)/);
      expect(text).toMatch(/Marie biscuits \(synthetic\)\s+48\s+₹30\.00\s+₹1,440\.00/);
      expect(text).toMatch(/Ponni rice \(synthetic\)\s+10\s+₹120\.00\s+₹1,200\.00/);
      expect(text).toMatch(/₹2,640\.00/);
      expect(text).toMatch(new RegExp(`Raised by: ${MGR}`));
      expect(text, 'items by name, never the code alone').not.toMatch(/^BISCUIT\b/m);
      expect(s.writes, 'opening Approvals writes nothing').toEqual([]);

      // No reason → nothing is sent.
      await box.locator('button.issue').click();
      await s.page.waitForFunction((id) => /Write why this order is approved first/.test((globalThis as unknown as { document: { getElementById(x: string): { textContent: string | null } | null } }).document.getElementById(id)?.textContent ?? ''), `issue-status-${PO}`, { timeout: 10_000 });
      expect(s.writes).toEqual([]);
      expect((await orderAtHeadOffice())?.status).toBe('proposed');

      // With a reason → issued by the owner, through the one issue path.
      await box.locator('input.issue-reason').fill('checked against last week\'s sales');
      await box.locator('button.issue').click();
      await s.page.waitForFunction(() => /No purchase order is waiting to be issued\./.test((globalThis as unknown as { document: { getElementById(x: string): { textContent: string | null } | null } }).document.getElementById('orders-state')?.textContent ?? ''), undefined, { timeout: 20_000 });
      expect(s.writes).toEqual([`POST /v1/purchase/orders/${PO}/approval`]);
      const issued = await orderAtHeadOffice();
      expect(issued).toMatchObject({ status: 'issued', approvedBy: OWNER, requisitionedBy: MGR });
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  });
});

/**
 * D-010 on the owner's page: "Waiting for you" counts the order the manager raised, names it with its supplier and value,
 * and opens Approvals to issue it — the phone page itself decides nothing about it and writes nothing.
 */
describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('D-010: the owner\'s page counts a waiting purchase order under "Waiting for you"', () => {
  let browser: Browser;
  let shop: InboxShop;
  const as = (c: RealCloud, userId: string, path: string, body: unknown, key: string) => c.request({ method: 'POST', path, userId, body, idempotencyKey: key });

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'owner-app'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      // What the store computer injects for the owner's page: the person signed in, what they hold, and the branch's day.
      page: {
        path: '/owner', html: 'index.html', dataGlobal: 'ownerData', webDir: 'apps/owner-app/web',
        extraData: async () => ({ ownerId: OWNER, staleAfterSeconds: 3600, branches: [{ branchId: 'br-1', name: 'Store One', lastSyncedAt: new Date().toISOString(), sales: [], exceptions: [], approvals: [] }] }),
      },
      seed: async (c) => {
        await c.grant(ACCT, 'accountant', undefined, 'all');
        await c.grant(SEED_BUYER, 'store_manager', undefined, 'all');
        await ok(as(c, SEED_BUYER, '/v1/purchase/suppliers/sup-1', { name: 'Sri Foods (synthetic)' }, 'sup'), 'supplier');
        await ok(as(c, ACCT, '/v1/purchase/suppliers/sup-1/approval', { reason: 'documents checked' }, 'sup-ok'), 'supplier approved');
        await ok(as(c, OWNER, '/v1/catalogue/tax-classes/1006/rates/2017-07-01', { rateBps: 500 }, 'tax'), 'tax');
        await ok(as(c, OWNER, '/v1/catalogue/products/BISCUIT/publish', {
          product: { sku: 'SKU-BISCUIT', name: 'Marie biscuits (synthetic)', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active' },
          categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
        }, 'pub-biscuit'), 'publish biscuit');
      },
    });
    const raised = await shop.cloud().request({
      method: 'POST', path: `/v1/purchase/orders/${PO}`, userId: MGR, branchId: 'br-1', idempotencyKey: 'raise-d010-owner',
      body: { supplierId: 'sup-1', deliverToLocationId: 'br-1', lines: [{ productId: 'BISCUIT', orderedQty: 48, unitCost: { minor: 3_000, currency: 'INR' } }] },
    });
    if (raised.status >= 300) throw new Error(`raise: ${raised.status} ${JSON.stringify(raised.body)}`);
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('"Waiting for you (1)": the order by its number, supplier and value, opening Approvals; nothing written', async () => {
    const context = await browser.newContext();
    await shop.signIn(context, OWNER);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    try {
      await page.goto(`${shop.base}/owner`, { waitUntil: 'load' });
      const row = page.locator(`#approvals .order-to-issue[data-po="${PO}"]`);
      await row.waitFor({ timeout: 20_000 });
      expect(await page.textContent('#approvals-count')).toBe('(1)');
      expect(await row.innerText()).toMatch(new RegExp(`Purchase order · ${PO} · Sri Foods \\(synthetic\\)`));
      expect(await row.innerText()).toMatch(/₹1,440\.00/);
      expect(await row.innerText()).toMatch(new RegExp(`raised by ${MGR}`));
      expect(await row.locator('a.open-approvals').getAttribute('href')).toBe('../approvals');
      expect(writes).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
});
