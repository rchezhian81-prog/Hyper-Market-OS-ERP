import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { theEvening, pinTheEveningClock, pinThePageClock } from '../support/evening-clock';
import { instantOf, wallClockIn } from '../../packages/calendar/src/trading-day';

/**
 * **OB-154 (owner, 16 Oct 2026, "Add screens before pilot") — the store-operations screens, in a real browser, on the
 * PRODUCTION API over real PostgreSQL.** Each page is served in front of the real API with who is looking (head office's own
 * `/v1/identity/me`), and every figure on it is head office's answer:
 *   (a) Food-safety checks — a chiller check that was MISSED and one due now; a failed reading with no corrective action is
 *       refused on the page and nothing is sent; with the action written down it is recorded in the owner's name;
 *   (b) Price mismatches — a shelf label showing less than the price of record, in the owner's bands (OB-163);
 *   (c) Store tasks / My tasks — the owner assigns a task to a named cashier on the board; the cashier, signed in as
 *       himself, sees it on "My tasks" and completes it with evidence; the board then says it is done (OB-158);
 *   (d) Waste analytics — a write-off and a waste record shown side by side, by reason in words.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['store', 'ops', 'e2e', 'key'].join('-').padEnd(48, '0');
const HOUR = 3_600_000;
const CASHIER = 'u-ravi';
const DATA = 'storeOpsData';
// The whole journey runs at an evening UTC moment (19:30 UTC — already tomorrow in the shop), pinned so the evening case
// is proven whenever this runs.
const EVENING = theEvening();
// OB-606 (round 13): the browsers run on a device in New York — NOT India — where 19:30 UTC is still the afternoon of the
// shop's yesterday. Each screen must show the shop's day anyway (round 12 worked around the food-safety board's own-zone
// "today" by running it in a zone where it was midday; the board now takes the shop's day and the work-around is gone).
const DEVICE_ZONE = 'America/New_York';
// The food-safety slots: hourly from 23:00 the shop's yesterday — 23:00 (yesterday's board), 00:00 (today's, MISSED by
// 00:59) and 01:00, the pinned moment itself (today's, DUE).
const SHOP_MIDNIGHT = Date.parse(instantOf(`${EVENING.shopDate}T00:00`, 'Asia/Kolkata'));
const slot = (hoursFromShopMidnight: number) => new Date(SHOP_MIDNIGHT + hoursFromShopMidnight * HOUR).toISOString();

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the store-operations screens (OB-154) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  // The hour the hourly check is seeded against — set in `beforeAll`, just before seeding. Case (a) needs the last hour's
  // slot MISSED and this hour's DUE; with 59 minutes' grace this hour's slot turns missed at :59, so a run that seeds in
  // the last three minutes of an hour first waits for the next one (it failed at 02:59:30 UTC, 28 Oct 2026).
  let H = 0;
  const at = (hours: number) => new Date(H + hours * HOUR).toISOString();
  // The shop's own date: the price is dated by the shop's day, never the UTC date (from 18:30 UTC it is already tomorrow).
  const today = EVENING.shopDate;

  beforeAll(async () => {
    pinTheEveningClock(EVENING);
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    const intoHour = Date.now() % HOUR;
    if (intoHour > HOUR - 3 * 60_000) await new Promise((r) => setTimeout(r, HOUR - intoHour + 1_000));
    H = Math.floor(Date.now() / HOUR) * HOUR;
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/food-safety', html: 'food-safety.html', dataGlobal: DATA },
      alsoPages: [
        { path: '/price-integrity', html: 'price-integrity.html', dataGlobal: DATA },
        { path: '/store-tasks', html: 'store-tasks.html', dataGlobal: DATA },
        { path: '/my-tasks', html: 'my-tasks.html', dataGlobal: DATA },
        { path: '/waste-analytics', html: 'waste-analytics.html', dataGlobal: DATA },
      ],
      seed: async (cloud) => {
        await cloud.grant(CASHIER, 'cashier');
        // (a) an hourly chiller check from two hours ago: two slots missed, this hour's due.
        await ok(cloud.request({ method: 'POST', path: '/v1/facilities/food-safety/checks/chiller', userId: OWNER, idempotencyKey: 'fs-chiller', body: {
          branchId: 'br-1', title: 'Dairy chiller', kind: 'temperature', everyMinutes: 60, startsAt: slot(-1), graceMinutes: 59, minTenthsC: 0, maxTenthsC: 50, assignedRole: 'store_manager', escalatesTo: OWNER,
        } }), 'define chiller');
        // (b) the price of record for OIL at br-1 is ₹55; the shelf was seen showing ₹50.
        await ok(cloud.request({ method: 'POST', path: '/v1/prices/list/OIL/entries/e-oil', userId: OWNER, idempotencyKey: 'price-oil', body: { scope: 'store', scopeRef: 'br-1', priceMinor: 5_500, mrpMinor: 11_000, costMinor: 2_500, marginFloorBps: 0, currency: 'INR', effectiveFrom: today } }), 'price');
        await ok(cloud.request({ method: 'POST', path: '/v1/pricing/integrity/observations/o-oil', userId: OWNER, idempotencyKey: 'obs-oil', body: { branchId: 'br-1', productId: 'OIL', surface: 'shelf_label', priceMinor: 5_000, shelfAddress: 'A4-1' } }), 'observe');
        // (d) a write-off of expired milk and a waste record of preparation loss.
        await ok(cloud.request({ method: 'POST', path: '/v1/inventory/movements', userId: OWNER, idempotencyKey: 'rcv-milk', body: { movementId: 'rcv-milk', productId: 'MILK', locationId: 'br-1', kind: 'received', quantityMinor: 20, uom: 'ea', occurredAt: at(-3), enteredBy: OWNER, unitCostMinor: 5_000 } }), 'receive milk');
        await ok(cloud.request({ method: 'POST', path: '/v1/inventory/write-off/w-milk', userId: OWNER, idempotencyKey: 'wo-milk', body: { productId: 'MILK', locationId: 'br-1', qty: 2, uom: 'ea', lossType: 'expiry', reasonCode: 'expiry' } }), 'write off');
        await ok(cloud.request({ method: 'POST', path: '/v1/waste/records/r-bread', userId: OWNER, idempotencyKey: 'wr-bread', body: { branchId: 'br-1', departmentId: 'bakery', productId: 'BREAD', at: new Date().toISOString(), valueMinor: 2_500, disposal: 'composted', source: 'preparation' } }), 'waste record');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 360_000);

  afterAll(async () => {
    await browser?.close();
    await shop?.stop();
    vi.useRealTimers();
  });

  const pageErrors: string[] = [];
  afterAll(() => { expect(pageErrors).toEqual([]); });
  const open = async (who: string, path: string, timezoneId?: string): Promise<{ page: Page; close: () => Promise<void> }> => {
    const context = await browser.newContext(timezoneId === undefined ? {} : { timezoneId });
    await pinThePageClock(context);
    await shop.signIn(context, who);
    const page = await context.newPage();
    // A script error on the page fails the journey — a screen that throws shows nothing true.
    page.on('pageerror', (e) => { pageErrors.push(`${path}: ${String(e)}`); });
    await page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    return { page, close: () => context.close() };
  };

  it('(a) food-safety: today shows missed and due; a failure with no action is refused; with it, recorded in the owner\'s name', async () => {
    // "Today" on the food-safety board is the SHOP's today (OB-606), on a device in New York at 01:00 shop time.
    const { page, close } = await open(OWNER, '/food-safety', DEVICE_ZONE);
    try {
      await page.locator('#rows .row').first().waitFor({ timeout: 15_000 });
      expect(await page.getAttribute('#today-h', 'data-day')).toBe(EVENING.shopDate);
      // The shop's midnight slot is MISSED (escalated); the count is exactly the missed rows the page shows.
      expect(await page.locator(`#rows .row[data-slot="${slot(0)}"]`).getAttribute('data-state')).toBe('missed');
      expect(await page.textContent('#v-missed')).toBe(String(await page.locator('#rows .row[data-state="missed"]').count()));
      // 23:00 the shop's yesterday is yesterday's board — never shown as today's (New York's own "today" showed it).
      expect(await page.locator(`#rows .row[data-slot="${slot(-1)}"]`).count()).toBe(0);
      const due = page.locator(`#rows .row[data-slot="${slot(1)}"]`);
      expect(await due.getAttribute('data-state')).toBe('due');
      await due.locator('input.reading').fill('9.2');
      await due.locator('button.save').click();
      await due.locator('.status.err').waitFor({ timeout: 10_000 });
      expect(await due.locator('.status').textContent()).toMatch(/write down what was done/);
      await due.locator('textarea.action').fill('Moved the milk to the walk-in; engineer called');
      await due.locator('button.save').click();
      await page.locator(`#rows .row[data-slot="${slot(1)}"][data-state="done_failed"]`).waitFor({ timeout: 15_000 });
      expect(await page.textContent('#v-failed')).toBe('1');
      const status = (await shop.cloud().request({ method: 'GET', path: `/v1/facilities/food-safety/status?from=${encodeURIComponent(at(-3))}`, userId: OWNER })).body as { failed: { performedBy: string; correctiveAction: string }[] };
      expect(status.failed).toEqual([expect.objectContaining({ performedBy: OWNER, correctiveAction: 'Moved the milk to the walk-in; engineer called' })]);
      await page.click('#lang');
      expect(await page.textContent('#k-missed')).toBe('தவறியவை');
    } finally { await close(); }
  }, 60_000);

  it('(b) price mismatches: the shelf below the price of record, in the owner\'s four bands', async () => {
    const { page, close } = await open(OWNER, '/price-integrity', DEVICE_ZONE);
    try {
      expect(await page.locator('#bands .panel').count()).toBe(4);
      await page.fill('#branch', 'br-1');
      await page.click('#show');
      await page.locator('#rows tr[data-product="OIL"]').waitFor({ timeout: 15_000 });
      const row = page.locator('#rows tr[data-product="OIL"][data-surface="shelf_label"]');
      expect(await row.getAttribute('data-kind')).toBe('shown_below_record');
      expect(await row.textContent()).toMatch(/Shelf label — shows LESS than the price — honour it.*₹55\.00.*₹50\.00.*Under 1 day/);
      // OB-606: open since the SHOP's date it was seen — on a device in New York, still the shop's yesterday there.
      expect(await row.textContent()).toContain(EVENING.shopDate);
      expect(await page.locator('#bands .panel[data-band="under 1 day"] .v').textContent()).toBe('1');
    } finally { await close(); }
  }, 60_000);

  it('(c) store tasks: the owner assigns on the board; the cashier completes it on his own page with evidence; the board says done', async () => {
    const board = await open(OWNER, '/store-tasks', DEVICE_ZONE);
    try {
      await board.page.locator('#assign-section').waitFor({ state: 'visible', timeout: 15_000 });
      await board.page.fill('#a-title', 'Face up aisle 4');
      await board.page.fill('#a-person', CASHIER);
      await board.page.fill('#a-branch', 'br-1');
      // The deadline field holds the SHOP's wall clock (OB-606) — three hours from now, as the shop's clock reads it.
      await board.page.fill('#a-due', wallClockIn(new Date(H + 3 * HOUR).toISOString(), 'Asia/Kolkata'));
      await board.page.check('#a-evidence');
      await board.page.click('#a-save');
      await board.page.locator('#rows .row[data-status="pending"]').waitFor({ timeout: 15_000 });
      expect(await board.page.textContent('#assign-status')).toBe('Assigned in your name.');
      // The board offers no completion: only the assignee completes (OB-158).
      expect(await board.page.locator('button.done').count()).toBe(0);
    } finally { await board.close(); }

    const mine = await open(CASHIER, '/my-tasks');
    try {
      const row = mine.page.locator('#rows .row').first();
      await row.waitFor({ timeout: 15_000 });
      await row.locator('button.done').click();
      await row.locator('.status.err').waitFor({ timeout: 10_000 });
      expect(await row.locator('.status').textContent()).toMatch(/needs its evidence/);
      await row.locator('input.evidence').fill('photo-aisle4');
      await row.locator('button.done').click();
      await mine.page.locator('#rows .row[data-status="done"]').waitFor({ timeout: 15_000 });
    } finally { await mine.close(); }

    const tasks = (await shop.cloud().request({ method: 'GET', path: '/v1/hr/workforce/assigned-tasks', userId: OWNER })).body as { tasks: { title: string; status: string; completion?: { doneBy: string; evidenceRefs: string[] } }[] };
    expect(tasks.tasks).toEqual([expect.objectContaining({ title: 'Face up aisle 4', status: 'done', completion: expect.objectContaining({ doneBy: CASHIER, evidenceRefs: ['photo-aisle4'] }) })]);
  }, 90_000);

  it('(d) waste analytics: write-offs and waste records side by side, by reason in words', async () => {
    const { page, close } = await open(OWNER, '/waste-analytics');
    try {
      // The window opens on the SHOP's month so far: at 19:30 UTC the browser (on UTC) still says yesterday, and the bread
      // wasted "now" is on the shop's today — a window ending on the browser's date would leave it out.
      expect(await page.inputValue('#to')).toBe(EVENING.shopDate);
      expect(await page.inputValue('#from')).toBe(`${EVENING.shopDate.slice(0, 7)}-01`);
      await page.locator('table[data-breakdown="wo-reason"] tr[data-key="expiry"]').waitFor({ timeout: 15_000 });
      expect(await page.locator('table[data-breakdown="wo-reason"] tr[data-key="expiry"]').textContent()).toMatch(/Past its date.*₹100\.00/);
      expect(await page.locator('table[data-breakdown="wr-reason"] tr[data-key="preparation"]').textContent()).toMatch(/Lost in preparation.*₹25\.00/);
      expect(await page.textContent('#wo-total')).toMatch(/₹100\.00 · 1 event/);
      await page.click('#lang');
      expect(await page.locator('table[data-breakdown="wo-reason"] tr[data-key="expiry"]').textContent()).toMatch(/காலாவதியானது/);
    } finally { await close(); }
  }, 60_000);
});
