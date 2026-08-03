import { describe, it, expect } from 'vitest';
import {
  CatalogueCache,
  UnknownBarcodeError,
  ItemNotSellableError,
  RecalledItemError,
  type CatalogueSnapshot,
  type CatalogueProduct,
} from '../../packages/catalogue/src/index';

// The lane's local catalogue: O(1) barcode lookup from an offline snapshot,
// variable-weight/price barcodes, and refusals at the scan (M03 / M12 / §31).

const BUILT_AT = '2026-08-02T06:00:00Z';

function product(over: Partial<CatalogueProduct> & Pick<CatalogueProduct, 'productId' | 'sku' | 'name'>): CatalogueProduct {
  return {
    baseUom: 'ea',
    unitPriceMinor: 100_00,
    taxBps: 1800,
    status: 'active',
    ...over,
  };
}

function snapshot(over: Partial<CatalogueSnapshot> = {}): CatalogueSnapshot {
  return {
    tenantId: 't1',
    version: 7,
    builtAt: BUILT_AT,
    products: [
      product({ productId: 'p1', sku: 'RICE1', name: 'Rice 1kg' }),
      product({ productId: 'p2', sku: 'TOM', name: 'Tomato', baseUom: 'kg', unitPriceMinor: 80_00 }),
      product({ productId: 'p3', sku: 'BEER', name: 'Beer 650ml', regulatedFlags: { minimumAge: 21 } }),
      product({ productId: 'p4', sku: 'OLD', name: 'Old Item', status: 'discontinued' }),
      product({ productId: 'p5', sku: 'BAD', name: 'Recalled Batch Item', recallBlock: true }),
    ],
    barcodes: [
      { code: '8901234567890', productId: 'p1', kind: 'standard' },
      { code: '8901234500003', productId: 'p3', kind: 'standard' },
      { code: '8901234500004', productId: 'p4', kind: 'standard' },
      { code: '8901234500005', productId: 'p5', kind: 'standard' },
    ],
    // Tenant rule: EAN-13 starting "2" → item code at 1..6, value (grams) at 7..12.
    embeddedRules: [
      { prefix: '2', itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight' },
    ],
    ...over,
  };
}

describe('CatalogueCache', () => {
  it('resolves a plain barcode to its product', () => {
    const cache = new CatalogueCache(snapshot());
    const hit = cache.scan('8901234567890');
    expect(hit.product.name).toBe('Rice 1kg');
    expect(hit.quantityMinor).toBe(1);
    expect(hit.barcodeKind).toBe('standard');
    expect(hit.requiresAgeCheck).toBe(false);
  });

  it('trims whitespace a scanner may append', () => {
    const cache = new CatalogueCache(snapshot());
    expect(cache.scan('  8901234567890 \n').product.sku).toBe('RICE1');
  });

  it('refuses an unknown barcode', () => {
    const cache = new CatalogueCache(snapshot());
    expect(() => cache.scan('0000000000000')).toThrow(UnknownBarcodeError);
  });

  it('refuses a discontinued item', () => {
    const cache = new CatalogueCache(snapshot());
    expect(() => cache.scan('8901234500004')).toThrow(ItemNotSellableError);
  });

  it('refuses a recalled item even offline (M10-FR-04)', () => {
    const cache = new CatalogueCache(snapshot());
    expect(() => cache.scan('8901234500005')).toThrow(RecalledItemError);
  });

  it('flags an age-restricted item so the lane prompts', () => {
    const cache = new CatalogueCache(snapshot());
    expect(cache.scan('8901234500003').requiresAgeCheck).toBe(true);
  });

  it('decodes a weight-embedded barcode into a quantity', () => {
    const cache = new CatalogueCache(snapshot());
    // "2" + item "TOM"→ matched by SKU is not numeric here, so use a numeric item code
    const withNumericSku = snapshot({
      products: [product({ productId: 'p2', sku: '123456', name: 'Tomato', baseUom: 'kg', unitPriceMinor: 80_00 })],
      barcodes: [],
    });
    const numericCache = new CatalogueCache(withNumericSku);
    // 2 | 123456 | 01234 | C  → 1234 g of item 123456
    const hit = numericCache.scan('2123456012349');
    expect(hit.product.name).toBe('Tomato');
    expect(hit.barcodeKind).toBe('weight_embedded');
    expect(hit.quantityMinor).toBe(1234); // grams
    expect(hit.priceOverrideMinor).toBeUndefined();
    expect(cache.productCount()).toBe(5);
  });

  it('decodes a price-embedded barcode into a line price', () => {
    const priceRule = snapshot({
      products: [product({ productId: 'p9', sku: '654321', name: 'Deli Counter Item' })],
      barcodes: [],
      embeddedRules: [
        { prefix: '2', itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'price' },
      ],
    });
    const cache = new CatalogueCache(priceRule);
    // 2 | 654321 | 02550 | C → ₹25.50 for this pack
    const hit = cache.scan('2654321025503');
    expect(hit.barcodeKind).toBe('price_embedded');
    expect(hit.priceOverrideMinor).toBe(2550);
    expect(hit.quantityMinor).toBe(1);
  });

  it('exposes its version and staleness so the lane can show it (P-08)', () => {
    const cache = new CatalogueCache(snapshot());
    expect(cache.version()).toBe(7);
    expect(cache.builtAt()).toBe(BUILT_AT);
    expect(cache.ageSeconds('2026-08-02T06:10:00Z')).toBe(600);
    expect(cache.isStale('2026-08-02T06:10:00Z', 3600)).toBe(false);
    expect(cache.isStale('2026-08-03T06:10:00Z', 3600)).toBe(true);
  });

  it('looks up by SKU for a manual keyed entry', () => {
    const cache = new CatalogueCache(snapshot());
    expect(cache.findBySku('RICE1')?.productId).toBe('p1');
    expect(cache.findBySku('NOPE')).toBeUndefined();
  });
});
