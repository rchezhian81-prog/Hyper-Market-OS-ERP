import { describe, it, expect } from 'vitest';
import { priceOnlineBasket } from '../../packages/storefront/src/online-pricing';
import type { Promotion } from '../../packages/promotions/src/promotions';
import type { Coupon } from '../../packages/loyalty/src/coupons';

// WF-13 · M20-FR-02 · P-02: the online basket's price — promotions first (the till's engine), then a coupon (the till's
// coupon engine, against the whole redemption history), then the delivery fee on what the goods now cost.

const AT = '2026-10-23T10:00:00.000Z';
const milk10: Promotion = { id: 'milk-10', kind: 'percent_off', percentBps: 1_000, productIds: ['MILK'], startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-11-01T00:00:00.000Z', status: 'active' };
const bagFree: Promotion = { id: 'everything-50', kind: 'percent_off', percentBps: 5_000, startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-11-01T00:00:00.000Z', status: 'active' };
const memberBroom: Promotion = { id: 'broom-member', kind: 'member_price', memberUnitPrice: { minor: 140_00, currency: 'INR' }, productIds: ['BROOM'], startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-11-01T00:00:00.000Z', status: 'active' };
const save20: Coupon = { code: 'SAVE20', kind: 'amount_off', valueMinor: 20_00, issuedAt: '2026-10-01T00:00:00.000Z', validUntil: '2026-10-31', maxRedemptions: 1, maxPerCustomer: 1, minimumBasketMinor: 100_00 };
const lines = [{ productId: 'MILK', quantityMinor: 2, unitPriceMinor: 60_00 }, { productId: 'BROOM', quantityMinor: 1, unitPriceMinor: 150_00 }];
const base = { lines, at: AT, customerRef: 'cust-1', orderRef: 'ORD-1', deliveryFeeFor: () => 0 };

describe('the online basket is priced by the till\'s engines (WF-13)', () => {
  it('a launched offer comes off; a draft or out-of-window one never does', () => {
    const p = priceOnlineBasket({ ...base, promotions: [milk10, { ...milk10, id: 'draft', status: 'draft' }, { ...milk10, id: 'old', endsAt: '2026-10-02T00:00:00.000Z' }], isMember: false });
    expect(p).toMatchObject({ goodsMinor: 270_00, promotionDiscountMinor: 12_00, payableMinor: 258_00, coupon: null });
    expect(p.promotions.map((x) => x.promotionId)).toEqual(['milk-10']);
    expect(p.lines.map((l) => l.discountMinor)).toEqual([12_00, 0]);
  });

  it('a member price only for a member', () => {
    expect(priceOnlineBasket({ ...base, promotions: [memberBroom], isMember: false }).promotionDiscountMinor).toBe(0);
    expect(priceOnlineBasket({ ...base, promotions: [memberBroom], isMember: true }).promotionDiscountMinor).toBe(10_00);
  });

  it('a coupon after the offers, judged on what the goods then cost; refused by name otherwise', () => {
    const ok = priceOnlineBasket({ ...base, promotions: [milk10], isMember: false, couponCode: 'SAVE20', coupon: save20, couponRedemptions: [] });
    expect(ok.coupon).toMatchObject({ code: 'SAVE20', applied: true, outcome: 'redeemed', discountMinor: 20_00 });
    expect(ok.payableMinor).toBe(238_00);
    const used = priceOnlineBasket({ ...base, promotions: [milk10], isMember: false, couponCode: 'SAVE20', coupon: save20, couponRedemptions: [{ redemptionId: 'online-ORD-0', code: 'SAVE20', customerRef: 'cust-2', at: AT, saleId: 'ORD-0' }] });
    expect(used.coupon).toMatchObject({ applied: false, outcome: 'limit_reached', discountMinor: 0 });
    expect(used.payableMinor).toBe(258_00);
    const small = priceOnlineBasket({ ...base, lines: [{ ...lines[0]!, quantityMinor: 1 }], promotions: [], isMember: false, couponCode: 'SAVE20', coupon: save20 });
    expect(small.coupon).toMatchObject({ applied: false, outcome: 'basket_too_small' });
    expect(priceOnlineBasket({ ...base, promotions: [], isMember: false, couponCode: 'NOPE', couponRedemptions: [] }).coupon).toMatchObject({ outcome: 'unknown_code', applied: false });
  });

  it('never a carry bag discounted; the fee on the goods after offers', () => {
    const p = priceOnlineBasket({ ...base, lines: [...lines, { productId: 'BAG', quantityMinor: 1, unitPriceMinor: 10_00, carryBag: true }], promotions: [bagFree], isMember: false, deliveryFeeFor: (g) => (g >= 200_00 ? 0 : 40_00) });
    expect(p.lines.find((l) => l.productId === 'BAG')!.discountMinor).toBe(0);
    expect(p.promotionDiscountMinor).toBe(135_00);
    expect(p.goodsAfterOffersMinor).toBe(145_00);
    expect(p.deliveryFeeMinor).toBe(40_00);
    expect(p.payableMinor).toBe(185_00);
  });
});
