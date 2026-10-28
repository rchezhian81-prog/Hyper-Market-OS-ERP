import { describe, it, expect } from 'vitest';
import {
  validateProduct, publishProduct, NotPublishableError, completeness, dualMrpConflict,
  type Category, type ProductRecord,
} from '../../packages/product/src/index';
import { createCatalogueSession, type CataloguePorts } from '../../apps/web-erp/src/catalogue-session';
import { money } from '../../packages/contracts/src/money';
import { ShelfMap } from '../../packages/merchandising/src/index';

/**
 * Round 6 · B2 · B4 (roadmap v2.1 addendum) — the tested `checkDualMrp` and `checkPackDeclarations` now run INSIDE the
 * product master's publish gate (`validateProduct` / `publishProduct`), so every path that publishes — the screen, head
 * office's route, a product file, a migration — refuses the same things. Before this round they ran only behind stateless
 * "check" routes nobody's publish called.
 */

const PACKED: Category = { categoryId: 'packed', name: 'Packed household', parentId: null, regulated: ['packed'] };
const FOOD_PACKED: Category = { categoryId: 'staples', name: 'Staples', parentId: null, regulated: ['food', 'packed'] };
const CATS = [PACKED, FOOD_PACKED, { categoryId: 'loose', name: 'Loose', parentId: null } as Category];
const CARE = 'Synthetic Care Desk, 1800-000-0000';

const pack = (over: Partial<ProductRecord> = {}): ProductRecord => ({
  productId: 'p-det', tenantId: 't1', sku: 'SKU-DET', name: 'Synthetic detergent 1kg', baseUom: 'each',
  primaryCategoryId: 'packed', taxClass: '34022010', lifecycle: 'draft',
  safety: { netQuantity: '1 kg', packerDetails: 'Synthetic Packers', countryOfOrigin: 'India', consumerCareContact: CARE },
  ...over,
});
const mrp = (minor: number, effectiveFrom: string) => ({ value: money(minor, 'INR'), effectiveFrom });

describe('B4: a packed product needs its consumer-care contact to publish', () => {
  it('blocks a packed product with no (or a blank) consumer-care contact, by name', () => {
    for (const consumerCareContact of [undefined, '   ']) {
      const r = validateProduct(pack({ safety: { netQuantity: '1 kg', packerDetails: 'X', countryOfOrigin: 'India', ...(consumerCareContact === undefined ? {} : { consumerCareContact }) } }), CATS);
      expect(r.publishable).toBe(false);
      expect(r.issues.find((i) => i.field === 'safety.consumerCareContact')).toMatchObject({ severity: 'blocks_publish', message: expect.stringContaining('consumer-care contact') });
    }
    expect(() => publishProduct(pack({ safety: { netQuantity: '1 kg', packerDetails: 'X', countryOfOrigin: 'India' } }), CATS)).toThrow(NotPublishableError);
  });

  it('blocks a packed non-food with no country of origin — said once, not twice for packed food', () => {
    const nonFood = validateProduct(pack({ safety: { netQuantity: '1 kg', packerDetails: 'X', consumerCareContact: CARE } }), CATS);
    expect(nonFood.issues.filter((i) => i.field === 'safety.countryOfOrigin')).toHaveLength(1);
    const food = validateProduct(pack({ primaryCategoryId: 'staples', safety: { allergens: [], netQuantity: '1 kg', packerDetails: 'X', consumerCareContact: CARE } }), CATS);
    expect(food.issues.filter((i) => i.field === 'safety.countryOfOrigin')).toHaveLength(1);
  });

  it('a complete pack publishes; an unregulated or loose item is not asked for a care contact', () => {
    expect(validateProduct(pack(), CATS).publishable).toBe(true);
    expect(validateProduct(pack({ primaryCategoryId: 'loose', safety: undefined }), CATS).issues.map((i) => i.field)).not.toContain('safety.consumerCareContact');
  });

  it('the completeness list names the care contact as a required check, outstanding then done', () => {
    const missing = completeness(pack({ safety: { netQuantity: '1 kg', packerDetails: 'X', countryOfOrigin: 'India' } }), CATS);
    expect(missing.knowable && missing.checks.find((c) => c.field === 'safety.consumerCareContact')).toMatchObject({ done: false, blocksPublish: true });
    const done = completeness(pack(), CATS);
    expect(done.knowable && done.checks.find((c) => c.field === 'safety.consumerCareContact')).toMatchObject({ done: true });
  });
});

describe('B2: two different MRPs taking effect on the same date are refused at publish', () => {
  it('a same-date, different MRP blocks publish with both amounts named; the record never publishes', () => {
    const r = validateProduct(pack({ mrpHistory: [mrp(120_00, '2026-11-01'), mrp(125_00, '2026-11-01')] }), CATS);
    expect(r.publishable).toBe(false);
    expect(r.issues.find((i) => i.field === 'mrpHistory')?.message).toContain('(₹120.00 and ₹125.00) take effect on 2026-11-01');
    expect(() => publishProduct(pack({ mrpHistory: [mrp(120_00, '2026-11-01'), mrp(125_00, '2026-11-01')] }), CATS)).toThrow(/only one MRP/);
  });

  it('a later-dated MRP (a price move) and an exact re-entry both pass', () => {
    expect(validateProduct(pack({ mrpHistory: [mrp(120_00, '2026-11-01'), mrp(130_00, '2027-01-01')] }), CATS).publishable).toBe(true);
    expect(dualMrpConflict([mrp(120_00, '2026-11-01'), mrp(120_00, '2026-11-01')])).toBeUndefined();
  });

  it('applies to every product, regulated or not, and lists the clash only when it happens', () => {
    const loose = pack({ primaryCategoryId: 'loose', safety: undefined, mrpHistory: [mrp(10_00, '2026-11-01'), mrp(11_00, '2026-11-01')] });
    expect(validateProduct(loose, CATS).issues.map((i) => i.field)).toEqual(['mrpHistory']);
    const clashScore = completeness(loose, CATS);
    expect(clashScore.knowable && clashScore.checks.find((c) => c.field === 'mrpHistory')).toMatchObject({ done: false, blocksPublish: true });
    const fine = completeness(pack(), CATS);
    expect(fine.knowable && fine.checks.some((c) => c.field === 'mrpHistory')).toBe(false);
  });

  it('an MRP the engine cannot read (bad date, zero) never makes a clash', () => {
    expect(dualMrpConflict([mrp(120_00, '2026-13-01'), mrp(125_00, '2026-13-01')])).toBeUndefined();
  });
});

describe('the product screen refuses a dual MRP by its own name', () => {
  const ports = (): CataloguePorts => ({
    categories: () => CATS, products: () => [], priceEntries: () => [], costOf: () => ({ known: true, cost: money(100_00, 'INR') }),
    barcodesInUse: () => [], promotions: () => [], shelfMap: () => new ShelfMap('S1', [], [], ['ambient']),
  });
  it('refusal two_mrps_on_one_date, every reason still listed', () => {
    const s = createCatalogueSession({ tenantId: 't1', storeId: 'S1', userId: 'u-cat', currency: 'INR', today: '2026-10-27', marginFloorBps: 2000 }, ports());
    const out = s.publish(pack({ mrpHistory: [mrp(120_00, '2026-11-01'), mrp(125_00, '2026-11-01')], safety: { netQuantity: '1 kg', packerDetails: 'X', countryOfOrigin: 'India' } }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal).toBe('two_mrps_on_one_date');
    expect(out.missing.some((m) => m.includes('consumer-care'))).toBe(true);
    const plain = s.publish(pack({ safety: { netQuantity: '1 kg', packerDetails: 'X', countryOfOrigin: 'India' } }));
    expect(!plain.ok && plain.refusal).toBe('not_finished');
  });
});
