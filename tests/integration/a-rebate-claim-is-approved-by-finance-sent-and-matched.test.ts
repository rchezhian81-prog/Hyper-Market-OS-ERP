import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller, issuedOrder, received, capturedAndMatched } from '../support/p3-purchase';
import { askForApproval, decide, sentWithApproval } from '../support/approval-request';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';

/**
 * **D03-FR-03 · §28 "Finance approves rebate claims" · OB-404 (owner, 27 Oct 2026, option A): a supplier rebate CLAIM is
 * raised for money earned and not yet received, approved by Finance, sent, matched to the money, and overdue when unanswered.**
 *
 * On the real API (in memory and — with DATABASE_URL — on real PostgreSQL, with a cold restart):
 *   • a claim is never for more than the scheme earned and has not received or already claimed (the same money is never
 *     claimed twice); the same claim re-sent is the same claim; its number reused for another amount is refused;
 *   • it is sent only with Finance's approval of exactly it, given by a different person in their own session — a typed
 *     approver is refused by name, and the person who RAISED it can never be its approver;
 *   • sent, its document prints as sent and the supplier sees it on its own portal (never a claim not yet approved, never
 *     another supplier's);
 *   • the money finance records is matched to it — never more than the receipt or the claim has left; a withdrawn claim
 *     answers nothing; a receipt matched to no claim is listed;
 *   • overdue needs the OWNER's answer period: "not set" until he sets it, then a due day; only the owner may set it;
 *   • every state is an appended fact: after a cold restart everything reads back the same.
 * Synthetic data.
 */

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const TODAY = new Date().toISOString().slice(0, 10);
const inDays = (n: number): string => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const leg = (account: string, side: 'debit' | 'credit') => ({ account, side, component: 'amount' });
const MAP = { rules: [...DEFAULT_RETAIL_POSTING_MAP.rules, { kind: 'supplier_rebate', legs: [leg('bank_clearing', 'debit'), leg('supplier_rebate_income', 'credit')] }] };

interface Ask { kind: string; subjectRef: string; valueMinor: number; details: Record<string, unknown>; summary: string; reason: string }
interface ClaimRow { claimId: string; state: string; amountMinor: number; matchedMinor: number; unansweredMinor: number; dueOn: string | null; overdue: boolean | 'not_set'; findings: string[]; approvalAsk?: Ask; sent?: { approvedBy: string; sentOn: string } }
interface Register {
  answerPeriod: { state: string; days: number | null };
  schemes: { schemeId: string; accruedMinor: number; receivedMinor: number; outstandingMinor: number; openClaimedMinor: number; claimableMinor: number; findings: string[]; receipts: { receiptId: string; matchedMinor: number }[] }[];
  claims: ClaimRow[];
  unmatchedReceipts: { receiptId: string; leftToMatchMinor: number }[];
  counts: { waitingForFinance: number; overdue: number; overdueNotKnown: number };
}

describe.each(backings)('a supplier rebate claim is approved by Finance, sent, matched and shown overdue (D03-FR-03 · OB-404) — on $name', ({ harness }) => {
  it('raises within what is earned, sends with a different person\'s approval, shows the supplier, matches the money, and says "not set" until the owner sets the answer period', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T, 'sup-1', 'sup-2');
    await h.provisionRole(T, 'u-sup', 'supplier');
    await h.provisionRole(T, 'u-sup2', 'supplier');
    const call = caller(h, T);
    const reg = async (who: string = P3.BUYER): Promise<Register> => {
      const r = await call('GET', '/v1/purchase/rebate-claims', who);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body as Register;
    };
    const claimOf = async (id: string, who?: string): Promise<ClaimRow> => (await reg(who)).claims.find((c) => c.claimId === id)!;

    // The supplier's bills earn the rebate: ₹800 matched → a 3% scheme earns ₹24.
    for (const [id, qty] of [['a', 10], ['b', 6]] as const) {
      const lines = [{ productId: 'rice', qty, unitMinor: 5_000 }];
      await issuedOrder(call, `po-${id}`, lines);
      await received(call, `grn-${id}`, `po-${id}`, lines);
      await capturedAndMatched(call, `inv-${id}`, `po-${id}`, lines, undefined, 'sup-1', TODAY);
    }
    const scheme = { supplierId: 'sup-1', basis: 'purchase_value', rateBp: 300, startsOn: `${TODAY.slice(0, 4)}-01-01`, endsOn: `${TODAY.slice(0, 4)}-12-31` };
    const sch = await sentWithApproval(h, T, P3.OWNER, P3.MATCHER, { kind: 'rebate_scheme', subjectRef: 'rb-1', pathIds: { schemeId: 'rb-1' } }, scheme,
      (body) => h.request({ method: 'POST', path: '/v1/purchase/rebate-schemes/rb-1', userId: P3.OWNER, tenantId: T, idempotencyKey: 'scheme-rb-1', body }));
    expect(sch.status, JSON.stringify(sch.body)).toBe(201);
    expect((await call('POST', '/v1/purchase/rebate-schemes/rb-1/accruals/q', P3.OWNER, { periodFrom: `${TODAY.slice(0, 4)}-01-01`, periodTo: TODAY })).status).toBe(201);
    expect((await reg()).schemes[0]).toMatchObject({ schemeId: 'rb-1', accruedMinor: 2_400, receivedMinor: 0, outstandingMinor: 2_400, claimableMinor: 2_400, findings: ['earned_not_claimed'] });

    // ── RAISE: never more than earned-and-not-claimed; the same claim re-sent is the same; its number is never reused.
    const raise = (claimId: string, body: Record<string, unknown>, who: string = P3.BUYER) => call('POST', `/v1/purchase/rebate-schemes/rb-1/claims/${claimId}`, who, body, `raise-${randomUUID()}`);
    expect((await raise('c-x', { amountMinor: 100 }, P3.CASHIER)).status).toBe(403);
    expect((await raise('c-x', { amountMinor: 100 }, P3.MATCHER)).status, 'Finance approves claims; it does not raise them').toBe(403);
    expect(codeOf(await raise('c-x', { amountMinor: 0 }))).toBe('not_readable_as_a_rebate_claim');
    expect(codeOf(await call('POST', '/v1/purchase/rebate-schemes/rb-nope/claims/c-x', P3.BUYER, { amountMinor: 100 }))).toBe('not_found');
    expect(codeOf(await raise('c-x', { amountMinor: 2_401 }))).toBe('claim_exceeds_unclaimed');
    const raised = await raise('c-1', { amountMinor: 1_500, note: 'Q3 purchases' });
    expect(raised.status, JSON.stringify(raised.body)).toBe(201);
    const ask = (raised.body as { approvalAsk: Ask }).approvalAsk;
    expect(ask).toMatchObject({ kind: 'rebate_claim', subjectRef: 'c-1', valueMinor: 1_500, details: { claimId: 'c-1', schemeId: 'rb-1', supplierId: 'sup-1', amountMinor: 1_500 } });
    expect(((await raise('c-1', { amountMinor: 1_500 })).body as { alreadyRaised: boolean }).alreadyRaised).toBe(true);
    expect(codeOf(await raise('c-1', { amountMinor: 1_400 }))).toBe('claim_number_already_used');
    // The same money is never claimed twice: ₹15 is open on c-1, so only ₹9 is left.
    expect(codeOf(await raise('c-2', { amountMinor: 1_000 }))).toBe('claim_exceeds_unclaimed');
    expect((await raise('c-0', { amountMinor: 900 }, P3.OWNER)).status).toBe(201);
    expect((await reg()).schemes[0]).toMatchObject({ openClaimedMinor: 2_400, claimableMinor: 0, findings: [] });

    // ── SEND: only with Finance's approval of exactly this claim, from a different person — never its raiser.
    const send = (claimId: string, body: Record<string, unknown>, who: string = P3.BUYER) => call('POST', `/v1/purchase/rebate-claims/${claimId}/send`, who, body, `send-${randomUUID()}`);
    expect(codeOf(await send('c-1', { sentOn: TODAY }))).toBe('claim_needs_finance_approval');
    expect(codeOf(await send('c-1', { sentOn: TODAY, approvedBy: P3.MATCHER }))).toBe('approver_named_without_approval');
    expect(codeOf(await send('c-nope', { sentOn: TODAY }))).toBe('not_found');
    const asked = await askForApproval(h, T, P3.BUYER, ask);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const requestId = (asked.body as { requestId: string }).requestId;
    expect(codeOf(await decide(h, T, P3.BUYER, requestId)), 'the asker cannot approve').toBe('not_permitted_for_this_approval');
    expect(codeOf(await send('c-1', { sentOn: TODAY, approvalId: requestId })), 'not yet decided').toBe('approval_still_waiting');
    expect((await decide(h, T, P3.MATCHER, requestId)).status).toBe(201);
    expect(codeOf(await send('c-1', { sentOn: inDays(1), approvalId: requestId }))).toBe('sent_on_outside_the_claim');
    const sent = await send('c-1', { sentOn: TODAY, approvalId: requestId });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect((sent.body as { claim: ClaimRow }).claim).toMatchObject({ state: 'sent', sent: { approvedBy: P3.MATCHER, sentOn: TODAY } });
    expect(((await send('c-1', { sentOn: TODAY, approvalId: requestId })).body as { alreadySent: boolean }).alreadySent).toBe(true);
    // The raiser can never be the approver: the owner raised c-0, so the owner's approval of it does not count.
    const c0Ask = (await claimOf('c-0')).approvalAsk!;
    const c0Request = (await askForApproval(h, T, P3.BUYER, c0Ask)).body as { requestId: string };
    expect((await decide(h, T, P3.OWNER, c0Request.requestId)).status).toBe(201);
    expect(codeOf(await send('c-0', { sentOn: TODAY, approvalId: c0Request.requestId }))).toBe('raiser_cannot_approve_claim');
    // A wrong claim is withdrawn by a compensating fact (with a reason), and what it asked for may be claimed again.
    expect(codeOf(await call('POST', '/v1/purchase/rebate-claims/c-0/withdraw', P3.OWNER, {}))).toBe('withdrawal_needs_a_reason');
    expect((await call('POST', '/v1/purchase/rebate-claims/c-0/withdraw', P3.OWNER, { reason: 'raised by mistake' })).status).toBe(201);
    expect(codeOf(await send('c-0', { sentOn: TODAY, approvalId: c0Request.requestId }))).toBe('claim_withdrawn');
    expect((await reg()).schemes[0]).toMatchObject({ openClaimedMinor: 1_500, claimableMinor: 900 });

    // ── The document prints as sent; the supplier sees its own sent claim on the portal, and nothing else.
    const doc = (await call('GET', '/v1/purchase/rebate-claims/c-1/document', P3.MATCHER)).body as { printable: boolean; document: Record<string, unknown> };
    expect(doc.printable).toBe(true);
    expect(doc.document).toMatchObject({ claimNumber: 'c-1', status: 'sent', amountClaimedMinor: 1_500, sentOn: TODAY, approvedByFinance: P3.MATCHER, answerDue: 'not_set', leftToPayMinor: 1_500, to: { supplierId: 'sup-1' } });
    expect(((await call('GET', '/v1/purchase/rebate-claims/c-0/document', P3.MATCHER)).body as { printable: boolean }).printable).toBe(false);
    await call('POST', '/v1/supplier-portal/partners/sup-1', P3.BUYER, { grants: ['view_statement'], documents: [], requiredDocuments: [], logins: ['u-sup'] });
    await call('POST', '/v1/supplier-portal/partners/sup-2', P3.BUYER, { grants: ['view_statement'], documents: [], requiredDocuments: [], logins: ['u-sup2'] });
    const portal = (await call('GET', '/v1/supplier-portal/me/rebate-claims', 'u-sup')).body as { partnerId: string; claimsKnown: boolean; claims: { claimId: string; amountMinor: number; sentOn: string; answerDueOn: string | null; leftToPayMinor: number }[] };
    expect(portal).toMatchObject({ partnerId: 'sup-1', claimsKnown: true, claims: [{ claimId: 'c-1', amountMinor: 1_500, sentOn: TODAY, answerDueOn: null, leftToPayMinor: 1_500 }] });
    expect(JSON.stringify(portal)).not.toContain(P3.MATCHER);
    expect(((await call('GET', '/v1/supplier-portal/me/rebate-claims', 'u-sup2')).body as { claims: unknown[] }).claims).toEqual([]);
    expect(codeOf(await h.request({ method: 'GET', path: '/v1/supplier-portal/me/rebate-claims', userId: 'u-sup2', tenantId: T, query: { partnerId: 'sup-1' } }))).toBe('not_your_data');

    // ── OVERDUE needs the owner's number: "not set" until he sets it — only the owner may.
    let r = await reg();
    expect(r.answerPeriod).toMatchObject({ state: 'not_set', days: null });
    expect(r.claims.find((c) => c.claimId === 'c-1')).toMatchObject({ overdue: 'not_set', dueOn: null, findings: ['answer_period_not_set'] });
    expect(r.counts).toMatchObject({ overdue: 0, overdueNotKnown: 1 });
    const period = (body: Record<string, unknown>, who: string = P3.OWNER) => call('POST', '/v1/purchase/rebate-claims/answer-period', who, body, `ap-${randomUUID()}`);
    expect((await period({ days: 30 }, P3.BUYER)).status).toBe(403);
    expect((await period({ days: 30 }, P3.MATCHER)).status).toBe(403);
    expect(codeOf(await period({ days: 0 }))).toBe('not_readable_as_an_answer_period');
    expect((await period({ days: 30 })).status).toBe(201);
    r = await reg();
    expect(r.answerPeriod).toMatchObject({ state: 'set', days: 30 });
    expect(r.claims.find((c) => c.claimId === 'c-1')).toMatchObject({ overdue: false, dueOn: inDays(30), findings: [] });

    // ── MATCH: finance's receipt answers the claim — never more than either has left; a withdrawn claim answers nothing.
    expect((await h.request({ method: 'PUT', path: '/v1/finance/posting-map', userId: P3.MATCHER, tenantId: T, idempotencyKey: 'map-1', body: MAP })).status).toBeLessThan(300);
    const receipt = (id: string, amountMinor: number) => call('POST', `/v1/finance/rebate-receipts/rb-1/receipts/${id}`, P3.MATCHER, { amountMinor, receivedOn: TODAY, reference: `NEFT-${id}` });
    expect((await receipt('r1', 1_000)).status).toBe(201);
    const match = (claimId: string, receiptId: string, body: Record<string, unknown> = {}, who: string = P3.MATCHER) => call('POST', `/v1/purchase/rebate-claims/${claimId}/matches/${receiptId}`, who, body, `match-${randomUUID()}`);
    expect((await match('c-1', 'r1', {}, P3.BUYER)).status, 'matching money is finance\'s').toBe(403);
    expect(codeOf(await match('c-1', 'r-nope'))).toBe('receipt_not_on_this_scheme');
    expect(codeOf(await match('c-0', 'r1'))).toBe('claim_withdrawn');
    expect(codeOf(await match('c-1', 'r1', { amountMinor: 1_001 }))).toBe('match_exceeds_receipt');
    const m1 = await match('c-1', 'r1');
    expect(m1.status, JSON.stringify(m1.body)).toBe(201);
    expect((m1.body as { claim: ClaimRow }).claim).toMatchObject({ state: 'partly_answered', matchedMinor: 1_000, unansweredMinor: 500 });
    expect(((await match('c-1', 'r1')).body as { alreadyMatched: boolean }).alreadyMatched).toBe(true);
    expect((await receipt('r2', 700)).status).toBe(201);
    expect(codeOf(await match('c-1', 'r2', { amountMinor: 600 }))).toBe('match_exceeds_claim');
    expect((await match('c-1', 'r2')).status).toBe(201); // ₹5 of the ₹7 answers c-1; ₹2 is left on the receipt
    r = await reg();
    expect(r.claims.find((c) => c.claimId === 'c-1')).toMatchObject({ state: 'answered', matchedMinor: 1_500, unansweredMinor: 0, overdue: false });
    expect(r.unmatchedReceipts).toEqual([expect.objectContaining({ receiptId: 'r2', leftToMatchMinor: 200 })]);
    expect(r.schemes[0]).toMatchObject({ accruedMinor: 2_400, receivedMinor: 1_700, outstandingMinor: 700, openClaimedMinor: 0, claimableMinor: 700 });
    expect(codeOf(await call('POST', '/v1/purchase/rebate-claims/c-1/withdraw', P3.BUYER, { reason: 'too late' }))).toBe('claim_already_answered');
    expect(((await call('GET', '/v1/supplier-portal/me/rebate-claims', 'u-sup')).body as { claims: { state: string; paidMinor: number }[] }).claims).toEqual([expect.objectContaining({ state: 'answered', paidMinor: 1_500 })]);

    // ── A cold restart reads every fact back the same.
    const h2 = harness(h);
    const again = (await h2.request({ method: 'GET', path: '/v1/purchase/rebate-claims', userId: P3.MATCHER, tenantId: T })).body as Register;
    expect(again.claims.map((c) => [c.claimId, c.state, c.matchedMinor])).toEqual(r.claims.map((c) => [c.claimId, c.state, c.matchedMinor]));
    expect(again.answerPeriod).toMatchObject({ state: 'set', days: 30 });
    expect(again.schemes[0]).toMatchObject({ claimableMinor: 700 });
  }, 120_000);
});
