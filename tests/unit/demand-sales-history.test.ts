import { describe, it, expect } from 'vitest';
import {
  salesHistory,
  InvalidDemandWindowError,
  type SoldLine,
} from '../../packages/demand/src/sales-history';

// Sales-history demand read (M09) — folds banked sold lines into per-product demand and the average
// daily demand the reorder engine (D-3) consumes. Pure: no clock, no I/O.

const line = (productId: string, quantityMinor: number, tradingDay: string): SoldLine => ({ productId, quantityMinor, tradingDay });

describe('salesHistory', () => {
  it('folds lines into per-product totals, a day-by-day series, and average daily demand', () => {
    const history = salesHistory({
      from: '2026-08-01',
      to: '2026-08-07', // 7-day window
      lines: [
        line('A', 10, '2026-08-01'),
        line('A', 20, '2026-08-03'),
        line('B', 7, '2026-08-02'),
      ],
    });

    expect(history.windowDays).toBe(7);
    expect(history.products.map((p) => p.productId)).toEqual(['A', 'B']); // sorted by productId

    const a = history.products[0]!;
    expect(a.totalQtyMinor).toBe(30);
    expect(a.sellingDays).toBe(2);
    expect(a.byDay).toEqual([{ day: '2026-08-01', qtyMinor: 10 }, { day: '2026-08-03', qtyMinor: 20 }]);
    expect(a.avgDailyDemandMinor).toBe(4); // round(30 / 7)

    const b = history.products[1]!;
    expect(b.totalQtyMinor).toBe(7);
    expect(b.avgDailyDemandMinor).toBe(1); // round(7 / 7)
  });

  it('sums multiple sales of the same product on the same day', () => {
    const history = salesHistory({
      from: '2026-08-01', to: '2026-08-01', // single-day window
      lines: [line('A', 3, '2026-08-01'), line('A', 4, '2026-08-01')],
    });
    expect(history.windowDays).toBe(1);
    expect(history.products[0]!.byDay).toEqual([{ day: '2026-08-01', qtyMinor: 7 }]);
    expect(history.products[0]!.avgDailyDemandMinor).toBe(7); // total / 1
  });

  it('averages over WINDOW days, counting days with no sale as zero', () => {
    // 28 sold across a 28-day window → 1/day, even though it all sold on two days
    const history = salesHistory({
      from: '2026-08-01', to: '2026-08-28',
      lines: [line('A', 14, '2026-08-05'), line('A', 14, '2026-08-20')],
    });
    expect(history.windowDays).toBe(28);
    expect(history.products[0]!.sellingDays).toBe(2);
    expect(history.products[0]!.avgDailyDemandMinor).toBe(1); // 28 / 28, not 28 / 2
  });

  it('counts only lines whose trading day falls inside the window', () => {
    const history = salesHistory({
      from: '2026-08-01', to: '2026-08-07',
      lines: [
        line('A', 5, '2026-07-31'), // before the window
        line('A', 9, '2026-08-04'), // inside
        line('A', 5, '2026-08-08'), // after the window
      ],
    });
    expect(history.products[0]!.totalQtyMinor).toBe(9);
    expect(history.products[0]!.sellingDays).toBe(1);
  });

  it('skips a malformed trading day or a non-positive quantity rather than crashing', () => {
    const history = salesHistory({
      from: '2026-08-01', to: '2026-08-07',
      lines: [
        line('A', 6, 'not-a-day'),
        line('A', 0, '2026-08-02'),
        line('A', -4, '2026-08-02'),
        line('A', 6, '2026-08-02'),
      ],
    });
    expect(history.products).toHaveLength(1);
    expect(history.products[0]!.totalQtyMinor).toBe(6);
  });

  it('preserves the line unit (grams for a weighed good) — it does not assume eaches', () => {
    const history = salesHistory({
      from: '2026-08-01', to: '2026-08-02',
      lines: [line('TOMATO', 1234, '2026-08-01'), line('TOMATO', 766, '2026-08-02')], // grams
    });
    expect(history.products[0]!.totalQtyMinor).toBe(2000);
    expect(history.products[0]!.avgDailyDemandMinor).toBe(1000); // 2000 g / 2 days
  });

  it('returns an empty product list for a window with no sales', () => {
    const history = salesHistory({ from: '2026-08-01', to: '2026-08-07', lines: [] });
    expect(history.products).toEqual([]);
    expect(history.windowDays).toBe(7);
  });

  it('rejects a malformed window or from after to', () => {
    expect(() => salesHistory({ from: '2026-08-07', to: '2026-08-01', lines: [] })).toThrow(InvalidDemandWindowError);
    expect(() => salesHistory({ from: 'nope', to: '2026-08-01', lines: [] })).toThrow(InvalidDemandWindowError);
    expect(() => salesHistory({ from: '2026-08-01', to: 'nope', lines: [] })).toThrow(InvalidDemandWindowError);
  });
});
