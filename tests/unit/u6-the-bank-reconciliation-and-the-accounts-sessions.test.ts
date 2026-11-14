import { describe, it, expect } from 'vitest';
import { createBankReconciliationSession, bankReconciliationOutcomeWords, BANK_RECONCILIATION_COPY, EXCEPTION_OUTCOMES } from '../../apps/web-erp/src/bank-reconciliation-session';
import { createPayablesReceivablesSession, payablesReceivablesOutcomeWords, PAYABLES_RECEIVABLES_COPY, journalAmountMinor } from '../../apps/web-erp/src/payables-receivables-session';

/**
 * **U6: the two finance pages' sessions (DOM-free): what each role may do, what is sent to head office and what is refused
 * before any call; every word in both languages (OB-699).**
 */
function fakeFetch(answers: Record<string, { status: number; body: unknown }>) {
  const sent: { method: string; url: string; body?: unknown }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    sent.push({ method, url, ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) });
    const key = `${method} ${url.split('?')[0]}`;
    const a = answers[key] ?? answers[`${method} *`] ?? { status: 404, body: { error: { code: 'not_found', whatHappened: 'no such route', wasItSaved: 'not_saved', nextSafeAction: 'check the path' } } };
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const ACCT = { userId: 'u-acct', permissions: ['settlement.review.read', 'settlement.investigation.manage', 'finance.period.read', 'finance.journal.post'] };
const MGR = { userId: 'u-mgr', permissions: ['settlement.review.read', 'finance.period.read'] };

describe('the bank reconciliation session', () => {
  it('every word has a Tamil twin; the outcomes are the five head office knows', () => {
    expect(Object.keys(BANK_RECONCILIATION_COPY.ta).sort()).toEqual(Object.keys(BANK_RECONCILIATION_COPY.en).sort());
    for (const k of Object.keys(BANK_RECONCILIATION_COPY.en)) expect((BANK_RECONCILIATION_COPY.ta as Record<string, string>)[k], k).not.toBe('');
    expect([...EXCEPTION_OUTCOMES]).toEqual(['matched_by_hand', 'bank_error', 'not_ours', 'timing', 'other']);
    for (const o of EXCEPTION_OUTCOMES) expect((BANK_RECONCILIATION_COPY.ta as Record<string, string>)[o]).toBeTruthy();
  });

  it('reads the chosen statement, folds the lines and their matches; a manager may read but not raise; nobody signed in is told so', async () => {
    const { fetch, sent } = fakeFetch({ 'GET /v1/finance/bank-reconciliation': { status: 200, body: { statements: [{ statementId: 'S1' }], statement: { statementId: 'S1' }, lines: [{ lineId: 'S1:1', date: '2026-09-03', amountMinor: 100, reference: 'X', match: { kind: 'provider_payout', batchId: 'PB', providerId: 'acq', declaredNetMinor: 100 } }, { lineId: 'S1:2', date: '2026-09-04', amountMinor: -5, reference: 'Y', match: { kind: 'nonsense' } }], totals: { lines: 2, unmatched: 1 }, statementAddsUp: true, exceptions: [], asAt: 'now' } } });
    const s = createBankReconciliationSession({ viewer: MGR, fetch });
    expect(s.may).toEqual({ named: true, read: true, manage: false });
    const r = await s.read(' S1 ');
    expect(sent[0]!.url).toBe('/v1/finance/bank-reconciliation?statementId=S1');
    expect(r.result === 'ok' && r.value.lines.map((l) => l.match.kind)).toEqual(['provider_payout', 'unmatched']);
    expect(await s.raise({ statementId: 'S1', lineId: 'S1:2', ownerUserId: 'u-acct' })).toEqual({ result: 'invalid', why: 'cannotManage' });
    expect(sent).toHaveLength(1);
    const nobody = createBankReconciliationSession({ viewer: undefined, fetch });
    expect(await nobody.read()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(bankReconciliationOutcomeWords('ta', { result: 'invalid', why: 'nobody' })).toBe(BANK_RECONCILIATION_COPY.ta.nobody);
  });

  it('raises with a fresh id under a fresh idempotency key and resolves with outcome + reason; refuses the cheap things before any POST; head office\'s refusal comes back in the three-part words', async () => {
    const { fetch, sent } = fakeFetch({ 'POST /v1/finance/bank-reconciliation/exceptions/bx-1': { status: 201, body: { exception: { exceptionId: 'bx-1' }, alreadyRaised: false } }, 'POST /v1/finance/bank-reconciliation/exceptions/bx-1/resolve': { status: 409, body: { error: { code: 'already', whatHappened: 'It is resolved.', wasItSaved: 'not_saved', nextSafeAction: 'Read it again.' } } } });
    const s = createBankReconciliationSession({ viewer: ACCT, fetch, newId: () => 'bx-1' });
    expect(await s.raise({ statementId: 'S1', lineId: '', ownerUserId: 'u-acct' })).toEqual({ result: 'invalid', why: 'needLine' });
    expect(await s.raise({ statementId: 'S1', lineId: 'S1:2', ownerUserId: ' ' })).toEqual({ result: 'invalid', why: 'needOwner' });
    expect(await s.resolve('bx-1', { outcome: 'wrong', reason: 'x' })).toEqual({ result: 'invalid', why: 'needOutcome' });
    expect(await s.resolve('bx-1', { outcome: 'bank_error', reason: '  ' })).toEqual({ result: 'invalid', why: 'needReason' });
    expect(sent).toHaveLength(0);
    expect(await s.raise({ statementId: 'S1', lineId: 'S1:2', ownerUserId: 'u-acct', note: ' no bill ' })).toEqual({ result: 'ok', value: { exceptionId: 'bx-1', alreadyRaised: false } });
    expect(sent[0]).toMatchObject({ method: 'POST', url: '/v1/finance/bank-reconciliation/exceptions/bx-1', body: { statementId: 'S1', lineId: 'S1:2', ownerUserId: 'u-acct', note: 'no bill' } });
    const refused = await s.resolve('bx-1', { outcome: 'matched_by_hand', reason: 'rent', matchedTo: 'RENT-09' });
    expect(refused.result).toBe('refused');
    expect(sent[1]).toMatchObject({ body: { outcome: 'matched_by_hand', reason: 'rent', matchedTo: 'RENT-09' } });
    const words = bankReconciliationOutcomeWords('en', refused);
    expect(words).toMatch(/^Head office refused: It is resolved\./); expect(words).toMatch(/Nothing was (changed|saved)/);
  });
});

describe('the payables and receivables session', () => {
  it('every word has a Tamil twin', () => {
    expect(Object.keys(PAYABLES_RECEIVABLES_COPY.ta).sort()).toEqual(Object.keys(PAYABLES_RECEIVABLES_COPY.en).sort());
  });

  it('reads both accounts with their honest defaults; a reader without the posting right is kept from posting before any call; the post is sent once with a body and folded', async () => {
    const { fetch, sent } = fakeFetch({
      'GET /v1/finance/payables': { status: 200, body: { journals: [{ entryId: 'j1', lines: [{ accountCode: 'A', debitMinor: 500, creditMinor: 0 }, { accountCode: 'B', debitMinor: 0, creditMinor: 500 }] }], exceptions: [], open: 0, reconciliation: { controlAccount: null, suppliers: [{ supplierId: 's-1', registerOwedMinor: 500, ledgerOwedMinor: 0, differenceMinor: 500, agrees: false, unposted: [{}] }], registerOwedMinor: 500, ledgerOwedMinor: 0, differenceMinor: 500, agrees: false }, asAt: 'now' } },
      'GET /v1/finance/receivables': { status: 200, body: { asAt: '2026-09-30', customers: [], totals: {}, agrees: null, leftDerivation: 'L', rightDerivation: 'R' } },
      'POST /v1/finance/payables/post': { status: 201, body: { planned: 1, journals: [{}], exceptions: [] } },
    });
    const reader = createPayablesReceivablesSession({ viewer: MGR, fetch });
    expect(reader.may).toEqual({ named: true, read: true, post: false });
    expect(await reader.post()).toEqual({ result: 'invalid', why: 'cannotPost' });
    const ap = await reader.payables();
    expect(ap.result === 'ok' && ap.value.reconciliation.suppliers[0]).toMatchObject({ supplierId: 's-1', agrees: false });
    expect(ap.result === 'ok' && journalAmountMinor(ap.value.journals[0]!)).toBe(500);
    const ar = await reader.receivables();
    expect(ar.result === 'ok' && [ar.value.totals.customers, ar.value.agrees, ar.value.leftDerivation]).toEqual([0, null, 'L']);
    const acct = createPayablesReceivablesSession({ viewer: ACCT, fetch });
    expect(await acct.post()).toEqual({ result: 'ok', value: { journals: 1, exceptions: 0, planned: 1 } });
    const posts = sent.filter((x) => x.method === 'POST');
    expect(posts).toHaveLength(1); expect(posts[0]!.body).toEqual({});
    expect(payablesReceivablesOutcomeWords('ta', { result: 'lost_link' })).toBe(PAYABLES_RECEIVABLES_COPY.ta.unreachable);
  });
});
