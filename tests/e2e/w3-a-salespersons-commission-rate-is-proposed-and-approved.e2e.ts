import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { openAs } from './lib/w3-page';
import { says } from './lib/r4c-box-page';

/**
 * **W3 · M22-FR-03 (FUL-09 · §28): a business salesperson's commission rate is proposed and approved on the Sales
 * commission page, in a real browser, on the PRODUCTION API over real PostgreSQL.** The accountant proposes 2.5% with a
 * ₹500 cap for salesperson sp-ravi; it is not in force until the owner — a different person — approves it on the same
 * page; then it is the rate in force. The owner's own proposal cannot be approved by himself: head office refuses it, in
 * its words, and it stays waiting. Nothing has been earned yet, and the page says so — never a made-up ₹0.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['w3', 'commission', 'key'].join('-').padEnd(48, '0');
const ACCT = 'u-acct';

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('Sales commission (M22-FR-03) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/sales-commission', html: 'sales-commission.html', dataGlobal: 'salesCommissionData' },
      seed: async (cloud) => {
        await ok(cloud.request({ method: 'PUT', path: '/v1/platform/entitlements/b2b', userId: OWNER, idempotencyKey: 'b2b-on', body: { enabled: true } }), 'b2b on');
        await cloud.grant(ACCT, 'accountant');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('the accountant proposes, the owner approves; the owner cannot approve his own', async () => {
    let s = await openAs(shop, browser, ACCT, '/sales-commission');
    let ruleId = '';
    try {
      await s.page.fill('#c-sp', 'sp-ravi'); await s.page.click('#c-look');
      await says(s.page, '#rules', /No rate has been proposed for this salesperson\./);
      await says(s.page, '#earned-sum', /^Nothing earned yet\.$/);
      await s.page.fill('#c-rate', '2.5'); await s.page.fill('#c-cap', 'five hundred');
      await s.page.click('#c-propose');
      await says(s.page, '#propose-status', /^Type the cap in rupees/);
      expect(s.writes).toEqual([]);
      await s.page.fill('#c-cap', '500');
      await s.page.click('#c-propose');
      await says(s.page, '#propose-status', /^Proposed\. It is in force only once someone else approves it\.$/);
      await says(s.page, '#rules li[data-in-force="false"]', /2\.5% · ₹500\.00 — waiting for approval.*proposed by u-acct/);
      ruleId = (await s.page.getAttribute('#rules li', 'data-rule'))!;
      expect(await s.page.locator('#rules button').count(), 'the accountant cannot approve').toBe(0);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    s = await openAs(shop, browser, OWNER, '/sales-commission');
    try {
      await s.page.fill('#c-sp', 'sp-ravi'); await s.page.click('#c-look');
      await s.page.click(`#rules li[data-rule="${ruleId}"] button`);
      await says(s.page, `#rules li[data-rule="${ruleId}"][data-in-force="true"]`, /2\.5% · ₹500\.00 — in force.*approved by u-owner/);
      // The owner's own proposal — he cannot approve it himself (§28).
      await s.page.fill('#c-rate', '3'); await s.page.fill('#c-cap', '');
      await s.page.click('#c-propose');
      await says(s.page, '#rules li[data-in-force="false"]', /3% · no cap — waiting for approval.*proposed by u-owner/);
      await s.page.click('#rules li[data-in-force="false"] button');
      await says(s.page, '#rules li[data-in-force="false"] .status', /^Head office refused: A commission rule must be approved by someone other than the person who proposed it\.$/);
      await s.page.click('#lang');
      await says(s.page, '#rules-h', /^விகிதங்கள்$/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    const rules = (await shop.cloud().request({ method: 'GET', path: '/v1/b2b/commissions/sp-ravi/rules', userId: OWNER })).body as { inForce: { ruleId: string; rateBps: number; capMinor: number; proposedBy: string; approvedBy: string } };
    expect(rules.inForce).toMatchObject({ ruleId, rateBps: 250, capMinor: 50_000, proposedBy: ACCT, approvedBy: OWNER });
  }, 240_000);
});
