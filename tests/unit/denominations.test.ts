import { describe, it, expect } from 'vitest';
import {
  INR_DENOMINATIONS,
  sumDenominations,
  checkDenominationCount,
  type DenominationCount,
} from '../../packages/till/src/index';

// The blind-count denomination breakdown (M14-FR-02). Pure arithmetic and integrity: a breakdown of
// real Indian notes/coins that must SUM to the total the cashier declared. A mismatch is an entry
// error caught at the drawer — never a variance the cash office chases at audit.

const notes = (counts: Record<number, number>): DenominationCount[] =>
  Object.entries(counts).map(([denominationMinor, count]) => ({ denominationMinor: Number(denominationMinor), count }));

describe('the denomination breakdown of a blind cash count', () => {
  it('lists the real Indian notes and coins in paise, largest first', () => {
    expect(INR_DENOMINATIONS[0]).toBe(200_000); // ₹2000
    expect(INR_DENOMINATIONS[INR_DENOMINATIONS.length - 1]).toBe(100); // ₹1
    // strictly descending
    for (let i = 1; i < INR_DENOMINATIONS.length; i++) {
      expect(INR_DENOMINATIONS[i]! < INR_DENOMINATIONS[i - 1]!).toBe(true);
    }
  });

  it('sums face value × count across the breakdown', () => {
    // 2×₹500 + 3×₹100 + 5×₹10 = 100000 + 30000 + 5000 = 135000
    expect(sumDenominations(notes({ 50_000: 2, 10_000: 3, 1_000: 5 }))).toBe(135_000);
    expect(sumDenominations([])).toBe(0);
  });

  it('accepts a breakdown that sums exactly to the counted total', () => {
    const check = checkDenominationCount({ denominations: notes({ 50_000: 2, 10_000: 1, 1_000: 5 }), countedCashMinor: 115_000 });
    expect(check.ok).toBe(true);
    expect(check.sumMinor).toBe(115_000);
  });

  it('refuses a breakdown that does not sum to the counted total — the drawer, not the audit, catches it', () => {
    // notes add to 110000 but the cashier declared 115000
    const check = checkDenominationCount({ denominations: notes({ 50_000: 2, 10_000: 1 }), countedCashMinor: 115_000 });
    expect(check.ok).toBe(false);
    expect(check.refusedBecause).toBe('does_not_sum_to_the_count');
    expect(check.sumMinor).toBe(110_000);
  });

  it('refuses a face value that is not a real Indian note or coin', () => {
    const check = checkDenominationCount({ denominations: [{ denominationMinor: 30_000, count: 1 }], countedCashMinor: 30_000 });
    expect(check.ok).toBe(false);
    expect(check.refusedBecause).toBe('unknown_denomination');
  });

  it('refuses a fractional or negative count of notes', () => {
    expect(checkDenominationCount({ denominations: [{ denominationMinor: 50_000, count: 1.5 }], countedCashMinor: 75_000 }).refusedBecause)
      .toBe('negative_or_fractional_count');
    expect(checkDenominationCount({ denominations: [{ denominationMinor: 50_000, count: -1 }], countedCashMinor: -50_000 }).refusedBecause)
      .toBe('negative_or_fractional_count');
  });

  it('treats an empty breakdown as summing to zero (only valid for a zero count)', () => {
    expect(checkDenominationCount({ denominations: [], countedCashMinor: 0 }).ok).toBe(true);
    expect(checkDenominationCount({ denominations: [], countedCashMinor: 100 }).ok).toBe(false);
  });
});
