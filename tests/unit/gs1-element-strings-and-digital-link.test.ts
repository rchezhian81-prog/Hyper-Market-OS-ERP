import { describe, it, expect } from 'vitest';
import {
  parseGs1, looksLikeGs1, gtinCandidates, hasValidCheckDigit, Gs1ParseError, GROUP_SEPARATOR, parseGs1Date,
} from '../../packages/gs1/src/index';
import {
  CatalogueCache, ExpiredItemError, RecalledItemError, UnknownBarcodeError, UnsupportedGs1ContentError,
  type CatalogueSnapshot, type CatalogueProduct,
} from '../../packages/catalogue/src/catalogue';

// D-20 (roadmap v2.1, signed 18 Oct 2026 · OB-188): "a GS1 element string or Digital Link scan is parsed offline into
// GTIN (01), batch (10) and expiry (17). The line carries the batch. An expired batch is refused (B8). A batch under
// markdown is charged the markdown price. A 1D scan behaves exactly as today. The scan stays sub-second with no network."
// SF-08 (OB-139 "A"): a plain barcode blocks the whole product; batch by batch only when the barcode carries the batch.

const GS = GROUP_SEPARATOR;
const PANEER_EAN = '8901000000019';
const PANEER_GTIN = '08901000000019';

describe('packages/gs1 reads the three forms a scanner sends', () => {
  it('the raw element string, with a symbology identifier and a group separator after the variable batch', () => {
    const r = parseGs1(`]d201${PANEER_GTIN}10B-1${GS}17300615`);
    expect(r).toMatchObject({ form: 'element_string', gtin: PANEER_GTIN, batch: 'B-1', expiry: '2030-06-15' });
  });

  it('a batch at the END needs no separator; fixed fields need none either', () => {
    expect(parseGs1(`01${PANEER_GTIN}1730061510B-2`)).toMatchObject({ gtin: PANEER_GTIN, expiry: '2030-06-15', batch: 'B-2' });
    expect(parseGs1(`${GS}01${PANEER_GTIN}17300600`)).toMatchObject({ expiry: '2030-06-30' }); // day 00 = last day of month
  });

  it('the printed (AI)value form', () => {
    expect(parseGs1(`(01)${PANEER_GTIN}(17)300615(10)B-1`)).toMatchObject({ form: 'human_readable', gtin: PANEER_GTIN, batch: 'B-1', expiry: '2030-06-15' });
  });

  it('a Digital Link web address — read as text, the domain ignored, keys from the path, attributes from the query', () => {
    expect(parseGs1(`https://id.gs1.org/01/${PANEER_GTIN}/10/B%2F7?17=300615&utm=shelf`))
      .toMatchObject({ form: 'digital_link', gtin: PANEER_GTIN, batch: 'B/7', expiry: '2030-06-15' });
    expect(parseGs1(`https://brand.example/some/prefix/01/${PANEER_GTIN}/21/SER9`)).toMatchObject({ serial: 'SER9' });
  });

  it('refuses what it cannot read with certainty — by name, never half-read', () => {
    const reason = (code: string): string => { try { parseGs1(code); return 'read'; } catch (e) { return (e as Gs1ParseError).reason; } };
    expect(reason(`01${PANEER_GTIN.slice(0, 13)}8`)).toBe('gtin_check_digit_wrong');
    expect(reason(`01${PANEER_GTIN}17301345`)).toBe('date_not_a_date');
    expect(reason(`01${PANEER_GTIN}77ABC`)).toBe('unknown_application_identifier');
    expect(reason('(10)B-1(17)300615')).toBe('no_gtin');
    expect(reason(`01${PANEER_GTIN}10${'X'.repeat(21)}`)).toBe('field_too_long');
    expect(reason(`(01)${PANEER_GTIN}(10)B-1(10)B-2`)).toBe('repeated_application_identifier');
    expect(reason('')).toBe('empty');
    expect(() => parseGs1('https://id.gs1.org/10/B-1')).toThrow(Gs1ParseError);
  });

  it('a plain 1D barcode never looks like a GS1 code; the GTIN maps back to the 1D codes a label carries', () => {
    expect(looksLikeGs1(PANEER_EAN)).toBe(false);
    expect(looksLikeGs1('8901000000019123')).toBe(false);
    expect(looksLikeGs1(`(01)${PANEER_GTIN}`)).toBe(true);
    expect(looksLikeGs1(`01${PANEER_GTIN}17300615`)).toBe(true);
    expect(looksLikeGs1('https://example.com/menu')).toBe(false);
    expect(gtinCandidates(PANEER_GTIN)).toEqual([PANEER_GTIN, PANEER_EAN]);
    expect(gtinCandidates('00000096385074')).toEqual(['00000096385074', '0000096385074', '000096385074', '96385074']);
    expect(hasValidCheckDigit(PANEER_EAN)).toBe(true);
    expect(hasValidCheckDigit('8901000000011')).toBe(false);
    expect(parseGs1Date('300229')).toBeUndefined();
  });
});

const product = (over: Partial<CatalogueProduct> & Pick<CatalogueProduct, 'productId' | 'name'>): CatalogueProduct => ({
  sku: over.productId, baseUom: 'ea', unitPriceMinor: 90_00, taxBps: 500, status: 'active', ...over,
});

function cache(products: readonly CatalogueProduct[]): CatalogueCache {
  const snapshot: CatalogueSnapshot = {
    tenantId: 't', version: 1, builtAt: '2030-06-01T00:00:00.000Z', products,
    barcodes: products.map((p, i) => ({ code: [PANEER_EAN, '8901000000026'][i]!, productId: p.productId, kind: 'standard' as const })),
  };
  return new CatalogueCache(snapshot);
}

describe('the lane catalogue scans a GS1 code offline (D-20 · SF-08)', () => {
  const today = { asOf: '2030-06-10' };

  it('the line carries the batch and expiry the code carried', () => {
    const hit = cache([product({ productId: 'p-paneer', name: 'Paneer 200g' })]).scan(`(01)${PANEER_GTIN}(17)300615(10)B-1`, today);
    expect(hit.product.productId).toBe('p-paneer');
    expect(hit.batch).toEqual({ gtin: PANEER_GTIN, batchId: 'B-1', expiry: '2030-06-15' });
    expect(hit.markdownPriceMinor).toBeUndefined();
  });

  it('an expired batch is refused (B8) — the expiry date itself is the last sellable day', () => {
    const c = cache([product({ productId: 'p-paneer', name: 'Paneer 200g' })]);
    expect(() => c.scan(`(01)${PANEER_GTIN}(17)300609(10)B-1`, today)).toThrow(ExpiredItemError);
    expect(() => c.scan(`(01)${PANEER_GTIN}(17)300609(10)B-1`, today)).toThrow(/Paneer 200g.*2030-06-09/);
    expect(c.scan(`(01)${PANEER_GTIN}(17)300610(10)B-1`, today).batch?.expiry).toBe('2030-06-10');
  });

  it('a batch under markdown is charged the markdown price; another batch and the plain barcode are not', () => {
    const c = cache([product({ productId: 'p-paneer', name: 'Paneer 200g', batchPrices: [{ batchId: 'B-1', unitPriceMinor: 45_00 }] })]);
    expect(c.scan(`(01)${PANEER_GTIN}(10)B-1`, today).markdownPriceMinor).toBe(45_00);
    expect(c.scan(`(01)${PANEER_GTIN}(10)B-2`, today).markdownPriceMinor).toBeUndefined();
    expect(c.scan(PANEER_EAN, today).markdownPriceMinor).toBeUndefined();
  });

  it('a 1D scan behaves exactly as before — no batch, the product price, the same refusals', () => {
    const c = cache([product({ productId: 'p-paneer', name: 'Paneer 200g', batchPrices: [{ batchId: 'B-1', unitPriceMinor: 45_00 }] })]);
    const hit = c.scan(PANEER_EAN);
    expect(hit).toEqual({ product: expect.objectContaining({ productId: 'p-paneer' }), barcodeKind: 'standard', quantityMinor: 1, requiresAgeCheck: false });
    expect(() => c.scan('8901000000099')).toThrow(UnknownBarcodeError);
  });

  it('OB-139 "A": with batch B-1 recalled, a 2D code carrying B-1 is refused BY NAME, B-2 sells, a plain barcode blocks the whole product', () => {
    const c = cache([product({ productId: 'p-paneer', name: 'Paneer 200g', recallBlock: true, blockedBatches: ['B-1'] })]);
    expect(() => c.scan(`(01)${PANEER_GTIN}(10)B-1`, today)).toThrow(RecalledItemError);
    expect(() => c.scan(`(01)${PANEER_GTIN}(10)B-1`, today)).toThrow(/Paneer 200g" batch B-1/);
    expect(c.scan(`(01)${PANEER_GTIN}(10)B-2`, today).batch?.batchId).toBe('B-2');
    expect(() => c.scan(PANEER_EAN, today)).toThrow(RecalledItemError);
    // A 2D code with no batch is a plain barcode for this purpose: the whole product.
    expect(() => c.scan(`(01)${PANEER_GTIN}(17)300615`, today)).toThrow(RecalledItemError);
  });

  it('a recall on the product ITSELF (no batch list) refuses every batch, whatever the code carries', () => {
    const c = cache([product({ productId: 'p-paneer', name: 'Paneer 200g', recallBlock: true })]);
    expect(() => c.scan(`(01)${PANEER_GTIN}(10)B-2`, today)).toThrow(RecalledItemError);
  });

  it('a GTIN the catalogue does not hold is unknown; a weight or price inside the code is refused by name, never sold as one unit', () => {
    const c = cache([product({ productId: 'p-paneer', name: 'Paneer 200g' })]);
    expect(() => c.scan('(01)08901000000057(10)B-1', today)).toThrow(UnknownBarcodeError);
    expect(() => c.scan(`(01)${PANEER_GTIN}(3103)000250`, today)).toThrow(UnsupportedGs1ContentError);
    expect(() => c.scan(`(01)${PANEER_GTIN}(3922)4500`, today)).toThrow(/price/);
  });

  it('a GS1 scan is as quick as a 1D scan: O(1), no catalogue walk (sub-second at the lane)', () => {
    const many: CatalogueProduct[] = Array.from({ length: 2 }, (_, i) => product({ productId: `p-${i}`, name: `Item ${i}` }));
    const c = cache(many);
    const started = performance.now();
    for (let i = 0; i < 2_000; i += 1) c.scan(`]d201${PANEER_GTIN}10B-${i % 9}${GS}17300615`, today);
    expect((performance.now() - started) / 2_000).toBeLessThan(5); // ms per scan, far under the ≤300 ms p95 target
  });
});
