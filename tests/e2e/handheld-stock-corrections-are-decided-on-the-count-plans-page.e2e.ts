import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **A stock correction asked for on a warehouse handheld is decided on the Count plans page, in a real browser, on the
 * PRODUCTION API over real PostgreSQL (M08-FR-03 · §28 · hard rules #2 #10).**
 *
 * Before this page section, `POST /v1/inventory/adjustment-requests/:requestId/decide` was called by no screen: a damaged
 * pack raised on the handheld waited for ever. Through Chromium:
 *   • the br-1 manager sees the three corrections waiting — a damaged rice sack read in its own unit ("2.500 kg", never
 *     2500), two tins found, and one he asked for himself, which he is NOT offered to decide ("You asked for this one");
 *   • approving without a reason is refused before any POST; with a reason head office posts ONE compensating movement and
 *     on-hand follows; the tins are rejected and nothing moves;
 *   • head office still refuses him deciding his own (§28), and a cashier is shown no corrections section at all (head
 *     office refuses the cashier's read too); the section speaks Tamil.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['adjustment', 'requests', 'e2e', 'production', 'signing', 'key'].join('-').padEnd(48, '0');
const CASHIER = 'u-cash-ar'; const BOX = 'u-box-ar'; const FLOOR = 'u-floor-ar';
const minuteAgo = (): string => new Date(Date.now() - 60_000).toISOString();

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('handheld stock corrections decided on the Count plans page (M08-FR-03)', () => {
  let browser: Browser;
  let shop: InboxShop;

  const get = async (path: string, userId = OWNER) => (await shop.cloud().request({ method: 'GET', path, userId })).body;
  const onHand = async (productId: string): Promise<number> => ((await get(`/v1/inventory/availability?productId=${productId}`)) as { rows: { locationId: string; onHandMinor: number }[] }).rows.filter((r) => r.locationId === 'br-1').reduce((s, r) => s + r.onHandMinor, 0);

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/count-plans', html: 'count-plans.html', dataGlobal: 'countPlansData' },
      seed: async (cloud) => {
        await cloud.grant(CASHIER, 'cashier');
        await cloud.grant(FLOOR, 'store_manager');
        await cloud.grant(BOX, 'store_computer', undefined, ['br-1']);
        const p = (path: string, userId: string, body: unknown) => ok(cloud.request({ method: 'POST', path, userId, idempotencyKey: `seed-${randomUUID()}`, body }), path);
        await p('/v1/org/nodes/C1', OWNER, { kind: 'company', name: 'SRE Retail' });
        await p('/v1/org/nodes/br-1', OWNER, { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' });
        // Rice 50 kg @ ₹60.00 a kg; tins 20 @ ₹10.00.
        await p('/v1/inventory/movements', OWNER, { movementId: 's-rice', productId: 'RICE', locationId: 'br-1', kind: 'received', quantityMinor: 50_000, uom: 'kg', occurredAt: minuteAgo(), enteredBy: OWNER, unitCostMinor: 6_000 });
        await p('/v1/inventory/movements', OWNER, { movementId: 's-tin', productId: 'TIN', locationId: 'br-1', kind: 'received', quantityMinor: 20, uom: 'EA', occurredAt: minuteAgo(), enteredBy: OWNER, unitCostMinor: 1_000 });
        // Three corrections raised on the handheld and relayed by the store computer.
        const relay = (requestId: string, productId: string, deltaMinor: number, uom: string, reasonCode: string, requestedBy: string) =>
          p(`/v1/inventory/adjustment-requests/${requestId}/synced`, BOX, { requestId, productId, locationId: 'br-1', binId: 'A-01', deltaMinor, uom, reasonCode, note: 'seen at the racking', requestedBy, at: minuteAgo(), storeId: 'br-1', source: 'warehouse-handheld' });
        await relay('ar-rice', 'RICE', -2_500, 'kg', 'damaged', FLOOR);
        await relay('ar-tin', 'TIN', 2, 'EA', 'found', FLOOR);
        await relay('ar-own', 'TIN', -1, 'EA', 'damaged', MGR);
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
    await page.goto(`${shop.base}/count-plans`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };
  const says = async (page: Page, selector: string, expected: RegExp): Promise<void> => {
    await page.waitForFunction(([sel, source]) => new RegExp(source!).test((globalThis as unknown as { document: { querySelector(x: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''), [selector, expected.source], { timeout: 15_000 });
  };

  it('the manager approves the damaged sack (one correction posts), rejects the tins (nothing moves), and is never offered his own', async () => {
    const s = await open(MGR);
    try {
      await s.page.waitForSelector('#adj-section:not([hidden])');
      expect(s.writes, 'nothing is written on open').toEqual([]);
      await s.page.click('#adj-show');
      await says(s.page, '#adj-status', /^3 waiting$/);
      const rice = s.page.locator('#adj-rows li[data-request="ar-rice"]');
      expect(await rice.innerText()).toMatch(/RICE — Missing or damaged 2\.500 kg · Damaged[\s\S]*at br-1 · bin A-01 · asked by u-floor-ar[\s\S]*Value at cost: ₹150\.00[\s\S]*Waiting for a decision/);
      expect(await s.page.locator('#adj-rows li[data-request="ar-tin"]').innerText()).toMatch(/TIN — Found more 2 · Found/);
      const own = s.page.locator('#adj-rows li[data-request="ar-own"]');
      expect(await own.innerText()).toContain('You asked for this one — a different person decides it.');
      expect(await own.locator('button').count(), 'never offered his own').toBe(0);

      // No reason → refused before any POST.
      await rice.locator('button[data-act="approve"]').click();
      await says(s.page, '#adj-rows li[data-request="ar-rice"] p.status', /^Write a reason first\.$/);
      expect(s.writes).toEqual([]);
      await rice.locator('input.adj-reason').fill('sack torn by the forklift');
      await rice.locator('button[data-act="approve"]').click();
      await says(s.page, '#adj-status', /^Approved\. Head office posted the correction once\.$/);
      expect(await s.page.locator('#adj-rows li[data-request="ar-rice"]').count(), 'a decided one leaves the waiting list').toBe(0);

      const tin = s.page.locator('#adj-rows li[data-request="ar-tin"]');
      await tin.locator('input.adj-reason').fill('the two were already on a transfer');
      await tin.locator('button[data-act="reject"]').click();
      await says(s.page, '#adj-status', /^Rejected\. Nothing moved\.$/);

      // Decided ones too: each with who decided and why.
      await s.page.check('#adj-all');
      await s.page.locator('#adj-rows li[data-request="ar-rice"][data-status="posted"]').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#adj-rows li[data-request="ar-rice"]').innerText()).toMatch(/Approved — correction posted · decided by u-mgr-br1 — sack torn by the forklift/);
      expect(await s.page.locator('#adj-rows li[data-request="ar-tin"]').innerText()).toMatch(/Rejected — nothing moved · decided by u-mgr-br1/);
      await s.page.click('#lang');
      await says(s.page, '#adj-h', /^கைக்கருவிகளிலிருந்து கேட்கப்பட்ட சரக்குத் திருத்தங்கள்$/);
      expect(s.writes).toEqual(['POST /v1/inventory/adjustment-requests/ar-rice/decide', 'POST /v1/inventory/adjustment-requests/ar-tin/decide']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    // Head office's own record: one compensating movement for the rice; the tins untouched.
    expect([await onHand('RICE'), await onHand('TIN')]).toEqual([47_500, 20]);
    const all = (await get('/v1/inventory/adjustment-requests')) as { requests: { requestId: string; status: string; movementId: string | null }[] };
    expect(all.requests.map((r) => [r.requestId, r.status, r.movementId]).sort()).toEqual([['ar-own', 'pending', null], ['ar-rice', 'posted', 'adj-req:ar-rice'], ['ar-tin', 'rejected', null]]);
    // §28 at head office too: the manager cannot decide the one he asked for.
    const self = await shop.cloud().request({ method: 'POST', path: '/v1/inventory/adjustment-requests/ar-own/decide', userId: MGR, branchId: 'br-1', idempotencyKey: `k-${randomUUID()}`, body: { decision: 'approved', reason: 'mine' } });
    expect(self.status).toBe(422);
  }, 180_000);

  it('a cashier is shown no corrections section, and head office refuses the cashier\'s read too', async () => {
    expect((await shop.cloud().request({ method: 'GET', path: '/v1/inventory/adjustment-requests', userId: CASHIER })).status).toBe(403);
    const s = await open(CASHIER);
    try {
      await says(s.page, '#list-status', /Your role cannot read count plans/);
      expect(await s.page.locator('#adj-section').isHidden()).toBe(true);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 60_000);
});
