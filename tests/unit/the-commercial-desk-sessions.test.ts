import { describe, it, expect } from 'vitest';
import { createB2BDeskSession, contractBodyOf, quoteLinesOf, pricesOf, paiseOfRupees, B2B_DESK_COPY, b2bDeskOutcomeWords } from '../../apps/web-erp/src/b2b-desk-session';
import { createSupplierSubmissionsSession, documentLine, SUPPLIER_SUBMISSIONS_COPY } from '../../apps/web-erp/src/supplier-submissions-session';
import { createConcessionSession, concessionContractOf, CONCESSION_COPY, concessionOutcomeWords } from '../../apps/web-erp/src/concession-session';
import { actionDetails } from '../../services/identity/src/approval-requests';

// OB-288 commercial desks — the three office screens' tested sessions: what each sends (exact paths and bodies), what each
// refuses before any request, that an approval is asked with EXACTLY the body the action then sends, and that every word
// has a Tamil twin.

type Asked = { method: string; path: string; body: Record<string, unknown> };
function recorder(reply: unknown = {}, status = 200): { asked: Asked[]; fetch: typeof globalThis.fetch } {
  const asked: Asked[] = [];
  const fetch = (async (path: string, init?: { method?: string; body?: string }) => {
    asked.push({ method: init?.method ?? 'GET', path: String(path), body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> });
    return new Response(JSON.stringify(reply), { status });
  }) as unknown as typeof globalThis.fetch;
  return { asked, fetch };
}
let n = 0;
const makeId = (prefix: string): string => `${prefix}-${++n}`;

describe('Business customers (M22)', () => {
  const DESK = { userId: 'u-mgr', permissions: ['b2b.document.read', 'b2b.document.issue', 'b2b.contract.read', 'b2b.account.read'] };
  it('quotes with NO price (the record prices it); converts; asks the owner with exactly the order body, then makes it', async () => {
    const { asked, fetch } = recorder();
    const s = createB2BDeskSession({ viewer: DESK, fetch, makeId });
    await s.quote({ customerId: ' SCHOOL ', locationId: 'S1', lines: [{ productId: 'rice', description: 'Rice 25kg', qty: '4', taxPercent: '5' }, { productId: '', description: '', qty: '', taxPercent: '5' }], validForDays: '10' });
    expect(asked[0]).toMatchObject({ method: 'POST', path: '/v1/b2b/documents/SCHOOL/quotations/Q-1', body: { lines: [{ lineId: 'l1', productId: 'rice', description: 'Rice 25kg', qty: 4, taxRateBps: 500 }], locationId: 'S1', validForDays: 10 } });
    expect(JSON.stringify(asked[0]!.body)).not.toContain('unitPriceMinor');
    await s.askOverride({ customerId: 'SCHOOL', quotationId: 'Q-1', locationId: 'S1', valueMinor: 126_000, reason: '' });
    const ask = asked[1]!;
    expect(ask).toMatchObject({ path: '/v1/approvals/requests', body: { kind: 'b2b_credit_override', subjectRef: 'SCHOOL/SO-2', valueMinor: 126_000 } });
    await s.convertWithApproval({ requestId: 'req-9', kind: 'b2b_credit_override', status: 'approved', subjectRef: 'SCHOOL/SO-2', details: ask.body['details'] as Record<string, unknown> });
    expect(asked[2]).toMatchObject({ path: '/v1/b2b/documents/SCHOOL/orders/SO-2', body: { fromQuotationId: 'Q-1', locationId: 'S1', approvalId: 'req-9' } });
    // The engine fingerprints the body + path ids: the asked details are exactly what the order route will compute.
    expect(actionDetails(asked[2]!.body, { customerId: 'SCHOOL', documentId: 'SO-2' })).toEqual(ask.body['details']);
  });
  it('a contract is proposed, asked for with the same terms, and put in force with exactly what was approved', async () => {
    const { asked, fetch } = recorder();
    const s = createB2BDeskSession({ viewer: { userId: 'u-acct', permissions: ['b2b.document.read', 'b2b.contract.manage', 'b2b.contract.read'] }, fetch, makeId });
    const form = { customerId: 'SCHOOL', contractId: 'K-1', validFrom: '2026-11-01', validTo: '2027-03-31', onExpiry: 'block' as const, prices: 'rice = 1,200\ndal=90.50', limitRupees: '6000', termsDays: '30', note: '' };
    await s.proposeContract(form);
    await s.askContractApproval(form, 'new school year');
    const details = asked[1]!.body['details'] as Record<string, unknown>;
    await s.putContractInForce({ requestId: 'req-1', kind: 'b2b_contract', status: 'approved', subjectRef: 'SCHOOL/K-1', details });
    expect(asked.map((a) => `${a.method} ${a.path}`)).toEqual(['POST /v1/b2b/contracts/SCHOOL/K-1', 'POST /v1/approvals/requests', 'POST /v1/b2b/contracts/SCHOOL/K-1']);
    expect(asked[0]!.body).toEqual({ validFrom: '2026-11-01', validTo: '2027-03-31', onExpiry: 'block', prices: [{ productId: 'rice', priceMinor: 120_000 }, { productId: 'dal', priceMinor: 9_050 }], creditLimitMinor: 600_000, paymentTermsDays: 30 });
    expect(asked[2]!.body).toEqual({ ...asked[0]!.body, approvalId: 'req-1' });
    expect(actionDetails(asked[2]!.body, { customerId: 'SCHOOL', contractId: 'K-1' })).toEqual(details);
  });
  it('refuses before any request', async () => {
    const { asked, fetch } = recorder();
    const s = createB2BDeskSession({ viewer: DESK, fetch, makeId });
    expect(await s.quote({ customerId: '', locationId: 'S1', lines: [], validForDays: '' })).toEqual({ result: 'invalid', why: 'needCustomer' });
    expect(await s.quote({ customerId: 'X', locationId: '', lines: [], validForDays: '' })).toEqual({ result: 'invalid', why: 'needStore' });
    expect(await s.quote({ customerId: 'X', locationId: 'S1', lines: [{ productId: 'rice', description: 'r', qty: '1.5', taxPercent: '5' }], validForDays: '' })).toEqual({ result: 'invalid', why: 'needLines' });
    expect(await s.challan('X', 'SO-1', { l1: '' })).toEqual({ result: 'invalid', why: 'needDispatched' });
    expect(await s.recordPayment('X', 'ten')).toEqual({ result: 'invalid', why: 'needMoney' });
    expect(await createB2BDeskSession({ viewer: undefined, fetch }).quote({ customerId: 'X', locationId: 'S1', lines: [], validForDays: '' })).toEqual({ result: 'invalid', why: 'nobody' });
    expect(asked).toEqual([]);
  });
  it('reads the form helpers exactly', () => {
    expect(paiseOfRupees('₹1,250.5')).toBe(125_050);
    expect(paiseOfRupees('12.345')).toBeUndefined();
    expect(pricesOf('rice=10\nbad line')).toBeUndefined();
    expect(contractBodyOf({ customerId: 'C', contractId: '', validFrom: '2026-12-01', validTo: '2026-11-01', onExpiry: 'block', prices: 'a=1', limitRupees: '', termsDays: '', note: '' })).toBe('needDates');
    expect(quoteLinesOf([{ productId: 'a', description: 'A', qty: '2', taxPercent: '' }])).toBeUndefined();
  });
  it('says a switched-off feature in plain words, and every English word has a Tamil twin', () => {
    expect(b2bDeskOutcomeWords('en', { result: 'refused', status: 403, code: 'feature_not_entitled', whatHappened: 'x' })).toBe(B2B_DESK_COPY.en.offFeature);
    expect(Object.keys(B2B_DESK_COPY.ta).sort()).toEqual(Object.keys(B2B_DESK_COPY.en).sort());
  });
});

describe('Supplier submissions (M24)', () => {
  it('a decision always carries a reason, and names the partner and submission in the path', async () => {
    const { asked, fetch } = recorder();
    const s = createSupplierSubmissionsSession({ viewer: { userId: 'u-buyer', permissions: ['supplier.portal.review'] }, fetch });
    const row = { partnerId: 'sup-a', submissionId: 'sub 1', kind: 'claim', receivedAt: 'x', submittedBy: null, document: null, feeds: null };
    expect(await s.decide(row, 'reject', '  ')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(await s.readDelivery(' ')).toEqual({ result: 'invalid', why: 'needPo' });
    expect(asked).toEqual([]);
    await s.decide(row, 'reject', ' all twelve received ');
    await s.readDelivery('po-a');
    expect(asked).toEqual([
      { method: 'POST', path: '/v1/supplier-portal/partners/sup-a/submissions/sub%201/review', body: { decision: 'reject', reason: 'all twelve received' } },
      { method: 'GET', path: '/v1/supplier-portal/orders/po-a/delivery-status', body: {} },
    ]);
  });
  it('says what a document is in one line; every English word has a Tamil twin', () => {
    expect(documentLine({ partnerId: 'p', submissionId: 's', kind: 'invoice', receivedAt: 'x', submittedBy: null, feeds: null, document: { invoiceId: 'INV-9', declaredTotalMinor: 21_600, poId: 'po-a' } })).toBe('INV-9 · ₹216.00 · PO po-a');
    expect(Object.keys(SUPPLIER_SUBMISSIONS_COPY.ta).sort()).toEqual(Object.keys(SUPPLIER_SUBMISSIONS_COPY.en).sort());
  });
});

describe('Concessions (M27 · OB-304)', () => {
  const ACCT = { userId: 'u-acct', permissions: ['concession.charge.read', 'concession.contract.manage'] };
  const form = { contractId: 'C-J', concessionaireId: 'JEWEL', name: 'Jewellery counter', branchId: 'BR1', startsOn: '2026-11-01', endsOn: '2027-10-31', basis: 'higher_of_both', rentRupees: '5,000', sharePercent: '15', utilitiesRupees: '', depositRupees: '10000', insuranceUntil: '2027-06-30', licenceUntil: '' };
  it('records, asks with exactly the body, and puts in force with what was approved', async () => {
    const { asked, fetch } = recorder();
    const s = createConcessionSession({ viewer: ACCT, fetch, makeId });
    await s.saveContract(form);
    await s.askContractApproval(form);
    const details = asked[1]!.body['details'] as Record<string, unknown>;
    await s.putInForce({ requestId: 'req-2', kind: 'concession_contract', status: 'approved', subjectRef: 'C-J', details });
    expect(asked[0]!.body).toEqual({ concessionaireId: 'JEWEL', name: 'Jewellery counter', branchId: 'BR1', startsOn: '2026-11-01', endsOn: '2027-10-31', basis: 'higher_of_both', depositMinor: 1_000_000, fixedRentMinor: 500_000, revenueShareBps: 1_500, insuranceUntil: '2027-06-30' });
    expect(asked[2]).toMatchObject({ path: '/v1/concession/contracts/C-J', body: { ...asked[0]!.body, approvalId: 'req-2' } });
    expect(actionDetails(asked[2]!.body, { contractId: 'C-J' })).toEqual(details);
  });
  it('a forfeit is only ever asked for, then made with the approval; reads take a window; refusals before any request', async () => {
    const { asked, fetch } = recorder();
    const s = createConcessionSession({ viewer: ACCT, fetch, makeId });
    expect(concessionContractOf({ ...form, basis: 'revenue_share', sharePercent: '' })).toBe('needContract');
    expect(await s.readCharge('', '2026-11-01', '2026-11-30', '')).toEqual({ result: 'invalid', why: 'needPick' });
    expect(await s.readSettlement('C-J', '2026-11-01', '', '100')).toEqual({ result: 'invalid', why: 'needWindow' });
    expect(await s.recordDeposit('JEWEL', 'received', '0')).toEqual({ result: 'invalid', why: 'needMoney' });
    expect(asked).toEqual([]);
    await s.askForfeit('JEWEL', '2500');
    const ask = asked[0]!;
    expect(ask.body).toMatchObject({ kind: 'concession_deposit_forfeit', valueMinor: 250_000 });
    await s.forfeitWithApproval({ requestId: 'req-3', kind: 'concession_deposit_forfeit', status: 'approved', subjectRef: String(ask.body['subjectRef']), details: ask.body['details'] as Record<string, unknown> });
    const d = ask.body['details'] as { concessionaireId: string; movementId: string };
    expect(actionDetails(asked[1]!.body, { concessionaireId: d.concessionaireId, movementId: d.movementId })).toEqual(ask.body['details']);
    await s.readSettlement('C-J', '2026-11-01', '2026-11-30', '1,00,000');
    expect(asked[2]!.path).toBe('/v1/concession/contracts/C-J/settlement?from=2026-11-01&to=2026-11-30&bankedForThemMinor=10000000');
  });
  it('says the feature is off (OB-304) in plain words; every English word has a Tamil twin', () => {
    expect(concessionOutcomeWords('ta', { result: 'refused', status: 403, code: 'feature_not_entitled', whatHappened: 'x' })).toBe(CONCESSION_COPY.ta.off);
    expect(Object.keys(CONCESSION_COPY.ta).sort()).toEqual(Object.keys(CONCESSION_COPY.en).sort());
  });
});
