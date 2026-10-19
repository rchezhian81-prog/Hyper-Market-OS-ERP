import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * M16 (R4, signed OB-227 · OB-74) — the Customers page, in a real browser, on the PRODUCTION API over real PostgreSQL:
 * "A person with the customer permission sees suggested duplicates and segments on one page. A merge needs a second
 * person and can be undone; nothing merges by itself. A customer without profiling consent shows as 'not profiled',
 * never silently left out. A person without the permission is refused."
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['customers', 'e2e', 'key'].join('-').padEnd(48, '0');

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Customers page (M16) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/customers', html: 'customers.html', dataGlobal: 'customersData' },
      seed: async (cloud) => {
        const post = (path: string, body: unknown, key: string) => ok(cloud.request({ method: 'POST', path, userId: OWNER, idempotencyKey: key, body }), key);
        let n = 0;
        for (const m of ['M-anu', 'M-anu-2', 'M-bala']) {
          n += 1;
          await post('/v1/sales', {
            saleId: `S-${n}`, receiptNumber: `R-${n}`, laneId: 'lane-1', locationId: 'br-1', cashierId: OWNER, tradingDay: '2026-10-01', committedAt: '2026-10-01T06:00:00.000Z',
            totalMinor: 5_000, currency: 'INR', packVersion: 1, customerRef: m,
            lines: [{ productId: 'p-tea', quantityMinor: 1, uom: 'ea', unitPriceMinor: 5_000, lineTotalMinor: 5_000 }], tenders: [{ kind: 'cash', amountMinor: 5_000 }],
          }, `sale-${n}`);
        }
        for (const m of ['M-anu', 'M-anu-2']) await post(`/v1/customers/${m}/consent`, { purpose: 'profiling', channel: 'sms', given: true, evidence: 'synthetic desk consent' }, `consent-${m}`);
        await cloud.grant('u-cash', 'cashier'); // holds no customer permission
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await shop?.stop();
  });

  it('segments with "not profiled" listed → suggested duplicates → a merge proposed by one person, approved by another, undone', async () => {
    const errors: string[] = [];
    const mgr = await browser.newContext();
    try {
      await shop.signIn(mgr, MGR, 'br-1');
      const page = await mgr.newPage();
      page.on('pageerror', (e) => { errors.push(String(e)); });
      await page.goto(`${shop.base}/customers`, { waitUntil: 'load' });
      await page.locator('#customer-rows tr[data-customer="M-bala"]').waitFor({ timeout: 15_000 });
      // Not profiled: listed, counted, never left out.
      expect(await page.getAttribute('#customer-rows tr[data-customer="M-bala"]', 'data-segment')).toBe('not_profiled');
      expect(await page.textContent('#customer-rows tr[data-customer="M-bala"]')).toMatch(/not profiled/);
      expect(await page.getAttribute('#customer-rows tr[data-customer="M-anu"]', 'data-profiled')).toBe('true');
      expect(await page.textContent('#counts .panel[data-segment="not_profiled"] .v')).toBe('1');

      // Fewer than two records: refused before anything is sent.
      await page.fill('#candidates', 'M-anu, 9840011111, yes, Anu');
      await page.click('#check');
      await expect.poll(() => page.textContent('#dup-status')).toMatch(/at least two records/);
      await page.fill('#candidates', 'M-anu, 9840011111, yes, Anu\nM-anu-2, 9840011111, no, Anu R\nM-bala, 9840022222, no, Bala');
      await page.click('#check');
      await page.locator('#matches li[data-pair="M-anu+M-anu-2"]').waitFor({ timeout: 15_000 });
      expect(await page.getAttribute('#matches li[data-pair="M-anu+M-anu-2"]', 'data-disposition')).toBe('review');
      // Suggesting merged nothing.
      expect(await page.locator('#pending li[data-merge]').count()).toBe(0);

      await page.click('#matches li[data-pair="M-anu+M-anu-2"] button.propose');
      await expect.poll(() => page.textContent('#merge-status')).toMatch(/Say why first/);
      await page.fill('#matches li[data-pair="M-anu+M-anu-2"] input.reason', 'same phone seen at the desk');
      await page.click('#matches li[data-pair="M-anu+M-anu-2"] button.propose');
      await expect.poll(() => page.textContent('#merge-status')).toMatch(/not in force until a second person approves it/);
      await page.locator('#pending li[data-merge]').waitFor({ timeout: 15_000 });
      // The proposer holds no approval: no button, and head office refuses it anyway.
      expect(await page.locator('#pending li[data-merge] button.approve').count()).toBe(0);
      const mergeId = (await page.getAttribute('#pending li[data-merge]', 'data-merge'))!;
      expect((await shop.cloud().request({ method: 'POST', path: `/v1/customers/merges/${mergeId}/approve`, userId: MGR, idempotencyKey: 'mgr-approve', body: {} })).status).toBe(403);
    } finally { await mgr.close(); }

    const owner = await browser.newContext();
    try {
      await shop.signIn(owner, OWNER);
      const page = await owner.newPage();
      page.on('pageerror', (e) => { errors.push(String(e)); });
      await page.goto(`${shop.base}/customers`, { waitUntil: 'load' });
      await page.locator('#pending li[data-merge] button.approve').waitFor({ timeout: 15_000 });
      await page.click('#pending li[data-merge] button.approve');
      await expect.poll(() => page.textContent('#merge-status')).toMatch(/Approved/);
      await page.locator('#inforce li[data-merge] button.undo').waitFor({ timeout: 15_000 });
      await page.fill('#inforce li[data-merge] input.undo-reason', 'two people after all');
      await page.click('#inforce li[data-merge] button.undo');
      await expect.poll(() => page.textContent('#merge-status')).toMatch(/Undone/);
      await page.locator('#reversed li[data-merge]').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#reversed li[data-merge]')).toMatch(/two people after all/);
      await page.click('#lang');
      expect(await page.textContent('#page-h')).toBe('வாடிக்கையாளர்கள்');
    } finally { await owner.close(); }

    // A person without the permission is refused: the page says so and head office refuses the read.
    const nobody = await browser.newContext();
    try {
      await shop.signIn(nobody, 'u-cash');
      const page = await nobody.newPage();
      await page.goto(`${shop.base}/customers`, { waitUntil: 'load' });
      await expect.poll(() => page.textContent('#page-status')).toMatch(/cannot read customers/);
      expect(await page.locator('#customer-rows tr').count()).toBe(0);
      expect((await shop.cloud().request({ method: 'GET', path: '/v1/customer/overview', userId: 'u-cash' })).status).toBe(403);
    } finally { await nobody.close(); }
    expect(errors).toEqual([]);
  }, 180_000);
});
