import { describe, it, expect } from 'vitest';
import {
  validatePack,
  unitsPerLevel,
  toBaseUnits,
  fromBaseUnits,
  conversionIsReversible,
  BarcodeRegistry,
  barcodeCoverageGaps,
  DuplicateBarcodeError,
  InvalidPackError,
  UnknownPackLevelError,
  type PackHierarchy,
} from '../../packages/product/src/index';

// M03-FR-02 — a case of 24 must become exactly 24 singles, and one barcode must
// belong to exactly one item. Both are where a catalogue silently goes wrong.

const CASE_PACK: PackHierarchy = {
  productId: 'p1',
  baseUom: 'each',
  levels: [
    { level: 'unit', containsMinor: 1, barcode: '8901234567890' },
    { level: 'inner', containsMinor: 6 },
    { level: 'case', containsMinor: 4, barcode: '18901234567897' },
  ],
};

describe('pack hierarchy — exact and reversible conversion (M03-FR-02)', () => {
  it('converts a case to the correct unit count at receiving (acceptance)', () => {
    expect(unitsPerLevel(CASE_PACK, 'unit')).toBe(1);
    expect(unitsPerLevel(CASE_PACK, 'inner')).toBe(6);
    expect(unitsPerLevel(CASE_PACK, 'case')).toBe(24); // 6 per inner × 4 inners
    expect(toBaseUnits(CASE_PACK, 2, 'case')).toBe(48);
  });

  it('converts back to whole packs and a remainder — never half a case', () => {
    expect(fromBaseUnits(CASE_PACK, 48, 'case')).toEqual({ packs: 2, remainderBaseUnits: 0 });
    expect(fromBaseUnits(CASE_PACK, 50, 'case')).toEqual({ packs: 2, remainderBaseUnits: 2 });
    expect(fromBaseUnits(CASE_PACK, 5, 'case')).toEqual({ packs: 0, remainderBaseUnits: 5 });
  });

  it('round-trips exactly at every level', () => {
    for (const level of ['unit', 'inner', 'case']) {
      expect(conversionIsReversible(CASE_PACK, level)).toBe(true);
    }
  });

  it('refuses a pack that could never be exact', () => {
    expect(() =>
      validatePack({ productId: 'p1', baseUom: 'each', levels: [{ level: 'unit', containsMinor: 1 }, { level: 'case', containsMinor: 2.5 }] }),
    ).toThrow(InvalidPackError);
    expect(() =>
      validatePack({ productId: 'p1', baseUom: 'each', levels: [{ level: 'case', containsMinor: 24 }] }),
    ).toThrow(/base level must contain exactly 1/);
    expect(() => validatePack({ productId: 'p1', baseUom: 'each', levels: [] })).toThrow(
      /no levels/,
    );
    expect(() =>
      validatePack({
        productId: 'p1',
        baseUom: 'each',
        levels: [
          { level: 'unit', containsMinor: 1 },
          { level: 'unit', containsMinor: 6 },
        ],
      }),
    ).toThrow(/share a name/);
  });

  it('refuses a level the product does not have', () => {
    expect(() => unitsPerLevel(CASE_PACK, 'pallet')).toThrow(UnknownPackLevelError);
  });
});

describe('BarcodeRegistry — one code, one item (M03-FR-02 acceptance)', () => {
  it('refuses the same barcode on two different products, naming the owner', () => {
    const registry = new BarcodeRegistry([
      { code: '8901234567890', productId: 'p1', kind: 'ean' },
    ]);
    try {
      registry.register({ code: '8901234567890', productId: 'p2', kind: 'ean' });
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateBarcodeError);
      expect((error as DuplicateBarcodeError).ownedBy).toBe('p1');
      expect((error as Error).message).toContain('already belongs to product "p1"');
    }
  });

  it('lets the same product re-register its own code, so an import can be re-run', () => {
    const registry = new BarcodeRegistry([{ code: '890', productId: 'p1', kind: 'ean' }]);
    expect(() => registry.register({ code: '890', productId: 'p1', kind: 'ean' })).not.toThrow();
    expect(registry.size()).toBe(1);
  });

  it('holds several codes for one item and looks any of them up', () => {
    const registry = new BarcodeRegistry([
      { code: '8901234567890', productId: 'p1', kind: 'ean' },
      { code: '18901234567897', productId: 'p1', kind: 'case', level: 'case' },
      { code: 'INT-0001', productId: 'p1', kind: 'internal' },
    ]);
    expect(registry.forProduct('p1')).toHaveLength(3);
    expect(registry.lookup('18901234567897')?.level).toBe('case');
    expect(registry.lookup('  INT-0001 ')?.productId).toBe('p1');
    expect(registry.lookup('nope')).toBeUndefined();
  });

  it('reports products that cannot be scanned at all', () => {
    const registry = new BarcodeRegistry([{ code: '890', productId: 'p1', kind: 'ean' }]);
    expect(barcodeCoverageGaps(['p1', 'p2', 'p3'], registry)).toEqual(['p2', 'p3']);
  });
});
