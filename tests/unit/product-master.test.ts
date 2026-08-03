import { describe, it, expect } from 'vitest';
import {
  validateProduct,
  publishProduct,
  sellability,
  canSell,
  canPurchase,
  mrpOn,
  NotPublishableError,
  CategoryNotFoundError,
  type Category,
  type ProductRecord,
} from '../../packages/product/src/index';
import { money } from '../../packages/contracts/src/money';

// M03-FR-01/03 — the single trusted product truth (P-02). An incomplete product is a
// legitimate DRAFT; it simply cannot be published until what is missing is there.

const INR = 'INR' as const;

const CATEGORIES: Category[] = [
  {
    categoryId: 'grocery',
    name: 'Grocery',
    parentId: null,
    regulated: ['food', 'packed'],
    attributes: [
      { key: 'shelf_life_days', label: 'Shelf life (days)', type: 'number', required: true },
      { key: 'storage', label: 'Storage', type: 'enum', allowed: ['ambient', 'chilled', 'frozen'] },
    ],
  },
  { categoryId: 'electronics', name: 'Electronics', parentId: null },
  { categoryId: 'liquor', name: 'Liquor', parentId: null, regulated: ['age_restricted', 'packed'] },
];

function product(over: Partial<ProductRecord> = {}): ProductRecord {
  return {
    productId: 'p1',
    tenantId: 't1',
    sku: 'SKU-1',
    name: 'Aashirvaad Atta 5kg',
    primaryCategoryId: 'electronics',
    baseUom: 'each',
    taxClass: 'HSN-1101',
    lifecycle: 'draft',
    ...over,
  };
}

describe('validateProduct — what may reach the shelf (M03-FR-01)', () => {
  it('blocks publish without a category or a tax class', () => {
    const result = validateProduct(product({ primaryCategoryId: null, taxClass: null }), CATEGORIES);
    expect(result.publishable).toBe(false);
    expect(result.issues.map((i) => i.field)).toEqual(['primaryCategoryId', 'taxClass']);
    expect(result.issues[1]?.message).toContain('the bill would charge the wrong tax');
  });

  it('reports what is missing instead of throwing — a draft is legitimate', () => {
    const result = validateProduct(product({ name: '', sku: '' }), CATEGORIES);
    expect(result.publishable).toBe(false);
    expect(result.issues).toHaveLength(2);
    // Nothing threw: the user can keep working on an incomplete record.
  });

  it('publishes a complete product and moves it out of draft', () => {
    const published = publishProduct(product(), CATEGORIES);
    expect(published.lifecycle).toBe('new');
    expect(canSell(published)).toBe(true);
  });

  it('refuses to publish and names every reason at once', () => {
    try {
      publishProduct(product({ primaryCategoryId: null, taxClass: null, name: '' }), CATEGORIES);
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(NotPublishableError);
      expect((error as NotPublishableError).issues).toHaveLength(3);
    }
  });

  it('refuses a category that does not exist in the hierarchy', () => {
    expect(() => validateProduct(product({ primaryCategoryId: 'nowhere' }), CATEGORIES)).toThrow(
      CategoryNotFoundError,
    );
  });
});

describe('validateProduct — typed per-tenant attributes', () => {
  const grocery = (over: Partial<ProductRecord> = {}): ProductRecord =>
    product({
      primaryCategoryId: 'grocery',
      safety: {
        allergens: ['wheat'],
        countryOfOrigin: 'India',
        netQuantity: '5 kg',
        packerDetails: 'ITC Ltd, Kolkata',
        storageConditions: 'Store in a cool dry place',
      },
      attributes: { shelf_life_days: '180', storage: 'ambient' },
      ...over,
    });

  it('accepts attributes that match the category’s own schema', () => {
    expect(validateProduct(grocery(), CATEGORIES).publishable).toBe(true);
  });

  it('blocks a required attribute that is empty', () => {
    const result = validateProduct(grocery({ attributes: { storage: 'ambient' } }), CATEGORIES);
    expect(result.publishable).toBe(false);
    expect(result.issues[0]?.message).toContain('"Shelf life (days)" is required');
  });

  it('blocks an attribute of the wrong type or outside its allowed values', () => {
    const notANumber = validateProduct(
      grocery({ attributes: { shelf_life_days: 'six months', storage: 'ambient' } }),
      CATEGORIES,
    );
    expect(notANumber.issues[0]?.message).toContain('must be a number, but reads "six months"');

    const badEnum = validateProduct(
      grocery({ attributes: { shelf_life_days: '180', storage: 'room' } }),
      CATEGORIES,
    );
    expect(badEnum.issues[0]?.message).toContain('must be one of ambient, chilled, frozen');
  });

  it('ignores attributes a category does not define — no schema, no rule', () => {
    const result = validateProduct(product({ attributes: { anything: 'goes' } }), CATEGORIES);
    expect(result.publishable).toBe(true);
  });
});

describe('validateProduct — safety and compliance content (M03-FR-03)', () => {
  const food = (over: Partial<ProductRecord> = {}): ProductRecord =>
    product({
      primaryCategoryId: 'grocery',
      attributes: { shelf_life_days: '180' },
      safety: {
        allergens: ['wheat'],
        countryOfOrigin: 'India',
        netQuantity: '5 kg',
        packerDetails: 'ITC Ltd, Kolkata',
      },
      ...over,
    });

  it('blocks a food item that has declared nothing about allergens (acceptance)', () => {
    const result = validateProduct(food({ safety: { countryOfOrigin: 'India', netQuantity: '5 kg', packerDetails: 'X' } }), CATEGORIES);
    expect(result.publishable).toBe(false);
    expect(result.issues[0]?.message).toContain('must state its allergens');
  });

  it('accepts an explicit declaration of "no allergens" — silence is not a declaration', () => {
    const result = validateProduct(food({ safety: { allergens: [], countryOfOrigin: 'India', netQuantity: '5 kg', packerDetails: 'X' } }), CATEGORIES);
    expect(result.publishable).toBe(true);
  });

  it('blocks packed goods missing their Legal Metrology label fields (§9.3)', () => {
    const noNetQty = validateProduct(
      food({ safety: { allergens: [], countryOfOrigin: 'India', packerDetails: 'X' } }),
      CATEGORIES,
    );
    expect(noNetQty.issues.map((i) => i.field)).toContain('safety.netQuantity');

    const noPacker = validateProduct(
      food({ safety: { allergens: [], countryOfOrigin: 'India', netQuantity: '5 kg' } }),
      CATEGORIES,
    );
    expect(noPacker.issues.map((i) => i.field)).toContain('safety.packerDetails');
  });

  it('blocks an age-restricted item that never says what age', () => {
    const result = validateProduct(
      product({ primaryCategoryId: 'liquor', safety: { netQuantity: '750 ml', packerDetails: 'X' } }),
      CATEGORIES,
    );
    expect(result.issues.map((i) => i.field)).toContain('safety.minimumAge');
  });

  it('advises on storage conditions without blocking the publish', () => {
    const result = validateProduct(food(), CATEGORIES);
    expect(result.publishable).toBe(true);
    expect(result.issues.find((i) => i.field === 'safety.storageConditions')?.severity).toBe('advisory');
  });
});

describe('sellability and effective-dated MRP', () => {
  it('a recall block stops sale AND purchase, offline included (M10-FR-04)', () => {
    const blocked = product({ lifecycle: 'active', recallBlocked: true });
    expect(sellability(blocked)).toBe('recall_blocked');
    expect(canSell(blocked)).toBe(false);
    expect(canPurchase(blocked)).toBe(false);
  });

  it('a discontinued item stops being sellable (M03-FR-04 acceptance)', () => {
    expect(canSell(product({ lifecycle: 'discontinued' }))).toBe(false);
    expect(sellability(product({ lifecycle: 'discontinued' }))).toBe('discontinued');
    expect(canSell(product({ lifecycle: 'clearance' }))).toBe(true);
    // Clearance sells down but is never reordered.
    expect(canPurchase(product({ lifecycle: 'clearance' }))).toBe(false);
  });

  it('an unpublished draft cannot be sold', () => {
    expect(sellability(product({ lifecycle: 'draft' }))).toBe('not_published');
  });

  it('returns the MRP in force on a date, keeping the whole history', () => {
    const withHistory = product({
      mrpHistory: [
        { value: money(25_000, INR), effectiveFrom: '2026-01-01' },
        { value: money(27_000, INR), effectiveFrom: '2026-06-01' },
      ],
    });
    expect(mrpOn(withHistory, '2026-03-15')).toEqual(money(25_000, INR));
    expect(mrpOn(withHistory, '2026-08-01')).toEqual(money(27_000, INR));
    // Before any MRP was set, there is no answer — not a guess.
    expect(mrpOn(withHistory, '2025-12-31')).toBeUndefined();
  });

  it('never activates an MRP before its effective date', () => {
    const future = product({
      mrpHistory: [
        { value: money(25_000, INR), effectiveFrom: '2026-01-01' },
        { value: money(30_000, INR), effectiveFrom: '2026-12-01' },
      ],
    });
    expect(mrpOn(future, '2026-11-30')).toEqual(money(25_000, INR));
  });
});
