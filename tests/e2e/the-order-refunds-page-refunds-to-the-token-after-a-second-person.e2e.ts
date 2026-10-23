import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * M18-FR-04 ("refunds by token … refund approval per policy") — the Order refunds page, in a real browser, on the
 * PRODUCTION API over real PostgreSQL. Nothing is read on open. The manager reads an online order's money, ASKS a second
 * person to approve exactly this refund (the owner approves it in their own session), then issues it — to the order's own
 * payment token; a refund the bank does not answer reads "waiting for the bank" and sits on the worklist until the
 * statement line is recorded (a record without the line is refused on the page). Tamil. A cashier changes nothing.
 * Needs DATABASE_URL and Chromium; else it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['refunds', 'e2e', 'key'].join('-').padEnd(48, '0');

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Order refunds page (M18-FR-04) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/order-refunds', html: 'order-refunds.html', dataGlobal: 'orderRefundsData' },
      seed: async (cloud) => {
        const post = (path: string, body: unknown, key: string) => ok(cloud.request({ method: 'POST', path, userId: OWNER, idempotencyKey: key, body }), key);
        for (const [orderId, token] of [['o-paid', 'tok_ok_1'], ['o-slow', 'tok_slow-unknown']] as const) {
          await post(`/v1/orders/${orderId}/promise`, { lines: [{ productId: 'MILK', quantityMinor: 2 }], locationId: 'br-1' }, `place-${orderId}`);
          await post(`/v1/orders/${orderId}/payment`, { providerRef: token, amountMinor: 10_000, result: 'authorised' }, `pay-${orderId}`);
        }
        await cloud.grant('u-cash', 'cashier');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const approve = async (requestId: string) =>
    ok(shop.cloud().request({ method: 'POST', path: `/v1/approvals/requests/${requestId}/decide`, userId: OWNER, idempotencyKey: `decide-${requestId}`, body: { decision: 'approved', reason: 'checked the order (synthetic)' } }), 'owner approves');

  it('read the money, ask, a second person approves, issue to the token; the bank\'s silence waits on the worklist until the statement line; Tamil; a cashier changes nothing', async () => {
    const errors: string[] = [];
    const ctx = await browser.newContext();
    try {
      await shop.signIn(ctx, MGR, 'br-1');
      const page = await ctx.newPage();
      page.on('pageerror', (e) => { errors.push(String(e)); });
      const reads: string[] = [];
      page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/')) reads.push(`${r.method()} ${u.pathname}`); });
      await page.goto(`${shop.base}/order-refunds`, { waitUntil: 'load' });
      expect(reads, 'nothing is read on open').toEqual([]);

      await page.fill('#order-id', 'o-paid');
      await page.click('#show-order');
      await page.locator('#money li[data-order="o-paid"]').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#money .paid')).toBe('Paid: ₹100.00');
      expect(await page.textContent('#money .refundable')).toBe('Can still be refunded: ₹100.00');

      // Issue before asking: refused on the page.
      await page.click('#issue');
      expect(await page.textContent('#refund-status')).toBe('⚠ Ask for the approval first, then issue the refund once it is approved.');
      await page.fill('#amount', '40');
      await page.selectOption('#basis', 'goodwill');
      await page.click('#ask');
      expect(await page.textContent('#refund-status')).toBe('⚠ Say why in words first. Nothing was sent.');
      await page.fill('#reason', 'Late delivery (synthetic)');
      await page.click('#ask');
      await page.locator('#refund-status', { hasText: '✓ Asked' }).waitFor({ timeout: 15_000 });
      const requestId = await page.inputValue('#approval-id');
      expect(requestId).not.toBe('');
      // Issued before the second person decides: head office refuses it.
      await page.click('#issue');
      await page.locator('#refund-status', { hasText: '⚠ Head office refused:' }).waitFor({ timeout: 15_000 });
      // Nothing moved. Once the owner approves that same request in his own session, the page's kept draft goes.
      await approve(requestId);
      await page.click('#issue');
      await page.locator('#refund-status[data-state="issued"]').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#refund-status')).toMatch(/^✓ Refund rf-\w+ · ₹40\.00 — refunded$/);
      await page.locator('#money .refundable', { hasText: '₹60.00' }).waitFor({ timeout: 15_000 });
      expect(await page.textContent('#money .refunded')).toBe('Refunded: ₹40.00');

      // The second order's bank does not answer: the refund waits, on the worklist.
      await page.fill('#order-id', 'o-slow');
      await page.fill('#amount', '25');
      await page.fill('#reason', 'Item missing (synthetic)');
      await page.selectOption('#basis', 'short_pick');
      await page.click('#ask');
      await page.locator('#refund-status', { hasText: '✓ Asked' }).waitFor({ timeout: 15_000 });
      await approve(await page.inputValue('#approval-id'));
      await page.click('#issue');
      await page.locator('#refund-status[data-state="pending"]').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#refund-status')).toMatch(/^⏱ Refund rf-\w+ · ₹25\.00 — waiting for the bank$/);
      await page.click('#show-pending');
      const row = page.locator('#pending li[data-order="o-slow"]');
      await row.waitFor({ timeout: 15_000 });
      expect(await row.innerText()).toMatch(/⏱ Refund not confirmed by the bank — o-slow · ₹25\.00[\s\S]*Something was missing · Item missing \(synthetic\)/);
      await row.locator('button.outcome-refunded').click();
      expect(await page.textContent('#pending-status')).toBe('⚠ Give the bank statement line first. Nothing was sent.');
      await row.locator('input.statement').fill('STMT-2026-10-23-0042');
      await row.locator('button.outcome-refunded').click();
      await page.locator('#pending li', { hasText: 'Nothing is waiting on the bank.' }).waitFor({ timeout: 15_000 });
      expect(await page.textContent('#pending-status')).toMatch(/^✓ Recorded from the statement: rf-\w+ — The bank refunded it$/);
      for (const id of ['show-pending', 'show-order', 'ask', 'issue']) expect(await page.locator(`#${id} svg.sre-icon`).count(), id).toBe(1);

      await page.click('#lang');
      expect(await page.textContent('#refund-h')).toBe('ஒரு ஆர்டரைத் திருப்பு');
      expect(await page.textContent('#to-token')).toBe('ஆர்டர் செலுத்தப்பட்ட அதே கட்டண முறைக்கே அது திரும்பும்.');
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }

    const cash = await browser.newContext();
    try {
      await shop.signIn(cash, 'u-cash', 'br-1');
      const page = await cash.newPage();
      await page.goto(`${shop.base}/order-refunds`, { waitUntil: 'load' });
      for (const id of ['ask', 'issue']) expect(await page.isDisabled(`#${id}`), id).toBe(true);
    } finally { await cash.close(); }
  });
});
