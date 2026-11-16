import { describe, it, expect } from 'vitest';
import { keyedReturnMinor, keyedWithDecimals } from '../../apps/pos/src/refund-view';

/**
 * Fix batch 4a — D-059 (M13-FR-02 · OB-31): the refund's how-much keypad takes a weighed line in its own unit WITH a decimal
 * point ("0.850" kg is 850 g), exactly — never rounded, never more than can still come back. A counted line keeps whole
 * numbers. Synthetic data only.
 */
describe('fix batch 4a: a weighed refund is keyed in kg (D-059)', () => {
  it('kg and L lines take a decimal point; counted lines do not', () => {
    expect(keyedWithDecimals('kg')).toBe(true);
    expect(keyedWithDecimals('KG')).toBe(true);
    expect(keyedWithDecimals('L')).toBe(true);
    expect(keyedWithDecimals('ea')).toBe(false);
    expect(keyedWithDecimals('g')).toBe(false);
    expect(keyedWithDecimals('box')).toBe(false);
  });

  it('"0.850" kg is 850 g; "0.5" is 500 g; "1.25" L is 1250 ml — exact', () => {
    const tomato = { uom: 'kg', returnableMinor: 850 };
    expect(keyedReturnMinor('0.850', tomato)).toBe(850);
    expect(keyedReturnMinor('0.5', tomato)).toBe(500);
    expect(keyedReturnMinor('0.25', tomato)).toBe(250);
    expect(keyedReturnMinor('1.25', { uom: 'L', returnableMinor: 2000 })).toBe(1250);
  });

  it('refuses a fourth decimal, nought, more than can come back, and anything that is not a number', () => {
    const tomato = { uom: 'kg', returnableMinor: 850 };
    expect(keyedReturnMinor('0.8505', tomato)).toBeUndefined();
    expect(keyedReturnMinor('0', tomato)).toBeUndefined();
    expect(keyedReturnMinor('0.000', tomato)).toBeUndefined();
    expect(keyedReturnMinor('0.9', tomato)).toBeUndefined();
    expect(keyedReturnMinor('850', tomato)).toBeUndefined(); // 850 kg, not 850 g — far more than came back
    expect(keyedReturnMinor('', tomato)).toBeUndefined();
    expect(keyedReturnMinor('abc', tomato)).toBeUndefined();
  });

  it('a counted line takes whole items only, as before', () => {
    const biscuits = { uom: 'ea', returnableMinor: 3 };
    expect(keyedReturnMinor('2', biscuits)).toBe(2);
    expect(keyedReturnMinor('2.5', biscuits)).toBeUndefined();
    expect(keyedReturnMinor('4', biscuits)).toBeUndefined();
  });
});
