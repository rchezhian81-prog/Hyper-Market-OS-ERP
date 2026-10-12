import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **The Transfers page, in a real browser, on the PRODUCTION API over real PostgreSQL (WF-07 · M09-FR-03 · M08-FR-02/03 ·
 * §28 · P-08 · hard rules #2 #10).**
 *
 * The page is served in front of the real API (no stub); who is looking comes from head office's own `GET /v1/identity/me`,
 * and every `/v1` call goes to the API under the signed-in person's token. Through Chromium:
 *
 *   • the br-1 manager SENDS a transfer someone else proposed (back store → floor): head office records him as the approver
 *     and values each line at its own cost at the source — nothing is priced on the page; his attempt to also count it in,
 *     and a transfer asking for more than the back store holds, are refused in head office's words;
 *   • after an API RESTART a second manager counts it in: 8 of 10 arrived — the shortfall is a VALUED exception (₹4.00),
 *     never a quiet adjustment; her attempt to settle her own count's shortfall is refused (§28);
 *   • the owner settles it: 1 turned up at the floor, 1 is gone — head office posts the found unit once and on-hand follows;
 *   • a cashier, who may not read stock, is told so (head office refuses them too); the page speaks Tamil.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['transfers', 'e2e', 'production', 'signing', 'key'].join('-').padEnd(48, '0');
const PROPOSER = 'u-prop-tr'; const MGR2 = 'u-mgr2-tr'; const CASHIER = 'u-cash-tr';

interface Transfer { transferId: string; state: string; approvedBy?: string; receivedBy?: string; lineCostsMinor?: (number | null)[]; shortfallResolution?: { resolvedBy: string; lines: { productId: string; foundMinor: number; lostMinor: number; lostValueMinor: number }[] } }

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Transfers page on the production API, in a real browser (WF-07 · M09-FR-03)', () => {
  let browser: Browser;
  let shop: InboxShop;

  const get = async (path: string, userId = OWNER) => (await shop.cloud().request({ method: 'GET', path, userId })).body;
  const transfer = async (id: string): Promise<Transfer> => await get(`/v1/warehouse/transfers/${id}`) as Transfer;
  const onHand = async (productId: string, loc: string): Promise<number> => ((await get(`/v1/inventory/availability?productId=${productId}`)) as { rows: { locationId: string; onHandMinor: number }[] }).rows.filter((r) => r.locationId === loc).reduce((s, r) => s + r.onHandMinor, 0);

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/transfers', html: 'transfers.html', dataGlobal: 'transfersData' },
      seed: async (cloud) => {
        await cloud.grant(CASHIER, 'cashier');
        for (const u of [PROPOSER, MGR2]) await cloud.grant(u, 'store_manager');
        const p = (path: string, userId: string, body: unknown) => ok(cloud.request({ method: 'POST', path, userId, idempotencyKey: `seed-${randomUUID()}`, body }), path);
        await p('/v1/org/nodes/C1', OWNER, { kind: 'company', name: 'SRE Retail' });
        await p('/v1/org/nodes/br-1', OWNER, { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' });
        await p('/v1/org/nodes/br-1-back', OWNER, { kind: 'warehouse', name: 'Store 1 back store', parentId: 'br-1', companyId: 'C1' });
        // The back store holds P1 50 @ ₹2.00 and P2 20 @ ₹5.00 — head office's own cost.
        for (const [id, product, qty, cost] of [['s-p1', 'P1', 50, 200], ['s-p2', 'P2', 20, 500]] as const) {
          await p('/v1/inventory/movements', OWNER, { movementId: id, productId: product, locationId: 'br-1-back', kind: 'received', quantityMinor: qty, uom: 'EA', occurredAt: new Date(Date.now() - 60_000).toISOString(), enteredBy: OWNER, unitCostMinor: cost });
        }
        // Proposed by someone else (the proposer cannot send their own, §28): one sendable, one asking for more than is there.
        await p('/v1/warehouse/transfers/t-1', PROPOSER, { fromLocationId: 'br-1-back', toLocationId: 'br-1', lines: [{ productId: 'P1', quantityMinor: 10, uom: 'EA' }, { productId: 'P2', quantityMinor: 4, uom: 'EA' }] });
        // Another store's transfer — not br-1's business: the br-1 manager's register never lists it (PA-01-r1).
        await p('/v1/org/nodes/br-2', OWNER, { kind: 'branch', name: 'Store 2', parentId: 'C1', companyId: 'C1' });
        await p('/v1/org/nodes/br-2-back', OWNER, { kind: 'warehouse', name: 'Store 2 back store', parentId: 'br-2', companyId: 'C1' });
        await p('/v1/warehouse/transfers/t-3', PROPOSER, { fromLocationId: 'br-2-back', toLocationId: 'br-2', lines: [{ productId: 'P1', quantityMinor: 1, uom: 'EA' }] });
        await p('/v1/warehouse/transfers/t-2', PROPOSER, { fromLocationId: 'br-1-back', toLocationId: 'br-1', lines: [{ productId: 'P1', quantityMinor: 500, uom: 'EA' }] });
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
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname} ${r.postData() ?? ''}`); });
    await page.goto(`${shop.base}/transfers`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };
  const says = async (page: Page, id: string, expected: RegExp): Promise<void> => {
    await page.waitForFunction(([i, source]) => new RegExp(source!).test((globalThis as unknown as { document: { getElementById(x: string): { textContent: string | null } | null } }).document.getElementById(i!)?.textContent ?? ''), [id, expected.source], { timeout: 15_000 });
  };
  const look = async (page: Page, id: string): Promise<void> => {
    await page.locator(`#register tbody tr[data-transfer="${id}"] button[data-act="view"]`).click();
    await says(page, 'd-title', new RegExp(`^${id}$`));
  };

  it('the br-1 manager sends a transfer he did not propose — head office names him the approver and values it at its own cost; counting it in himself, and an over-draw, are refused in head office\'s words', async () => {
    const s = await open(MGR);
    try {
      await s.page.locator('#register tbody tr[data-transfer="t-1"][data-state="proposed"]').waitFor({ timeout: 15_000 });
      expect(s.writes, 'nothing is written on open').toEqual([]);
      expect(await s.page.locator('#n-proposed').innerText()).toBe('2');
      expect(await s.page.locator('#register tbody tr[data-transfer="t-3"]').count(), 'another store\'s transfer is not listed').toBe(0);
      await look(s.page, 't-1');
      expect(await s.page.locator('#d-lines').innerText()).toMatch(/P1 — 10 EA[\s\S]*head office cost ₹2\.00[\s\S]*P2 — 4 EA[\s\S]*head office cost ₹5\.00/);
      expect(await s.page.locator('#drawer input:visible').count(), 'no cost or approver is typed').toBe(0);
      const answered = s.page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/t-1/dispatch'));
      await s.page.click('#d-dispatch');
      expect(await (await answered).json()).toMatchObject({ state: 'in_transit', approvedBy: MGR, lineCostsMinor: [200, 500] });
      await says(s.page, 'd-state', /^On the road — not sellable yet/);
      // He sent it, so he cannot also count it in (§28) — head office's words; nothing is received.
      for (const [i, q] of ['10', '4'].entries()) await s.page.locator(`#d-receive-lines input.arrived[data-index="${i}"]`).fill(q);
      await s.page.click('#d-receive');
      await says(s.page, 'd-status', new RegExp(`^Head office refused: ${MGR} dispatched transfer t-1 and cannot also count it in at br-1 \\(§28\\)`));
      await s.page.click('#d-close');
      // More than the back store holds: refused by head office, nothing moves.
      await look(s.page, 't-2');
      await s.page.click('#d-dispatch');
      await says(s.page, 'd-status', /^Head office refused: only 40 of P1 available to send, not 500/);
      expect(s.writes).toEqual(['POST /v1/warehouse/transfers/t-1/dispatch {}', 'POST /v1/warehouse/transfers/t-1/receive {"counted":[{"productId":"P1","batchId":null,"quantityMinor":10},{"productId":"P2","batchId":null,"quantityMinor":4}]}', 'POST /v1/warehouse/transfers/t-2/dispatch {}']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect(await transfer('t-1')).toMatchObject({ state: 'in_transit', approvedBy: MGR });
    expect((await transfer('t-2')).state).toBe('proposed');
    expect([await onHand('P1', 'br-1-back'), await onHand('P1', 'br-1')]).toEqual([40, 0]);
  }, 180_000);

  it('after an API restart a second manager counts it in: two short becomes a valued exception, and she may not settle her own count\'s shortfall', async () => {
    await shop.restart();
    const s = await open(MGR2);
    try {
      await s.page.locator('#register tbody tr[data-transfer="t-1"][data-state="in_transit"]').waitFor({ timeout: 15_000 });
      await look(s.page, 't-1');
      await s.page.locator('#d-receive-lines input.arrived[data-index="0"]').fill('8');
      await s.page.click('#d-receive');
      await says(s.page, 'd-status', /^Write each arrived quantity as a whole number/);
      await s.page.locator('#d-receive-lines input.arrived[data-index="1"]').fill('4');
      await s.page.click('#d-receive');
      await says(s.page, 'd-state', /^Received · Shortfall open/);
      expect(await s.page.locator('#d-short').innerText()).toMatch(/P1 — 2 missing · worth ₹4\.00/);
      expect(await s.page.locator('#n-short').innerText()).toBe('1');
      await s.page.locator('#d-short input.found').fill('1');
      await s.page.fill('#d-note', 'searched the van and the floor');
      await s.page.click('#d-resolve');
      await says(s.page, 'd-status', new RegExp(`^Head office refused: ${MGR2} counted transfer t-1 and cannot also resolve its shortfall \\(§28\\)`));
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect(await transfer('t-1')).toMatchObject({ state: 'received', receivedBy: MGR2 });
    expect((await transfer('t-1')).shortfallResolution).toBeUndefined();
    expect([await onHand('P1', 'br-1'), await onHand('P2', 'br-1')]).toEqual([8, 4]);
  }, 180_000);

  it('the owner settles it — one turned up on the floor, one is gone — and head office posts the found unit once', async () => {
    const s = await open(OWNER);
    try {
      await s.page.locator('#register tbody tr[data-transfer="t-1"][data-state="received"]').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#register tbody tr[data-transfer="t-3"]').count(), 'the owner sees every store').toBe(1);
      await look(s.page, 't-1');
      await s.page.locator('#d-short input.found').fill('1');
      await s.page.selectOption('#d-reason-code', 'theft_suspected');
      await s.page.fill('#d-note', 'searched the van and the floor');
      await s.page.click('#d-resolve');
      await says(s.page, 'd-state', /^Received · Shortfall settled/);
      expect(await s.page.locator('#d-short').innerText()).toMatch(/P1: 1 found · 1 lost \(₹2\.00\) — searched the van and the floor/);
      expect(await s.page.locator('#d-resolve-box').isHidden()).toBe(true);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect((await transfer('t-1')).shortfallResolution).toMatchObject({ resolvedBy: OWNER, lines: [{ productId: 'P1', foundMinor: 1, lostMinor: 1, lostValueMinor: 200 }] });
    expect([await onHand('P1', 'br-1'), await onHand('P1', 'br-1-back')]).toEqual([9, 40]);
  }, 120_000);

  it('a cashier, who may not read stock, is told so (head office refuses them too), offered nothing, and the page speaks Tamil', async () => {
    expect((await shop.cloud().request({ method: 'GET', path: '/v1/warehouse/transfers', userId: CASHIER })).status).toBe(403);
    const s = await open(CASHIER);
    try {
      await says(s.page, 'list-status', /Your role cannot read transfers/);
      await s.page.click('#lang');
      expect(await s.page.locator('#title').innerText()).toBe('இடமாற்றங்கள்');
      expect(await s.page.locator('#list-status').innerText()).toBe('உங்கள் பங்கால் இடமாற்றங்களைப் படிக்க முடியாது.');
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 60_000);
});
