import { describe, it, expect } from 'vitest';
import { emptyPack, known, type StorePack } from '../../edge/store-edge/src/store-pack';
import { directoryProducts, DIRECTORY_PRODUCTS_PATH } from '../../edge/store-edge/src/screen-server';

/**
 * **The store computer serves its own signed catalogue to the office picker when head office is away (U5 · UI/UX gap
 * audit G5 · P-01 · P-08).** `GET /directory/products` answers from the pack on this box: the till's slice when the box
 * holds it (names in both languages, barcodes), else the master records an office box holds, with the warehouse's
 * barcode register beside them; a box whose pack holds neither answers `known: false` — never a thin list as if whole.
 * The pack's version and arrival time ride with the rows, so the picker can say how old the copy is.
 */

const product = (productId: string, name: string, extra: Record<string, unknown> = {}) => ({ productId, name, categoryId: 'grocery', unitPriceMinor: 1000, uom: 'ea', barcodes: [], availableMinor: 0, ...extra });
const master = (productId: string, sku: string, name: string) => ({ productId, tenantId: 't', sku, name, primaryCategoryId: 'grocery', baseUom: 'ea', taxClass: '1006' });
const pack = (over: Partial<StorePack> = {}): StorePack => ({ ...emptyPack('never pulled'), version: 7, receivedAt: '2026-11-07T10:00:00.000Z', ...over });

describe('U5: the store computer serves its own catalogue to the picker', () => {
  it('is the path the chrome reads', () => { expect(DIRECTORY_PRODUCTS_PATH).toBe('/directory/products'); });

  it('answers from the till\'s slice with both names and the barcodes, the SKU from the master records, the pack\'s version and arrival', () => {
    const p = pack({
      products: known([product('p-milk', 'Toned milk 500 ml', { nameTa: 'பால் 500 மிலி', barcodes: ['8901234567890'] }), product('p-rice', 'Ponni rice 5kg')] as never),
      productMaster: known([master('p-rice', 'RICE-5KG', 'Ponni rice 5kg')] as never),
    });
    const got = directoryProducts(p, '', 500);
    expect(got).toMatchObject({ known: true, version: 7, receivedAt: '2026-11-07T10:00:00.000Z', count: 2 });
    expect(got.products).toEqual([
      { id: 'p-milk', name: 'Toned milk 500 ml', nameTa: 'பால் 500 மிலி', barcodes: ['8901234567890'] },
      { id: 'p-rice', name: 'Ponni rice 5kg', code: 'RICE-5KG', barcodes: [] },
    ]);
  });

  it('narrows by every word typed — a name, the Tamil name, a code or a barcode — and caps the rows at the limit, keeping the whole count', () => {
    const p = pack({ products: known([product('p-milk', 'Toned milk 500 ml', { nameTa: 'பால்', barcodes: ['8901234567890'] }), product('p-rice', 'Ponni rice 5kg'), product('p-dal', 'Toor dal 1kg')] as never) });
    expect(directoryProducts(p, 'milk', 500).products.map((r) => r.id)).toEqual(['p-milk']);
    expect(directoryProducts(p, 'பால்', 500).products.map((r) => r.id)).toEqual(['p-milk']);
    expect(directoryProducts(p, '89012345', 500).products.map((r) => r.id)).toEqual(['p-milk']);
    expect(directoryProducts(p, 'ponni 5kg', 500).products.map((r) => r.id)).toEqual(['p-rice']);
    expect(directoryProducts(p, 'nothing like it', 500).products).toEqual([]);
    const capped = directoryProducts(p, '', 2);
    expect(capped.count).toBe(3);
    expect(capped.products).toHaveLength(2);
  });

  it('an office box with the master records but no till slice still answers, with the warehouse\'s barcodes', () => {
    const p = pack({
      productMaster: known([master('p-rice', 'RICE-5KG', 'Ponni rice 5kg')] as never),
      warehouse: known({ assignmentId: 'a1', workerId: 'u-wh', storeId: 'S1', bins: [], barcodes: [{ barcode: '8900000000017', productId: 'p-rice', level: 'each' }] } as never),
    });
    expect(directoryProducts(p, 'rice', 500).products).toEqual([{ id: 'p-rice', name: 'Ponni rice 5kg', code: 'RICE-5KG', barcodes: ['8900000000017'] }]);
  });

  it('a box whose pack holds no catalogue says so — known: false, no rows, never a guess', () => {
    const got = directoryProducts(pack(), '', 500);
    expect(got).toEqual({ known: false, version: 7, receivedAt: '2026-11-07T10:00:00.000Z', count: 0, products: [] });
  });
});
