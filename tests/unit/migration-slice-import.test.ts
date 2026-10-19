import { describe, it, expect } from 'vitest';
import {
  SLICE_FILES, SLICE_TEMPLATES, readSliceFile, sliceApplyGate, sliceExceptionsCsv, sliceTemplateCsv, splitCsvLine, stageSlice,
  type SliceAcceptance, type SliceDepartment,
} from '../../packages/migration/src/slice-import';
import { validateBundle } from '../../packages/migration/src/load';

/**
 * OB-241 / MG-05 / §34.1 — the first department's slice, judged ROW BY ROW: good rows staged, bad rows quarantined with
 * their file, line, source key and reason, and nothing applied until a named person accepts exactly this list.
 * Synthetic data only.
 */

const DEPT: SliceDepartment = { categoryId: 'staples', name: 'Staples', regulated: ['food', 'packed'] };
const FOOD = 'none,India,1 kg,Synthetic Packers Pvt Ltd Chennai';
const tax = ['hsn_code,effective_from,rate_percent', '1006,2017-07-01,5', '0713,2017-07-01,0'].join('\n');
const products = [
  SLICE_TEMPLATES['products.csv'].columns.join(','),
  `R-001,,Synthetic rice 1kg,each,staples,1006,,active,${FOOD},,,`,
  `R-002,,Synthetic dal 1kg,each,staples,0713,,active,${FOOD},,,`,
  `R-003,,Synthetic oil 1L,each,oils,1006,,active,${FOOD},,,`,             // outside the department
  `R-004,,Synthetic salt 1kg,each,staples,2501,,active,${FOOD},,,`,        // no tax class
  `R-005,,Synthetic sugar 1kg,each,staples,1006,,active,,India,1 kg,Synthetic Packers,,,`, // food with no allergen declaration
  `R-001,,Duplicate rice,each,staples,1006,,active,${FOOD},,,`,            // duplicate item code
  `R-006,,"Synthetic "atta, 1kg",each,staples,1006,,active,${FOOD},,,`,     // a broken line
  `R-007,,Synthetic poha 500g,each,staples,1006,,active,${FOOD},,,`,       // will have no price
].join('\n');
const prices = [
  'item_code,mrp,selling_price,cost_price,margin_floor_percent',
  'R-001,60.00,55.00,48.00,', 'R-002,140.00,150.00,120.00,',   // R-002 above MRP
  'R-003,200.00,190.00,170.00,', 'R-009,10.00,9.00,8.00,',       // R-003 not staged; R-009 unknown
].join('\n');
const barcodes = [
  'item_code,barcode,kind', 'R-001,8900000000011,', 'R-001,8900000000028,', 'R-002,8900000000035,',
  'R-003,8900000000042,', 'R-001,8900000000059,', 'R-007,8900000000059,', 'R-001,8900000000011,',
].join('\n');

const staged = () => stageSlice({ department: DEPT, files: { 'tax-classes.csv': tax, 'products.csv': products, 'prices.csv': prices, 'barcodes.csv': barcodes } });

describe('the templates', () => {
  it('there are exactly four — products, barcodes, tax classes and prices — and each downloads as its header line alone', () => {
    expect([...SLICE_FILES].sort()).toEqual(['barcodes.csv', 'prices.csv', 'products.csv', 'tax-classes.csv']);
    for (const f of SLICE_FILES) {
      expect(sliceTemplateCsv(f)).toBe(`${SLICE_TEMPLATES[f].columns.join(',')}\n`);
      for (const r of SLICE_TEMPLATES[f].required) expect(SLICE_TEMPLATES[f].columns).toContain(r);
      for (const c of SLICE_TEMPLATES[f].columns) expect(SLICE_TEMPLATES[f].help[c], `${f} ${c} has help`).toBeTruthy();
    }
  });

  it('a header that is not the template is refused by name — never a guessed column', () => {
    expect(readSliceFile('prices.csv', 'item_code,price\nR-1,10').headerProblem).toMatch(/not a template column: price; required column missing: mrp, selling_price, cost_price/);
    expect(readSliceFile('prices.csv', '').headerProblem).toMatch(/first line must be/);
    expect(readSliceFile('prices.csv', 'item_code,mrp,mrp,selling_price,cost_price\n').headerProblem).toMatch(/column given twice: mrp/);
    // Order and case do not matter.
    expect(readSliceFile('tax-classes.csv', 'RATE_PERCENT,hsn_code,Effective_From\n5,1006,2017-07-01').records).toEqual([{ line: 2, row: { rate_percent: '5', hsn_code: '1006', effective_from: '2017-07-01' } }]);
  });

  it('splits quoted cells and refuses an unclosed quote on its own line only', () => {
    expect(splitCsvLine('a,"b, c","d ""e"""')).toEqual(['a', 'b, c', 'd "e"']);
    expect(splitCsvLine('a,"b')).toBeUndefined();
    const r = readSliceFile('barcodes.csv', 'item_code,barcode,kind\nR-1,"123\nR-2,456,ean');
    expect(r.records).toEqual([{ line: 2, unreadable: 'a quoted value is never closed on this line' }, { line: 3, row: { item_code: 'R-2', barcode: '456', kind: 'ean' } }]);
  });
});

describe('staging, row by row', () => {
  it('good rows are staged and every bad row is quarantined with file, line, source key and reason — one bad row never stops the others', () => {
    const s = staged();
    expect(s.headerProblems).toEqual([]);
    expect(s.bundle.products.map((p) => p.productId)).toEqual(['R-001']);
    expect(s.bundle.products[0]).toMatchObject({ priceMinor: 5500, mrpMinor: 6000, costMinor: 4800, marginFloorBps: 0, primaryCategoryId: 'staples', taxClass: '1006', sku: 'R-001' });
    expect(s.bundle.products[0]!.barcodes.map((b) => b.code)).toEqual(['8900000000011', '8900000000028']);
    expect(s.bundle.suppliers).toEqual([]);
    expect(s.bundle.customers).toEqual([]);
    expect(s.bundle.openingStock).toEqual([]);
    const by = (file: string, line: number) => s.exceptions.find((e) => e.file === file && e.line === line);
    expect(by('products.csv', 4)).toMatchObject({ sourceKey: 'R-003', code: 'outside_the_department', column: 'category' });
    expect(by('products.csv', 5)).toMatchObject({ sourceKey: 'R-004', code: 'no_tax_class' });
    expect(by('products.csv', 6)).toMatchObject({ sourceKey: 'R-005', code: 'product_rules' });
    expect(by('products.csv', 7)).toMatchObject({ sourceKey: 'R-001', code: 'duplicate' });
    expect(by('products.csv', 8)).toMatchObject({ code: 'unreadable_line', sourceKey: '' });
    expect(by('products.csv', 9)).toMatchObject({ sourceKey: 'R-007', code: 'no_price' });
    expect(by('products.csv', 3)).toMatchObject({ sourceKey: 'R-002', code: 'no_price' }); // its only price was above MRP
    expect(by('prices.csv', 3)).toMatchObject({ sourceKey: 'R-002', code: 'price_above_mrp' });
    expect(by('prices.csv', 4)).toMatchObject({ sourceKey: 'R-003', code: 'depends_on_a_quarantined_row' });
    expect(by('prices.csv', 5)).toMatchObject({ sourceKey: 'R-009', code: 'unknown_item' });
    expect(by('barcodes.csv', 4)).toMatchObject({ sourceKey: '8900000000035', code: 'depends_on_a_quarantined_row' });
    expect(by('barcodes.csv', 5)).toMatchObject({ sourceKey: '8900000000042', code: 'depends_on_a_quarantined_row' });
    // One code on two items: BOTH rows are held back.
    expect(by('barcodes.csv', 6)).toMatchObject({ code: 'barcode_on_two_items' });
    expect(by('barcodes.csv', 7)).toMatchObject({ code: 'barcode_on_two_items' });
    expect(by('barcodes.csv', 8)).toMatchObject({ code: 'duplicate' });
    expect(s.exceptions.every((e) => e.disposition === 'quarantined' && e.reason.length > 10)).toBe(true);
    // Every row read is either staged or quarantined — none vanishes.
    expect(s.counts['products.csv']).toEqual({ rows: 8, staged: 1, quarantined: 7 });
    expect(s.counts['barcodes.csv']).toEqual({ rows: 7, staged: 2, quarantined: 5 });
    expect(s.counts['tax-classes.csv']).toEqual({ rows: 2, staged: 2, quarantined: 0 });
  });

  it('what is staged is exactly what the bulk loader accepts (its own whole-bundle check finds nothing)', () => {
    expect(validateBundle(staged().bundle)).toEqual([]);
  });

  it('a blank or unreadable price is never loaded as zero, and two prices for one item hold BOTH back', () => {
    const s = stageSlice({ department: DEPT, files: {
      'tax-classes.csv': tax, 'products.csv': products.split('\n').slice(0, 2).join('\n'),
      'prices.csv': ['item_code,mrp,selling_price,cost_price', 'R-001,60.00,,48.00', 'R-001,60.00,55.00,48.00', 'R-001,61.00,55.00,48.00'].join('\n'),
    } });
    expect(s.bundle.products).toEqual([]);
    expect(s.exceptions.filter((e) => e.file === 'prices.csv').map((e) => [e.line, e.code])).toEqual([[2, 'bad_value'], [3, 'duplicate'], [4, 'duplicate']]);
    expect(s.exceptions.find((e) => e.file === 'products.csv')).toMatchObject({ code: 'no_price', reason: expect.stringMatching(/more than one price row/) });
  });

  it('a bad tax row is quarantined, and the products naming only that HSN go with it', () => {
    const s = stageSlice({ department: DEPT, files: {
      'tax-classes.csv': ['hsn_code,effective_from,rate_percent', '1006,2017-02-30,5', '0713,2017-07-01,abc'].join('\n'),
      'products.csv': products.split('\n').slice(0, 3).join('\n'), 'prices.csv': prices,
    } });
    expect(s.bundle.taxRates).toEqual([]);
    expect(s.exceptions.filter((e) => e.file === 'tax-classes.csv').map((e) => e.column)).toEqual(['effective_from', 'rate_percent']);
    expect(s.exceptions.filter((e) => e.file === 'products.csv').every((e) => e.code === 'no_tax_class')).toBe(true);
  });

  it('a file that does not follow the template stops the whole slice (columns would be guessed), and so does a missing department', () => {
    const s = stageSlice({ department: DEPT, files: { 'tax-classes.csv': tax, 'products.csv': 'code,name\nR-1,x', 'prices.csv': prices } });
    expect(s.headerProblems.join(' ')).toMatch(/products.csv: not a template column/);
    expect(s.bundle.products).toEqual([]);
    expect(stageSlice({ department: { categoryId: '', name: '' }, files: { 'tax-classes.csv': tax, 'products.csv': products, 'prices.csv': prices } }).headerProblems.join(' ')).toMatch(/must name the pilot department/);
    expect(stageSlice({ department: DEPT, files: { 'products.csv': products } }).headerProblems.join(' ')).toMatch(/tax-classes.csv is missing.*prices.csv is missing/);
  });

  it('the digest changes when one byte of a file changes, and is stable otherwise', () => {
    expect(staged().digest).toBe(staged().digest);
    const changed = stageSlice({ department: DEPT, files: { 'tax-classes.csv': tax, 'products.csv': products, 'prices.csv': prices.replace('55.00', '55.01'), 'barcodes.csv': barcodes } });
    expect(changed.digest).not.toBe(staged().digest);
  });

  it('the exception list exports as a CSV the acceptor reads, one quarantined row per line', () => {
    const csv = sliceExceptionsCsv(staged());
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('file,line,source_key,column,code,reason,disposition');
    expect(lines).toHaveLength(staged().exceptions.length + 1);
    expect(csv).toMatch(/products.csv,4,R-003,category,outside_the_department,/);
  });
});

describe('the one door — nothing applies until a named person accepts THIS list', () => {
  const s = staged();
  const acceptance = (over: Partial<SliceAcceptance> = {}): SliceAcceptance => ({ sliceDigest: s.digest, acceptedBy: 'u-owner', acceptedAt: '2026-10-19T10:00:00.000Z', statement: 'read every quarantined row; they stay behind', quarantined: s.exceptions.length, ...over });

  it('shut with no acceptance, with a nameless one, and with one over a different list', () => {
    expect(sliceApplyGate(s, undefined)).toMatchObject({ open: false, refusedBecause: 'not_accepted' });
    expect(sliceApplyGate(s, acceptance({ acceptedBy: ' ' }))).toMatchObject({ open: false, refusedBecause: 'accepted_by_nobody' });
    expect(sliceApplyGate(s, acceptance({ sliceDigest: 'other' }))).toMatchObject({ open: false, refusedBecause: 'accepted_a_different_list' });
  });

  it('shut on header problems and when nothing staged — open only for the accepted list', () => {
    const empty = stageSlice({ department: DEPT, files: { 'tax-classes.csv': tax, 'products.csv': products.split('\n')[0]!, 'prices.csv': prices } });
    expect(sliceApplyGate(empty, acceptance({ sliceDigest: empty.digest }))).toMatchObject({ open: false, refusedBecause: 'nothing_staged' });
    expect(sliceApplyGate({ ...s, headerProblems: ['x'] }, acceptance())).toMatchObject({ open: false, refusedBecause: 'header_problems' });
    expect(sliceApplyGate(s, acceptance())).toMatchObject({ open: true });
  });

  it('an empty exception list still needs a named acceptance', () => {
    const clean = stageSlice({ department: DEPT, files: { 'tax-classes.csv': tax, 'products.csv': products.split('\n').slice(0, 2).join('\n'), 'prices.csv': 'item_code,mrp,selling_price,cost_price\nR-001,60.00,55.00,48.00' } });
    expect(clean.exceptions).toEqual([]);
    expect(sliceApplyGate(clean, undefined)).toMatchObject({ open: false, refusedBecause: 'not_accepted' });
  });
});
