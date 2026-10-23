import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { Tally } from './lib/tally';
import type { RealCloud } from '../support/real-store';

/**
 * **The open-to-buy panel on the Buying page, in a real browser, on the PRODUCTION API over real PostgreSQL (WF-03 ·
 * D02-FR-01 · D03-FR-01 · M06-FR-01 "PO above limit escalates" · OB-63 "Owner only" · round 12).**
 *
 * The Buying page is served in front of the real API (no stub) with what the store computer injects for it — the signed-in
 * buyer and what they hold, read here from head office's own `GET /v1/identity/me`; every `/v1` call goes to the API under
 * that person's token. Through Chromium:
 *
 *   • opening the page and the Budget tab writes nothing;
 *   • the owner sets the month's grocery budget, then a new figure that supersedes it — the old one stays on record and
 *     the panel says so; budget, committed, waiting and open-to-buy are head office's figures;
 *   • the br-1 manager raises an order over that budget: head office proposes it (never refused at the desk) and the page
 *     says it escalates — only the owner can issue it (OB-63); the manager is offered no budget setting and no issuing;
 *   • the owner issues it: without an over-budget reason head office refuses, in its words; with one it issues, and the
 *     override (who, why, by how much) and the category now over budget are on the panel;
 *   • after a RESTART of the API all of it reads back from head office; Tamil labels; no page errors.
 *
 * Purchase-order AMENDMENTS do not appear on this page (no screen amends an order), so there is no amendment refusal to show.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['open', 'to', 'buy', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const ACCT = 'u-acct-otb';
const SEED_BUYER = 'u-seed-buyer';
const MONTH = new Date().toISOString().slice(0, 7);

interface Order { poId: string; status: string; requisitionedBy: string; approvedBy: string | null; totalMinor: number }

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the open-to-buy panel on the Buying page, on the production API, in a real browser (WF-03 · D02-FR-01 · OB-63)', () => {
  let browser: Browser;
  let shop: InboxShop;

  const as = (c: RealCloud, userId: string, path: string, body: unknown, key: string) => c.request({ method: 'POST', path, userId, body, idempotencyKey: key });
  const ordersAtHeadOffice = async (): Promise<Order[]> => ((await shop.cloud().request({ method: 'GET', path: '/v1/purchase/orders', userId: OWNER })).body as { orders: Order[] }).orders;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      // What the store computer injects for the Buying page: the signed-in person as the buyer, with what they hold.
      page: { path: '/buying', html: 'buying.html', dataGlobal: 'buyingData', extraData: async (api) => ({ buyerId: ((await api('/v1/identity/me')) as { userId: string }).userId }) },
      seed: async (c) => {
        await c.grant(ACCT, 'accountant', undefined, 'all');
        await c.grant(SEED_BUYER, 'store_manager', undefined, 'all');
        await ok(as(c, OWNER, '/v1/org/nodes/C-E2E', { kind: 'company', name: 'Synthetic Retail' }, 'org-c'), 'company');
        await ok(as(c, OWNER, '/v1/org/nodes/br-1', { kind: 'branch', name: 'Store One', parentId: 'C-E2E', companyId: 'C-E2E' }, 'org-br1'), 'store');
        await ok(as(c, SEED_BUYER, '/v1/purchase/suppliers/sup-1', { name: 'Synthetic supplier one' }, 'sup'), 'supplier');
        await ok(as(c, ACCT, '/v1/purchase/suppliers/sup-1/approval', { reason: 'documents checked' }, 'sup-ok'), 'supplier approved');
        await ok(as(c, OWNER, '/v1/catalogue/tax-classes/1006/rates/2017-07-01', { rateBps: 500 }, 'tax'), 'tax');
        await ok(as(c, OWNER, '/v1/catalogue/products/RICE/publish', {
          product: { sku: 'SKU-RICE', name: 'Ponni rice (synthetic)', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active' },
          categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
        }, 'pub-rice'), 'publish rice');
        // QG-02 (OB-288 gates lane): a second category, so an order WITHIN budget can be approved and its taps counted.
        await ok(as(c, OWNER, '/v1/catalogue/products/SOAP/publish', {
          product: { sku: 'SKU-SOAP', name: 'Bath soap (synthetic)', baseUom: 'ea', primaryCategoryId: 'household', taxClass: '1006', lifecycle: 'active' },
          categories: [{ categoryId: 'household', name: 'Household', parentId: null }],
        }, 'pub-soap'), 'publish soap');
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
    return { page, writes, errors, close: () => context.close() };
  };
  const says = async (page: Page, id: string, expected: RegExp): Promise<void> => {
    try {
      await page.waitForFunction(([i, source]) => new RegExp(source!).test((globalThis as unknown as { document: { getElementById(x: string): { textContent: string | null } | null } }).document.getElementById(i!)?.textContent ?? ''), [id, expected.source], { timeout: 15_000 });
    } catch (e) {
      throw new Error(`#${id} never said ${String(expected)} — it says "${await page.locator(`#${id}`).textContent()}"`, { cause: e });
    }
  };
  const row = (page: Page, category: string) => page.locator(`#otb-table tr[data-category="${category}"]`);
  const setBudget = async (page: Page, category: string, amount: string, reason: string): Promise<void> => {
    await page.fill('#budget-category', category);
    await page.fill('#budget-amount', amount);
    await page.fill('#budget-reason', reason);
    await page.click('#budget-save');
  };

  it('the owner sets and supersedes a budget; the manager\'s order over it escalates to the owner; the owner issues it only with a reason; all of it survives a restart', async () => {
    // ── The owner: budgets ──────────────────────────────────────────────────────────────────────────────────────
    let s = await open(OWNER);
    try {
      await s.page.click('#tab-budget');
      await says(s.page, 'budget-history', /No budget has been set for this month/);
      expect(await s.page.inputValue('#budget-period')).toBe(MONTH);
      expect(s.writes, 'nothing is written on open or on reading the panel').toEqual([]);
      await setBudget(s.page, 'grocery', '1000', 'October grocery plan');
      await says(s.page, 'budget-set-status', /^Budget set — head office kept it\./);
      await row(s.page, 'grocery').waitFor({ timeout: 15_000 });
      await setBudget(s.page, 'grocery', '1200', 'festival uplift');
      await says(s.page, 'budget-set-status', /replaces the earlier figure, which stays on record/);
      await says(s.page, 'budget-history', /grocery · ₹1,000\.00 · set by u-owner · “October grocery plan” — replaced by a later figure/);
      expect(await s.page.locator('#budget-history .version[data-superseded="false"]').innerText()).toMatch(/₹1,200\.00 · set by u-owner · “festival uplift”/);
      await s.page.waitForFunction(() => /₹1,200\.00/.test((globalThis as unknown as { document: { querySelector(x: string): { textContent: string | null } | null } }).document.querySelector('#otb-table tr[data-category="grocery"]')?.textContent ?? ''), undefined, { timeout: 15_000 });
      expect(await row(s.page, 'grocery').getAttribute('data-state')).toBe('within');
      // A figure that is not money never leaves the page.
      await setBudget(s.page, 'grocery', 'ten', 'x');
      await says(s.page, 'budget-set-status', /The amount is not an amount of money/);
      expect(s.writes).toEqual(['POST /v1/purchase/budgets', 'POST /v1/purchase/budgets']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // ── The br-1 manager raises an order over the budget: proposed, and it escalates to the owner (OB-63) ──────────
    s = await open(MGR);
    let poId = '';
    try {
      await s.page.click('#tab-po');
      await s.page.fill('#po-supplier', 'sup-1');
      await s.page.fill('#po-store', 'br-1');
      await s.page.fill('#po-product', 'RICE');
      await s.page.fill('#po-qty', '30');
      await s.page.fill('#po-cost', '50');
      await s.page.click('#add-po-line');
      await s.page.click('#raise-po');
      await says(s.page, 'banner-title', /^Order proposed — over this month's budget by ₹300\.00/);
      expect(await s.page.textContent('#banner-text')).toMatch(/Only the owner can issue an order over budget, with a reason \(OB-63\)/);
      await s.page.click('#banner-ok');
      poId = (await ordersAtHeadOffice()).find((o) => o.status === 'proposed')?.poId ?? '';
      expect(poId).toMatch(/^PO-/);
      await s.page.click('#tab-budget');
      await s.page.locator(`#waiting-orders .escalation.over[data-po="${poId}"]`).waitFor({ timeout: 15_000 });
      expect(await s.page.locator(`#waiting-orders [data-po="${poId}"]`).innerText()).toMatch(/Over budget by ₹300\.00 \(grocery\)\. This order is over the budget: it goes to the owner\./);
      // The manager may read the budgets but is offered neither setting one nor issuing an order.
      expect(await s.page.locator('#budget-set').isHidden()).toBe(true);
      await says(s.page, 'budget-set-not', /Setting a budget is the owner's/);
      expect(await s.page.locator('#waiting-orders button[data-act="issue"]').count()).toBe(0);
      expect(s.writes).toEqual([`POST /v1/purchase/orders/${poId}`]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // ── The owner issues it: no over-budget reason → head office refuses in its words; with one → issued, recorded ─────
    s = await open(OWNER);
    try {
      await s.page.click('#tab-budget');
      const box = s.page.locator(`#waiting-orders [data-po="${poId}"]`);
      await box.waitFor({ timeout: 15_000 });
      await box.locator('.issue-reason').fill('weekly replenishment');
      await box.locator('button[data-act="issue"]').click();
      await says(s.page, `issue-status-${poId}`, new RegExp(`^Head office refused: Purchase order ${poId} is over budget \\(grocery by 30000 \\(budget 120000, committed 0, this order 150000\\)\\); issuing it needs an over-budget reason on the record\\.`));
      expect(((await ordersAtHeadOffice()).find((o) => o.poId === poId))?.status, 'refused: nothing issued').toBe('proposed');
      await box.locator('.over-reason').fill('Diwali stock-up agreed with the buyer');
      await box.locator('button[data-act="issue"]').click();
      await says(s.page, 'budget-status', new RegExp(`^${poId}: Issued over budget — head office recorded the reason\\.`));
      await says(s.page, 'budget-overrides', new RegExp(`${poId} · Over budget by ₹300\\.00 · let through by u-owner · because “Diwali stock-up agreed with the buyer”`));
      expect(await row(s.page, 'grocery').getAttribute('data-state')).toBe('over');
      await says(s.page, 'waiting-orders', /No orders are waiting for approval this month/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // ── Head office's own record, after a RESTART of the API, read back on the page ──────────────────────────────────
    await shop.restart();
    expect((await ordersAtHeadOffice()).find((o) => o.poId === poId)).toMatchObject({ status: 'issued', requisitionedBy: MGR, approvedBy: OWNER, totalMinor: 150_000 });
    const otb = (await shop.cloud().request({ method: 'GET', path: `/v1/purchase/open-to-buy?period=${MONTH}`, userId: OWNER })).body as { categories: { categoryId: string; budgetMinor: number; committedMinor: number; openToBuyMinor: number; state: string }[] };
    expect(otb.categories.find((c) => c.categoryId === 'grocery')).toMatchObject({ budgetMinor: 120_000, committedMinor: 150_000, openToBuyMinor: -30_000, state: 'over' });
    s = await open(OWNER);
    try {
      await s.page.click('#tab-budget');
      await row(s.page, 'grocery').waitFor({ timeout: 15_000 });
      expect(await row(s.page, 'grocery').innerText()).toMatch(/₹1,200\.00\s+₹1,500\.00\s+₹0\.00\s+−₹300\.00/);
      await says(s.page, 'budget-overrides', new RegExp(`${poId} · Over budget by ₹300\\.00`));
      expect(await s.page.locator('#budget-history .version').count()).toBe(2);
      // Tamil.
      await s.page.click('#lang');
      await s.page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(x: string): { getAttribute(a: string): string | null } | null } }).document.getElementById('tab-budget')?.getAttribute('aria-label') === 'பட்ஜெட் (வாங்க மீதம்)', undefined, { timeout: 15_000 });
      expect(await s.page.textContent('#budget-title')).toBe('பட்ஜெட் (வாங்க மீதம்)');
      expect(await row(s.page, 'grocery').innerText()).toMatch(/பட்ஜெட்டை மீறியது/);
      expect(s.writes, 'reading back writes nothing').toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 180_000);

  it('QG-02 — approve a purchase order within budget in 3 (Budget tab → why it is approved → Issue); head office records the owner as approver', async () => {
    // The manager raises a small household order (no household budget is over).
    let s = await open(MGR);
    let poId = '';
    try {
      await s.page.click('#tab-po');
      await s.page.fill('#po-supplier', 'sup-1');
      await s.page.fill('#po-store', 'br-1');
      await s.page.fill('#po-product', 'SOAP');
      await s.page.fill('#po-qty', '2');
      await s.page.fill('#po-cost', '50');
      await s.page.click('#add-po-line');
      await s.page.click('#raise-po');
      await says(s.page, 'banner-title', /^Order proposed/);
      await s.page.click('#banner-ok');
      poId = (await ordersAtHeadOffice()).find((o) => o.status === 'proposed' && o.totalMinor === 10_000)?.poId ?? '';
      expect(poId).toMatch(/^PO-/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // The owner approves (issues) it — every interaction counted with the same Tally as the till and the handhelds.
    s = await open(OWNER);
    try {
      const taps = new Tally(s.page);
      await taps.tap('#tab-budget');
      const box = s.page.locator(`#waiting-orders [data-po="${poId}"]`);
      await box.waitFor({ timeout: 15_000 });
      expect(await box.locator('.over-reason').isHidden(), 'within budget: no over-budget reason is asked for').toBe(true);
      await taps.type(`#waiting-orders [data-po="${poId}"] .issue-reason`, 'weekly household top-up');
      await taps.tap(`#waiting-orders [data-po="${poId}"] button[data-act="issue"]`);
      await says(s.page, 'budget-status', new RegExp(`^${poId}: `));
      expect(taps.reset(), 'approve a PO').toBeLessThanOrEqual(3);
      expect(((await ordersAtHeadOffice()).find((o) => o.poId === poId))).toMatchObject({ status: 'issued', requisitionedBy: MGR, approvedBy: OWNER });
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 180_000);
});
