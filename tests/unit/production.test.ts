import { describe, it, expect } from 'vitest';
import {
  requireDepartment,
  operatedDepartments,
  DEPARTMENT_CATALOGUE,
  DepartmentNotOperatedError,
  UnknownDepartmentError,
  planProduction,
  produceBatch,
  validateRecipe,
  InvalidRecipeError,
  InsufficientMaterialError,
  buildPackLabel,
  renderLabel,
  releaseForSale,
  repack,
  IncompleteLabelError,
  RepackError,
  type PackLabel,
  type ProductionRun,
  type Recipe,
} from '../../packages/production/src/index';
import { projectStock, availableToSell } from '../../packages/stock/src/index';
import { money } from '../../packages/contracts/src/money';

// M11 — in-store production, built for the departments the store actually operates.
// SRE runs a CAFE and nothing else (owner, 3 Aug 2026 — OB-04, closing AVR-12).

const INR = 'INR' as const;
const AT = '2026-08-03T07:00:00Z';

/** SRE's setting: the one department switched on. */
const OPERATED = ['cafe'];

const FILTER_COFFEE: Recipe = {
  recipeId: 'rec-coffee',
  departmentId: 'cafe',
  outputProductId: 'coffee-cup',
  outputQuantityMinor: 20, // 20 cups per batch
  outputUom: 'cup',
  inputs: [
    { productId: 'coffee-powder', quantityMinor: 300, uom: 'g' },
    { productId: 'milk', quantityMinor: 3_000, uom: 'ml' },
    { productId: 'sugar', quantityMinor: 200, uom: 'g' },
  ],
  shelfLifeHours: 4,
  yieldToleranceBp: 500, // 5%
};

const AVAILABLE = { 'coffee-powder': 5_000, milk: 20_000, sugar: 4_000 };
const COSTS = {
  'coffee-powder': money(80, INR), // ₹0.80 per gram
  milk: money(6, INR), // ₹0.06 per ml
  sugar: money(5, INR),
};

function run(over: Partial<ProductionRun> = {}): ProductionRun {
  return {
    runId: 'run-1',
    recipe: FILTER_COFFEE,
    batches: 2,
    locationId: 'cafe-counter',
    producedBy: 'barista-1',
    at: AT,
    outputBatchId: 'B-COF-001',
    actualOutputMinor: 40,
    ...over,
  };
}

describe('departments — never a module for a counter the store does not have', () => {
  it('runs the cafe, because that is what this store operates (OB-04)', () => {
    const cafe = requireDepartment('cafe', OPERATED);
    expect(cafe.label).toBe('Cafe');
    expect(cafe.foodSafety).toBe(true);
    // A cafe sells by the cup and the piece, not the kilo.
    expect(cafe.weighedOutput).toBe(false);
  });

  it('refuses a department this store does not operate, listing what it does', () => {
    try {
      requireDepartment('meat_fish', OPERATED);
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(DepartmentNotOperatedError);
      expect((error as Error).message).toContain('it operates: cafe');
      expect((error as Error).message).toContain('never built or enabled');
    }
  });

  it('offers other departments for other tenants — one shop’s answer is not everyone’s', () => {
    // The catalogue exists so a different tenant can switch one on (OB-01)...
    expect(Object.keys(DEPARTMENT_CATALOGUE)).toContain('bakery');
    expect(DEPARTMENT_CATALOGUE['deli']?.weighedOutput).toBe(true);
    // ...but being listed is not being enabled.
    expect(() => requireDepartment('bakery', OPERATED)).toThrow(DepartmentNotOperatedError);
    expect(operatedDepartments(OPERATED).map((d) => d.departmentId)).toEqual(['cafe']);
  });

  it('refuses a department it has never heard of', () => {
    expect(() => requireDepartment('sushi_bar', ['sushi_bar'])).toThrow(UnknownDepartmentError);
  });

  it('operates nothing when a tenant has switched nothing on — the default', () => {
    expect(operatedDepartments([])).toEqual([]);
    expect(() => requireDepartment('cafe', [])).toThrow(/it operates: none/);
  });
});

describe('recipes and production runs (M11-FR-01)', () => {
  it('scales a recipe to the number of batches', () => {
    const plan = planProduction(FILTER_COFFEE, 3);
    expect(plan.expectedOutputMinor).toBe(60);
    expect(plan.requiredInputs[0]).toEqual({ productId: 'coffee-powder', quantityMinor: 900, uom: 'g' });
  });

  it('refuses a recipe that consumes nothing, produces nothing or has no shelf life', () => {
    expect(() => validateRecipe({ ...FILTER_COFFEE, inputs: [] })).toThrow(/not a recipe/);
    expect(() => validateRecipe({ ...FILTER_COFFEE, outputQuantityMinor: 0 })).toThrow(/produces nothing/);
    expect(() => validateRecipe({ ...FILTER_COFFEE, shelfLifeHours: 0 })).toThrow(/no shelf life/);
    expect(() => planProduction(FILTER_COFFEE, 0)).toThrow(InvalidRecipeError);
  });

  it('consumes the inputs and creates a finished batch with an expiry (acceptance)', () => {
    const result = produceBatch({ run: run(), available: AVAILABLE, unitCosts: COSTS, currency: INR });
    expect(result.movements).toHaveLength(4); // 3 inputs out, 1 output in
    expect(result.movements[0]?.from).toBe('on_hand');
    expect(result.movements[0]?.to).toBeNull();
    expect(result.outputBatchId).toBe('B-COF-001');
    // Four-hour shelf life from production.
    expect(result.expiresAt).toBe('2026-08-03T11:00:00Z');
  });

  it('cannot issue more raw material than is on hand (acceptance)', () => {
    try {
      produceBatch({
        run: run({ batches: 40 }),
        available: AVAILABLE,
        unitCosts: COSTS,
        currency: INR,
      });
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(InsufficientMaterialError);
      // Nothing was consumed — the shelf and the system still agree.
      expect((error as Error).message).toContain('nothing has been issued');
    }
  });

  it('puts the output in quarantine, so it is not sellable until released', () => {
    const result = produceBatch({ run: run(), available: AVAILABLE, unitCosts: COSTS, currency: INR });
    const projection = projectStock(result.movements.filter((m) => m.from === null));
    // The stock model itself refuses to count quarantine as sellable.
    expect(availableToSell(projection, 'coffee-cup')).toBe(0);
    expect(projection.positions[0]?.byState.quarantine).toBe(40);
  });
});

describe('yield and cost (M11-FR-02)', () => {
  it('carries the full input cost on the output that survived', () => {
    const result = produceBatch({ run: run(), available: AVAILABLE, unitCosts: COSTS, currency: INR });
    // 600g × ₹0.80 + 6000ml × ₹0.06 + 400g × ₹0.05 = ₹480 + ₹360 + ₹20 = ₹860.00
    expect(result.inputCost).toEqual({ minor: 86_000, currency: INR });
    expect(result.outputUnitCost).toEqual({ minor: 2_150, currency: INR }); // ₹21.50 a cup
    expect(result.yieldBp).toBe(10_000);
    expect(result.yieldVerdict).toBe('as_expected');
    expect(result.exceptions).toEqual([]);
  });

  it('spreads the same cost over fewer cups when some are lost — real margin shows', () => {
    const spilt = produceBatch({
      run: run({ actualOutputMinor: 34 }),
      available: AVAILABLE,
      unitCosts: COSTS,
      currency: INR,
    });
    expect(spilt.inputCost).toEqual({ minor: 86_000, currency: INR }); // unchanged
    expect(spilt.outputUnitCost.minor).toBe(2_529); // ₹25.29 — the loss is in the cost
    expect(spilt.yieldVerdict).toBe('low_yield');
  });

  it('raises a valued exception when yield drifts beyond tolerance (P-08)', () => {
    const low = produceBatch({
      run: run({ actualOutputMinor: 30 }),
      available: AVAILABLE,
      unitCosts: COSTS,
      currency: INR,
    });
    expect(low.yieldBp).toBe(7_500);
    expect(low.exceptions[0]?.kind).toBe('yield_variance');
    expect(low.exceptions[0]?.detail).toContain('10 cup less than the recipe expects');
    expect(low.exceptions[0]?.value.minor).toBeGreaterThan(0);

    const high = produceBatch({
      run: run({ actualOutputMinor: 48 }),
      available: AVAILABLE,
      unitCosts: COSTS,
      currency: INR,
    });
    expect(high.yieldVerdict).toBe('high_yield');
    expect(high.exceptions[0]?.detail).toContain('the recipe or the portioning may be wrong');
  });

  it('does not flag a small, ordinary drift', () => {
    const result = produceBatch({
      run: run({ actualOutputMinor: 39 }),
      available: AVAILABLE,
      unitCosts: COSTS,
      currency: INR,
    });
    expect(result.yieldVerdict).toBe('as_expected');
    expect(result.exceptions).toEqual([]);
  });

  it('demands an explanation when the inputs went in and nothing came out', () => {
    const result = produceBatch({
      run: run({ actualOutputMinor: 0 }),
      available: AVAILABLE,
      unitCosts: COSTS,
      currency: INR,
    });
    expect(result.movements).toHaveLength(3); // inputs consumed, no output
    expect(result.exceptions[0]?.kind).toBe('no_output');
    expect(result.exceptions[0]?.value).toEqual({ minor: 86_000, currency: INR });
  });
});

describe('labels, quality release and repacking (M11-FR-03)', () => {
  const CAFE = requireDepartment('cafe', OPERATED);

  function label(over: Partial<PackLabel> = {}): PackLabel {
    return {
      productId: 'sandwich',
      productName: 'Cheese sandwich',
      batchId: 'B-SAN-001',
      netQuantity: '180 g',
      packerDetails: 'SRE Hyper Market, Cafe counter',
      useBy: '2026-08-03T18:00:00Z',
      price: money(9_000, INR),
      allergens: ['wheat', 'milk'],
      producedAt: AT,
      ...over,
    };
  }

  it('prints a complete label', () => {
    const printed = renderLabel(buildPackLabel(label(), CAFE));
    expect(printed[0]).toBe('Cheese sandwich');
    expect(printed).toContain('Net 180 g');
    expect(printed).toContain('USE BY 2026-08-03 18:00');
    expect(printed).toContain('Contains: wheat, milk');
    expect(printed).toContain('INR 90.00');
  });

  it('refuses to print a label missing a Legal Metrology field (§9.3)', () => {
    expect(() => buildPackLabel(label({ netQuantity: '' }), CAFE)).toThrow(IncompleteLabelError);
    expect(() => buildPackLabel(label({ packerDetails: '  ' }), CAFE)).toThrow(/packer/);
    expect(() => buildPackLabel(label({ useBy: '' }), CAFE)).toThrow(/use-by date/);
  });

  it('refuses a food label that declares nothing about allergens — silence is not a declaration', () => {
    expect(() => buildPackLabel(label({ allergens: undefined }), CAFE)).toThrow(/allergen declaration/);
    // An explicit "none" is a declaration and passes.
    const none = buildPackLabel(label({ allergens: [] }), CAFE);
    expect(renderLabel(none)).toContain('Allergens: none declared');
  });

  it('does not demand a weight from a department that does not sell by weight', () => {
    expect(() => buildPackLabel(label({ weightMinor: undefined }), CAFE)).not.toThrow();
    // A weighed department would insist on it.
    expect(() =>
      buildPackLabel(label({ weightMinor: undefined }), DEPARTMENT_CATALOGUE['deli']!),
    ).toThrow(/sells by weight/);
  });

  it('makes stock sellable only after a quality release (acceptance)', () => {
    const released = releaseForSale({
      release: { batchId: 'B-COF-001', releasedBy: 'supervisor-1', qcPassed: true, at: '2026-08-03T07:10:00Z' },
      productId: 'coffee-cup',
      locationId: 'cafe-counter',
      quantityMinor: 40,
      uom: 'cup',
      expiresAt: '2026-08-03T11:00:00Z',
    });
    expect(released.released).toBe(true);
    expect(released.movements[0]?.from).toBe('quarantine');
    expect(released.movements[0]?.to).toBe('on_hand');
  });

  it('refuses to release a failed check, an unnamed releaser, or an expired batch', () => {
    const base = {
      productId: 'coffee-cup',
      locationId: 'cafe-counter',
      quantityMinor: 40,
      uom: 'cup',
      expiresAt: '2026-08-03T11:00:00Z',
    };
    const failed = releaseForSale({
      ...base,
      release: { batchId: 'b', releasedBy: 'sup-1', qcPassed: false, at: AT, notes: 'tastes burnt' },
    });
    expect(failed.outcome).toBe('qc_failed');
    expect(failed.detail).toContain('tastes burnt');
    expect(failed.movements).toEqual([]);

    const anonymous = releaseForSale({
      ...base,
      release: { batchId: 'b', releasedBy: '  ', qcPassed: true, at: AT },
    });
    expect(anonymous.detail).toContain('is not evidence');

    // You cannot release your way past a use-by date.
    const late = releaseForSale({
      ...base,
      release: { batchId: 'b', releasedBy: 'sup-1', qcPassed: true, at: '2026-08-03T12:00:00Z' },
    });
    expect(late.outcome).toBe('already_expired');
    expect(late.detail).toContain('can never be released');
  });

  it('keeps a repack traceable to its source, and never makes food younger (acceptance)', () => {
    const result = repack({
      repackId: 'rp-1',
      sourceBatchId: 'B-SAN-001',
      newBatchId: 'B-SAN-001-R',
      productId: 'sandwich',
      locationId: 'cafe-counter',
      quantityMinor: 6,
      uom: 'each',
      repackedBy: 'barista-1',
      at: '2026-08-03T12:00:00Z',
      sourceExpiresAt: '2026-08-03T18:00:00Z',
    });
    expect(result.sourceBatchId).toBe('B-SAN-001');
    // A fresh wrapper does not reset the clock.
    expect(result.expiresAt).toBe('2026-08-03T18:00:00Z');
    expect(result.movements[1]?.to).toBe('quarantine'); // released like any output
    expect(result.movements[1]?.reason).toContain('repacked from B-SAN-001');
  });

  it('refuses to repack an expired batch — that is not a way to sell it', () => {
    expect(() =>
      repack({
        repackId: 'rp-2',
        sourceBatchId: 'B-1',
        newBatchId: 'B-2',
        productId: 'sandwich',
        locationId: 'cafe-counter',
        quantityMinor: 6,
        uom: 'each',
        repackedBy: 'barista-1',
        at: '2026-08-04T09:00:00Z',
        sourceExpiresAt: '2026-08-03T18:00:00Z',
      }),
    ).toThrow(RepackError);
  });
});
