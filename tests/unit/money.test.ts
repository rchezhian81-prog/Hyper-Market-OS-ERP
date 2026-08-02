import { describe, it, expect } from 'vitest';
import {
  money,
  parseMoney,
  zero,
  add,
  subtract,
  negate,
  multiplyByInteger,
  compare,
  equals,
  isZero,
  isNegative,
  isPositive,
  allocate,
  allocateByRatios,
  toDecimalString,
  precisionOf,
  isCurrencyCode,
  scaleMoney,
  type CurrencyCode,
} from '../../packages/contracts/src/money';

// Money is the foundation of every price, tender, ledger entry and total.
// These tests pin the §29.1 rule: exact integer minor units, explicit currency,
// never a float, and never a lost paisa.

describe('money construction', () => {
  it('builds from integer minor units and is immutable', () => {
    const m = money(1050, 'INR');
    expect(m.minor).toBe(1050);
    expect(m.currency).toBe('INR');
    expect(Object.isFrozen(m)).toBe(true);
  });

  it('rejects a non-integer (float) amount', () => {
    expect(() => money(10.5, 'INR')).toThrow(RangeError);
  });

  it('rejects an unsafe integer', () => {
    expect(() => money(Number.MAX_SAFE_INTEGER + 1, 'INR')).toThrow(RangeError);
  });

  it('rejects an unknown currency at runtime', () => {
    expect(() => money(100, 'XYZ' as CurrencyCode)).toThrow(RangeError);
  });

  it('zero is zero in the given currency', () => {
    expect(zero('INR')).toEqual(money(0, 'INR'));
  });
});

describe('parseMoney', () => {
  it('parses exact decimal strings to minor units', () => {
    expect(parseMoney('10.50', 'INR').minor).toBe(1050);
    expect(parseMoney('10.5', 'INR').minor).toBe(1050);
    expect(parseMoney('10', 'INR').minor).toBe(1000);
    expect(parseMoney('0.05', 'INR').minor).toBe(5);
    expect(parseMoney('-3.00', 'INR').minor).toBe(-300);
    expect(parseMoney('-0.00', 'INR').minor).toBe(0);
  });

  it('rejects more fractional digits than the currency allows (no silent rounding)', () => {
    expect(() => parseMoney('10.505', 'INR')).toThrow(RangeError);
  });

  it('rejects malformed input', () => {
    for (const bad of ['abc', '', '1.2.3', '10,50', ' ', '--1']) {
      expect(() => parseMoney(bad, 'INR')).toThrow(RangeError);
    }
  });

  it('round-trips through toDecimalString', () => {
    expect(toDecimalString(parseMoney('10.5', 'INR'))).toBe('10.50');
    expect(toDecimalString(parseMoney('-3', 'INR'))).toBe('-3.00');
    expect(toDecimalString(parseMoney('0.05', 'INR'))).toBe('0.05');
    expect(toDecimalString(zero('INR'))).toBe('0.00');
  });
});

describe('arithmetic', () => {
  it('adds, subtracts and negates within a currency', () => {
    expect(add(money(1050, 'INR'), money(250, 'INR')).minor).toBe(1300);
    expect(subtract(money(1050, 'INR'), money(250, 'INR')).minor).toBe(800);
    expect(negate(money(1050, 'INR')).minor).toBe(-1050);
  });

  it('refuses to combine different currencies', () => {
    expect(() => add(money(100, 'INR'), money(100, 'USD'))).toThrow(TypeError);
    expect(() => subtract(money(100, 'INR'), money(100, 'USD'))).toThrow(TypeError);
    expect(() => compare(money(100, 'INR'), money(100, 'USD'))).toThrow(TypeError);
  });

  it('multiplies by an integer factor exactly and rejects a fractional factor', () => {
    expect(multiplyByInteger(money(150, 'INR'), 3).minor).toBe(450);
    expect(() => multiplyByInteger(money(150, 'INR'), 2.5)).toThrow(RangeError);
  });
});

describe('comparison and predicates', () => {
  it('compares and tests equality', () => {
    expect(compare(money(100, 'INR'), money(200, 'INR'))).toBe(-1);
    expect(compare(money(200, 'INR'), money(100, 'INR'))).toBe(1);
    expect(compare(money(100, 'INR'), money(100, 'INR'))).toBe(0);
    expect(equals(money(100, 'INR'), money(100, 'INR'))).toBe(true);
    expect(equals(money(100, 'INR'), money(100, 'USD'))).toBe(false);
  });

  it('tests sign', () => {
    expect(isZero(zero('INR'))).toBe(true);
    expect(isNegative(money(-1, 'INR'))).toBe(true);
    expect(isPositive(money(1, 'INR'))).toBe(true);
  });
});

describe('allocate (equal split, no lost paise)', () => {
  it('splits evenly, distributing the remainder', () => {
    const shares = allocate(money(1000, 'INR'), 3);
    expect(shares.map((s) => s.minor)).toEqual([334, 333, 333]);
    expect(shares.reduce((s, m) => s + m.minor, 0)).toBe(1000);
  });

  it('handles a negative amount and still sums exactly', () => {
    const shares = allocate(money(-1000, 'INR'), 3);
    expect(shares.reduce((s, m) => s + m.minor, 0)).toBe(-1000);
  });

  it('rejects a non-positive parts count', () => {
    expect(() => allocate(money(100, 'INR'), 0)).toThrow(RangeError);
    expect(() => allocate(money(100, 'INR'), -2)).toThrow(RangeError);
  });
});

describe('allocateByRatios (weighted split, no lost paise)', () => {
  it('allocates by ratios and sums exactly', () => {
    expect(allocateByRatios(money(1000, 'INR'), [1, 2, 1]).map((s) => s.minor)).toEqual([
      250, 500, 250,
    ]);
    const uneven = allocateByRatios(money(1002, 'INR'), [1, 1, 1, 1]);
    expect(uneven.reduce((s, m) => s + m.minor, 0)).toBe(1002);
    expect(uneven.map((s) => s.minor)).toEqual([251, 251, 250, 250]);
  });

  it('rejects negative amounts, empty ratios and all-zero ratios', () => {
    expect(() => allocateByRatios(money(-100, 'INR'), [1, 1])).toThrow(RangeError);
    expect(() => allocateByRatios(money(100, 'INR'), [])).toThrow(RangeError);
    expect(() => allocateByRatios(money(100, 'INR'), [0, 0])).toThrow(RangeError);
  });
});

describe('scaleMoney (exact fractional multiply)', () => {
  it('scales by a fraction with rounding', () => {
    // ₹100.00 × 333/1000 = ₹33.30
    expect(scaleMoney(money(100_00, 'INR'), 333, 1000).minor).toBe(33_30);
    // exact .5 boundary: 5 × 1/10 = 0.5 → half_up 1, half_even 0, down 0
    expect(scaleMoney(money(5, 'INR'), 1, 10, 'half_up').minor).toBe(1);
    expect(scaleMoney(money(5, 'INR'), 1, 10, 'half_even').minor).toBe(0);
    expect(scaleMoney(money(5, 'INR'), 1, 10, 'down').minor).toBe(0);
  });

  it('rejects a bad numerator or denominator', () => {
    expect(() => scaleMoney(money(100, 'INR'), 1.5, 10)).toThrow(RangeError);
    expect(() => scaleMoney(money(100, 'INR'), 1, 0)).toThrow(RangeError);
    expect(() => scaleMoney(money(100, 'INR'), 1, -10)).toThrow(RangeError);
  });
});

describe('formatting and helpers', () => {
  it('formats to a locale-neutral decimal string', () => {
    expect(toDecimalString(money(1050, 'INR'))).toBe('10.50');
    expect(toDecimalString(money(-300, 'INR'))).toBe('-3.00');
    expect(toDecimalString(money(5, 'INR'))).toBe('0.05');
  });

  it('exposes precision and currency checks', () => {
    expect(precisionOf('INR')).toBe(2);
    expect(isCurrencyCode('INR')).toBe(true);
    expect(isCurrencyCode('XYZ')).toBe(false);
  });
});
