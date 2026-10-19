import { describe, it, expect } from 'vitest';
import {
  plasticReturn, financialYearOf, financialYearBounds, eprSettingStatuses, recyclersById, registeredRecycler, assertTakeBackLeavesOnlyToARecycler,
  takeBackStock, assertWithinTakeBackStock, takeBackStockExceptions, disposedAssetExceptions, EprRefusal, TAKE_BACK_LOCATION,
  type OwnBrandDeclaration, type UnitsMovement, type TakeBack, type Handover, type Recycler,
} from '../../packages/epr/src/index';

/**
 * **R4 · B20 · B21 · B22 · OB-212 — the EPR registers (the pure engine).** The plastic put on the market per category from
 * own-brand declarations and the units received and produced; a missing declaration an exception, never zero; the
 * registration / exemption / brand-owner answers "not confirmed" until confirmed; take-back stock never saleable and
 * leaving only to a registered recycler; on hand = taken back − handed over, a count that differs an exception; a
 * disposed asset with no handover an exception. Synthetic data.
 */

const decl = (productId: string, packaging: OwnBrandDeclaration['packaging'], ownBrand = true): OwnBrandDeclaration => ({ productId, ownBrand, packaging, by: 'u', at: 'x' });
const mv = (productId: string, kind: 'received' | 'produced', quantityMinor: number, date: string, uom = 'EA'): UnitsMovement => ({ productId, kind, quantityMinor, uom, date });

describe('B20 · plastic put on the market, per category, to the gram', () => {
  const declarations = [
    decl('P-JAR', [{ category: 'I', weightPerUnitMg: 12_500 }, { category: 'II', weightPerUnitMg: 1_200 }]),
    decl('P-SACHET', [{ category: 'II', weightPerUnitMg: 2_500 }]),
    decl('P-NODECL', []),
    decl('P-BRANDX', [{ category: 'I', weightPerUnitMg: 99_000 }], false),
    decl('P-RICE', [{ category: 'II', weightPerUnitMg: 4_000 }]),
  ];
  const movements = [
    mv('P-JAR', 'received', 100, '2030-04-01'), mv('P-JAR', 'received', 30, '2030-03-31'), mv('P-JAR', 'received', 50, '2031-04-01'),
    mv('P-SACHET', 'received', 1_000, '2030-06-01'), mv('P-SACHET', 'produced', 200, '2030-07-01'),
    mv('P-NODECL', 'received', 40, '2030-05-01'), mv('P-BRANDX', 'received', 999, '2030-05-01'), mv('P-RICE', 'received', 25_000, '2030-05-01', 'kg'),
  ];
  const r = plasticReturn({ financialYear: '2030-31', declarations, movements });

  it('counts only own-brand products, only the year\'s receipts and production, per category', () => {
    expect(r.from).toBe('2030-04-01');
    expect(r.to).toBe('2031-03-31');
    const cat = Object.fromEntries(r.categories.map((c) => [c.category, c]));
    expect(cat['I']).toMatchObject({ products: 1, units: 100, totalMg: 1_250_000, totalGrams: 1_250 });
    // P-JAR film 100 × 1.2 g + P-SACHET 1,200 × 2.5 g (1,000 received, 200 produced).
    expect(cat['II']).toMatchObject({ products: 2, units: 1_300, totalMg: 3_120_000, totalGrams: 3_120 });
    expect(cat['III']).toMatchObject({ products: 0, totalGrams: 0 });
    expect(r.rows.find((x) => x.productId === 'P-SACHET')).toMatchObject({ unitsReceived: 1_000, unitsProduced: 200, units: 1_200 });
    expect(r.rows.some((x) => x.productId === 'P-BRANDX')).toBe(false);
  });

  it('an own-brand product with no packaging declared is an exception and is never counted as zero', () => {
    expect(r.exceptions.map((e) => [e.productId, e.kind])).toEqual([['P-NODECL', 'packaging_declaration_missing'], ['P-RICE', 'not_counted_in_items']]);
    expect(r.exceptions[0]!.detail).toMatch(/^packaging declaration missing: P-NODECL/);
    expect(r.rows.some((x) => x.productId === 'P-NODECL')).toBe(false);
    expect(r.incomplete).toBe(true);
  });

  it('is a sortable CSV for the CPCB portal, rows by category then product, then totals and exceptions; nothing is filed', () => {
    const lines = r.csv.trim().split('\n');
    expect(lines[0]).toBe('financial_year,category,product_id,plastic_per_unit_g,units_received,units_produced,units_put_on_market,plastic_g');
    expect(lines.slice(1, 4)).toEqual(['2030-31,I,P-JAR,12.500,100,0,100,1250.000', '2030-31,II,P-JAR,1.200,100,0,100,120.000', '2030-31,II,P-SACHET,2.500,1000,200,1200,3000.000']);
    expect(lines).toContain('2030-31,II,TOTAL,,,,1300,3120');
    expect(lines.some((l) => l.includes('EXCEPTION') && l.includes('P-NODECL'))).toBe(true);
    expect(r.filing).toBe('not_filed_by_the_system');
  });

  it('a financial year is April to March; a malformed one is refused', () => {
    expect(financialYearOf('2031-03-31')).toBe('2030-31');
    expect(financialYearOf('2031-04-01')).toBe('2031-32');
    expect(() => financialYearBounds('2030-32')).toThrow(/2026-27/);
  });

  it('the registration, exemption and brand-owner answers are "not confirmed" until they name who confirmed them', () => {
    expect(eprSettingStatuses([]).every((s) => s.status === 'not_confirmed')).toBe(true);
    const s = eprSettingStatuses([
      { key: 'plasticRegistration', setting: { value: 'PWM-TEST-1', confirmation: null }, by: 'u', at: 'x' },
      { key: 'plasticExemption', setting: { value: 'none', confirmation: 'EPR consultant (test) ref E-1' }, by: 'u', at: 'x' },
    ]);
    expect(Object.fromEntries(s.map((x) => [x.key, x.status]))).toEqual({ plasticRegistration: 'not_confirmed', plasticExemption: 'confirmed', eWasteBrandOwner: 'not_confirmed', batteryBrandOwner: 'not_confirmed' });
  });
});

describe('B21 · B22 · take-back and handover', () => {
  const recyclers = recyclersById([
    { recyclerId: 'r-ok', name: 'Green Recyclers (test)', registrationNumber: 'TNPCB-EW-TEST-1', by: 'u', at: 'x' },
    { recyclerId: 'r-none', name: 'Kabadi (test)', registrationNumber: null, by: 'u', at: 'x' },
  ] as Recycler[]);
  const tb = (takeBackId: string, kind: 'e_waste' | 'battery', weightGrams: number, batteryType?: string): TakeBack => ({
    takeBackId, kind, description: 'x', weightGrams, ...(batteryType === undefined ? {} : { batteryType }), on: '2030-05-01', location: TAKE_BACK_LOCATION, by: 'u', at: 'x',
  });
  const ho = (kind: 'e_waste' | 'battery', source: 'take_back' | 'shop', lines: Handover['lines']): Handover => ({ handoverId: 'h', kind, source, recyclerId: 'r-ok', registrationNumber: 'TNPCB-EW-TEST-1', lines, note: 'n', on: '2030-05-02', by: 'u', at: 'x' });

  it('a handover goes only to a recycler with a recorded registration number — "recycler not registered"', () => {
    expect(registeredRecycler(recyclers, 'r-ok').registrationNumber).toBe('TNPCB-EW-TEST-1');
    expect(() => registeredRecycler(recyclers, 'r-none')).toThrow('recycler not registered: Kabadi (test) has no registration number recorded');
    expect(() => registeredRecycler(recyclers, 'r-ghost')).toThrow(EprRefusal);
  });

  it('take-back stock is never saleable: it leaves only to a recycler — "not saleable: take-back stock"', () => {
    for (const kind of ['sale', 'shelf', 'transfer', 'return_to_stock']) {
      expect(() => assertTakeBackLeavesOnlyToARecycler({ kind })).toThrow(/^not saleable: take-back stock/);
    }
    expect(() => assertTakeBackLeavesOnlyToARecycler({ kind: 'recycler' })).not.toThrow();
  });

  it('on hand = taken back − handed over, batteries by type; the shop\'s own handovers do not touch it', () => {
    const stock = takeBackStock(
      [tb('t1', 'battery', 1_500, 'Lead-acid'), tb('t2', 'battery', 300, 'lithium-ion'), tb('t3', 'battery', 500, 'lead-acid'), tb('t4', 'e_waste', 2_000)],
      [ho('battery', 'take_back', [{ description: 'b', weightGrams: 1_200, batteryType: 'lead-acid' }]), ho('e_waste', 'shop', [{ description: 'old till', weightGrams: 9_000, assetId: 'FA-1' }])],
    );
    expect(stock.map((s) => [s.stockKey, s.takenBackGrams, s.handedOverGrams, s.onHandGrams, s.saleable])).toEqual([
      ['battery:lead-acid', 2_000, 1_200, 800, false], ['battery:lithium-ion', 300, 0, 300, false], ['e_waste', 2_000, 0, 2_000, false],
    ]);
    expect(() => assertWithinTakeBackStock(stock, 'battery', [{ description: 'b', weightGrams: 801, batteryType: 'lead-acid' }])).toThrow(/only 800 g is held/);
    expect(() => assertWithinTakeBackStock(stock, 'battery', [{ description: 'b', weightGrams: 800, batteryType: 'LEAD-ACID' }])).not.toThrow();
    // A count that differs from the register is an exception; one that agrees is not.
    const ex = takeBackStockExceptions(stock, [
      { countId: 'c1', kind: 'battery', batteryType: 'lead-acid', countedGrams: 700, on: '2030-05-03', by: 'u', at: 'x' },
      { countId: 'c2', kind: 'battery', batteryType: 'lithium-ion', countedGrams: 300, on: '2030-05-03', by: 'u', at: 'x' },
    ]);
    expect(ex).toEqual([expect.objectContaining({ stockKey: 'battery:lead-acid', countedGrams: 700, onHandGrams: 800, differenceGrams: -100 })]);
  });

  it('a disposed fixed asset with no e-waste handover is an exception, until a handover names it or a person says it was not e-waste', () => {
    const assets = [
      { assetId: 'FA-1', name: 'Till 3', category: 'IT equipment', disposedOn: '2030-04-10' },
      { assetId: 'FA-2', name: 'Weighing scale', category: 'Equipment', disposedOn: '2030-04-11' },
      { assetId: 'FA-3', name: 'Display rack', category: 'Furniture', disposedOn: '2030-04-12' },
    ];
    const handovers = [ho('e_waste', 'shop', [{ description: 'Till 3', weightGrams: 9_000, assetId: 'FA-1' }])];
    expect(disposedAssetExceptions(assets, handovers, []).map((a) => a.assetId)).toEqual(['FA-2', 'FA-3']);
    expect(disposedAssetExceptions(assets, handovers, [{ assetId: 'FA-3', reason: 'steel rack, no electrics', by: 'u', at: 'x' }]).map((a) => a.assetId)).toEqual(['FA-2']);
  });
});
