import { describe, it, expect } from 'vitest';
import { categoriesOf, productsInCategory } from '../../apps/customer-app/src/categories';
import { customerPayload } from '../../edge/store-edge/src/screen-data';

/**
 * **U6 · M20-FR-01 · §27 "Customer: Category" — the customer app browses by CATEGORY, from the catalogue the phone already
 * holds (no network).** The store computer hands the app the pack's category names beside the products; the app lists the
 * top-level categories that hold something sellable, with a count, and the products of one. A category the pack does not
 * name is shown by its id, never dropped. Pure and offline.
 */
const P = (productId: string, categoryId: string, extra: Record<string, unknown> = {}) => ({ productId, name: productId, categoryId, unitPriceMinor: 100, uom: 'each', barcodes: [], status: 'active' as const, availableMinor: 5, ...extra });

describe('browse by category on the customer app', () => {
  const products = [P('MILK', 'dairy'), P('CURD', 'dairy'), P('DAL', 'grocery'), P('OLD', 'grocery', { status: 'discontinued' }), P('BOLT', 'hardware'), P('MYSTERY', 'c-9')];
  const categories = [
    { categoryId: 'food', name: 'Food', nameTa: 'உணவு', parentId: null },
    { categoryId: 'dairy', name: 'Dairy', nameTa: 'பால் பொருட்கள்', parentId: 'food' },
    { categoryId: 'grocery', name: 'Grocery', parentId: 'food' },
    { categoryId: 'hardware', name: 'Hardware', parentId: null },
    { categoryId: 'empty', name: 'Nothing here', parentId: null },
  ];

  it('lists the categories that hold something sellable, counted, in the reader\'s language; a parent counts its children; an unnamed category keeps its id', () => {
    expect(categoriesOf(products, categories, 'en')).toEqual([
      { categoryId: 'food', name: 'Food', count: 3, children: [{ categoryId: 'dairy', name: 'Dairy', count: 2 }, { categoryId: 'grocery', name: 'Grocery', count: 1 }] },
      { categoryId: 'hardware', name: 'Hardware', count: 1, children: [] },
      { categoryId: 'c-9', name: 'c-9', count: 1, children: [] },
    ]);
    expect(categoriesOf(products, categories, 'ta')[0]).toMatchObject({ name: 'உணவு', children: [{ name: 'பால் பொருட்கள்' }, { name: 'Grocery' }] });
    // No categories from the pack at all: every product's category id, as given.
    expect(categoriesOf(products, [], 'en').map((c) => [c.categoryId, c.count])).toEqual([['dairy', 2], ['grocery', 1], ['hardware', 1], ['c-9', 1]]);
  });

  it('the products of a category, sellable only, a parent reaching its children, by name', () => {
    expect(productsInCategory(products, categories, 'dairy').map((p) => p.productId)).toEqual(['CURD', 'MILK']);
    expect(productsInCategory(products, categories, 'food').map((p) => p.productId)).toEqual(['CURD', 'DAL', 'MILK']);
    expect(productsInCategory(products, categories, 'empty')).toEqual([]);
  });

  it('the store computer hands the app the pack\'s categories beside the products', () => {
    const known = <T,>(value: T) => ({ known: true as const, value });
    const unknown = { known: false as const, why: 'not in the pack' };
    const pack = {
      version: 7, products: known([{ productId: 'MILK', name: 'Milk', categoryId: 'dairy', unitPriceMinor: 6000, uom: 'each', barcodes: [], availableMinor: 3 }]),
      categories: known([{ categoryId: 'dairy', name: 'Dairy', nameTa: 'பால்', parentId: null }]),
      policies: unknown, routingPolicy: unknown, slots: unknown, consentPurposes: unknown,
    };
    const payload = customerPayload({ pack, tradingDay: '2026-11-07' } as unknown as Parameters<typeof customerPayload>[0])!;
    expect(payload['categories']).toEqual([{ categoryId: 'dairy', name: 'Dairy', nameTa: 'பால்', parentId: null }]);
  });
});
