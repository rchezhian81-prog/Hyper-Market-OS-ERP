import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startBoxPageShop, says, HAVE_BROWSER, type BoxPageShop } from './lib/r4c-box-page';
import { askedThenConfirmed, writeCounter } from './lib/confirm-sheet';
import { approveSupplierWith, SUPPLIER_MAKER, SUPPLIER_CHECKER, deliveryPlaces } from '../support/approved-supplier';
import { P3, issuedOrder, received, capturedAndMatched, caller } from '../support/p3-purchase';
import { approvedRequestId } from '../support/approval-request';

/**
 * **OB-807 A (owner, 16 Nov 2026, in writing) · daily-work defect D-046 — a supplier payment is approved before it is paid,
 * in a real browser on the real store computer and head office's production routes.**
 *   • The accountant asks on Supplier bills with the amount, how it is paid and the bill it settles — there is no day and no
 *     UTR to type yet, and none goes into the approval.
 *   • A second person approves it; the accountant's list says "Approved — record it when paid".
 *   • Pressing "Record this payment" without the day and UTR is refused in plain words and nothing is sent; a day still to
 *     come is refused too; with today's date and the bank's UTR it is recorded, behind the confirm sheet, exactly once.
 */
const shopDay = (offsetDays = 0): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offsetDays * 86_400_000));
const ddmmOf = (iso: string): string => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
const day = shopDay();
const WORDS = ['identity.self.read', 'purchase.supplier.pay', 'supplier.view', 'purchase.commitment.read', 'purchase.invoice.match'];

describe.skipIf(!HAVE_BROWSER)('OB-807 A: a supplier payment is approved on its amount and bills; the day and UTR are typed when it is recorded', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'ob807',
      people: [{ userId: P3.PAYER, permissions: WORDS }, { userId: P3.PAY_APPROVER, permissions: WORDS }],
      seed: async (h, T, store) => {
        await h.seedOwner(T, P3.OWNER);
        for (const [u, r] of [[SUPPLIER_MAKER, 'store_manager'], [SUPPLIER_CHECKER, 'accountant'], [P3.BUYER, 'store_manager'], [P3.RECEIVER, 'store_manager'],
          [P3.MATCHER, 'accountant'], [P3.PAYER, 'accountant'], [P3.PAY_APPROVER, 'accountant']] as const) await h.provisionRole(T, u, r);
        const call = (method: 'POST', path: string, userId: string, body: unknown, idempotencyKey: string) => h.request({ method, path, userId, tenantId: T, body, idempotencyKey });
        await approveSupplierWith(call, 'sup-1', 'Sakthi Traders');
        await deliveryPlaces(h, T, store, ...[P3.STORE, P3.BACK].filter((x) => x !== store));
        const p3 = caller(h, T);
        const lines = [{ productId: 'rice', qty: 10, unitMinor: 5_000 }];
        await issuedOrder(p3, 'po-a', lines, 'sup-1');
        await received(p3, 'grn-a', 'po-a', lines);
        await capturedAndMatched(p3, 'inv-a', 'po-a', lines, undefined, 'sup-1', day);
        const change = { newAccount: 'HDFC-0001-2345-6789', requestedVia: 'letter', calledBackOn: '+91-800-1', numberWeAlreadyHeld: '+91-800-1', requestedAt: '2026-09-30T08:00:00.000Z' };
        const approvalId = await approvedRequestId(h, T, P3.OWNER, P3.MATCHER, { kind: 'supplier_bank_change', subjectRef: 'sup-1', details: { ...change, supplierId: 'sup-1' } });
        const bank = await h.request({ method: 'POST', path: '/v1/purchase/suppliers/sup-1/bank-details', userId: P3.OWNER, tenantId: T, body: { ...change, approvalId }, idempotencyKey: 'ob807-bank' });
        if (bank.status >= 300) throw new Error(`bank: ${bank.status} ${JSON.stringify(bank.body)}`);
      },
    });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); });

  it('asked with no day or UTR; approved; recorded only with today\'s date and the UTR — once, behind the sheet', async () => {
    const p = await shop.open(P3.PAYER, '/supplier-bills');
    try {
      const { page } = p;
      const sent = writeCounter(page);
      await page.waitForSelector('#pay:not([hidden])');
      await page.waitForFunction('globalThis.sreOffice !== undefined');
      // The ask has no day and no reference: those boxes sit under "Approved — record it when paid".
      await says(page, '#pay-record-h', /^Approved — record it when paid$/);
      await says(page, '#pay-record-lead', /type the day it was paid and its reference \(UTR/);
      await page.fill('#pay-supplier', 'sup-1');
      await page.fill('#pay-amount', '500');
      await page.selectOption('#pay-method', 'bank_transfer');
      await page.locator('#pay-bills-list input[value="inv-a"]').check();
      await page.click('#pay-ask');
      await says(page, '#pay-status', /^Asked\./);

      // What was asked: the amount, how, the bill — no day, no UTR.
      const mine = (await shop.call('GET', '/v1/approvals/requests', P3.PAYER)).body as { mine: { requestId: string; kind: string; details: Record<string, unknown>; summary: string }[] };
      const ask = mine.mine.find((q) => q.kind === 'supplier_payment')!;
      expect(ask.details).toMatchObject({ amountMinor: 50_000, method: 'bank_transfer', settles: ['inv-a'], supplierId: 'sup-1' });
      expect(ask.details).not.toHaveProperty('paidOn');
      expect(ask.details).not.toHaveProperty('reference');
      expect(ask.summary).toBe('Payment to Sakthi Traders (sup-1): ₹500.00 by Bank transfer, settles bill(s) inv-a');
      expect((await shop.call('POST', `/v1/approvals/requests/${ask.requestId}/decide`, P3.PAY_APPROVER, { decision: 'approved', reason: 'checked the bill' })).status).toBe(201);

      await page.click('#pay-asks-show');
      await says(page, '#pay-asks', /Approved — record it when paid/);
      const payments = () => p.writes.filter((w) => /^POST \/v1\/purchase\/suppliers\/sup-1\/payments\//.test(w)).length;
      // Not paid yet: no day, no UTR — refused here in plain words; nothing sent.
      await page.fill('#pay-on', '');
      await page.fill('#pay-ref', '');
      await page.click('#pay-asks .pay-record');
      await says(page, '#pay-status', /^Type the day it was paid and its reference/);
      // A day still to come: refused; nothing recorded.
      await page.fill('#pay-on', ddmmOf(shopDay(1)));
      await page.fill('#pay-ref', 'NEFT-807');
      await page.click('#pay-asks .pay-record');
      await says(page, '#pay-status', /cannot be a day still to come/);
      expect(payments()).toBe(0);

      // Paid today: the date and the bank's UTR, then recorded behind the confirm sheet.
      await page.fill('#pay-on', ddmmOf(day));
      await askedThenConfirmed(page, async () => { await page.click('#pay-asks .pay-record'); }, /₹500\.00 paid to .*sup-1.* will be recorded/, sent);
      await says(page, '#pay-status', /^Recorded\./);
      expect(payments()).toBe(1);
      const account = (await shop.call('GET', '/v1/purchase/suppliers/sup-1/account', P3.PAYER)).body as { payments: { reference: string; paidOn: string; approvedBy: string; amountMinor: number }[] };
      expect(account.payments).toEqual([expect.objectContaining({ reference: 'NEFT-807', paidOn: day, approvedBy: P3.PAY_APPROVER, amountMinor: 50_000 })]);
      expect(p.errors).toEqual([]);
    } finally { await p.close(); }
  });
});
