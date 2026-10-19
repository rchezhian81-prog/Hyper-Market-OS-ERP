import { describe, it, expect } from 'vitest';
import { basketAffinity, netBasket, InvalidAffinityInputError, type Basket } from '../../packages/reporting/src/basket-affinity';

/** D-23 (R4, signed OB-227): support, confidence and lift on a fixture; the minimum baskets; returns taken out. */
const b = (id: string, ...products: string[]): Basket => ({ basketId: id, lines: products.map((p) => ({ productId: p, quantityMinor: 1 })) });

// 10 baskets: bread+butter ×4, bread+jam ×1, butter alone ×1, milk ×4. bread in 5, butter in 5, both in 4.
const FIXTURE: Basket[] = [b('1', 'bread', 'butter'), b('2', 'bread', 'butter'), b('3', 'bread', 'butter'), b('4', 'bread', 'butter'), b('5', 'bread', 'jam'), b('6', 'butter'), b('7', 'milk'), b('8', 'milk'), b('9', 'milk'), b('10', 'milk')];

describe('basket affinity (D-23)', () => {
  it('support, confidence both ways and lift, from whole counts', () => {
    const r = basketAffinity({ baskets: FIXTURE, minBaskets: 2 });
    expect(r.basketCount).toBe(10);
    const pair = r.pairs.find((p) => p.productA === 'bread' && p.productB === 'butter')!;
    // support 4/10; confidence bread→butter 4/5, butter→bread 4/5; lift = 4·10/(5·5) = 1.6.
    expect([pair.basketCount, pair.basketsWithA, pair.basketsWithB, pair.support, pair.confidenceAtoB, pair.confidenceBtoA, pair.lift]).toEqual([4, 5, 5, 0.4, 0.8, 0.8, 1.6]);
  });

  it('lists only pairs above chance, and only those seen in at least the minimum number of baskets', () => {
    // bread+jam: 1 basket; lift = 1·10/(5·1) = 2 — above chance, but under a minimum of 2.
    const r = basketAffinity({ baskets: FIXTURE, minBaskets: 2 });
    expect(r.pairs.map((p) => `${p.productA}+${p.productB}`)).toEqual(['bread+butter']);
    expect(r.belowMinimum).toBe(1);
    expect(basketAffinity({ baskets: FIXTURE, minBaskets: 1 }).pairs.map((p) => `${p.productA}+${p.productB}`)).toEqual(['bread+jam', 'bread+butter']);
    expect(basketAffinity({ baskets: FIXTURE, minBaskets: 5 }).pairs).toEqual([]);
    // A pair at chance or below (lift ≤ 1) is never listed, whatever the minimum.
    const even = [b('a', 'x', 'y'), b('b', 'x', 'y')];
    expect(basketAffinity({ baskets: even, minBaskets: 1 }).pairs).toEqual([]);
  });

  it('takes returns out of the basket they came from — a line returned in full leaves the basket; a part return keeps it', () => {
    expect([...netBasket(b('1', 'bread', 'butter'), [{ basketId: '1', lines: [{ productId: 'butter', quantityMinor: 1 }] }])]).toEqual(['bread']);
    expect([...netBasket({ basketId: '1', lines: [{ productId: 'bread', quantityMinor: 2 }] }, [{ basketId: '1', lines: [{ productId: 'bread', quantityMinor: 1 }] }])]).toEqual(['bread']);
    expect([...netBasket(b('1', 'bread'), [{ basketId: '2', lines: [{ productId: 'bread', quantityMinor: 1 }] }])]).toEqual(['bread']);
    const r = basketAffinity({ baskets: FIXTURE, minBaskets: 4, returns: [{ basketId: '4', lines: [{ productId: 'butter', quantityMinor: 1 }] }] });
    expect(r.pairs).toEqual([]); // bread+butter now 3 baskets
    const emptied = basketAffinity({ baskets: [b('1', 'x'), b('2', 'x', 'y')], minBaskets: 1, returns: [{ basketId: '1', lines: [{ productId: 'x', quantityMinor: 1 }] }] });
    expect([emptied.basketCount, emptied.emptiedByReturns]).toEqual([1, 1]);
  });

  it('every suggestion is a draft; a minimum that is not a whole number of at least 1 is refused', () => {
    const r = basketAffinity({ baskets: FIXTURE, minBaskets: 2 });
    expect(r.pairs[0]!.suggestions.every((s) => s.draft)).toBe(true);
    expect(r.pairs[0]!.suggestions.map((s) => s.kind)).toEqual(['place_side_by_side', 'bundle', 'promotion']);
    expect(() => basketAffinity({ baskets: FIXTURE, minBaskets: 0 })).toThrow(InvalidAffinityInputError);
    expect(() => basketAffinity({ baskets: FIXTURE, minBaskets: 1.5 })).toThrow(InvalidAffinityInputError);
  });
});
