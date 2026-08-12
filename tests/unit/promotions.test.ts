import { describe, it, expect } from 'vitest';
import {
  bestPrice,
  type BasketLine,
  type Promotion,
  type PromoContext,
} from '../../packages/promotions/src/index';
import { money } from '../../packages/contracts/src/money';

// The promotions engine yields a deterministic best price: an expired/unpublished
// promotion never applies, exclusive promotions compete, others stack, and the
// result is identical online and offline (M05-FR-03).

const NOW = '2026-08-02T12:00:00Z';

const ctx: PromoContext = { at: NOW, currency: 'INR', isMember: false };

function line(lineId: string, productId: string, unitMinor: number, qty: number, group?: string): BasketLine {
  return { lineId, productId, unitPrice: money(unitMinor, 'INR'), qty, group };
}

function promo(overrides: Partial<Promotion> & Pick<Promotion, 'id' | 'kind'>): Promotion {
  return {
    startsAt: '2026-08-01T00:00:00Z',
    endsAt: '2026-08-31T23:59:59Z',
    status: 'active',
    ...overrides,
  } as Promotion;
}

describe('bestPrice', () => {
  it('applies a percent-off to the eligible products', () => {
    const lines = [line('l1', 'p1', 100_00, 1), line('l2', 'p2', 50_00, 1)];
    const promos = [promo({ id: 'promo-10pc', kind: 'percent_off', productIds: ['p1'], percentBps: 1000 })];
    const result = bestPrice(lines, promos, ctx);
    expect(result.grossTotal).toEqual(money(150_00, 'INR'));
    expect(result.discount).toEqual(money(10_00, 'INR')); // 10% of ₹100
    expect(result.netTotal).toEqual(money(140_00, 'INR'));
    expect(result.applied).toHaveLength(1);
  });

  it('attributes a TARGETED promotion only to the lines it applied to (perLine, CGST s.15(3))', () => {
    // 10% off p1 (₹100) only; p2 (₹200) is untouched. The ₹10 saving must sit entirely on l1.
    const lines = [line('l1', 'p1', 100_00, 1), line('l2', 'p2', 200_00, 1)];
    const result = bestPrice(lines, [promo({ id: 'p1-10pc', kind: 'percent_off', productIds: ['p1'], percentBps: 1000 })], ctx);
    expect(result.perLine).toEqual([
      { lineId: 'l1', discountMinor: 10_00 },
      { lineId: 'l2', discountMinor: 0 },
    ]);
    expect(result.perLine.reduce((s, p) => s + p.discountMinor, 0)).toBe(result.discount.minor); // sums exactly
  });

  it('spreads a BASKET-WIDE discount across the lines by value', () => {
    // ₹30 off the whole basket (no productIds) over ₹100 + ₹200 → ₹10 and ₹20 (1:2).
    const lines = [line('l1', 'p1', 100_00, 1), line('l2', 'p2', 200_00, 1)];
    const result = bestPrice(lines, [promo({ id: 'basket-30', kind: 'amount_off', amountOffMinor: 30_00 })], ctx);
    expect(result.perLine).toEqual([
      { lineId: 'l1', discountMinor: 10_00 },
      { lineId: 'l2', discountMinor: 20_00 },
    ]);
  });

  it('reports a zero per-line discount for every line when no promotion applies', () => {
    const lines = [line('l1', 'p1', 100_00, 1), line('l2', 'p2', 200_00, 1)];
    const result = bestPrice(lines, [], ctx);
    expect(result.perLine).toEqual([
      { lineId: 'l1', discountMinor: 0 },
      { lineId: 'l2', discountMinor: 0 },
    ]);
  });

  it('never applies an expired or unpublished promotion (§31)', () => {
    const lines = [line('l1', 'p1', 100_00, 1)];
    const expired = promo({
      id: 'old',
      kind: 'percent_off',
      percentBps: 5000,
      endsAt: '2026-07-31T23:59:59Z', // ended before NOW
    });
    const draft = promo({ id: 'draft', kind: 'percent_off', percentBps: 5000, status: 'draft' });
    const result = bestPrice(lines, [expired, draft], ctx);
    expect(result.discount).toEqual(money(0, 'INR'));
    expect(result.applied).toHaveLength(0);
  });

  it('applies a fixed amount-off coupon only when the min spend is met', () => {
    const belowMin = bestPrice(
      [line('l1', 'p1', 40_00, 1)],
      [promo({ id: 'c', kind: 'amount_off', amountOffMinor: 10_00, minSpendMinor: 50_00, requiresCoupon: 'SAVE10' })],
      { ...ctx, coupons: ['SAVE10'] },
    );
    expect(belowMin.discount).toEqual(money(0, 'INR')); // spend ₹40 < ₹50

    const atMin = bestPrice(
      [line('l1', 'p1', 60_00, 1)],
      [promo({ id: 'c', kind: 'amount_off', amountOffMinor: 10_00, minSpendMinor: 50_00, requiresCoupon: 'SAVE10' })],
      { ...ctx, coupons: ['SAVE10'] },
    );
    expect(atMin.discount).toEqual(money(10_00, 'INR'));
  });

  it('does not apply a coupon that was not presented', () => {
    const result = bestPrice(
      [line('l1', 'p1', 60_00, 1)],
      [promo({ id: 'c', kind: 'amount_off', amountOffMinor: 10_00, requiresCoupon: 'SAVE10' })],
      ctx, // no coupons
    );
    expect(result.discount).toEqual(money(0, 'INR'));
  });

  it('applies buy-one-get-one: the cheapest unit in each pair is free', () => {
    // 3 units at ₹100, ₹100, ₹60 → buy 1 get 1 → one pair → cheapest of the pair free
    const lines = [line('l1', 'p1', 100_00, 2), line('l2', 'p1', 60_00, 1)];
    const promos = [promo({ id: 'bogo', kind: 'buy_x_get_y', productIds: ['p1'], buyQty: 1, getQty: 1 })];
    const result = bestPrice(lines, promos, ctx);
    // 3 units → one full (1+1) block → 1 cheapest unit (₹60) free
    expect(result.discount).toEqual(money(60_00, 'INR'));
  });

  it('caps a repeatable promo at its abuse limit', () => {
    // 4 units → two BOGO pairs normally, but maxApplications 1 → only one free unit
    const lines = [line('l1', 'p1', 100_00, 4)];
    const promos = [
      promo({ id: 'bogo', kind: 'buy_x_get_y', productIds: ['p1'], buyQty: 1, getQty: 1, maxApplications: 1 }),
    ];
    const result = bestPrice(lines, promos, ctx);
    expect(result.discount).toEqual(money(100_00, 'INR')); // one free unit only
  });

  it('applies member pricing only for members', () => {
    const lines = [line('l1', 'p1', 100_00, 2)];
    const promos = [
      promo({ id: 'mem', kind: 'member_price', productIds: ['p1'], memberUnitPrice: money(90_00, 'INR') }),
    ];
    expect(bestPrice(lines, promos, ctx).discount).toEqual(money(0, 'INR')); // not a member
    const asMember = bestPrice(lines, promos, { ...ctx, isMember: true });
    expect(asMember.discount).toEqual(money(20_00, 'INR')); // ₹10 off × 2 units
  });

  it('within an exclusive group only the single best promotion applies', () => {
    const lines = [line('l1', 'p1', 100_00, 1)];
    const promos = [
      promo({ id: 'a-5pc', kind: 'percent_off', productIds: ['p1'], percentBps: 500, exclusiveGroup: 'g1' }),
      promo({ id: 'b-20pc', kind: 'percent_off', productIds: ['p1'], percentBps: 2000, exclusiveGroup: 'g1' }),
    ];
    const result = bestPrice(lines, promos, ctx);
    expect(result.discount).toEqual(money(20_00, 'INR')); // best of the group (20%)
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.promotionId).toBe('b-20pc');
  });

  it('stacks non-exclusive promotions', () => {
    const lines = [line('l1', 'p1', 100_00, 1), line('l2', 'p2', 100_00, 1)];
    const promos = [
      promo({ id: 'p1off', kind: 'percent_off', productIds: ['p1'], percentBps: 1000 }),
      promo({ id: 'p2off', kind: 'percent_off', productIds: ['p2'], percentBps: 2000 }),
    ];
    const result = bestPrice(lines, promos, ctx);
    expect(result.discount).toEqual(money(30_00, 'INR')); // ₹10 + ₹20
    expect(result.applied).toHaveLength(2);
  });

  it('is deterministic regardless of promotion input order', () => {
    const lines = [line('l1', 'p1', 100_00, 1)];
    const a = promo({ id: 'a', kind: 'percent_off', productIds: ['p1'], percentBps: 500, exclusiveGroup: 'g' });
    const b = promo({ id: 'b', kind: 'percent_off', productIds: ['p1'], percentBps: 2000, exclusiveGroup: 'g' });
    const r1 = bestPrice(lines, [a, b], ctx);
    const r2 = bestPrice(lines, [b, a], ctx);
    expect(r1).toEqual(r2);
  });

  it('never discounts below zero', () => {
    const lines = [line('l1', 'p1', 10_00, 1)];
    const promos = [promo({ id: 'huge', kind: 'amount_off', amountOffMinor: 999_00 })];
    const result = bestPrice(lines, promos, ctx);
    expect(result.discount).toEqual(money(10_00, 'INR')); // capped at gross
    expect(result.netTotal).toEqual(money(0, 'INR'));
  });
});
