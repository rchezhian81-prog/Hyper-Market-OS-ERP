import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { creditLimitWithApproval } from '../support/approved-credit-limit';

/**
 * **OB-76 "A" (owner, 12 Oct 2026, "Staff invite + 2nd approves") — the "Logins for customers and suppliers" part of the
 * Admin page's "Who can get in", in a real browser, on the PRODUCTION API over real PostgreSQL.**
 *
 * The page is served in front of the real API (no stub): who is looking comes from head office's own
 * `GET /v1/identity/me`; every `/v1` call goes to the API under the signed-in person's token. Through Chromium:
 *
 *   • nothing is written on open; the owner (who manages all three kinds of party) is offered all three;
 *   • an invite for an account head office does not hold is refused in head office's own words, nothing recorded;
 *   • the owner invites the caterer's clerk, bound to the CATERER account — "waiting for a second person", and the owner is
 *     NOT offered Approve on his own invite;
 *   • the accountant (who also manages business-customer accounts, and only those) approves it: both names on the row and
 *     at head office; the clerk's login now reads the caterer's own account on the B2B portal;
 *   • giving the sign-in is refused in head office's words (this API is not connected to an identity server);
 *   • after a RESTART the accountant still sees both names and revokes it with a reason: the clerk's login is refused;
 *   • a cashier, who manages no party, is told so and offered nothing; the section reads in Tamil; no page errors.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['outside', 'logins', 'e2e', 'production', 'signing', 'key'].join('-').padEnd(48, '0');
const ACCT = 'u-acct-ol'; const CASHIER = 'u-cash-ol'; const CLERK = 'u-caterer-clerk';

interface Login { inviteId: string; state: string; invitedBy: string; approvedBy?: string; revokedBy?: string; partyId: string; userId: string }

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('logins for outside parties on the Admin page, on the production API (OB-76)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const atHeadOffice = async (): Promise<Login[]> => ((await shop.cloud().request({ method: 'GET', path: '/v1/identity/outside-logins/b2b-accounts', userId: OWNER })).body as { logins: Login[] }).logins;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/admin', html: 'admin.html', dataGlobal: 'adminData' },
      seed: async (cloud) => {
        await cloud.grant(ACCT, 'accountant');
        await cloud.grant(CASHIER, 'cashier');
        await ok(cloud.request({ method: 'PUT', path: '/v1/platform/entitlements/b2b', userId: OWNER, idempotencyKey: 'b2b-on', body: { enabled: true } }), 'b2b on');
        await ok(creditLimitWithApproval((r) => cloud.request(r), OWNER, ACCT, 'CATERER', { creditLimitMinor: 500_000 }, 'acc-cat'), 'caterer account'); // OB-360
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname.replace(/inv-[^/]+/, 'inv-…')}`); });
    await page.goto(`${shop.base}/admin`, { waitUntil: 'load' });
    await page.click('#tab-people');
    return { page, writes, errors, close: () => context.close() };
  };
  const says = async (page: Page, id: string, expected: RegExp): Promise<void> => {
    await page.waitForFunction(([i, source]) => new RegExp(source!).test((globalThis as unknown as { document: { getElementById(x: string): { textContent: string | null } | null } }).document.getElementById(i!)?.textContent ?? ''), [id, expected.source], { timeout: 15_000 });
  };
  const options = async (page: Page): Promise<string[]> => page.locator('#outside-kind option').evaluateAll((os) => os.map((o) => (o as unknown as { value: string }).value));

  it('the owner invites the caterer\'s clerk; head office refuses an unknown account in its own words; the owner is not offered Approve on his own invite', async () => {
    const s = await open(OWNER);
    try {
      await says(s.page, 'outside-source-text', /^Head office, as at/);
      expect(s.writes, 'nothing is written on open').toEqual([]);
      expect(await options(s.page)).toEqual(['b2b_customer', 'customer', 'supplier']);
      await says(s.page, 'outside-list', /No outside logins have been invited yet/);
      // Refused in head office's words: an account it does not hold.
      await s.page.selectOption('#outside-kind', 'b2b_customer');
      await s.page.fill('#outside-party', 'NOBODY');
      await s.page.fill('#outside-display', 'Meena Raman');
      await s.page.fill('#outside-user', CLERK);
      await s.page.check('#outside-grant-view_invoices');
      await s.page.check('#outside-grant-view_statement');
      await s.page.click('#outside-invite');
      await says(s.page, 'outside-result-text', /^Head office said: No business customer account "NOBODY" is held here/);
      expect(await atHeadOffice()).toEqual([]);
      // The real one.
      await s.page.fill('#outside-party', 'CATERER');
      await s.page.click('#outside-invite');
      await says(s.page, 'outside-result-text', /^Invited Meena Raman — waiting for a second person to approve/);
      const row = s.page.locator('#outside-list .row');
      await row.first().waitFor({ timeout: 15_000 });
      expect(await row.innerText()).toMatch(/Meena Raman \(u-caterer-clerk\) — Business customer CATERER[\s\S]*waiting for a second person to approve · invited by u-owner/);
      expect(await row.locator('button', { hasText: 'Approve' }).count(), 'never the inviter\'s own approval').toBe(0);
      expect(s.writes).toEqual(['POST /v1/identity/outside-logins/b2b-accounts/NOBODY/invites/inv-…', 'POST /v1/identity/outside-logins/b2b-accounts/CATERER/invites/inv-…']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const held = await atHeadOffice();
    expect(held.map((l) => [l.state, l.invitedBy, l.partyId, l.userId])).toEqual([['invited', OWNER, 'CATERER', CLERK]]);
    expect((await shop.cloud().request({ method: 'GET', path: '/v1/b2b-portal/me/account', userId: CLERK })).status, 'invited is not granted').toBe(403);
  }, 120_000);

  it('the accountant (a second person who manages business accounts) approves: both names, and the clerk reads the caterer\'s own account', async () => {
    const s = await open(ACCT);
    try {
      await says(s.page, 'outside-source-text', /^Head office, as at/);
      expect(await options(s.page), 'only the kind the accountant manages').toEqual(['b2b_customer']);
      const row = s.page.locator('#outside-list .row');
      await row.locator('button', { hasText: 'Approve' }).click();
      await says(s.page, 'outside-result-text', /^Approved\. Meena Raman can now sign in to their own record/);
      await says(s.page, 'outside-list', /approved — can sign in to its own record · invited by u-owner · approved by u-acct-ol/);
      // Giving the sign-in: this API is not connected to an identity server — refused in head office's words.
      await row.locator('input.sign-in-name').fill('meena.r');
      await row.locator('button', { hasText: 'Give the sign-in' }).click();
      await says(s.page, 'outside-result-text', /^Head office said: This deployment is not connected to the identity server/);
      expect(await s.page.locator('#outside-handover').isHidden()).toBe(true);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect((await atHeadOffice()).map((l) => [l.state, l.invitedBy, l.approvedBy])).toEqual([['approved', OWNER, ACCT]]);
    const account = await shop.cloud().request({ method: 'GET', path: '/v1/b2b-portal/me/account', userId: CLERK });
    expect([account.status, (account.body as { customerId?: string }).customerId]).toEqual([200, 'CATERER']);
  }, 120_000);

  it('after a restart the accountant revokes it with a reason; a cashier is offered nothing; the section reads in Tamil', async () => {
    await shop.restart();
    let s = await open(ACCT);
    try {
      await says(s.page, 'outside-list', /approved by u-acct-ol/);
      const row = s.page.locator('#outside-list .row');
      await row.locator('button', { hasText: 'Revoke' }).click();
      await says(s.page, 'outside-result-text', /^Say why\./); // the cheap refusal, before any request
      await row.locator('input.reason').fill('The clerk left the caterer');
      await row.locator('button', { hasText: 'Revoke' }).click();
      await says(s.page, 'outside-result-text', /^Revoked\. Meena Raman can no longer sign in/);
      await says(s.page, 'outside-list', /revoked — cannot sign in · invited by u-owner · approved by u-acct-ol · revoked by u-acct-ol/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect((await atHeadOffice()).map((l) => [l.state, l.revokedBy])).toEqual([['revoked', ACCT]]);
    expect([401, 403]).toContain((await shop.cloud().request({ method: 'GET', path: '/v1/b2b-portal/me/account', userId: CLERK })).status);

    s = await open(CASHIER);
    try {
      await says(s.page, 'outside-cannot', /You may not manage business customers, customers or suppliers/);
      expect(await s.page.locator('#outside-form').isHidden()).toBe(true);
      await s.page.click('#lang');
      await says(s.page, 'outside-title', /^வாடிக்கையாளர்கள், சப்ளையர்களுக்கான உள்நுழைவுகள்$/);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);
});
