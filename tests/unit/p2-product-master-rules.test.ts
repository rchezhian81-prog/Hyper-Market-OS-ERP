import { describe, it, expect } from 'vitest';
import {
  validateProduct, checkVariant, rollUpVariants, bundleProblems, explodeBundleLine, bundleInForce, substituteProblems,
  nutritionProblems, nutritionRequired, type ProductRecord, type Category, type NutritionFacts, type BundleDefinition,
} from '../../packages/product/src/index';
import {
  isLiquorHsn, liquorReason, tillLineRefusals, tobaccoAdvertisingRefusal, TILL_RULE_FLAG_KEYS,
} from '../../packages/restricted-sales/src/index';

// OB-288 P2 — the product master's new rules, pure: B17 liquor is never published or sold (TASMAC); OB-307 nutrition is
// required only for food SRE packs or labels itself; M03-FR-01 variants share a one-level parent and differ from their
// siblings; OB-306 an own-barcode bundle is made of sellable, promotable items and explodes into its components; M03-FR-04
// the approved substitute list refuses controlled items; B15 tobacco is never promoted.

const food: Category = { categoryId: 'grocery', name: 'Grocery', parentId: null, regulated: ['food'] };
const liquorCat: Category = { categoryId: 'spirits', name: 'Spirits', parentId: null, regulated: ['liquor'] };
const general: Category = { categoryId: 'home', name: 'Home', parentId: null };
const cats = [food, liquorCat, general];
const base = (over: Partial<ProductRecord> = {}): ProductRecord => ({
  productId: 'p1', tenantId: 't', sku: 'SKU-1', name: 'Thing', baseUom: 'ea', primaryCategoryId: 'home', taxClass: '3401', lifecycle: 'draft', ...over,
});
const foodSafety = { allergens: [], countryOfOrigin: 'India', storageConditions: 'cool and dry' };
const panel: NutritionFacts = {
  basis: 'per_100g', energyKcal: 360, proteinG: 7, carbohydrateG: 80, totalSugarsG: 2, addedSugarsG: 0, totalFatG: 1,
  saturatedFatG: 0.3, transFatG: 0, cholesterolMg: 0, sodiumMg: 5,
};
const blocks = (p: ProductRecord): string[] => validateProduct(p, cats).issues.filter((i) => i.severity === 'blocks_publish').map((i) => i.field);

describe('B17 — liquor is never published, by flag, by category or by HSN', () => {
  it('refuses each way, and says TASMAC', () => {
    expect(blocks(base({ safety: { liquor: true } }))).toContain('safety.liquor');
    expect(blocks(base({ primaryCategoryId: 'spirits' }))).toContain('safety.liquor');
    expect(blocks(base({ taxClass: '22030000', name: 'Beer 650ml' }))).toContain('safety.liquor');
    expect(validateProduct(base({ taxClass: '2208' }), cats).issues.find((i) => i.field === 'safety.liquor')!.message).toMatch(/TASMAC/);
  });

  it('non-alcoholic beer (2202) and ethyl alcohol (2207) are not liquor', () => {
    expect(isLiquorHsn('22029100')).toBe(false);
    expect(isLiquorHsn('2207 20')).toBe(false);
    expect(isLiquorHsn('2204.21')).toBe(true);
    expect(liquorReason({ hsn: '2206' })).toMatch(/alcoholic-drink heading/);
    expect(blocks(base({ taxClass: '22029100' }))).not.toContain('safety.liquor');
  });

  it('the till refuses a liquor line offline by its flag or its HSN, before anything else', () => {
    expect(TILL_RULE_FLAG_KEYS).toContain('liquor');
    const byFlag = tillLineRefusals({ productId: 'beer', description: 'Beer 650ml', quantityMinor: 1, uom: 'ea', unitPriceMinor: 15_000, regulatedFlags: { liquor: true } }, {});
    expect(byFlag.map((r) => r.reason)).toEqual(['liquor_not_sold']);
    expect(byFlag[0]!.laneMessage).toMatch(/TASMAC/);
    const byHsn = tillLineRefusals({ productId: 'beer', description: 'Beer 650ml', quantityMinor: 1, uom: 'ea', unitPriceMinor: 15_000, hsnCode: '22030000', regulatedFlags: { minimumAge: 21 } }, {});
    expect(byHsn.map((r) => r.reason)).toEqual(['liquor_not_sold']);
    expect(tillLineRefusals({ productId: 'soap', description: 'Soap', quantityMinor: 1, uom: 'ea', unitPriceMinor: 4_000, hsnCode: '3401' }, {})).toEqual([]);
  });
});

describe('OB-307 — nutrition is required only for food SRE packs or labels itself', () => {
  const groceryFood = (over: Partial<ProductRecord['safety']> = {}) => base({ primaryCategoryId: 'grocery', taxClass: '1006', safety: { ...foodSafety, ...over } });

  it('a bought-in pack publishes without a panel; an SRE pack does not', () => {
    expect(blocks(groceryFood())).toEqual([]);
    expect(nutritionRequired({ food: true })).toBe(false);
    expect(blocks(groceryFood({ packedBySre: true }))).toEqual(['safety.nutrition']);
    expect(blocks(groceryFood({ packedBySre: true, nutrition: panel }))).toEqual([]);
    expect(blocks(base({ safety: { packedBySre: true } }))).toEqual([]); // not food: no panel needed
  });

  it('a panel that is given must be readable and add up, whoever packed it', () => {
    expect(blocks(groceryFood({ nutrition: { ...panel, sodiumMg: -1 } }))).toEqual(['safety.nutrition']);
    expect(nutritionProblems({ ...panel, totalSugarsG: 90 })).toEqual(['the total sugars cannot be more than the carbohydrate they are part of']);
    expect(nutritionProblems({ ...panel, saturatedFatG: 1, transFatG: 0.5 })).toEqual(['the saturated and trans fat together cannot be more than the total fat']);
    expect(nutritionProblems({ ...panel, basis: 'per_pack' })[0]).toMatch(/per 100 g or per 100 ml/);
    expect(nutritionProblems('rich in fibre')).toEqual(['the nutrition panel must be a set of figures, not text']);
    expect(nutritionProblems({ ...panel, servingSize: 30 })).toEqual([]);
  });
});

describe('M03-FR-01 — variants', () => {
  const parent = base({ productId: 'shampoo', sku: 'SH', name: 'Shampoo', manufacturer: 'Maker A', attributes: {} });
  const small = base({ productId: 'shampoo-100', sku: 'SH-100', parentProductId: 'shampoo', attributes: { size: '100ml' } });
  const held = [parent, small];

  it('a variant names a held, one-level parent and differs from its siblings', () => {
    expect(checkVariant(base({ productId: 'shampoo-200', parentProductId: 'shampoo', attributes: { size: '200ml' } }), held).ok).toBe(true);
    expect(checkVariant(base({ productId: 'x', parentProductId: 'nobody' }), held).refusal).toBe('variant_parent_unknown');
    expect(checkVariant(base({ productId: 'x', parentProductId: 'x' }), held).refusal).toBe('variant_of_itself');
    expect(checkVariant(base({ productId: 'x', parentProductId: 'shampoo-100', attributes: { size: '5ml' } }), held).refusal).toBe('variant_parent_is_a_variant');
    expect(checkVariant(base({ productId: 'shampoo', parentProductId: 'other' }), [...held, base({ productId: 'other' })]).refusal).toBe('product_has_variants');
    expect(checkVariant(base({ productId: 'shampoo-100b', parentProductId: 'shampoo', attributes: { size: '100ml' } }), held).refusal).toBe('variant_same_as_sibling');
    // Re-publishing the same variant is not a clash with itself.
    expect(checkVariant(small, held).ok).toBe(true);
  });

  it('a category report rolls variants up under the parent and keeps the manufacturer', () => {
    const big = base({ productId: 'shampoo-200', parentProductId: 'shampoo', attributes: { size: '200ml' } });
    const soap = base({ productId: 'soap', name: 'Soap' });
    const r = rollUpVariants([parent, small, big, soap], [parent, small, big, soap]);
    expect(r.familyCount).toBe(2);
    expect(r.productCount).toBe(4);
    expect(r.families.find((f) => f.productId === 'shampoo')).toMatchObject({ manufacturer: 'Maker A', variantCount: 2 });
    expect(r.byManufacturer).toEqual([{ manufacturer: 'Maker A', families: 1, products: 3 }, { manufacturer: null, families: 1, products: 1 }]);
    // A variant filed in the category whose parent sits elsewhere brings its whole family.
    expect(rollUpVariants([small], held).families[0]).toMatchObject({ productId: 'shampoo', variantCount: 1 });
    expect(rollUpVariants([base({ productId: 'lost', parentProductId: 'gone' })], []).orphanVariants).toEqual(['lost']);
  });
});

describe('OB-306 — an own-barcode bundle product', () => {
  const products = new Map<string, ProductRecord>([
    ['gift-box', base({ productId: 'gift-box', lifecycle: 'active' })],
    ['tea', base({ productId: 'tea', lifecycle: 'active' })],
    ['mug', base({ productId: 'mug', lifecycle: 'active' })],
    ['cig', base({ productId: 'cig', lifecycle: 'active', safety: { tobacco: true, packMinimumMinor: 10, minimumAge: 18 } })],
    ['bag', base({ productId: 'bag', lifecycle: 'active', safety: { carryBag: true } })],
    ['old', base({ productId: 'old', lifecycle: 'discontinued' })],
  ]);
  const judge = (components: BundleDefinition['components'], bundles: readonly BundleDefinition[] = []) =>
    bundleProblems({ bundleProductId: 'gift-box', components, product: (id) => products.get(id), bundles }).map((p) => p.refusal);

  it('is made of sellable, promotable products; refusals are named', () => {
    expect(judge([{ productId: 'tea', quantityMinor: 2 }, { productId: 'mug', quantityMinor: 1 }])).toEqual([]);
    expect(judge([{ productId: 'tea', quantityMinor: 2 }])).toEqual([]); // two of one is a bundle
    expect(judge([{ productId: 'tea', quantityMinor: 1 }])).toEqual(['bundle_needs_components']);
    expect(judge([{ productId: 'tea', quantityMinor: 1 }, { productId: 'cig', quantityMinor: 10 }])).toEqual(['bundle_component_tobacco']);
    expect(judge([{ productId: 'tea', quantityMinor: 1 }, { productId: 'bag', quantityMinor: 1 }])).toEqual(['bundle_component_carry_bag']);
    expect(judge([{ productId: 'tea', quantityMinor: 1 }, { productId: 'old', quantityMinor: 1 }])).toEqual(['bundle_component_not_sellable']);
    expect(judge([{ productId: 'tea', quantityMinor: 1 }, { productId: 'gift-box', quantityMinor: 1 }])).toEqual(['bundle_contains_itself']);
    expect(judge([{ productId: 'tea', quantityMinor: 1 }, { productId: 'tea', quantityMinor: 1 }])).toEqual(['bundle_component_repeated']);
    expect(judge([{ productId: 'tea', quantityMinor: 0 }, { productId: 'mug', quantityMinor: 1 }])).toContain('bundle_component_quantity');
    expect(judge([{ productId: 'tea', quantityMinor: 1 }, { productId: 'ghost', quantityMinor: 1 }])).toEqual(['bundle_component_unknown']);
    const mugSet: BundleDefinition = { bundleProductId: 'mug', version: 1, components: [{ productId: 'tea', quantityMinor: 2 }], reason: 'x', definedBy: 'u', definedAt: AT };
    expect(judge([{ productId: 'tea', quantityMinor: 1 }, { productId: 'mug', quantityMinor: 1 }], [mugSet])).toEqual(['bundle_component_is_a_bundle']);
  });

  it('explodes into each component × the bundles sold, by the version in force', () => {
    const v1: BundleDefinition = { bundleProductId: 'gift-box', version: 1, components: [{ productId: 'tea', quantityMinor: 2 }, { productId: 'mug', quantityMinor: 1 }], reason: 'Diwali box', definedBy: 'u', definedAt: '2026-10-01T00:00:00Z' };
    const v2: BundleDefinition = { ...v1, version: 2, components: [{ productId: 'tea', quantityMinor: 3 }, { productId: 'mug', quantityMinor: 1 }], definedAt: '2026-10-20T00:00:00Z' };
    expect(bundleInForce([v2, v1], 'gift-box', '2026-10-10T00:00:00Z')!.version).toBe(1);
    expect(explodeBundleLine(bundleInForce([v1, v2], 'gift-box', AT)!, 2)).toEqual([
      { productId: 'tea', quantityMinor: 6, fromBundle: 'gift-box', bundleVersion: 2 },
      { productId: 'mug', quantityMinor: 2, fromBundle: 'gift-box', bundleVersion: 2 },
    ]);
    expect(explodeBundleLine(v1, -1)).toEqual([
      { productId: 'tea', quantityMinor: -2, fromBundle: 'gift-box', bundleVersion: 1 },
      { productId: 'mug', quantityMinor: -1, fromBundle: 'gift-box', bundleVersion: 1 },
    ]); // a returned bundle puts its components back
  });
});

describe('M03-FR-04 — the approved substitute list', () => {
  const products = new Map<string, ProductRecord>([
    ['milk-a', base({ productId: 'milk-a', lifecycle: 'active', safety: { allergens: ['milk'] } })],
    ['milk-b', base({ productId: 'milk-b', lifecycle: 'active', safety: { allergens: ['milk'] } })],
    ['milk-nuts', base({ productId: 'milk-nuts', lifecycle: 'active', safety: { allergens: ['milk', 'peanuts_tree_nuts'] } })],
    ['cig', base({ productId: 'cig', lifecycle: 'active', safety: { tobacco: true, packMinimumMinor: 10, minimumAge: 18 } })],
    ['gone', base({ productId: 'gone', lifecycle: 'discontinued' })],
  ]);
  const judge = (productId: string, substitutes: readonly string[]) => substituteProblems({ productId, substitutes, product: (id) => products.get(id) });

  it('keeps a fair list, warns about an extra allergen, and refuses what can never stand in', () => {
    expect(judge('milk-a', ['milk-b'])).toEqual({ problems: [], warnings: [] });
    expect(judge('milk-a', ['milk-nuts']).warnings[0]).toMatch(/peanuts_tree_nuts/);
    expect(judge('milk-a', ['cig']).problems.map((p) => p.refusal)).toEqual(['substitute_controlled']);
    expect(judge('cig', ['milk-a']).problems.map((p) => p.refusal)).toEqual(['product_controlled']);
    expect(judge('milk-a', ['gone', 'milk-a', 'nobody', 'milk-b', 'milk-b']).problems.map((p) => p.refusal))
      .toEqual(['substitute_not_sellable', 'substitute_is_itself', 'substitute_unknown', 'substitute_repeated']);
    expect(judge('milk-a', Array.from({ length: 11 }, (_, i) => `s${i}`)).problems[0]!.refusal).toBe('substitute_list_too_long');
  });
});

describe('B15 — tobacco is never promoted, on any surface', () => {
  it('names the tobacco products, or passes', () => {
    const isTobacco = (id: string) => id.startsWith('cig');
    expect(tobaccoAdvertisingRefusal('promotion', ['rice', 'cig-10', 'cig-20', 'cig-10'], isTobacco)).toMatchObject({ code: 'tobacco_may_not_be_promoted', tobaccoProductIds: ['cig-10', 'cig-20'] });
    expect(tobaccoAdvertisingRefusal('bundle', ['rice'], isTobacco)).toBeUndefined();
    expect(tobaccoAdvertisingRefusal('campaign', ['cig-10'], isTobacco)!.whatHappened).toMatch(/^A campaign cannot name a tobacco product .*COTPA/);
  });
});

const AT = '2026-10-23T10:00:00Z';
