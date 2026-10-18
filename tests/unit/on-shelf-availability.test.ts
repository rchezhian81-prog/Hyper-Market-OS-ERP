import { describe, it, expect } from 'vitest';
import { findPhantomSuspects, InvalidOsaInputError, osaWindowStart } from '../../packages/replenishment/src/on-shelf-availability';

/** D-14 (R3, OB-147 "A"): a suspected phantom is judged per item from its own selling rate, with the owner's minimum. */
const sale = (productId: string, tradingDay: string, q = 1, locationId = 'store-01') => ({ productId, locationId, tradingDay, quantityMinor: q });
const stock = (productId: string, onHandMinor: number, locationId = 'store-01') => ({ productId, locationId, onHandMinor });
const AS_OF = '2030-06-28';

describe('D-14 phantom-stock rule', () => {
  it('with no owner minimum set, nothing is judged and the state says so (P-08)', () => {
    const r = findPhantomSuspects({ asOf: AS_OF, lookbackDays: 28, ownerMinimumDays: undefined, stock: [stock('p', 5)], sales: [] });
    expect(r.state).toBe('minimum_not_set');
  });

  it('an item that sells every day is raised after more than the owner minimum of quiet days, not before', () => {
    const days = Array.from({ length: 24 }, (_, i) => `2030-06-${String(i + 1).padStart(2, '0')}`); // sold 1..24 June
    const r = findPhantomSuspects({ asOf: AS_OF, lookbackDays: 28, ownerMinimumDays: 3, stock: [stock('rice', 40)], sales: days.map((d) => sale('rice', d)) });
    expect(r.state).toBe('judged');
    if (r.state !== 'judged') return;
    // window 1–28 June, 24 selling days → expected gap ceil(28/24)=2; owner minimum 3 sets the threshold; 4 days quiet > 3
    expect(r.suspects).toHaveLength(1);
    expect(r.suspects[0]).toMatchObject({ productId: 'rice', lastSaleDay: '2030-06-24', daysWithoutSale: 4, expectedGapDays: 2, thresholdDays: 3, basis: 'owner_minimum' });
    const notYet = findPhantomSuspects({ asOf: '2030-06-27', lookbackDays: 28, ownerMinimumDays: 3, stock: [stock('rice', 40)], sales: days.map((d) => sale('rice', d)) });
    expect(notYet.state === 'judged' && notYet.suspects).toEqual([]); // 3 days quiet is not MORE than 3
  });

  it('a slow seller uses its own, longer expected gap', () => {
    // sold on 4 days in a 28-day window → expected about every 7 days
    const sales = ['2030-06-01', '2030-06-08', '2030-06-15', '2030-06-22'].map((d) => sale('saffron', d));
    const quiet6 = findPhantomSuspects({ asOf: AS_OF, lookbackDays: 28, ownerMinimumDays: 3, stock: [stock('saffron', 2)], sales });
    expect(quiet6.state === 'judged' && quiet6.suspects).toEqual([]); // 6 days quiet ≤ 7
    const earlier = ['2030-06-03', '2030-06-10', '2030-06-17', '2030-06-20'].map((d) => sale('saffron', d));
    const quiet8 = findPhantomSuspects({ asOf: AS_OF, lookbackDays: 28, ownerMinimumDays: 3, stock: [stock('saffron', 2)], sales: earlier });
    expect(quiet8.state === 'judged' && quiet8.suspects[0]).toMatchObject({ daysWithoutSale: 8, expectedGapDays: 7, thresholdDays: 7, basis: 'own_selling_rate' });
  });

  it('stock with no sale in the whole window is raised with "at least" the window, judged by the owner minimum only', () => {
    const r = findPhantomSuspects({ asOf: AS_OF, lookbackDays: 28, ownerMinimumDays: 3, stock: [stock('ghost', 6)], sales: [] });
    expect(r.state === 'judged' && r.suspects[0]).toMatchObject({ lastSaleDay: null, daysWithoutSale: 28, daysWithoutSaleIsAtLeast: true, expectedGapDays: null, basis: 'no_sale_in_window' });
  });

  it('no stock, or stock at another place, is never a suspect; sales are per place', () => {
    const r = findPhantomSuspects({
      asOf: AS_OF, lookbackDays: 28, ownerMinimumDays: 3,
      stock: [stock('a', 0), stock('b', -2), stock('c', 5, 'store-02')],
      sales: [sale('c', '2030-06-28', 1, 'store-01')],
    });
    expect(r.state === 'judged' && r.suspects.map((s) => `${s.productId}@${s.locationId}`)).toEqual(['c@store-02']);
    expect(r.state === 'judged' && r.judged).toBe(1);
  });

  it('refuses a malformed window or minimum by name', () => {
    expect(() => findPhantomSuspects({ asOf: '28/06/2030', lookbackDays: 28, ownerMinimumDays: 3, stock: [], sales: [] })).toThrow(InvalidOsaInputError);
    expect(() => findPhantomSuspects({ asOf: AS_OF, lookbackDays: 0, ownerMinimumDays: 3, stock: [], sales: [] })).toThrow(InvalidOsaInputError);
    expect(() => findPhantomSuspects({ asOf: AS_OF, lookbackDays: 28, ownerMinimumDays: 0, stock: [], sales: [] })).toThrow(InvalidOsaInputError);
    expect(osaWindowStart(AS_OF, 28)).toBe('2030-06-01');
  });
});
