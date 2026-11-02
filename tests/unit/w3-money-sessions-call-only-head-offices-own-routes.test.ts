import { describe, it, expect } from 'vitest';
import { createSettlementSession, SETTLEMENT_COPY, signedPaiseOf, settlementOutcomeWords } from '../../apps/web-erp/src/settlement-bank-session';
import { createRebateAccrualsSession, REBATE_ACCRUAL_COPY, accrualIdOf } from '../../apps/web-erp/src/rebate-accruals-session';
import { createLiabilitiesSession, LIABILITIES_COPY } from '../../apps/web-erp/src/liabilities-session';
import { REBATES_COPY } from '../../apps/web-erp/src/rebates-session';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';
import { HEAD_OFFICE_PAGE_SCREENS, HEAD_OFFICE_PAGE_GLOBALS } from '../../edge/store-edge/src/head-office-pages';

/**
 * **W3 (money) — M23-FR-03 Card, UPI and bank · D03-FR-03 / D10-FR-04 rebate accruals · D10-FR-04 owed to customers.** Each
 * session is a thin client over head office's own routes: proven against a stand-in, it calls only those routes with the
 * bodies they read; a person nobody named, or a role without the word, is refused before any call; a form that does not
 * read is refused by name before any call; a typed figure is never sent where head office folds it; the page is on the
 * menu and served by the store computer; every word has a Tamil twin.
 */

interface Call { readonly url: string; readonly method: string; readonly body: unknown; readonly key: string | null }
function headOffice(answer: (url: string, method: string) => { status: number; body: unknown } | 'throw' = () => ({ status: 200, body: {} })) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown, key: headers['idempotency-key'] ?? null });
    const a = answer(String(input), init?.method ?? 'GET');
    if (a === 'throw') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const TAMIL = /[஀-௿]/;
const ACCT = { userId: 'u-acct', permissions: ['settlement.review.read', 'settlement.batch.import', 'settlement.investigation.manage', 'payment.dispute.read', 'payment.dispute.record'] };
const EXC = { finding: 'overdue_settlement', ref: 'PAY-2', valueMinor: 50_000, needsInvestigation: true, detail: 'late' };

describe('every word has a Tamil twin', () => {
  for (const [name, copy] of [['settlement', SETTLEMENT_COPY], ['rebate accruals', REBATE_ACCRUAL_COPY], ['owed to customers', LIABILITIES_COPY]] as const) {
    it(name, () => {
      expect(Object.keys(copy.ta).sort()).toEqual(Object.keys(copy.en).sort());
      for (const v of Object.values(copy.ta)) expect(v === 'UPI' || TAMIL.test(v), v).toBe(true);
    });
  }
  it('the Rebates page no longer points at a supplier screen that does not exist (P-08)', () => {
    expect(REBATES_COPY.en.noAccruals).not.toMatch(/supplier screen/);
    expect(REBATES_COPY.en.noAccruals).toMatch(/Measure what a scheme earned/);
  });
});

describe('Card, UPI and bank — the session', () => {
  it('loads the files, records a deposit, reviews, works a case and a dispute — only through head office\'s routes', async () => {
    const ho = headOffice();
    const s = createSettlementSession({ viewer: ACCT, fetch: ho.fetch, newCaseId: () => 'inv-1', newDepositId: () => 'dep-1' });
    expect(s.may).toEqual({ named: true, read: true, import: true, investigate: true, disputes: true, recordDispute: true });
    await s.importBatch(JSON.stringify({ batchId: 'PB-1', lines: [] }), ' pb.json ');
    await s.importStatement({ statementId: ' S-1 ', accountRef: 'HDFC-1', fromDate: '2026-09-01', toDate: '2026-09-30', openingRupees: '-1,000.50', closingRupees: '2000', csv: 'Date,Reference,Debit,Credit', sourceName: 'x.csv' });
    await s.recordDeposit({ depositedOn: '2026-09-05', amountRupees: '₹25,000', slipRef: ' DS-1 ', accountRef: 'HDFC-1', note: '' });
    await s.cancelDeposit('dep-1', ' wrong ');
    await s.review('2026-09-10', '2');
    await s.cases('2026-09-10');
    await s.openCase(EXC, ' u-acct ', '2026-12-31');
    await s.addEvidence('inv-1', ' mail ');
    await s.resolve('inv-1', 'timing_only', ' paid later ');
    await s.disputes('2026-11-02');
    await s.recordDispute({ disputeId: 'D-1', instrument: 'card', providerRef: 'CASE-1', amountRupees: '500', receivedOn: '2026-10-25', respondBy: '2026-11-05', reason: 'not received', saleId: '' });
    await s.answer('D-1', '2026-10-28', 'PACK-1');
    await s.decide('D-1', 'lost', '2026-11-01');
    expect(ho.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /v1/settlement/batches', 'POST /v1/finance/bank-statements', 'POST /v1/finance/cash-deposits/dep-1', 'POST /v1/finance/cash-deposits/dep-1/cancel',
      'GET /v1/settlement/review?date=2026-09-10&cycleDays=2', 'GET /v1/settlement/investigations?date=2026-09-10', 'POST /v1/settlement/investigations',
      'POST /v1/settlement/investigations/inv-1/evidence', 'POST /v1/settlement/investigations/inv-1/resolve', 'GET /v1/finance/payment-disputes?asOf=2026-11-02',
      'POST /v1/finance/payment-disputes/D-1', 'POST /v1/finance/payment-disputes/D-1/response', 'POST /v1/finance/payment-disputes/D-1/outcome',
    ]);
    expect(ho.calls[0]!.body).toEqual({ batchId: 'PB-1', lines: [], sourceName: 'pb.json' });
    expect(ho.calls[1]!.body).toMatchObject({ statementId: 'S-1', openingMinor: -100_050, closingMinor: 200_000 });
    expect(ho.calls[2]!.body).toEqual({ depositedOn: '2026-09-05', amountMinor: 2_500_000, slipRef: 'DS-1', accountRef: 'HDFC-1' });
    expect(ho.calls[6]!.body, 'the exception is sent exactly as the review gave it').toEqual({ investigationId: 'inv-1', exception: EXC, ownerId: 'u-acct', dueBy: '2026-12-31' });
    expect(ho.calls[10]!.body).toEqual({ instrument: 'card', providerRef: 'CASE-1', amountMinor: 50_000, receivedOn: '2026-10-25', reason: 'not received', respondBy: '2026-11-05' });
    expect(ho.calls.filter((c) => c.method === 'POST').every((c) => c.key !== null && c.key.startsWith('settlement-'))).toBe(true);
    expect(new Set(ho.calls.filter((c) => c.method === 'POST').map((c) => c.key)).size).toBe(10);
  });

  it('refuses before any call: nobody named, a role without the word, a form that does not read', async () => {
    const ho = headOffice();
    const nobody = createSettlementSession({ viewer: undefined, fetch: ho.fetch });
    expect(await nobody.review('2026-09-10', '2')).toEqual({ result: 'invalid', why: 'nobody' });
    const reader = createSettlementSession({ viewer: { userId: 'u-m', permissions: ['settlement.review.read'] }, fetch: ho.fetch });
    expect(await reader.importBatch('{}', '')).toEqual({ result: 'invalid', why: 'cannotImport' });
    expect(await reader.openCase(EXC, 'u', '2026-12-31')).toEqual({ result: 'invalid', why: 'cannotInvestigate' });
    expect(await reader.disputes('')).toEqual({ result: 'invalid', why: 'cannotDisputes' });
    const s = createSettlementSession({ viewer: ACCT, fetch: ho.fetch });
    expect(await s.importBatch('', '')).toEqual({ result: 'invalid', why: 'needBatch' });
    expect(await s.importBatch('not json', '')).toEqual({ result: 'invalid', why: 'badBatch' });
    expect(await s.importBatch('[1]', '')).toEqual({ result: 'invalid', why: 'badBatch' });
    expect((await s.importStatement({ statementId: 'S', accountRef: 'A', fromDate: '2026-02-31', toDate: '2026-03-01', openingRupees: '0', closingRupees: '0', csv: 'x', sourceName: '' })).result).toBe('invalid');
    expect(await s.recordDeposit({ depositedOn: '2026-09-05', amountRupees: '0', slipRef: 'S', accountRef: 'A', note: '' })).toEqual({ result: 'invalid', why: 'needDeposit' });
    expect(await s.cancelDeposit('d', ' ')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(await s.review('10/09/2026', '2')).toEqual({ result: 'invalid', why: 'needReview' });
    expect(await s.openCase(EXC, '', '2026-12-31')).toEqual({ result: 'invalid', why: 'needCase' });
    expect(await s.resolve('i', 'closed', 'n')).toEqual({ result: 'invalid', why: 'needResolve' });
    expect(await s.recordDispute({ disputeId: 'D', instrument: 'card', providerRef: 'C', amountRupees: '5', receivedOn: '2026-10-25', respondBy: '', reason: 'r', saleId: '' })).toEqual({ result: 'invalid', why: 'needDispute' });
    expect(await s.answer('D', '2026-10-28', '')).toEqual({ result: 'invalid', why: 'needAnswer' });
    expect(ho.calls).toEqual([]);
  });

  it('head office\'s refusal is its own words; a lost line is "cannot be reached"', async () => {
    const refused = createSettlementSession({ viewer: ACCT, fetch: headOffice(() => ({ status: 422, body: { error: { code: 'duplicate_batch', whatHappened: 'PB-1 is already in.' } } })).fetch });
    expect(settlementOutcomeWords('en', await refused.importBatch('{"batchId":"PB-1"}', ''))).toBe('Head office refused: PB-1 is already in.');
    const lost = createSettlementSession({ viewer: ACCT, fetch: headOffice(() => 'throw').fetch });
    expect(settlementOutcomeWords('ta', await lost.statements())).toMatch(TAMIL);
  });

  it('a balance may be below zero; an amount is whole paise', () => {
    expect(signedPaiseOf('₹1,234.5')).toBe(123_450);
    expect(signedPaiseOf('-0.05')).toBe(-5);
    expect(signedPaiseOf('12.345')).toBeNull();
    expect(signedPaiseOf('')).toBeNull();
  });
});

describe('rebate accruals — the session', () => {
  it('measures with ONLY the period (the accrual id is the period, so measuring again replaces it), reads the books, posts', async () => {
    const ho = headOffice();
    const s = createRebateAccrualsSession({ viewer: { userId: 'u', permissions: ['purchase.contract.manage', 'finance.period.read', 'finance.journal.post'] }, fetch: ho.fetch });
    await s.measure({ schemeId: ' rb-1 ', from: '2026-01-01', to: '2026-11-02', baselineFrom: '', baselineTo: '' });
    await s.measure({ schemeId: 'rb-g', from: '2026-07-01', to: '2026-09-30', baselineFrom: '2025-07-01', baselineTo: '2025-09-30' });
    await s.books(); await s.post();
    expect(ho.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST /v1/purchase/rebate-schemes/rb-1/accruals/${accrualIdOf('2026-01-01', '2026-11-02')}`, 'POST /v1/purchase/rebate-schemes/rb-g/accruals/period-2026-07-01-to-2026-09-30',
      'GET /v1/finance/rebate-accruals', 'POST /v1/finance/rebate-accruals/post',
    ]);
    expect(ho.calls[0]!.body).toEqual({ periodFrom: '2026-01-01', periodTo: '2026-11-02' });
    expect(ho.calls[1]!.body).toEqual({ periodFrom: '2026-07-01', periodTo: '2026-09-30', baselineFrom: '2025-07-01', baselineTo: '2025-09-30' });
  });
  it('refuses before any call', async () => {
    const ho = headOffice();
    const buyer = createRebateAccrualsSession({ viewer: { userId: 'u', permissions: ['purchase.contract.manage'] }, fetch: ho.fetch });
    expect(buyer.may).toEqual({ named: true, measure: true, books: false, post: false });
    expect(await buyer.post()).toEqual({ result: 'invalid', why: 'cannotPost' });
    expect(await buyer.books()).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(await buyer.measure({ schemeId: 'rb', from: '2026-01-01', to: '', baselineFrom: '', baselineTo: '' })).toEqual({ result: 'invalid', why: 'needMeasure' });
    expect(await buyer.measure({ schemeId: 'rb', from: '2026-01-01', to: '2026-02-01', baselineFrom: '2025-01-01', baselineTo: '' })).toEqual({ result: 'invalid', why: 'needBaseline' });
    expect(await createRebateAccrualsSession({ viewer: undefined, fetch: ho.fetch }).measure({ schemeId: 'rb', from: '2026-01-01', to: '2026-02-01', baselineFrom: '', baselineTo: '' })).toEqual({ result: 'invalid', why: 'nobody' });
    expect(ho.calls).toEqual([]);
  });
});

describe('owed to customers — the session', () => {
  it('reads both liabilities and posts the referral rewards; a reader is not offered the post', async () => {
    const ho = headOffice((url) => ({ status: 200, body: url.includes('loyalty') ? { points: {}, storeCredit: {}, reconciles: true } : { register: { outstandingMinor: 0 }, account: null } }));
    const s = createLiabilitiesSession({ viewer: { userId: 'u', permissions: ['finance.period.read', 'finance.journal.post'] }, fetch: ho.fetch });
    const out = await s.read();
    expect(out.result).toBe('ok');
    await s.postReferrals();
    expect(ho.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/finance/loyalty-liability', 'GET /v1/finance/referral-liability', 'POST /v1/finance/referral-liability/post']);
    const reader = createLiabilitiesSession({ viewer: { userId: 'u', permissions: ['finance.period.read'] }, fetch: ho.fetch });
    expect(await reader.postReferrals()).toEqual({ result: 'invalid', why: 'cannotPost' });
    expect(await createLiabilitiesSession({ viewer: { userId: 'u', permissions: [] }, fetch: ho.fetch }).read()).toEqual({ result: 'invalid', why: 'cannotRead' });
  });
});

describe('the page is on the menu and served by the store computer', () => {
  it('Card, UPI and bank', () => {
    const item = ERP_NAVIGATION.find((i) => i.id === 'settlement');
    expect(item).toMatchObject({ path: '/settlement', requires: 'settlement.review.read', group: 'Finance', labelTa: 'அட்டை, UPI மற்றும் வங்கி' });
    expect(HEAD_OFFICE_PAGE_SCREENS).toContain('settlement');
    expect(HEAD_OFFICE_PAGE_GLOBALS['settlement']).toBe('settlementBankData');
  });
});
