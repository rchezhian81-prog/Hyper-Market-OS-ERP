import { describe, it, expect } from 'vitest';
import { draftPersonalOffers, offerGate, priceTheOffer, offersInCapWindow, OFFER_CAP, InvalidOfferDraftError, type OfferMember } from '../../packages/loyalty/src/next-best-offer';

/** D-22 (R4, signed OB-227): the engine that drafts personal offers — consent, an adult, the cap, cost and MRP floors. */
const adult = (ref: string, over: Partial<OfferMember> = {}): OfferMember => ({ customerRef: ref, profilingConsent: true, marketingConsent: true, age: 'adult', ...over });

describe('next-best-offer drafting (D-22)', () => {
  it('drafts the member\'s most-bought product (bills, then quantity, then code) at the person\'s discount', () => {
    const r = draftPersonalOffers({
      members: [adult('M1')],
      purchases: [
        { customerRef: 'M1', saleId: 's1', productId: 'tea', quantityMinor: 1, day: '2030-01-02' },
        { customerRef: 'M1', saleId: 's2', productId: 'tea', quantityMinor: 1, day: '2030-01-03' },
        { customerRef: 'M1', saleId: 's2', productId: 'rice', quantityMinor: 9, day: '2030-01-03' },
        { customerRef: 'M1', saleId: 's3', productId: 'oil', quantityMinor: 1, day: '2029-12-01' }, // before the look-back
      ],
      pricing: () => ({ priceMinor: 10_000, mrpMinor: 12_000, costMinor: 6_000 }), issuedDays: () => [],
      discountBps: 1_500, fromDay: '2030-01-01', asOfDay: '2030-01-10',
    });
    expect(r.offers.map((o) => [o.customerRef, o.productId, o.offerPriceMinor, o.discountMinor])).toEqual([['M1', 'tea', 8_500, 1_500]]);
    expect(r.excluded).toEqual([]);
  });

  it('no consent, a child or an unknown age, and no history are left out by name', () => {
    expect(offerGate(adult('a', { marketingConsent: false }), [], '2030-01-10')).toBe('no_consent');
    expect(offerGate(adult('a', { profilingConsent: false }), [], '2030-01-10')).toBe('no_consent');
    expect(offerGate(adult('a', { age: 'child' }), [], '2030-01-10')).toBe('child_or_age_unknown');
    expect(offerGate(adult('a', { age: 'unknown' }), [], '2030-01-10')).toBe('child_or_age_unknown');
    const r = draftPersonalOffers({ members: [adult('M-none')], purchases: [], pricing: () => ({}), issuedDays: () => [], discountBps: 500, fromDay: '2030-01-01', asOfDay: '2030-01-10' });
    expect(r.excluded).toEqual([{ customerRef: 'M-none', reason: 'no_purchase_history', words: 'no purchase history in the look-back' }]);
  });

  it('OB-42: 2 offers in 7 days is the cap — the 7-day window is inclusive of today', () => {
    expect(OFFER_CAP).toEqual({ offers: 2, days: 7 });
    expect(offersInCapWindow(['2030-01-04', '2030-01-10'], '2030-01-10')).toBe(2);
    expect(offersInCapWindow(['2030-01-03', '2030-01-10'], '2030-01-10')).toBe(1); // 8 days back is out of the window
    expect(offerGate(adult('a'), ['2030-01-04', '2030-01-09'], '2030-01-10')).toBe('cap_reached');
    expect(offerGate(adult('a'), ['2030-01-09'], '2030-01-10')).toBeUndefined();
  });

  it('never below cost, never above MRP; an unknown price, cost or MRP is said, never taken as zero', () => {
    expect(priceTheOffer({ priceMinor: 10_000, mrpMinor: 12_000, costMinor: 9_000 }, 1_000)).toEqual({ ok: true, offerPriceMinor: 9_000, discountMinor: 1_000 }); // at cost is allowed
    expect(priceTheOffer({ priceMinor: 10_000, mrpMinor: 12_000, costMinor: 9_001 }, 1_000)).toEqual({ ok: false, reason: 'below_cost' });
    expect(priceTheOffer({ priceMinor: 13_000, mrpMinor: 12_000, costMinor: 1 }, 500)).toEqual({ ok: false, reason: 'above_mrp' });
    expect(priceTheOffer({ mrpMinor: 12_000, costMinor: 1 }, 500)).toEqual({ ok: false, reason: 'price_not_known' });
    expect(priceTheOffer({ priceMinor: 10_000, mrpMinor: 12_000 }, 500)).toEqual({ ok: false, reason: 'cost_not_known' });
    expect(priceTheOffer({ priceMinor: 10_000, costMinor: 1 }, 500)).toEqual({ ok: false, reason: 'mrp_not_known' });
  });

  it('a discount outside 1–9999 basis points or a back-to-front look-back is refused', () => {
    const base = { members: [], purchases: [], pricing: () => ({}), issuedDays: () => [], fromDay: '2030-01-01', asOfDay: '2030-01-10' };
    expect(() => draftPersonalOffers({ ...base, discountBps: 0 })).toThrow(InvalidOfferDraftError);
    expect(() => draftPersonalOffers({ ...base, discountBps: 10_000 })).toThrow(InvalidOfferDraftError);
    expect(() => draftPersonalOffers({ ...base, discountBps: 500, fromDay: '2030-02-01' })).toThrow(InvalidOfferDraftError);
  });
});
