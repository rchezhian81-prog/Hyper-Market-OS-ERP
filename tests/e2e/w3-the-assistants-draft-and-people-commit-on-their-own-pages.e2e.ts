import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { approveSupplierWith, SUPPLIER_MAKER, SUPPLIER_CHECKER } from '../support/approved-supplier';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import { shiftDate } from '../../packages/calendar/src/trading-day';
import { pinTheEveningClock, pinThePageClock, theEvening } from '../support/evening-clock';
import { confirmIt } from './lib/confirm-sheet';

/**
 * **The assistants draft on the AI page; PEOPLE act on their own pages — in a real browser, on the PRODUCTION API over real
 * PostgreSQL (A01 · A02 · A03 · roadmap §7 · P-05 · hard rule #5 · WF-03 · WF-07/M28 · AI-NFR-04).**
 *
 * Only the rule-based assistants run (no live model: OB-382 / OB-561 defer that to R8). Through Chromium:
 *
 *   • A01 (Owner Intelligence): the shop took ₹1,200 on the same weekday last week (milk ₹1,000 in dairy) and ₹600 so far
 *     today; on the AI page the owner reads A01's "likely because dairy took ₹1,000.00 less" draft — said as a likely cause,
 *     with what it rests on and what it cannot know — read-only, proposing nothing to do;
 *   • A02 (Purchase): cooking oil is out at br-1 and sold today; A02's draft shows on the AI page with its confidence and
 *     evidence and NO quantity. The br-1 manager raises a requisition from it on the Buying page's "from an assistant's
 *     purchase draft" form, naming how many himself; on the Requisitions page he records a quote and proposes the order from
 *     it; the OWNER issues it on the Buying page — the agent ordered nothing;
 *   • A03 (Inventory): a curd batch is past its date; A03's "Dispose" draft shows on the AI page; the br-1 manager records the
 *     write-off himself on the Record-a-write-off page — the agent wrote nothing off;
 *   • head office's register says committedAnything:false for every run; every order, requisition and loss is in a
 *     person's name.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['w3', 'assistants', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const TILL = 'u-till-w3';
// The shop's own dates (Asia/Kolkata, the shop calendar's zone) — never the UTC date. The clock is pinned to an evening UTC
// moment (01:00 the next morning in the shop), when the two dates differ, so the shop's small hours are proved every run.
const EVENING = theEvening();
const NOW = new Date(EVENING.at);
const TODAY = shopDateIn(NOW.toISOString());
const LAST_WEEK = shiftDate(TODAY, -7);
const EXPIRED_ON = shiftDate(TODAY, -5);

interface Proposal { proposalId: string; agent: string; summary: string; committed: boolean; outcome: unknown }

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('A01, A02 and A03 draft on the AI page; people act on their own pages (P-05 · hard rule #5)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const ran: Record<string, { proposals: Proposal[]; committedAnything: boolean; calledAModel?: boolean }> = {};

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    pinTheEveningClock(EVENING);
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/ai', html: 'ai.html', dataGlobal: 'aiData' },
      alsoPages: [
        { path: '/buying', html: 'buying.html', dataGlobal: 'buyingData', extraData: async (api) => ({ buyerId: ((await api('/v1/identity/me')) as { userId: string }).userId, productUoms: { 'P-OIL': 'ea' } }) },
        { path: '/requisitions', html: 'requisitions.html', dataGlobal: 'requisitionsData' },
        { path: '/write-off-capture', html: 'write-off-capture.html', dataGlobal: 'writeOffCaptureData' },
      ],
      seed: async (cloud) => {
        await cloud.grant(TILL, 'cashier');
        await cloud.grant(SUPPLIER_MAKER, 'store_manager');
        await cloud.grant(SUPPLIER_CHECKER, 'accountant');
        await approveSupplierWith((method, path, userId, body, idempotencyKey) => cloud.request({ method, path, userId, idempotencyKey, body }), 'sup-1');
        const owner = (path: string, body: unknown) => ok(cloud.request({ method: 'POST', path, userId: OWNER, idempotencyKey: `seed-${randomUUID()}`, body }), path);
        for (const [id, cat] of [['P-MILK', 'dairy'], ['P-RICE', 'grocery'], ['CURD', 'dairy']] as const) {
          await owner(`/v1/catalogue/products/${id}/publish`, { product: { sku: `SKU-${id}`, name: id, baseUom: 'ea', primaryCategoryId: cat, taxClass: '0401', lifecycle: 'active', handling: 'ambient' }, categories: [{ categoryId: cat, name: cat, parentId: null }] });
        }
        const received = (movementId: string, productId: string, qty: number, at: string, cost: number, batch?: { batchId: string; expiry: string }) =>
          owner('/v1/inventory/movements', { movementId, productId, locationId: 'br-1', kind: 'received', quantityMinor: qty, uom: 'ea', occurredAt: at, enteredBy: OWNER, unitCostMinor: cost, ...(batch ?? {}) });
        await received('mv-milk', 'P-MILK', 2, `${shiftDate(LAST_WEEK, -1)}T04:30:00.000Z`, 8_000);
        await received('mv-oil', 'P-OIL', 2, new Date(NOW.getTime() - 3_600_000).toISOString(), 15_000);
        // A03: a curd batch past its date, received well before it, still on hand.
        await received('mv-curd', 'CURD', 4, `${shiftDate(TODAY, -40)}T04:30:00.000Z`, 3_000, { batchId: 'B-OLD', expiry: EXPIRED_ON });
        const sale = (saleId: string, day: string, at: string, lines: { productId: string; qty: number; unit: number }[]) => {
          const total = lines.reduce((t, l) => t + l.qty * l.unit, 0);
          return ok(cloud.request({ method: 'POST', path: '/v1/sales', userId: TILL, idempotencyKey: `sale-${saleId}`, body: {
            saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', locationId: 'br-1', cashierId: TILL, tradingDay: day, committedAt: at, totalMinor: total, currency: 'INR', packVersion: 1,
            lines: lines.map((l) => ({ productId: l.productId, quantityMinor: l.qty, uom: 'ea', unitPriceMinor: l.unit, lineTotalMinor: l.qty * l.unit })), tenders: [{ kind: 'cash', amountMinor: total }],
          } }), `sale ${saleId}`);
        };
        // Last week, the same weekday, 10:00 at the shop: ₹1,200 (milk ₹1,000 in dairy). Today so far: ₹600, no milk.
        await sale('W-1', LAST_WEEK, `${LAST_WEEK}T04:30:00.000Z`, [{ productId: 'P-MILK', qty: 10, unit: 10_000 }, { productId: 'P-RICE', qty: 4, unit: 5_000 }]);
        await sale('T-1', TODAY, new Date(NOW.getTime() - 60_000).toISOString(), [{ productId: 'P-RICE', qty: 6, unit: 5_000 }, { productId: 'P-OIL', qty: 3, unit: 10_000 }]);
      },
    });
    const cloud = shop.cloud();
    // The owner switches the three rule-based assistants on (the fixture switched A06/A08/A10 on) with a spending limit.
    await ok(cloud.request({ method: 'PUT', path: '/v1/ai/budget', userId: OWNER, idempotencyKey: 'w3-budget', body: { capMinor: 100_000, periodEnds: '2099-01-31T18:29:00.000Z' } }), 'budget');
    await ok(cloud.request({ method: 'PUT', path: '/v1/ai/agents/enabled', userId: OWNER, idempotencyKey: 'w3-enable', body: { expected: ['A06', 'A08', 'A10'], agents: ['A01', 'A02', 'A03', 'A06', 'A08', 'A10'] } }), 'enable');
    for (const agent of ['A01', 'A02', 'A03']) {
      const r = await cloud.request({ method: 'POST', path: `/v1/ai/agents/${agent}/runs`, userId: OWNER, idempotencyKey: `w3-run-${agent}`, body: {} });
      if (r.status !== 200) throw new Error(`run ${agent}: ${r.status} ${JSON.stringify(r.body)}`);
      ran[agent] = r.body as (typeof ran)[string];
    }
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); vi.useRealTimers(); });

  const open = async (who: string, path: string, branch?: string) => {
    const context = await browser.newContext();
    await pinThePageClock(context);
    await shop.signIn(context, who, branch);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    return { page, writes, errors, close: async () => { await page.waitForLoadState('networkidle').catch(() => {}); await context.close(); } };
  };
  const says = async (page: Page, selector: string, expected: RegExp): Promise<void> => {
    try {
      await page.waitForFunction(([sel, source]) => new RegExp(source!).test((globalThis as unknown as { document: { querySelector(x: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''), [selector, expected.source], { timeout: 15_000 });
    } catch (e) {
      throw new Error(`${selector} never said ${String(expected)} — it says "${await page.locator(selector).first().textContent().catch(() => '(nothing)')}"`, { cause: e });
    }
  };
  const draftRow = async (page: Page, proposalId: string): Promise<string> => {
    const row = page.locator(`#queue-list .row[data-proposal="${proposalId}"]`);
    await row.waitFor({ timeout: 15_000 });
    return row.innerText();
  };
  const register = async () => (await shop.cloud().request({ method: 'GET', path: '/v1/ai/proposals', userId: OWNER })).body as { proposals: Proposal[]; committedAnything: boolean };

  it('every run is rule-based, calls no model and commits nothing', () => {
    for (const agent of ['A01', 'A02', 'A03']) {
      expect(ran[agent]!.committedAnything, agent).toBe(false);
      expect(ran[agent]!.proposals.every((p) => p.committed === false), agent).toBe(true);
    }
    expect(ran['A01']!.calledAModel).toBe(false);
  });

  it('A01: the owner reads a "likely because…" draft on the AI page — evidenced, with what it cannot know, read-only', async () => {
    const s = await open(OWNER, '/ai');
    try {
      await s.page.waitForFunction("document.body.dataset.aiControl === 'ok'", undefined, { timeout: 15_000 });
      await s.page.click('#tab-queue');
      const text = await draftRow(s.page, `a01-cause-department-${TODAY}`);
      expect(text).toContain(`Takings are down ₹600.00 on ${LAST_WEEK} (the same weekday last week) — likely because dairy took ₹1,000.00 less`);
      expect(text).toMatch(/Likely — check the evidence|Unsure — a guess to check/);
      expect(text).toContain('What it cannot know');
      expect(text).toMatch(/report sales_by_day — .*report units_by_category — dairy — taken/s);
      // O-2: "to act" in plain words — never a route; and A01 proposes no act at all.
      const toAct = (await s.page.locator(`#queue-list .row[data-proposal="a01-cause-department-${TODAY}"] .where`).textContent()) ?? '';
      expect(toAct).toMatch(/^To act on it: \S/);
      expect(toAct).not.toMatch(/\/v1\/|POST |GET /);
      expect(s.writes, 'reading the drafts writes nothing').toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 90_000);

  it('A02: the draft shows on the AI page; the manager raises a requisition from it, proposes the order; the owner issues it', async () => {
    const draftId = `a02-stockout-P-OIL-br-1-${TODAY}`;
    expect(ran['A02']!.proposals.map((p) => p.proposalId)).toContain(draftId);
    let s = await open(OWNER, '/ai');
    try {
      await s.page.waitForFunction("document.body.dataset.aiControl === 'ok'", undefined, { timeout: 15_000 });
      await s.page.click('#tab-queue');
      const text = await draftRow(s.page, draftId);
      expect(text).toContain('P-OIL is out of stock at br-1 (on hand -1) and sold 3 in the last 7 days');
      expect(text).toContain('how many is the buyer\'s decision');
      expect(text).toContain('What it cannot know');
      expect(text).toMatch(/inventory availability — P-OIL at br-1: on hand -1/);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // The manager (the buyer at br-1) raises the requisition FROM THE DRAFT on the Buying page, naming how many himself.
    s = await open(MGR, '/buying', 'br-1');
    try {
      await s.page.click('#tab-reorder');
      await s.page.fill('#dr-id', draftId);
      await s.page.fill('#dr-product', 'P-OIL');
      await s.page.click('#dr-raise');
      await says(s.page, '#dr-status', /^Write the draft number, the item and how many/);
      await s.page.fill('#dr-qty', '24');
      await s.page.click('#dr-raise');
      await says(s.page, '#dr-status', /^Requisition raised\./);
      expect(s.writes).toHaveLength(1);
      expect(s.writes[0]).toMatch(/^POST \/v1\/purchase\/requisitions\/rq-[A-Za-z0-9]+\/from-drafts$/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const reqs = (await shop.cloud().request({ method: 'GET', path: '/v1/purchase/requisitions', userId: OWNER })).body as { requisitions: { requisitionId: string; lines: { productId: string; quantity: number }[]; raisedBy: string; source: { kind: string; proposalIds?: string[] } }[] };
    expect(reqs.requisitions).toEqual([expect.objectContaining({ raisedBy: MGR, lines: [expect.objectContaining({ productId: 'P-OIL', quantity: 24 })], source: { kind: 'a02_draft', proposalIds: [draftId] } })]);
    const requisitionId = reqs.requisitions[0]!.requisitionId;
    expect(((await shop.cloud().request({ method: 'GET', path: '/v1/purchase/orders', userId: OWNER })).body as { orders: unknown[] }).orders, 'the draft and the requisition ordered nothing').toEqual([]);

    // On the Requisitions page: sup-1's quote, then the order PROPOSED from it — by the manager, not the assistant.
    s = await open(MGR, '/requisitions', 'br-1');
    try {
      const row = s.page.locator(`#list tr[data-requisition="${requisitionId}"]`);
      await row.waitFor({ timeout: 15_000 });
      expect(await row.innerText()).toContain('purchase-agent draft');
      await row.locator('button.open').click();
      await s.page.fill('#quote-id', 'q1');
      await s.page.fill('#quote-supplier', 'sup-1');
      await s.page.fill('#q-unit-0', '95');
      await s.page.fill('#q-lead-0', '2');
      await s.page.click('#record-quote');
      await says(s.page, '#page-status', /^Quote recorded\.$/);
      await s.page.locator('#order-quote option[value="sup-1|q1"]').waitFor({ state: 'attached', timeout: 15_000 });
      await s.page.selectOption('#order-quote', 'sup-1|q1');
      await s.page.fill('#order-store', 'br-1');
      await s.page.fill('#order-id', 'po-a02');
      await s.page.click('#raise-order');
      await says(s.page, '#page-status', /Order proposed — a second person issues it on the Buying page\. \(po-a02 · ₹2,280\.00\)/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // The OWNER issues it on the Buying page — a person's act, with a reason.
    s = await open(OWNER, '/buying');
    try {
      await s.page.click('#tab-budget');
      const box = s.page.locator('#waiting-orders [data-po="po-a02"]');
      await box.waitFor({ timeout: 15_000 });
      await box.locator('.issue-reason').fill('oil ran out; the buyer\'s own quantity from the assistant\'s draft');
      if (await box.locator('.over-reason').isVisible()) await box.locator('.over-reason').fill('no oil budget set yet; agreed with the buyer');
      await box.locator('button[data-act="issue"]').click();
      await says(s.page, '#budget-status', /^po-a02: Issued/);
      expect(s.writes).toEqual(['POST /v1/purchase/orders/po-a02/approval']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const po = (await shop.cloud().request({ method: 'GET', path: '/v1/purchase/orders/po-a02', userId: OWNER })).body as { order: Record<string, unknown> };
    expect(po.order).toMatchObject({ status: 'issued', requisitionId, requisitionedBy: MGR, approvedBy: OWNER, supplierId: 'sup-1' });
    expect((await register()).committedAnything).toBe(false);
  }, 180_000);

  it('A03: the "dispose" draft shows on the AI page; the manager records the write-off himself on its own page', async () => {
    const draftId = 'inv-dispose:B-OLD';
    expect(ran['A03']!.proposals.map((p) => p.proposalId)).toContain(draftId);
    let s = await open(OWNER, '/ai');
    try {
      await s.page.waitForFunction("document.body.dataset.aiControl === 'ok'", undefined, { timeout: 15_000 });
      await s.page.click('#tab-queue');
      const text = await draftRow(s.page, draftId);
      expect(text).toContain(`Dispose batch B-OLD of CURD — expired ${EXPIRED_ON}, 4 still on hand`);
      expect(text).toMatch(/near-expiry stock \(cloud ledger\) — CURD batch B-OLD: 4 on hand/);
      const toAct = (await s.page.locator(`#queue-list .row[data-proposal="${draftId}"] .where`).textContent()) ?? '';
      expect(toAct).toBe('To act on it: A person writes the stock off, with the usual write-off approval.');
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const before = (await shop.cloud().request({ method: 'GET', path: '/v1/inventory/write-offs', userId: OWNER })).body as { count: number };
    expect(before.count, 'the assistant wrote nothing off').toBe(0);

    s = await open(MGR, '/write-off-capture', 'br-1');
    try {
      await s.page.fill('#wo-product', 'CURD');
      await s.page.fill('#wo-location', 'br-1');
      await s.page.fill('#wo-qty', '4');
      await s.page.press('#wo-qty', 'Tab');
      await says(s.page, '#value-hint-text', /4 × ₹30\.00 = ₹120\.00/);
      await s.page.locator('#loss-types button.chip', { hasText: 'Expired' }).click();
      await s.page.locator('#reasons button.chip', { hasText: 'Past its date' }).click();
      await s.page.click('#record');
      await confirmIt(s.page); // U1 · OB-694: the sheet names the loss before it is recorded
      await says(s.page, '#result-text', /^Loss recorded/);
      expect(s.writes).toHaveLength(1);
      expect(s.writes[0]).toMatch(/^POST \/v1\/inventory\/write-off\//);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const after = (await shop.cloud().request({ method: 'GET', path: '/v1/inventory/write-offs', userId: OWNER })).body as { count: number; writeOffs?: { raisedBy?: string; productId?: string }[] };
    expect(after.count).toBe(1);
    expect((await register()).committedAnything).toBe(false);
  }, 120_000);
});
