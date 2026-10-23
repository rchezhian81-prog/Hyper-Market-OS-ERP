import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import type { ApiHarness } from '../support/api-harness';
import { testModePaymentProvider } from '../../packages/orders/src/payment-verification';
import { apiHarness } from '../support/api-harness';
import { seedOnlineShop, listShopOnline, callsFor, codeOf, OWNER, CASHIER, CUSTOMER, OTHER_CUSTOMER, STORE, MANAGER } from '../support/online-shop';

// WF-13 ("cart/promotion") · M20-FR-02 (§27 "coupon … loyalty") · P-02 one commerce truth. The online basket is priced by
// the SAME promotions engine and coupon engine as the till, from the shop's own registers:
//   • an offer launched at head office takes its money off the app's basket; a member price only for an app tied to a
//     loyalty membership; the coupon's answer is said by name and the price is the price without it when it does not apply;
//   • the order is placed at THAT price — paying the old, undiscounted figure is not taken as paid (a person looks);
//   • the coupon is spent ONCE, on the order: a second customer is told it is used up; a restart reads the same;
//   • the points balance is shown to a member; a cashier cannot price anyone's basket.
// In memory and on real PostgreSQL, with a cold restart.

const backings = useRestartableBackings();
const day = (offset: number): string => new Date(Date.now() + offset * 864e5).toISOString();
const MARGIN_OK = { description: 'offer (synthetic)', normalPrice: { minor: 6_000, currency: 'INR' }, promoPrice: { minor: 5_400, currency: 'INR' }, unitCost: { minor: 4_000, currency: 'INR' }, baselineUnits: 100, expectedUnits: 200 };
const BASKET = [{ productId: 'MILK', quantityMinor: 2 }, { productId: 'BROOM', quantityMinor: 1 }];

interface Quote { priced: boolean; goodsMinor: number; deliveryFeeMinor: number; payableMinor: number; promotions: { discountMinor: number; applied: { promotionId: string }[] }; coupon: { code: string; applied: boolean; outcome: string; discountMinor: number; detail: string } | null; points: { member: boolean; pointsBalance?: number; say: string } }

describe.each(backings)('the online basket gets the till\'s offers (WF-13 · M20-FR-02) — on $name', ({ harness }) => {
  it('promotions and a coupon priced by the till\'s engines; the order placed at that price; the coupon spent once; member price and points for a member; a restart reads the same', async () => {
    const provider = testModePaymentProvider();
    // The PostgreSQL backing builds its harness without the provider — the payment then stays pending; both prove the price.
    let h: ApiHarness = harness();
    const withProvider = (hh: ApiHarness): ApiHarness => (hh.store.constructor.name === 'InMemoryEventStore' ? apiHarness({ store: hh.store, paymentVerifier: provider }) : hh);
    h = withProvider(h);
    const T = randomUUID();
    const c = callsFor(() => h, T);
    const { req, ok } = c;
    await seedOnlineShop(h, T, c);
    await h.enableFeature(T, 'loyalty');
    await listShopOnline(c);
    const quote = async (who: string, body: Record<string, unknown>) => {
      const r = await req('POST', '/v1/storefront/cart/quote', body, who);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body as Quote;
    };

    // No offer yet: the published prices.
    const plain = await quote(CUSTOMER, { lines: BASKET });
    expect(plain).toMatchObject({ priced: true, goodsMinor: 270_00, payableMinor: 270_00, promotions: { discountMinor: 0 }, coupon: null });
    expect(plain.points.member).toBe(false);

    // Head office launches 10% off MILK and a member price on BROOM, and issues a single-use ₹20 coupon.
    await ok(req('POST', '/v1/promotions/milk-10/definition', { kind: 'percent_off', percentBps: 1_000, productIds: ['MILK'], startsAt: day(-1), endsAt: day(30) }), 'define milk-10');
    await ok(req('POST', '/v1/promotions/milk-10/launch', MARGIN_OK), 'launch milk-10');
    await ok(req('POST', '/v1/promotions/broom-member/definition', { kind: 'member_price', memberUnitPrice: { minor: 140_00, currency: 'INR' }, productIds: ['BROOM'], startsAt: day(-1), endsAt: day(30) }), 'define broom-member');
    await ok(req('POST', '/v1/promotions/broom-member/launch', { ...MARGIN_OK, normalPrice: { minor: 15_000, currency: 'INR' }, promoPrice: { minor: 14_000, currency: 'INR' }, unitCost: { minor: 9_000, currency: 'INR' } }), 'launch broom-member');
    await ok(req('POST', '/v1/loyalty/coupons/SAVE20', { kind: 'amount_off', valueMinor: 20_00, validUntil: day(30).slice(0, 10), maxRedemptions: 1, maxPerCustomer: 1, minimumBasketMinor: 100_00 }), 'coupon SAVE20');

    const offered = await quote(CUSTOMER, { lines: BASKET, couponCode: 'SAVE20' });
    expect(offered.goodsMinor).toBe(270_00);
    expect(offered.promotions.discountMinor).toBe(12_00); // 10% of 2 × ₹60; the member price is not this customer's
    expect(offered.promotions.applied.map((a) => a.promotionId)).toEqual(['milk-10']);
    expect(offered.coupon).toMatchObject({ code: 'SAVE20', applied: true, outcome: 'redeemed', discountMinor: 20_00 });
    expect(offered.payableMinor).toBe(238_00);
    // A code the shop never issued is said by name; the price is the price without it.
    expect((await quote(CUSTOMER, { lines: BASKET, couponCode: 'NOPE1' })).coupon).toMatchObject({ applied: false, outcome: 'unknown_code', discountMinor: 0 });
    // A delivery adds the shop's fee on what the goods now cost.
    expect((await quote(CUSTOMER, { lines: BASKET, fulfilment: 'delivery' }))).toMatchObject({ deliveryFeeMinor: 40_00, payableMinor: 258_00 + 40_00 });

    // A basket that cannot be read, and a cashier, are refused.
    expect(codeOf(await req('POST', '/v1/storefront/cart/quote', { lines: [], couponCode: 'SAVE20' }, CUSTOMER))).toBe('not_readable_as_a_basket');
    expect(codeOf(await req('POST', '/v1/storefront/cart/quote', { lines: BASKET, couponCode: 'bad code!' }, CUSTOMER))).toBe('not_readable_as_a_basket');
    expect((await req('POST', '/v1/storefront/cart/quote', { lines: BASKET }, CASHIER)).status).toBe(403);

    // The old undiscounted figure is not the shop's price: not taken as paid — a person must look.
    provider.capture('tok-old', 270_00);
    const wrong = await ok(req('POST', '/v1/storefront/orders/ORD-OLD', { lines: BASKET, locationId: STORE, payment: { providerRef: 'tok-old', amountMinor: 270_00, result: 'authorised' } }, OTHER_CUSTOMER), 'place at the old figure');
    expect(wrong.body).toMatchObject({ amountMismatch: true, payment: { state: 'pending' } });

    // Placed at the shop's price, with the coupon: the coupon is spent once, on this order.
    provider.capture('tok-1', 238_00);
    const placed = await ok(req('POST', '/v1/storefront/orders/ORD-1', { lines: BASKET, locationId: STORE, couponCode: 'SAVE20', payment: { providerRef: 'tok-1', amountMinor: 238_00, result: 'authorised' } }, CUSTOMER), 'place ORD-1');
    const pb = placed.body as { quote: { itemsMinor: number; offers: { coupon: { applied: boolean } } }; amountMismatch?: boolean; payment: { state: string } };
    expect(pb.quote.itemsMinor).toBe(238_00);
    expect(pb.quote.offers.coupon.applied).toBe(true);
    expect(pb.amountMismatch).toBeUndefined();
    const used = (await req('GET', '/v1/loyalty/coupons/SAVE20')).body as { redemptionCount: number; redemptions: { redemptionId: string; saleId: string }[] };
    expect(used.redemptionCount).toBe(1);
    expect(used.redemptions[0]).toMatchObject({ redemptionId: 'online-ORD-1', saleId: 'ORD-1' });
    // The second customer is told it is used up — never a silent discount twice (hard rule #10).
    expect((await quote(OTHER_CUSTOMER, { lines: BASKET, couponCode: 'SAVE20' })).coupon).toMatchObject({ applied: false, outcome: 'limit_reached', discountMinor: 0 });

    // A member: the desk enrols the customer and ties their app; member price and the points balance appear.
    for (const [key, value] of [['loyalty.point_value_paise', 100]] as const) {
      await ok(req('PUT', `/v1/platform/setup/${key}`, { value }), `setting ${key}`);
    }
    await ok(req('POST', '/v1/loyalty/members', { mobile: '9840011223', consent: true, verifiedHow: 'seen_on_phone' }, MANAGER), 'enrol');
    await ok(req('POST', '/v1/loyalty/members/app-link', { mobile: '9840011223', appCustomerRef: OTHER_CUSTOMER, verifiedHow: 'seen_on_phone' }, MANAGER), 'tie the app');
    const member = await quote(OTHER_CUSTOMER, { lines: BASKET });
    expect(member.promotions.applied.map((a) => a.promotionId)).toEqual(['broom-member', 'milk-10']);
    expect(member.promotions.discountMinor).toBe(12_00 + 10_00);
    expect(member.points).toMatchObject({ member: true, pointsBalance: 0 });
    expect(member.points.say).toBe('You have 0 point(s), worth ₹0.00 at the till.');

    // A cold restart: the coupon is still spent (the redemption is durable).
    h = withProvider(harness(h));
    expect((await quote(OTHER_CUSTOMER, { lines: BASKET, couponCode: 'SAVE20' })).coupon).toMatchObject({ applied: false, outcome: 'limit_reached' });
    expect(((await req('GET', '/v1/loyalty/coupons/SAVE20', undefined, OWNER)).body as { redemptionCount: number }).redemptionCount).toBe(1);
  });
});
