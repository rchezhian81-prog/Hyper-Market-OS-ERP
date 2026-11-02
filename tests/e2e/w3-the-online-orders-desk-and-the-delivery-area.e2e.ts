import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import type { RealCloud } from '../support/real-store';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import { shiftDate } from '../../packages/calendar/src/trading-day';

/**
 * **W3 — the Online orders desk and the Delivery area page, in a real browser, on the PRODUCTION API over real PostgreSQL
 * (M18-FR-01 · M18-FR-02 · M18-FR-03 · M18-FR-04 · D05-FR-03 · D08 · AVR-13).**
 *
 *   • the desk reads an online order's lifecycle; confirming an order whose payment the bank has not answered is refused by
 *     head office; the payment is settled from the statement line on the worklist (a settle without it is refused on the
 *     page); then the order is moved step by step;
 *   • a short order's shortfall is recorded as a backorder and shows on the order;
 *   • a cancel gives the order's held stock back in the same step — the desk says what came back, and head office no
 *     longer holds it;
 *   • the stock held for orders at the store; the app's safety buffer is "not set" until a figure is saved with a reason,
 *     then the app may promise less (D05-FR-03);
 *   • a channel's list compared with ours both ways — a line that cannot be read is named, never dropped;
 *   • the delivery area reads "not set" for every figure until the owner types his (head office's standard 10 km is never
 *     shown as his), then his figures from a date, a second set on the same date refused by name, the history kept; the
 *     slots "not set" until saved, then each slot with how full it is; the places that fulfil online orders — a branch with
 *     its express minutes, a dark store that never takes pickup; Tamil; a cashier changes nothing.
 * Synthetic data only. Needs DATABASE_URL and Chromium; else it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['w3', 'orders', 'desk', 'e2e', 'key'].join('-').padEnd(48, '0');

async function seed(cloud: RealCloud): Promise<void> {
  const post = (path: string, body: unknown, userId = OWNER) => ok(cloud.request({ method: 'POST', path, userId, idempotencyKey: `k-${randomUUID()}`, body }), path);
  const arrived = new Date(Date.now() - 3_600_000).toISOString();
  await post('/v1/catalogue/tax-classes/0401/rates/2017-07-01', { rateBps: 0 });
  for (const id of ['MILK', 'BROOM']) {
    await post(`/v1/catalogue/products/${id}/publish`, {
      product: { sku: `${id}-1`, name: `Synthetic ${id}`, baseUom: 'ea', primaryCategoryId: 'grocery-test', taxClass: '0401', lifecycle: 'active' },
      categories: [{ categoryId: 'grocery-test', name: 'Grocery (test)', parentId: null }],
    });
  }
  await post('/v1/inventory/movements', { movementId: 'rx-milk', productId: 'MILK', locationId: 'br-1', kind: 'received', quantityMinor: 20, uom: 'ea', occurredAt: arrived, enteredBy: OWNER, unitCostMinor: 40_00 });
  await post('/v1/inventory/movements', { movementId: 'rx-broom', productId: 'BROOM', locationId: 'br-1', kind: 'received', quantityMinor: 10, uom: 'ea', occurredAt: arrived, enteredBy: OWNER, unitCostMinor: 90_00 });
  // Three online orders: one whose payment the bank has not answered, one ordered beyond the shelf, one to be cancelled.
  await post('/v1/orders/o-pending/promise', { lines: [{ productId: 'MILK', quantityMinor: 2 }], locationId: 'br-1' });
  await post('/v1/orders/o-pending/payment', { providerRef: 'tok_ok_w3', amountMinor: 120_00, result: 'unknown', reason: 'the bank did not answer at checkout (synthetic)' });
  await post('/v1/orders/o-short/promise', { lines: [{ productId: 'MILK', quantityMinor: 25 }], locationId: 'br-1' });
  await post('/v1/orders/o-cancel/promise', { lines: [{ productId: 'BROOM', quantityMinor: 3 }], locationId: 'br-1' });
  await cloud.grant('u-cash', 'cashier');
}

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Online orders desk and the Delivery area (M18 · D05-FR-03) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/online-orders', html: 'online-orders.html', dataGlobal: 'onlineOrdersData' },
      alsoPages: [{ path: '/delivery-area', html: 'delivery-area.html', dataGlobal: 'deliveryAreaData' }],
      seed,
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const api = (path: string, userId = OWNER, branchId?: string) => shop.cloud().request({ method: 'GET', path, userId, ...(branchId === undefined ? {} : { branchId }) });

  it('lifecycle, a payment settled from the statement, a backorder, a cancel that gives the stock back, the app buffer, a channel compared; Tamil; a cashier changes nothing', async () => {
    const errors: string[] = [];
    const ctx = await browser.newContext();
    try {
      await shop.signIn(ctx, MGR, 'br-1');
      const page = await ctx.newPage();
      page.on('pageerror', (e) => { errors.push(String(e)); });
      const reads: string[] = [];
      page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/')) reads.push(`${r.method()} ${u.pathname}`); });
      await page.goto(`${shop.base}/online-orders`, { waitUntil: 'load' });
      expect(reads, 'nothing is read on open').toEqual([]);
      for (const id of ['show-order', 'show-pay', 'show-res', 'show-avail', 'set-buffer', 'compare']) expect(await page.locator(`#${id} svg.sre-icon`).count(), id).toBe(1);

      // ── An order waiting on the bank: confirming it is refused by head office ──
      await page.click('#show-order');
      expect(await page.textContent('#order-status')).toBe('⚠ Give the order number first. Nothing was read.');
      await page.fill('#order-id', 'o-pending');
      await page.click('#show-order');
      const order = page.locator('#order li[data-order="o-pending"]');
      await order.waitFor({ timeout: 15_000 });
      expect(await order.locator('.state-line').textContent()).toBe('○ o-pending — Now: placed');
      expect(await order.locator('.payment').textContent()).toBe('Payment: waiting for the bank');
      expect(await order.locator('.held').textContent()).toBe('Stock held for it: 2 × MILK');
      expect(await order.locator('button.step').allTextContents()).toEqual(['Confirm', 'Cancel the order']);
      await order.locator('button.step-confirm').click();
      await page.locator('#order-status', { hasText: '⚠ Head office refused: Order "o-pending" is waiting for the bank to confirm its payment.' }).waitFor({ timeout: 15_000 });

      // ── The worklist: settle it from the statement line ──
      await page.click('#show-pay');
      const waiting = page.locator('#pay li[data-payment="o-pending"]');
      await waiting.waitFor({ timeout: 15_000 });
      expect(await waiting.locator('strong').textContent()).toBe('⏱ Waiting for the bank — o-pending · ₹120.00');
      await waiting.locator('button.settle-authorised').click();
      expect(await page.textContent('#pay-status')).toBe('⚠ Give the bank statement line first. Nothing was sent.');
      await waiting.locator('input.statement').fill('STMT-2026-11-02-0007');
      await waiting.locator('button.settle-authorised').click();
      await page.locator('#pay li', { hasText: 'No payment is waiting for the bank.' }).waitFor({ timeout: 15_000 });
      expect(await page.textContent('#pay-status')).toBe('✓ Recorded from the statement: o-pending — paid');

      // ── Then it moves, one step at a time ──
      await page.click('#show-order');
      await order.locator('.payment', { hasText: 'Payment: paid' }).waitFor({ timeout: 15_000 });
      await order.locator('button.step-confirm').click();
      await page.locator('#order li[data-state="confirmed"]').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#order-status')).toBe('✓ Moved: o-pending — placed → confirmed.');
      await page.locator('#order button.step-pick').click();
      await page.locator('#order li[data-state="picking"]').waitFor({ timeout: 15_000 });

      // ── A short order: the shortfall recorded as a backorder ──
      await page.fill('#order-id', 'o-short');
      await page.click('#show-order');
      const short = page.locator('#order li[data-order="o-short"]');
      await short.waitFor({ timeout: 15_000 });
      expect(await short.locator('.backorders').textContent()).toBe('No backorder recorded.');
      expect(await short.locator('.payment').textContent()).toBe('Payment: no online payment');
      await short.locator('button.backorder').click();
      await page.locator('#order-status', { hasText: '✓ Backorder recorded:' }).waitFor({ timeout: 15_000 });
      expect(await page.textContent('#order-status')).toBe('✓ Backorder recorded: 7 × MILK');
      expect(await page.locator('#order li[data-order="o-short"] .backorders').textContent()).toBe('⚠ Not held (backorder): 7 × MILK');
      expect(await page.locator('#order li[data-order="o-short"] button.backorder').count()).toBe(0);

      // ── A cancel gives the held stock back in the same step ──
      await page.fill('#order-id', 'o-cancel');
      await page.click('#show-order');
      await page.locator('#order li[data-order="o-cancel"] .held', { hasText: '3 × BROOM' }).waitFor({ timeout: 15_000 });
      await page.locator('#order button.step-cancel').click();
      await page.locator('#order li[data-order="o-cancel"][data-state="cancelled"]').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#order-status')).toBe('✓ Moved: o-cancel — placed → cancelled. Stock given back: 3 × BROOM');
      expect(await page.textContent('#order li[data-order="o-cancel"] .held')).toBe('No stock is held for it.');
      expect(await page.textContent('#order li[data-order="o-cancel"] .steps')).toBe('This order is finished — no step is left.');

      // ── The stock held at the store (head office's own answer) ──
      await page.fill('#res-store', 'br-1');
      await page.click('#show-res');
      await page.locator('#res li[data-order="o-pending"]').waitFor({ timeout: 15_000 });
      expect(await page.locator('#res li[data-order="o-cancel"]').count()).toBe(0);
      expect(await page.locator('#res li[data-order="o-short"]').textContent()).toContain('o-short — 18 × MILK');
      const held = (await api('/v1/orders/reservations?locationId=br-1', MGR, 'br-1')).body as { outstanding: { orderId: string }[] };
      expect(held.outstanding.map((r) => r.orderId).sort()).toEqual(['o-pending', 'o-short']);

      // ── D05-FR-03: the app's buffer — not set, then saved with a reason; the app may promise less ──
      await page.fill('#buf-store', 'br-1');
      await page.click('#show-avail');
      const milk = page.locator('#avail li[data-product="MILK"]');
      await milk.waitFor({ timeout: 15_000 });
      expect(await milk.locator('.may').textContent()).toBe('MILK — the app may promise: 0');
      const broom = page.locator('#avail li[data-product="BROOM"]');
      expect(await broom.locator('.may').textContent()).toBe('BROOM — the app may promise: 10');
      expect(await broom.locator('.facts').textContent()).toBe('on hand 10 · held for orders 0 · ○ buffer not set');
      await page.fill('#buf-product', 'BROOM');
      await page.fill('#buf-units', '4');
      await page.click('#set-buffer');
      expect(await page.textContent('#buf-status')).toBe('⚠ Say why first. Nothing was sent.');
      await page.fill('#buf-reason', 'Keep four on the shelf for walk-in shoppers (synthetic)');
      await page.click('#set-buffer');
      await page.locator('#buf-status', { hasText: '✓ Buffer saved: BROOM — 4' }).waitFor({ timeout: 15_000 });
      await page.locator('#avail li[data-product="BROOM"] .may', { hasText: 'the app may promise: 6' }).waitFor({ timeout: 15_000 });
      expect(await page.textContent('#avail li[data-product="BROOM"] .facts')).toBe('on hand 10 · held for orders 0 · kept back 4');
      const avail = (await api('/v1/inventory/online-availability?locationId=br-1', MGR, 'br-1')).body as { rows: { productId: string; appMayPromiseMinor: number }[]; buffers: { setBy: string; reason: string }[] };
      expect(avail.rows.find((r) => r.productId === 'BROOM')?.appMayPromiseMinor).toBe(6);
      expect(avail.buffers.map((b) => b.setBy)).toEqual([MGR]);

      // ── A channel's list compared with ours, both ways ──
      await page.fill('#rec-channel', 'Marketplace (synthetic)');
      await page.fill('#rec-theirs', 'o-pending, 120, confirmed\no-ghost, sixty, placed');
      await page.fill('#rec-ours', 'o-pending, 120, picking');
      await page.click('#compare');
      expect(await page.textContent('#rec-status')).toBe('⚠ A line could not be read (number, rupees, state): o-ghost, sixty, placed');
      await page.fill('#rec-theirs', 'o-pending, 120, confirmed\no-ghost, 60, placed');
      await page.fill('#rec-ours', 'o-pending, 120, picking\no-cancel, 1,050.50, cancelled');
      await page.click('#compare');
      await page.locator('#rec li.summary').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#rec li.summary')).toBe('⚠ Marketplace (synthetic): Differences: Matched 0 (₹0.00) · Money in the differences ₹1,110.50');
      expect(await page.locator('#rec li[data-kind]').evaluateAll((ls) => ls.map((l) => `${(l as unknown as { dataset: { order: string; kind: string } }).dataset.order} ${(l as unknown as { dataset: { kind: string } }).dataset.kind}`)))
        .toEqual(['o-ghost in_channel_not_in_ledger', 'o-pending state_mismatch', 'o-cancel in_ledger_not_in_channel']);
      expect(await page.textContent('#rec li[data-order="o-cancel"]')).toBe('⚠ o-cancel — With us, not on the channel — it will not be paidWe say: ₹1,050.50');

      await page.click('#lang');
      expect(await page.textContent('#order-h')).toBe('ஒரு ஆர்டர்');
      expect(await page.textContent('#order li[data-order="o-cancel"] .state-line')).toBe('✓ o-cancel — இப்போது: ரத்து செய்யப்பட்டது');
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }

    // A cashier moves nothing and keeps nothing back.
    const cash = await browser.newContext();
    try {
      await shop.signIn(cash, 'u-cash', 'br-1');
      const page = await cash.newPage();
      await page.goto(`${shop.base}/online-orders`, { waitUntil: 'load' });
      for (const id of ['set-buffer', 'show-res']) expect(await page.isDisabled(`#${id}`), id).toBe(true);
    } finally { await cash.close(); }
  }, 240_000);

  it('the delivery area reads "not set" until the owner types his figures; a second set on the same date refused; the slots and how full each is; Tamil', async () => {
    const errors: string[] = [];
    const ctx = await browser.newContext();
    const today = shopDateIn(new Date().toISOString());
    const tomorrow = shiftDate(today, 1);
    try {
      await shop.signIn(ctx, OWNER);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => { errors.push(String(e)); });
      await page.goto(`${shop.base}/delivery-area`, { waitUntil: 'load' });
      expect(await page.inputValue('#area-on')).toBe(today);
      await page.click('#show-area');
      await page.locator('#area dd[data-field="radius"]').waitFor({ timeout: 15_000 });
      for (const f of ['radius', 'minimum', 'fee', 'freeAbove', 'from']) expect(await page.textContent(`#area dd[data-field="${f}"]`), f).toBe('not set');
      expect(await page.textContent('#area-default')).toBe('○ Not set by the owner — head office uses the standard 10 km until he sets it.');
      await page.fill('#slots-day', tomorrow);
      await page.click('#show-slots');
      await page.locator('#service[data-state="not_set"]').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#service')).toBe('○ Delivery slots: not set — every delivery order is refused until they are set.');

      // His figures, from today — only what he typed; the minimum stays not set.
      await page.fill('#a-radius', '7.5');
      await page.fill('#a-fee', '30');
      await page.click('#save-area');
      await page.locator('#set-area-status', { hasText: `✓ Saved from ${today}.` }).waitFor({ timeout: 15_000 });
      await page.locator('#area dd[data-field="radius"]', { hasText: '7.5 km' }).waitFor({ timeout: 15_000 });
      expect(await page.textContent('#area dd[data-field="fee"]')).toBe('₹30.00');
      expect(await page.textContent('#area dd[data-field="minimum"]')).toBe('not set');
      expect(await page.textContent('#area dd[data-field="from"]')).toBe(today);
      expect(await page.isHidden('#area-default')).toBe(true);
      // A different set on the same date is refused by name; the history keeps the one.
      await page.fill('#a-radius', '9');
      await page.click('#save-area');
      await page.locator('#set-area-status', { hasText: `⚠ Head office refused: A serviceability policy already takes effect on ${today}` }).waitFor({ timeout: 15_000 });
      await page.click('#show-history');
      await page.locator(`#history li[data-from="${today}"]`).waitFor({ timeout: 15_000 });
      expect(await page.locator('#history li').count()).toBe(1);
      expect(await page.textContent(`#history li[data-from="${today}"] .facts`)).toBe('Delivers up to: 7.5 km · Minimum order: not set · Delivery fee: ₹30.00 · Free delivery above: not set');

      // The slots: refused on the page while the hours are back to front; then saved and shown with how full each is.
      await page.fill('#s-lat', '11.0168');
      await page.fill('#s-lon', '76.9558');
      await page.fill('#s-count', '6');
      await page.fill('#s-open', '21:00');
      await page.fill('#s-close', '09:00');
      await page.fill('#s-capacity', '10');
      await page.click('#save-slots');
      expect(await page.textContent('#set-slots-status')).toMatch(/^⚠ Give the store's latitude and longitude/);
      await page.fill('#s-open', '09:00');
      await page.fill('#s-close', '21:00');
      await page.click('#save-slots');
      await page.locator('#set-slots-status', { hasText: '✓ Slots saved.' }).waitFor({ timeout: 15_000 });
      await page.locator('#service[data-state="set"]').waitFor({ timeout: 15_000 });
      expect(await page.locator('#slots li').count()).toBe(6);
      expect(await page.locator('#slots li').first().textContent()).toBe('○ 09:00–11:00 — 0 / 10 taken');
      expect(await page.textContent('#service')).toMatch(/^Store location: 11\.0168, 76\.9558 · Slots a day: 6 · 09:00–21:00 · Orders each slot can take: 10 · Notice needed to pick \(minutes\): 60 · Set by u-owner, /);

      // The places that fulfil online orders (M18-FR-03): none set; a branch with express minutes; a dark store, never pickup.
      await page.click('#show-places');
      await page.locator('#places li', { hasText: 'No place is set up yet: not set.' }).waitFor({ timeout: 15_000 });
      await page.fill('#p-id', 'br-1');
      await page.fill('#p-lat', '11.0168');
      await page.fill('#p-lon', '76.9558');
      await page.fill('#p-radius', '7.5');
      await page.fill('#p-express', '45');
      await page.check('#p-pickup');
      await page.click('#save-place');
      await page.locator('#places li[data-place="br-1"]').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#places li[data-place="br-1"] .facts')).toMatch(/^Takes pickup: yes · Delivers: yes · Delivers up to: 7\.5 km · express in 45 minutes · orders a slot: not set · Set by u-owner, /);
      await page.fill('#p-id', 'DS-1');
      await page.selectOption('#p-kind', 'dark_store');
      expect(await page.isChecked('#p-pickup')).toBe(false);
      expect(await page.isDisabled('#p-pickup')).toBe(true);
      await page.fill('#p-express', '');
      await page.fill('#p-slot', '12');
      await page.click('#save-place');
      await page.locator('#places li[data-place="DS-1"][data-kind="dark_store"]').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#places li[data-place="DS-1"] strong')).toBe('DS-1 — Dark store');
      expect(await page.textContent('#places li[data-place="DS-1"] .facts')).toMatch(/^Takes pickup: no · Delivers: yes · Delivers up to: 7\.5 km · no express · orders a slot: 12 · /);

      await page.click('#lang');
      expect(await page.textContent('#area-h')).toBe('டெலிவரி பகுதி');
      expect(await page.textContent('#places li[data-place="DS-1"] strong')).toBe('DS-1 — டார்க் ஸ்டோர்');
      expect(await page.textContent('#area dd[data-field="minimum"]')).toBe('அமைக்கப்படவில்லை');
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }

    // Head office holds the owner's figures; a cashier can set nothing on the page.
    const resolved = (await api(`/v1/serviceability?on=${today}`)).body as { source: string; policy: { radiusMetres: number } };
    expect(resolved).toMatchObject({ source: 'scheduled', policy: { radiusMetres: 7_500 } });
    const cash = await browser.newContext();
    try {
      await shop.signIn(cash, 'u-cash', 'br-1');
      const page = await cash.newPage();
      await page.goto(`${shop.base}/delivery-area`, { waitUntil: 'load' });
      for (const id of ['save-area', 'save-slots', 'show-area', 'save-place']) expect(await page.isDisabled(`#${id}`), id).toBe(true);
    } finally { await cash.close(); }
  }, 180_000);
});
