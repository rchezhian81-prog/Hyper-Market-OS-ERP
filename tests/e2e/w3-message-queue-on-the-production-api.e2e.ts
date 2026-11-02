import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **W3 (M31-FR-04 · P-08 · hard rule #6): the Message queue page, in a real browser, on the PRODUCTION API over real
 * PostgreSQL — M31's connected run.**
 *
 * The page is served in front of the real API (no stub): who is looking comes from head office's own `GET /v1/identity/me`;
 * every `/v1` call goes to the API under the signed-in person's token. Through Chromium:
 *   • on open nothing is written; the budget says "Not set" (no number is invented) and nothing waits;
 *   • a cap without any channel's cost is refused before anything is sent; the owner sets ₹500 a month and ₹0.25 an SMS,
 *     and head office holds version 1 with exactly those paise;
 *   • an order-ready SMS for a demo customer who said yes is queued by head office (an approved template, their consent,
 *     the budget) and the page shows it waiting, with its tries; after a RESTART of the API it is still there;
 *   • the store manager reads the queue and the budget but is offered no budget form; the page reads in Tamil; no page errors.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['message', 'queue', 'e2e', 'production', 'key'].join('-').padEnd(48, '0');

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Message queue page on the production API, in a real browser (M31-FR-04)', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/message-queue', html: 'message-queue.html', dataGlobal: 'messageQueueData' },
      seed: async () => {},
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string, branch?: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who, branch);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/message-queue`, { waitUntil: 'load' });
    return { page, writes, errors, close: async () => { await page.waitForLoadState('networkidle').catch(() => {}); await context.close(); } };
  };
  const says = async (page: Page, sel: string, expected: RegExp): Promise<void> => {
    await page.waitForFunction(([s, source]) => new RegExp(source!).test((globalThis as unknown as { document: { querySelector(x: string): { textContent: string | null } | null } }).document.querySelector(s!)?.textContent ?? ''), [sel, expected.source], { timeout: 15_000 });
  };

  it('the owner sets the budget; a queued order notice waits on the page and is still there after a restart; the manager only reads', async () => {
    let s = await open(OWNER);
    try {
      await says(s.page, '#budget-now', /^Not set — messages are held until the owner sets the budget\.$/);
      await says(s.page, '#pending', /Nothing is waiting\./);
      await says(s.page, '#dead', /Every message was delivered or is still being tried\./);
      expect(s.writes, 'nothing is written on open').toEqual([]);

      await s.page.fill('#b-cap', '500');
      await s.page.click('#b-save');
      await says(s.page, '#budget-save-status', /^Type the cost of one message for at least one channel\.$/);
      expect(s.writes).toEqual([]);
      await s.page.fill('#b-cost-sms', '0.25');
      await s.page.click('#b-save');
      await says(s.page, '#budget-save-status', /^Saved\./);
      await says(s.page, '#budget-now', /Monthly cap \(₹\) ₹500\.00 · Spent this month ₹0\.00 · Left this month ₹500\.00 · version 1, set by u-owner/);
      expect(s.writes).toEqual(['POST /v1/notifications/budget']);
      const budget = (await shop.cloud().request({ method: 'GET', path: '/v1/notifications/budget', userId: OWNER })).body as { budget: { capMinor: number; costMinorByChannel: Record<string, number>; version: number } };
      expect(budget.budget).toMatchObject({ capMinor: 50_000, costMinorByChannel: { sms: 25 }, version: 1 });
    } finally { await s.close(); }

    // Head office queues an order-ready SMS for a demo customer who said yes: an approved template (made by the owner,
    // approved by the manager), their own consent, and the budget just set.
    const cloud = shop.cloud();
    await ok(cloud.request({ method: 'POST', path: '/v1/notifications/templates/order-ready', userId: OWNER, idempotencyKey: 'tpl', body: { purpose: 'transactional', channel: 'sms', body: 'Your order {order} is ready to collect.' } }), 'template');
    await ok(cloud.request({ method: 'POST', path: '/v1/notifications/templates/order-ready/approval', userId: MGR, branchId: 'br-1', idempotencyKey: 'tpl-ok', body: { version: 1 } }), 'approve template');
    await ok(cloud.request({ method: 'POST', path: '/v1/customers/demo-c-1/consent', userId: OWNER, idempotencyKey: 'consent', body: { purpose: 'transactional', channel: 'sms', given: true, evidence: 'demo consent at the desk' } }), 'consent');
    await ok(cloud.request({ method: 'POST', path: '/v1/notifications/queue/n-order-1', userId: OWNER, idempotencyKey: 'q1', body: { customerId: 'demo-c-1', purpose: 'transactional', channel: 'sms', templateId: 'order-ready', values: { order: 'ORD-1' } } }), 'enqueue');

    s = await open(OWNER);
    try {
      await says(s.page, '#pending li[data-id="n-order-1"]', /n-order-1 · SMS/);
      await says(s.page, '#pending li[data-id="n-order-1"]', /0 tries/);
    } finally { await s.close(); }

    await shop.restart();
    s = await open(OWNER);
    try {
      await says(s.page, '#pending li[data-id="n-order-1"]', /n-order-1 · SMS/);
      await says(s.page, '#budget-now', /version 1, set by u-owner/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    const m = await open(MGR, 'br-1');
    try {
      await says(m.page, '#pending li[data-id="n-order-1"]', /n-order-1/);
      await says(m.page, '#budget-save-status', /^Only the owner can change the budget\.$/);
      expect(await m.page.isVisible('#budget-form')).toBe(false);
      await m.page.click('#lang');
      await says(m.page, '#pending-h', /^அனுப்பக் காத்திருப்பவை$/);
      expect(m.errors).toEqual([]);
      expect(m.writes).toEqual([]);
    } finally { await m.close(); }
  });
});
