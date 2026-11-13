import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { confirmIt } from './lib/confirm-sheet';
import { auditPage } from './lib/a11y-audit';

/**
 * **U6 (UI/UX gap audit lane 3 · M23-FR-03 · M23-FR-01 · QG-07 · P-08): the Bank reconciliation page and the Payables and
 * receivables page, in a real browser, on the PRODUCTION API over real PostgreSQL.**
 *
 * The accountant imported September's bank statement (three lines), the provider's settlement file and a cash deposit on
 * the Card, UPI and bank page. Through Chromium:
 *   • BANK RECONCILIATION — the page reads the newest statement: the payout credit and the deposit credit are MATCHED
 *     (chips), the rent debit is UNMATCHED with its value in the cards; the accountant raises an exception on it for a
 *     named owner — the shared confirm sheet asks first (OB-698) — the line now carries an open exception, the exceptions
 *     register lists it; they resolve it with an outcome and a reason, confirmed, and the line shows it resolved; in Tamil
 *     on the toggle every page word is Tamil; one primary; the audit is clean; a cashier is refused in words and nothing
 *     is read.
 *   • PAYABLES AND RECEIVABLES — the receivables side lists the two credit customers, the differing one first with the
 *     difference visible and a "Differs" chip; the payables side is honest with no supplier account yet (an empty state,
 *     never a balanced zero), and "Post the payables" is greyed with the reason; a store manager reads both and is offered
 *     no post; the audit is clean in both languages.
 * Synthetic data, a fresh tenant. Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['u6', 'bank', 'accounts', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const ACCT = 'u-acct'; const CASHIER = 'u-cash'; const SM = 'u-sm';

const BATCH = {
  batchId: 'PB-0903', providerId: 'test-acquirer', currency: 'INR', settlementDate: '2026-09-03',
  lines: [{ id: 'l1', ref: 'PAY-1', amountMinor: 100_000 }], declaredGrossMinor: 100_000, declaredFeesMinor: 1_000, declaredNetMinor: 99_000, sourceName: 'acquirer.json',
};
const CSV = ['Date,Reference,Narrative,Debit,Credit', '03/09/2026,UTR778899 PB-0903,ACQUIRER SETTLEMENT,,990.00', '05/09/2026,DEP SLIP-77,CASH DEPOSIT,,200.00', '15/09/2026,CHQ001,Rent,"20,000.00",'].join('\n');
const STATEMENT = { statementId: 'HDFC-2026-09', accountRef: 'HDFC-current-1', fromDate: '2026-09-01', toDate: '2026-09-30', openingMinor: 5_000_000, closingMinor: 5_000_000 + 99_000 + 20_000 - 2_000_000, sourceName: 'hdfc-sep.csv', csv: CSV };

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('U6: the Bank reconciliation and the Payables and receivables pages on the production API', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/bank-reconciliation', html: 'bank-reconciliation.html', dataGlobal: 'bankReconciliationData' },
      alsoPages: [{ path: '/payables-receivables', html: 'payables-receivables.html', dataGlobal: 'payablesReceivablesData' }],
      seed: async (cloud) => {
        await cloud.grant(ACCT, 'accountant');
        await cloud.grant(CASHIER, 'cashier');
        await cloud.grant(SM, 'store_manager');
        const req = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown) =>
          cloud.request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `seed-${randomUUID()}` }) });
        await ok(req('POST', '/v1/settlement/batches', ACCT, BATCH), 'batch');
        await ok(req('POST', '/v1/finance/bank-statements', ACCT, STATEMENT), 'statement');
        await ok(req('POST', '/v1/finance/cash-deposits/dep-1', ACCT, { depositedOn: '2026-09-05', amountMinor: 20_000, slipRef: 'SLIP-77', accountRef: 'HDFC-current-1' }), 'deposit');
        // Receivables: B2B on; CUST1 agrees (₹1,000 both ways), CUST2 differs (the register asks ₹2,000, the ledger holds ₹1,800).
        await ok(req('PUT', '/v1/platform/entitlements/b2b', OWNER, { enabled: true }), 'b2b on');
        await ok(req('POST', '/v1/b2b/collections/CUST1/invoices/inv-1', OWNER, { number: 'INV-1', issuedOn: '2026-07-21', dueOn: '2026-08-20', grossMinor: 100_000 }), 'inv-1');
        await ok(req('POST', '/v1/b2b/accounts/CUST1/receivables', OWNER, { movementId: 'ar-1', kind: 'invoice', amountMinor: 100_000, ref: 'INV-1' }), 'ar-1');
        await ok(req('POST', '/v1/b2b/collections/CUST2/invoices/inv-2', OWNER, { number: 'INV-2', issuedOn: '2026-04-01', dueOn: '2026-05-01', grossMinor: 200_000, disputed: true, disputeReason: 'short delivery' }), 'inv-2');
        await ok(req('POST', '/v1/b2b/accounts/CUST2/receivables', OWNER, { movementId: 'ar-2', kind: 'invoice', amountMinor: 180_000, ref: 'INV-2' }), 'ar-2');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string, path: string) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await shop.signIn(context, who);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('response', (r) => { if (r.status() === 404 && !r.url().includes('/v1/')) errors.push(`404 ${r.url()}`); });
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    return { page, writes, errors, close: async () => { await page.waitForLoadState('networkidle').catch(() => {}); await context.close(); } };
  };
  const textOf = async (page: Page, selector: string): Promise<string> => (await page.locator(selector).first().textContent()) ?? '';

  it('bank reconciliation: the payout and the deposit are matched, the rent is unmatched with its value; an exception is raised (confirmed) and resolved (confirmed); Tamil; one primary; audit clean', async () => {
    const s = await open(ACCT, '/bank-reconciliation');
    try {
      await s.page.waitForSelector('#bank-lines-grid tbody tr', { timeout: 20_000 });
      const chips = await s.page.locator('#bank-lines-grid tbody tr .sre-chip').allTextContents();
      expect(chips.map((c) => c.split(' · ')[0]?.trim())).toEqual(['Provider payout', 'Cash deposit', 'Unmatched']);
      expect(await textOf(s.page, '#cards')).toMatch(/Unmatched value\s*−₹20000\.00/);
      expect(await textOf(s.page, '#adds-up')).toMatch(/adds up/);
      expect(await s.page.locator('.sre-btn-primary:visible').count()).toBe(1);
      // Raise an exception on the rent line: pick it from the row, name the owner, confirm on the sheet.
      await s.page.click('#bank-lines-grid tbody tr button[data-raise-line]');
      expect(await s.page.inputValue('#line')).toBe('HDFC-2026-09:3');
      await s.page.fill('#owner', ACCT);
      await s.page.fill('#note', 'no bill for this rent yet');
      const before = s.writes.length;
      await s.page.click('#raise-go');
      await s.page.waitForSelector('#sre-confirm:not([hidden])', { timeout: 10_000 });
      expect(await textOf(s.page, '#sre-confirm')).toMatch(/−₹20000\.00/);
      expect(s.writes.length).toBe(before); // nothing is sent before the person confirms
      await confirmIt(s.page);
      await s.page.waitForFunction(`document.getElementById('raise-status')?.textContent === 'Exception raised.'`, undefined, { timeout: 15_000 });
      expect(s.writes.filter((w) => w.includes('/bank-reconciliation/exceptions/'))).toHaveLength(1);
      await s.page.waitForSelector('#bank-exceptions-grid tbody tr', { timeout: 15_000 });
      await s.page.waitForFunction(`/open/.test(document.querySelector('#bank-lines-grid tbody tr:nth-child(3) .sre-chip')?.textContent ?? '')`, undefined, { timeout: 15_000 });
      expect(await textOf(s.page, '#bank-lines-grid tbody tr:nth-child(3) .sre-chip')).toMatch(/Exception · open/);
      expect(await textOf(s.page, '#cards')).toMatch(/Open exceptions\s*1/);
      // Resolve it: outcome + reason, confirmed.
      await s.page.click('#bank-lines-grid tbody tr button[data-resolve-exception]');
      expect(await s.page.inputValue('#exception')).not.toBe('');
      await s.page.selectOption('#outcome', 'matched_by_hand');
      await s.page.fill('#reason', 'September rent, bill RENT-09');
      await s.page.fill('#matched-to', 'RENT-09');
      await s.page.click('#resolve-go');
      await confirmIt(s.page);
      await s.page.waitForFunction(`document.getElementById('resolve-status')?.textContent === 'Resolution recorded.'`, undefined, { timeout: 15_000 });
      // the page reads head office again after the fact lands; the row follows
      await s.page.waitForFunction(`/resolved/.test(document.querySelector('#bank-lines-grid tbody tr:nth-child(3) .sre-chip')?.textContent ?? '')`, undefined, { timeout: 15_000 });
      expect(await textOf(s.page, '#bank-lines-grid tbody tr:nth-child(3) .sre-chip')).toMatch(/Exception · resolved/);
      expect(await textOf(s.page, '#exceptions-table')).toMatch(/Matched by hand · September rent, bill RENT-09 · Matched to.*RENT-09/);
      expect(await textOf(s.page, '#cards')).toMatch(/Open exceptions\s*0/);
      // Tamil: the page's words follow the toggle; head office's sentences are said to be English.
      await s.page.click('#lang');
      expect(await textOf(s.page, '#page-h')).toBe('வங்கி சரிக்கட்டல்');
      expect(await textOf(s.page, '#raise-text')).toBe('விதிவிலக்கை எழுப்பு');
      expect(await textOf(s.page, '#bank-lines-grid tbody tr:nth-child(1) .sre-chip')).toMatch(/வழங்குநர் செலுத்துதல்/);
      expect(await auditPage(s.page, { expectLang: 'ta' })).toEqual([]);
      await s.page.click('#lang');
      expect(await auditPage(s.page, { expectLang: 'en' })).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);

  it('a cashier is refused by name on the bank page and nothing is read', async () => {
    const s = await open(CASHIER, '/bank-reconciliation');
    try {
      await s.page.waitForFunction(`(document.getElementById('page-status')?.textContent ?? '') !== ''`, undefined, { timeout: 10_000 });
      expect(await textOf(s.page, '#page-status')).toBe('Your role cannot read the bank reconciliation.');
      expect(await s.page.locator('#choose').isHidden()).toBe(true);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  });

  it('payables and receivables: the two credit customers beside the ledger, the differing one first; no supplier account is said honestly; the post is greyed with its reason; a manager is offered no post; audit clean', async () => {
    const s = await open(ACCT, '/payables-receivables');
    try {
      await s.page.waitForSelector('#ar-customers-table-grid tbody tr', { timeout: 20_000 });
      const rows = await s.page.locator('#ar-customers-table-grid tbody tr').allTextContents();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatch(/CUST2/); expect(rows[0]).toMatch(/₹2000\.00/); expect(rows[0]).toMatch(/₹1800\.00/); expect(rows[0]).toMatch(/Differs/);
      expect(rows[1]).toMatch(/CUST1/); expect(rows[1]).toMatch(/Agrees/);
      expect(await textOf(s.page, '#ar-cards')).toMatch(/Difference\s*₹200\.00/);
      expect(await textOf(s.page, '#ar-cards')).toMatch(/Customers that differ 1/);
      expect(await textOf(s.page, '#ap-suppliers')).toMatch(/No supplier account yet\./);
      const post = s.page.locator('#post');
      expect(await post.isDisabled()).toBe(true);
      expect(await textOf(s.page, '#ap')).toMatch(/Nothing to post/);
      expect(await s.page.locator('.sre-btn-primary').count()).toBe(1);
      expect(s.writes).toEqual([]);
      await s.page.click('#lang');
      expect(await textOf(s.page, '#page-h')).toBe('கொடுக்க வேண்டியவை, பெற வேண்டியவை');
      expect(await textOf(s.page, '#ar-customers-table-grid tbody tr:nth-child(1)')).toMatch(/வேறுபடுகிறது/);
      expect(await auditPage(s.page, { expectLang: 'ta' })).toEqual([]);
      await s.page.click('#lang');
      expect(await auditPage(s.page, { expectLang: 'en' })).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const m = await open(SM, '/payables-receivables');
    try {
      await m.page.waitForSelector('#ar-customers-table-grid tbody tr', { timeout: 20_000 });
      expect(await textOf(m.page, '#page-status')).toBe('Your role can read the accounts but cannot post.');
      expect(await m.page.locator('#post').isHidden()).toBe(true);
      expect(m.writes).toEqual([]);
    } finally { await m.close(); }
  }, 120_000);
});
