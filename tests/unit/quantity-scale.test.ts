import { describe, it, expect } from 'vitest';
import { normaliseUom, minorPerUnit, minorPerUnitOf, valueAtUnitCost } from '../../packages/contracts/src/quantity';
import { weightedAverageValuation } from '../../packages/stock/src/valuation';
import { threeWayMatch } from '../../packages/purchasing/src/three-way-match';

/** OB-31 "A" (owner, 10 Oct 2026): grams for weighed goods, cost per kg, value rounded once — one rule for every section. */
describe('OB-31 — the quantity scale', () => {
  it('normalises the spellings people use to one code, and names an unknown one as unknown', () => {
    expect(['ea', 'each', 'EA', 'Each', 'pcs', 'NOS', ' unit '].map(normaliseUom)).toEqual(['ea', 'ea', 'ea', 'ea', 'ea', 'ea', 'ea']);
    expect(['kg', 'KG', 'Kgs', 'kilo'].map(normaliseUom)).toEqual(['kg', 'kg', 'kg', 'kg']);
    expect(['l', 'L', 'ltr', 'LTR', 'litre'].map(normaliseUom)).toEqual(['L', 'L', 'L', 'L', 'L']);
    expect(['g', 'gm', 'ml', 'ML'].map(normaliseUom)).toEqual(['g', 'g', 'ml', 'ml']);
    expect(normaliseUom('case')).toBeUndefined();
    expect(normaliseUom('')).toBeUndefined();
  });

  it('a kg is 1000 smallest steps (grams), a litre 1000 (ml), an item 1', () => {
    expect([minorPerUnit('ea'), minorPerUnit('kg'), minorPerUnit('L'), minorPerUnit('g'), minorPerUnit('ml')]).toEqual([1, 1000, 1000, 1, 1]);
    expect(minorPerUnitOf('KG')).toBe(1000);
    expect(minorPerUnitOf('bag')).toBe(1);
  });

  it('value = steps × per-unit cost ÷ steps per unit, rounded ONCE, half up: 2500 g at ₹45/kg = ₹112.50; 333 g at ₹45/kg = ₹14.99 (14.985 up)', () => {
    expect(valueAtUnitCost(2_500, 'kg', 4_500)).toBe(11_250);
    expect(valueAtUnitCost(333, 'kg', 4_500)).toBe(1_499);
    expect(valueAtUnitCost(12, 'ea', 1_800)).toBe(21_600);
    expect(valueAtUnitCost(-30, 'kg', 4_500)).toBe(-135);
  });

  it('valuation: kg receipts in grams re-average per KG; issues leave at that average; the unit cost reads back per kg', () => {
    const rows = weightedAverageValuation([
      { productId: 'R', locationId: 'S', effect: 1, quantityMinor: 10_000, isPurchaseReceipt: true, unitCostMinor: 4_000, minorPerUnit: 1000 },
      { productId: 'R', locationId: 'S', effect: 1, quantityMinor: 10_000, isPurchaseReceipt: true, unitCostMinor: 5_000, minorPerUnit: 1000 },
      { productId: 'R', locationId: 'S', effect: -1, quantityMinor: 5_000, isPurchaseReceipt: false, minorPerUnit: 1000 },
    ], 'INR');
    expect(rows[0]).toMatchObject({ onHandMinor: 15_000, value: { minor: 67_500 }, unitCostMinor: 4_500, cogs: { minor: 22_500 } });
  });

  it('the three-way match pays grams at the per-kg price', () => {
    const r = threeWayMatch({ lines: [{ productId: 'R', orderedQty: 25_250, receivedQty: 25_250, invoicedQty: 25_250, orderedUnitMinor: 4_500, invoicedUnitMinor: 4_500, minorPerUnit: 1000 }] });
    expect(r).toMatchObject({ payableMinor: 113_625, invoicedMinor: 113_625, withheldMinor: 0, blocked: false });
  });
});
