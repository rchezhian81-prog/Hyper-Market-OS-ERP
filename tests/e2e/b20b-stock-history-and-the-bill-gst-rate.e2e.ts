import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import type { RealCloud } from '../support/real-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **Batch 20b, in a real browser, on the PRODUCTION API over real PostgreSQL** — the store manager:
 *
 *   • S2 — Waste & write-off: picks the days, presses Show, reads every write-off of those days by its WOF number with the
 *     total and the totals by kind; a range with none says so.
 *   • S3 — Stock counts: earlier counts by their CNT number and how accurate they were.
 *   • S4 — Stock health: what the empty shelves cost, with the basis in plain words and "Not known" where it is.
 *   • S5 — Transfers: a suggested transfer; "Start this transfer" fills the form and SENDS NOTHING.
 *   • Count review: the count plan's drawer is titled with its CNT number, not its internal id.
 *   • A2 — Supplier bills: a typed line's GST rate is filled from the item, marked "check against the bill"; a different rate
 *     is flagged and named in the second person's check; the bill sent carries no rate.
 * Each in English, and one in Tamil (one language at a time). Needs DATABASE_URL and the pre-installed Chromium.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const SHOTS = process.env['B20B_SHOTS'];
const KEY = ['b20b', 'stock', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();
type Doc = { getElementById(x: string): { textContent: string | null } | null; querySelectorAll(x: string): { length: number } };

const today = shopDateIn(new Date().toISOString());
const daysAgo = (n: number, hour = 11): string => {
  const d = new Date(`${today}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return new Date(`${d.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00:00.000+05:30`).toISOString();
};
const ddmm = (iso: string): string => { const d = shopDateIn(iso); return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`; };

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('Batch 20b: stock history on the stock pages, and a typed bill\'s GST rate from the item', () => {
  let browser: Browser;
  let shop: InboxShop;
  let pool: Pool;
  let planNumber = '';
  const as = (c: RealCloud, userId: string, path: string, body: unknown, key: string) => c.request({ method: 'POST', path, userId, body, idempotencyKey: key });

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    if (SHOTS !== undefined) mkdirSync(SHOTS, { recursive: true });
    pool = new Pool({ connectionString: DATABASE_URL, max: 2, options: '-c app.tenant_id=*' });
    const events = new SqlEventStore(pgPoolClient(pool));
    const data = (dataGlobal: string, path: string, html: string) => ({ path, html, dataGlobal });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: TENANT, signingKey: KEY,
      page: data('wasteData', '/waste', 'waste.html'),
      alsoPages: [data('countsData', '/counts', 'counts.html'), data('stockHealthData', '/stock-health', 'stock-health.html'), data('transfersData', '/transfers', 'transfers.html'), data('countPlansData', '/count-plans', 'count-plans.html'), data('supplierBillsData', '/supplier-bills', 'supplier-bills.html')],
      seed: async (c) => {
        await ok(as(c, OWNER, '/v1/org/nodes/br-1-back', { kind: 'warehouse', name: 'Store 1 back store', parentId: 'br-1', companyId: 'C-PRACTICE' }, 'org-back'), 'back store');
        // The published catalogue: OIL at 5% GST.
        await events.append(TENANT, 'catalogue', makeEvent({ id: `pack-${TENANT}-b20b`, type: 'CataloguePublished', occurredAt: daysAgo(40), idempotencyKey: `catalogue-${TENANT}-b20b`, source: 'test/catalogue',
          payload: { snapshot: { tenantId: TENANT, version: 1, builtAt: daysAgo(40), scope: { tenantId: TENANT, storeId: 'br-1' }, barcodes: [], products: [
            { productId: 'OIL', sku: 'OIL', name: 'Sunflower oil 1L', unitPriceMinor: 2_000, taxBps: 500, status: 'active', baseUom: 'ea' },
          ] } } }));
        const move = (id: string, productId: string, locationId: string, kind: string, qty: number, at: string) =>
          ok(as(c, OWNER, '/v1/inventory/movements', { movementId: id, productId, locationId, kind, quantityMinor: qty, uom: 'ea', occurredAt: at, enteredBy: OWNER, unitCostMinor: 1_000 }, id), id);
        const sell = (saleId: string, p: string, q: number, at: string) => ok(as(c, OWNER, '/v1/sales', {
          saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', locationId: 'br-1', cashierId: OWNER, tradingDay: shopDateIn(at), committedAt: at,
          totalMinor: q * 2_000, currency: 'INR', packVersion: 1, lines: [{ productId: p, quantityMinor: q, uom: 'ea', unitPriceMinor: 2_000, lineTotalMinor: q * 2_000 }], tenders: [{ kind: 'cash', amountMinor: q * 2_000 }],
        }, saleId), saleId);
        // S4/S5: OIL on the shelf at br-1 — 10 in, 2 sold a day for five days, then empty; 6 wait in the back store.
        await move('rx-oil', 'OIL', 'br-1', 'received', 10, daysAgo(20, 7));
        for (const n of [20, 19, 18, 17, 16]) await sell(`s-${n}`, 'OIL', 2, daysAgo(n, 13));
        await move('rx-back', 'OIL', 'br-1-back', 'received', 6, daysAgo(3, 7));
        // Then one more came in and sold out yesterday — it sold this week and is out, while the back store holds 6.
        await move('rx-oil-2', 'OIL', 'br-1', 'received', 1, daysAgo(2, 7));
        await sell('s-recent', 'OIL', 1, daysAgo(1, 13));
        // S2: two write-offs from earlier days, on the register as they were saved then.
        for (const [id, n, num, loss, value] of [['wo-1', 9, 'WOF1/26-27/00041', 'expiry', 30_000], ['wo-2', 4, 'WOF1/26-27/00042', 'damage', 4_000]] as const) {
          await events.append(TENANT, 'inventory\u001fwrite-offs', makeEvent({ id: `wo-${id}`, type: 'WriteOffCommitted', occurredAt: daysAgo(n), idempotencyKey: `wo-${TENANT}-${id}`, source: 'test',
            payload: { id, documentNumber: num, productId: 'OIL', locationId: 'br-1', lossType: loss, qtyRemoved: 1, uom: 'ea', valueMinor: value, currency: 'INR', reasonCode: loss, requiredApproval: false, evidenceRef: null, raisedBy: MGR, approvedBy: null, at: daysAgo(n), valueSource: 'stock_cost' } }));
        }
        // S3: one count today (its own CNT number) and an earlier one that matched.
        await ok(c.request({ method: 'POST', path: '/v1/inventory/counts/c-today', userId: MGR, branchId: 'br-1', idempotencyKey: 'c-today', body: { productId: 'OIL', locationId: 'br-1', uom: 'ea', countedMinor: 0, reasonCode: 'cycle_count' } }), 'count');
        await events.append(TENANT, 'inventory\u001fcounts', makeEvent({ id: 'count-c-old', type: 'CountReconciled', occurredAt: daysAgo(6), idempotencyKey: `count-${TENANT}-c-old`, source: 'test',
          payload: { countId: 'c-old', documentNumber: 'CNT1/26-27/00031', productId: 'OIL', locationId: 'br-1', expectedMinor: 4, countedMinor: 4, varianceMinor: 0, valueMinor: 0, currency: 'INR', reasonCode: 'cycle_count', reconciled: true, adjusted: false, requiredApproval: false, counterId: MGR, approvedBy: null, at: daysAgo(6) } }));
        // Count review: a count plan (its CNT number is taken when it is planned).
        const planned = await c.request({ method: 'POST', path: '/v1/inventory/count-plans/plan-b20b', userId: MGR, branchId: 'br-1', idempotencyKey: 'plan', body: { locationId: 'br-1', productIds: ['OIL'], recountThresholdMinor: 0 } });
        if (planned.status >= 300) throw new Error(`plan: ${JSON.stringify(planned.body)}`);
        planNumber = String((planned.body as { plan?: { documentNumber?: string }; documentNumber?: string }).plan?.documentNumber ?? (planned.body as { documentNumber?: string }).documentNumber ?? '');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); await pool?.end(); });

  const open = async (path: string) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    await shop.signIn(context, MGR, 'br-1');
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    await page.waitForFunction('globalThis.sreOffice !== undefined');
    return { page, writes, errors, close: () => context.close() };
  };
  const textOf = (page: Page, id: string) => page.evaluate((x) => (globalThis as unknown as { document: Doc }).document.getElementById(x)?.textContent ?? '', id);
  const waitText = (page: Page, id: string, re: RegExp) =>
    page.waitForFunction(([x, src]) => new RegExp(src as string).test((globalThis as unknown as { document: Doc }).document.getElementById(x as string)?.textContent ?? ''), [id, re.source], { timeout: 20_000 });
  const shot = async (page: Page, name: string) => { if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };
  const setDay = async (page: Page, id: string, iso: string) => { await page.fill(`#${id}`, ddmm(iso)); await page.locator(`#${id}`).blur(); };

  it('S2: earlier write-offs by date range, with their numbers and the totals; a range with none says so', async () => {
    const s = await open('/waste');
    try {
      await s.page.locator('#past-write-offs-section').waitFor({ state: 'visible', timeout: 20_000 });
      await waitText(s.page, 'wo-h', /^Earlier write-offs$/);
      await setDay(s.page, 'wo-from', daysAgo(14)); await setDay(s.page, 'wo-to', daysAgo(0));
      await s.page.click('#wo-show');
      await s.page.locator('#past-write-offs-section tr[data-write-off="WOF1/26-27/00041"]').waitFor({ timeout: 20_000 });
      expect(await s.page.locator('#past-write-offs-section tr[data-write-off]').count()).toBe(2);
      expect(await textOf(s.page, 'wo-cards-total')).toBe('₹340.00');
      expect(await textOf(s.page, 'wo-extra')).toMatch(/Expired: 1 · ₹300\.00.*Damage: 1 · ₹40\.00/);
      await shot(s.page, 's2-1-earlier-write-offs');
      await s.page.click('#lang');
      await waitText(s.page, 'wo-h', /^முந்தைய தள்ளுபடிகள்$/);
      expect(await textOf(s.page, 'wo-extra')).toMatch(/காலாவதி: 1/);
      await shot(s.page, 's2-2-earlier-write-offs-tamil');
      await s.page.click('#lang');
      await setDay(s.page, 'wo-from', daysAgo(3)); await setDay(s.page, 'wo-to', daysAgo(1));
      await s.page.click('#wo-show');
      await waitText(s.page, 'wo-status', /^No write-offs were saved in these days\.$/);
      expect(s.writes, 'reading writes nothing').toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  });

  it('S3: earlier counts by their numbers, and how accurate they were', async () => {
    const s = await open('/counts');
    try {
      await s.page.locator('#past-counts-section').waitFor({ state: 'visible', timeout: 20_000 });
      await s.page.click('#ch-show');
      await s.page.locator('#past-counts-section tr[data-count="CNT1/26-27/00031"]').waitFor({ timeout: 20_000 });
      expect(await s.page.locator('#past-counts-section tr[data-count^="CNT"]').count()).toBe(2);
      expect(await textOf(s.page, 'ch-cards-counts')).toBe('2');
      expect(await textOf(s.page, 'ch-cards-exact')).toMatch(/^(50|100)%$/);
      await shot(s.page, 's3-1-earlier-counts-and-accuracy');
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  });

  it('S4: what the empty shelves cost — an estimate, its basis said, in English and Tamil', async () => {
    const s = await open('/stock-health');
    try {
      await s.page.locator('#stockout-section').waitFor({ state: 'visible', timeout: 20_000 });
      await waitText(s.page, 'so-basis', /none at the start of the day and nothing of it was sold that day/);
      await s.page.click('#so-show');
      await s.page.locator('#stockout-section tr[data-product="OIL"]').waitFor({ timeout: 20_000 });
      expect(await s.page.locator('#stockout-section tr[data-product="OIL"]').innerText()).toMatch(/\b\d+ of 2[01]\b[\s\S]*₹\d/);
      expect(await textOf(s.page, 'so-cards-lost')).toMatch(/^₹\d/);
      expect(await textOf(s.page, 'so-lede')).toMatch(/last 28 days.*estimate/);
      await shot(s.page, 's4-1-what-the-empty-shelves-cost');
      await s.page.click('#lang');
      await waitText(s.page, 'so-h', /^காலி அலமாரிகளின் இழப்பு/);
      await shot(s.page, 's4-2-what-the-empty-shelves-cost-tamil');
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  });

  it('S5: a suggested transfer fills the Start-a-transfer form and sends nothing', async () => {
    const s = await open('/transfers');
    try {
      await s.page.locator('#transfer-suggestions-section').waitFor({ state: 'visible', timeout: 20_000 });
      await s.page.click('#ts-show');
      const row = s.page.locator('#transfer-suggestions-section tr[data-product="OIL"]');
      await row.waitFor({ timeout: 20_000 });
      expect(await row.getAttribute('data-from')).toBe('br-1-back');
      expect(await row.getAttribute('data-to')).toBe('br-1');
      await shot(s.page, 's5-1-suggested-transfers');
      await row.locator('button.ts-start').click();
      expect([await s.page.inputValue('#s-from'), await s.page.inputValue('#s-to'), await s.page.inputValue('#s-item'), await s.page.inputValue('#s-qty')]).toEqual(['br-1-back', 'br-1', 'OIL', '']);
      await waitText(s.page, 'ts-status', /Type how many/);
      await shot(s.page, 's5-2-start-this-transfer-filled');
      expect(s.writes, 'a suggestion moves nothing').toEqual([]);
      const listed = (await shop.cloud().request({ method: 'GET', path: '/v1/warehouse/transfers', userId: OWNER })).body as { transfers?: unknown[] };
      expect(listed.transfers ?? []).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  });

  it('Count review: the count plan is titled by its CNT number, not its internal id', async () => {
    expect(planNumber).toMatch(/^CNT\d\/\d\d-\d\d\/\d{5}$/);
    const s = await open('/count-plans');
    try {
      await s.page.locator('button[data-act="view"]').first().waitFor({ timeout: 20_000 });
      await s.page.locator('button[data-act="view"]').first().click();
      await waitText(s.page, 'd-title', new RegExp(`^${planNumber.replace(/\//g, '\\/')}$`));
      expect(await textOf(s.page, 'd-title')).not.toContain('plan-b20b');
      await shot(s.page, 'count-review-titled-by-its-number');
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  });

  it('A2: a typed line\'s GST rate comes from the item, is marked to check, and a different rate is flagged for the second person', async () => {
    const s = await open('/supplier-bills');
    try {
      await s.page.click('#type-paper');
      await s.page.locator('#type-part').waitFor({ state: 'visible' });
      await s.page.fill('#type-invoice', 'sup-1-B20B');
      await s.page.fill('#type-supplier', 'sup-1');
      const r1 = s.page.locator('#type-lines tr[data-row="1"]');
      await r1.locator('.t-productId').fill('OIL');
      await r1.locator('.t-productId').blur();
      await s.page.waitForFunction(() => ((globalThis as unknown as { document: { querySelector(x: string): { value: string } | null } }).document.querySelector('#type-lines tr[data-row="1"] .t-rate')?.value ?? '') === '5', undefined, { timeout: 20_000 });
      expect(await r1.locator('.rate-mark').innerText()).toBe('from the item (5%) — check against the bill');
      await shot(s.page, 'a2-1-gst-rate-from-the-item');
      await r1.locator('.t-quantity').fill('10'); await r1.locator('.t-unitPrice').fill('100'); await r1.locator('.t-amount').fill('1000');
      await r1.locator('.t-cgst').fill('60'); await r1.locator('.t-sgst').fill('60');
      await r1.locator('.t-rate').fill('12');
      expect(await r1.locator('.rate-mark').innerText()).toBe('differs from the item\'s 5% — ask a second person to look again');
      expect(await r1.locator('.rate-mark').getAttribute('data-mark')).toBe('differs');
      expect(await r1.locator('.t-rate').inputValue(), 'never changed back').toBe('12');
      await s.page.fill('#type-total', '1120');
      await shot(s.page, 'a2-2-a-different-rate-is-flagged');
      await s.page.click('#lang');
      await s.page.waitForFunction(() => /பொருளின் 5%/.test((globalThis as unknown as { document: { querySelector(x: string): { textContent: string | null } | null } }).document.querySelector('#type-lines tr[data-row="1"] .rate-mark')?.textContent ?? ''), undefined, { timeout: 20_000 }).catch(() => undefined);
      await shot(s.page, 'a2-3-a-different-rate-is-flagged-tamil');
      await s.page.click('#lang');
      await s.page.click('#type-ask');
      await waitText(s.page, 'type-status', /Asked/);
      expect(s.writes).toEqual(['POST /v1/approvals/requests']);
      const mine = (await shop.cloud().request({ method: 'GET', path: '/v1/approvals/requests', userId: MGR, branchId: 'br-1' })).body as { mine: { kind: string; summary: string; details: Record<string, unknown> }[] };
      const check = mine.mine.find((q) => q.kind === 'supplier_invoice_check')!;
      expect(check.summary).toMatch(/look again at the GST rate: line 1 \(OIL\): GST typed 12%, the item says 5%/);
      expect(JSON.stringify(check.details), 'the bill carries no rate').not.toMatch(/"rate"|itemBps/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  });
});
