import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { says } from './lib/r4c-box-page';
import { STORE_RULES } from '../support/store-rules';
import { shiftDate } from '../../packages/calendar/src/trading-day';
import { theEvening, pinTheEveningClock, pinThePageClock } from '../support/evening-clock';
import { confirmIt } from './lib/confirm-sheet';

/**
 * **W7 · A03 (Inventory agent: markdown SUGGESTIONS — a manager commits) · P-05 · hard rule #5 · D06-FR-05 — ONE connected run:
 * an A03 MARKDOWN draft on the AI page is taken by the store manager to a price change that goes through the price approval,
 * in real browsers, on the PRODUCTION API over real PostgreSQL.** Only the rule-based assistant runs (no live model, OB-382 /
 * OB-561). Synthetic data, a fresh tenant.
 *   • the bread batch B-7 (100 on hand) is two days from its date at br-1; the owner runs A03 and it drafts "Mark down batch
 *     B-7 of p-bread" — citing the batch on the cloud ledger, with how sure it is and what it cannot know, and "To act on it:
 *     A manager changes the price, with the usual price approval." Running it changed no price and committed nothing;
 *   • the br-1 manager reads that draft on the AI page and approves it there — a decision on record that commits nothing
 *     (head office says "Nothing has happened yet"); the shelf price is still ₹50.00;
 *   • she opens Change a price for the bread herself and enters ₹37.50 — under the owner's 20% margin floor, so it needs a
 *     second person: she asks, the OWNER approves in his own session, and only then does her save go through — head office's
 *     price is ₹37.50, saved by her and approved by him; the assistant's register still says committedAnything:false.
 * The clock is pinned to an evening UTC moment (the shop's date is ahead of UTC then): batch dates and prices are the
 * shop's days. Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['w7', 'a03', 'markdown', 'key'].join('-').padEnd(48, '0');
const STORE = 'br-1';
const EVENING = theEvening();
const TODAY = EVENING.shopDate;
const EXPIRES = shiftDate(TODAY, 2);
const DRAFT = 'inv-markdown:B-7';
const BREAD = { sku: 'BREAD-400', name: 'Milk bread 400g', baseUom: 'ea', primaryCategoryId: 'bakery', taxClass: '1905', lifecycle: 'active' };

interface Proposal { proposalId: string; agent: string; summary: string; committed: boolean; wouldRequire: string }

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('A03: a markdown draft on the AI page becomes a price change only through the price approval (P-05 · hard rule #5)', () => {
  let browser: Browser;
  let shop: InboxShop;
  let run: { proposals: Proposal[]; committedAnything: boolean } = { proposals: [], committedAnything: true };
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) =>
    shop.cloud().request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: randomUUID() }) });
  const shelf = async (): Promise<number> => ((await call('GET', `/v1/prices/list/p-bread/resolve?storeId=${STORE}&at=${encodeURIComponent(new Date().toISOString())}`, OWNER)).body as { priceMinor: number }).priceMinor;
  const register = async () => (await call('GET', '/v1/ai/proposals', OWNER)).body as { proposals: Proposal[]; committedAnything: boolean };

  beforeAll(async () => {
    pinTheEveningClock(EVENING);
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/ai', html: 'ai.html', dataGlobal: 'aiData' },
      alsoPages: [{
        path: '/catalogue', html: 'catalogue.html', dataGlobal: 'catalogueData',
        extraData: async (api) => ({ storeId: STORE, today: TODAY, now: new Date().toISOString(), marginFloorBps: 2_000, costsMinor: { 'p-bread': 3_500 },
          products: ((await api('/v1/catalogue/products')) as { products?: unknown[] }).products ?? [] }),
      }],
      seed: async (cloud) => {
        const req = (path: string, body: unknown) => cloud.request({ method: 'POST', path, userId: OWNER, body, idempotencyKey: `seed-${randomUUID()}` });
        await ok(req('/v1/catalogue/tax-classes/1905/rates/2017-07-01', { rateBps: 500 }), 'tax');
        await ok(req('/v1/catalogue/products/p-bread/publish', { product: { ...BREAD, mrpHistory: [{ value: { minor: 6_000, currency: 'INR' }, effectiveFrom: '2026-01-01' }] }, categories: [{ categoryId: 'bakery', name: 'Bakery', parentId: null }] }), 'publish bread');
        await ok(req('/v1/prices/list/p-bread/entries/e1', { scope: 'store', scopeRef: STORE, priceMinor: 5_000, mrpMinor: 6_000, costMinor: 3_500, marginFloorBps: 0, currency: 'INR', effectiveFrom: TODAY }), 'bread price');
        // The bread batch B-7: 100 received yesterday, two days from its date — on the cloud ledger A03 reads.
        await ok(req('/v1/inventory/movements', { movementId: 'rx-bread-b7', productId: 'p-bread', locationId: STORE, kind: 'received', quantityMinor: 100, uom: 'ea', occurredAt: new Date(Date.now() - 86_400_000).toISOString(), enteredBy: OWNER, unitCostMinor: 3_500, batchId: 'B-7', expiry: EXPIRES }), 'bread batch');
        // The owner's margin floor at the store: 20% — the marked-down bread will sit under it.
        await ok(req(`/v1/stores/${STORE}/rules`, { ...STORE_RULES, marginFloorBps: 2_000 }), 'rules');
      },
    });
    const cloud = shop.cloud();
    await ok(cloud.request({ method: 'PUT', path: '/v1/ai/budget', userId: OWNER, idempotencyKey: 'w7-budget', body: { capMinor: 100_000, periodEnds: '2099-01-31T18:29:00.000Z' } }), 'budget');
    await ok(cloud.request({ method: 'PUT', path: '/v1/ai/agents/enabled', userId: OWNER, idempotencyKey: 'w7-enable', body: { expected: ['A06', 'A08', 'A10'], agents: ['A03', 'A06', 'A08', 'A10'] } }), 'enable A03');
    const r = await cloud.request({ method: 'POST', path: '/v1/ai/agents/A03/runs', userId: OWNER, idempotencyKey: 'w7-run-A03', body: {} });
    if (r.status !== 200) throw new Error(`run A03: ${r.status} ${JSON.stringify(r.body)}`);
    run = r.body as typeof run;
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
    page.on('request', (q) => { const u = new URL(q.url()); if (u.pathname.startsWith('/v1/') && q.method() !== 'GET') writes.push(`${q.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    return { page, writes, errors, close: async () => { await page.waitForLoadState('networkidle').catch(() => {}); await context.close(); } };
  };

  it('A03 drafts the markdown and commits nothing; the manager approves the draft, then changes the price herself through the second-person approval', async () => {
    // ── A03's run: a markdown draft for B-7, naming the price route a manager uses — and nothing committed.
    expect(run.committedAnything).toBe(false);
    const draft = run.proposals.find((p) => p.proposalId === DRAFT);
    expect(draft, JSON.stringify(run.proposals.map((p) => p.proposalId))).toBeDefined();
    expect(draft).toMatchObject({ agent: 'A03', committed: false, wouldRequire: 'POST /v1/prices/changes' });
    expect(await shelf()).toBe(5_000);

    // ── The br-1 manager reads the draft on the AI page and approves it there — a decision that commits nothing.
    const ai = await open(MGR, '/ai');
    await ai.page.waitForFunction("document.body.dataset.aiControl === 'ok'", undefined, { timeout: 15_000 });
    await ai.page.click('#tab-queue');
    const row = ai.page.locator(`#queue-list .row[data-proposal="${DRAFT}"]`);
    await row.waitFor({ timeout: 15_000 });
    const text = await row.innerText();
    expect(text).toContain(`Mark down batch B-7 of p-bread — expires ${EXPIRES} in 2 day(s), 100 on hand`);
    expect(text).toMatch(/near-expiry stock \(cloud ledger\) — p-bread batch B-7: 100 on hand/);
    expect(text).toContain('What it cannot know');
    expect(await row.locator('.where').textContent()).toBe('To act on it: A manager changes the price, with the usual price approval.');
    await row.locator('button', { hasText: 'Approve' }).click();
    await says(ai.page, `#queue-list .row[data-proposal="${DRAFT}"]`, new RegExp(`approved by ${MGR}`));
    expect(ai.writes).toEqual([`POST /v1/ai/proposals/${encodeURIComponent(DRAFT)}/outcome`]);
    expect(await shelf(), 'approving the draft changed no price').toBe(5_000);
    expect(ai.errors).toEqual([]);
    await ai.close();

    // ── She takes it to Change a price herself: ₹37.50 sits under the 20% floor, so it needs a second person.
    const c = await open(MGR, '/catalogue?tab=price&product=p-bread');
    await c.page.waitForSelector('#view-price:not([hidden])');
    expect(await c.page.inputValue('#price-item')).toBe('BREAD-400');
    await c.page.fill('#new-price', '37.50');
    await c.page.press('#new-price', 'Tab');
    await c.page.waitForSelector('#price-approval:not([hidden])');
    await c.page.fill('#price-why', `A03 draft ${DRAFT}: batch B-7 has two days left, 100 on hand.`);
    await c.page.click('#ask-price');
    await says(c.page, '#banner-title', /\S/);
    type Inbox = { waitingForMe: { requestId: string; kind: string; subjectRef: string }[] };
    let asked: Inbox = { waitingForMe: [] };
    await expect.poll(async () => {
      asked = (await call('GET', '/v1/approvals/requests', OWNER)).body as Inbox;
      return asked.waitingForMe.some((q) => q.kind === 'price_change' && q.subjectRef.includes('p-bread'));
    }, { message: 'the price change waits for the owner', timeout: 15_000 }).toBe(true);
    const request = asked.waitingForMe.find((q) => q.kind === 'price_change' && q.subjectRef.includes('p-bread'))!;
    expect(await shelf(), 'asking changed no price').toBe(5_000);
    // The owner approves exactly this price change in his own session; only then does her save go through.
    await ok(call('POST', `/v1/approvals/requests/${request.requestId}/decide`, OWNER, { decision: 'approved', reason: 'the batch has two days left' }), 'owner approves');
    await c.page.click('#banner-ok');
    await c.page.click('#save-price');
    await confirmIt(c.page); // U1 · OB-698: the consequence-and-confirm sheet before the price is saved
    await says(c.page, '#banner-title', /^Price saved$/);
    expect(c.writes).toEqual(['POST /v1/approvals/requests', 'POST /v1/prices/changes']);
    await expect.poll(shelf).toBe(3_750);
    expect(c.errors).toEqual([]);
    await c.close();

    // The assistant committed nothing; the decision on its draft is the manager's, and committed nothing either.
    const reg = await register();
    expect(reg.committedAnything).toBe(false);
    expect(reg.proposals.every((p) => p.committed === false)).toBe(true);
    const decided = (reg.proposals as unknown as { proposalId: string; outcome: { decision: string; by: string } | null }[]).find((p) => p.proposalId === DRAFT);
    expect(decided?.outcome).toMatchObject({ decision: 'approved', by: MGR });
  }, 180_000);
});
