import { describe, it, expect } from 'vitest';
import {
  costCatchWeight,
  priceByWeight,
  buildScaleBarcode,
  buildScaleLabel,
  ean13CheckDigit,
  requireDepartment,
  InvalidCatchWeightError,
  ScaleLabelError,
  type CatchWeightRun,
  type WeighedPack,
} from '../../packages/production/src/index';
import { CatalogueCache, type EmbeddedBarcodeRule } from '../../packages/catalogue/src/catalogue';
import { money } from '../../packages/contracts/src/money';

// M11-FR-02/03 for WEIGHED departments — the butcher, the fish counter, the deli.
// This is a multi-tenant product (OB-01): every department the roadmap names is
// built, and each tenant enables the ones it operates.

const INR = 'INR' as const;
const AT = '2026-08-03T07:00:00Z';

/** A tenant that runs a meat counter, a deli and a bakery. */
const WEIGHED_TENANT = ['meat_fish', 'deli', 'bakery'];

describe('a tenant that operates weighed counters gets them', () => {
  it('enables the departments this tenant actually runs', () => {
    expect(requireDepartment('meat_fish', WEIGHED_TENANT).weighedOutput).toBe(true);
    expect(requireDepartment('deli', WEIGHED_TENANT).legalMetrology).toBe(true);
    expect(requireDepartment('bakery', WEIGHED_TENANT).coldChain).toBe(false);
    // ...and still refuses one it does not.
    expect(() => requireDepartment('cafe', WEIGHED_TENANT)).toThrow(/it operates: meat_fish, deli, bakery/);
  });
});

describe('costCatchWeight — the bin was paid for too (M11-FR-02)', () => {
  function run(over: Partial<CatchWeightRun> = {}): CatchWeightRun {
    return {
      runId: 'cut-1',
      departmentId: 'meat_fish',
      inputs: [{ productId: 'mutton-carcass', weightGrams: 12_400, costPerKg: money(60_000, INR) }],
      outputs: [
        { productId: 'mutton-curry-cut', weightGrams: 8_900 },
        { productId: 'bone', weightGrams: 2_000, isByproduct: true },
      ],
      standardYieldBp: 8_800,
      toleranceBp: 300,
      at: AT,
      ...over,
    };
  }

  it('makes the surviving meat carry the whole cost of the carcass', () => {
    const result = costCatchWeight(run(), INR);
    // 12.4 kg × ₹600.00 = ₹7,440.00 went in.
    expect(result.inputCost).toEqual({ minor: 744_000, currency: INR });
    // All of it lands on the 8.9 kg that can be sold — not on the bone.
    const cut = result.outputs.find((o) => o.productId === 'mutton-curry-cut');
    expect(cut?.allocatedCost).toEqual({ minor: 744_000, currency: INR });
    // ₹600/kg in becomes ₹835.96/kg out. Price the shelf off the input figure and
    // the counter loses money on every kilo.
    expect(cut?.costPerKg).toEqual({ minor: 83_596, currency: INR });
    expect(result.outputs.find((o) => o.isByproduct)?.allocatedCost.minor).toBe(0);
  });

  it('reports the loss and the yield exactly', () => {
    const result = costCatchWeight(run(), INR);
    expect(result.inputWeightGrams).toBe(12_400);
    expect(result.outputWeightGrams).toBe(10_900);
    expect(result.lossGrams).toBe(1_500);
    expect(result.yieldBp).toBe(8_790); // 87.90%
    expect(result.verdict).toBe('as_expected');
    expect(result.exceptions).toEqual([]);
  });

  it('flags a bad yield with the money attached — the thing you cannot see otherwise', () => {
    const poor = costCatchWeight(
      run({ outputs: [{ productId: 'mutton-curry-cut', weightGrams: 7_400 }] }),
      INR,
    );
    expect(poor.verdict).toBe('low_yield');
    expect(poor.exceptions[0]?.detail).toContain('yield 59.7% against a standard of 88.0%');
    expect(poor.exceptions[0]?.detail).toContain('a heavy hand, or stock leaving another way');
    expect(poor.exceptions[0]?.value.minor).toBeGreaterThan(0);
  });

  it('flags a yield that is too good — the standard or the scale is wrong', () => {
    const high = costCatchWeight(
      run({ outputs: [{ productId: 'mutton-curry-cut', weightGrams: 12_000 }] }),
      INR,
    );
    expect(high.verdict).toBe('high_yield');
    expect(high.exceptions[0]?.detail).toContain('The standard or the weighing is wrong');
  });

  it('catches more coming out than went in — that is not physics', () => {
    const impossible = costCatchWeight(
      run({ outputs: [{ productId: 'mutton-curry-cut', weightGrams: 13_000 }] }),
      INR,
    );
    expect(impossible.exceptions.some((e) => e.kind === 'gained_weight')).toBe(true);
    expect(impossible.exceptions[0]?.detail).toContain('600 g more came out than went in');
  });

  it('splits cost between prime and secondary cuts by value, to the paisa', () => {
    const result = costCatchWeight(
      run({
        outputs: [
          { productId: 'prime', weightGrams: 3_000, costWeightBp: 7_000 },
          { productId: 'secondary', weightGrams: 5_900, costWeightBp: 3_000 },
          { productId: 'bone', weightGrams: 2_000, isByproduct: true },
        ],
      }),
      INR,
    );
    const allocated = result.outputs.reduce((sum, o) => sum + o.allocatedCost.minor, 0);
    // The parts sum to the whole — not "about" the whole (§29.1).
    expect(allocated).toBe(744_000);
    expect(result.outputs[0]?.allocatedCost.minor).toBe(520_800); // 70%
    expect(result.outputs[1]?.allocatedCost.minor).toBe(223_200); // 30%
  });

  it('refuses fractional or impossible weights', () => {
    expect(() =>
      costCatchWeight(run({ inputs: [{ productId: 'x', weightGrams: 12.5, costPerKg: money(100, INR) }] }), INR),
    ).toThrow(InvalidCatchWeightError);
    expect(() => costCatchWeight(run({ inputs: [] }), INR)).toThrow(/nothing went in/);
  });

  it('prices a pack from its weight, exact to the paisa', () => {
    expect(priceByWeight(money(60_000, INR), 8_900)).toEqual({ minor: 534_000, currency: INR });
    expect(priceByWeight(money(29_900, INR), 337)).toEqual({ minor: 10_076, currency: INR });
  });
});

describe('scale labels scan correctly at the till (M11-FR-03 acceptance)', () => {
  // The tenant's own rule — prefix "2", item code at 1..6, weight in grams at 7..12.
  const WEIGHT_RULE: EmbeddedBarcodeRule = {
    prefix: '2',
    itemStart: 1,
    itemLength: 6,
    valueStart: 7,
    valueLength: 5,
    valueKind: 'weight',
  };

  const PACK: WeighedPack = {
    itemCode: '100234',
    productName: 'Mutton curry cut',
    batchId: 'B-MUT-001',
    weightGrams: 850,
    pricePerKg: money(90_000, INR), // ₹900.00 per kg
    useBy: '2026-08-05T18:00:00Z',
    netQuantity: '850 g',
    packerDetails: 'SRE Hyper Market, Meat counter',
    allergens: [],
  };

  it('prices the label from the weight and prints the barcode', () => {
    const label = buildScaleLabel(PACK, WEIGHT_RULE);
    expect(label.price).toEqual({ minor: 76_500, currency: INR }); // 0.850 kg × ₹900
    expect(label.lines).toContain('Weight 0.850 kg');
    expect(label.lines).toContain('INR 765.00');
    expect(label.barcode).toHaveLength(13);
  });

  it('the label the counter prints scans back through the real catalogue', () => {
    const label = buildScaleLabel(PACK, WEIGHT_RULE);

    // The acid test: the till's own catalogue reads the counter's own sticker.
    const catalogue = new CatalogueCache({
      tenantId: 't1',
      version: 1,
      builtAt: AT,
      products: [
        {
          productId: 'p-mutton',
          sku: '100234',
          name: 'Mutton curry cut',
          baseUom: 'g',
          unitPriceMinor: 90,
          taxBps: 0,
          status: 'active',
        },
      ],
      barcodes: [{ code: '100234', productId: 'p-mutton', kind: 'standard' }],
      embeddedRules: [WEIGHT_RULE],
    });

    const scan = catalogue.scan(label.barcode);
    expect(scan.product.productId).toBe('p-mutton');
    expect(scan.barcodeKind).toBe('weight_embedded');
    // The weight the counter put on the sticker is the weight the till rings up.
    expect(scan.quantityMinor).toBe(850);
  });

  it('round-trips a price-embedded label too, for scales that print value', () => {
    const priceRule: EmbeddedBarcodeRule = { ...WEIGHT_RULE, valueKind: 'price' };
    const label = buildScaleLabel(PACK, priceRule);
    const catalogue = new CatalogueCache({
      tenantId: 't1',
      version: 1,
      builtAt: AT,
      products: [
        { productId: 'p-mutton', sku: '100234', name: 'Mutton curry cut', baseUom: 'g', unitPriceMinor: 90, taxBps: 0, status: 'active' },
      ],
      barcodes: [{ code: '100234', productId: 'p-mutton', kind: 'standard' }],
      embeddedRules: [priceRule],
    });

    const scan = catalogue.scan(label.barcode);
    expect(scan.barcodeKind).toBe('price_embedded');
    expect(scan.priceOverrideMinor).toBe(76_500);
    expect(scan.quantityMinor).toBe(1);
  });

  it('computes the check digit rather than assuming it', () => {
    // A published EAN-13 (4006381333931), so the algorithm is checked against the
    // real standard rather than against itself.
    expect(ean13CheckDigit('400638133393')).toBe('1');
    expect(ean13CheckDigit('890123456789')).toBe('0');
    expect(() => ean13CheckDigit('12345')).toThrow(ScaleLabelError);
    const barcode = buildScaleBarcode({ rule: WEIGHT_RULE, itemCode: '100234', value: 850 });
    expect(barcode[12]).toBe(ean13CheckDigit(barcode.slice(0, 12)));
  });

  it('refuses to truncate a value that does not fit — that would charge the wrong amount', () => {
    expect(() =>
      buildScaleBarcode({ rule: WEIGHT_RULE, itemCode: '100234', value: 123_456 }),
    ).toThrow(/too heavy for this barcode format/);

    const priceRule: EmbeddedBarcodeRule = { ...WEIGHT_RULE, valueKind: 'price' };
    expect(() =>
      buildScaleBarcode({ rule: priceRule, itemCode: '100234', value: 999_999 }),
    ).toThrow(/too high for this barcode format/);
  });

  it('refuses an item code that does not match the tenant’s rule, or a weightless pack', () => {
    expect(() => buildScaleBarcode({ rule: WEIGHT_RULE, itemCode: '123', value: 100 })).toThrow(
      /expects 6/,
    );
    expect(() => buildScaleLabel({ ...PACK, weightGrams: 0 }, WEIGHT_RULE)).toThrow(
      /cannot weigh nothing/,
    );
  });
});
