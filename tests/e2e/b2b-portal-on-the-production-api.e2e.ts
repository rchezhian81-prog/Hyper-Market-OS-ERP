import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { creditLimitWithApproval } from '../support/approved-credit-limit';
import { customerListPrice, unpriced } from '../support/b2b-price-on-record';

/**
 * **A business customer reads its own account, in a real browser, on the PRODUCTION API over real PostgreSQL (M22-FR-04 ·
 * API-09 · §35 · P-08).**
 *
 * `b2b-portal-delivery.e2e.ts` proves the portal against a stub cloud. This is the connected proof: the B2B portal page
 * (apps/b2b-app/web) is served in front of the real API (no stub); who is looking comes from head office's own
 * `GET /v1/identity/me`; every `/v1` call goes to the API under the business customer's own token, and the customer is
 * the one a member of staff BOUND that login to — never the request. Through Chromium:
 *
 *   • the caterer's login (both grants) sees its credit account (limit, owed net of the payment it made, available), its
 *     two invoices with the overdue one marked, its statement aged into buckets, and the quotation issued to it — and
 *     not one write leaves the screen;
 *   • the canteen's login (invoices only) is TOLD it cannot see the account and statement — never shown ₹0.00 — and sees
 *     only its own invoice, never the caterer's;
 *   • after a RESTART of the API the caterer reads the same; the page reads in Tamil; no page errors.
 *
 * OB-76 "A" (owner, 12 Oct 2026, "Staff invite + 2nd approves"): the two portal logins are now given through the governed
 * path — the owner (who manages business-customer accounts) INVITES each login bound to its account, and the accountant (a
 * DIFFERENT person who also manages them) APPROVES it (`/v1/identity/outside-logins/b2b-accounts/…`); both names stay on
 * the record and on the `RoleGranted`. The generic grant route still refuses `b2b_customer` (`outside_party_login_holds_only_its_role`, round 14 G5)
 * — the rule is unchanged for every staff role; the outside-party flow is its named, narrow exception. Before, this seed
 * had to lay the logins down as an operator's ledger write because no governed path existed.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['b2b', 'portal', 'e2e', 'production', 'signing', 'key'].join('-').padEnd(48, '0');
const CATERER = 'u-caterer'; const CANTEEN = 'u-canteen'; const ACCOUNTANT = 'u-acct-b2b';
const LINE = { lineId: 'l1', productId: 'p1', description: 'Rice 25kg', qty: 10, unitPriceMinor: 10_000, taxRateBps: 500 };
const day = (offset: number): string => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the B2B portal on the production API, in a real browser (M22-FR-04)', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'b2b-app'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/', html: 'index.html', dataGlobal: 'b2bData', webDir: 'apps/b2b-app/web' },
      seed: async (cloud) => {
        const as = (path: string, body: unknown, key: string, method: 'POST' | 'PUT' = 'POST') => ok(cloud.request({ method, path, userId: OWNER, idempotencyKey: key, body }), path);
        await as('/v1/platform/entitlements/b2b', { enabled: true }, 'b2b-on', 'PUT');
        // The caterer: ₹5,000 credit; two invoices — one 45 days overdue (₹1,000), one not yet due (₹500); ₹300 paid.
        // OB-360: a credit limit is asked by the owner and approved by another person who manages B2B accounts.
        await cloud.grant(ACCOUNTANT, 'accountant');
        await ok(creditLimitWithApproval((r) => cloud.request(r), OWNER, ACCOUNTANT, 'CATERER', { creditLimitMinor: 500_000 }, 'acc-cat'), 'caterer account');
        await as('/v1/b2b/accounts/CATERER/receivables', { movementId: 'ar-cat-1', kind: 'invoice', amountMinor: 100_000, ref: 'INV-C1' }, 'ar-cat-1');
        await as('/v1/b2b/collections/CATERER/invoices/inv-c1', { number: 'INV-C1', issuedOn: day(-75), dueOn: day(-45), grossMinor: 100_000 }, 'inv-c1');
        await as('/v1/b2b/collections/CATERER/invoices/inv-c2', { number: 'INV-C2', issuedOn: day(-5), dueOn: day(10), grossMinor: 50_000 }, 'inv-c2');
        await as('/v1/b2b/collections/CATERER/payments/rcpt-c1', { receivedMinor: 30_000 }, 'rcpt-c1');
        // OB-361: no typed price on a business quotation — rice goes on the caterer's price list first.
        const listed = customerListPrice('p1', 'CATERER', LINE.unitPriceMinor);
        await as(listed.path, listed.body, 'pl-p1');
        await as('/v1/b2b/documents/CATERER/quotations/q-c1', { lines: unpriced([LINE]) }, 'q-c1');
        await as('/v1/b2b/collections/CANTEEN/invoices/inv-k1', { number: 'INV-K1', issuedOn: day(-20), dueOn: day(5), grossMinor: 999_900 }, 'inv-k1');
        // The portal logins: each a named person with the business-customer role, bound to its own account through the
        // governed path (OB-76) — invited by the owner, approved by a DIFFERENT person who also manages B2B accounts.
        // The generic grant route still refuses it: no approver holds b2b.portal.self, and that rule is unchanged.
        await expect(cloud.grant(CATERER, 'b2b_customer')).rejects.toThrow(/outside_party_login_holds_only_its_role/);
        await ok(creditLimitWithApproval((r) => cloud.request(r), OWNER, ACCOUNTANT, 'CANTEEN', { creditLimitMinor: 100_000 }, 'acc-can'), 'canteen account');
        for (const [account, userId, displayName, grants] of [
          ['CATERER', CATERER, 'Meena Raman', ['view_statement', 'view_invoices']],
          ['CANTEEN', CANTEEN, 'Joseph Paul', ['view_invoices']],
        ] as const) {
          await as(`/v1/identity/outside-logins/b2b-accounts/${account}/invites/inv-${userId}`, { userId, displayName, grants }, `invite-${userId}`);
          await ok(cloud.request({ method: 'POST', path: `/v1/identity/outside-logins/b2b-accounts/invites/inv-${userId}/approve`, userId: ACCOUNTANT, idempotencyKey: `approve-${userId}`, body: {} }), `approve ${userId}`);
        }
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who);
    const page = await context.newPage();
    const requests: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/')) requests.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(x: string): { length: number } } }).document.querySelectorAll('#invoices li.row').length > 0, undefined, { timeout: 15_000 });
    return { page, requests, errors, close: async () => { await page.waitForLoadState('networkidle').catch(() => {}); await context.close(); } }; // settle in-flight reads before the API restarts
  };

  it('the caterer sees its own account, invoices (the overdue one marked), aged statement and quotation — and writes nothing; a restart reads the same', async () => {
    let s = await open(CATERER);
    try {
      expect(await s.page.locator('#invoices li.row').count()).toBe(2);
      expect(await s.page.locator('#invoices li.row.tone-error').count()).toBe(1);
      expect(await s.page.locator('#invoices li.row.tone-error').first().innerText()).toContain('INV-C1');
      await s.page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(x: string): { hidden: boolean } | null } }).document.getElementById('account')?.hidden === false, undefined, { timeout: 15_000 });
      const account = await s.page.locator('#account').innerText();
      expect(account).toContain('₹5,000.00'); // the limit
      expect(account).toContain('₹700.00');   // owed: ₹1,000 invoiced − ₹300 paid (head office's own figure)
      expect(account).toContain('₹4,300.00'); // available
      await s.page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(x: string): { hidden: boolean } | null } }).document.getElementById('statement')?.hidden === false, undefined, { timeout: 15_000 });
      const statement = await s.page.locator('#statement').innerText();
      expect(statement).toContain('31–60 days overdue');
      expect(statement).toContain('₹700.00'); // INV-C1 net of the payment, in the 31–60 bucket
      expect(await s.page.locator('#documents li.row').count()).toBe(1);
      expect(await s.page.locator('#documents li.row').first().innerText()).toContain('Quotation');
      for (const p of ['/v1/b2b-portal/me/account', '/v1/b2b-portal/me/invoices', '/v1/b2b-portal/me/statement', '/v1/b2b-portal/me/documents']) expect(s.requests).toContain(`GET ${p}`);
      expect(s.requests.every((r) => r.startsWith('GET ')), 'not one write leaves the portal').toBe(true);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    await shop.restart();
    s = await open(CATERER);
    try {
      expect(await s.page.locator('#invoices li.row').count()).toBe(2);
      // In Tamil too.
      expect(await s.page.locator('#title').innerText()).toBe('Your account with SRE');
      await s.page.click('#lang');
      await s.page.waitForFunction(() => /[\u0B80-\u0BFF]/.test((globalThis as unknown as { document: { getElementById(x: string): { textContent: string | null } | null } }).document.getElementById('title')?.textContent ?? ''), undefined, { timeout: 10_000 });
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 180_000);

  it('the canteen (invoices only) is told it cannot see the account or statement — never ₹0.00 — and sees only its own invoice', async () => {
    const s = await open(CANTEEN);
    try {
      await s.page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(x: string): { hidden: boolean } | null } }).document.getElementById('statement-note')?.hidden === false, undefined, { timeout: 15_000 });
      expect(await s.page.locator('#account').getAttribute('hidden')).not.toBeNull();
      expect(await s.page.locator('#statement').getAttribute('hidden')).not.toBeNull();
      expect(await s.page.locator('#account-note').innerText()).toContain('cannot see the account balance');
      expect(await s.page.locator('#statement-note').innerText()).toContain('does not mean nothing is owed');
      const invoices = await s.page.locator('#invoices').innerText();
      expect(invoices).toContain('INV-K1');
      expect(invoices).not.toContain('INV-C1');
      expect(s.requests.every((r) => r.startsWith('GET '))).toBe(true);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 60_000);
});
