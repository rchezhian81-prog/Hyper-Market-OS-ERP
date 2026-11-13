import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startBoxPageShop, says, HAVE_BROWSER, type BoxPageShop } from './lib/r4c-box-page';
import { askedThenConfirmed, writeCounter } from './lib/confirm-sheet';
import { approveSupplierWith, SUPPLIER_MAKER, SUPPLIER_CHECKER, deliveryPlaces } from '../support/approved-supplier';
import { P3, issuedOrder, received, capturedAndMatched, caller } from '../support/p3-purchase';
import { approvedRequestId } from '../support/approval-request';

/**
 * **U7 · OB-725 · M24-FR-02 alt · OB-724, in a real browser on the real store computer and head office.**
 *   • Supplier claims: the claim a buyer ACCEPTED is a draft credit; the buyer who accepted it is shown the Approve button
 *     grey with the reason (another person approves); the accountant approves it behind the confirm sheet (Go back sends
 *     nothing; Confirm sends once) and the row reads Approved; the claim the buyer REJECTED is an open disputed claim with
 *     its value and owner; the buyer settles it with an outcome and a reason; Tamil twin.
 *   • Supplier bills: the payer asks to record ₹500 paid to sup-1 by bank transfer, reference NEFT-77001, settling inv-a; a
 *     second person approves; the payer records it behind the confirm sheet. Bank reconciliation then shows the statement's
 *     ₹500 debit naming NEFT-77001 as matched to that supplier payment.
 */
const BUYER = 'u-buyer';
const BOSS = 'u-boss';
const ACCT = 'u-acct';
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const [y, m, d] = day.split('-');
const ddmm = `${d}/${m}/${y}`;

describe.skipIf(!HAVE_BROWSER)('U7: draft credits, disputed claims and a supplier payment matched on the bank', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'u7-claims-pay',
      people: [
        { userId: BUYER, permissions: ['purchase.commitment.read', 'supplier.portal.review'] },
        { userId: BOSS, permissions: ['purchase.commitment.read', 'supplier.portal.review', 'purchase.supplier.pay'] },
        { userId: ACCT, permissions: ['purchase.commitment.read', 'purchase.supplier.pay'] },
        { userId: P3.PAYER, permissions: ['identity.self.read', 'purchase.invoice.match', 'purchase.invoice.capture', 'finance.period.read', 'purchase.supplier.pay'] },
        { userId: P3.MATCHER, permissions: ['settlement.review.read', 'settlement.investigation.manage', 'finance.period.read'] },
      ],
      seed: async (h, T, store) => {
        await h.seedOwner(T, P3.OWNER);
        for (const [u, r] of [[BUYER, 'store_manager'], [BOSS, 'owner'], [ACCT, 'accountant'], ['u-sup', 'supplier'], [SUPPLIER_MAKER, 'store_manager'], [SUPPLIER_CHECKER, 'accountant'],
          [P3.BUYER, 'store_manager'], [P3.RECEIVER, 'store_manager'], [P3.MATCHER, 'accountant'], [P3.PAYER, 'accountant'], [P3.PAY_APPROVER, 'accountant']] as const) await h.provisionRole(T, u, r);
        let seq = 0;
        const post = async (path: string, userId: string, body: unknown) => {
          const r = await h.request({ method: 'POST', path, userId, tenantId: T, body, idempotencyKey: `seed-${path}-${userId}-${JSON.stringify(body).length}-${seq++}` });
          if (r.status >= 300) throw new Error(`${path}: ${r.status} ${JSON.stringify(r.body)}`);
          return r;
        };
        const call = (method: 'POST', path: string, userId: string, body: unknown, idempotencyKey: string) => h.request({ method, path, userId, tenantId: T, body, idempotencyKey });
        await approveSupplierWith(call, 'sup-a', 'Aavin Dairy');
        await approveSupplierWith(call, 'sup-1', 'Sakthi Traders');
        await deliveryPlaces(h, T, store, ...[P3.STORE, P3.BACK].filter((x) => x !== store));
        // Two claims from Aavin Dairy: freight (accepted by the boss) and a short-paid bill (rejected by the buyer).
        await post('/v1/purchase/orders/po-1', BUYER, { supplierId: 'sup-a', deliverToLocationId: store, lines: [{ productId: 'p2', orderedQty: 4, unitCost: { minor: 1000, currency: 'INR' } }] });
        await post('/v1/purchase/orders/po-1/approval', P3.OWNER, { reason: 'fixture' });
        await post('/v1/supplier-portal/partners/sup-a', BUYER, { grants: ['raise_claim'], documents: [], requiredDocuments: [], logins: ['u-sup'] });
        await post('/v1/supplier-portal/me/submissions', 'u-sup', { submissionId: 'clm-freight', kind: 'claim', document: { poId: 'po-1', claimMinor: 150_000, why: 'freight paid by us' } });
        await post('/v1/supplier-portal/me/submissions', 'u-sup', { submissionId: 'clm-short', kind: 'claim', document: { poId: 'po-1', claimMinor: 20_000, why: 'bill short-paid' } });
        await post('/v1/supplier-portal/partners/sup-a/submissions/clm-freight/review', BOSS, { decision: 'accept', reason: 'freight was not in the price' });
        await post('/v1/supplier-portal/partners/sup-a/submissions/clm-short/review', BUYER, { decision: 'reject', reason: 'paid in full on 2 Nov' });
        // Sakthi Traders: a matched ₹500 bill inv-a, and a verified bank account.
        const p3 = caller(h, T);
        const lines = [{ productId: 'rice', qty: 10, unitMinor: 5_000 }];
        await issuedOrder(p3, 'po-a', lines, 'sup-1');
        await received(p3, 'grn-a', 'po-a', lines);
        await capturedAndMatched(p3, 'inv-a', 'po-a', lines, undefined, 'sup-1', day);
        const change = { newAccount: 'HDFC-0001-2345-6789', requestedVia: 'letter', calledBackOn: '+91-800-1', numberWeAlreadyHeld: '+91-800-1', requestedAt: '2026-09-30T08:00:00.000Z' };
        const approvalId = await approvedRequestId(h, T, P3.OWNER, P3.MATCHER, { kind: 'supplier_bank_change', subjectRef: 'sup-1', details: { ...change, supplierId: 'sup-1' } });
        await post('/v1/purchase/suppliers/sup-1/bank-details', P3.OWNER, { ...change, approvalId });
      },
    });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); });

  it('Supplier claims: the accepter cannot approve the credit (said why); the accountant approves it behind the sheet; the buyer settles the disputed claim', async () => {
    const boss = await shop.open(BOSS, '/supplier-claims');
    try {
      await says(boss.page, '#credit-table tbody tr[data-credit="SCC-clm-freight"]', /Draft — waiting for the accountant/);
      await boss.page.click('#credit-table tbody tr[data-credit="SCC-clm-freight"] .sre-row-open');
      await boss.page.waitForSelector('#approve-clm-freight');
      expect(await boss.page.isDisabled('#approve-clm-freight')).toBe(true);
      await says(boss.page, '#sre-drawer', /You accepted this claim, so another person approves its credit\./);
      expect(boss.writes).toEqual([]);
      expect(boss.errors).toEqual([]);
    } finally { await boss.close(); }

    const a = await shop.open(ACCT, '/supplier-claims');
    try {
      const { page } = a;
      const sent = writeCounter(page);
      await says(page, '#cards', /Credits to approve\s*1/);
      await page.click('#credit-table tbody tr[data-credit="SCC-clm-freight"] .sre-row-open');
      await page.fill('#credit-reason-clm-freight', 'freight receipt seen');
      const title = await askedThenConfirmed(page, async () => {
        if (!(await page.locator('#approve-clm-freight').isVisible())) {
          await page.click('#credit-table tbody tr[data-credit="SCC-clm-freight"] .sre-row-open');
          await page.fill('#credit-reason-clm-freight', 'freight receipt seen');
        }
        await page.click('#approve-clm-freight');
      }, /₹1,500\.00 will be added to what the shop owes Aavin Dairy/, sent);
      expect(title).toMatch(/Aavin Dairy/);
      await says(page, '#credit-table tbody tr[data-credit="SCC-clm-freight"]', /Approved — on the account/);
      expect(a.writes).toEqual(['POST /v1/purchase/supplier-claims/credits/sup-a/clm-freight']);
      // the disputed claim is there for the accountant to read, but settling it is the buyer's (said why)
      await says(page, '#dispute-table tbody tr[data-exception="DSP-clm-short"]', /₹200\.00/);
      await page.click('#lang');
      await says(page, '#credit-h', /^ஒப்புதல் தேவைப்படும் வரவுகள்$/);
      expect(a.errors).toEqual([]);
    } finally { await a.close(); }

    const b = await shop.open(BUYER, '/supplier-claims');
    try {
      const { page } = b;
      await says(page, '#dispute-table tbody tr[data-exception="DSP-clm-short"]', /Open|Overdue/);
      await says(page, '#dispute-table tbody tr[data-exception="DSP-clm-short"]', /paid in full on 2 Nov/);
      await page.click('#dispute-table tbody tr[data-exception="DSP-clm-short"] .sre-row-open');
      await page.click('#settle-clm-short');
      await says(page, '#dispute-status', /^Choose how it was settled first\. Nothing was recorded\.$/);
      expect(b.writes).toEqual([]);
      await page.click('#dispute-table tbody tr[data-exception="DSP-clm-short"] .sre-row-open');
      await page.selectOption('#outcome-clm-short', 'supplier_withdrew');
      await page.fill('#settle-reason-clm-short', 'supplier saw the 2 Nov payment');
      await page.click('#settle-clm-short');
      await says(page, '#dispute-table tbody tr[data-exception="DSP-clm-short"]', /Settled/);
      expect(b.writes).toEqual(['POST /v1/purchase/supplier-claims/disputes/sup-a/clm-short/resolve']);
      expect(b.errors).toEqual([]);
    } finally { await b.close(); }
  });

  it('Supplier bills: a payment naming its bill is asked, approved by a second person, recorded behind the sheet; the bank line is matched to it', async () => {
    const p = await shop.open(P3.PAYER, '/supplier-bills');
    try {
      const { page } = p;
      const sent = writeCounter(page);
      await page.waitForSelector('#pay:not([hidden])');
      await says(page, '#pay-h', /^Record a payment to a supplier$/);
      await page.waitForFunction('globalThis.sreOffice !== undefined');
      await page.fill('#pay-supplier', 'sup-1');
      await page.fill('#pay-amount', '500');
      await page.fill('#pay-on', ddmm);
      await page.selectOption('#pay-method', 'bank_transfer');
      await page.fill('#pay-ref', 'NEFT-77001');
      await page.fill('#pay-settles', 'inv-a');
      await page.click('#pay-ask');
      await says(page, '#pay-status', /^Asked\./);
      // A second person approves it in their own session.
      const mine = (await shop.call('GET', '/v1/approvals/requests', P3.PAYER)).body as { mine: { requestId: string; kind: string }[] };
      const ask = mine.mine.find((q) => q.kind === 'supplier_payment')!;
      expect((await shop.call('POST', `/v1/approvals/requests/${ask.requestId}/decide`, P3.PAY_APPROVER, { decision: 'approved', reason: 'checked' })).status).toBe(201);
      await page.click('#pay-asks-show');
      await says(page, '#pay-asks', /approved — ready to record/);
      await says(page, '#pay-asks', /settles inv-a/);
      await askedThenConfirmed(page, async () => { await page.click('#pay-asks .pay-record'); }, /₹500\.00 paid to .*sup-1.* will be recorded/, sent);
      await says(page, '#pay-status', /^Recorded\./);
      expect(p.writes.filter((w) => /^POST \/v1\/purchase\/suppliers\/sup-1\/payments\//.test(w))).toHaveLength(1);
      expect(p.errors).toEqual([]);
    } finally { await p.close(); }

    // The bank's statement: the ₹500 debit naming NEFT-77001.
    const csv = ['Date,Reference,Narrative,Debit,Credit', `${ddmm},NEFT-77001,SAKTHI TRADERS,500.00,`, `${ddmm},CHQ9,Rent,100.00,`].join('\n');
    const imported = await shop.call('POST', '/v1/finance/bank-statements', ACCT, { statementId: 'BANK-U7', accountRef: 'current-1', fromDate: day, toDate: day, openingMinor: 1_000_000, closingMinor: 1_000_000 - 50_000 - 10_000, sourceName: 'u7.csv', csv });
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    const bank = await shop.open(P3.MATCHER, '/bank-reconciliation');
    try {
      await says(bank.page, '#lines', /Supplier payment · .*sup-1.* · ref NEFT-77001/);
      await says(bank.page, '#lines', /Unmatched/);
      expect(bank.writes).toEqual([]);
      expect(bank.errors).toEqual([]);
    } finally { await bank.close(); }
  });
});
