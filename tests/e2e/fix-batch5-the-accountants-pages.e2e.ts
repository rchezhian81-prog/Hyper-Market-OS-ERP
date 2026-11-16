import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startBoxPageShop, says, HAVE_BROWSER, type BoxPageShop } from './lib/r4c-box-page';
import { approveSupplierWith, SUPPLIER_MAKER, SUPPLIER_CHECKER, deliveryPlaces } from '../support/approved-supplier';
import { P3, issuedOrder, received, capturedAndMatched, caller } from '../support/p3-purchase';
import { approvedRequestId } from '../support/approval-request';
import { chromium, type Browser } from 'playwright-core';
import { startOfficeShop, PEOPLE, type OfficeShop } from './lib/office-shop';
import { CHROMIUM } from './lib/r4c-box-page';

/**
 * **Fix batch 5 (OB-800 THE PLAN) · daily-work defects D-048, D-049, D-050, D-051 — the accountant's pages, in a real
 * browser on the real store computer and head office's production routes.**
 *   • D-048 Supplier bills: a bank transfer to Murugan Stores (approved, but no checked bank account) is refused the moment it
 *     is ASKED for — in plain words, with no requirement code, and no approval is asked; the same payment to Sakthi Traders
 *     (checked account) is asked.
 *   • D-049 Approvals: the second person reads "Bank transfer", the supplier by name and the bill with its match result.
 *   • D-050 Day book: before posting, the page shows what the tills sent for today (sales, takings by tender) and says plainly
 *     that the account names are not set up yet, and where in the menu that is done.
 *   • D-051 GST returns: one job at a time (Monthly GST / Yearly returns / TDS) and the month is a month picker.
 */
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const [y, m, d] = day.split('-');
const ddmm = `${d}/${m}/${y}`;
const ACCT_WORDS = ['identity.self.read', 'finance.period.read', 'finance.journal.post', 'purchase.supplier.pay', 'supplier.view', 'purchase.commitment.read', 'purchase.invoice.match',
  'finance.gstr.read', 'finance.gstr.generate', 'finance.tds.read', 'finance.rcm.read'];

describe.skipIf(!HAVE_BROWSER)('Fix batch 5: the accountant\'s pages (D-048, D-049, D-050, D-051)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'b5-accounts',
      people: [
        { userId: P3.PAYER, permissions: ACCT_WORDS },
        { userId: P3.PAY_APPROVER, permissions: ACCT_WORDS },
      ],
      seed: async (h, T, store) => {
        await h.seedOwner(T, P3.OWNER);
        for (const [u, r] of [[SUPPLIER_MAKER, 'store_manager'], [SUPPLIER_CHECKER, 'accountant'], [P3.BUYER, 'store_manager'], [P3.RECEIVER, 'store_manager'],
          [P3.MATCHER, 'accountant'], [P3.PAYER, 'accountant'], [P3.PAY_APPROVER, 'accountant']] as const) await h.provisionRole(T, u, r);
        const call = (method: 'POST', path: string, userId: string, body: unknown, idempotencyKey: string) => h.request({ method, path, userId, tenantId: T, body, idempotencyKey });
        await approveSupplierWith(call, 'sup-1', 'Sakthi Traders');
        await approveSupplierWith(call, 'sup-2', 'Murugan Stores');
        await deliveryPlaces(h, T, store, ...[P3.STORE, P3.BACK].filter((x) => x !== store));
        const p3 = caller(h, T);
        const lines = [{ productId: 'rice', qty: 10, unitMinor: 5_000 }];
        // Sakthi Traders: a matched ₹500 bill inv-a and a checked bank account. Murugan Stores: a matched bill, no checked account.
        await issuedOrder(p3, 'po-a', lines, 'sup-1');
        await received(p3, 'grn-a', 'po-a', lines);
        await capturedAndMatched(p3, 'inv-a', 'po-a', lines, undefined, 'sup-1', day);
        await issuedOrder(p3, 'po-b', lines, 'sup-2');
        await received(p3, 'grn-b', 'po-b', lines);
        await capturedAndMatched(p3, 'inv-b', 'po-b', lines, undefined, 'sup-2', day);
        const change = { newAccount: 'HDFC-0001-2345-6789', requestedVia: 'letter', calledBackOn: '+91-800-1', numberWeAlreadyHeld: '+91-800-1', requestedAt: '2026-09-30T08:00:00.000Z' };
        const approvalId = await approvedRequestId(h, T, P3.OWNER, P3.MATCHER, { kind: 'supplier_bank_change', subjectRef: 'sup-1', details: { ...change, supplierId: 'sup-1' } });
        const bank = await h.request({ method: 'POST', path: '/v1/purchase/suppliers/sup-1/bank-details', userId: P3.OWNER, tenantId: T, body: { ...change, approvalId }, idempotencyKey: 'b5-bank' });
        if (bank.status >= 300) throw new Error(`bank: ${bank.status} ${JSON.stringify(bank.body)}`);
        // Today's till: two bills, one paid by cash and one by UPI (D-050).
        for (const [saleId, tender, minor] of [['b5-s1', 'cash', 10_500], ['b5-s2', 'upi', 20_000]] as const) {
          const s = await h.request({
            method: 'POST', path: '/v1/sales', userId: P3.OWNER, tenantId: T, idempotencyKey: `b5-${saleId}`,
            body: { saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: P3.OWNER, tradingDay: day, committedAt: `${day}T05:00:00Z`, totalMinor: minor, currency: 'INR', packVersion: 1,
              lines: [{ productId: 'rice', quantityMinor: 1, uom: 'each', unitPriceMinor: minor, lineTotalMinor: minor }], tenders: [{ kind: tender, amountMinor: minor }] },
          });
          if (s.status >= 300) throw new Error(`sale: ${s.status} ${JSON.stringify(s.body)}`);
        }
      },
    });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); });

  const fillPayment = async (page: import('playwright-core').Page, supplierId: string, ref: string): Promise<void> => {
    await page.waitForSelector('#pay:not([hidden])');
    await page.waitForFunction('globalThis.sreOffice !== undefined');
    await page.fill('#pay-supplier', supplierId);
    await page.fill('#pay-amount', '500');
    await page.fill('#pay-on', ddmm);
    await page.selectOption('#pay-method', 'bank_transfer');
    await page.fill('#pay-ref', ref);
  };

  it('D-048 · D-049: a supplier with no checked account is refused when asked (plain words); the approver reads the name, "Bank transfer" and the bill\'s match', async () => {
    const p = await shop.open(P3.PAYER, '/supplier-bills');
    try {
      const { page } = p;
      await fillPayment(page, 'sup-2', 'NEFT-B5-2');
      await page.click('#pay-ask');
      await says(page, '#pay-status', /no checked bank account on record.*Nothing was asked\./);
      expect(await page.textContent('#pay-status')).not.toMatch(/M\d{2}-FR|§\d|OB-\d/);
      expect(p.writes.filter((w) => w === 'POST /v1/approvals/requests'), 'no approval is asked for a payment that could never be recorded').toEqual([]);

      await fillPayment(page, 'sup-1', 'NEFT-B5-1');
      await page.locator('#pay-bills-list input[value="inv-a"]').check();
      await page.click('#pay-ask');
      await says(page, '#pay-status', /^Asked\./);
      expect(p.writes.filter((w) => w === 'POST /v1/approvals/requests')).toHaveLength(1);
      expect(p.errors).toEqual([]);
    } finally { await p.close(); }

    const a = await shop.open(P3.PAY_APPROVER, '/approvals');
    try {
      const { page } = a;
      await says(page, '#waiting', /Payment to Sakthi Traders \(sup-1\): ₹500\.00 by Bank transfer/);
      await says(page, '#waiting', /How it is paid: Bank transfer/);
      await says(page, '#waiting .pay-facts', /Supplier: Sakthi Traders \(sup-1\)/);
      await says(page, '#waiting .pay-facts', /inv-a — matched; ₹500\.00 may be paid/);
      expect(await page.textContent('#waiting')).not.toMatch(/bank_transfer/);
      expect(a.writes).toEqual([]);
      expect(a.errors).toEqual([]);
    } finally { await a.close(); }
  });
});

describe.skipIf(!HAVE_BROWSER)('Fix batch 5: the Day book and GST pages as the accountant (D-050, D-051)', () => {
  let browser: Browser;
  let office: OfficeShop;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    office = await startOfficeShop(browser, {
      seed: async (ok) => {
        // Today's till: two bills, one paid by cash and one by UPI (D-050).
        for (const [saleId, tender, minor] of [['b5-s1', 'cash', 10_500], ['b5-s2', 'upi', 20_000]] as const) {
          await ok('/v1/sales', PEOPLE.owner, { saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: PEOPLE.owner, tradingDay: day, committedAt: `${day}T05:00:00Z`, totalMinor: minor, currency: 'INR', packVersion: 1,
            lines: [{ productId: 'rice', quantityMinor: 1, uom: 'each', unitPriceMinor: minor, lineTotalMinor: minor }], tenders: [{ kind: tender, amountMinor: minor }] });
        }
      },
    });
  }, 300_000);
  afterAll(async () => { await office?.stop(); await browser?.close(); });

  /** Open a page as a person, listing every write the browser sends to head office. */
  const openAs = async (who: string, path: string) => {
    const s = await office.asPerson(who, { viewport: { width: 1280, height: 860 } } as never);
    const writes: string[] = [];
    s.page.on('request', (r) => { if (r.method() !== 'GET' && new URL(r.url()).pathname.startsWith('/v1/')) writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    await s.page.goto(`${office.base}${path}`, { waitUntil: 'load' });
    await s.page.waitForFunction('globalThis.sreOffice !== undefined');
    await s.page.waitForLoadState('networkidle').catch(() => {});
    return { page: s.page, errors: s.errors, writes, close: () => s.context.close() };
  };

  it('D-050: before posting, the Day book shows what the tills sent today and says plainly the account names are not set up', async () => {
    const b = await openAs(PEOPLE.accountant, '/day-book');
    try {
      const { page } = b;
      await page.waitForFunction('globalThis.sreOffice !== undefined');
      await page.click('#load');
      await page.waitForSelector('#tills:not([hidden])', { timeout: 15_000 });
      await says(page, '#tills-rows', /Sales: 2 bill\(s\), ₹305\.00/);
      await says(page, '#tills-rows', /Takings — Cash: ₹105\.00 · UPI: ₹200\.00/);
      await says(page, '#tills-waiting', /^2 bill\(s\) or return\(s\) not yet in the books\.$/);
      await page.waitForSelector('#map-missing:not([hidden])');
      await says(page, '#map-missing', /account names have not been set up.*Accounts and Tally names/);
      await page.click('#lang');
      await says(page, '#tills-heading', /^இந்த நாளுக்குக் கல்லாக்கள் அனுப்பியவை$/);
      expect(b.writes).toEqual([]);
      expect(b.errors).toEqual([]);
    } finally { await b.close(); }
  });

  it('D-051: the GST page shows one job at a time, and the month is a month picker', async () => {
    const g = await openAs(PEOPLE.accountant, '/gst-returns');
    try {
      const { page } = g;
      await page.waitForSelector('#job-monthly');
      expect(await page.getAttribute('#job-monthly', 'aria-selected')).toBe('true');
      expect(await page.getAttribute('#period', 'type')).toBe('month');
      expect(await page.inputValue('#period')).toMatch(/^\d{4}-\d{2}$/);
      const off = (id: string) => page.$eval(`#${id}`, (n) => (n as unknown as { classList: { contains(c: string): boolean } }).classList.contains('job-off'));
      expect(await off('ho')).toBe(false);
      expect(await off('d-tds')).toBe(true);
      expect(await off('ho-yearly')).toBe(true);
      await page.click('#job-tds');
      expect(await page.getAttribute('#job-tds', 'aria-selected')).toBe('true');
      expect(await off('d-tds')).toBe(false);
      expect(await off('ho')).toBe(true);
      await says(page, '#job-lead', /Income-tax TDS/);
      await page.click('#job-yearly');
      expect(await off('ho-yearly')).toBe(false);
      expect(await off('d-9c')).toBe(false);
      expect(await off('register')).toBe(true);
      await page.click('#job-monthly');
      await page.fill('#period', `${y}-${m}`);
      await page.click('#show');
      expect(await page.getAttribute('#period', 'aria-invalid')).toBeNull();
      await page.click('#lang');
      await says(page, '#job-monthly', /^மாதாந்திர GST$/);
      expect(g.errors).toEqual([]);
    } finally { await g.close(); }
  });
});
