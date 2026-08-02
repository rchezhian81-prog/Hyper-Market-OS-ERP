import { describe, it, expect } from 'vitest';
import {
  rate,
  parseRatePercent,
  applyRate,
  toPercentString,
} from '../../packages/contracts/src/rate';
import { money } from '../../packages/contracts/src/money';

// Rate does the exact percentage maths pricing (M05) and tax (M23) rely on: rates
// are integer basis points, and applying one to Money rounds to whole minor units
// with an explicit rule — never a float.

describe('rate construction and parsing', () => {
  it('builds from basis points and rejects a non-integer', () => {
    expect(rate(1800).bps).toBe(1800);
    expect(() => rate(18.5)).toThrow(RangeError);
  });

  it('parses percentages exactly', () => {
    expect(parseRatePercent('18').bps).toBe(1800);
    expect(parseRatePercent('2.5').bps).toBe(250);
    expect(parseRatePercent('0.01').bps).toBe(1);
    expect(parseRatePercent('-5').bps).toBe(-500);
  });

  it('rejects over-precise or malformed percentages', () => {
    expect(() => parseRatePercent('18.001')).toThrow(RangeError);
    expect(() => parseRatePercent('abc')).toThrow(RangeError);
  });

  it('formats back to a percentage string', () => {
    expect(toPercentString(rate(1800))).toBe('18.00');
    expect(toPercentString(rate(250))).toBe('2.50');
    expect(toPercentString(rate(1))).toBe('0.01');
  });
});

describe('applyRate', () => {
  it('applies a clean rate exactly (18% GST on ₹100)', () => {
    expect(applyRate(money(100_00, 'INR'), rate(1800)).minor).toBe(18_00);
  });

  it('rounds a fractional result (half-up by default)', () => {
    // ₹9.99 (999 paise) × 18% = 179.82 paise → 180
    expect(applyRate(money(999, 'INR'), rate(1800)).minor).toBe(180);
    expect(applyRate(money(999, 'INR'), rate(1800), 'down').minor).toBe(179);
  });

  it('handles the exact .5 boundary per rounding mode', () => {
    // 5 paise × 10% = 0.5 paise
    expect(applyRate(money(5, 'INR'), rate(1000), 'half_up').minor).toBe(1);
    expect(applyRate(money(5, 'INR'), rate(1000), 'half_even').minor).toBe(0); // 0 is even
    expect(applyRate(money(5, 'INR'), rate(1000), 'down').minor).toBe(0);
  });

  it('rounds a negative amount symmetrically (away from zero on .5, half-up)', () => {
    expect(applyRate(money(-5, 'INR'), rate(1000), 'half_up').minor).toBe(-1);
  });

  it('keeps the amount currency', () => {
    expect(applyRate(money(100_00, 'INR'), rate(500)).currency).toBe('INR');
  });
});
