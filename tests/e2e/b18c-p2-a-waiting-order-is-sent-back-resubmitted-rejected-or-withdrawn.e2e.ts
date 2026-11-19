import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import type { RealCloud } from '../support/real-store';

/**
 * **P2 · batch 18c — on the Approvals page, in a real browser, on the PRODUCTION API over real PostgreSQL:** a waiting
 * purchase order is SENT BACK with a note, CHANGED and RESUBMITTED by the manager who raised it, then REJECTED with a
 * reason; a second order is WITHDRAWN by its raiser (M06-FR-02 · pilot audit B-6 · OB-871).
 *
 * Every button sends one POST on an explicit click, and nothing without a written reason; what head office holds is read
 * back from head office, not from the page. Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const SHOTS = process.env['B18C_SHOTS'];
const KEY = ['b18c', 'p2', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const ACCT = 'u-acct-b18c';
const SEED_BUYER = 'u-seed-buyer-b18c';
const PO = 'PO-B18C-1';
const PO2 = 'PO-B18C-2';

interface Order { poId: string; status: string; totalMinor: number; lines: { productId: string; orderedQty: number }[]; proposalSteps?: { step: string; by: string; reason: string }[] }
type Doc = { getElementById(x: string): { textContent: string | null } | null };

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('P2: a waiting order is sent back, resubmitted, rejected or withdrawn on Approvals', () => {
  let browser: Browser;
  let shop: InboxShop;
  const as = (c: RealCloud, userId: string, path: string, body: unknown, key: string) => c.request({ method: 'POST', path, userId, body, idempotencyKey: key });
  const atHeadOffice = async (poId: string): Promise<Order | undefined> => ((await shop.cloud().request({ method: 'GET', path: '/v1/purchase/orders', userId: OWNER })).body as { orders: Order[] }).orders.find((o) => o.poId === poId);
  const raise = async (poId: string) => {
    const raised = await shop.cloud().request({
      method: 'POST', path: `/v1/purchase/orders/${poId}`, userId: MGR, branchId: 'br-1', idempotencyKey: `raise-${poId}`,
      body: { supplierId: 'sup-1', deliverToLocationId: 'br-1', lines: [
        { productId: 'BISCUIT', orderedQty: 48, unitCost: { minor: 3_000, currency: 'INR' } },
        { productId: 'RICE', orderedQty: 10, unitCost: { minor: 12_000, currency: 'INR' } },
      ] },
    });
    if (raised.status >= 300) throw new Error(`raise: ${raised.status} ${JSON.stringify(raised.body)}`);
  };

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    if (SHOTS !== undefined) mkdirSync(SHOTS, { recursive: true });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/approvals', html: 'approvals.html', dataGlobal: 'approvalsData' },
      seed: async (c) => {
        await c.grant(ACCT, 'accountant', undefined, 'all');
        await c.grant(SEED_BUYER, 'store_manager', undefined, 'all');
        await ok(as(c, SEED_BUYER, '/v1/purchase/suppliers/sup-1', { name: 'Sri Foods (synthetic)' }, 'sup'), 'supplier');
        await ok(as(c, ACCT, '/v1/purchase/suppliers/sup-1/approval', { reason: 'documents checked' }, 'sup-ok'), 'supplier approved');
        await ok(as(c, OWNER, '/v1/catalogue/tax-classes/1006/rates/2017-07-01', { rateBps: 500 }, 'tax'), 'tax');
        for (const [id, name] of [['BISCUIT', 'Marie biscuits (synthetic)'], ['RICE', 'Ponni rice (synthetic)']] as const) {
          await ok(as(c, OWNER, `/v1/catalogue/products/${id}/publish`, {
            product: { sku: `SKU-${id}`, name, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active' },
            categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
          }, `pub-${id}`), `publish ${id}`);
        }
      },
    });
    await raise(PO);
    await raise(PO2);
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    await shop.signIn(context, who, who === MGR ? 'br-1' : undefined);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/approvals`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };
  const box = (page: Page, list: string, poId: string) => page.locator(`#${list} li[data-po="${poId}"]`);
  const statusSays = (page: Page, id: string, re: RegExp) =>
    page.waitForFunction(([i, src]) => new RegExp(src as string).test((globalThis as unknown as { document: Doc }).document.getElementById(i as string)?.textContent ?? ''), [id, re.source], { timeout: 20_000 });
  const shot = async (page: Page, name: string) => { if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };

  it('the owner sends an order back with a note; the manager changes it and resubmits; the owner rejects it with a reason', async () => {
    let s = await open(OWNER);
    try {
      const b = box(s.page, 'orders', PO);
      await b.waitFor({ timeout: 20_000 });
      expect(await b.locator('button.send-back').count()).toBe(1);
      expect(await b.locator('button.reject').count()).toBe(1);
      await shot(s.page, 'p2-1-owner-sees-issue-send-back-reject');
      // No note → nothing is sent.
      await b.locator('button.send-back').click();
      await statusSays(s.page, `issue-status-${PO}`, /Write your reason or note first/);
      expect(s.writes).toEqual([]);
      await b.locator('input.issue-reason').fill('Too many biscuits — make it 24');
      await b.locator('button.send-back').click();
      await s.page.locator(`#orders li[data-po="${PO}"]`).waitFor({ state: 'detached', timeout: 20_000 });
      expect(s.writes).toEqual([`POST /v1/purchase/orders/${PO}/send-back`]);
      expect((await atHeadOffice(PO))?.status).toBe('sent_back');
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    s = await open(MGR);
    try {
      const b = box(s.page, 'sent-back', PO);
      await b.waitFor({ timeout: 20_000 });
      const text = await b.innerText();
      expect(text).toMatch(/Sent back by: u-owner|Sent back by: /);
      expect(text).toMatch(/Too many biscuits — make it 24/);
      expect(await s.page.locator('#sent-back-heading').textContent()).toBe('Orders sent back to you');
      await b.locator('tr[data-product="BISCUIT"] input.qty').fill('24');
      await shot(s.page, 'p2-2-manager-changes-the-sent-back-order');
      await b.locator('button.resubmit').click();
      await statusSays(s.page, `resubmit-status-${PO}`, /Write your reason or note first/);
      expect(s.writes).toEqual([]);
      await b.locator('input.resubmit-note').fill('Biscuits cut to 24');
      await b.locator('button.resubmit').click();
      await b.waitFor({ state: 'detached', timeout: 20_000 });
      expect(s.writes).toEqual([`POST /v1/purchase/orders/${PO}/resubmission`]);
      const po = await atHeadOffice(PO);
      expect(po?.status).toBe('proposed');
      expect(po?.lines.find((l) => l.productId === 'BISCUIT')?.orderedQty).toBe(24);
      expect(po?.totalMinor).toBe(24 * 3_000 + 10 * 12_000);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    s = await open(OWNER);
    try {
      const b = box(s.page, 'orders', PO);
      await b.waitFor({ timeout: 20_000 });
      expect(await b.innerText()).toMatch(/Resubmitted with changes: “Biscuits cut to 24”/);
      await b.locator('input.issue-reason').fill('Supplier price is higher than the market this week');
      await b.locator('button.reject').click();
      await b.waitFor({ state: 'detached', timeout: 20_000 });
      expect(s.writes).toEqual([`POST /v1/purchase/orders/${PO}/rejection`]);
      const po = await atHeadOffice(PO);
      expect(po?.status).toBe('rejected');
      expect(po?.proposalSteps?.map((x) => [x.step, x.by])).toEqual([['sent_back', OWNER], ['resubmitted', MGR], ['rejected', OWNER]]);
      await shot(s.page, 'p2-3-owner-rejected-it');
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  });

  it('the manager withdraws his own waiting order with a reason', async () => {
    const s = await open(MGR);
    try {
      const b = box(s.page, 'orders', PO2);
      await b.waitFor({ timeout: 20_000 });
      expect(await b.locator('button.issue').count()).toBe(0);
      await b.locator('button.withdraw').click();
      await statusSays(s.page, `withdraw-status-${PO2}`, /Write your reason or note first/);
      expect(s.writes).toEqual([]);
      await b.locator('input.withdraw-reason').fill('Raised twice by mistake');
      await shot(s.page, 'p2-4-manager-withdraws-his-order');
      await b.locator('button.withdraw').click();
      await b.waitFor({ state: 'detached', timeout: 20_000 });
      expect(s.writes).toEqual([`POST /v1/purchase/orders/${PO2}/withdrawal`]);
      expect((await atHeadOffice(PO2))?.status).toBe('withdrawn');
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  });
});
