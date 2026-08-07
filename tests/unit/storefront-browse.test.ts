import { describe, it, expect } from 'vitest';
import {
  viewProduct,
  searchCatalogue,
  reviewCart,
  repeatOrder,
  recommend,
  type StorefrontProduct,
} from '../../packages/storefront/src/browse';

// M20-FR-01/02: "catalogue reflects ONE COMMERCE TRUTH (P-02); English/Tamil; typo-tolerant
// results (D01); consent-safe recommendations."

const product = (over: Partial<StorefrontProduct>): StorefrontProduct => ({
  productId: 'p-atta',
  name: 'Aashirvaad Atta 5kg',
  nameTa: 'ஆஷீர்வாத் ஆட்டா 5கிலோ',
  brand: 'Aashirvaad',
  categoryId: 'grocery',
  unitPriceMinor: 26_500,
  uom: 'ea',
  barcodes: ['8901030865278'],
  status: 'active',
  availableMinor: 40,
  availabilityAgeMinutes: 5,
  ...over,
});

describe('the app sells the same shop as the till (P-02)', () => {
  it('shows a sellable item as buyable', () => {
    const view = viewProduct(product({}));
    expect(view.buyable).toBe(true);
    expect(view.status).toBe('sellable');
    expect(view.unitPriceMinor).toBe(26_500);
  });

  it('REFUSES a recalled item first, before every other state', () => {
    const view = viewProduct(product({ recallBlock: true, availableMinor: 0, status: 'discontinued' }));
    expect(view.status).toBe('recalled');
    expect(view.buyable).toBe(false);
  });

  it('refuses a discontinued item and an out-of-stock one, differently', () => {
    expect(viewProduct(product({ status: 'discontinued' })).status).toBe('not_sellable');
    expect(viewProduct(product({ availableMinor: 0 })).status).toBe('out_of_stock');
  });

  it('LABELS STALE STOCK rather than presenting it as live (P-08)', () => {
    const stale = viewProduct(product({ availabilityAgeMinutes: 120 }), 'en', 30);
    expect(stale.availabilityStale).toBe(true);
    expect(stale.detail).toContain('Stock last checked 120 minutes ago');
  });

  it('treats UNKNOWN age as stale — "we do not know" is not "fresh"', () => {
    const unknown = viewProduct(product({ availabilityAgeMinutes: undefined }));
    expect(unknown.availabilityStale).toBe(true);
  });

  it('speaks Tamil, including the reason an item cannot be bought', () => {
    const ta = viewProduct(product({ availableMinor: 0 }), 'ta');
    expect(ta.name).toBe('ஆஷீர்வாத் ஆட்டா 5கிலோ');
    expect(ta.detail).toBe('இருப்பில் இல்லை');

    const recalled = viewProduct(product({ recallBlock: true }), 'ta');
    expect(recalled.detail).toBe('விற்பனையிலிருந்து விலக்கப்பட்டது');
  });

  it('flags an age-restricted item so the customer knows before the doorstep', () => {
    expect(viewProduct(product({ ageRestricted: true })).detail).toContain('Identification required');
  });
});

describe('search finds what the customer meant (D01)', () => {
  const catalogue = [
    product({}),
    product({ productId: 'p-oil', name: 'Sunflower Oil 1L', nameTa: undefined, brand: 'Fortune', barcodes: ['8901030000012'] }),
    product({ productId: 'p-gone', name: 'Aashirvaad Atta 10kg', status: 'discontinued' }),
    product({ productId: 'p-recall', name: 'Aashirvaad Multigrain', recallBlock: true }),
  ];

  it('a scanned barcode wins outright', () => {
    const hits = searchCatalogue({ query: '8901030865278', products: catalogue });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.match).toBe('barcode');
    expect(hits[0]?.product.productId).toBe('p-atta');
  });

  it('TOLERATES A TYPO — otherwise the customer concludes we do not stock it', () => {
    const hits = searchCatalogue({ query: 'aashirwad', products: catalogue });
    expect(hits.map((h) => h.product.productId)).toContain('p-atta');
    expect(hits[0]?.match).toBe('fuzzy');
  });

  it('ranks an exact or prefix match above a typo match', () => {
    const hits = searchCatalogue({ query: 'sunflower', products: catalogue });
    expect(hits[0]?.match).toBe('prefix');
  });

  it('matches "5kg" and "5 KG" as the same thing', () => {
    expect(searchCatalogue({ query: 'atta 5 KG', products: catalogue })[0]?.product.productId).toBe('p-atta');
  });

  it('EXCLUDES recalled and discontinued items entirely, not greyed out', () => {
    const hits = searchCatalogue({ query: 'aashirvaad', products: catalogue });
    const ids = hits.map((h) => h.product.productId);
    expect(ids).toContain('p-atta');
    expect(ids).not.toContain('p-gone');
    expect(ids).not.toContain('p-recall');
  });

  it('searches Tamil names too, and returns nothing for an empty query', () => {
    expect(searchCatalogue({ query: 'ஆஷீர்வாத்', products: catalogue, language: 'ta' }).length).toBeGreaterThan(0);
    expect(searchCatalogue({ query: '   ', products: catalogue })).toEqual([]);
  });
});

describe('the cart is reviewed before the payment screen, not at the door', () => {
  const catalogue = [
    product({}),
    product({ productId: 'p-milk', name: 'Milk 1L', availableMinor: 2 }),
    product({ productId: 'p-gone', name: 'Ghee 1L', availableMinor: 0 }),
  ];

  it('prices from the published price and totals exactly', () => {
    const review = reviewCart({ lines: [{ productId: 'p-atta', quantityMinor: 2 }], products: catalogue });
    expect(review.subtotalMinor).toBe(53_000);
    expect(review.hasProblems).toBe(false);
  });

  it('NAMES what is short and what is gone, before checkout', () => {
    const review = reviewCart({
      lines: [
        { productId: 'p-atta', quantityMinor: 1 },
        { productId: 'p-milk', quantityMinor: 5 },
        { productId: 'p-gone', quantityMinor: 1 },
      ],
      products: catalogue,
    });
    expect(review.shortfalls.map((l) => l.productId)).toEqual(['p-milk']);
    expect(review.shortfalls[0]?.detail).toBe('only 2 of 5 available');
    expect(review.unavailable.map((l) => l.productId)).toEqual(['p-gone']);
    expect(review.detail).toContain('rather than at the payment screen');
    // The subtotal reflects what can actually be supplied.
    expect(review.subtotalMinor).toBe(26_500 + 2 * 26_500);
  });

  it('handles a product that no longer exists at all', () => {
    const review = reviewCart({ lines: [{ productId: 'p-vanished', quantityMinor: 1 }], products: catalogue });
    expect(review.unavailable).toHaveLength(1);
    expect(review.lines[0]?.lineTotalMinor).toBe(0);
  });
});

describe('the repeat order drops nothing silently', () => {
  it('rebuilds the cart and NAMES what could not come back', () => {
    const catalogue = [product({}), product({ productId: 'p-gone', name: 'Ghee 1L', availableMinor: 0 })];
    const result = repeatOrder({
      previousLines: [
        { productId: 'p-atta', quantityMinor: 2 },
        { productId: 'p-gone', quantityMinor: 1 },
      ],
      products: catalogue,
    });
    expect(result.lines).toEqual([{ productId: 'p-atta', quantityMinor: 2 }]);
    expect(result.droppedProductIds).toEqual(['p-gone']);
    expect(result.detail).toContain('1 could not be: Ghee 1L');
  });

  it('says so plainly when everything came back', () => {
    const result = repeatOrder({ previousLines: [{ productId: 'p-atta', quantityMinor: 1 }], products: [product({})] });
    expect(result.detail).toBe('1 item(s) added again');
  });
});

describe('aggregate suggestions are for everyone; personal ones need consent (M16-FR-02)', () => {
  const aggregate = [
    { productId: 'p-oil', count: 90 },
    { productId: 'p-rice', count: 40 },
  ];
  const history = [{ productId: 'p-milk', lastBoughtAt: '2026-07-30T10:00:00Z' }];

  it('shows aggregate suggestions to a customer who has not consented', () => {
    const result = recommend({ customerRef: 'c-1', consents: [], aggregateAlsoBought: aggregate, personalHistory: history });
    expect(result.recommendations.every((r) => r.basis === 'aggregate')).toBe(true);
    expect(result.recommendations[0]?.productId).toBe('p-oil');
  });

  it('SAYS personalisation was omitted rather than quietly showing less', () => {
    const result = recommend({ customerRef: 'c-1', consents: ['marketing'], aggregateAlsoBought: aggregate, personalHistory: history });
    expect(result.personalisationOmitted).toContain('not consented to profiling');
  });

  it('shows personal suggestions first once consent exists', () => {
    const result = recommend({ customerRef: 'c-1', consents: ['profiling'], aggregateAlsoBought: aggregate, personalHistory: history });
    expect(result.recommendations[0]).toEqual({ productId: 'p-milk', basis: 'personal', reason: 'You bought this before' });
    expect(result.personalisationOmitted).toBeUndefined();
  });

  it('shows aggregate suggestions to a guest with no account at all', () => {
    const result = recommend({ aggregateAlsoBought: aggregate });
    expect(result.recommendations).toHaveLength(2);
    expect(result.personalisationOmitted).toBeUndefined();
  });

  it('does not repeat a product across both bases', () => {
    const result = recommend({
      customerRef: 'c-1',
      consents: ['profiling'],
      aggregateAlsoBought: [{ productId: 'p-milk', count: 10 }],
      personalHistory: history,
    });
    expect(result.recommendations).toHaveLength(1);
  });
});
