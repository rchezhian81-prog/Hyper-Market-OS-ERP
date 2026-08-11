import { describe, it, expect } from 'vitest';
import { assessCompensationCess, checkDemeritHoldover, InvalidCessInput } from '../../packages/finance/src/cess';

// Roadmap v2.1 A7 — GST Compensation Cess on tobacco / pan-masala, plus the GST-2.0 "28% + cess holdover"
// invariant. Cess is over and above the GST: an ad-valorem part (bps of the taxable value) and/or a
// specific part (₹ per block of units, pro-rata on quantity). A good with neither is not cess-liable.

const spec = (o: Partial<Parameters<typeof assessCompensationCess>[0]['spec']> = {}) =>
  ({ hsnCode: '24022090', advaloremBps: 0, specificPerQuantityMinor: 0, perQuantity: 1000, ...o });

describe('assessCompensationCess — A7: the cess over and above GST', () => {
  it('computes an ad-valorem cess as a percentage of the taxable value (pan-masala 60%)', () => {
    // ₹100 taxable at 60% ad-valorem = ₹60 cess, no specific part.
    const r = assessCompensationCess({ spec: spec({ hsnCode: '21069020', advaloremBps: 6000 }), taxableMinor: 10_000, quantity: 0 });
    expect(r.cessLiable).toBe(true);
    expect(r.advaloremCessMinor).toBe(6_000);
    expect(r.specificCessMinor).toBe(0);
    expect(r.totalCessMinor).toBe(6_000);
  });

  it('computes a specific cess pro-rata on quantity (cigarettes: ₹4170 per 1000 sticks, a 20-pack)', () => {
    // 417000 paisa / 1000 × 20 = 8340 paisa = ₹83.40.
    const r = assessCompensationCess({ spec: spec({ specificPerQuantityMinor: 417_000, perQuantity: 1000 }), taxableMinor: 20_000, quantity: 20 });
    expect(r.specificCessMinor).toBe(8_340);
    expect(r.advaloremCessMinor).toBe(0);
    expect(r.totalCessMinor).toBe(8_340);
  });

  it('adds both parts when a good carries ad-valorem AND specific cess', () => {
    // ₹200 taxable at 5% = ₹10 ad-valorem; 20 sticks at ₹4170/1000 = ₹83.40 specific; total ₹93.40.
    const r = assessCompensationCess({ spec: spec({ advaloremBps: 500, specificPerQuantityMinor: 417_000, perQuantity: 1000 }), taxableMinor: 20_000, quantity: 20 });
    expect(r.advaloremCessMinor).toBe(1_000);
    expect(r.specificCessMinor).toBe(8_340);
    expect(r.totalCessMinor).toBe(9_340);
  });

  it('rounds each part half-up to the paisa', () => {
    // 333 paisa × 5% = 16.65 paisa → 17; 100 paisa per 3 units × 1 = 33.33 → 33.
    expect(assessCompensationCess({ spec: spec({ advaloremBps: 500 }), taxableMinor: 333, quantity: 0 }).advaloremCessMinor).toBe(17);
    expect(assessCompensationCess({ spec: spec({ specificPerQuantityMinor: 100, perQuantity: 3 }), taxableMinor: 0, quantity: 1 }).specificCessMinor).toBe(33);
  });

  it('treats a good with no cess spec as not liable — every amount is zero (the data gate)', () => {
    const r = assessCompensationCess({ spec: spec({ hsnCode: '1905' }), taxableMinor: 5_000, quantity: 3 });
    expect(r.cessLiable).toBe(false);
    expect(r.totalCessMinor).toBe(0);
  });

  it('refuses a bad HSN, a negative rate, a non-whole taxable, a negative quantity, and a specific rate with no block', () => {
    expect(() => assessCompensationCess({ spec: spec({ hsnCode: 'ABCD' }), taxableMinor: 100, quantity: 0 })).toThrow(InvalidCessInput);
    expect(() => assessCompensationCess({ spec: spec({ advaloremBps: -1 }), taxableMinor: 100, quantity: 0 })).toThrow(InvalidCessInput);
    expect(() => assessCompensationCess({ spec: spec({ advaloremBps: 500 }), taxableMinor: 10.5, quantity: 0 })).toThrow(InvalidCessInput);
    expect(() => assessCompensationCess({ spec: spec({ advaloremBps: 500 }), taxableMinor: 100, quantity: -2 })).toThrow(InvalidCessInput);
    expect(() => assessCompensationCess({ spec: spec({ specificPerQuantityMinor: 417_000, perQuantity: 0 }), taxableMinor: 100, quantity: 20 })).toThrow(InvalidCessInput);
  });
});

describe('checkDemeritHoldover — A7: the GST-2.0 28%+cess holdover invariant', () => {
  it('accepts a cess-liable good on 28% GST + cess (the holdover)', () => {
    const r = checkDemeritHoldover({ cessLiable: true, gstRateBps: 2800 });
    expect(r.ok).toBe(true);
    expect(r.band).toBe('cess_holdover_28');
  });

  it('REFUSES a cess-liable good ALSO on the 40% demerit slab (it would be taxed twice)', () => {
    const r = checkDemeritHoldover({ cessLiable: true, gstRateBps: 4000 });
    expect(r.ok).toBe(false);
    expect(r.band).toBe('demerit_40');
  });

  it('accepts a non-cess demerit good on 40%, and a standard good on an ordinary slab', () => {
    expect(checkDemeritHoldover({ cessLiable: false, gstRateBps: 4000 }).band).toBe('demerit_40');
    expect(checkDemeritHoldover({ cessLiable: false, gstRateBps: 1800 }).band).toBe('standard');
  });

  it('refuses a non-whole GST rate', () => {
    expect(() => checkDemeritHoldover({ cessLiable: true, gstRateBps: 28.5 })).toThrow(InvalidCessInput);
  });
});
