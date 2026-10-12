import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { storeSealer } from '../support/store-seal';

/**
 * **The Count plans page, in a real browser, on the PRODUCTION API over real PostgreSQL (WF-08 · D05-FR-05 · M09-FR-04 ·
 * OB-59 · OB-66 · §28 · hard rules #2 #10).**
 *
 * The page is served in front of the real API (no stub); who is looking comes from head office's own `GET /v1/identity/me`,
 * and every `/v1` call goes to the API under the signed-in person's token. Through Chromium:
 *
 *   • the br-1 manager plans a count of P1 and P2 at br-1 with the freeze left on the owner's default — the page says
 *     "adjustments, write-offs (the owner's default, OB-59)" and head office kept `frozenByDefault` — and opens it;
 *   • he counts both blind from the sheet; a damaged unit arriving on a floor indent is HELD on the plan (OB-66) and a
 *     write-off the manager approved on the floor is RELAYED by the store computer — kept, shown as a freeze exception,
 *     and P1 must be counted again; his approval is refused in head office's words (lines not ready);
 *   • a second manager recounts both and names the causes; her own approval is refused in head office's words (§28);
 *   • after an API RESTART the first manager reads it all back and approves: head office posts one correction per line,
 *     the held write-off is applied once, and on-hand follows; a second plan freezing nothing is cancelled;
 *   • a cashier is told their role cannot read count plans (head office refuses them too); the page has Tamil words.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['count', 'plans', 'e2e', 'production', 'signing', 'key'].join('-').padEnd(48, '0');
const MGR2 = 'u-mgr2'; const CASHIER = 'u-cash-cp'; const BOX = 'u-box-cp'; const FLOOR = 'u-floor-cp'; const BACK = 'u-back-cp';
const minuteAgo = (): string => new Date(Date.now() - 60_000).toISOString();

interface PlanRec { planId: string; state: string; frozenKinds: string[]; frozenByDefault?: boolean; recountThresholdMinor: number; plannedBy: string; approvedBy?: string }
interface View { plan: PlanRec; lines: { productId: string; state: string; recountBecause: string[]; varianceMinor: number }[]; freezeBreaches: { movementId: string; kind: string }[]; heldWriteOffs: { heldId: string; state: string }[] }

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Count plans page on the production API, in a real browser (WF-08 · D05-FR-05)', () => {
  let browser: Browser;
  let shop: InboxShop;
  let planId = '';

  const get = async (path: string, userId = OWNER) => (await shop.cloud().request({ method: 'GET', path, userId })).body;
  const plansAtHeadOffice = async (): Promise<PlanRec[]> => (await get('/v1/inventory/count-plans') as { plans: PlanRec[] }).plans;
  const viewAtHeadOffice = async (id: string): Promise<View> => await get(`/v1/inventory/count-plans/${id}`) as View;
  const onHand = async (productId: string): Promise<number> => ((await get(`/v1/inventory/availability?productId=${productId}`)) as { rows: { locationId: string; onHandMinor: number }[] }).rows.filter((r) => r.locationId === 'br-1').reduce((s, r) => s + r.onHandMinor, 0);
  const post = (path: string, userId: string, body: unknown) => ok(shop.cloud().request({ method: 'POST', path, userId, idempotencyKey: `k-${randomUUID()}`, body }), path);

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/count-plans', html: 'count-plans.html', dataGlobal: 'countPlansData' },
      seed: async (cloud) => {
        await cloud.grant(CASHIER, 'cashier');
        for (const u of [MGR2, FLOOR, BACK]) await cloud.grant(u, 'store_manager');
        await cloud.grant(BOX, 'store_computer', undefined, ['br-1']);
        const p = (path: string, userId: string, body: unknown) => ok(cloud.request({ method: 'POST', path, userId, idempotencyKey: `seed-${randomUUID()}`, body }), path);
        await p('/v1/org/nodes/C1', OWNER, { kind: 'company', name: 'SRE Retail' });
        await p('/v1/org/nodes/br-1', OWNER, { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' });
        await p('/v1/org/nodes/br-1-back', OWNER, { kind: 'warehouse', name: 'Store 1 back store', parentId: 'br-1', companyId: 'C1' });
        // P1 100 @ ₹1.00 and P2 20 @ ₹10.00 on the floor; P2 10 in the back store.
        for (const [id, product, loc, qty, cost] of [['s-p1', 'P1', 'br-1', 100, 100], ['s-p2', 'P2', 'br-1', 20, 1_000], ['s-p2b', 'P2', 'br-1-back', 10, 1_000]] as const) {
          await p('/v1/inventory/movements', OWNER, { movementId: id, productId: product, locationId: loc, kind: 'received', quantityMinor: qty, uom: 'EA', occurredAt: minuteAgo(), enteredBy: OWNER, unitCostMinor: cost });
        }
        // The back store sends 6 of P2 to the floor on an indent — on the road when the count opens.
        await p('/v1/floor/indents/ind-1', MGR2, { fromLocationId: 'br-1-back', toLocationId: 'br-1', lines: [{ productId: 'P2', quantityMinor: 6, uom: 'EA' }], reason: 'shelf 4 empty' });
        await p('/v1/floor/indents/ind-1/approval', OWNER, {});
        await p('/v1/floor/indents/ind-1/issues/is-1', BACK, { lines: [{ productId: 'P2', batchId: null, quantityMinor: 6 }] });
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
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname.replace(/cp-\d{8}-[a-z0-9]+(-P\d-[a-z0-9]+)?/g, (m) => (m.includes('-P') ? 'cp-…-count' : 'cp-…'))}`); });
    await page.goto(`${shop.base}/count-plans`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };
  const says = async (page: Page, id: string, expected: RegExp): Promise<void> => {
    await page.waitForFunction(([i, source]) => new RegExp(source!).test((globalThis as unknown as { document: { getElementById(x: string): { textContent: string | null } | null } }).document.getElementById(i!)?.textContent ?? ''), [id, expected.source], { timeout: 15_000 });
  };
  const lineState = (page: Page, product: string, state: string) => page.locator(`#d-lines li[data-product="${product}"][data-state="${state}"]`).waitFor({ timeout: 15_000 });
  const countOnSheet = async (page: Page, product: string, qty: string): Promise<void> => {
    const li = page.locator(`#d-sheet li[data-product="${product}"]`);
    await li.locator('input.qty').fill(qty);
    await li.locator('button[data-act="count"]').click();
    await says(page, 'd-status', /^(Done — head office recorded it\.|Head office refused)/);
    expect(await page.locator('#d-status').innerText()).toBe('Done — head office recorded it.');
  };
  const viewPlan = async (page: Page, id: string): Promise<void> => {
    await page.locator(`#register tbody tr[data-plan="${id}"] button[data-act="view"]`).click();
    await says(page, 'd-title', new RegExp(`^${id}$`));
    await page.locator('#d-lines li').first().waitFor({ timeout: 15_000 });
  };

  it('the br-1 manager plans a count on the owner\'s default freeze, opens it, and counts blind; a held write-off and a relayed freeze exception show; his early approval is refused in head office\'s words', async () => {
    const s = await open(MGR);
    try {
      await says(s.page, 'register', /No count plans yet/);
      expect(s.writes, 'nothing is written on open').toEqual([]);
      // Refused locally before any POST: no products named.
      await s.page.fill('#place', 'br-1');
      await s.page.fill('#threshold', '20');
      await s.page.click('#create');
      await says(s.page, 'create-status', /^Name at least one product\./);
      expect(s.writes).toEqual([]);
      // The real one — head office answers with the plan it kept.
      await s.page.fill('#products', 'P1\nP2');
      const answered = s.page.waitForResponse((r) => r.request().method() === 'POST' && r.status() === 201 && r.url().includes('/v1/inventory/count-plans/'));
      await s.page.click('#create');
      const made = (await (await answered).json()) as { plan: PlanRec };
      planId = made.plan.planId;
      expect(made.plan).toMatchObject({ state: 'planned', plannedBy: MGR, frozenKinds: ['adjusted', 'wasted'], frozenByDefault: true, recountThresholdMinor: 2_000 });
      await says(s.page, 'd-freeze', /^Frozen while counting: Adjustments, Write-offs \(the owner's default, OB-59\)\. Till sales and returns are never frozen\./);
      await s.page.click('#d-open');
      await says(s.page, 'd-state', /^Counting — frozen/);

      // Blind counts from the sheet: P1 97 of 100 (−3, ₹3 — under the ₹20 threshold); P2 22.
      expect(await s.page.locator('#d-sheet').innerText()).not.toMatch(/Expected|expected/);
      await countOnSheet(s.page, 'P1', '97');
      await countOnSheet(s.page, 'P2', '22');

      // The trolley arrives at the floor: 5 good, 1 damaged — the damaged write-off is HELD on the plan (OB-66).
      await post('/v1/floor/indents/ind-1/issues/is-1/receipt', FLOOR, { counted: [{ productId: 'P2', batchId: null, quantityMinor: 5, damagedMinor: 1 }] });
      // A write-off of one P1 the manager approved on the floor, RELAYED by the store computer — kept, never refused.
      await post('/v1/inventory/adjustment-requests/ar-p1/synced', BOX, { requestId: 'ar-p1', productId: 'P1', locationId: 'br-1', binId: null, deltaMinor: -1, uom: 'EA', reasonCode: 'damaged', requestedBy: FLOOR, at: new Date().toISOString(), storeId: 'br-1', source: 'warehouse-handheld' });
      await post('/v1/approvals/decisions/ap-p1/synced', BOX, storeSealer(KEY).decision(shop.cloud().tenantId, 'ApprovalDecided', {
        id: 'ap-p1', subjectType: 'stock_adjustment', subjectRef: 'ar-p1', requestedBy: FLOOR, branchId: 'br-1', value: null, status: 'approved', decidedBy: MGR, reason: 'checked on the floor', decidedAt: new Date().toISOString(), storeId: 'br-1', source: 'manager-screen',
      }));

      await s.page.reload({ waitUntil: 'load' });
      await viewPlan(s.page, planId);
      await lineState(s.page, 'P1', 'recount_required');
      expect(await s.page.locator('#d-lines li[data-product="P1"]').innerText()).toMatch(/Recount needed[\s\S]*a frozen movement landed after it was counted/);
      await lineState(s.page, 'P2', 'recount_required');
      expect(await s.page.locator('#d-lines li[data-product="P2"]').innerText()).toMatch(/difference at or over the recount threshold/);
      await s.page.locator('#d-breaches li[data-movement="adj-req:ar-p1"]').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#d-breaches').innerText()).toMatch(/P1 — Write-offs \(-1\)/);
      expect(await s.page.locator('#d-held li[data-state="awaiting_close"]').innerText()).toMatch(/P2 — 1 ea · ₹10\.00[\s\S]*Held until the count closes/);

      // Approving now is refused in head office's own words — nothing posts.
      await s.page.fill('#d-reason', 'aisle 4 done');
      await s.page.click('#d-approve');
      await says(s.page, 'd-status', /^Head office refused: Not every line is ready: P1 recount_required \(moved_during_freeze\); P2 recount_required \(over_recount_threshold\)/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const v = await viewAtHeadOffice(planId);
    expect(v.plan.state).toBe('counting');
    expect(v.freezeBreaches.map((b) => [b.movementId, b.kind])).toEqual([['adj-req:ar-p1', 'wasted']]);
    expect(v.heldWriteOffs.map((h) => h.state)).toEqual(['awaiting_close']);
    expect([await onHand('P1'), await onHand('P2')]).toEqual([99, 25]);
  }, 180_000);

  it('a second manager recounts and names the causes; her own approval is refused (§28) in head office\'s words', async () => {
    const s = await open(MGR2);
    try {
      await s.page.locator(`#register tbody tr[data-plan="${planId}"]`).waitFor({ timeout: 15_000 });
      expect(s.writes).toEqual([]);
      await viewPlan(s.page, planId);
      // P1: 96 of the 99 head office now expects (−3); P2: 24 of 25 (−1).
      await countOnSheet(s.page, 'P1', '96');
      await countOnSheet(s.page, 'P2', '24');
      for (const [product, cause, note] of [['P1', 'miscount', 'front row counted twice'], ['P2', 'theft_suspected', 'one tin missing from the front']] as const) {
        await lineState(s.page, product, 'cause_required');
        const li = s.page.locator(`#d-lines li[data-product="${product}"]`);
        await li.locator('select').selectOption(cause);
        await li.locator('input').fill(note);
        await li.locator('button[data-act="cause"]').click();
        await lineState(s.page, product, 'ready');
      }
      await s.page.fill('#d-reason', 'aisle 4 done');
      await s.page.click('#d-approve');
      await says(s.page, 'd-status', new RegExp(`^Head office refused: ${MGR2} counted P1, P2 and cannot approve their own variance \\(§28\\)\\.`));
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect((await viewAtHeadOffice(planId)).plan.state).toBe('counting');
  }, 120_000);

  it('after an API restart the first manager reads it back and approves: one correction per line, the held write-off applied once; a plan freezing nothing is cancelled', async () => {
    await shop.restart();
    const s = await open(MGR);
    try {
      await s.page.locator(`#register tbody tr[data-plan="${planId}"][data-state="counting"]`).waitFor({ timeout: 15_000 });
      await viewPlan(s.page, planId);
      await lineState(s.page, 'P1', 'ready');
      await lineState(s.page, 'P2', 'ready');
      expect(await s.page.locator('#d-lines li[data-product="P2"]').innerText()).toMatch(/Expected 25 · Counted 24 · Difference -1 · Value −₹10\.00[\s\S]*Cause: Theft suspected — one tin missing from the front/);
      const answered = s.page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/approve'));
      await s.page.fill('#d-reason', 'aisle 4 done');
      await s.page.click('#d-approve');
      const body = (await (await answered).json()) as { posted: { productId: string; varianceMinor: number }[]; heldWriteOffsApplied: { heldId: string }[]; plan: PlanRec };
      expect(body.plan).toMatchObject({ state: 'approved', approvedBy: MGR });
      expect(body.posted.map((p) => [p.productId, p.varianceMinor])).toEqual([['P1', -3], ['P2', -1]]);
      expect(body.heldWriteOffsApplied).toHaveLength(1);
      await says(s.page, 'd-state', /^Approved — corrections posted/);
      await s.page.locator('#d-held li[data-state="applied"]').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#d-approve').isHidden()).toBe(true);
      await s.page.click('#d-close');

      // A second plan that freezes nothing — said on the plan — then cancelled with a reason.
      await s.page.fill('#place', 'br-1');
      await s.page.fill('#products', 'P1');
      await s.page.fill('#threshold', '5');
      await s.page.check('input[name="freeze"][value="none"]');
      await s.page.click('#create');
      await says(s.page, 'd-freeze', /^Freezes nothing\./);
      await s.page.click('#d-cancel');
      await says(s.page, 'd-status', /^Write a reason first\./);
      await s.page.fill('#d-reason', 'counted by the auditors instead');
      await s.page.click('#d-cancel');
      await says(s.page, 'd-state', /^Cancelled — nothing posted/);
      expect(s.writes).toEqual(['POST /v1/inventory/count-plans/cp-…/approve', 'POST /v1/inventory/count-plans/cp-…', 'POST /v1/inventory/count-plans/cp-…/cancel']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    // Head office's own record: the ledger followed once; the held write-off is applied; the second plan cancelled.
    expect([await onHand('P1'), await onHand('P2')]).toEqual([96, 24]);
    expect((await viewAtHeadOffice(planId)).heldWriteOffs.map((h) => h.state)).toEqual(['applied']);
    const plans = await plansAtHeadOffice();
    expect(plans.map((p) => [p.state, p.frozenKinds])).toEqual([['cancelled', []], ['approved', ['adjusted', 'wasted']]]);
  }, 180_000);

  it('a cashier is told their role cannot read count plans (head office refuses them too), offered nothing, and the page speaks Tamil', async () => {
    expect((await shop.cloud().request({ method: 'GET', path: '/v1/inventory/count-plans', userId: CASHIER })).status).toBe(403);
    const s = await open(CASHIER);
    try {
      await says(s.page, 'list-status', /Your role cannot read count plans/);
      expect(await s.page.locator('#new-section').isHidden()).toBe(true);
      await s.page.click('#lang');
      expect(await s.page.locator('#title').innerText()).toBe('எண்ணிக்கைத் திட்டங்கள்');
      expect(await s.page.locator('#list-status').innerText()).toBe('உங்கள் பங்கால் எண்ணிக்கைத் திட்டங்களைப் படிக்க முடியாது.');
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 60_000);
});
