import { describe, it, expect } from 'vitest';
import {
  CatalogueCache,
  UnknownBarcodeError,
  ItemNotSellableError,
  RecalledItemError,
  ExpiredItemError,
  parseGs1Date,
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

describe('parseGs1Date', () => {
  it('parses a YYMMDD date to YYYY-MM-DD (year → 20YY)', () => {
    expect(parseGs1Date('260815')).toBe('2026-08-15');
  });
  it('treats a day of 00 as the last day of the month (GS1 convention)', () => {
    expect(parseGs1Date('260200')).toBe('2026-02-28'); // Feb 2026, last day
    expect(parseGs1Date('240200')).toBe('2024-02-29'); // leap year
  });
  it('rejects an impossible or malformed date', () => {
    expect(parseGs1Date('261301')).toBeUndefined();  // month 13
    expect(parseGs1Date('260431')).toBeUndefined();  // 31 April
    expect(parseGs1Date('2608')).toBeUndefined();    // too short
    expect(parseGs1Date('26081a')).toBeUndefined();  // non-digit
  });
});

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

  describe('refuses a past-use-by batch at the lane, even offline (B8 / M10·M12)', () => {
    const RICE = '8901234567890';

    it('blocks a batch whose use-by is before today', () => {
      const cache = new CatalogueCache(snapshot());
      expect(() => cache.scan(RICE, { asOf: '2026-08-07T10:00:00Z', batchExpiry: '2026-08-01' })).toThrow(ExpiredItemError);
    });

    it('allows a sale ON the use-by date (the last sellable day)', () => {
      const cache = new CatalogueCache(snapshot());
      expect(cache.scan(RICE, { asOf: '2026-08-07', batchExpiry: '2026-08-07' }).product.sku).toBe('RICE1');
    });

    it('allows a batch still in date', () => {
      const cache = new CatalogueCache(snapshot());
      expect(cache.scan(RICE, { asOf: '2026-08-07', batchExpiry: '2026-12-31' }).product.sku).toBe('RICE1');
    });

    it('is backward-compatible: a plain scan, or one it cannot judge, does not block', () => {
      const cache = new CatalogueCache(snapshot());
      expect(cache.scan(RICE).product.sku).toBe('RICE1');                                  // no batch context
      expect(cache.scan(RICE, { batchExpiry: '2020-01-01' }).product.sku).toBe('RICE1');   // no asOf → cannot judge
      expect(cache.scan(RICE, { asOf: '2026-08-07' }).product.sku).toBe('RICE1');          // no expiry → cannot judge
      expect(cache.scan(RICE, { asOf: '2026-08-07', batchExpiry: 'soon' }).product.sku).toBe('RICE1'); // bad date → cannot judge
    });

    it('checks recall BEFORE expiry — a recalled item refuses as recalled, not expired', () => {
      const cache = new CatalogueCache(snapshot());
      expect(() => cache.scan('8901234500005', { asOf: '2026-08-07', batchExpiry: '2026-08-01' })).toThrow(RecalledItemError);
    });
  });

  describe('reads the use-by date from a date-coded barcode and blocks an expired one (B8 auto-capture)', () => {
    // A tenant whose perishable label encodes the batch use-by GS1-style: prefix '3', item at 1..6,
    // a YYMMDD date at 7..12.
    const dateCoded = (over: Partial<CatalogueSnapshot> = {}) => new CatalogueCache(snapshot({
      products: [product({ productId: 'p6', sku: '778899', name: 'Fresh Milk' })],
      barcodes: [],
      embeddedRules: [{ prefix: '3', itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 6, valueKind: 'expiry' }],
      ...over,
    }));
    const code = (yymmdd: string) => `3778899${yymmdd}`; // prefix + SKU 778899 + YYMMDD

    it('refuses a scan whose encoded use-by is before today', () => {
      const cache = dateCoded();
      expect(() => cache.scan(code('260730'), { asOf: '2026-08-02' })).toThrow(ExpiredItemError); // use-by 30 Jul
    });

    it('rings up a date-coded item that is still in date, as one unit', () => {
      const cache = dateCoded();
      const hit = cache.scan(code('261231'), { asOf: '2026-08-02' }); // use-by 31 Dec
      expect(hit.product.sku).toBe('778899');
      expect(hit.quantityMinor).toBe(1);
    });

    it('does not block when today is unknown (a plain scan of the same code)', () => {
      const cache = dateCoded();
      expect(cache.scan(code('260730')).product.sku).toBe('778899'); // no asOf → cannot judge → no block
    });
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
