import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/day-book';

/**
 * **The Month-end page, in a real browser, on the PRODUCTION API over real PostgreSQL (M23-FR-01/03/04 · WF-18 ·
 * D10-FR-03/05 · OB-55 · OB-56 · OB-57 · OB-67 · OB-69).**
 *
 * The page is served in front of the real API (no stub); who is looking comes from head office's own `GET /v1/identity/me`;
 * every `/v1` call goes to the API under the signed-in person's token. Through Chromium:
 *
 *   • CARD AND UPI WITH NO ANSWER — a UPI attempt the store raised the moment the machine gave no answer (OB-69) and two card
 *     attempts a day close carried (OB-55, its approver flagged by head office) are listed once each, with the open totals.
 *     The accountant's "nothing found, report not complete" is refused in head office's words (still unknown — it stays
 *     open); the provider's complete record settles the card. Two people settle the UPI item from two screens at once with
 *     DIFFERENT answers: the first stands, the second is refused in head office's words, and the conflict is shown on the
 *     item — as is a conflict two different store relays made (hard rule #10);
 *   • THE MONTH-END STOCK ADJUSTMENT — the valuation names what blocks it: rice on hand with no buying cost (by its name
 *     for the owner), the count difference and the write-off not in the books; the post is refused in head office's words;
 *     once they are dealt with, the page posts ONE adjustment, and a second press posts nothing;
 *   • THE PROFIT AND LOSS — read from the books: sales, cost of goods sold, gross margin;
 *   • BUDGET AND ASSETS — the accountant saves a budget (a duplicated account is refused in head office's words), adds a
 *     freezer to the register (a clashing re-add is refused), and runs depreciation: the acquisition and a FULL month's
 *     depreciation from the month it went into service (OB-67); a re-run posts nothing;
 *   • everything read back from head office after a RESTART of the API; Tamil labels; no page errors;
 *   • permissions — a cashier is told their role cannot read the month-end and nothing is fetched or written; a store
 *     manager reads it and is offered no change (head office refuses their post and settle, 403). Nothing is written on open.
 *
 * Synthetic data, a fresh tenant. Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['finance', 'close', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const ACCT = 'u-acct';
const CASHIER = 'u-cash';
const BOX = 'u-box';
/** A store manager for every store — the one who decides the count and writes off at store-1. */
const SM = 'u-sm';
const PERIOD = new Date().toISOString().slice(0, 7);
const TODAY = new Date().toISOString().slice(0, 10);

interface Row { attemptId: string; state: string; conflicts: unknown[]; resolution: { paid: boolean } | null }

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Month-end page on the production API, in a real browser (M23 · WF-18 · D10)', () => {
  let browser: Browser;
  let shop: InboxShop;
  let n = 0;
  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown) =>
    shop.cloud().request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `fc-${n += 1}-${randomUUID()}` }) });
  const receive = (id: string, productId: string, qty: number, unitCostMinor?: number) => ok(call('POST', '/v1/inventory/movements', OWNER, {
    movementId: id, productId, locationId: 'store-1', kind: 'received', quantityMinor: qty, uom: 'each', occurredAt: `${TODAY}T03:00:00.000Z`, enteredBy: OWNER,
    ...(unitCostMinor === undefined ? {} : { unitCostMinor }),
  }), id);

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/finance-close', html: 'finance-close.html', dataGlobal: 'financeCloseData', extraData: async () => ({ period: PERIOD }) },
      seed: async (cloud) => {
        await cloud.grant(ACCT, 'accountant');
        await cloud.grant(CASHIER, 'cashier');
        await cloud.grant(BOX, 'store_computer', undefined, ['store-1']);
        await cloud.grant(SM, 'store_manager');
        const req = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown) =>
          cloud.request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `seed-${randomUUID()}` }) });
        // ── Payments: one UPI no-answer raised at once (OB-69); two cards carried by a day close (OB-55), approver unknown.
        await ok(req('POST', '/v1/finance/payment-exceptions/PAY-R1/no-answer/synced', BOX, {
          storeId: 'store-1', laneId: 'lane-1', billRef: 'B-11', kind: 'upi', amountMinor: 41_000, askedAt: `${TODAY}T05:00:00.000Z`, tradingDay: TODAY, recordedAt: `${TODAY}T05:01:00.000Z`, recordedBy: 'u-lanecash',
        }), 'raise');
        const pay = (attemptId: string, amountMinor: number, billRef: string) => ({ attemptId, laneId: 'lane-1', billRef, kind: 'card', amountMinor, askedAt: `${TODAY}T06:00:00.000Z`, state: 'no_answer', tradingDay: TODAY });
        await ok(req('POST', '/v1/pos/day-close/dc-1/synced', BOX, {
          dayCloseId: 'dc-1', storeId: 'store-1', tradingDay: TODAY, closedBy: MGR, closedAt: `${TODAY}T20:00:00.000Z`, locked: true,
          carriedForward: { approvalId: 'apr-1', approvedBy: 'u-stranger', reason: 'card provider down', payments: [pay('PAY-C1', 64_000, 'B-12'), pay('PAY-C2', 30_000, 'B-13')], unresolvedMinor: { card: 94_000, upi: 0 } },
        }), 'close');
        // Two store relays with different answers for PAY-C2: the first stands; the second is a visible conflict.
        await ok(req('POST', '/v1/finance/payment-exceptions/PAY-C2/resolved/synced', BOX, { paid: true, detail: 'provider says captured' }), 'relay 1');
        const second = await req('POST', '/v1/finance/payment-exceptions/PAY-C2/resolved/synced', BOX, { paid: false, detail: 'provider says declined' });
        if (second.status !== 409) throw new Error(`the second, different answer should be refused: ${second.status}`);
        // ── Stock and books (OB-56): oil 10 @ ₹50; rice 5 with NO cost; one oil sold; a count finds one short; one written off.
        for (const [id, name] of [['p-oil', 'Groundnut oil 1L'], ['p-rice', 'Ponni rice 5kg']] as const) {
          await ok(req('POST', `/v1/catalogue/products/${id}/publish`, OWNER, { product: { sku: id.toUpperCase(), name, baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'draft' }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }), `publish ${id}`);
        }
        await ok(req('POST', '/v1/inventory/movements', OWNER, { movementId: 'rcv-oil', productId: 'p-oil', locationId: 'store-1', kind: 'received', quantityMinor: 10, uom: 'each', occurredAt: `${TODAY}T03:00:00.000Z`, enteredBy: OWNER, unitCostMinor: 5_000 }), 'oil');
        await ok(req('POST', '/v1/inventory/movements', OWNER, { movementId: 'rcv-rice', productId: 'p-rice', locationId: 'store-1', kind: 'received', quantityMinor: 5, uom: 'each', occurredAt: `${TODAY}T03:00:00.000Z`, enteredBy: OWNER }), 'rice');
        await ok(req('POST', '/v1/sales', OWNER, {
          saleId: 'S1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: OWNER, locationId: 'store-1', tradingDay: TODAY, committedAt: `${TODAY}T04:00:00.000Z`,
          totalMinor: 10_500, currency: 'INR', packVersion: 1,
          lines: [{ productId: 'p-oil', quantityMinor: 1, uom: 'each', unitPriceMinor: 10_500, lineTotalMinor: 10_500, taxRateBps: 500 }],
          tenders: [{ kind: 'cash', amountMinor: 10_500 }],
        }), 'sale');
        const counted = await req('POST', '/v1/inventory/counts/C1', OWNER, { productId: 'p-oil', locationId: 'store-1', uom: 'each', countedMinor: 8, reasonCode: 'cycle_count' });
        if (counted.status >= 300) throw new Error(`count: ${counted.status} ${JSON.stringify(counted.body)}`);
        if ((counted.body as { pendingApproval?: boolean }).pendingApproval) await ok(req('POST', '/v1/inventory/counts/C1/decide', SM, { decision: 'approved', reason: 'recounted' }), 'decide');
        await ok(req('POST', '/v1/inventory/write-off/W1', SM, { productId: 'p-oil', locationId: 'store-1', qty: 1, uom: 'each', lossType: 'damage', reasonCode: 'damage' }), 'write-off');
        await ok(req('PUT', '/v1/finance/posting-map', OWNER, DEFAULT_RETAIL_POSTING_MAP), 'map');
        await ok(req('POST', `/v1/finance/day-book/${TODAY}/post`, OWNER), 'day book');
        const suggested = ((await req('GET', '/v1/finance/account-classes', OWNER)).body as { suggested: Record<string, string> }).suggested;
        await ok(req('PUT', '/v1/finance/account-classes', OWNER, { classes: suggested }), 'classes');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who, who === MGR ? 'br-1' : undefined);
    const page = await context.newPage();
    const writes: string[] = []; const reads: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (!u.pathname.startsWith('/v1/')) return; (r.method() === 'GET' ? reads : writes).push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/finance-close`, { waitUntil: 'load' });
    return { page, writes, reads, errors, close: () => context.close() };
  };
  const says = async (page: Page, selector: string, expected: RegExp): Promise<void> => {
    await page.waitForFunction(([sel, source]) => new RegExp(source!).test((globalThis as unknown as { document: { querySelector(x: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''), [selector, expected.source], { timeout: 15_000 });
  };
  const item = (attemptId: string) => `#pay-list li[data-attempt="${attemptId}"]`;
  const settle = async (page: Page, attemptId: string, found: string, complete: boolean, amount?: string): Promise<void> => {
    const li = page.locator(item(attemptId));
    // Open the drawer unless it is open already (a refused answer leaves it open with what was typed).
    if (!(await li.locator('details.resolve').evaluate((d) => (d as unknown as { open: boolean }).open))) await li.locator('details.resolve summary').click();
    await li.locator('select.found').selectOption(found);
    if (amount !== undefined) await li.locator('input.amount').fill(amount);
    await li.locator('input.at').fill(`${TODAY}T10:00`);
    if (complete) await li.locator('input.complete').check();
    await li.locator('button.go').click();
  };
  const exceptions = async (): Promise<Row[]> => ((await call('GET', '/v1/finance/payment-exceptions', ACCT)).body as { exceptions: Row[] }).exceptions;

  it('card and UPI with no answer: listed once each with totals and flags; refused, settled, and two different answers shown as a conflict', async () => {
    const a = await open(ACCT);
    const b = await open(OWNER);
    try {
      await a.page.locator(item('PAY-C1')).waitFor({ timeout: 15_000 });
      expect(a.writes, 'nothing is written on open').toEqual([]);
      expect(await a.page.locator('#pay-list > li').count()).toBe(3);
      expect(await a.page.locator('[data-tile="open"] b').innerText()).toBe('2');
      expect(await a.page.locator('[data-tile="card"] b').innerText()).toBe('₹640.00');
      expect(await a.page.locator('[data-tile="upi"] b').innerText()).toBe('₹410.00');
      expect(await a.page.locator(item('PAY-R1')).innerText()).toMatch(/UPI ₹410\.00[\s\S]*Open — no answer yet[\s\S]*Raised by the store when the machine gave no answer/);
      expect(await a.page.locator(item('PAY-C1')).innerText()).toMatch(/Carried by the day close · day closed by u-mgr-br1 · carried on the approval of u-stranger · why: card provider down[\s\S]*Head office found: the approver does not hold the authority/);
      // The conflict two different store relays made: the first answer stands, the second is shown.
      expect(await a.page.locator(item('PAY-C2')).innerText()).toMatch(/Settled — the provider took the money[\s\S]*Two different answers — the first stands: Standing: Settled — the provider took the money\. Another answer \(store_computer, u-box\) said: Settled — the provider did not take the money\./);
      expect(await a.page.locator(`${item('PAY-C2')} details.resolve`).count(), 'a settled item offers no settling').toBe(0);

      // Nothing found and the report not complete: head office refuses — it stays open.
      await settle(a.page, 'PAY-C1', 'nothing', false);
      await says(a.page, '#pay-status', /^Head office refused: .*does not settle payment PAY-C1 — it stays open on the exception list/);
      // The provider's complete record: money taken — settled.
      await settle(a.page, 'PAY-C1', 'captured', true);
      await says(a.page, '#pay-status', /^Settled — head office kept the provider's answer\./);
      await says(a.page, item('PAY-C1'), /Settled — the provider took the money/);

      // Two people settle PAY-R1 from two screens at once, with different answers: the first stands; the second is refused
      // in head office's words and the conflict is shown on the item.
      await b.page.locator(item('PAY-R1')).waitFor({ timeout: 15_000 });
      await settle(a.page, 'PAY-R1', 'captured', true);
      await says(a.page, '#pay-status', /^Settled/);
      await settle(b.page, 'PAY-R1', 'declined', true);
      await says(b.page, '#pay-status', /^Head office refused: Payment PAY-R1 was already resolved as paid .* recorded as a conflict on the exception list\./);
      await says(b.page, item('PAY-R1'), /Two different answers — the first stands: Standing: Settled — the provider took the money\. Another answer \(provider_record, u-owner\) said: Settled — the provider did not take the money\./);
      expect(a.writes).toEqual(['POST /v1/finance/payment-exceptions/PAY-C1/resolve', 'POST /v1/finance/payment-exceptions/PAY-C1/resolve', 'POST /v1/finance/payment-exceptions/PAY-R1/resolve']);
      expect(a.errors).toEqual([]); expect(b.errors).toEqual([]);
    } finally { await a.close(); await b.close(); }

    // Head office's own record, not the page.
    const rows = await exceptions();
    expect(rows.map((r) => [r.attemptId, r.state, r.conflicts.length]).sort()).toEqual([['PAY-C1', 'resolved_paid', 0], ['PAY-C2', 'resolved_paid', 1], ['PAY-R1', 'resolved_paid', 1]]);
  }, 120_000);

  it('the month-end stock adjustment: blockers named, refused in head office\'s words, then posted once; the P&L shows gross margin', async () => {
    // The owner sees rice by its NAME (the owner reads the catalogue).
    let s = await open(OWNER);
    try {
      await s.page.click('#tab-stock');
      await says(s.page, '#stock-blockers', /Ponni rice 5kg at store-1: 5 each on hand with no buying cost/);
      expect(await s.page.locator('#stock-blockers li[data-kind="outstanding"]').allInnerTexts()).toEqual(['Not in the books yet: count:C1', 'Not in the books yet: write_off:W1']);
      await s.page.click('#post-adjustment');
      await says(s.page, '#post-status', /^Head office refused: 2 count difference\(s\), write-off\(s\) or shortfall\(s\) of .* are not in the books yet: count:C1, write_off:W1/);
      expect(s.writes).toEqual([`POST /v1/finance/periods/${PERIOD}/stock-adjustment`]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // A store manager cannot post — head office refuses it (and the page does not offer it to them: see the last test).
    expect((await call('POST', `/v1/finance/periods/${PERIOD}/stock-adjustment`, MGR, {})).status).toBe(403);
    // The count and the write-off go into the books; rice gets its cost.
    await ok(call('POST', '/v1/finance/stock-adjustments/post', OWNER, {}), 'post count and write-off');
    await receive('rcv-rice-2', 'p-rice', 5, 1_000);

    s = await open(ACCT);
    try {
      await s.page.click('#tab-stock');
      await says(s.page, '#stock-blockers', /Nothing blocks the adjustment\./);
      expect(await s.page.locator('[data-tile="closing"] b').innerText()).toBe('₹450.00'); // oil 7 @ ₹50, rice 10 @ ₹10
      expect(await s.page.locator('[data-tile="cogs"] b').innerText()).toBe('₹50.00');
      await s.page.click('#post-adjustment');
      await says(s.page, '#post-status', /^Posted — one journal for the month\./);
      await says(s.page, '#stock-posted', /Already posted for this month — nothing posted twice\. posted by u-acct\./);
      expect(await s.page.locator('#post-adjustment').isHidden()).toBe(true);

      await s.page.click('#tab-pl');
      await says(s.page, '#pl-tiles', /Gross margin/);
      expect(await s.page.locator('[data-tile="margin"] b').innerText()).toBe('₹50.00 (50.0%)');
      expect(await s.page.locator('#pl-table tr[data-account="cost_of_goods_sold"]').innerText()).toMatch(/₹50\.00/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const ledger = (await call('GET', `/v1/finance/periods/${PERIOD}/stock-valuation`, ACCT)).body as { posted: { entryId: string; postedBy: string } | null };
    expect(ledger.posted).toMatchObject({ entryId: `stock-period:${PERIOD}`, postedBy: ACCT });
    // Posted once: the same post again is the same journal, nothing booked twice.
    expect(await call('POST', `/v1/finance/periods/${PERIOD}/stock-adjustment`, ACCT, {})).toMatchObject({ status: 200, body: { alreadyPosted: true } });
  }, 120_000);

  it('budget and assets: a budget version, a freezer on the register, a full month of depreciation; refusals in head office\'s words; all read back after a restart', async () => {
    let s = await open(ACCT);
    try {
      await s.page.click('#tab-plan');
      await says(s.page, '#budget-status', /No budget set for this month\./);
      // A duplicated account is refused by head office.
      await s.page.locator('#budget-lines .b-account').first().fill('sales_revenue');
      await s.page.locator('#budget-lines .b-amount').first().fill('150');
      await s.page.click('#budget-add-line');
      await s.page.locator('#budget-lines .b-account').nth(1).fill('sales_revenue');
      await s.page.locator('#budget-lines .b-amount').nth(1).fill('40');
      await s.page.click('#budget-save');
      await says(s.page, '#budget-save-status', /^Head office refused: A budget is .* each account once\./);
      await s.page.locator('#budget-lines .b-account').nth(1).fill('cost_of_goods_sold');
      await s.page.fill('#budget-reason', 'first month on the new system');
      await s.page.click('#budget-save');
      await says(s.page, '#budget-save-status', /^Saved — head office kept the new version\./);
      await says(s.page, '#budget-status', /version 1 · u-acct/);
      expect(await s.page.locator('#budget-table tr[data-account="sales_revenue"]').innerText()).toMatch(/₹150\.00[\s\S]*₹100\.00[\s\S]*−₹50\.00/);

      // The freezer: ₹12,000, nothing left at the end, 12 months, in service mid-month.
      await s.page.click('#asset-add summary');
      for (const [id, v] of [['#a-id', 'FA-FRZ-1'], ['#a-name', 'Chest freezer'], ['#a-category', 'refrigeration'], ['#a-store', 'store-1'], ['#a-cost', '12000'], ['#a-salvage', '0'], ['#a-life', '12']] as const) await s.page.fill(id, v);
      await s.page.fill('#a-in', `${PERIOD}-15`);
      await s.page.click('#asset-add-go');
      await says(s.page, '#asset-add-status', /^Added — head office kept it\./);
      await s.page.fill('#a-cost', '15000');
      await s.page.click('#asset-add-go');
      await says(s.page, '#asset-add-status', /^Head office refused: FA-FRZ-1 is already on the register with other figures\. A register entry is never edited\./);
      // The run: the acquisition and ONE FULL month (OB-67: from the month it went into service, even mid-month).
      await s.page.click('#run-depreciation');
      await says(s.page, '#run-status', /^2 journal\(s\) posted\./);
      await says(s.page, '#assets-list li[data-asset="FA-FRZ-1"]', /₹1,000\.00 a month · depreciated so far ₹1,000\.00 · worth in the books ₹11,000\.00/);
      await s.page.click('#run-depreciation');
      await says(s.page, '#run-status', /^Nothing new to post/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // ── A restart of the API: everything is head office's, read back.
    await shop.restart();
    s = await open(ACCT);
    try {
      await s.page.locator(item('PAY-R1')).waitFor({ timeout: 15_000 });
      await says(s.page, item('PAY-R1'), /Two different answers — the first stands/);
      await s.page.click('#tab-stock');
      await says(s.page, '#stock-posted', /Already posted for this month/);
      await s.page.click('#tab-plan');
      await says(s.page, '#budget-status', /version 1 · u-acct · .* · first month on the new system/);
      await says(s.page, '#assets-list li[data-asset="FA-FRZ-1"]', /worth in the books ₹11,000\.00/);
      // In Tamil too.
      await s.page.click('#lang');
      expect(await s.page.locator('#title').innerText()).toBe('மாத இறுதி');
      expect(await s.page.locator('#tab-payments .t').innerText()).toBe('பதில் இல்லாத கார்டு, யுபிஐ');
      expect(await s.page.locator('#run-depreciation').innerText()).toBe('இந்த மாதத்துக்குத் தேய்மானம் இயக்கு');
      expect(s.writes, 'reading after a restart writes nothing').toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const assets = (await call('GET', '/v1/finance/fixed-assets', ACCT)).body as { assets: { assetId: string; costMinor: number; depreciationPostedMinor: number }[] };
    expect(assets.assets).toEqual([expect.objectContaining({ assetId: 'FA-FRZ-1', costMinor: 1_200_000, depreciationPostedMinor: 100_000 })]);
    const budget = (await call('GET', `/v1/finance/budgets/${PERIOD}`, ACCT)).body as { budget: { version: number; lines: unknown[] } };
    expect(budget.budget).toMatchObject({ version: 1, lines: [{ account: 'sales_revenue', amountMinor: 15_000 }, { account: 'cost_of_goods_sold', amountMinor: 4_000 }] });
  }, 150_000);

  it('a cashier is told their role cannot read the month-end; a store manager reads it and is offered no change; nothing is written', async () => {
    let s = await open(CASHIER);
    try {
      await says(s.page, '#page-status', /Your role cannot read the month-end books\./);
      expect(await s.page.locator('#tabs').isHidden()).toBe(true);
      expect(await s.page.locator('#view-payments').isHidden()).toBe(true);
      expect(s.reads.filter((r) => r.includes('/v1/finance/')), 'the cashier reads nothing').toEqual([]);
      expect(s.writes).toEqual([]);
      await s.page.click('#lang');
      await says(s.page, '#page-status', /உங்கள் பங்கால் மாத இறுதிக் கணக்குகளைப் படிக்க முடியாது\./);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect((await call('GET', '/v1/finance/payment-exceptions', CASHIER)).status).toBe(403);

    // The store manager holds the finance read (not the post, the settle or the budget): reads, and is offered no change.
    s = await open(MGR);
    try {
      await says(s.page, '#page-status', /You can read this; changing it needs another role\./);
      await s.page.locator(item('PAY-C1')).waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#pay-list details.resolve').count()).toBe(0);
      await s.page.click('#tab-stock');
      await says(s.page, '#stock-tiles', /Closing stock/);
      expect(await s.page.locator('#post-adjustment').isHidden()).toBe(true);
      await s.page.click('#tab-plan');
      await says(s.page, '#assets-list', /Chest freezer|Nothing on the register yet/);
      expect(await s.page.locator('#budget-edit').isHidden()).toBe(true);
      expect(await s.page.locator('#asset-add').isHidden()).toBe(true);
      expect(await s.page.locator('#run-depreciation').isHidden()).toBe(true);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    // Head office refuses the manager's post and settle directly too.
    expect((await call('POST', `/v1/finance/fixed-assets/depreciation/${PERIOD}`, MGR, {})).status).toBe(403);
    expect((await call('POST', '/v1/finance/payment-exceptions/PAY-C1/resolve', MGR, { authorisations: [], statementComplete: true })).status).toBe(403);
  }, 60_000);
});
