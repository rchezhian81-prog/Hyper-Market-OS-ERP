// The online basket's price (WF-13 "cart/promotion" · M20-FR-02 · §27 "coupon … loyalty" · P-02 one commerce truth).
//
// The till prices a basket with the promotions engine (`bestPrice`) and honours a coupon with the coupon engine
// (`redeemCoupon`). The online basket used neither: an offer on the shelf was not an offer in the app. Now the app's
// basket is priced by THE SAME TWO ENGINES, from the shop's own published prices and its own promotion register:
//   1. the promotions in force (only active, in-window, eligible ones — the engine's own rule), member prices only for a
//      signed-in customer whose app is tied to a loyalty membership; never onto a carry bag (OB-173);
//   2. then a coupon, if the customer typed one, checked against the WHOLE redemption history at that moment — expired,
//      used up, not theirs, basket too small: said by name, and the price is the price without it;
//   3. then the delivery fee on what the goods now cost.
// Pure and deterministic: no clock, no I/O. Whole paise throughout.

import { bestPrice, type Promotion, type AppliedPromotion } from '../../promotions/src/promotions';
import { redeemCoupon, type Coupon, type Redemption, type RedeemOutcome } from '../../loyalty/src/coupons';
import { money } from '../../contracts/src/money';

export interface PricedLine { readonly productId: string; readonly quantityMinor: number; readonly unitPriceMinor: number; readonly carryBag?: boolean }

export interface CouponAnswer {
  readonly code: string;
  readonly applied: boolean;
  readonly outcome: RedeemOutcome;
  readonly discountMinor: number;
  readonly detail: string;
}

export interface OnlineBasketPrice {
  /** What the goods cost at the shop's published prices, before any offer. */
  readonly goodsMinor: number;
  readonly promotionDiscountMinor: number;
  readonly promotions: readonly { readonly promotionId: string; readonly kind: AppliedPromotion['kind']; readonly discountMinor: number }[];
  /** Each line's share of the promotions' saving (sums to `promotionDiscountMinor`). */
  readonly lines: readonly (PricedLine & { readonly lineMinor: number; readonly discountMinor: number })[];
  readonly coupon: CouponAnswer | null;
  /** The goods after promotions and the coupon — what the delivery fee is judged on. */
  readonly goodsAfterOffersMinor: number;
  readonly deliveryFeeMinor: number;
  /** What the customer pays: goods after offers, plus the delivery fee. */
  readonly payableMinor: number;
}

export function priceOnlineBasket(input: {
  readonly lines: readonly PricedLine[];
  readonly promotions: readonly Promotion[];
  /** The instant the price is for (decides which promotions are in their window, and the coupon's validity). */
  readonly at: string;
  /** A signed-in customer whose app is tied to a loyalty membership — member prices apply. */
  readonly isMember: boolean;
  readonly couponCode?: string;
  readonly coupon?: Coupon;
  /** Every redemption of that code head office holds — the authoritative set. */
  readonly couponRedemptions?: readonly Redemption[];
  /** Who is buying and the order the coupon would be spent on (the redemption's id is the order's). */
  readonly customerRef: string;
  readonly orderRef: string;
  readonly customerSegments?: readonly string[];
  /** The shop's delivery fee for goods of a value (0 for a pickup). */
  readonly deliveryFeeFor: (goodsMinor: number) => number;
}): OnlineBasketPrice {
  const basket = input.lines.filter((l) => l.quantityMinor > 0).map((l, i) => ({
    lineId: `l${i}`, productId: l.productId, unitPrice: money(l.unitPriceMinor, 'INR'), qty: l.quantityMinor, ...(l.carryBag === true ? { carryBag: true } : {}),
  }));
  const code = input.couponCode?.trim();
  const result = bestPrice(basket, input.promotions, { at: input.at, currency: 'INR', isMember: input.isMember, ...(code === undefined || code === '' ? {} : { coupons: [code] }) });
  const share = new Map(result.perLine.map((p) => [p.lineId, p.discountMinor]));
  const lines = input.lines.filter((l) => l.quantityMinor > 0).map((l, i) => ({ ...l, lineMinor: l.unitPriceMinor * l.quantityMinor, discountMinor: share.get(`l${i}`) ?? 0 }));
  const afterPromotions = result.netTotal.minor;
  let coupon: CouponAnswer | null = null;
  if (code !== undefined && code !== '') {
    const r = redeemCoupon({
      coupon: input.coupon,
      redemption: { redemptionId: `online-${input.orderRef}`, code, customerRef: input.customerRef, at: input.at, saleId: input.orderRef },
      knownRedemptions: input.couponRedemptions ?? [],
      basketMinor: afterPromotions,
      ...(input.customerSegments === undefined ? {} : { customerSegments: input.customerSegments }),
    });
    coupon = { code, applied: r.redeemed, outcome: r.outcome, discountMinor: r.redeemed ? r.discountMinor : 0, detail: r.detail };
  }
  const goodsAfterOffersMinor = Math.max(0, afterPromotions - (coupon?.discountMinor ?? 0));
  const deliveryFeeMinor = Math.max(0, Math.trunc(input.deliveryFeeFor(goodsAfterOffersMinor)));
  return {
    goodsMinor: result.grossTotal.minor,
    promotionDiscountMinor: result.discount.minor,
    promotions: result.applied.map((a) => ({ promotionId: a.promotionId, kind: a.kind, discountMinor: a.discount.minor })),
    lines, coupon, goodsAfterOffersMinor, deliveryFeeMinor,
    payableMinor: goodsAfterOffersMinor + deliveryFeeMinor,
  };
}
