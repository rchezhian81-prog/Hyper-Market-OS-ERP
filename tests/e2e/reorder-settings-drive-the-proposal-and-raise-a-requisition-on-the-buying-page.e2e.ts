import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **The Buying page's Reorder tab, in a real browser, on the PRODUCTION API over real PostgreSQL (M09-FR-02 "min/max, safety
 * stock, reorder point … parameters per product/store … parameter changes logged" · WF-03 "→ requisition" · hard rule #5).**
 *
 * Before this tab no screen called `/v1/replenishment/*` and nothing stored the reorder settings. Through Chromium:
 *   • the br-1 manager sets rice's reorder settings in kg (most to hold 50 kg, reorder at 10 kg) — a fraction of a gram is
 *     refused before any POST; head office stores them in grams as version 1; a change is version 2 and the first is kept;
 *   • head office's proposal on those stored settings and its own stock (2 kg on hand) is "48.000 kg — below its reorder
 *     point", advisory only; the manager ticks it, writes 45 kg, and raises a requisition — head office keeps the proposed
 *     48 kg beside his 45 kg; nothing is ordered;
 *   • after an API RESTART the settings read back; a cashier is told their role cannot read stock (head office refuses too).
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['reorder', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const CASHIER = 'u-cash-rp';

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Reorder tab on the Buying page (M09-FR-02 · WF-03)', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      // What the store computer injects for the Buying page: the signed-in buyer, and each item's unit from the pack.
      page: { path: '/buying', html: 'buying.html', dataGlobal: 'buyingData', extraData: async (api) => ({ buyerId: ((await api('/v1/identity/me')) as { userId: string }).userId, productUoms: { RICE: 'kg', SOAP: 'ea' } }) },
      seed: async (c) => {
        await c.grant(CASHIER, 'cashier');
        const p = (path: string, body: unknown) => ok(c.request({ method: 'POST', path, userId: OWNER, idempotencyKey: `seed-${randomUUID()}`, body }), path);
        await p('/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' });
        await p('/v1/org/nodes/br-1', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' });
        await p('/v1/inventory/movements', { movementId: 's-rice', productId: 'RICE', locationId: 'br-1', kind: 'received', quantityMinor: 2_000, uom: 'kg', occurredAt: new Date(Date.now() - 3_600_000).toISOString(), enteredBy: OWNER, unitCostMinor: 6_000 });
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
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname.replace(/rq-[A-Za-z0-9]+/, 'rq-…')}`); });
    await page.goto(`${shop.base}/buying`, { waitUntil: 'load' });
    await page.click('#tab-reorder');
    return { page, writes, errors, close: () => context.close() };
  };
  const says = async (page: Page, selector: string, expected: RegExp): Promise<void> => {
    try {
      await page.waitForFunction(([sel, source]) => new RegExp(source!).test((globalThis as unknown as { document: { querySelector(x: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''), [selector, expected.source], { timeout: 15_000 });
    } catch (e) {
      throw new Error(`${selector} never said ${String(expected)} — it says "${await page.locator(selector).first().textContent()}"`, { cause: e });
    }
  };
  const fill = async (page: Page, values: Record<string, string>): Promise<void> => { for (const [k, v] of Object.entries(values)) await page.fill(`#rp-${k}`, v); };

  it('the manager sets rice\'s settings in kg, changes them (a new version), and raises a requisition from head office\'s proposal on them', async () => {
    const s = await open(MGR);
    try {
      await s.page.fill('#reorder-store', 'br-1');
      await s.page.click('#reorder-read');
      await says(s.page, '#reorder-proposal', /No reorder settings are kept for this store yet/);
      expect(s.writes.filter((w) => !w.endsWith('/stored-proposal')), 'reading writes nothing').toEqual([]);

      await fill(s.page, { productId: 'RICE', maxLevel: '40', reorderPoint: '10.0005', reason: 'weekly sales' });
      await s.page.click('#rp-save');
      await says(s.page, '#rp-status', /^Write the item, the most to hold/);
      await fill(s.page, { reorderPoint: '10' });
      await s.page.click('#rp-save');
      await says(s.page, '#rp-status', /^Saved — head office keeps it as a new version/);
      await fill(s.page, { maxLevel: '50', reason: 'festival' });
      await s.page.click('#rp-save');
      await says(s.page, '#rp-status', /^Saved/);
      await s.page.locator('#reorder-params tr[data-product="RICE"][data-version="2"]').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#reorder-params tr[data-product="RICE"]').innerText()).toMatch(/RICE\s+50\.000 kg\s+10\.000 kg[\s\S]*version 2 · set by u-mgr-br1 · Why: festival · Earlier settings: v1 40\.000 kg/);

      const row = s.page.locator('#reorder-proposal tr[data-product="RICE"]');
      await row.waitFor({ timeout: 15_000 });
      expect(await row.innerText()).toMatch(/RICE\s+2\.000 kg\s+10\.000 kg\s+48\.000 kg · Below its reorder point/);
      expect(await s.page.locator('#reorder-advisory').innerText()).toBe('Advisory only — this orders nothing.');
      await s.page.click('#reorder-raise');
      await says(s.page, '#reorder-raise-status', /^Tick at least one proposed line/);
      await row.locator('input.tick').check();
      await row.locator('input.qty').fill('45');
      await s.page.click('#reorder-raise');
      await says(s.page, '#reorder-raise-status', /^Requisition raised\./);
      await s.page.click('#lang');
      await says(s.page, '#reorder-title', /^மறு ஆணை$/);
      expect(s.writes.filter((w) => !w.endsWith('/stored-proposal'))).toEqual(['POST /v1/replenishment/parameters/br-1/RICE', 'POST /v1/replenishment/parameters/br-1/RICE', 'POST /v1/purchase/requisitions/rq-…/from-replenishment']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const reqs = (await shop.cloud().request({ method: 'GET', path: '/v1/purchase/requisitions', userId: OWNER })).body as { requisitions: { lines: { productId: string; quantity: number }[]; raisedBy: string; source: { kind: string; proposed: Record<string, number> } }[] };
    expect(reqs.requisitions).toEqual([expect.objectContaining({ raisedBy: MGR, lines: [{ productId: 'RICE', quantity: 45_000 }], source: expect.objectContaining({ kind: 'replenishment', proposed: { RICE: 48_000 } }) })]);
    const orders = (await shop.cloud().request({ method: 'GET', path: '/v1/purchase/orders', userId: OWNER })).body as { orders: unknown[] };
    expect(orders.orders, 'nothing was ordered').toEqual([]);
  }, 180_000);

  it('after a restart the settings read back; a cashier is told their role cannot read stock, and head office refuses too', async () => {
    await shop.restart();
    const s = await open(MGR);
    try {
      await s.page.fill('#reorder-store', 'br-1');
      await s.page.click('#reorder-read');
      await s.page.locator('#reorder-params tr[data-product="RICE"][data-version="2"]').waitFor({ timeout: 15_000 });
    } finally { await s.close(); }
    expect((await shop.cloud().request({ method: 'GET', path: '/v1/replenishment/parameters?storeId=br-1', userId: CASHIER })).status).toBe(403);
    const c = await open(CASHIER);
    try {
      await says(c.page, '#reorder-status', /^Your role cannot read stock\.$/);
      expect(await c.page.isHidden('#reorder-set')).toBe(true);
      expect(c.writes).toEqual([]);
      expect(c.errors).toEqual([]);
    } finally { await c.close(); }
  }, 120_000);
});
