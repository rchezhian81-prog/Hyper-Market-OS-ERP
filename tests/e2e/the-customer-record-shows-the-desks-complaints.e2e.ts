import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * OB-288 · M16-FR-04 ("complaint history is visible to service") — the Customers page opens ONE customer's record, in a
 * real browser, on the PRODUCTION API over real PostgreSQL: what they bought, then the service desk's own complaints
 * (the open one marked first, with what it was about and the order it concerns), then their other questions. Nothing is
 * typed onto the record; it is M21's register. Tamil. A cashier cannot open a record. Needs DATABASE_URL and Chromium.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['complaints', 'e2e', 'key'].join('-').padEnd(48, '0');

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the customer record shows the desk\'s complaints (M16-FR-04), in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/customers', html: 'customers.html', dataGlobal: 'customersData' },
      seed: async (cloud) => {
        const post = (path: string, body: unknown, key: string) => ok(cloud.request({ method: 'POST', path, userId: OWNER, idempotencyKey: key, body }), key);
        await post('/v1/sales', {
          saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', locationId: 'br-1', cashierId: OWNER, tradingDay: '2026-10-01', committedAt: '2026-10-01T06:00:00.000Z',
          totalMinor: 12_000, currency: 'INR', packVersion: 1, customerRef: 'M-anu',
          lines: [{ productId: 'p-milk', quantityMinor: 2, uom: 'ea', unitPriceMinor: 6_000, lineTotalMinor: 12_000 }], tenders: [{ kind: 'cash', amountMinor: 12_000 }],
        }, 'sale-1');
        const open = (caseId: string, kind: string, summary: string, orderRef?: string) => post(`/v1/service/cases/${caseId}`, { kind, customerRef: 'M-anu', priority: 'normal', summary, assignedTo: OWNER, ...(orderRef === undefined ? {} : { orderRef }) }, `case-${caseId}`);
        await open('C-1', 'complaint', 'Milk was sour (synthetic)', 'S-1');
        await open('C-2', 'complaint', 'Bill printed twice (synthetic)');
        await post('/v1/service/cases/C-2/resolution', { resolution: 'Reprinted once, apologised' }, 'resolve-C-2');
        await open('C-3', 'enquiry', 'Do you stock ragi flour? (synthetic)');
        await cloud.grant('u-cash', 'cashier');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('the record: bought, complaints with the open one marked, other questions; Tamil; a cashier cannot open it', async () => {
    const errors: string[] = [];
    const mgr = await browser.newContext();
    try {
      await shop.signIn(mgr, MGR, 'br-1');
      const page = await mgr.newPage();
      page.on('pageerror', (e) => { errors.push(String(e)); });
      await page.goto(`${shop.base}/customers`, { waitUntil: 'load' });
      // Nothing typed: refused before a request.
      await page.click('#record-open');
      await expect.poll(() => page.textContent('#record-status')).toBe('Give the customer code first. Nothing was read.');
      await page.fill('#record-ref', 'M-anu');
      await page.click('#record-open');
      await page.locator('#record-complaints li[data-case="C-1"]').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#record-summary')).toMatch(/^Bought: 1 bills · net spend ₹120\.00/);
      expect(await page.getAttribute('#record-say', 'data-open')).toBe('1');
      expect(await page.textContent('#record-say')).toBe('⚠ 2 — 1 open complaints');
      const c1 = page.locator('#record-complaints li[data-case="C-1"]');
      expect(await c1.getAttribute('data-state')).toBe('open');
      expect(await c1.innerText()).toMatch(/⚠ C-1 — open[\s\S]*Milk was sour \(synthetic\)[\s\S]*order S-1/);
      expect(await page.locator('#record-complaints li[data-case="C-2"]').innerText()).toMatch(/✓ C-2 — dealt with[\s\S]*answer: Reprinted once, apologised/);
      expect(await page.locator('#record-other li[data-case="C-3"]').getAttribute('data-kind')).toBe('enquiry');
      // Icons beside the words.
      expect(await page.locator('#record-open svg.sre-icon').count()).toBe(1);

      await page.click('#lang');
      expect(await page.textContent('#complaints-h')).toBe('புகார்கள்');
      expect(await page.locator('#record-complaints li[data-case="C-1"]').innerText()).toMatch(/திறந்துள்ளது/);
      expect(errors).toEqual([]);
    } finally { await mgr.close(); }

    const cash = await browser.newContext();
    try {
      await shop.signIn(cash, 'u-cash', 'br-1');
      const page = await cash.newPage();
      await page.goto(`${shop.base}/customers`, { waitUntil: 'load' });
      expect(await page.isDisabled('#record-open')).toBe(true);
    } finally { await cash.close(); }
  });
});
