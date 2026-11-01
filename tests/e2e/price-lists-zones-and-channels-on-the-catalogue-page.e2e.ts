import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **M05-FR-01 (re-audit 30 Oct 2026, lane-1) — dated prices for a store, zone, channel or customer; the price zones; the
 * channel switches — on the Products and prices page's "Price lists" tab**, in a real browser, on the PRODUCTION API over
 * real PostgreSQL, through head office's OWN routes and their rules exactly:
 *
 *   • the owner sees every price dal has had, sets a store price from TOMORROW (within the set size), and the page shows
 *     which price is in force today (the old one) and tomorrow (the new one) — head office holds both, after a RESTART too;
 *   • a zone price is refused while zone pricing is switched off (OB-148 "same price everywhere"), in head office's words;
 *   • with head office unreachable the page says nothing was saved, and nothing was;
 *   • the owner puts store br-1 in zone "south" (price.zone.manage); asks for the app channel to be switched on — the page
 *     offers HIM no approve button (never his own); a second owner approves it on her page, and only then is an app price
 *     accepted;
 *   • the store manager's dated price that moves more than the set size (OB-291) is refused, asked for under kind
 *     price_list_entry with a reason, approved by the owner in his own session, and only then saved — naming that approval;
 *   • a cashier reads the price lists and is offered no way to change them; head office refuses the write to her too.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['price', 'lists', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const CASHIER = 'u-cash';
const OWNER2 = 'u-owner2';
const shopDay = (offsetDays: number): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offsetDays * 86_400_000));
const TODAY = shopDay(0);
const TOMORROW = shopDay(1);

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('price lists, zones and channel switches on the catalogue page, on the production API (M05-FR-01)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const history = async (): Promise<{ id: string; scope: string; scopeRef: string; price: { minor: number }; effectiveFrom: string }[]> =>
    ((await shop.cloud().request({ method: 'GET', path: '/v1/prices/list/p-dal/history', userId: OWNER })).body as { entries: { id: string; scope: string; scopeRef: string; price: { minor: number }; effectiveFrom: string }[] }).entries;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: {
        path: '/catalogue', html: 'catalogue.html', dataGlobal: 'catalogueData',
        extraData: async (api) => ({
          storeId: 'br-1', today: TODAY, now: new Date().toISOString(), marginFloorBps: 1_000, costsMinor: { 'p-dal': 100_00 },
          products: ((await api('/v1/catalogue/products')) as { products?: unknown[] }).products ?? [],
        }),
      },
      seed: async (cloud) => {
        await cloud.grant(CASHIER, 'cashier');
        await cloud.grant(OWNER2, 'owner');
        const req = (path: string, body: unknown) => cloud.request({ method: 'POST', path, userId: OWNER, body, idempotencyKey: `seed-${randomUUID()}` });
        await ok(req('/v1/catalogue/products/p-dal/publish', { product: { sku: 'SKU-DAL', name: 'Toor dal 1kg', baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '0713', lifecycle: 'active', mrpHistory: [{ value: { minor: 160_00, currency: 'INR' }, effectiveFrom: '2026-01-01' }] }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }), 'publish dal');
        await ok(req('/v1/prices/list/p-dal/entries/e1', { scope: 'store', scopeRef: 'br-1', priceMinor: 150_00, mrpMinor: 160_00, costMinor: 100_00, marginFloorBps: 1_000, currency: 'INR', effectiveFrom: TODAY }), 'first price');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who, who === MGR ? 'br-1' : undefined);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname.replace(/ple-[\w-]+|switch-[\w-]+/, (m) => m.split('-')[0]!)}`); });
    await page.goto(`${shop.base}/catalogue?tab=pricelist`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };
  const says = async (page: Page, selector: string, expected: RegExp): Promise<void> => {
    await page.waitForFunction(([sel, source]) => new RegExp(source!).test((globalThis as unknown as { document: { querySelector(x: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''), [selector, expected.source], { timeout: 15_000 });
  };
  const setPrice = async (page: Page, scope: string, ref: string, price: string, from: string): Promise<void> => {
    await page.selectOption('#pl-scope', scope);
    await page.fill('#pl-ref', ref); await page.fill('#pl-price', price); await page.fill('#pl-from', from);
    await page.click('#pl-save');
  };

  it('the owner dates a store price, sees which is in force when, is refused a switched-off zone price, and an unreachable head office saves nothing', async () => {
    const s = await open(OWNER);
    try {
      await says(s.page, '#pl-same', /^Same price everywhere: every switch is off\./);
      await s.page.fill('#pl-product', 'p-dal');
      await s.page.click('#pl-show');
      await says(s.page, '#pl-entries [data-entry="e1"]', new RegExp(`^₹150\\.00 for store br-1, from ${TODAY}, until another price replaces it`));
      expect(s.writes, 'nothing is written on open or on reading').toEqual([]);

      await setPrice(s.page, 'store', 'br-1', '145', TOMORROW);
      await says(s.page, '#pl-save-status', new RegExp(`^Saved at head office: ₹145\\.00 for store br-1, from ${TOMORROW}\\.`));
      await says(s.page, '#pl-entries', /₹145\.00 for store br-1/);
      expect(s.writes).toEqual(['POST /v1/prices/list/p-dal/entries/ple']);

      // Which price is in force: today the old one, tomorrow the new one — head office's own resolution.
      await s.page.fill('#pl-on', TODAY); await s.page.click('#pl-check');
      await says(s.page, '#pl-in-force', new RegExp(`^In force: ₹150\\.00 — the store price for br-1, from ${TODAY}\\.`));
      await s.page.fill('#pl-on', TOMORROW); await s.page.click('#pl-check');
      await says(s.page, '#pl-in-force', new RegExp(`^In force: ₹145\\.00 — the store price for br-1, from ${TOMORROW}\\.`));

      // A zone price while zone pricing is off: refused in head office's words; nothing recorded.
      await setPrice(s.page, 'zone', 'south', '140', TOMORROW);
      await says(s.page, '#pl-save-status', /^Head office refused: Zone pricing is switched off/);
      expect(await s.page.locator('#pl-approval').isHidden(), 'a switch refusal is not something a second person signs off').toBe(true);

      // Head office unreachable: said, never a success; nothing reached head office.
      await s.page.route('**/v1/prices/list/**/entries/**', (route) => route.abort());
      await setPrice(s.page, 'store', 'br-1', '146', TOMORROW);
      await says(s.page, '#pl-save-status', /^Head office cannot be reached — nothing was saved\./);
      await s.page.unroute('**/v1/prices/list/**/entries/**');
      expect((await history()).map((e) => [e.scope, e.scopeRef, e.price.minor])).toEqual([['store', 'br-1', 150_00], ['store', 'br-1', 145_00]]);

      // Tamil.
      await s.page.click('#lang');
      await says(s.page, '#tab-pricelist', /^விலைப் பட்டியல்கள்/);
      await says(s.page, '#pl-entries [data-entry="e1"]', /கடை br-1 க்கு ₹150\.00/);
      await s.page.click('#lang');
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    await shop.restart();
    expect((await history()).map((e) => [e.price.minor, e.effectiveFrom])).toEqual([[150_00, TODAY], [145_00, TOMORROW]]);
  }, 180_000);

  it('zones and the app channel: the owner puts a store in a zone and asks; never his own approval; a second owner approves; then an app price is accepted', async () => {
    const s = await open(OWNER);
    try {
      await says(s.page, '#pl-zones-status', /^No store has been put in a zone yet\./);
      await s.page.fill('#pl-zone-id', 'south'); await s.page.fill('#pl-zone-store', 'br-1');
      await s.page.click('#pl-zone-save');
      await says(s.page, '#pl-zone-save-status', /^Saved at head office: store br-1 is now in zone south\./);
      await says(s.page, '#pl-zones [data-zone="south"]', /^Zone south: br-1$/);

      // Asking with no reason sends nothing.
      await s.page.click('#pl-switches [data-ask="channel:app:on"]');
      await says(s.page, '#pl-switch-status', /^Write why in the box first\. Nothing was sent\./);
      await s.page.fill('#pl-switch-reason', 'app-only festival prices for Pongal');
      await s.page.click('#pl-switches [data-ask="channel:app:on"]');
      await says(s.page, '#pl-switch-status', /^Asked\. A second person who may approve prices must approve switching it on\./);
      await says(s.page, '#pl-pending', /The app channel: u-owner asked to switch it on — “app-only festival prices for Pongal”You asked for this — a second person must approve it\./);
      expect(await s.page.locator('#pl-pending [data-approve]').count(), 'never offered his own approval').toBe(0);
      expect(s.writes).toEqual(['POST /v1/prices/zones/south/stores/br-1', 'POST /v1/prices/channel-pricing/requests/switch']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    const t = await open(OWNER2);
    try {
      await says(t.page, '#pl-pending', /u-owner asked to switch it on/);
      await t.page.fill('#pl-switch-reason', 'agreed at the Monday meeting');
      await t.page.click('#pl-pending [data-approve]');
      await says(t.page, '#pl-switch-status', /^Approved: it is switched on\./);
      await says(t.page, '#pl-switches [data-switch="channel:app"]', /The app channel: on/);
      await says(t.page, '#pl-same', /^Some channel prices are switched on/);
      await t.page.fill('#pl-product', 'p-dal');
      await setPrice(t.page, 'channel', 'app', '148', TOMORROW);
      await says(t.page, '#pl-save-status', new RegExp(`^Saved at head office: ₹148\\.00 for channel app, from ${TOMORROW}\\.`));
      await t.page.click('#pl-diff-show');
      await says(t.page, '#pl-diff-status', /^No price differs from the shelf at this store\./); // the app price starts tomorrow
      expect(t.errors).toEqual([]);
    } finally { await t.close(); }
    expect((await history()).some((e) => e.scope === 'channel' && e.scopeRef === 'app' && e.price.minor === 148_00)).toBe(true);
  }, 180_000);

  it('the store manager\'s price beyond the set size is asked for, approved by the owner in his own session, and only then saved', async () => {
    const s = await open(MGR);
    try {
      await s.page.fill('#pl-product', 'p-dal');
      await setPrice(s.page, 'store', 'br-1', '120', TOMORROW); // ₹145 → ₹120 on that day: more than 10% (OB-291)
      await says(s.page, '#pl-save-status', /^Head office refused: p-dal for store br-1 would move from ₹145\.00 to ₹120\.00 .*\(OB-291\)/);
      expect(await s.page.locator('#pl-approval').isVisible()).toBe(true);

      await s.page.click('#pl-save-approved');
      await says(s.page, '#pl-save-status', /nobody has been asked to approve exactly this yet/);
      await s.page.fill('#pl-why', 'Clearing the old stock before the new crop arrives');
      await s.page.click('#pl-ask');
      await says(s.page, '#pl-save-status', /^Asked\. Waiting for a second person who may approve prices/);
      await s.page.click('#pl-save-approved');
      await says(s.page, '#pl-save-status', /still waiting for a second person/);
      expect((await history()).some((e) => e.price.minor === 120_00), 'nothing is saved while it waits').toBe(false);

      // The owner approves it in HIS own session (his Approvals page's route).
      const inbox = (await shop.cloud().request({ method: 'GET', path: '/v1/approvals/requests', userId: OWNER })).body as { waitingForMe: { requestId: string; kind: string }[] };
      const asked = inbox.waitingForMe.find((r) => r.kind === 'price_list_entry')!;
      await ok(shop.cloud().request({ method: 'POST', path: `/v1/approvals/requests/${asked.requestId}/decide`, userId: OWNER, idempotencyKey: randomUUID(), body: { decision: 'approved', reason: 'fine for the old crop' } }), 'approve');

      await s.page.click('#pl-save-approved');
      await says(s.page, '#pl-save-status', /^Price saved: ₹120\.00\./);
      expect(s.writes.filter((w) => w.includes('/entries/'))).toEqual(['POST /v1/prices/list/p-dal/entries/ple', 'POST /v1/prices/list/p-dal/entries/ple']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const saved = await shop.cloud().request({ method: 'GET', path: `/v1/prices/list/p-dal/resolve?storeId=br-1&at=${encodeURIComponent(`${TOMORROW}T12:00:00+05:30`)}`, userId: OWNER });
    expect(saved.body).toMatchObject({ priceMinor: 120_00, scope: 'store' });
  }, 180_000);

  it('a cashier reads the price lists and is offered no way to change them', async () => {
    const s = await open(CASHIER);
    try {
      await says(s.page, '#pl-status', /^You can read the price lists; setting a price needs the pricing role\./);
      expect(await s.page.locator('#pl-form').isHidden()).toBe(true);
      expect(await s.page.locator('#pl-zone-form').isHidden()).toBe(true);
      expect(await s.page.locator('#pl-switches button').count()).toBe(0);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect((await shop.cloud().request({ method: 'POST', path: '/v1/prices/list/p-dal/entries/x', userId: CASHIER, idempotencyKey: randomUUID(), body: { scope: 'store', scopeRef: 'br-1', priceMinor: 1, mrpMinor: 160_00, costMinor: 100_00, marginFloorBps: 0, currency: 'INR', effectiveFrom: TOMORROW } })).status).toBe(403);
  }, 60_000);
});
