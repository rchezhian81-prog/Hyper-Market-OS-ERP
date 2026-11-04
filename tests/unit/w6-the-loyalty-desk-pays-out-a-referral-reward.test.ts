import { describe, it, expect } from 'vitest';
import { createDeskSession, DESK_COPY, SECTION_WORDS, PAYOUT_HOWS } from '../../apps/web-erp/src/customer-desk-sections-session';

/**
 * W6 · M17-FR-02 · OB-221 · OB-356 — a referral reward the shop owes is PAID OUT (how, and the receipt or transfer number) or
 * LET LAPSE (why) by a person on the Loyalty page. OB-356 makes the reward itself automatic (given once the owner sets it);
 * paying it is a person's step with a reference, so it sits on the page behind `loyalty.referral.settle`.
 * The session reads the programme first (that read gives a reward now due), then the liability register, and lists only
 * what is still owed, naming whose it is where the programme says. It refuses only the cheap things before a request.
 */

type Sent = { method: string; path: string; body?: unknown };
function fakeFetch(reply: (r: Sent) => { status?: number; body: unknown }) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const r: Sent = { method: init?.method ?? 'GET', path: String(url), ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) };
    sent.push(r);
    const out = reply(r);
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

const PROGRAMME = { referrals: [{ claim: { claimId: 'cl-1' }, grants: [
  { referralId: 'cl-1-referrer', side: 'referrer', customerRef: 'c-1', rewardMinor: 5_000 },
  { referralId: 'cl-1-referred', side: 'referred', customerRef: 'c-2', rewardMinor: 2_500 },
] }] };
const LIABILITY = { register: { outstandingMinor: 7_500, referrals: [
  { referralId: 'cl-1-referred', earnedMinor: 2_500, paidMinor: 0, expiredMinor: 0, outstandingMinor: 2_500, state: 'owed' },
  { referralId: 'cl-1-referrer', earnedMinor: 5_000, paidMinor: 0, expiredMinor: 0, outstandingMinor: 5_000, state: 'owed' },
  { referralId: 'old-paid', earnedMinor: 1_000, paidMinor: 1_000, expiredMinor: 0, outstandingMinor: 0, state: 'paid' },
  { referralId: 'legacy-1', earnedMinor: 900, paidMinor: 0, expiredMinor: 0, outstandingMinor: 900, state: 'owed' },
] } };

const desk = (perms: readonly string[], reply: Parameters<typeof fakeFetch>[0] = (r) => ({ body: r.path.includes('programme') ? PROGRAMME : LIABILITY }), userId: string | null = 'u-mgr') => {
  const f = fakeFetch(reply);
  return { s: createDeskSession({ viewer: userId === null ? undefined : { userId, permissions: perms }, fetch: f.fetch, newKey: () => 'k-1' }), sent: f.sent };
};

describe('W6 · the Loyalty page pays out a referral reward (M17-FR-02 · OB-221 · OB-356)', () => {
  it('the section is offered only to whom head office lets settle a referral; its words have Tamil twins', async () => {
    expect(SECTION_WORDS.referral).toBe('loyalty.referral.settle');
    expect(desk(['loyalty.referral.settle']).s.may.referral).toBe(true);
    const cashier = desk(['loyalty.member.enrol']);
    expect(cashier.s.may.referral).toBe(false);
    expect(await cashier.s.owedReferrals()).toEqual({ result: 'invalid', why: 'cannot' });
    expect(await cashier.s.payReferral('cl-1-referrer', 'cash', 'R-1')).toEqual({ result: 'invalid', why: 'cannot' });
    const nobody = desk(['loyalty.referral.settle'], undefined, null);
    expect(await nobody.s.lapseReferral('cl-1-referrer', 'declined')).toEqual({ result: 'invalid', why: 'nobody' });
    expect(cashier.sent).toEqual([]); expect(nobody.sent).toEqual([]);
    for (const k of ['owedH', 'owedLead', 'owedShow', 'noOwed', 'owes', 'side_referrer', 'side_referred', 'how', 'how_cash', 'how_store_credit', 'how_bank_transfer', 'payRef', 'payOut', 'paidOut', 'lapseReason', 'lapse', 'lapsed']) {
      expect((DESK_COPY.en as Record<string, string>)[k], k).toBeTruthy();
      expect((DESK_COPY.ta as Record<string, string>)[k], k).toBeTruthy();
      expect((DESK_COPY.ta as Record<string, string>)[k]).not.toBe((DESK_COPY.en as Record<string, string>)[k]);
    }
    expect(PAYOUT_HOWS).toEqual(['cash', 'store_credit', 'bank_transfer']);
  });

  it('reads the programme first, then the register; lists only what is still owed, naming whose it is where the programme says', async () => {
    const { s, sent } = desk(['loyalty.referral.settle']);
    const out = await s.owedReferrals();
    expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v1/loyalty/referral-programme', 'GET /v1/finance/referral-liability']);
    expect(out).toEqual({ result: 'ok', value: [
      { referralId: 'cl-1-referred', earnedMinor: 2_500, outstandingMinor: 2_500, side: 'referred', customerRef: 'c-2' },
      { referralId: 'cl-1-referrer', earnedMinor: 5_000, outstandingMinor: 5_000, side: 'referrer', customerRef: 'c-1' },
      { referralId: 'legacy-1', earnedMinor: 900, outstandingMinor: 900, side: null, customerRef: null },
    ] });
  });

  it('a refused programme read stops there: the register is not read and the refusal is said', async () => {
    const { s, sent } = desk(['loyalty.referral.settle'], () => ({ status: 403, body: { error: { code: 'forbidden', whatHappened: 'This account does not hold "loyalty.coupon.read".' } } }));
    expect(await s.owedReferrals()).toEqual({ result: 'refused', status: 403, code: 'forbidden', whatHappened: 'This account does not hold "loyalty.coupon.read".' });
    expect(sent).toHaveLength(1);
  });

  it('pays out with how and the reference, or lets lapse with the reason — each its own documented body; cheap refusals send nothing', async () => {
    const { s, sent } = desk(['loyalty.referral.settle'], () => ({ status: 201, body: { outstandingMinor: 0 } }));
    expect(await s.payReferral('cl-1-referrer', 'cash', '  ')).toEqual({ result: 'invalid', why: 'needText' });
    expect(await s.payReferral('cl-1-referrer', 'upi', 'R-1')).toEqual({ result: 'invalid', why: 'needText' });
    expect(await s.lapseReferral('cl-1-referrer', ' ')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(sent).toEqual([]);
    expect((await s.payReferral('cl-1-referrer', 'store_credit', ' SC-77 ')).result).toBe('ok');
    expect((await s.lapseReferral('cl-1-referred', ' The customer declined it ')).result).toBe('ok');
    expect(sent).toEqual([
      { method: 'POST', path: '/v1/loyalty/referrals/cl-1-referrer/payout', body: { how: 'store_credit', reference: 'SC-77' } },
      { method: 'POST', path: '/v1/loyalty/referrals/cl-1-referred/expire', body: { reason: 'The customer declined it' } },
    ]);
  });
});
