import { describe, it, expect } from 'vitest';
import { createRebatesSession, rebatesOutcomeWords, rebatesWords, REBATES_COPY, type ClaimRow } from '../../apps/web-erp/src/rebates-session';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';
import { HEAD_OFFICE_PAGE_SCREENS, HEAD_OFFICE_PAGE_GLOBALS } from '../../edge/store-edge/src/head-office-pages';

/**
 * **The Supplier rebates page (QG-02 · M06-FR-03 · D03-FR-03 · OB-404).** A thin client over head office's own rebate routes.
 * Proven against a stand-in for head office: the session calls ONLY those routes, with the method and body they read; it
 * asks Finance for exactly what head office said to ask (`approvalAsk`), and records a claim sent only with the asker's OWN
 * approved request for that claim (never a typed number); a person nobody named, or a role without the word, is refused
 * before any call; a form that does not read is refused by name before any call; head office's refusal is its own words, a
 * lost line is "unreachable"; the page is on the menu and served by the store computer; every word has a Tamil twin.
 */

interface Call { readonly url: string; readonly method: string; readonly body: unknown; readonly key: string | null }
function headOffice(answer: (url: string, method: string) => { status: number; body: unknown } | 'throw' = () => ({ status: 200, body: {} })): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown, key: headers['idempotency-key'] ?? null });
    const a = answer(url, method);
    if (a === 'throw') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const TAMIL = /[஀-௿]/;
const keys = (() => { let n = 0; return () => `k-${(n += 1)}`; })();
const ASK = { kind: 'rebate_claim', subjectRef: 'RC-1', valueMinor: 1_500, details: { claimId: 'RC-1', schemeId: 'rb-1', supplierId: 'sup-1', amountMinor: 1_500 }, summary: 'Rebate claim RC-1', reason: 'earned' };
const CLAIM: ClaimRow = {
  claimId: 'RC-1', schemeId: 'rb-1', supplierId: 'sup-1', amountMinor: 1_500, raisedBy: 'u-buyer', raisedAt: '2026-10-27T05:00:00.000Z', state: 'raised',
  matchedMinor: 0, unansweredMinor: 1_500, dueOn: null, overdue: false, findings: ['waiting_for_finance'], approvalAsk: ASK,
};
const BUYER = { userId: 'u-buyer', permissions: ['purchase.commitment.read', 'purchase.contract.manage'] };
const FINANCE = { userId: 'u-fin', permissions: ['purchase.commitment.read', 'finance.journal.post'] };
const OWNER = { userId: 'u-owner', permissions: ['purchase.commitment.read', 'purchase.rebate.terms.set'] };

describe('Supplier rebates — the session', () => {
  it('reads the register, raises (₹ as paise), asks Finance with head office\'s own ask, records sent with the asker\'s approved request, withdraws, shows the document', async () => {
    const ho = headOffice((url, method) => (method === 'GET' && url === '/v1/approvals/requests'
      ? { status: 200, body: { mine: [{ requestId: 'areq-old', kind: 'rebate_claim', subjectRef: 'RC-1', status: 'rejected' }, { requestId: 'areq-9', kind: 'rebate_claim', subjectRef: 'RC-1', status: 'approved' }, { requestId: 'areq-x', kind: 'rebate_scheme', subjectRef: 'RC-1', status: 'approved' }] } }
      : { status: 200, body: {} }));
    const s = createRebatesSession({ viewer: BUYER, fetch: ho.fetch, newKey: keys, newClaimId: () => 'RC-1' });
    expect(s.may).toEqual({ named: true, read: true, claim: true, receipt: false, setPeriod: false });
    await s.register();
    await s.raise({ schemeId: ' rb-1 ', amountRupees: '₹15', note: ' Q3 purchases ' });
    await s.askApproval(CLAIM);
    await s.send(CLAIM, ' 2026-10-27 ');
    await s.withdraw('RC-1', ' raised by mistake ');
    await s.document('RC-1');
    expect(ho.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /v1/purchase/rebate-claims', 'POST /v1/purchase/rebate-schemes/rb-1/claims/RC-1', 'POST /v1/approvals/requests',
      'GET /v1/approvals/requests', 'POST /v1/purchase/rebate-claims/RC-1/send', 'POST /v1/purchase/rebate-claims/RC-1/withdraw', 'GET /v1/purchase/rebate-claims/RC-1/document',
    ]);
    expect(ho.calls[1]!.body).toEqual({ amountMinor: 1_500, note: 'Q3 purchases' });
    expect(ho.calls[2]!.body).toEqual(ASK);
    expect(ho.calls[4]!.body).toEqual({ approvalId: 'areq-9', sentOn: '2026-10-27' });
    expect(ho.calls[5]!.body).toEqual({ reason: 'raised by mistake' });
    expect(ho.calls.filter((c) => c.method === 'POST').every((c) => c.key !== null), 'every write carries its own idempotency key').toBe(true);
  });

  it('records money received as one journal and then matches it to the named claim — a refused match is said, with the money still recorded', async () => {
    const ok = headOffice();
    const fin = createRebatesSession({ viewer: FINANCE, fetch: ok.fetch, newKey: keys, newReceiptId: () => 'rcpt-1' });
    expect(await fin.receipt({ schemeId: 'rb-1', amountRupees: '10', receivedOn: '2026-10-27', reference: ' NEFT 1 ', claimId: '' })).toEqual({ result: 'ok', value: { matched: null } });
    expect(await fin.receipt({ schemeId: 'rb-1', amountRupees: '10', receivedOn: '2026-10-27', reference: 'NEFT 1', claimId: 'RC-1' })).toEqual({ result: 'ok', value: { matched: true } });
    await fin.match('RC-1', 'rcpt-7');
    expect(ok.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /v1/finance/rebate-receipts/rb-1/receipts/rcpt-1', 'POST /v1/finance/rebate-receipts/rb-1/receipts/rcpt-1', 'POST /v1/purchase/rebate-claims/RC-1/matches/rcpt-1', 'POST /v1/purchase/rebate-claims/RC-1/matches/rcpt-7',
    ]);
    expect(ok.calls[0]!.body).toEqual({ amountMinor: 1_000, receivedOn: '2026-10-27', reference: 'NEFT 1' });
    const refusingMatch = headOffice((url) => (url.includes('/matches/') ? { status: 409, body: { error: { code: 'claim_not_sent', whatHappened: 'Claim RC-1 has not been approved by Finance and sent.' } } } : { status: 201, body: {} }));
    const out = await createRebatesSession({ viewer: FINANCE, fetch: refusingMatch.fetch, newReceiptId: () => 'rcpt-2' }).receipt({ schemeId: 'rb-1', amountRupees: '5', receivedOn: '2026-10-27', reference: 'R', claimId: 'RC-1' });
    expect(rebatesOutcomeWords('en', out)).toBe('The money was recorded, but head office did not match it to the claim: Claim RC-1 has not been approved by Finance and sent.');
  });

  it('the owner sets or clears the answer days; nobody else is offered it', async () => {
    const ho = headOffice();
    const owner = createRebatesSession({ viewer: OWNER, fetch: ho.fetch });
    await owner.setPeriod(' 30 ');
    await owner.clearPeriod(' terms being renegotiated ');
    expect(ho.calls.map((c) => c.body)).toEqual([{ days: 30 }, { clear: true, reason: 'terms being renegotiated' }]);
    expect(await createRebatesSession({ viewer: BUYER, fetch: ho.fetch }).setPeriod('30')).toEqual({ result: 'invalid', why: 'cannotSetPeriod' });
  });

  it('refuses before any call: nobody named, a role without the word, a form that does not read, a claim Finance has not approved', async () => {
    const ho = headOffice((url) => (url === '/v1/approvals/requests' ? { status: 200, body: { mine: [{ requestId: 'areq-1', kind: 'rebate_claim', subjectRef: 'RC-1', status: 'waiting' }] } } : { status: 200, body: {} }));
    expect(await createRebatesSession({ viewer: { permissions: BUYER.permissions }, fetch: ho.fetch }).register()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(await createRebatesSession({ viewer: { userId: 'u-c', permissions: [] }, fetch: ho.fetch }).register()).toEqual({ result: 'invalid', why: 'cannotRead' });
    const reader = createRebatesSession({ viewer: { userId: 'u-r', permissions: ['purchase.commitment.read'] }, fetch: ho.fetch });
    expect(await reader.raise({ schemeId: 'rb-1', amountRupees: '1', note: '' })).toEqual({ result: 'invalid', why: 'cannotClaim' });
    expect(await reader.receipt({ schemeId: 'rb-1', amountRupees: '1', receivedOn: '2026-10-27', reference: 'R', claimId: '' })).toEqual({ result: 'invalid', why: 'cannotReceipt' });
    const s = createRebatesSession({ viewer: BUYER, fetch: ho.fetch });
    expect(await s.raise({ schemeId: '', amountRupees: '1', note: '' })).toEqual({ result: 'invalid', why: 'needRaise' });
    expect(await s.raise({ schemeId: 'rb-1', amountRupees: '10.555', note: '' })).toEqual({ result: 'invalid', why: 'needRaise' });
    expect(await s.raise({ schemeId: 'rb-1', amountRupees: '0', note: '' })).toEqual({ result: 'invalid', why: 'needRaise' });
    expect(await s.send(CLAIM, '27/10/2026')).toEqual({ result: 'invalid', why: 'needSentOn' });
    expect(await s.withdraw('RC-1', '  ')).toEqual({ result: 'invalid', why: 'needReason' });
    // A claim head office gave no ask for (it is no longer waiting for Finance) is not asked about.
    expect(await s.askApproval({ ...CLAIM, state: 'sent', approvalAsk: undefined } as unknown as ClaimRow)).toEqual({ result: 'invalid', why: 'notApprovedYet' });
    expect(ho.calls).toEqual([]);
    // Waiting, not approved: the send reads the asker's own requests and refuses — nothing is sent.
    expect(await s.send(CLAIM, '2026-10-27')).toEqual({ result: 'invalid', why: 'notApprovedYet' });
    expect(ho.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/approvals/requests']);
    const fin = createRebatesSession({ viewer: FINANCE, fetch: ho.fetch });
    expect(await fin.receipt({ schemeId: 'rb-1', amountRupees: '1', receivedOn: 'today', reference: 'R', claimId: '' })).toEqual({ result: 'invalid', why: 'needReceipt' });
    expect(await fin.match(' ', 'rcpt-1')).toEqual({ result: 'invalid', why: 'needClaim' });
    expect(await createRebatesSession({ viewer: OWNER, fetch: ho.fetch }).setPeriod('0')).toEqual({ result: 'invalid', why: 'needDays' });
  });

  it('outcomes and refusals are said in words; a lost line is "unreachable"; every word has a Tamil twin', async () => {
    expect(rebatesOutcomeWords('en', { result: 'ok', value: { alreadyRaised: false } })).toBe('Claim raised. Next: ask Finance to approve it.');
    expect(rebatesOutcomeWords('en', { result: 'ok', value: { alreadySent: false } })).toMatch(/^Recorded as sent\./);
    expect(rebatesOutcomeWords('en', { result: 'ok', value: { alreadySent: true } })).toBe('Already recorded — nothing changed.');
    expect(rebatesOutcomeWords('en', { result: 'ok', value: { requestId: 'areq-1' } })).toMatch(/^Asked\./);
    expect(rebatesOutcomeWords('en', { result: 'refused', status: 422, code: 'claim_exceeds_unclaimed', whatHappened: 'At most 900 paise may still be claimed.' })).toBe('Head office refused: At most 900 paise may still be claimed.');
    const down = createRebatesSession({ viewer: BUYER, fetch: headOffice(() => 'throw').fetch });
    expect(rebatesOutcomeWords('ta', await down.register())).toBe(rebatesWords('ta', 'unreachable'));
    expect(Object.keys(REBATES_COPY.ta).sort()).toEqual(Object.keys(REBATES_COPY.en).sort());
    for (const k of Object.keys(REBATES_COPY.en)) expect((REBATES_COPY.ta as Record<string, string>)[k], k).toMatch(TAMIL);
  });

  it('is on the Purchase menu behind the register\'s read, and the store computer serves it as a head-office page', () => {
    expect(ERP_NAVIGATION.find((i) => i.id === 'rebates')).toMatchObject({ path: '/rebates', requires: 'purchase.commitment.read', group: 'Purchase', labelTa: expect.stringMatching(TAMIL) });
    expect(HEAD_OFFICE_PAGE_SCREENS).toContain('rebates');
    expect(HEAD_OFFICE_PAGE_GLOBALS.rebates).toBe('rebatesData');
  });
});
