import { describe, it, expect } from 'vitest';
import {
  bpalToSlice, departmentOf, labelFactsFrom, labelFactsNeeded, readCsv, setUpElsewhere, STORE_DEPARTMENTS, storeDepartment, type SheetRow,
} from '../../packages/migration/src/bpal-slice';
import {
  analyseOldSystem, importSummary, isReady, resolveImport, sliceDepartmentsFor, sliceFilesFor, validateFix, type ImportFix,
} from '../../packages/migration/src/old-system-import';
import { stageSlice } from '../../packages/migration/src/slice-import';
import { readSliceManifest } from '../../packages/migration/src/slice-command';
import { LABEL_FACTS_MAY_FOLLOW_IN } from '../../packages/product/src/product';

// OB-800 (owner, 15 Nov 2026): NO pilot department — the whole store, every department, is loaded from the old ERP (Bpal)
// and run in parallel with it. Every per-item check stays (barcode check digit, HSN and GST slab, two-rate HSN to Finance —
// OB-697, MRP ceiling, the exception list); loose goods (kg or by count, no barcode) and non-food packed goods load in
// their own departments; the OB-738 allowance (label facts may follow, sell at the till only) stays packaged groceries'
// ONLY — every other department keeps the full rule until the owner decides otherwise. Made-up data only (hard rule #7).

const table = (rows: readonly (readonly string[])[]): SheetRow[] => rows.slice(1).map((r) => Object.fromEntries(rows[0]!.map((h, i) => [h, r[i] ?? ''])));
const EAN = table([['Item Id', 'Item Name', 'EanCode'],
  ['21', 'TEST RICE 5KG', '8901234567890'],
  ['22', 'TEST BANANA LOOSE', '123'], // a short code where a barcode should be — the scale's PLU, perhaps
  ['24', 'TEST SHAMPOO 180ML', '8901234567906'],
  ['25', 'TEST MILK 500ML', '8901234567913'],
  ['26', 'TEST CIGARETTES 10', '8901234567920'],
  ['27', 'TEST DETERGENT 1KG', '8901234567937'],
  ['28', 'TEST BROOM', '8901234567944']]); // 28 is in no HSN report line
const HSN = table([['Item Id', 'Item Name', 'Hsn Code', 'Item Quantity', 'Gst %', 'Cess Amt', 'Addl Cess Amt'],
  ['21', 'TEST RICE 5KG', '10063020', '50', '5', '0', '0'],
  ['22', 'TEST BANANA LOOSE', '08039010', '412.75', '0', '0', '0'], // a part quantity: sold by weight, perhaps
  ['23', 'TEST COCONUT', '08011910', '300', '0', '0', '0'], // no barcode at all
  ['24', 'TEST SHAMPOO 180ML', '33051090', '80', '18', '0', '0'],
  ['25', 'TEST MILK 500ML', '04012000', '900', '0', '0', '0'],
  ['26', 'TEST CIGARETTES 10', '24022090', '40', '28', '0', '0'],
  ['27', 'TEST DETERGENT 1KG', '34022010', '60', '18', '0', '0']]);
const BUYS = table([['Purc Date', 'Purc No', 'Item Id', 'Cost', 'NetCost', 'Selling', 'MRP'],
  ['01/11/2026', '1', '21', '300', '300', '340', '360'], ['01/11/2026', '1', '22', '30', '30', '40', '40'], ['01/11/2026', '1', '23', '20', '20', '25', '25'],
  ['01/11/2026', '1', '24', '90', '90', '110', '120'], ['01/11/2026', '1', '25', '25', '25', '28', '28'], ['01/11/2026', '1', '26', '80', '80', '95', '100'],
  ['01/11/2026', '1', '27', '100', '100', '130', '125'], // selling above MRP
  ['01/11/2026', '1', '28', '40', '40', '60', '70']]);
const TODAY = '2026-11-15';
const items = () => analyseOldSystem({ eanRows: EAN, hsnRows: HSN, purchaseRows: BUYS, today: TODAY }).items;
let clock = 0;
const fix = (itemId: string, kind: ImportFix['kind'], value: Record<string, unknown>, by = 'store-manager-01'): ImportFix => ({ importId: 'imp-800', itemId, kind, value, reason: 'checked in the shop', by, at: `2026-11-15T10:${String(Math.floor(clock / 60)).padStart(2, '0')}:${String(clock++ % 60).padStart(2, '0')}.000Z` });
const byId = (r: ReturnType<typeof resolveImport>, id: string) => r.find((x) => x.itemId === id)!;
const kinds = (r: ReturnType<typeof resolveImport>, id: string) => byId(r, id).gaps.map((g) => g.kind).sort();
const FOOD_LOOSE = { allergens: 'none', country_of_origin: 'India' };
const PACKED = { country_of_origin: 'India', net_quantity: '180 ml', packer: 'Test Care, Chennai', consumer_care: '1800 111 111' };

describe('OB-800: the department table — from the HSN and how an item is sold, never a guess per item', () => {
  it('packaged groceries keep OB-694\'s HSN rule; dairy, ice cream, personal care and household each have their own department', () => {
    expect(departmentOf('10063020')?.categoryId).toBe('packaged-groceries');
    expect(LABEL_FACTS_MAY_FOLLOW_IN).toContain(departmentOf('10063020')?.categoryId);
    expect(departmentOf('04012000')?.categoryId).toBe('other-packaged-foods');
    expect(departmentOf('21050000')?.categoryId).toBe('other-packaged-foods');
    expect(departmentOf('33051090')?.categoryId).toBe('personal-care');
    expect(departmentOf('34011110')?.categoryId).toBe('personal-care');
    expect(departmentOf('34022010')?.categoryId).toBe('household-general');
    expect(departmentOf('08039010', 'loose_kg')?.categoryId).toBe('loose-foods');
    expect(departmentOf('10063020', 'loose_count')?.categoryId).toBe('loose-foods'); // loose rice is not a packaged grocery
    expect(departmentOf('96032100', 'loose_count')?.categoryId).toBe('loose-general');
    expect(departmentOf('96032100')?.categoryId).toBe('personal-care'); // toothbrushes
    expect(departmentOf('96031000')?.categoryId).toBe('household-general'); // brooms
    expect(departmentOf('3401111')).toBeUndefined();
    expect(STORE_DEPARTMENTS.map((d) => d.categoryId)).toEqual(['packaged-groceries', 'other-packaged-foods', 'personal-care', 'household-general', 'loose-foods', 'loose-general']);
  });

  it('tobacco, medicines and gold are never loaded from the old ERP — their legal facts are not in it', () => {
    expect(setUpElsewhere('24022090')).toContain('minimum age and pack size');
    expect(setUpElsewhere('30049099')).toContain('medicines');
    expect(setUpElsewhere('71131910')).toContain('HUID');
    expect(setUpElsewhere('10063020')).toBeUndefined();
  });

  it('the label facts each department needs are the product engine\'s own rule (food: allergens, origin; packed: net quantity, packer, consumer care, origin)', () => {
    expect(labelFactsNeeded(storeDepartment('loose-foods')!)).toEqual(['allergens', 'country_of_origin']);
    expect(labelFactsNeeded(storeDepartment('personal-care')!)).toEqual(['country_of_origin', 'net_quantity', 'packer', 'consumer_care']);
    expect(labelFactsNeeded(storeDepartment('other-packaged-foods')!)).toHaveLength(5);
    expect(labelFactsNeeded(storeDepartment('loose-general')!)).toEqual([]);
  });
});

describe('OB-800: the Import page\'s rules take every department, every item kind', () => {
  it('reads every item any report names — one only in the barcode report is kept, with a tax gap for Finance, never dropped', () => {
    const its = items();
    expect(its.map((i) => i.itemId).sort()).toEqual(['21', '22', '23', '24', '25', '26', '27', '28']);
    const r = resolveImport(its, []);
    expect(byId(r, '28').gaps.find((g) => g.kind === 'tax')!.why).toContain('the HSN report has no line for it');
    expect(analyseOldSystem({ eanRows: EAN, hsnRows: HSN, purchaseRows: BUYS, today: TODAY }).counts).toMatchObject({ hsnItems: 7, items: 8 });
  });

  it('with no fix: each item is in its department; every PACKED good loads before its label facts (OB-738 · OB-811 B)', () => {
    const r = resolveImport(items(), []);
    // The rice, the shampoo and the milk: facts still to read, not a gap — each listed with the facts ITS department needs.
    expect(r.filter(isReady).map((x) => x.itemId)).toEqual(['25', '24', '21']);
    expect(byId(r, '21').factsToRead).toEqual(['allergens', 'country_of_origin', 'net_quantity', 'packer', 'consumer_care']);
    expect(byId(r, '25').factsToRead).toEqual(['allergens', 'country_of_origin', 'net_quantity', 'packer', 'consumer_care']);
    expect(byId(r, '24').factsToRead).toEqual(['country_of_origin', 'net_quantity', 'packer', 'consumer_care']); // a shampoo is never asked for allergens
    expect(kinds(r, '24')).toEqual([]);
    expect(kinds(r, '25')).toEqual([]);
    expect(kinds(r, '26')).toEqual(['setup']); // cigarettes
    expect(kinds(r, '27')).toEqual(['price']); // detergent: its facts may follow, but selling above MRP is still refused
    expect(byId(r, '27').gaps.find((g) => g.kind === 'price')!.why).toContain('above its MRP');
    expect([byId(r, '24').department, byId(r, '25').department, byId(r, '27').department]).toEqual(['personal-care', 'other-packaged-foods', 'household-general']);
    // The banana and the coconut have no pack barcode: a gap — with the hint, never a decision.
    const banana = byId(r, '22').gaps.find((g) => g.kind === 'barcode')!.why;
    expect(banana).toContain('mark it "Sold loose"');
    expect(banana).toContain('sold 412.75 of it — a part quantity');
    expect(banana).toContain('123 may be the scale\'s PLU code');
    expect(byId(r, '22').soldAs).toBe('pack');
    expect(byId(r, '23').gaps.find((g) => g.kind === 'barcode')!.why).toContain('the old ERP has no barcode for it');
    expect(importSummary(r).gaps).toEqual({ barcode: 2, tax: 1, price: 1, label: 0, setup: 1 });
    // Rice, shampoo, milk and detergent — and the banana and coconut, which also wait on their barcode — listed until read.
    expect(r.filter((x) => x.factsToRead.length > 0).map((x) => x.itemId).sort()).toEqual(['21', '22', '23', '24', '25', '27']);
    expect(importSummary(r).factsToRead).toBe(6);
    expect(importSummary(r).byDepartment).toMatchObject({ 'packaged-groceries': { ready: 1, loaded: 0, waiting: 2 }, 'personal-care': { ready: 1, waiting: 0 }, 'other-packaged-foods': { ready: 1, waiting: 0 }, 'household-general': { ready: 0, waiting: 2 }, 'not-known-yet': { waiting: 1 } });
  });

  it('sold loose: marked by a person (kg with the scale\'s PLU, or by count) — then in loose foods, in kg or pieces, needing only a food\'s facts', () => {
    const fixes = [
      fix('22', 'loose', { soldBy: 'kg', plu: '00123' }), fix('22', 'label', FOOD_LOOSE),
      fix('23', 'loose', { soldBy: 'count' }), fix('23', 'label', FOOD_LOOSE),
    ];
    const r = resolveImport(items(), fixes);
    expect([byId(r, '22').soldAs, byId(r, '22').department, byId(r, '22').barcodes, kinds(r, '22')]).toEqual(['loose_kg', 'loose-foods', ['00123'], []]);
    expect([byId(r, '23').soldAs, byId(r, '23').department, byId(r, '23').barcodes, kinds(r, '23')]).toEqual(['loose_count', 'loose-foods', [], []]);
    expect(byId(r, '22').fixedBy.loose?.by).toBe('store-manager-01');
    expect(importSummary(r).loose).toBe(2);
    // Without its facts, a loose food waits — the allowance is packaged groceries' only.
    const noFacts = resolveImport(items(), [fix('22', 'loose', { soldBy: 'kg' })]);
    expect(kinds(noFacts, '22')).toEqual(['label']);
    expect(byId(noFacts, '22').gaps[0]!.why).toContain('allergens, country of origin');
    // "Sold as a pack after all" undoes it: the barcode gap is back (the latest loose fix applies; both are kept).
    const undone = resolveImport(items(), [...fixes, fix('22', 'loose', { soldBy: 'pack' })]);
    expect([byId(undone, '22').soldAs, byId(undone, '22').department, kinds(undone, '22')]).toEqual(['pack', 'packaged-groceries', ['barcode']]);
  });

  it('two loose items cannot share one PLU code; a fix that says something unreadable is refused by name', () => {
    const r = resolveImport(items(), [fix('22', 'loose', { soldBy: 'kg', plu: '00123' }), fix('23', 'loose', { soldBy: 'count', plu: '00123' })]);
    expect(byId(r, '23').gaps.find((g) => g.kind === 'barcode')!.why).toContain('PLU code 00123 is also on item 22');
    expect(validateFix('loose', { soldBy: 'litre' }, 'checked').join(' ')).toContain('say how it is sold');
    expect(validateFix('loose', { soldBy: 'kg', plu: '12' }, 'checked').join(' ')).toContain('3 to 6 digits');
    expect(validateFix('loose', { soldBy: 'pack', plu: '00123' }, 'checked').join(' ')).toContain('a PLU code is for an item sold loose');
    expect(validateFix('loose', { soldBy: 'kg', price: '10' }, 'checked').join(' ')).toContain('"price" is not part of "sold loose"');
    expect(validateFix('loose', { soldBy: 'count' }, 'checked')).toEqual([]);
    expect(validateFix('loose', { soldBy: 'kg' }, '')).toEqual(['say why, in a few words (for example "read off the pack")']);
  });

  it('every other check stays: Finance settles an item with no HSN line, and a two-rate HSN still goes to Finance (OB-697)', () => {
    const settled = resolveImport(items(), [fix('28', 'tax', { hsn: '96031000', gstPercent: 12 }, 'accountant-01')]);
    expect([byId(settled, '28').department, kinds(settled, '28'), byId(settled, '28').factsToRead]).toEqual(['household-general', [], ['country_of_origin', 'net_quantity', 'packer', 'consumer_care']]);
    const twoRates = resolveImport(items(), [fix('28', 'tax', { hsn: '34022010', gstPercent: 5 }, 'accountant-01')]);
    expect(byId(twoRates, '28').gaps.find((g) => g.kind === 'tax')!.why).toContain('HSN 34022010 carries 5% and 18% across items');
    expect(byId(twoRates, '27').gaps.find((g) => g.kind === 'tax')!.why).toContain('one HSN, one rate');
  });

  it('the ready items of several departments become the four files, and the REAL slice importer stages them with no exception', () => {
    const fixes = [
      fix('22', 'loose', { soldBy: 'kg', plu: '00123' }), fix('22', 'label', FOOD_LOOSE),
      fix('23', 'loose', { soldBy: 'count' }), fix('23', 'label', FOOD_LOOSE),
      fix('24', 'label', PACKED),
      fix('25', 'label', { allergens: 'milk', country_of_origin: 'India', net_quantity: '500 ml', packer: 'Test Dairy, Erode', consumer_care: 'care@testdairy.example' }),
    ];
    const ready = resolveImport(items(), fixes).filter(isReady);
    expect(ready.map((x) => x.itemId).sort()).toEqual(['21', '22', '23', '24', '25']);
    const files = sliceFilesFor(ready, TODAY);
    const products = readCsv(files['products.csv']);
    expect(products.map((p) => [p['item_code'], p['uom'], p['category']]).sort()).toEqual([
      ['21', 'pcs', 'packaged-groceries'], ['22', 'kg', 'loose-foods'], ['23', 'pcs', 'loose-foods'], ['24', 'pcs', 'personal-care'], ['25', 'pcs', 'other-packaged-foods']]);
    expect(readCsv(files['barcodes.csv']).find((b) => b['item_code'] === '22')).toEqual({ item_code: '22', barcode: '00123', kind: 'internal' });
    const departments = sliceDepartmentsFor(ready);
    expect(departments.map((d) => d.categoryId)).toEqual(['packaged-groceries', 'other-packaged-foods', 'personal-care', 'loose-foods']);
    const staged = stageSlice({ departments, files });
    expect(staged.headerProblems).toEqual([]);
    expect(staged.exceptions).toEqual([]);
    expect(staged.bundle.categories.map((c) => c.categoryId)).toEqual(['packaged-groceries', 'other-packaged-foods', 'personal-care', 'loose-foods']);
    const p = (id: string) => staged.bundle.products.find((x) => x.productId === id)!;
    expect([p('22').baseUom, p('22').primaryCategoryId, p('22').barcodes]).toEqual(['kg', 'loose-foods', [{ code: '00123', kind: 'internal' }]]);
    expect(p('23').barcodes).toEqual([]);
    // OB-738's mark only on the packaged grocery; the others carry their facts.
    expect(staged.bundle.products.filter((x) => x.labelFactsFollow === true).map((x) => x.productId)).toEqual(['21']);
    expect(staged.factsToRead.map((f) => f.itemId)).toEqual(['21']);
    expect(p('24').safety).toMatchObject({ countryOfOrigin: 'India', netQuantity: '180 ml', consumerCareContact: '1800 111 111' });
  });

  it('a loose food still waits for its allergens and origin (OB-811 B leaves it out); belt and braces: one that reached the loader blank is quarantined in words', () => {
    const noFacts = resolveImport(items(), [fix('22', 'loose', { soldBy: 'kg', plu: '00123' })]);
    expect([byId(noFacts, '22').department, kinds(noFacts, '22'), byId(noFacts, '22').factsToRead]).toEqual(['loose-foods', ['label'], []]);
    expect(byId(noFacts, '22').gaps[0]!.why).toContain('only packed goods may load before their label facts are read (OB-738 · OB-811 B)');
    const ready = resolveImport(items(), [fix('22', 'loose', { soldBy: 'kg', plu: '00123' }), fix('22', 'label', { allergens: 'none', country_of_origin: 'India' })]).filter(isReady);
    const files = sliceFilesFor(ready, TODAY);
    const blanked = { ...files, 'products.csv': files['products.csv'].replace(/^(22,.*),India,/m, '$1,,') };
    expect(blanked['products.csv']).not.toBe(files['products.csv']);
    const staged = stageSlice({ departments: sliceDepartmentsFor(ready), files: blanked });
    expect(staged.exceptions.map((e) => [e.file, e.sourceKey, e.code])).toEqual([['products.csv', '22', 'product_rules'], ['prices.csv', '22', 'depends_on_a_quarantined_row'], ['barcodes.csv', '00123', 'depends_on_a_quarantined_row']]);
    expect(staged.exceptions[0]!.reason).toContain('country of origin');
    // A packed good with a blank fact is staged with its mark, never quarantined (OB-811 B).
    expect(staged.bundle.products.filter((x) => x.labelFactsFollow === true).map((x) => x.productId).sort()).toEqual(['21', '24', '25']);
    // A product row naming a department the load does not list is quarantined, said, never loaded.
    const outside = stageSlice({ departments: [storeDepartment('personal-care')!].map((d) => ({ ...d, regulated: [...d.regulated] })), files });
    expect(outside.exceptions.find((e) => e.sourceKey === '21')).toMatchObject({ code: 'outside_the_department' });
    expect(outside.exceptions.find((e) => e.sourceKey === '21')!.reason).toContain('is not one of the departments this load names (personal-care)');
    // The acceptance binds the departments too: another list, another digest.
    const two = stageSlice({ departments: sliceDepartmentsFor(ready), files });
    expect(two.digest).not.toBe(stageSlice({ departments: [...sliceDepartmentsFor(ready), storeDepartment('loose-general')!], files }).digest);
    expect(stageSlice({ files }).headerProblems.join(' ')).toContain('exactly one of the two');
  });

  it('slice.json names one department (OB-241) or several (OB-800) — never both, never none', () => {
    const base = { loadId: 'L-1', tenantId: 't', operator: 'owner-01', storeId: 'S', files: {} };
    expect(readSliceManifest({ ...base, departments: [{ categoryId: 'personal-care', name: 'Personal care', regulated: ['packed'] }] }).problems).toEqual([]);
    expect(readSliceManifest({ ...base, department: { categoryId: 'packaged-groceries', name: 'Packaged groceries' } }).problems).toEqual([]);
    expect(readSliceManifest({ ...base, department: { categoryId: 'a', name: 'A' }, departments: [{ categoryId: 'b', name: 'B' }] }).problems.join(' ')).toContain('not both');
    expect(readSliceManifest(base).problems.join(' ')).toContain('"departments", a list of them');
    expect(readSliceManifest({ ...base, departments: [] }).problems.join(' ')).toContain('at least one');
    expect(readSliceManifest({ ...base, departments: [{ categoryId: 'x', name: 'X', regulated: ['spicy'] }] }).problems.join(' ')).toContain('departments[0].regulated');
  });
});

describe('OB-800: the command-line converter takes the whole store too', () => {
  it('barcoded items of every department are written, packed goods with their facts still to read (OB-811 B); loose, tobacco and no-HSN items are set aside with the reason', () => {
    const run = (facts?: ReturnType<typeof labelFactsFrom>) => bpalToSlice({ eanRows: EAN, hsnRows: HSN, purchaseRows: BUYS, ratesFrom: TODAY, today: TODAY, ...(facts === undefined ? {} : { labelFacts: facts }) });
    const first = run();
    const reason = (id: string) => first.setAside.find((s) => s.itemId === id)?.reason ?? '';
    // The rice, the shampoo and the milk load with their facts still to read; nothing is set aside for a label fact.
    expect(readCsv(first.files['products.csv']).map((p) => [p['item_code'], p['category']])).toEqual([['25', 'other-packaged-foods'], ['24', 'personal-care'], ['21', 'packaged-groceries']]);
    expect(first.setAside.filter((s) => s.reason.includes('label facts'))).toEqual([]);
    expect(reason('22')).toContain('if it is sold loose (by weight or by count), mark it so on the Import page');
    expect(reason('26')).toContain('tobacco');
    expect(reason('27')).toContain('above the MRP');
    expect(reason('28')).toContain('not in the HSN report');
    expect(first.counts).toMatchObject({ items: 8, ready: 3, factsStillToRead: 3, byDepartment: { 'packaged-groceries': 1, 'other-packaged-foods': 1, 'personal-care': 1 } });
    // The staff's sheet still lists them all, with their department, so their facts can be read and given back.
    const sheet = readCsv(first.labelFactsSheet);
    expect(sheet.map((r) => [r['item_code'], r['department'], r['all_facts_read']])).toEqual([['25', 'Dairy, chilled, frozen and other packed foods', 'no'], ['24', 'Personal care', 'no'], ['21', 'Packaged groceries', 'no']]);
    // The shampoo's four facts read: all ITS department needs — no allergens asked of a shampoo.
    const second = run(labelFactsFrom([{ item_code: '24', ...PACKED }]));
    expect(readCsv(second.labelFactsSheet).find((r) => r['item_code'] === '24')!['all_facts_read']).toBe('yes');
    expect(second.counts.factsStillToRead).toBe(2);
    const staged = stageSlice({ departments: second.departments.map((d) => ({ ...d, regulated: [...d.regulated] })), files: second.files });
    expect(staged.exceptions).toEqual([]);
    expect(staged.bundle.products.map((p) => [p.productId, p.labelFactsFollow === true])).toEqual([['25', true], ['24', false], ['21', true]]);
  });
});
