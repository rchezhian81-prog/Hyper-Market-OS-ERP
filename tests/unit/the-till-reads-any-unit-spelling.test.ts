import { describe, it, expect } from 'vitest';
import { CatalogueCache, UnknownUnitError, type CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

/** OB-31 "A" (rule 4): the till normalises the product's unit spelling, so 'each' / 'KG' sell; a unit no rule knows is refused. */
const snapshot = (baseUom: string): CatalogueSnapshot => ({
  tenantId: 't', version: 1, builtAt: '2026-10-10T00:00:00.000Z',
  products: [{ productId: 'p', sku: 'p', name: 'Item', unitPriceMinor: 1_000, taxBps: 0, status: 'active', baseUom } as never],
  barcodes: [{ code: '8900000000001', productId: 'p', kind: 'standard' }],
} as CatalogueSnapshot);

describe('the till reads the product unit in any spelling (OB-31)', () => {
  it.each([['each', 'ea'], ['EA', 'ea'], ['KG', 'kg'], ['kg', 'kg'], ['ltr', 'L']])('"%s" sells as "%s"', (spelt, unit) => {
    expect(new CatalogueCache(snapshot(spelt)).scan('8900000000001').product.baseUom).toBe(unit);
  });
  it('a unit no rule knows is refused by name', () => {
    expect(() => new CatalogueCache(snapshot('bundle')).scan('8900000000001')).toThrow(UnknownUnitError);
  });
});
