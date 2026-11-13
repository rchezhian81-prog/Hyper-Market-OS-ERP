import { describe, it, expect } from 'vitest';
import { createSupplierClaimsSession, SUPPLIER_CLAIMS_COPY, creditStateTone, disputeTone, disputeStateKey, DISPUTE_OUTCOMES } from '../../apps/web-erp/src/supplier-claims-session';
import { DISPUTE_OUTCOMES as SERVICE_OUTCOMES } from '../../services/purchase/src/supplier-claims';
import { createSupplierPaymentSession, paymentBody, billsOf, SUPPLIER_PAYMENT_COPY } from '../../apps/web-erp/src/supplier-payment-session';
import { createBankReconciliationSession, BANK_RECONCILIATION_COPY } from '../../apps/web-erp/src/bank-reconciliation-session';

/**
 * **U7 · OB-723 · OB-724 · M24-FR-02 alt — the pages' tested, DOM-free sessions.**
 *   • Supplier claims: approving / refusing a draft credit needs `purchase.supplier.pay`, is refused before any request for
 *     the buyer who ACCEPTED the claim (or whoever sent it) and without a reason, and calls the credit route; settling a
 *     disputed claim needs `supplier.portal.review`, one of head office's outcomes and a reason; tones; Tamil twins.
 *   • Supplier payment: the bills a payment settles are read from what was typed (trimmed, no blanks, no repeats) and sent.
 *   • Bank reconciliation: a line matched to a supplier payment is read as such; its words have Tamil twins.
 */
type Sent = { method: string; url: string; body?: unknown };
function fakeFetch(status = 201, body: unknown = { ok: true }) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ method: init?.method ?? 'GET', url: String(url), ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }) });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const draft = { supplierId: 's-1', submissionId: 'c-1', acceptedBy: 'u-buyer', submittedBy: 'u-sup' };

describe('U7 · the supplier claims session — draft credits and disputed claims', () => {
  it('a credit is decided by someone who may pay suppliers and did not accept the claim, with a reason', async () => {
    const { fetch, sent } = fakeFetch();
    const buyer = createSupplierClaimsSession({ viewer: { userId: 'u-buyer', permissions: ['purchase.commitment.read', 'supplier.portal.review', 'purchase.supplier.pay'] }, fetch, newKey: () => 'k' });
    expect(buyer.whyNotCredit(draft)).toBe('sameAccepter');
    expect(await buyer.decideCredit(draft, 'approve', 'ok')).toEqual({ result: 'invalid', why: 'sameAccepter' });
    const manager = createSupplierClaimsSession({ viewer: { userId: 'u-mgr', permissions: ['purchase.commitment.read', 'supplier.portal.review'] }, fetch });
    expect(manager.whyNotCredit(draft)).toBe('cannotCredit');
    expect(await manager.decideCredit(draft, 'approve', 'ok')).toEqual({ result: 'invalid', why: 'cannotCredit' });
    const nobody = createSupplierClaimsSession({ viewer: undefined, fetch });
    expect(nobody.whyNotCredit(draft)).toBe('nobody');
    const acct = createSupplierClaimsSession({ viewer: { userId: 'u-acct', permissions: ['purchase.commitment.read', 'purchase.supplier.pay'] }, fetch, newKey: () => 'k' });
    expect(acct.may).toMatchObject({ credit: true, settle: false });
    expect(acct.whyNotCredit(draft)).toBe('');
    expect(await acct.decideCredit(draft, 'refuse', '   ')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(sent).toEqual([]);
    expect((await acct.decideCredit(draft, 'approve', ' freight receipt seen ')).result).toBe('ok');
    expect(sent).toEqual([{ method: 'POST', url: '/v1/purchase/supplier-claims/credits/s-1/c-1', body: { decision: 'approve', reason: 'freight receipt seen' } }]);
  });

  it('a disputed claim is settled by someone who may review supplier claims, with an outcome head office knows and a reason', async () => {
    const { fetch, sent } = fakeFetch();
    const acct = createSupplierClaimsSession({ viewer: { userId: 'u-acct', permissions: ['purchase.commitment.read', 'purchase.supplier.pay'] }, fetch });
    expect(await acct.settleDispute({ supplierId: 's-1', submissionId: 'c-2' }, 'supplier_withdrew', 'ok')).toEqual({ result: 'invalid', why: 'cannotSettle' });
    const mgr = createSupplierClaimsSession({ viewer: { userId: 'u-mgr', permissions: ['purchase.commitment.read', 'supplier.portal.review'] }, fetch, newKey: () => 'k' });
    expect(await mgr.settleDispute({ supplierId: 's-1', submissionId: 'c-2' }, '', 'ok')).toEqual({ result: 'invalid', why: 'needOutcome' });
    expect(await mgr.settleDispute({ supplierId: 's-1', submissionId: 'c-2' }, 'other', ' ')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(sent).toEqual([]);
    expect((await mgr.settleDispute({ supplierId: 's-1', submissionId: 'c-2' }, 'shop_position_upheld', 'paid in full on 2 Nov')).result).toBe('ok');
    expect(sent).toEqual([{ method: 'POST', url: '/v1/purchase/supplier-claims/disputes/s-1/c-2/resolve', body: { outcome: 'shop_position_upheld', reason: 'paid in full on 2 Nov' } }]);
  });

  it('the page offers exactly head office\'s outcomes; tones and state words; every word has a Tamil twin', () => {
    expect([...DISPUTE_OUTCOMES]).toEqual([...SERVICE_OUTCOMES]);
    expect([creditStateTone('draft'), creditStateTone('approved'), creditStateTone('refused')]).toEqual(['pending', 'ok', 'idle']);
    expect([disputeTone({ state: 'open', overdue: false }), disputeTone({ state: 'open', overdue: true }), disputeTone({ state: 'resolved', overdue: false })]).toEqual(['pending', 'error', 'ok']);
    expect(disputeStateKey({ state: 'open', overdue: true })).toBe('dispute_overdue');
    expect(Object.keys(SUPPLIER_CLAIMS_COPY.ta).sort()).toEqual(Object.keys(SUPPLIER_CLAIMS_COPY.en).sort());
    for (const k of [...DISPUTE_OUTCOMES.map((o) => `outcome_${o}`), 'credit_draft', 'credit_approved', 'credit_refused', 'dispute_open', 'dispute_overdue', 'dispute_resolved', 'sameAccepter', 'cannotCredit', 'cannotSettle', 'needOutcome']) {
      expect((SUPPLIER_CLAIMS_COPY.ta as Record<string, string>)[k], k).toBeTruthy();
      expect((SUPPLIER_CLAIMS_COPY.ta as Record<string, string>)[k], k).not.toBe((SUPPLIER_CLAIMS_COPY.en as Record<string, string>)[k]);
    }
  });
});

describe('U7 · the supplier payment session — the bills a payment settles', () => {
  it('reads the bills typed, and sends them with the payment it asks approval for', async () => {
    expect(billsOf(' inv-a, inv-b ,, inv-a  inv-c')).toEqual(['inv-a', 'inv-b', 'inv-c']);
    expect(billsOf(undefined)).toEqual([]);
    const base = { supplierId: 'sup-1', amountRupees: '500', paidOn: '2026-11-12', method: 'bank_transfer', reference: 'NEFT-1' };
    expect(paymentBody(base)).toEqual({ amountMinor: 50_000, paidOn: '2026-11-12', method: 'bank_transfer', reference: 'NEFT-1' });
    expect(paymentBody({ ...base, settles: 'inv-a, inv-b' })).toMatchObject({ settles: ['inv-a', 'inv-b'] });
    const { fetch, sent } = fakeFetch(201, { requestId: 'rq-1' });
    const s = createSupplierPaymentSession({ viewer: { userId: 'u-pay', permissions: ['purchase.supplier.pay'] }, fetch, newKey: () => 'k', newId: () => 'pay-1' });
    expect((await s.ask({ ...base, settles: 'inv-a' })).result).toBe('ok');
    expect(sent[0]!.body).toMatchObject({ kind: 'supplier_payment', subjectRef: 'sup-1/pay-1', details: { settles: ['inv-a'], reference: 'NEFT-1', supplierId: 'sup-1', paymentId: 'pay-1' } });
    expect(Object.keys(SUPPLIER_PAYMENT_COPY.ta).sort()).toEqual(Object.keys(SUPPLIER_PAYMENT_COPY.en).sort());
  });
});

describe('U7 · the bank reconciliation session — a line matched to a supplier payment', () => {
  it('reads the supplier payment match; its words have Tamil twins', async () => {
    const { fetch } = fakeFetch(200, { statements: [{ statementId: 'S1' }], statement: { statementId: 'S1' }, lines: [{ lineId: 'S1:1', date: '2026-11-12', amountMinor: -50_000, reference: 'NEFT-1', match: { kind: 'supplier_payment', paymentId: 'pay-1', supplierId: 'sup-1', reference: 'NEFT-1', paidOn: '2026-11-12' } }], totals: { lines: 1, matched: 1 }, statementAddsUp: true, exceptions: [], asAt: 'now' });
    const s = createBankReconciliationSession({ viewer: { userId: 'u-acct', permissions: ['settlement.review.read'] }, fetch });
    const out = await s.read();
    expect(out.result).toBe('ok');
    if (out.result === 'ok') expect(out.value.lines[0]!.match).toEqual({ kind: 'supplier_payment', paymentId: 'pay-1', supplierId: 'sup-1', reference: 'NEFT-1', paidOn: '2026-11-12' });
    expect((BANK_RECONCILIATION_COPY.ta as Record<string, string>)['supplier_payment']).toBeTruthy();
    expect(Object.keys(BANK_RECONCILIATION_COPY.ta).sort()).toEqual(Object.keys(BANK_RECONCILIATION_COPY.en).sort());
  });
});
