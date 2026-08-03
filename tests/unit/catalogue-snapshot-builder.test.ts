import { describe, it, expect } from 'vitest';
import {
  buildCatalogueSnapshot,
  CatalogueCache,
  type MasterProduct,
  type BuildSnapshotInput,
} from '../../packages/catalogue/src/index';
import { money } from '../../packages/contracts/src/money';
import type { PriceEntry } from '../../packages/price-list/src/index';

// The builder turns the product master + price lists into the lane's snapshot,
// using the same effective-dated precedence as the rest of the system, and never
// ships a product it cannot price safely (M03 → M05 → §31 / P-08).

const ASOF = '2026-08-02T06:00:00Z';

function master(over: Partial<MasterProduct> & Pick<MasterProduct, 'productId' | 'sku' | 'name'>): MasterProduct {
  return { baseUom: 'ea', taxClassId: 'gst18', status: 'active', ...over };
}

function priceEntry(over: Partial<PriceEntry> & Pick<PriceEntry, 'id' | 'productId' | 'scope' | 'scopeRef'>): PriceEntry {
  return {
    price: money(100_00, 'INR'),
    effectiveFrom: '2026-08-01T00:00:00Z',
    effectiveTo: null,
    status: 'active',
    version: 1,
    ...over,
  };
}

function input(over: Partial<BuildSnapshotInput> = {}): BuildSnapshotInput {
  return {
    scope: { tenantId: 't1', storeId: 'store-1', zoneId: 'zone-1' },
    version: 5,
    asOf: ASOF,
    products: [master({ productId: 'p1', sku: 'RICE1', name: 'Rice 1kg' })],
    barcodes: [{ code: '890111', productId: 'p1', kind: 'standard' }],
    priceEntries: [priceEntry({ id: 'base', productId: 'p1', scope: 'store', scopeRef: 'store-1' })],
    taxClasses: { gst18: 1800, gst0: 0 },
    ...over,
  };
}

describe('buildCatalogueSnapshot', () => {
  it('builds a versioned snapshot with prices resolved for the lane', () => {
    const result = buildCatalogueSnapshot(input());
    expect(result.includedCount).toBe(1);
    expect(result.snapshot.version).toBe(5);
    expect(result.snapshot.builtAt).toBe(ASOF);
    expect(result.snapshot.products[0]).toMatchObject({
      sku: 'RICE1',
      unitPriceMinor: 100_00,
      taxBps: 1800,
    });
    expect(result.excluded).toEqual([]);
  });

  it('honours price precedence — a zone price beats the store base price', () => {
    const result = buildCatalogueSnapshot(
      input({
        priceEntries: [
          priceEntry({ id: 'base', productId: 'p1', scope: 'store', scopeRef: 'store-1', price: money(100_00, 'INR') }),
          priceEntry({ id: 'zone', productId: 'p1', scope: 'zone', scopeRef: 'zone-1', price: money(90_00, 'INR') }),
        ],
      }),
    );
    expect(result.snapshot.products[0]?.unitPriceMinor).toBe(90_00);
  });

  it('does not pick up a price that is not yet effective', () => {
    const result = buildCatalogueSnapshot(
      input({
        priceEntries: [
          priceEntry({ id: 'now', productId: 'p1', scope: 'store', scopeRef: 'store-1', price: money(100_00, 'INR') }),
          priceEntry({
            id: 'future',
            productId: 'p1',
            scope: 'store',
            scopeRef: 'store-1',
            price: money(70_00, 'INR'),
            effectiveFrom: '2026-09-01T00:00:00Z',
            version: 2,
          }),
        ],
      }),
    );
    expect(result.snapshot.products[0]?.unitPriceMinor).toBe(100_00);
  });

  it('excludes an unpriced product with a reason instead of shipping a zero price', () => {
    const result = buildCatalogueSnapshot(
      input({
        products: [
          master({ productId: 'p1', sku: 'RICE1', name: 'Rice 1kg' }),
          master({ productId: 'p9', sku: 'NOPRICE', name: 'Unpriced Item' }),
        ],
        barcodes: [
          { code: '890111', productId: 'p1', kind: 'standard' },
          { code: '890999', productId: 'p9', kind: 'standard' },
        ],
      }),
    );
    expect(result.includedCount).toBe(1);
    expect(result.excluded).toEqual([{ productId: 'p9', sku: 'NOPRICE', reason: 'no_price' }]);
    // its barcode is dropped too — a lane can never scan into a product it lacks
    expect(result.snapshot.barcodes.map((b) => b.code)).toEqual(['890111']);
    expect(result.droppedBarcodes).toBe(1);
  });

  it('excludes a product priced above its MRP (M05-FR-02)', () => {
    const result = buildCatalogueSnapshot(
      input({
        products: [master({ productId: 'p1', sku: 'RICE1', name: 'Rice 1kg', mrpMinor: 90_00 })],
      }),
    );
    expect(result.includedCount).toBe(0);
    expect(result.excluded[0]?.reason).toBe('price_above_mrp');
  });

  it('excludes a product whose tax class is unknown', () => {
    const result = buildCatalogueSnapshot(
      input({ products: [master({ productId: 'p1', sku: 'X', name: 'X', taxClassId: 'missing' })] }),
    );
    expect(result.excluded[0]?.reason).toBe('no_tax_class');
  });

  it('includes discontinued items (marked) so a scan says "not sellable", not "unknown"', () => {
    const result = buildCatalogueSnapshot(
      input({ products: [master({ productId: 'p1', sku: 'OLD', name: 'Old Item', status: 'discontinued' })] }),
    );
    expect(result.includedCount).toBe(1);
    expect(result.snapshot.products[0]?.status).toBe('discontinued');
  });

  it('carries the recall flag and age restriction through to the lane', () => {
    const result = buildCatalogueSnapshot(
      input({
        products: [
          master({ productId: 'p1', sku: 'BAD', name: 'Recalled', recallBlock: true }),
          master({ productId: 'p2', sku: 'BEER', name: 'Beer', regulatedFlags: { minimumAge: 21 } }),
        ],
        priceEntries: [
          priceEntry({ id: 'a', productId: 'p1', scope: 'store', scopeRef: 'store-1' }),
          priceEntry({ id: 'b', productId: 'p2', scope: 'store', scopeRef: 'store-1' }),
        ],
      }),
    );
    expect(result.snapshot.products[0]?.recallBlock).toBe(true);
    expect(result.snapshot.products[1]?.regulatedFlags).toEqual({ minimumAge: 21 });
  });

  it('is deterministic — the same inputs build the same snapshot', () => {
    expect(buildCatalogueSnapshot(input())).toEqual(buildCatalogueSnapshot(input()));
  });

  it('produces a snapshot the lane cache can scan straight away', () => {
    const { snapshot } = buildCatalogueSnapshot(input());
    const cache = new CatalogueCache(snapshot);
    const hit = cache.scan('890111');
    expect(hit.product.name).toBe('Rice 1kg');
    expect(cache.version()).toBe(5);
  });
});
