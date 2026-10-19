import { describe, it, expect } from 'vitest';
import {
  checkOnlineListing, listingLines, shopDetailsMissing, onlineStorePublishable, complaintClock, oneMonthAfter, taxInside,
  OTHER_SELLER_REFUSAL, TCS_LINE, NOT_SET, type OnlineListingFacts, type OnlineShopDetails,
} from '../../packages/storefront/src/listing-duties';

/** R4 · B23 · A26 — the pure rules for what the online store must show before payment, and whose goods it sells. */

const SHOP: OnlineShopDetails = {
  version: 1, legalName: 'Synthetic Stores Pvt Ltd', address: '1 Test Road', gstin: '33ABCDE1234F1Z5', returnTerms: 'as shown',
  grievanceOfficerName: 'Synthetic Officer', grievanceOfficerContact: 'officer@example.invalid', setBy: 'u', setAt: '2026-10-19T00:00:00.000Z',
};
const MILK: OnlineListingFacts = { productId: 'MILK', name: 'Milk', mrpMinor: 70_00, sellingPriceMinor: 60_00, taxRateBps: 500, carriesDate: true, bestBefore: '2026-12-31', countryOfOrigin: 'India', seller: { own: true } };
const FEE = { deliveryFeeMinor: 40_00 };

describe('online listing duties (B23)', () => {
  it('a product carrying every duty, with every shop detail set, may be published', () => {
    expect(checkOnlineListing(MILK, SHOP, FEE).publishable).toBe(true);
  });

  it('each missing duty is named, the first in the refusal — "online listing incomplete: <field>"', () => {
    const cases: [Partial<OnlineListingFacts>, string][] = [
      [{ mrpMinor: undefined }, 'MRP'], [{ taxRateBps: undefined }, 'selling price with tax'], [{ sellingPriceMinor: 0 }, 'selling price with tax'],
      [{ bestBefore: undefined }, 'best-before date'], [{ bestBefore: '31/12/2026' }, 'best-before date'], [{ countryOfOrigin: ' ' }, 'country of origin'],
    ];
    for (const [change, field] of cases) {
      const v = checkOnlineListing({ ...MILK, ...change } as OnlineListingFacts, SHOP, FEE);
      expect(v.publishable).toBe(false);
      expect(!v.publishable && v.refusal).toBe(`online listing incomplete: ${field}`);
    }
    expect(checkOnlineListing(MILK, SHOP, {}).publishable).toBe(false);
    // A product that carries no date needs none.
    expect(checkOnlineListing({ ...MILK, carriesDate: false, bestBefore: undefined } as OnlineListingFacts, SHOP, FEE).publishable).toBe(true);
    // A zero fee the owner SET is a fee (free delivery), not missing.
    expect(checkOnlineListing(MILK, SHOP, { deliveryFeeMinor: 0 }).publishable).toBe(true);
  });

  it('OB-223: without the grievance officer nothing can be published, and the store itself cannot open', () => {
    const pending = { ...SHOP, grievanceOfficerName: undefined, grievanceOfficerContact: undefined } as OnlineShopDetails;
    const v = checkOnlineListing(MILK, pending, FEE);
    expect(!v.publishable && [v.refusal, v.missing]).toEqual(['online listing incomplete: grievance officer name', ['grievance officer name', 'grievance officer contact']]);
    expect(onlineStorePublishable(pending)).toEqual({ publishable: false, missing: ['grievance officer name', 'grievance officer contact'], refusal: 'online listing incomplete: grievance officer name' });
    expect(onlineStorePublishable(undefined).missing).toEqual(['shop legal name', 'shop address', 'shop GSTIN', 'return and refund terms', 'grievance officer name', 'grievance officer contact']);
    expect(shopDetailsMissing({ ...SHOP, gstin: 'NOT-A-GSTIN' })).toEqual(['shop GSTIN']);
  });

  it('A26: another seller\'s goods — a concession tenant\'s — are refused first, whatever else they carry', () => {
    const v = checkOnlineListing({ ...MILK, seller: { own: false, sellerId: 'silks-counter' } }, SHOP, FEE);
    expect(!v.publishable && [v.refusal, v.otherSeller]).toEqual([OTHER_SELLER_REFUSAL, 'silks-counter']);
    expect(OTHER_SELLER_REFUSAL).toBe("other seller's goods: not sold online");
    expect(TCS_LINE).toBe('TCS (section 52): not applicable: own goods only');
  });

  it('what the customer reads: every duty, its value or "not set", and the total with the delivery fee', () => {
    const shown = listingLines(MILK, undefined, FEE, 2);
    expect(shown.lines.map((l) => l.field)).toEqual(['MRP', 'selling price with tax', 'delivery fee', 'best-before date', 'country of origin', 'shop legal name', 'shop address', 'shop GSTIN', 'return and refund terms', 'grievance officer name', 'grievance officer contact']);
    expect(shown.lines.find((l) => l.field === 'grievance officer name')!.value).toBe(NOT_SET);
    expect(shown.lines.find((l) => l.field === 'selling price with tax')!.value).toBe('₹60.00 including ₹2.86 GST at 5%');
    expect([shown.goodsMinor, shown.deliveryFeeMinor, shown.totalMinor]).toEqual([120_00, 40_00, 160_00]);
    expect(listingLines(MILK, SHOP, { deliveryFeeMinor: 40_00, freeDeliveryAboveMinor: 100_00 }, 2).lines.find((l) => l.field === 'delivery fee')!.value).toBe('free');
    expect(listingLines({ ...MILK, mrpMinor: undefined } as OnlineListingFacts, SHOP, {}).lines.slice(0, 3).map((l) => l.value)).toEqual([NOT_SET, '₹60.00 including ₹2.86 GST at 5%', NOT_SET]);
    expect(taxInside(118_00, 1_800)).toEqual({ netMinor: 100_00, taxMinor: 18_00 });
  });
});

describe('the online complaint clock (48 hours · one month)', () => {
  const opened = '2026-10-01T10:00:00.000Z';
  it('awaiting → overdue after 48 hours → acknowledged by a person\'s reply', () => {
    expect(complaintClock({ caseId: 'c', openedAt: opened, now: '2026-10-03T09:59:59.000Z' }).state).toBe('awaiting_acknowledgement');
    expect(complaintClock({ caseId: 'c', openedAt: opened, now: '2026-10-03T10:00:01.000Z' }).state).toBe('acknowledgement_overdue');
    expect(complaintClock({ caseId: 'c', openedAt: opened, acknowledgedAt: '2026-10-02T00:00:00.000Z', now: '2026-10-05T00:00:00.000Z' }).state).toBe('acknowledged');
  });
  it('unresolved past one calendar month is the owner\'s exception; resolved is not', () => {
    const late = complaintClock({ caseId: 'c', openedAt: opened, acknowledgedAt: '2026-10-02T00:00:00.000Z', now: '2026-11-01T10:00:01.000Z' });
    expect([late.state, late.ownerException]).toEqual(['redress_overdue', true]);
    expect(complaintClock({ caseId: 'c', openedAt: opened, now: '2026-11-01T09:59:59.000Z' }).ownerException).toBe(false);
    expect(complaintClock({ caseId: 'c', openedAt: opened, resolvedAt: '2026-10-20T00:00:00.000Z', now: '2026-12-01T00:00:00.000Z' }).state).toBe('resolved');
    // One month after 31 January is the last day of February — never 3 March.
    expect(oneMonthAfter('2027-01-31T10:00:00.000Z')).toBe('2027-02-28T10:00:00.000Z');
    expect(oneMonthAfter('2026-12-15T00:00:00.000Z')).toBe('2027-01-15T00:00:00.000Z');
  });
});
