import { describe, it, expect } from 'vitest';
import { unitSalePrice, UNIT_PRICE_LOW_VALUE_MINOR, InvalidUnitPriceInput } from '../../packages/product/src/unit-price';

// Roadmap v2.1 B3 — the unit sale price a label must show (Legal Metrology): ₹ per kg/l/piece computed
// from MRP + net quantity, grams normalised to a kilogram and millilitres to a litre, with the small
// package (≤100 cm²) and low value (≤₹35) exemptions surfaced rather than hidden.

describe('unitSalePrice — B3', () => {
  it('normalises grams to a kilogram', () => {
    // A 500 g pack at ₹100 → ₹200 / kg.
    const r = unitSalePrice({ mrpMinor: 100_00, netQuantity: 500, unit: 'g' });
    expect(r.per).toBe('kg');
    expect(r.unitPriceMinor).toBe(200_00);
    expect(r.exempt).toBe(false);
  });

  it('normalises millilitres to a litre, and keeps kg / l / piece as they are', () => {
    expect(unitSalePrice({ mrpMinor: 60_00, netQuantity: 250, unit: 'ml' })).toMatchObject({ per: 'l', unitPriceMinor: 240_00 });
    expect(unitSalePrice({ mrpMinor: 200_00, netQuantity: 2, unit: 'kg' })).toMatchObject({ per: 'kg', unitPriceMinor: 100_00 });
    expect(unitSalePrice({ mrpMinor: 90_00, netQuantity: 6, unit: 'piece' })).toMatchObject({ per: 'unit', unitPriceMinor: 15_00 });
  });

  it('rounds the unit price to the nearest paisa', () => {
    // ₹10.00 / 3 pieces → 333.33p → 333p (half-up on the exact third).
    expect(unitSalePrice({ mrpMinor: 10_00, netQuantity: 3, unit: 'piece' }).unitPriceMinor).toBe(333);
  });

  it('flags the low-value exemption (≤ ₹35) but still computes the figure', () => {
    const r = unitSalePrice({ mrpMinor: UNIT_PRICE_LOW_VALUE_MINOR, netQuantity: 100, unit: 'g' });
    expect(r.exempt).toBe(true);
    expect(r.exemptReason).toContain('₹35');
    expect(r.unitPriceMinor).toBeGreaterThan(0); // computed anyway
  });

  it('flags the small-panel exemption (≤ 100 cm²)', () => {
    const r = unitSalePrice({ mrpMinor: 100_00, netQuantity: 500, unit: 'g', principalPanelAreaCm2: 80 });
    expect(r.exempt).toBe(true);
    expect(r.exemptReason).toContain('cm²');
  });

  it('is not exempt for a normal-sized, normal-value pack', () => {
    expect(unitSalePrice({ mrpMinor: 100_00, netQuantity: 500, unit: 'g', principalPanelAreaCm2: 150 }).exempt).toBe(false);
  });

  it('refuses a non-positive MRP, a non-whole net quantity, and an unknown unit', () => {
    expect(() => unitSalePrice({ mrpMinor: 0, netQuantity: 500, unit: 'g' })).toThrow(InvalidUnitPriceInput);
    expect(() => unitSalePrice({ mrpMinor: 100_00, netQuantity: 1.5, unit: 'kg' })).toThrow(InvalidUnitPriceInput);
    expect(() => unitSalePrice({ mrpMinor: 100_00, netQuantity: 500, unit: 'dozen' as never })).toThrow(InvalidUnitPriceInput);
  });
});
