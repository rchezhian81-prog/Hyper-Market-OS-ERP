import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { startPageShell } from './lib/page-shell';
import { creditLimitWithApproval } from '../support/approved-credit-limit';
import { customerListPrice, unpriced } from '../support/b2b-price-on-record';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **A business customer ASKS for a quote, ORDERS from its quotation and TELLS THE SHOP IT PAID on the portal; finance MATCHES
 * the payment to its own bank statement on the Business customers page — in a real browser, on the PRODUCTION API over real
 * PostgreSQL (M22-FR-04 · API-09 · OB-41 "A" · §28 · P-04 · hard rules #3 #6 #10).**
 *
 * Before W3 the portal was read-only and no screen called the portal's write routes or finance's matching routes. Through
 * Chromium, the customer on its own login (bound by the shop; no customer id is ever sent from the page):
 *   • asks for a quote (items and quantities — no price); the shop's desk sees the request;
 *   • places an order from the quotation the shop sent, at the quoted price, with the stock held at the quoted store;
 *   • tells the shop it sent ₹1,000 by bank transfer — the note is WAITING and what it owes does not change;
 *   • tells the shop about a second transfer the shop never receives.
 * Then the ACCOUNTANT (a second person) on the Business customers page: a match whose amount is not the note's is refused in
 * head office's words and the note stays waiting; the exact statement line matches it — the customer's balance comes down;
 * the second note is rejected with a reason. Back on the portal the customer reads both outcomes, in Tamil too.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['w3', 'b2b', 'write', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const CATERER = 'u-caterer-w3'; const ACCOUNTANT = 'u-acct-w3';
const LINE = { lineId: 'l1', productId: 'rice', description: 'Rice 25kg', qty: 10, unitPriceMinor: 10_000, taxRateBps: 500 };
const TODAY = shopDateIn(new Date().toISOString()); // the shop's own date — never the UTC date

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the B2B portal asks, orders and pays; finance matches (M22-FR-04)', () => {
  let browser: Browser;
  let shop: InboxShop;
  let desk: { base: string; stop: () => Promise<void> };

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'b2b-app'], { stdio: 'ignore' });
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/', html: 'index.html', dataGlobal: 'b2bData', webDir: 'apps/b2b-app/web' },
      seed: async (cloud) => {
        const as = (path: string, body: unknown, key: string, method: 'POST' | 'PUT' = 'POST') => ok(cloud.request({ method, path, userId: OWNER, idempotencyKey: key, body }), path);
        await as('/v1/platform/entitlements/b2b', { enabled: true }, 'b2b-on', 'PUT');
        await cloud.grant(ACCOUNTANT, 'accountant');
        await ok(creditLimitWithApproval((r) => cloud.request(r), OWNER, ACCOUNTANT, 'CATERER', { creditLimitMinor: 500_000 }, 'acc-cat'), 'caterer account');
        // ₹1,000 owed on one invoice.
        await as('/v1/b2b/accounts/CATERER/receivables', { movementId: 'ar-cat-1', kind: 'invoice', amountMinor: 100_000, ref: 'INV-C1' }, 'ar-cat-1');
        await as('/v1/b2b/collections/CATERER/invoices/inv-c1', { number: 'INV-C1', issuedOn: TODAY, dueOn: TODAY, grossMinor: 100_000 }, 'inv-c1');
        // The shop's quotation, priced from the caterer's price list, supplied from br-1 where 25 bags are on hand.
        const listed = customerListPrice('rice', 'CATERER', LINE.unitPriceMinor);
        await as(listed.path, listed.body, 'pl-rice');
        await as('/v1/inventory/movements', { movementId: 'rice-in', productId: 'rice', locationId: 'br-1', kind: 'received', quantityMinor: 25, uom: 'ea', occurredAt: new Date(Date.now() - 3_600_000).toISOString(), enteredBy: OWNER }, 'rice-in');
        await as('/v1/b2b/documents/CATERER/quotations/q-c1', { lines: unpriced([LINE]), locationId: 'br-1' }, 'q-c1');
        // The portal login, bound by the owner and approved by a second person (OB-76), with every portal grant.
        await as(`/v1/identity/outside-logins/b2b-accounts/CATERER/invites/inv-${CATERER}`, { userId: CATERER, displayName: 'Meena Raman', grants: ['view_statement', 'view_invoices', 'place_order', 'make_payment'] }, `invite-${CATERER}`);
        await ok(cloud.request({ method: 'POST', path: `/v1/identity/outside-logins/b2b-accounts/invites/inv-${CATERER}/approve`, userId: ACCOUNTANT, idempotencyKey: `approve-${CATERER}`, body: {} }), 'approve login');
      },
    });
    desk = await startPageShell({ cloud: () => shop.cloud(), page: { path: '/b2b', html: 'b2b.html', dataGlobal: 'b2bDeskData' } });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await desk?.stop(); await shop?.stop(); });

  const open = async (base: string, who: string, path: string) => {
    const context = await browser.newContext();
    const host = new URL(base).hostname;
    await context.addCookies([{ name: 'who', value: who, domain: host, path: '/' }]);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname.replace(/\/(QR|SO|TN)-[A-Za-z0-9]+/, '/$1-…')}`); });
    await page.goto(`${base}${path}`, { waitUntil: 'load' });
    return { page, writes, errors, close: async () => { await page.waitForLoadState('networkidle').catch(() => {}); await context.close(); } };
  };
  const says = async (page: Page, selector: string, expected: RegExp): Promise<void> => {
    try {
      await page.waitForFunction(([sel, source]) => new RegExp(source!).test((globalThis as unknown as { document: { querySelector(x: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''), [selector, expected.source], { timeout: 15_000 });
    } catch (e) {
      throw new Error(`${selector} never said ${String(expected)} — it says "${await page.locator(selector).first().textContent().catch(() => '(nothing)')}"`, { cause: e });
    }
  };
  const owedByHeadOffice = async (): Promise<number> => ((await shop.cloud().request({ method: 'GET', path: '/v1/b2b-portal/me/transfer-notes', userId: CATERER })).body as { outstandingMinor: number }).outstandingMinor;

  it('the customer asks for a quote, orders from its quotation and tells the shop about two transfers — nothing written on open', async () => {
    const s = await open(shop.base, CATERER, '/');
    try {
      await s.page.waitForSelector('#ordering:not([hidden])', { timeout: 15_000 });
      await s.page.waitForLoadState('networkidle');
      expect(s.writes, 'nothing is written on open').toEqual([]);

      // ASK — items and quantities only; a fraction is refused before anything is sent.
      await s.page.fill('#ask-productId-0', 'dal');
      await s.page.fill('#ask-qty-0', '2.5');
      await s.page.click('#ask-go');
      await says(s.page, '#ask-status', /^Write each item code and a whole quantity/);
      await s.page.fill('#ask-qty-0', '20');
      await s.page.fill('#ask-note', 'for the hostel, monthly');
      await s.page.click('#ask-go');
      await says(s.page, '#ask-status', /^Sent\. The shop will price this/);
      await s.page.locator('#ord-requests li[data-request]').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#ord-requests').innerText()).toContain('dal × 20 · for the hostel, monthly');

      // ORDER — from the shop's quotation, at its price.
      await s.page.locator('#order-quote option[value="q-c1"]').waitFor({ state: 'attached', timeout: 15_000 });
      await s.page.selectOption('#order-quote', 'q-c1');
      await s.page.click('#order-go');
      await says(s.page, '#order-status', /^Order placed at the quoted price\. .* · ₹1,050\.00$/);
      await s.page.locator('#ord-orders li[data-order]').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#ord-orders').innerText()).toContain('₹1,050.00 · q-c1');
      expect(await s.page.locator('#order-quote option').count(), 'an ordered quotation is offered no more').toBe(0);

      // PAY — a note, not money: what the customer owes does not change.
      await s.page.fill('#pay-amount', '1,000');
      await s.page.fill('#pay-on', TODAY);
      await s.page.fill('#pay-ref', 'UTR 2026');
      await s.page.click('#pay-go');
      await says(s.page, '#pay-status', /^Write the amount in rupees/);
      await s.page.fill('#pay-ref', 'UTR20261102A');
      await s.page.fill('#pay-against', 'inv-c1');
      await s.page.click('#pay-go');
      await says(s.page, '#pay-status', /^Thank you — the shop will check its bank/);
      await s.page.fill('#pay-amount', '500');
      await s.page.fill('#pay-on', TODAY);
      await s.page.fill('#pay-ref', 'UTR20261102B');
      await s.page.click('#pay-go');
      await says(s.page, '#pay-status', /^Thank you/);
      await says(s.page, '#ord-notes', /UTR20261102B · Waiting — the shop is checking its bank/);
      await says(s.page, '#ord-owed', /What you owe now \(the shop's figure\): ₹1,000\.00 · Told the shop, not yet seen in its bank: ₹1,500\.00/);
      expect(s.writes).toEqual([
        'POST /v1/b2b-portal/me/quote-requests/QR-…', 'POST /v1/b2b-portal/me/orders/SO-…',
        'POST /v1/b2b-portal/me/transfer-notes/TN-…', 'POST /v1/b2b-portal/me/transfer-notes/TN-…',
      ]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect(await owedByHeadOffice(), 'a note never reduces what is owed').toBe(100_000);
    const requests = (await shop.cloud().request({ method: 'GET', path: '/v1/b2b/quote-requests', userId: OWNER })).body as { requests: { customerId: string; lines: unknown; requestedBy: string }[] };
    expect(requests.requests).toEqual([expect.objectContaining({ customerId: 'CATERER', lines: [{ productId: 'dal', qty: 20 }], requestedBy: CATERER })]);
  }, 120_000);

  it('finance refuses a match that is not the note, matches the exact statement line and rejects the other; the customer reads both', async () => {
    const s = await open(desk.base, ACCOUNTANT, '/b2b');
    try {
      await s.page.waitForSelector('#tn:not([hidden])', { timeout: 15_000 });
      await s.page.click('#tn-show');
      await says(s.page, '#tn-summary', /^2 waiting · ₹1,500\.00 waiting to be checked/);
      const first = s.page.locator('#tn-list li', { hasText: 'UTR20261102A' });
      await first.waitFor({ timeout: 15_000 });
      expect(await first.innerText()).toMatch(/CATERER · ₹1,000\.00 · Waiting — check the bank statement/);
      await first.locator('input.tn-received').fill('900');
      await first.locator('input.tn-on').fill(TODAY);
      await first.locator('input.tn-ref').fill('UTR20261102A');
      await first.locator('button.tn-match').click();
      await says(s.page, '#tn-status', /^Head office refused: The bank shows 90000 received; the note says 100000 was sent/);
      await first.locator('input.tn-received').fill('1000');
      await first.locator('button.tn-match').click();
      await says(s.page, '#tn-status', /^Matched — the money is recorded once/);
      await s.page.locator('#tn-list li[data-state="matched"]').waitFor({ timeout: 15_000 });

      const second = s.page.locator('#tn-list li[data-state="pending"]', { hasText: 'UTR20261102B' });
      await second.locator('button.tn-reject').click();
      await says(s.page, '#tn-status', /^Write why it is rejected/);
      await second.locator('input.tn-why').fill('no such credit on the statement');
      await second.locator('button.tn-reject').click();
      await says(s.page, '#tn-status', /^Rejected — the note stays on record/);
      await says(s.page, '#tn-summary', /^0 waiting/);
      expect(s.writes).toEqual(expect.arrayContaining([expect.stringMatching(/^POST \/v1\/b2b\/transfer-notes\/TN-…\/match$/), expect.stringMatching(/^POST \/v1\/b2b\/transfer-notes\/TN-…\/reject$/)]));
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect(await owedByHeadOffice(), 'the matched transfer reduced what is owed, once').toBe(0);

    const c = await open(shop.base, CATERER, '/');
    try {
      await c.page.waitForSelector('#ordering:not([hidden])', { timeout: 15_000 });
      await c.page.click('#ord-show');
      await says(c.page, '#ord-notes', /UTR20261102A · Received by the shop/);
      await says(c.page, '#ord-notes', /UTR20261102B · Not found by the shop — no such credit on the statement/);
      await says(c.page, '#ord-owed', /What you owe now \(the shop's figure\): ₹0\.00/);
      await c.page.click('#lang');
      await says(c.page, '#ord-h', /கேள், ஆணையிடு, செலுத்து/);
      expect(c.errors).toEqual([]);
    } finally { await c.close(); }
  }, 120_000);
});
