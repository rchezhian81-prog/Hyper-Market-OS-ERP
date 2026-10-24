import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * M21-FR-01 ("campaigns … consent, frequency caps, approved templates, reach and status") and M21-FR-02 (journeys) — the
 * Campaigns page, in a real browser, on the PRODUCTION API over real PostgreSQL. Nothing is read on open. The manager
 * drafts the words (and cannot approve their own); the owner approves them in his own session. The frequency cap reads
 * "not set" until the owner sets it. The loyal customers are found — the one who has not said yes is COUNTED, not hidden;
 * the plan holds back the one on the do-not-contact register with that reason; the send fills the {value} blank and queues
 * exactly the reachable one; the status shows where it is. A journey switches on only with a reason. Tamil. A cashier
 * changes nothing. Needs DATABASE_URL and Chromium; else it SKIPS. Synthetic customers only.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['campaigns', 'e2e', 'key'].join('-').padEnd(48, '0');
const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Campaigns page (M21-FR-01 · M21-FR-02) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/campaigns', html: 'campaigns.html', dataGlobal: 'campaignsData' },
      seed: async (cloud) => {
        const post = (path: string, body: unknown, key: string) => ok(cloud.request({ method: 'POST', path, userId: OWNER, idempotencyKey: key, body }), key);
        await post('/v1/customer/segments/policy', { loyalAtOrders: 3 }, 'policy');
        for (const ref of ['C1', 'C2', 'C3']) {
          for (const [i, d] of [20, 12, 5].entries()) await post(`/v1/customer/facts/orders/${ref}-${i}`, { customerRef: ref, at: daysAgo(d), netMinor: 20_000, marginMinor: 6_000, channel: 'store' }, `o-${ref}-${i}`);
          await post(`/v1/customers/${ref}/consent`, { purpose: 'profiling', channel: 'sms', given: true, evidence: 'synthetic seed consent' }, `prof-${ref}`);
        }
        // C1 and C3 said yes to offers by SMS; C2 did not. C3 later asked never to be contacted.
        for (const ref of ['C1', 'C3']) await post(`/v1/customers/${ref}/consent`, { purpose: 'marketing', channel: 'sms', given: true, evidence: 'synthetic seed consent' }, `mkt-${ref}`);
        await post('/v1/notifications/suppressions/C3', { channel: 'all', reason: 'asked at the desk (synthetic)', source: 'customer_request' }, 'dnc-C3');
        await cloud.grant('u-cash', 'cashier');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('words by one person approved by another; cap "not set"; the audience counts who said no; the plan holds back do-not-contact; the send queues only the reachable one; journeys need a reason; Tamil; a cashier changes nothing', async () => {
    const errors: string[] = [];
    const ctx = await browser.newContext();
    try {
      await shop.signIn(ctx, MGR, 'br-1');
      const page = await ctx.newPage();
      page.on('pageerror', (e) => { errors.push(String(e)); });
      const reads: string[] = [];
      page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/')) reads.push(`${r.method()} ${u.pathname}`); });
      await page.goto(`${shop.base}/campaigns`, { waitUntil: 'load' });
      expect(reads, 'nothing is read on open').toEqual([]);

      // The cap is not set — said, never a fake number.
      await page.click('#show-words');
      await page.locator('#cap[data-state="not_set"]').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#cap')).toBe('⚠ No frequency cap is set — the owner sets it first; until then no marketing message is sent.');

      // The manager drafts the words, and cannot approve their own.
      await page.fill('#template-id', 'diwali');
      await page.selectOption('#template-channel', 'sms');
      await page.fill('#template-body', 'SRE: {value} this Diwali. (synthetic)');
      await page.click('#draft');
      await page.locator('#words-status', { hasText: 'diwali v1 — Drafted' }).waitFor({ timeout: 15_000 });
      await page.locator('#words li[data-template="diwali"][data-state="draft"] button.approve').click();
      await page.locator('#words-status', { hasText: '⚠ Head office refused:' }).waitFor({ timeout: 15_000 });
      // The owner approves in his own session, and sets the cap.
      await ok(shop.cloud().request({ method: 'POST', path: '/v1/notifications/templates/diwali/approval', userId: OWNER, idempotencyKey: 'approve-diwali', body: { version: 1 } }), 'owner approves');
      await ok(shop.cloud().request({ method: 'PUT', path: '/v1/service/campaigns/frequency-policy', userId: OWNER, idempotencyKey: 'cap', body: { capPerWindow: 2, windowDays: 7 } }), 'cap');
      await page.click('#show-words');
      await page.locator('#words li[data-template="diwali"][data-state="approved"]').waitFor({ timeout: 15_000 });
      await page.locator('#cap[data-state="set"]').waitFor({ timeout: 15_000 });
      expect(await page.inputValue('#template')).toBe('diwali');

      // Plan before finding who can be reached: refused on the page.
      await page.click('#plan');
      expect(await page.textContent('#plan-status')).toBe('⚠ Find who can be reached first. Nothing was sent.');
      await page.selectOption('#segment', 'loyal');
      await page.click('#find-audience');
      await page.locator('#audience', { hasText: 'can be reached' }).waitFor({ timeout: 15_000 });
      expect(await page.textContent('#audience')).toBe('2 can be reached · 1 match but have not said yes and are not contacted');
      await page.fill('#campaign-id', 'diwali-2026');
      await page.click('#plan');
      await page.locator('#plan-out li[data-campaign="diwali-2026"]').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#plan-out .plan-count')).toBe('✓ Campaign diwali-2026: 1 will be sent · 1 held back');
      expect(await page.textContent('#plan-out .reason-do_not_contact')).toBe('○ 1 — asked never to be contacted');

      // The {value} blank must be filled; then exactly the reachable one is queued, and the status shows it waiting.
      await page.click('#send');
      expect(await page.textContent('#plan-status')).toBe('⚠ These words have a {value} blank — fill it in first. Nothing was sent.');
      await page.fill('#value', '10% off sweets');
      await page.click('#send');
      await page.locator('#plan-status[data-queued="1"]').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#plan-status')).toBe('✓ 1 queued · 0 already queued · 0 held back') // only the plan's reachable list is sent;
      await page.locator('#status-out li[data-campaign="diwali-2026"]').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#status-out .total-queued')).toBe('queued: 1');
      expect(await page.textContent('#status-out .total-pending')).toBe('waiting: 1');

      // Journeys: off until switched on; switching needs a reason.
      await page.click('#show-journeys');
      await page.locator('#journeys li[data-journey="win_back"][data-on="false"]').waitFor({ timeout: 15_000 });
      expect(await page.locator('#journeys li[data-on="false"]').count()).toBe(3);
      const winBack = page.locator('#journeys li[data-journey="win_back"]');
      await winBack.locator('button.switch').click();
      expect(await page.textContent('#journeys-status')).toBe('⚠ Say why first. Nothing was sent.');
      await winBack.locator('input.reason').fill('Owner asked for it (synthetic)');
      await winBack.locator('button.switch').click();
      await page.locator('#journeys li[data-journey="win_back"][data-on="true"]').waitFor({ timeout: 15_000 });
      expect(await page.locator('#journeys li[data-journey="win_back"] strong').textContent()).toBe('● A customer who has not bought for a while — ON · diwali · sms');
      await page.click('#run-journeys');
      await page.locator('#journeys-status', { hasText: '✓ Journeys run' }).waitFor({ timeout: 15_000 });
      for (const id of ['show-words', 'draft', 'find-audience', 'plan', 'send', 'show-status', 'show-journeys', 'run-journeys']) expect(await page.locator(`#${id} svg.sre-icon`).count(), id).toBe(1);

      await page.click('#lang');
      expect(await page.textContent('#plan-h')).toBe('ஒரு பிரச்சாரத்தைத் திட்டமிடு');
      expect(await page.textContent('#plan-out .reason-do_not_contact')).toBe('○ 1 — ஒருபோதும் தொடர்பு கொள்ள வேண்டாம் என்று கேட்டனர்');
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }

    const cash = await browser.newContext();
    try {
      await shop.signIn(cash, 'u-cash', 'br-1');
      const page = await cash.newPage();
      await page.goto(`${shop.base}/campaigns`, { waitUntil: 'load' });
      for (const id of ['draft', 'plan', 'send', 'run-journeys', 'show-journeys']) expect(await page.isDisabled(`#${id}`), id).toBe(true);
      expect(await page.textContent('#page-status')).toBe('⚠ Your role cannot read campaigns.');
    } finally { await cash.close(); }
  });
});
