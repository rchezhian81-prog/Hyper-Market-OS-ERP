import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { askedThenConfirmed, writeCounter } from './lib/confirm-sheet';
import { auditPage } from './lib/a11y-audit';

/**
 * **U6 (UI/UX gap audit, 1 Nov 2026 · §27 Inventory "Ledger" / "Quarantine" / "Adjustment"): the three stock screens, in a real
 * browser, on the PRODUCTION API over real PostgreSQL (M08-FR-01 · M08-FR-03 · M07-FR-03 · M10-FR-02 · §28 · OB-698 · hard
 * rules #2 #10).**
 *
 * Through Chromium, the br-1 manager:
 *   • reads the STOCK LEDGER of the rice: the on-hand card, three movements in ledger order with the stock after each, the
 *     kind in words; narrowed to one day; nothing written; the words in Tamil on the toggle; the audit clean; it fits 360px;
 *   • reads the QUARANTINE register: two batches on hold and one delivery line held at the door, counted at the top; releases a
 *     sampled batch behind the confirm sheet (Go back sends nothing) — it moves to the released list; puts a new batch in
 *     quarantine behind the sheet; a cashier is refused by head office and told so;
 *   • ASKS for a correction (2.5 kg of rice damaged) behind the confirm sheet: recorded pending, valued at head office's cost,
 *     marked "you asked for this one" with no decide buttons; a SECOND manager approves it behind the sheet with a reason:
 *     head office posts one correcting movement, on-hand falls by 2.5 kg, and the ledger shows the line in both names.
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['u6', 'stock', 'screens', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const MGR2 = 'u-mgr2-u6'; const CASHIER = 'u-cash-u6';
const minuteAgo = (): string => new Date(Date.now() - 60_000).toISOString();

/** What reaches past a 360px viewport (a register's own scroll box is contained, never the page scrolling sideways). */
const widest = (page: Page): Promise<string[]> => page.evaluate(`(() => {
  const w = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > w + 1) return ['document scrollWidth=' + document.documentElement.scrollWidth];
  return Array.from(document.querySelectorAll('body *'))
    .filter((el) => !el.closest('.sre-scroll-x'))
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.right > w + 1 && r.width > 0)
    .filter(({ el }) => !Array.from(el.children).some((c) => c.getBoundingClientRect().right > w + 1))
    .slice(0, 8)
    .map(({ el, r }) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' right=' + Math.round(r.right));
})()`);

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the stock ledger, quarantine and adjust-a-quantity pages on the production API, in a real browser (U6)', () => {
  let browser: Browser;
  let shop: InboxShop;

  const get = async (path: string, userId = OWNER) => (await shop.cloud().request({ method: 'GET', path, userId })).body;
  const onHand = async (productId: string): Promise<number> => ((await get(`/v1/inventory/availability?productId=${productId}`)) as { rows: { locationId: string; onHandMinor: number }[] }).rows.filter((r) => r.locationId === 'br-1').reduce((s, r) => s + r.onHandMinor, 0);

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/stock-ledger', html: 'stock-ledger.html', dataGlobal: 'stockLedgerData' },
      alsoPages: [
        { path: '/quarantine', html: 'quarantine.html', dataGlobal: 'quarantineData' },
        { path: '/stock-adjustments', html: 'stock-adjustments.html', dataGlobal: 'stockAdjustmentsData' },
      ],
      seed: async (cloud) => {
        await cloud.grant(CASHIER, 'cashier');
        await cloud.grant(MGR2, 'store_manager');
        const p = (path: string, userId: string, body: unknown) => ok(cloud.request({ method: 'POST', path, userId, idempotencyKey: `seed-${randomUUID()}`, body }), path);
        await p('/v1/org/nodes/C1', OWNER, { kind: 'company', name: 'SRE Retail' });
        await p('/v1/org/nodes/br-1', OWNER, { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' });
        // Rice: 50 kg received at ₹60.00 a kg yesterday, 10 kg sent to another store, 20 kg received today.
        const day = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();
        await p('/v1/inventory/movements', OWNER, { movementId: 'r-1', productId: 'RICE', locationId: 'br-1', kind: 'received', quantityMinor: 50_000, uom: 'kg', occurredAt: day(2), enteredBy: OWNER, unitCostMinor: 6_000 });
        await p('/v1/inventory/movements', OWNER, { movementId: 'r-2', productId: 'RICE', locationId: 'br-1', kind: 'transferred_out', quantityMinor: 10_000, uom: 'kg', occurredAt: day(1), enteredBy: OWNER });
        await p('/v1/inventory/movements', OWNER, { movementId: 'r-3', productId: 'RICE', locationId: 'br-1', kind: 'received', quantityMinor: 20_000, uom: 'kg', occurredAt: minuteAgo(), enteredBy: OWNER, unitCostMinor: 6_000 });
        // Two batches on quality hold; B-1 has a passing sample recorded, so a release is allowed.
        await p('/v1/quality/holds/B-1', OWNER, { productId: 'p-milk', reason: 'awaiting listeria result' });
        await p('/v1/quality/holds/B-1/samples/s-1', OWNER, { test: 'listeria', result: 'pass', takenAt: minuteAgo() });
        await p('/v1/quality/holds/B-2', OWNER, { productId: 'p-curd', reason: 'cold-chain reading out of range' });
        // A delivery with one damaged line, quarantined at the door.
        await p('/v1/inventory/goods-receipt/grn-u6', OWNER, { warehouseId: 'br-1', receivedOnDate: new Date().toISOString().slice(0, 10), currency: 'INR', lines: [
          { lineId: 'L1', productId: 'p-oil', orderedMinor: 12, countedMinor: 12, uom: 'EA', unitCost: { minor: 10_000, currency: 'INR' }, condition: 'damaged' },
        ] });
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string, path: string, width = 1280) => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await shop.signIn(context, who, who === CASHIER ? undefined : 'br-1');
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof (globalThis as unknown as { sreOffice?: { table?: unknown } }).sreOffice?.table === 'function', null, { timeout: 15_000 });
    return { page, writes, errors, close: async () => { await page.waitForLoadState('networkidle').catch(() => {}); await context.close(); } };
  };
  const says = async (page: Page, selector: string, expected: RegExp): Promise<void> => {
    try {
      await page.waitForFunction(([sel, source]) => new RegExp(source!).test((globalThis as unknown as { document: { querySelector(x: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''), [selector, expected.source], { timeout: 15_000 });
    } catch (e) {
      throw new Error(`${selector} never said ${String(expected)} — it says "${await page.locator(selector).first().textContent().catch(() => '(nothing)')}"`, { cause: e });
    }
  };

  it('the stock ledger: one product\'s movements in order with the stock after each, narrowed to a day, in both languages, fitting a phone, nothing written', async () => {
    const s = await open(MGR, '/stock-ledger');
    try {
      await s.page.fill('#product', 'RICE');
      await s.page.click('#show');
      await s.page.locator('#ledger-grid tbody tr').first().waitFor({ timeout: 15_000 });
      const rows = s.page.locator('#ledger-grid tbody tr');
      expect(await rows.count()).toBe(3);
      const words = await rows.allInnerTexts();
      expect(words[0]).toMatch(/Delivery received[\s\S]*\+50\.000 kg[\s\S]*50\.000 kg/);
      expect(words[1]).toMatch(/Transferred out[\s\S]*−10\.000 kg[\s\S]*40\.000 kg/);
      expect(words[2]).toMatch(/Delivery received[\s\S]*\+20\.000 kg[\s\S]*60\.000 kg/);
      expect(await s.page.locator('#cards').innerText()).toMatch(/On hand now[\s\S]*60\.000 kg[\s\S]*Movements shown[\s\S]*3[\s\S]*Came in[\s\S]*\+70000[\s\S]*Went out[\s\S]*−10000/);
      // Only today: one line, whose balance still counts the whole history.
      const today = (globalThis as unknown as { Intl: typeof Intl }).Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
      const [y, m, d] = today.split('-');
      await s.page.fill('#from', `${d}/${m}/${y}`); await s.page.fill('#to', `${d}/${m}/${y}`);
      await s.page.click('#show');
      await says(s.page, '#cards', /Movements shown\s*1\s*Came in/);
      expect(await s.page.locator('#ledger-grid tbody tr').count()).toBe(1);
      expect((await s.page.locator('#ledger-grid tbody tr').first().innerText())).toMatch(/\+20\.000 kg[\s\S]*60\.000 kg/);
      expect(await auditPage(s.page, { expectLang: 'en' })).toEqual([]);
      await s.page.click('#lang');
      await says(s.page, '#page-h', /^சரக்குப் பேரேடு$/);
      expect(await s.page.locator('#ledger-grid thead').innerText()).toMatch(/எப்போது[\s\S]*என்ன நடந்தது[\s\S]*பின் சரக்கு/);
      expect(await s.page.locator('#ledger-grid tbody tr').first().innerText()).toMatch(/விநியோகம் பெறப்பட்டது/);
      expect(await auditPage(s.page, { expectLang: 'ta' })).toEqual([]);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    // A phone: the first screenful carries the page's first task and nothing reaches past the viewport.
    const m = await open(MGR, '/stock-ledger', 360);
    try {
      await m.page.fill('#product', 'RICE'); await m.page.click('#show');
      await m.page.locator('#ledger-grid tbody tr').first().waitFor({ timeout: 15_000 });
      expect(await widest(m.page)).toEqual([]);
    } finally { await m.close(); }
  }, 180_000);

  it('the quarantine register: holds and held delivery lines counted; a release and a new hold behind the confirm sheet; a cashier refused', async () => {
    const s = await open(MGR, '/quarantine');
    try {
      const writes = writeCounter(s.page);
      await s.page.locator('#holds-grid tbody tr').first().waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#cards').innerText()).toMatch(/Batches on hold[\s\S]*2[\s\S]*Failed a test[\s\S]*0[\s\S]*Delivery lines held[\s\S]*1[\s\S]*Released[\s\S]*0/);
      expect(await s.page.locator('#holds-grid tbody tr').count()).toBe(2);
      expect(await s.page.locator('#holds-grid tbody tr[data-batch="B-1"]').innerText()).toMatch(/B-1[\s\S]*p-milk[\s\S]*On hold[\s\S]*awaiting listeria result/);
      expect(await s.page.locator('#lines-grid tbody tr').innerText()).toMatch(/grn-u6[\s\S]*p-oil[\s\S]*12[\s\S]*Quarantined/);
      // Release B-1: the sheet names the batch; Go back sends nothing; confirm releases it once.
      const title = await askedThenConfirmed(s.page, () => s.page.click('#rel-B-1'), /Release batch B-1 for sale\?/, writes);
      expect(title).toContain('B-1');
      await says(s.page, '#holds-status', /^Head office released the batch for sale\.$/);
      await s.page.locator('#released-grid tbody tr[data-batch="B-1"]').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#holds-grid tbody tr').count()).toBe(1);
      // A new hold behind the sheet.
      await s.page.fill('#batch', 'B-9'); await s.page.fill('#product', 'p-ghee'); await s.page.fill('#reason', 'seal broken on three jars');
      await askedThenConfirmed(s.page, () => s.page.click('#hold'), /Put batch B-9 in quarantine\?/, writes);
      await says(s.page, '#new-status', /^Head office recorded the hold\. The batch is not sellable\.$/);
      await s.page.locator('#holds-grid tbody tr[data-batch="B-9"]').waitFor({ timeout: 15_000 });
      expect(s.writes).toEqual(['POST /v1/quality/holds/B-1/release', 'POST /v1/quality/holds/B-9']);
      await s.page.click('#lang');
      await says(s.page, '#page-h', /^தனிமைப்படுத்தல்$/);
      expect(await s.page.locator('#holds-grid tbody tr[data-batch="B-9"]').innerText()).toMatch(/காத்திருப்பில்/);
      expect(await auditPage(s.page, { expectLang: 'ta' })).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const c = await open(CASHIER, '/quarantine');
    try {
      await says(c.page, '#read-status', /cannot read the quarantine register/);
      expect(await c.page.locator('#new-section').isHidden()).toBe(true);
      expect(c.writes).toEqual([]);
    } finally { await c.close(); }
    expect(((await get('/v1/quality/holds/B-1')) as { hold: { status: string; releasedBy: string } }).hold).toMatchObject({ status: 'released', releasedBy: MGR });
  }, 180_000);

  it('adjust a quantity: the manager asks behind the sheet, is never offered his own; a second manager approves behind the sheet; one movement posts and the ledger shows it', async () => {
    expect(await onHand('RICE')).toBe(60_000);
    const s = await open(MGR, '/stock-adjustments');
    try {
      const writes = writeCounter(s.page);
      await s.page.locator('#register .sre-state, #requests-grid').first().waitFor({ timeout: 15_000 });
      await says(s.page, '#reg-status', /^0 waiting for a decision$/);
      await s.page.fill('#product', 'RICE');
      await s.page.fill('#place', 'br-1');
      await s.page.fill('#qty', '2.5'); await s.page.fill('#uom', 'kg');
      await s.page.selectOption('#reason', 'damaged');
      await s.page.fill('#note', 'wet sack at the back');
      // A missing quantity is refused before the sheet and before any request.
      await s.page.fill('#qty', '');
      await s.page.click('#ask');
      await says(s.page, '#new-status', /^Type how many, as a whole number of the unit\.$/);
      expect(writes()).toBe(0);
      await s.page.fill('#qty', '2.5');
      const title = await askedThenConfirmed(s.page, () => s.page.click('#ask'), /Ask for this correction\?/, writes);
      expect(title).toBe('Ask for this correction?');
      await says(s.page, '#new-status', /^Recorded\. Head office holds it for a different person to decide\.$/);
      await says(s.page, '#reg-status', /^1 waiting for a decision$/);
      const row = s.page.locator('#requests-grid tbody tr').first();
      expect(await row.innerText()).toMatch(/RICE[\s\S]*br-1[\s\S]*−2\.500 kg[\s\S]*₹150\.00[\s\S]*Damaged — wet sack at the back[\s\S]*Waiting for a decision[\s\S]*You asked for this one — a different person decides it\./);
      expect(await row.locator('button').count(), 'never offered his own').toBe(0);
      expect(s.writes.length).toBe(1);
      expect(s.writes[0]).toMatch(/^POST \/v1\/inventory\/adjustment-requests\/adj-/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect(await onHand('RICE'), 'nothing moved yet').toBe(60_000);

    const t = await open(MGR2, '/stock-adjustments');
    try {
      const writes = writeCounter(t.page);
      await t.page.locator('#requests-grid tbody tr').first().waitFor({ timeout: 15_000 });
      const row = t.page.locator('#requests-grid tbody tr').first();
      expect(await row.innerText()).not.toContain('You asked for this one');
      // No reason → refused before any request; then the approval behind the sheet.
      await row.locator('button[data-act="approve"]').click();
      await says(t.page, '#requests-grid tbody tr p.status', /^Write a reason first\.$/);
      expect(writes()).toBe(0);
      await row.locator('input.adj-reason').fill('sack torn by the forklift');
      await askedThenConfirmed(t.page, () => row.locator('button[data-act="approve"]').click(), /Approve this correction\?/, writes);
      await says(t.page, '#reg-status', /^Approved\. Head office posted the correction once\.$/);
      await t.page.check('#all');
      await t.page.locator('#requests-grid tbody tr[data-status="posted"]').waitFor({ timeout: 15_000 });
      // The answer stays on the line after the list has reloaded twice — the reload once wiped it before anyone read it.
      expect(await t.page.textContent('#reg-status')).toBe('Approved. Head office posted the correction once.');
      expect(await t.page.locator('#requests-grid tbody tr[data-status="posted"]').innerText()).toMatch(/Approved — correction posted[\s\S]*decided by u-mgr2-u6 — sack torn by the forklift/);
      await t.page.click('#lang');
      await says(t.page, '#page-h', /^அளவைத் திருத்து$/);
      expect(await auditPage(t.page, { expectLang: 'ta' })).toEqual([]);
      expect(t.writes.length).toBe(1);
      expect(t.writes[0]).toMatch(/\/decide$/);
      expect(t.errors).toEqual([]);
    } finally { await t.close(); }
    expect(await onHand('RICE'), 'one compensating movement').toBe(57_500);

    // The ledger shows the correction with both people on it.
    const l = await open(MGR, '/stock-ledger');
    try {
      await l.page.fill('#product', 'RICE'); await l.page.click('#show');
      await l.page.locator('#ledger-grid tbody tr').nth(3).waitFor({ timeout: 15_000 });
      expect(await l.page.locator('#ledger-grid tbody tr').nth(3).innerText()).toMatch(/Written off[\s\S]*−2\.500 kg[\s\S]*57\.500 kg[\s\S]*damaged: wet sack at the back[\s\S]*u-mgr-br1[\s\S]*u-mgr2-u6/);
    } finally { await l.close(); }
  }, 180_000);
});
