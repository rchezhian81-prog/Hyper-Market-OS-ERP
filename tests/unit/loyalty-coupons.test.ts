import { describe, it, expect } from 'vitest';
import {
  redeemCoupon,
  issuePersonalisedOffer,
  assessReferral,
  type Coupon,
  type Redemption,
} from '../../packages/loyalty/src/coupons';

// M17-FR-02: "single-use/expiry enforced; personalization consent-scoped (PRV);
// invalid/expired/duplicate redemption blocked."

const COUPON: Coupon = {
  code: 'SAVE100',
  kind: 'amount_off',
  valueMinor: 10_000,
  issuedAt: '2026-08-01T00:00:00Z',
  validUntil: '2026-08-31',
  maxRedemptions: 1,
  maxPerCustomer: 1,
};

const redemption = (over: Partial<Redemption> = {}): Redemption => ({
  redemptionId: 'RD-1',
  code: 'SAVE100',
  customerRef: 'c-1',
  at: '2026-08-04T14:00:00Z',
  saleId: 'S-1',
  ...over,
});

function redeem(over: Partial<Parameters<typeof redeemCoupon>[0]> = {}) {
  return redeemCoupon({
    coupon: COUPON,
    redemption: redemption(),
    knownRedemptions: [],
    basketMinor: 80_000,
    ...over,
  });
}

describe('a coupon is checked at redemption, not at issue (M17-FR-02)', () => {
  it('redeems a valid coupon for an exact amount', () => {
    const result = redeem();
    expect(result.redeemed).toBe(true);
    expect(result.discountMinor).toBe(10_000);
  });

  it('BLOCKS THE SECOND USE — including on another lane', () => {
    const result = redeem({
      redemption: redemption({ redemptionId: 'RD-2', saleId: 'S-2' }),
      knownRedemptions: [redemption()],
    });
    expect(result.redeemed).toBe(false);
    expect(result.outcome).toBe('limit_reached');
    expect(result.discountMinor).toBe(0);
  });

  it('is IDEMPOTENT on the redemption id — a re-scan is not a second use', () => {
    const result = redeem({ knownRedemptions: [redemption()] });
    expect(result.outcome).toBe('already_redeemed');
    expect(result.detail).toContain('scanning again changes nothing');
  });

  it('WARNS WHEN THE LANE\'S LIST IS STALE rather than silently trusting it', () => {
    const result = redeem({ cacheAgeMinutes: 90, staleAfterMinutes: 15 });
    expect(result.redeemed).toBe(true);
    expect(result.countMayBeStale).toBe(true);
    expect(result.detail).toContain('may not be counted yet');
  });

  it('does not flag a fresh lane', () => {
    expect(redeem({ cacheAgeMinutes: 5, staleAfterMinutes: 15 }).countMayBeStale).toBeUndefined();
  });

  it('refuses an expired coupon and one not yet valid', () => {
    expect(redeem({ redemption: redemption({ at: '2026-09-01T10:00:00Z' }) }).outcome).toBe('expired');
    expect(redeem({ redemption: redemption({ at: '2026-07-30T10:00:00Z' }) }).outcome).toBe('not_yet_valid');
  });

  it('refuses an unknown code', () => {
    expect(redeem({ coupon: undefined }).outcome).toBe('unknown_code');
  });

  it('enforces a per-customer limit separately from the total limit', () => {
    const generous: Coupon = { ...COUPON, maxRedemptions: 100, maxPerCustomer: 2 };
    const result = redeemCoupon({
      coupon: generous,
      redemption: redemption({ redemptionId: 'RD-3' }),
      knownRedemptions: [
        redemption({ redemptionId: 'RD-1' }),
        redemption({ redemptionId: 'RD-2' }),
        redemption({ redemptionId: 'RD-x', customerRef: 'c-other' }),
      ],
      basketMinor: 80_000,
    });
    expect(result.outcome).toBe('customer_limit_reached');
  });

  it('refuses a coupon issued to somebody else, and one the customer is not eligible for', () => {
    expect(redeem({ coupon: { ...COUPON, issuedTo: 'c-other' } }).outcome).toBe('not_eligible');

    const memberOnly = redeem({ coupon: { ...COUPON, eligibleTo: ['gold'] }, customerSegments: ['regular'] });
    expect(memberOnly.outcome).toBe('not_eligible');
    expect(memberOnly.detail).toContain('for gold customers');

    expect(redeem({ coupon: { ...COUPON, eligibleTo: ['gold'] }, customerSegments: ['gold'] }).redeemed).toBe(true);
  });

  it('enforces a minimum basket', () => {
    const result = redeem({ coupon: { ...COUPON, minimumBasketMinor: 100_000 } });
    expect(result.outcome).toBe('basket_too_small');
  });

  it('computes a percentage exactly and NEVER PAYS THE CUSTOMER', () => {
    const percent = redeem({
      coupon: { ...COUPON, kind: 'percent_off', valueMinor: undefined, percentBps: 1_250 },
      basketMinor: 80_000,
    });
    expect(percent.discountMinor).toBe(10_000); // 12.5% of ₹800.00, exact

    // A ₹100 coupon on a ₹40 basket discounts ₹40, not ₹100.
    const tiny = redeem({ basketMinor: 4_000 });
    expect(tiny.discountMinor).toBe(4_000);
  });
});

describe('a personalised offer carries the consent gate (PRV / M16-FR-02)', () => {
  const offer: Coupon = { ...COUPON, code: 'FORYOU', personalised: true };

  it('REFUSES without profiling consent, naming the reason', () => {
    const result = issuePersonalisedOffer({ customerRef: 'c-1', coupon: offer, consents: ['marketing'] });
    expect(result.issued).toBe(false);
    expect(result.outcome).toBe('no_profiling_consent');
    expect(result.detail).toContain("built from the customer's own shopping history");
  });

  it('REFUSES with profiling but no marketing consent — two different permissions', () => {
    const result = issuePersonalisedOffer({ customerRef: 'c-1', coupon: offer, consents: ['profiling'] });
    expect(result.outcome).toBe('no_marketing_consent');
    expect(result.detail).toContain('two different permissions');
  });

  it('issues with both, stamping the recipient', () => {
    const result = issuePersonalisedOffer({ customerRef: 'c-1', coupon: offer, consents: ['profiling', 'marketing'] });
    expect(result.issued).toBe(true);
    expect(result.coupon?.issuedTo).toBe('c-1');
    expect(result.coupon?.personalised).toBe(true);
  });

  it('refuses a customer outside the offer\'s segment', () => {
    const result = issuePersonalisedOffer({
      customerRef: 'c-1',
      coupon: { ...offer, eligibleTo: ['gold'] },
      consents: ['profiling', 'marketing'],
      customerSegments: ['regular'],
    });
    expect(result.outcome).toBe('not_in_segment');
  });
});

describe('a referral pays on a purchase, not on a sign-up', () => {
  const base = {
    referralId: 'REF-1',
    referrerRef: 'c-1',
    referredRef: 'c-2',
    qualifyingSpendMinor: 50_000,
    rewardMinor: 20_000,
    alreadyPaidReferralIds: [] as string[],
  };

  it('pays once the referred customer has actually spent', () => {
    const result = assessReferral({ ...base, referredPurchases: [{ netMinor: 60_000, at: '2026-08-04T10:00:00Z' }] });
    expect(result.payable).toBe(true);
    expect(result.rewardMinor).toBe(20_000);
  });

  it('REFUSES on a sign-up with no qualifying purchase', () => {
    const result = assessReferral({ ...base, referredPurchases: [] });
    expect(result.payable).toBe(false);
    expect(result.detail).toContain('pays on a purchase, not on a sign-up');
  });

  it('REFUSES A SELF-REFERRAL — the first thing anyone tries', () => {
    const direct = assessReferral({ ...base, referredRef: 'c-1', referredPurchases: [{ netMinor: 90_000, at: 'x' }] });
    expect(direct.outcome).toBe('self_referral');
    expect(direct.detail).toContain('cannot refer themselves');

    const disguised = assessReferral({
      ...base,
      referredPurchases: [{ netMinor: 90_000, at: 'x' }],
      sharedContacts: 1,
    });
    expect(disguised.outcome).toBe('self_referral');
    expect(disguised.detail).toContain('one person in two names');
  });

  it('never pays the same referral twice', () => {
    const result = assessReferral({
      ...base,
      referredPurchases: [{ netMinor: 90_000, at: 'x' }],
      alreadyPaidReferralIds: ['REF-1'],
    });
    expect(result.outcome).toBe('already_paid');
  });
});
