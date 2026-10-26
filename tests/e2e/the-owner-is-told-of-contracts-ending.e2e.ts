import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { actionDetails } from '../../services/identity/src/approval-requests';

/**
 * FG-4 · M04-FR-04 / M06-FR-03 — contracts ending, on the Owner alerts page, in a real browser on the PRODUCTION API over
 * real PostgreSQL. A supplier contract that ended yesterday is listed at once; the warning window reads "Not set"; the owner
 * enters 30 days and a contract ending in 10 days joins the list. Tamil twin; icons beside the words. Needs DATABASE_URL
 * and Chromium; else it SKIPS. Text is read only after the expected words appear.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['contract', 'expiry', 'e2e', 'key'].join('-').padEnd(48, '0');
const day = (n: number): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + n * 86_400_000));

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('contracts ending on the Owner alerts page (M04-FR-04 · M06-FR-03), in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/owner-alerts', html: 'owner-alerts.html', dataGlobal: 'ownerAlertsData' },
      seed: async (cloud) => {
        await cloud.grant('u-buyer', 'store_manager');
        // Each contract as two people make it: the buyer asks, the owner approves, the buyer records it naming the approval.
        for (const [id, endsOn] of [['SC-OLD', day(-1)], ['SC-SOON', day(10)]] as const) {
          const body = { supplierId: 'sup-b', startsOn: day(-300), endsOn, agreedLeadTimeDays: 7 };
          const asked = await cloud.request({ method: 'POST', path: '/v1/approvals/requests', userId: 'u-buyer', idempotencyKey: `ask-${id}`, body: { kind: 'purchase_contract', subjectRef: id, details: actionDetails(body, { contractId: id }), valueMinor: null, summary: `contract ${id}`, reason: 'synthetic' } });
          expect(asked.status, JSON.stringify(asked.body)).toBe(201);
          const requestId = (asked.body as { requestId: string }).requestId;
          await ok(cloud.request({ method: 'POST', path: `/v1/approvals/requests/${requestId}/decide`, userId: OWNER, idempotencyKey: `decide-${id}`, body: { decision: 'approved', reason: 'checked' } }), `approve ${id}`);
          await ok(cloud.request({ method: 'POST', path: `/v1/purchase/contracts/${id}`, userId: 'u-buyer', idempotencyKey: `contract-${id}`, body: { ...body, approvalId: requestId } }), id);
        }
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const waitText = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
    const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
    return (node?.textContent ?? '').includes(want!);
  }, [selector, text], { timeout: 15_000 });

  it('an ended contract at once; the window not set until the owner enters it; then the early one too', async () => {
    const context = await browser.newContext();
    const errors: string[] = [];
    try {
      await shop.signIn(context, OWNER);
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${shop.base}/owner-alerts`, { waitUntil: 'load' });
      await page.locator('#contracts:not([hidden])').waitFor({ timeout: 15_000 });
      await waitText(page, '#contracts-window', 'Not set');
      await waitText(page, '#contracts-rows', 'SC-OLD');
      expect(await page.textContent('#contracts-rows')).not.toContain('SC-SOON');
      expect(await page.locator('#contracts-save svg').count()).toBe(1);
      await page.fill('#contracts-days', '30');
      await page.click('#contracts-save');
      await waitText(page, '#contracts-window', 'You are told 30 day(s)');
      await waitText(page, '#contracts-rows', 'SC-SOON');
      await page.click('#lang');
      await waitText(page, '#contracts-h', 'முடிவடையும் ஒப்பந்தங்கள்');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 180_000);
});
