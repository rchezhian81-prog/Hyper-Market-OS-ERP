import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

/**
 * **OB-560 (owner, 31 Oct 2026, option A): the cashier enrols a loyalty customer at the till's counter** — the Loyalty page
 * the cashier's menu already offered, in a real browser, on the PRODUCTION API over real PostgreSQL:
 *   • the cashier sees the enrolment notice, enrols a customer on their yes and the number seen on their own phone, and then
 *     finds the member;
 *   • the accountant (no enrol word) is refused by head office, by name, and the page offers no enrol.
 * Needs DATABASE_URL and Chromium; else it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['r4c', 'cashier', 'enrol', 'key'].join('-').padEnd(48, '0');
const CASHIER = 'u-cash-br1';
const ACCOUNTANT = 'u-acc';

describe('OB-560: the cashier holds the enrol word, and the Loyalty page is on the cashier\'s menu', () => {
  it('the cashier role carries loyalty.member.enrol and the menu item opens for it', () => {
    const cashier = ROLE_CATALOGUE.find((r) => r.id === 'cashier')!;
    expect(cashier.permissions).toContain('loyalty.member.enrol');
    const item = ERP_NAVIGATION.find((i) => i.id === 'loyalty-desk')!;
    expect(cashier.permissions).toContain(item.requires);
  });
});

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('OB-560: the cashier enrols at the counter, on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/loyalty', html: 'loyalty.html', dataGlobal: 'loyaltyDeskData' },
      seed: async (cloud) => {
        for (const [who, role, scope] of [[CASHIER, 'cashier', ['br-1']], [ACCOUNTANT, 'accountant', 'all']] as const) {
          const gid = `grant-${who}`;
          await ok(cloud.request({ method: 'POST', path: '/v1/identity/grants', userId: 'u-hr', idempotencyKey: `${gid}-ask`, body: { grantId: gid, userId: who, roleId: role, branchScope: scope, reason: 'staff' } }), `ask ${who}`);
          await ok(cloud.request({ method: 'POST', path: `/v1/identity/grants/${gid}/approve`, userId: OWNER, idempotencyKey: `${gid}-approve`, body: {} }), `approve ${who}`);
        }
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('the cashier enrols a customer on their yes and the number seen on their phone, then finds the member', async () => {
    const context = await browser.newContext();
    try {
      await shop.signIn(context, CASHIER, 'br-1');
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => { errors.push(String(e)); });
      await page.goto(`${shop.base}/loyalty`, { waitUntil: 'load' });
      await page.locator('#notice-text', { hasText: 'Joining SRE Hyper Market loyalty' }).waitFor({ timeout: 15_000 });
      expect(await page.isDisabled('#enrol')).toBe(false);
      await page.fill('#enrol-mobile', '98400 66601');
      await page.check('#enrol-yes'); await page.check('#enrol-seen');
      await page.click('#enrol');
      await page.locator('#enrol-status', { hasText: '✓' }).waitFor({ timeout: 15_000 });
      expect(await page.textContent('#enrol-status')).toMatch(/^✓ Enrolled — member ending 6601\./);
      await page.fill('#find-mobile', '9840066601');
      await page.click('#find');
      await page.locator('#found', { hasText: '6601' }).waitFor({ timeout: 15_000 });
      // OB-702 (decision 5 = A): the cashier's desk sees no programme panel (tiers, expiry, the CA's note, referral rewards)
      // — one line says whose numbers they are — and nothing of the programme is read for this desk.
      expect(await page.isHidden('#programme-section')).toBe(true);
      expect(await page.isHidden('#referral-section')).toBe(true);
      expect(await page.textContent('#desk-only')).toMatch(/^○ This desk enrols customers and finds members\./);
      expect(await page.locator('#programme-section button').count()).toBeGreaterThan(0); // the panel exists for the owner; it is hidden, not emptied
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });

  it('the accountant holds no enrol word: head office refuses by name, and the page offers no enrol', async () => {
    const r = await shop.cloud().request({ method: 'POST', path: '/v1/loyalty/members', userId: ACCOUNTANT, idempotencyKey: 'acc-enrol', body: { mobile: '9840066602', consent: true, phoneChecked: true } });
    expect(r.status).toBe(403);
    const context = await browser.newContext();
    try {
      await shop.signIn(context, ACCOUNTANT);
      const page = await context.newPage();
      await page.goto(`${shop.base}/loyalty`, { waitUntil: 'load' });
      await page.locator('#page-status', { hasText: '⚠' }).waitFor({ timeout: 15_000 });
      expect(await page.isDisabled('#enrol')).toBe(true);
    } finally { await context.close(); }
  });
});
