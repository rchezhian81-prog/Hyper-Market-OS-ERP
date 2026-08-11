import { describe, it, expect } from 'vitest';
import { checkSingleUsePlastic, type PlasticLine } from '../../packages/restricted-sales/src/index';

// B19 (Plastic Waste Management Rules): no banned single-use plastic; a plastic carry bag must be ≥ 120 µm;
// a carry bag must be a separate priced line (never free).

const bag = (o: Partial<PlasticLine> = {}): PlasticLine =>
  ({ lineId: 'b1', productId: 'carry-bag', unitPriceMinor: 500, isCarryBag: true, material: 'plastic', plasticThicknessMicrons: 120, ...o });
const groceries: PlasticLine = { lineId: 'g1', productId: 'rice-5kg', unitPriceMinor: 45000 };

describe('single-use-plastic gate (B19)', () => {
  it('allows a compliant 120 µm priced plastic carry bag alongside ordinary goods', () => {
    const r = checkSingleUsePlastic({ lines: [bag(), groceries] });
    expect(r.allowed).toBe(true);
    expect(r.blocks).toHaveLength(0);
  });

  it('blocks a plastic carry bag below the 120 µm minimum', () => {
    const r = checkSingleUsePlastic({ lines: [bag({ plasticThicknessMicrons: 50 })] });
    expect(r.allowed).toBe(false);
    expect(r.blocks[0]!.reason).toBe('carry_bag_below_min_thickness');
  });

  it('blocks a plastic carry bag whose thickness the master data cannot prove', () => {
    const r = checkSingleUsePlastic({ lines: [bag({ plasticThicknessMicrons: undefined })] });
    expect(r.blocks.map((b) => b.reason)).toContain('carry_bag_below_min_thickness');
  });

  it('blocks a banned single-use-plastic SKU outright', () => {
    const r = checkSingleUsePlastic({ lines: [{ lineId: 's1', productId: 'plastic-straw', unitPriceMinor: 200, bannedSingleUsePlastic: true }] });
    expect(r.allowed).toBe(false);
    expect(r.blocks[0]!.reason).toBe('banned_single_use_plastic');
  });

  it('blocks a carry bag given free (not a separate priced line), whatever the material', () => {
    expect(checkSingleUsePlastic({ lines: [bag({ unitPriceMinor: 0 })] }).blocks.map((b) => b.reason)).toContain('carry_bag_not_priced');
    // A cloth bag is exempt from the micron rule but still must be billed.
    const cloth = checkSingleUsePlastic({ lines: [bag({ material: 'cloth', plasticThicknessMicrons: undefined, unitPriceMinor: 0 })] });
    expect(cloth.blocks.map((b) => b.reason)).toEqual(['carry_bag_not_priced']);
  });

  it('exempts cloth / paper / certified-compostable carry bags from the micron rule', () => {
    for (const material of ['cloth', 'paper', 'compostable']) {
      const r = checkSingleUsePlastic({ lines: [bag({ material, plasticThicknessMicrons: undefined })] });
      expect(r.allowed).toBe(true);
    }
  });

  it('reports both faults on one bag at once (too thin AND free) and ignores ordinary goods', () => {
    const r = checkSingleUsePlastic({ lines: [bag({ plasticThicknessMicrons: 40, unitPriceMinor: 0 }), groceries] });
    expect(r.blocks.map((b) => b.reason).sort()).toEqual(['carry_bag_below_min_thickness', 'carry_bag_not_priced']);
  });

  it('respects a store’s configured minimum thickness', () => {
    // A 120 µm bag passes the default but fails a stricter 150 µm store rule.
    expect(checkSingleUsePlastic({ lines: [bag()], minCarryBagMicrons: 150 }).blocks[0]!.reason).toBe('carry_bag_below_min_thickness');
  });
});
