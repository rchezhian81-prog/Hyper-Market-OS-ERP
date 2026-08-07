import { describe, it, expect } from 'vitest';
import {
  quantity,
  parseQuantity,
  zero,
  add,
  subtract,
  negate,
  multiplyByInteger,
  compare,
  equals,
  isZero,
  isNegative,
  toDecimalString,
  precisionOf,
  isUom,
  type Uom,
} from '../../packages/contracts/src/quantity';

// Quantity mirrors Money's exactness for stock and weighed goods: integer counts
// of the UOM's smallest unit (e.g. grams for kg), never a float.

describe('quantity construction and parsing', () => {
  it('builds from integer minor units and is immutable', () => {
    const q = quantity(1234, 'kg');
    expect(q.minor).toBe(1234);
    expect(q.uom).toBe('kg');
    expect(Object.isFrozen(q)).toBe(true);
  });

  it('rejects a float amount, an unsafe integer and an unknown UOM', () => {
    expect(() => quantity(1.5, 'kg')).toThrow(RangeError);
    expect(() => quantity(Number.MAX_SAFE_INTEGER + 1, 'kg')).toThrow(RangeError);
    expect(() => quantity(1, 'furlong' as Uom)).toThrow(RangeError);
  });

  it('parses UOM-aware decimals exactly', () => {
    expect(parseQuantity('1.234', 'kg').minor).toBe(1234); // grams
    expect(parseQuantity('3', 'ea').minor).toBe(3);
    expect(parseQuantity('0.5', 'L').minor).toBe(500); // ml
    expect(parseQuantity('-0.250', 'kg').minor).toBe(-250);
  });

  it('rejects over-precise or discrete-fractional input', () => {
    expect(() => parseQuantity('1.2345', 'kg')).toThrow(RangeError); // > 3 dp
    expect(() => parseQuantity('2.5', 'ea')).toThrow(RangeError); // ea has 0 dp
  });
});

describe('quantity arithmetic', () => {
  it('adds, subtracts, negates and multiplies within a UOM', () => {
    expect(add(quantity(1000, 'g'), quantity(500, 'g')).minor).toBe(1500);
    expect(subtract(quantity(1000, 'g'), quantity(400, 'g')).minor).toBe(600);
    expect(negate(quantity(5, 'ea')).minor).toBe(-5);
    expect(multiplyByInteger(quantity(12, 'ea'), 3).minor).toBe(36);
  });

  it('refuses to combine different UOMs', () => {
    expect(() => add(quantity(1, 'kg'), quantity(1, 'g'))).toThrow(TypeError);
    expect(() => compare(quantity(1, 'kg'), quantity(1, 'ea'))).toThrow(TypeError);
  });

  it('rejects a fractional multiply factor', () => {
    expect(() => multiplyByInteger(quantity(10, 'ea'), 1.5)).toThrow(RangeError);
  });
});

describe('quantity comparison, predicates and formatting', () => {
  it('compares and tests values', () => {
    expect(compare(quantity(1, 'kg'), quantity(2, 'kg'))).toBe(-1);
    expect(equals(quantity(1000, 'g'), quantity(1000, 'g'))).toBe(true);
    expect(equals(quantity(1000, 'g'), quantity(1000, 'ml'))).toBe(false);
    expect(isZero(zero('kg'))).toBe(true);
    expect(isNegative(quantity(-1, 'ea'))).toBe(true);
  });

  it('formats to a locale-neutral decimal string and exposes precision', () => {
    expect(toDecimalString(quantity(1234, 'kg'))).toBe('1.234');
    expect(toDecimalString(quantity(3, 'ea'))).toBe('3');
    expect(toDecimalString(quantity(-250, 'kg'))).toBe('-0.250');
    expect(precisionOf('kg')).toBe(3);
    expect(isUom('kg')).toBe(true);
    expect(isUom('furlong')).toBe(false);
  });
});
