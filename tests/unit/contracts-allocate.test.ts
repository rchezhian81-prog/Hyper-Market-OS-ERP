import { describe, it, expect } from 'vitest';
import { allocateDiscount, InvalidDiscountAllocation } from '../../packages/contracts/src/allocate';

// Split a bill-level discount across the lines it applied to, in whole minor units, so the parts sum to
// the discount EXACTLY and no share exceeds its line's total (largest-remainder apportionment).

describe('allocateDiscount', () => {
  it('splits in proportion to each line total', () => {
    // ₹100 and ₹300 lines, ₹40 discount → ₹10 and ₹30 (1:3).
    expect(allocateDiscount([100_00, 300_00], 40_00)).toEqual([10_00, 30_00]);
  });

  it('hands the rounding remainder to the largest fractional shares, summing exactly', () => {
    // Three equal lines, 10 paise discount → 3.33 each; the extra paise goes to the first line (stable).
    const shares = allocateDiscount([100, 100, 100], 10);
    expect(shares).toEqual([4, 3, 3]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(10); // exact
  });

  it('returns all zeros when there is no discount, or nothing to discount', () => {
    expect(allocateDiscount([100, 200], 0)).toEqual([0, 0]);
    expect(allocateDiscount([0, 0], 0)).toEqual([0, 0]);
  });

  it('gives the whole discount to a single line', () => {
    expect(allocateDiscount([500], 123)).toEqual([123]);
  });

  it('never lets a share exceed its line total (a full-basket discount zeroes every line)', () => {
    const totals = [100, 250, 650];
    const shares = allocateDiscount(totals, 1000); // == the whole basket
    expect(shares).toEqual(totals);
    expect(shares.every((s, i) => s <= totals[i]!)).toBe(true);
  });

  it('rejects a discount larger than the basket, and malformed inputs', () => {
    expect(() => allocateDiscount([100, 100], 201)).toThrow(InvalidDiscountAllocation); // > basket
    expect(() => allocateDiscount([100, -1], 10)).toThrow(InvalidDiscountAllocation);   // negative line
    expect(() => allocateDiscount([100, 1.5], 10)).toThrow(InvalidDiscountAllocation);  // non-integer line
    expect(() => allocateDiscount([100], -5)).toThrow(InvalidDiscountAllocation);        // negative discount
  });
});
