import { describe, it, expect } from 'vitest';
import { pointsToGiveBack, refundRoomOutsidePoints } from '../../packages/loyalty/src/index';
import { giveBackOnReturn, type LoyaltyEffectsDeps, type ReturnGiveBack, type PointsSpentOnSale } from '../../services/customer/src/loyalty-effects';
import { ConcurrencyConflictError } from '../../packages/persistence/src/event-store';
import { buildDayBook, refundLegs, returnedValue, type DayBookReturn } from '../../packages/finance/src/day-book';

/**
 * OB-34 "A" (owner decision, 10 Oct 2026): on a return, the points the customer PAID WITH are given back automatically —
 * in proportion to the returned part of the bill, once, under the member's write guards, with the liability posted. The
 * money side of such a return is only the money share of the goods, so a return never turns points into rupees and never
 * pays the points part twice.
 */
describe('OB-34: the points a member paid with come back on a return, in proportion', () => {
  it('gives back in proportion to the goods returned, cumulatively, never past what was spent', () => {
    // A ₹1,000 bill, 20 points spent. Half comes back, then the other half: 10 + 10, exactly the 20.
    expect(pointsToGiveBack({ spent: 20, saleTotalMinor: 100_000, returnedValueMinor: 50_000, priorReturnedValueMinor: 0, priorGivenBack: 0 })).toBe(10);
    expect(pointsToGiveBack({ spent: 20, saleTotalMinor: 100_000, returnedValueMinor: 50_000, priorReturnedValueMinor: 50_000, priorGivenBack: 10 })).toBe(10);
    // Three thirds round down each time but add up to the whole on the last.
    const a = pointsToGiveBack({ spent: 10, saleTotalMinor: 30_000, returnedValueMinor: 10_000, priorReturnedValueMinor: 0, priorGivenBack: 0 });
    const b = pointsToGiveBack({ spent: 10, saleTotalMinor: 30_000, returnedValueMinor: 10_000, priorReturnedValueMinor: 10_000, priorGivenBack: a });
    const c = pointsToGiveBack({ spent: 10, saleTotalMinor: 30_000, returnedValueMinor: 10_000, priorReturnedValueMinor: 20_000, priorGivenBack: a + b });
    expect([a, b, c]).toEqual([3, 3, 4]);
    // More goods than the bill (a wrong record) still gives back no more than was spent; nothing spent gives nothing.
    expect(pointsToGiveBack({ spent: 20, saleTotalMinor: 100_000, returnedValueMinor: 500_000, priorReturnedValueMinor: 0, priorGivenBack: 0 })).toBe(20);
    expect(pointsToGiveBack({ spent: 0, saleTotalMinor: 100_000, returnedValueMinor: 50_000, priorReturnedValueMinor: 0, priorGivenBack: 0 })).toBe(0);
  });

  it('caps the money refund at the money share of the goods coming back (the points share comes back as points)', () => {
    const tenders = [{ kind: 'loyalty_points', amountMinor: 20_000 }, { kind: 'cash', amountMinor: 80_000 }];
    // ₹1,000 bill, ₹200 in points. Half the goods back → at most ₹400 in money (₹100 comes back as points).
    expect(refundRoomOutsidePoints({ totalMinor: 100_000, tenders, priorRefundsMinor: 0, returnedValueMinor: 50_000 })).toBe(40_000);
    // The other half later → the remaining ₹400.
    expect(refundRoomOutsidePoints({ totalMinor: 100_000, tenders, priorRefundsMinor: 40_000, returnedValueMinor: 100_000 })).toBe(40_000);
    // Without a value for the goods the cap stays the coarse one; a bill with no points has no cap here.
    expect(refundRoomOutsidePoints({ totalMinor: 100_000, tenders, priorRefundsMinor: 0 })).toBe(80_000);
    expect(refundRoomOutsidePoints({ totalMinor: 100_000, tenders: [{ kind: 'cash', amountMinor: 100_000 }], priorRefundsMinor: 0, returnedValueMinor: 50_000 })).toBeUndefined();
  });

  const stubDeps = (spent: PointsSpentOnSale | undefined, opts: { conflictOnce?: boolean } = {}) => {
    const giveBacks: ReturnGiveBack[] = [];
    let version = 0;
    let conflict = opts.conflictOnce === true;
    const deps: LoyaltyEffectsDeps = {
      rule: () => ({ pointsPer100Inr: 1, pointValuePaise: 100 }) as never,
      memberHistory: () => [],
      saleLoyalty: async () => ({ takeBacks: [], giveBacks: [...giveBacks] }),
      pointsBalance: () => 0,
      pointsVersion: () => version,
      recordEarn: async () => {},
      recordTakeBack: async () => {},
      pointsSpentOnSale: async () => spent,
      recordGiveBack: async (_t, _s, g, _at, expected) => {
        if (conflict) { conflict = false; version += 1; throw new ConcurrencyConflictError('points:m', expected); }
        if (expected !== version) throw new ConcurrencyConflictError('points:m', expected);
        version += 1;
        giveBacks.push(g);
      },
      now: () => '2026-10-10T10:00:00.000Z',
    };
    return { deps, giveBacks };
  };

  it('records each give-back once per return, valued at what the points were worth when spent, re-reading on a guard conflict', async () => {
    const { deps, giveBacks } = stubDeps({ memberRef: 'm-1', saleTotalMinor: 100_000, pointsApplied: 20, appliedMinor: 2_000 }, { conflictOnce: true });
    expect(await giveBackOnReturn(deps, 'T', 'S-1', 'RT-1', 50_000)).toMatchObject({ outcome: 'given_back', points: 10, valueMinor: 1_000 });
    // The same return again (a till resend): nothing new.
    expect(await giveBackOnReturn(deps, 'T', 'S-1', 'RT-1', 50_000)).toMatchObject({ outcome: 'given_back', points: 10 });
    expect(await giveBackOnReturn(deps, 'T', 'S-1', 'RT-2', 50_000)).toMatchObject({ outcome: 'given_back', points: 10, valueMinor: 1_000 });
    expect(giveBacks.map((g) => [g.returnId, g.points, g.valueMinor])).toEqual([['RT-1', 10, 1_000], ['RT-2', 10, 1_000]]);
  });

  it('says so when the bill used no points', async () => {
    const { deps, giveBacks } = stubDeps(undefined);
    expect(await giveBackOnReturn(deps, 'T', 'S-1', 'RT-1', 50_000)).toMatchObject({ outcome: 'no_points_spent' });
    expect(giveBacks).toHaveLength(0);
  });

  it('the day book reverses the whole returned value and posts the points part back to the points liability', () => {
    const ret: DayBookReturn = { returnId: 'RT-1', originalSaleId: 'S-1', refundMinor: 98_000, refundTender: 'cash', lines: [{ productId: 'P1', quantityMinor: 1 }], pointsGivenBackMinor: 2_000 };
    expect(returnedValue(ret)).toBe(100_000);
    expect(refundLegs(ret)).toEqual([{ kind: 'cash', amountMinor: 98_000 }, { kind: 'loyalty_points', amountMinor: 2_000 }]);
    const sale = { saleId: 'S-1', tradingDay: '2026-10-10', totalMinor: 100_000, lines: [{ productId: 'P1', quantityMinor: 1, lineTotalMinor: 100_000, taxRateBps: 0 }], tenders: [{ kind: 'loyalty_points', amountMinor: 2_000 }, { kind: 'cash', amountMinor: 98_000 }] };
    const book = buildDayBook({
      tradingDay: '2026-10-10', sales: [], returns: [ret], originalSales: new Map([['S-1', sale as never]]),
      taxRateOf: () => 0, alreadyPosted: new Map(),
    });
    expect(book.exceptions).toEqual([]);
    const byKind = Object.fromEntries(book.aggregates.map((a) => [a.kind, a.components]));
    expect(byKind['sale_return']).toMatchObject({ total: 100_000 });
    expect(byKind['refund:cash']).toEqual({ amount: 98_000 });
    expect(byKind['refund:loyalty_points']).toEqual({ amount: 2_000 });
  });
});
