import { describe, it, expect } from 'vitest';
import { productChecks, type ProductRecord, type Category } from '../../packages/product/src/index';

/**
 * OB-625 (owner, 1 Nov 2026): the three read-only product-master check reports — no tax mapping, allergen or ingredient
 * details missing where the category needs them, no barcode. The rules: an HSN with no GST rate on the shop's day is a gap
 * (a rate dated later does not count yet); a schedule that could not be read is "not read", never "no rate"; a `food`
 * category needs an allergen declaration (an empty list is "declared: none"); a `food` + `packed` category also needs an
 * ingredient list; a category not on the list cannot be judged and is said so; a weighed product with no barcode is marked;
 * only sellable products are checked, and the count says how many.
 */

const product = (id: string, extra: Partial<ProductRecord> = {}): ProductRecord => ({
  productId: id, tenantId: 't', sku: `SKU-${id}`, name: `Synthetic ${id}`, primaryCategoryId: 'plain', baseUom: 'ea', taxClass: '1006',
  lifecycle: 'active', safety: { allergens: [], ingredients: 'x' }, ...extra,
} as ProductRecord);
const categories: Category[] = [
  { categoryId: 'plain', name: 'Plain', parentId: null },
  { categoryId: 'fresh', name: 'Fresh', parentId: null, regulated: ['food'] },
  { categoryId: 'packed', name: 'Packed food', parentId: null, regulated: ['food', 'packed'] },
];
const rates = new Map<string, { effectiveFrom: string; rateBps: number }[] | null>([['1006', [{ effectiveFrom: '2017-07-01', rateBps: 500 }]], ['2202', [{ effectiveFrom: '2027-01-01', rateBps: 1_200 }]], ['3401', null]]);
const run = (products: ProductRecord[], barcodes: { code: string; productId: string; kind: 'internal' }[] = []) =>
  productChecks({ products, categories, barcodes, gstSchedules: rates, onDay: '2026-11-01' });
const why = (r: ReturnType<typeof run>, report: string, id: string) => r.rows.find((x) => x.report === report && x.productId === id)?.reasons;

describe('the product checks (OB-625)', () => {
  it('no tax mapping: no HSN, a rate only from a later date, and a schedule that could not be read are three different things', () => {
    const r = run([product('A', { taxClass: null }), product('B', { taxClass: '2202' }), product('C', { taxClass: '3401' }), product('D')]);
    expect(why(r, 'tax', 'A')).toEqual(['no_hsn_code']);
    expect(why(r, 'tax', 'B')).toEqual(['no_gst_rate_today']);
    expect(why(r, 'tax', 'C')).toEqual(['gst_rate_not_read']);
    expect(why(r, 'tax', 'D')).toBeUndefined();
    expect(r.counts.tax).toBe(3);
  });

  it('allergens where the category is food; ingredients only where it is packed food; an unknown category is not judged', () => {
    const r = run([
      product('F1', { primaryCategoryId: 'fresh', safety: {} }), product('F2', { primaryCategoryId: 'fresh', safety: { allergens: [] } }),
      product('P1', { primaryCategoryId: 'packed', safety: { allergens: ['milk'] } }), product('N', { primaryCategoryId: 'gone', safety: {} }),
      product('X', { safety: {} }),
    ]);
    expect(why(r, 'allergens', 'F1')).toEqual(['no_allergen_declaration']);
    expect(why(r, 'allergens', 'F2')).toBeUndefined(); // "declared: none", and fresh food asks no ingredient list
    expect(why(r, 'allergens', 'P1')).toEqual(['no_ingredient_list']);
    expect(why(r, 'allergens', 'N')).toEqual(['category_not_on_the_list']);
    expect(why(r, 'allergens', 'X')).toBeUndefined(); // a plain category asks for neither
    expect(r.notJudged).toBe(1);
  });

  it('no barcode: any pack level counts; a weighed product is marked; only sellable products are checked and counted', () => {
    const r = run([product('S'), product('K', { baseUom: 'kg' }), product('B'), product('OLD', { lifecycle: 'discontinued' })], [{ code: 'B-1', productId: 'B', kind: 'internal' }]);
    expect(r.rows.filter((x) => x.report === 'barcode').map((x) => [x.productId, x.soldByWeight])).toEqual([['K', true], ['S', false]]);
    expect(r).toMatchObject({ checked: 3, onMaster: 4 });
    expect(r.rows.some((x) => x.productId === 'OLD')).toBe(false);
  });
});
