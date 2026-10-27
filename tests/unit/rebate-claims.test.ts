import { describe, it, expect } from 'vitest';
import {
  foldRebateClaims, claimView, claimableFor, judgeRaise, judgeSend, judgeMatch, judgeWithdraw, unmatchedReceipts, rebateDaysAfter,
  type RebateClaimFact, type RebateClaim,
} from '../../packages/purchasing/src/index';
import { rebateClaimRoutes, supplierRebateClaims, type RebateClaimDeps, type RebateAnswerPeriodSetting } from '../../services/purchase/src/rebate-claims';
import type { StoredRebateAccrual } from '../../services/purchase/src/rebates';
import type { Route, RequestContext } from '../../services/kernel/src/index';

/**
 * **The rebate claim engine (D03-FR-03 · §28 · OB-404).** A claim is facts, never an edited row; what may be claimed is what
 * was earned and not received, less what open claims already ask for; a receipt answers a sent claim of its own scheme and
 * never more than either has left; and overdue is the OWNER's answer period after the day it was sent — "not set" until he
 * sets it. The route is driven with its own clock to show a claim go overdue. Synthetic data.
 */

const raised = (claimId: string, amountMinor: number, schemeId = 'rb-1'): RebateClaimFact => ({ type: 'raised', claimId, schemeId, supplierId: 'sup-1', amountMinor, raisedBy: 'u-buyer', raisedAt: '2026-10-01T09:00:00.000Z' });
const sentFact = (claimId: string, sentOn = '2026-10-02'): RebateClaimFact => ({ type: 'sent', claimId, approvalId: 'areq-1', approvedBy: 'u-fin', sentBy: 'u-buyer', sentOn, sentAt: `${sentOn}T10:00:00.000Z` });
const matched = (claimId: string, receiptId: string, amountMinor: number): RebateClaimFact => ({ type: 'matched', claimId, receiptId, amountMinor, matchedBy: 'u-fin', matchedAt: '2026-10-20T10:00:00.000Z' });
const views = (facts: readonly RebateClaimFact[], today = '2026-10-10', answerDays: number | null = 30) => [...foldRebateClaims(facts).values()].map((c) => claimView(c, { today, answerDays }));
const one = (facts: readonly RebateClaimFact[], today?: string, days?: number | null) => views(facts, today, days)[0]!;

describe('a claim is folded from its facts — states, never edits', () => {
  it('raised → sent → partly answered → answered; a withdrawal releases only what is unanswered', () => {
    expect(one([raised('c-1', 1_500)])).toMatchObject({ state: 'raised', unansweredMinor: 1_500, dueOn: null, overdue: false });
    expect(one([raised('c-1', 1_500), sentFact('c-1')])).toMatchObject({ state: 'sent', unansweredMinor: 1_500, dueOn: '2026-11-01', overdue: false });
    expect(one([raised('c-1', 1_500), sentFact('c-1'), matched('c-1', 'r1', 1_000)])).toMatchObject({ state: 'partly_answered', matchedMinor: 1_000, unansweredMinor: 500 });
    expect(one([raised('c-1', 1_500), sentFact('c-1'), matched('c-1', 'r1', 1_000), matched('c-1', 'r2', 500)])).toMatchObject({ state: 'answered', unansweredMinor: 0 });
    const w: RebateClaimFact = { type: 'withdrawn', claimId: 'c-1', reason: 'supplier refused', withdrawnBy: 'u-buyer', withdrawnAt: '2026-10-21T00:00:00.000Z' };
    expect(one([raised('c-1', 1_500), sentFact('c-1'), matched('c-1', 'r1', 1_000), w])).toMatchObject({ state: 'withdrawn', unansweredMinor: 0, releasedMinor: 500, overdue: false });
  });

  it('the first raise of a number stands; a second send, a repeated match and facts for an unknown claim change nothing', () => {
    const c = one([raised('c-1', 1_500), raised('c-1', 9_999), sentFact('c-1'), sentFact('c-1', '2026-10-05'), matched('c-1', 'r1', 100), matched('c-1', 'r1', 100), sentFact('c-ghost')]);
    expect(c).toMatchObject({ amountMinor: 1_500, sent: { sentOn: '2026-10-02' }, matchedMinor: 100 });
    expect(views([sentFact('c-ghost')])).toEqual([]);
  });
});

describe('overdue is the owner\'s answer period after the day it was sent — never a guessed number', () => {
  const facts = [raised('c-1', 1_500), sentFact('c-1', '2026-10-02')];
  it('not set → "not_set"; set → due on sent + days; overdue only once that day has passed and money is unanswered', () => {
    expect(one(facts, '2026-12-31', null)).toMatchObject({ dueOn: null, overdue: 'not_set' });
    expect(one(facts, '2026-11-01', 30)).toMatchObject({ dueOn: '2026-11-01', overdue: false });
    expect(one(facts, '2026-11-02', 30)).toMatchObject({ overdue: true });
    expect(one([...facts, matched('c-1', 'r1', 1_000)], '2026-11-02', 30)).toMatchObject({ state: 'partly_answered', overdue: true });
    expect(one([...facts, matched('c-1', 'r1', 1_500)], '2026-11-02', 30)).toMatchObject({ state: 'answered', overdue: false });
    expect(one([raised('c-1', 1_500)], '2027-01-01', null), 'a claim never sent is waiting for Finance, not overdue').toMatchObject({ overdue: false });
    expect(rebateDaysAfter('2026-12-20', 15)).toBe('2027-01-04');
  });
});

describe('the same money is never claimed twice', () => {
  it('claimable = earned − received − what open claims still ask for; a withdrawn or answered claim asks for nothing', () => {
    const v = views([raised('c-1', 1_500), raised('c-2', 400), { type: 'withdrawn', claimId: 'c-2', reason: 'x', withdrawnBy: 'u', withdrawnAt: 't' }]);
    expect(claimableFor({ accruedMinor: 2_400, receivedMinor: 0, claims: v })).toEqual({ outstandingMinor: 2_400, openClaimedMinor: 1_500, claimableMinor: 900, overClaimedMinor: 0 });
    // Money arrived that was not matched to the open claim: the claims now ask for more than is outstanding — said.
    expect(claimableFor({ accruedMinor: 2_400, receivedMinor: 1_200, claims: v })).toEqual({ outstandingMinor: 1_200, openClaimedMinor: 1_500, claimableMinor: 0, overClaimedMinor: 300 });
  });

  it('raise is refused above what may be claimed, and a number reused for another amount', () => {
    const v = views([raised('c-1', 1_500)]);
    const base = { claimId: 'c-2', schemeId: 'rb-1', accruedMinor: 2_400, receivedMinor: 0, schemeClaims: v, existing: undefined };
    expect(judgeRaise({ ...base, amountMinor: 900 })).toEqual({ ok: true, alreadyRaised: false });
    expect(judgeRaise({ ...base, amountMinor: 901 })).toMatchObject({ ok: false, status: 422, code: 'claim_exceeds_unclaimed' });
    const existing = foldRebateClaims([raised('c-1', 1_500)]).get('c-1') as RebateClaim;
    expect(judgeRaise({ ...base, claimId: 'c-1', existing, amountMinor: 1_500 })).toEqual({ ok: true, alreadyRaised: true });
    expect(judgeRaise({ ...base, claimId: 'c-1', existing, amountMinor: 1_400 })).toMatchObject({ ok: false, status: 409, code: 'claim_number_already_used' });
  });

  it('send is re-checked against what is outstanding NOW; a withdrawn claim is never sent', () => {
    const v = views([raised('c-1', 1_500)]);
    expect(judgeSend({ claim: v[0]!, accruedMinor: 2_400, receivedMinor: 0, schemeClaims: v })).toEqual({ ok: true, alreadySent: false });
    expect(judgeSend({ claim: v[0]!, accruedMinor: 2_400, receivedMinor: 1_000, schemeClaims: v })).toMatchObject({ ok: false, status: 409, code: 'claim_now_exceeds_outstanding' });
    const w = views([raised('c-1', 1_500), { type: 'withdrawn', claimId: 'c-1', reason: 'x', withdrawnBy: 'u', withdrawnAt: 't' }]);
    expect(judgeSend({ claim: w[0]!, accruedMinor: 2_400, receivedMinor: 0, schemeClaims: w })).toMatchObject({ ok: false, code: 'claim_withdrawn' });
    const s = views([raised('c-1', 1_500), sentFact('c-1')]);
    expect(judgeSend({ claim: s[0]!, accruedMinor: 0, receivedMinor: 0, schemeClaims: s })).toEqual({ ok: true, alreadySent: true });
  });
});

describe('a receipt answers a sent claim of its own scheme — never more than either has left', () => {
  const r1 = { schemeId: 'rb-1', receiptId: 'r1', amountMinor: 1_000, receivedOn: '2026-10-20', reference: 'NEFT-1' };
  it('refuses a claim not yet sent, another scheme\'s money, more than the receipt or the claim has left', () => {
    const notSent = one([raised('c-1', 1_500)]);
    expect(judgeMatch({ claim: notSent, receipt: r1, receiptId: 'r1', amountMinor: undefined, matchedOfReceiptMinor: 0 })).toMatchObject({ ok: false, code: 'claim_not_sent' });
    const c = one([raised('c-1', 1_500), sentFact('c-1')]);
    expect(judgeMatch({ claim: c, receipt: { ...r1, schemeId: 'rb-2' }, receiptId: 'r1', amountMinor: undefined, matchedOfReceiptMinor: 0 })).toMatchObject({ ok: false, code: 'receipt_not_on_this_scheme' });
    expect(judgeMatch({ claim: c, receipt: undefined, receiptId: 'r9', amountMinor: undefined, matchedOfReceiptMinor: 0 })).toMatchObject({ ok: false, code: 'receipt_not_on_this_scheme' });
    expect(judgeMatch({ claim: c, receipt: r1, receiptId: 'r1', amountMinor: 1_001, matchedOfReceiptMinor: 0 })).toMatchObject({ ok: false, code: 'match_exceeds_receipt' });
    expect(judgeMatch({ claim: c, receipt: r1, receiptId: 'r1', amountMinor: undefined, matchedOfReceiptMinor: 1_000 })).toMatchObject({ ok: false, code: 'receipt_already_matched' });
    expect(judgeMatch({ claim: c, receipt: r1, receiptId: 'r1', amountMinor: undefined, matchedOfReceiptMinor: 400 })).toEqual({ ok: true, amountMinor: 600, alreadyMatched: false });
    const small = one([raised('c-1', 300), sentFact('c-1')]);
    expect(judgeMatch({ claim: small, receipt: r1, receiptId: 'r1', amountMinor: 301, matchedOfReceiptMinor: 0 })).toMatchObject({ ok: false, code: 'match_exceeds_claim' });
    expect(judgeMatch({ claim: small, receipt: r1, receiptId: 'r1', amountMinor: undefined, matchedOfReceiptMinor: 0 })).toEqual({ ok: true, amountMinor: 300, alreadyMatched: false });
    const done = one([raised('c-1', 300), sentFact('c-1'), matched('c-1', 'r1', 300)]);
    expect(judgeMatch({ claim: done, receipt: r1, receiptId: 'r1', amountMinor: undefined, matchedOfReceiptMinor: 300 })).toEqual({ ok: true, amountMinor: 300, alreadyMatched: true });
    expect(judgeMatch({ claim: done, receipt: r1, receiptId: 'r1', amountMinor: 200, matchedOfReceiptMinor: 300 })).toMatchObject({ ok: false, code: 'receipt_already_matched_to_this_claim' });
  });

  it('lists the money matched to no claim, and withdraw refuses a claim answered in full', () => {
    const claims = [...foldRebateClaims([raised('c-1', 300), sentFact('c-1'), matched('c-1', 'r1', 300)]).values()];
    expect(unmatchedReceipts([r1, { ...r1, receiptId: 'r2', amountMinor: 50 }], claims).map((r) => [r.receiptId, r.leftToMatchMinor])).toEqual([['r1', 700], ['r2', 50]]);
    expect(judgeWithdraw(one([raised('c-1', 300), sentFact('c-1'), matched('c-1', 'r1', 300)]))).toMatchObject({ ok: false, code: 'claim_already_answered' });
    expect(judgeWithdraw(one([raised('c-1', 300)]))).toEqual({ ok: true, alreadyWithdrawn: false });
  });
});

describe('the claim register goes overdue on the shop\'s own clock', () => {
  function stub(now: { at: string }) {
    const facts: RebateClaimFact[] = [raised('c-1', 1_500), sentFact('c-1', '2026-10-02')];
    const periods: RebateAnswerPeriodSetting[] = [];
    const accrual = { schemeId: 'rb-1', supplierId: 'sup-1', basisAmount: { minor: 80_000, currency: 'INR' }, accrued: { minor: 2_400, currency: 'INR' }, received: { minor: 0, currency: 'INR' }, outstanding: { minor: 2_400, currency: 'INR' }, thresholdMet: true, detail: '', accrualId: 'q' } as StoredRebateAccrual;
    const deps: RebateClaimDeps = {
      schemes: () => [{ schemeId: 'rb-1', supplierId: 'sup-1', basis: 'purchase_value', rateBp: 300, startsOn: '2026-01-01', endsOn: '2026-12-31', approvedBy: 'u-fin' }],
      accruals: () => [accrual], receipts: () => [], claimFacts: () => facts, claimsVersion: () => 0,
      recordFact: async (_t, _s, f) => { facts.push(f); },
      answerPeriods: () => periods, recordAnswerPeriod: (_t, s) => { periods.push(s); },
      now: () => now.at,
    };
    return { routes: rebateClaimRoutes(deps), deps, periods };
  }
  const route = (routes: readonly Route[], method: string, path: string): Route => routes.find((r) => r.method === method && r.path === path)!;
  const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({ tenantId: 't-1', userId: 'u-owner', params: {}, query: {}, body: undefined, ...over } as RequestContext);

  it('not set says so; once the owner sets 30 days the claim sent on 2 Oct is due on 1 Nov and overdue on 2 Nov — on the portal too', async () => {
    const now = { at: '2026-11-02T06:00:00.000Z' }; // 11:30 in India: the shop's 2 Nov
    const { routes, deps } = stub(now);
    const read = async () => (await route(routes, 'GET', '/v1/purchase/rebate-claims').handler(ctx())).body as { answerPeriod: { state: string }; claims: { claimId: string; overdue: unknown; dueOn: string | null; findings: string[] }[]; counts: { overdue: number; overdueNotKnown: number } };
    let r = await read();
    expect(r.answerPeriod.state).toBe('not_set');
    expect(r.claims[0]).toMatchObject({ overdue: 'not_set', dueOn: null, findings: ['answer_period_not_set'] });
    await route(routes, 'POST', '/v1/purchase/rebate-claims/answer-period').handler(ctx({ body: { days: 30 } }));
    r = await read();
    expect(r.claims[0]).toMatchObject({ overdue: true, dueOn: '2026-11-01', findings: ['overdue'] });
    expect(r.counts).toMatchObject({ overdue: 1, overdueNotKnown: 0 });
    now.at = '2026-11-01T06:00:00.000Z';
    expect((await read()).claims[0]).toMatchObject({ overdue: false });
    expect(await supplierRebateClaims(deps, 't-1', 'sup-1')).toEqual([expect.objectContaining({ claimId: 'c-1', answerDueOn: '2026-11-01', leftToPayMinor: 1_500, state: 'sent' })]);
    expect(await supplierRebateClaims(deps, 't-1', 'sup-2')).toEqual([]);
  });

  it('the owner may clear the period only with a reason, and every claim goes back to "not set"', async () => {
    const { routes, periods } = stub({ at: '2026-11-02T06:00:00.000Z' });
    const set = route(routes, 'POST', '/v1/purchase/rebate-claims/answer-period');
    await set.handler(ctx({ body: { days: 30 } }));
    await expect(set.handler(ctx({ body: { clear: true } }))).rejects.toMatchObject({ status: 400 });
    await set.handler(ctx({ body: { clear: true, reason: 'renegotiating terms' } }));
    expect(periods.map((p) => p.days)).toEqual([30, null]); // append-only: the earlier value stays on the record
    const r = (await route(routes, 'GET', '/v1/purchase/rebate-claims').handler(ctx())).body as { claims: { overdue: unknown }[] };
    expect(r.claims[0]!.overdue).toBe('not_set');
  });
});
