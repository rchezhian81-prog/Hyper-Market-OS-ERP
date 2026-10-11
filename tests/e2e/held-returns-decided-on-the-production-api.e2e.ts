import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **WF-11 / M13-FR-02 — "Returned goods to decide", in a real browser, on the PRODUCTION API over real PostgreSQL.**
 *
 * The page is served in front of the real API; the held units are real — a real sale and a real desk return with two
 * damaged dal. Through Chromium the owner: sees both waiting with their batch and return; tries to send one back to a
 * supplier without naming the supplier — head office refuses and the page says so, nothing moves; puts one back on sale
 * (one `returned` movement, on-hand +1); writes the other off (a small loss at head office's own cost — no second
 * person needed). Both move to "Decided" with who decided them; after a RESTART of the API the page reads them back.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['held', 'returns', 'e2e', 'key'].join('-').padEnd(48, '0');
const AT = '2026-10-09T10:00:00.000Z';

interface Doc { querySelectorAll(s: string): { length: number } }

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('Returned goods to decide (WF-11) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/held-returns', html: 'held-returns.html', dataGlobal: 'heldReturnsData' },
      seed: async (cloud) => {
        await ok(cloud.request({ method: 'POST', path: '/v1/inventory/movements', userId: OWNER, idempotencyKey: 'rcv-dal',
          body: { movementId: 'rcv-dal', productId: 'DAL', locationId: 'store-1', kind: 'received', quantityMinor: 10, uom: 'each', occurredAt: '2026-10-01T09:00:00.000Z', enteredBy: OWNER, unitCostMinor: 4_000, batchId: 'D-07' } }), 'receive');
        await ok(cloud.request({ method: 'POST', path: '/v1/sales', userId: OWNER, idempotencyKey: 'sale-S1', body: {
          saleId: 'S1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: OWNER, locationId: 'store-1', tradingDay: '2026-10-09', committedAt: AT,
          totalMinor: 10_000, currency: 'INR', packVersion: 1,
          lines: [{ productId: 'DAL', quantityMinor: 2, uom: 'each', unitPriceMinor: 5_000, lineTotalMinor: 10_000, batchId: 'D-07', batchExpiry: '2026-12-31' }],
          tenders: [{ kind: 'cash', amountMinor: 10_000 }],
        } }), 'sale');
        // The refund is approved by a second person in their own session (ADR-0022).
        await cloud.grant('u-mgr-all', 'store_manager');
        const approval = await cloud.request({ method: 'POST', path: '/v1/pos/refund-approvals', userId: 'u-mgr-all', idempotencyKey: 'apr-RT1', body: { kind: 'refund', saleId: 'S1', valueMinor: 10_000, requestedBy: OWNER, reason: 'damaged goods' } });
        if (approval.status !== 201) throw new Error(`refund approval: ${approval.status} ${JSON.stringify(approval.body)}`);
        await ok(cloud.request({ method: 'POST', path: '/v1/sales/S1/returns', userId: OWNER, idempotencyKey: 'ret-RT1', body: {
          approvalId: (approval.body as { approvalId: string }).approvalId, returnId: 'RT1', reasonCode: 'damaged_in_use', refundMinor: 10_000, refundTender: 'cash',
          lines: [{ productId: 'DAL', uom: 'each', quantityMinor: 1, disposition: 'damaged', condition: 'torn pack' }, { productId: 'DAL', uom: 'each', quantityMinor: 1, disposition: 'damaged', condition: 'seal broken' }],
        } }), 'return');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await shop?.stop();
  });

  const onHand = async (): Promise<number> =>
    ((await shop.cloud().request({ method: 'GET', path: '/v1/inventory/availability?productId=DAL', userId: OWNER })).body as { rows: { onHandMinor: number }[] }).rows.reduce((s, r) => s + r.onHandMinor, 0);

  it('the owner decides both held units in the browser; a refusal is shown and moves nothing; a restart reads them back', async () => {
    expect(await onHand()).toBe(8);
    const context = await browser.newContext();
    await shop.signIn(context, OWNER);
    const page = await context.newPage();
    const asked: string[] = [];
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/')) asked.push(`${r.method()} ${u.pathname}`); });
    try {
      await page.goto(`${shop.base}/held-returns`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { document: Doc }).document.querySelectorAll('#rows .row').length === 2, undefined, { timeout: 15_000 });
      expect(await page.textContent('#summary')).toBe('2 waiting for a decision');
      const first = page.locator('#rows .row', { hasText: 'torn pack' });
      expect(await first.locator('.facts').textContent()).toContain('Return: RT1');
      expect(await first.locator('.facts').textContent()).toContain('Batch: D-07');

      // Back to the supplier with no supplier named: head office refuses, the page says so, nothing moves.
      await first.locator('select.decision').selectOption('return_to_supplier');
      await first.locator('input.reason').fill('supplier_fault');
      await first.locator('button.record').click();
      await page.locator('#result.tone-error').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#result')).toMatch(/Not recorded/);
      expect(await onHand()).toBe(8);

      // Back on sale.
      const again = page.locator('#rows .row', { hasText: 'torn pack' });
      await again.locator('select.decision').selectOption('restock');
      await again.locator('input.reason').fill('qc_passed');
      await again.locator('button.record').click();
      await page.locator('#done-rows .row', { hasText: 'torn pack' }).waitFor({ timeout: 15_000 });
      expect(await page.textContent('#result')).toMatch(/Recorded: DAL — Back on sale/);
      expect(await onHand()).toBe(9);

      // Written off — a small loss at head office's own cost (₹40), no second person needed.
      const second = page.locator('#rows .row', { hasText: 'seal broken' });
      await second.locator('select.decision').selectOption('write_off');
      await second.locator('input.reason').fill('contents_spilt');
      await second.locator('button.record').click();
      await page.locator('#done-rows .row', { hasText: 'seal broken' }).waitFor({ timeout: 15_000 });
      expect(await page.locator('#done-rows .row', { hasText: 'seal broken' }).locator('.facts').textContent()).toMatch(/Write off by u-owner \(contents_spilt\) · Loss value ₹40\.00/);
      expect(await page.textContent('#summary')).toBe('Nothing is waiting — every returned unit has been decided.');
      expect(await onHand()).toBe(9);
      expect(asked.filter((a) => a.startsWith('POST /v1/returns/held-stock/'))).toHaveLength(3);
    } finally { await context.close(); }

    const wl = (await shop.cloud().request({ method: 'GET', path: '/v1/returns/held-stock/worklist', userId: OWNER })).body as { open: number; items: { state: string; decisions: { decidedBy: string }[] }[] };
    expect(wl.open).toBe(0);
    expect(wl.items.map((i) => [i.state, i.decisions.map((d) => d.decidedBy)])).toEqual([['restocked', [OWNER]], ['written_off', [OWNER]]]);

    await shop.restart();
    const context2 = await browser.newContext();
    await shop.signIn(context2, OWNER);
    const page2 = await context2.newPage();
    try {
      await page2.goto(`${shop.base}/held-returns`, { waitUntil: 'load' });
      await page2.waitForFunction(() => (globalThis as unknown as { document: Doc }).document.querySelectorAll('#done-rows .row').length === 2, undefined, { timeout: 15_000 });
      // Tamil words for the same page.
      await page2.click('#lang');
      expect(await page2.textContent('#done-heading')).toBe('முடிவு எடுக்கப்பட்டவை');
    } finally { await context2.close(); }
  }, 120_000);
});
