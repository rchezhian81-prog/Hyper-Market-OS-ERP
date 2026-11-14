import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bpalToSlice, isGtin, inPilotDepartment, labelFactsFrom, purchaseDay, readCsv, readPurchaseReport, PILOT_CATEGORY_ID, type LabelFact, type SheetRow } from '../../packages/migration/src/bpal-slice';
import { stageSlice } from '../../packages/migration/src/slice-import';
import { readXlsxTable } from '../../scripts/lib/xlsx-read.mjs';
import { xlsx } from '../support/xlsx';

// Store PC, 6 Nov 2026 (OB-693 · OB-694 · OB-695 · OB-696 · MG-05): the old ERP (Bpal) gives the shop's item facts in three
// Excel reports — barcodes, HSN/GST with quantities sold, and purchase lines with MRP / selling / cost. The converter
// picks the packaged groceries by HSN, takes each item's newest price in the last 12 months, writes only items whose
// five label facts staff have read off the pack, and sets every other item aside WITH its reason. All data here is made up.

const SHOP = [['TEST SHOP'], ['1 Test Road, Testville']];

// Made-up items. 1001–1004 are packaged groceries; 2001 is soap (HSN 3401, outside); 1005 is ice cream (2105, out).
const EAN = [['Item Id', 'Item Name', 'EanCode'],
  ['1001', ' TEST RICE 1KG', '8901234567890'], ['1001', ' TEST RICE 1KG', '8901234567906'],
  ['1002', 'TEST DAL 500G', '8901234567913'], ['1003', 'TEST TEA 250G', '8901234567911'], // 1003: wrong check digit
  ['1004', 'TEST OIL 1L', '8901234567920'], ['1005', 'TEST ICE CREAM', '8901234567937'], ['2001', 'TEST SOAP', '8901234567944'],
  ['1006', 'TEST BISCUIT', '8901234567951'], ['1007', 'TEST COOKIE', '8901234567968']];
const HSN = [['serial_no', 'Item Id', 'Item Name', 'Hsn Code', 'Item Quantity', 'Gst %', 'Basic Amt', 'Cess Amt', 'Addl Cess Amt'],
  ['1', '1001', 'TEST RICE 1KG', '10063020', '400', '5', '1', '0', '0'],
  ['2', '1002', 'TEST DAL 500G', '07133100', '900', '5', '1', '0', '0'],
  ['3', '1003', 'TEST TEA 250G', '09023020', '50', '5', '1', '0', '0'],
  ['4', '1004', 'TEST OIL 1L', '15079010', '30', '5', '1', '0', '0'],
  ['5', '1005', 'TEST ICE CREAM', '21050000', '80', '18', '1', '0', '0'],
  ['6', '2001', 'TEST SOAP', '34011110', '70', '18', '1', '0', '0'],
  ['7', '1006', 'TEST BISCUIT', '19053100', '60', '5', '1', '0', '0'],
  ['8', '1007', 'TEST COOKIE', '19053100', '20', '18', '1', '0', '0']]; // one HSN, two rates → both set aside
// Excel day 46328 = 2026-11-02; 46000 = 2025-12-09; 45500 = 2024-07-27 (over a year before 2026-11-06).
const BUYS = [['Purc Date', 'Purc No', 'Item Id', 'Item Name', 'Qty', 'Cost', 'NetCost', 'Selling', 'MRP'],
  ['46000', '7', '1001', 'TEST RICE 1KG', '10', '60', '60.0001', '70', '80'],
  ['46328', '3', '1001', 'TEST RICE 1KG', '10', '62', '61.999999999', '72', '82'], // newest → 72 / 82 / 62.00
  ['46328', '4', '1002', 'TEST DAL 500G', '10', '50', '50', '95', '90'], // selling above MRP → set aside
  ['45500', '1', '1004', 'TEST OIL 1L', '5', '150', '150', '170', '180'], // over 12 months ago → no price
  ['46328', '5', '1006', 'TEST BISCUIT', '5', '8', '8', '9', '10'], ['46328', '5', '1007', 'TEST COOKIE', '5', '8', '8', '9', '10']];

const tableOf = (rows: readonly (readonly string[])[]): SheetRow[] => rows.slice(1).map((r) => Object.fromEntries(rows[0]!.map((h, i) => [h, (r[i] ?? '').trim()])));
const FACTS = new Map([['1001', { allergens: 'none', country_of_origin: 'India', net_quantity: '1 kg', packer: 'Test Foods, Testville', consumer_care: 'Test Foods 1800 000 000' }]]);
const run = (labelFacts?: ReadonlyMap<string, Readonly<Partial<Record<LabelFact, string>>>>, already?: Set<string>) => bpalToSlice({
  eanRows: tableOf(EAN), hsnRows: tableOf(HSN), purchaseRows: tableOf(BUYS), ratesFrom: '2026-11-06', today: '2026-11-06',
  ...(labelFacts === undefined ? {} : { labelFacts }), ...(already === undefined ? {} : { alreadyLoaded: already }),
});
const reasonOf = (out: ReturnType<typeof run>, id: string): string => out.setAside.find((s) => s.itemId === id)?.reason ?? '';

describe('the old ERP\'s reports become the pilot department\'s slice — nothing guessed, every item accounted for', () => {
  it('OB-694: the department is packaged food and beverages by HSN; ice cream (2105) and soap stay out', () => {
    expect(inPilotDepartment('10063020')).toBe(true);
    expect(inPilotDepartment('0402')).toBe(true);
    expect(inPilotDepartment('21050000')).toBe(false);
    expect(inPilotDepartment('34011110')).toBe(false);
    expect(inPilotDepartment('0401')).toBe(false);
    expect(inPilotDepartment('0026')).toBe(false);
    const out = run();
    const ids = new Set([...readCsv(out.labelFactsSheet).map((r) => r['item_code']), ...out.setAside.map((s) => s.itemId)]);
    expect([...ids].sort()).toEqual(['1001', '1002', '1003', '1004', '1006', '1007']);
  });

  it('a barcode with a wrong check digit, a selling price above MRP, no purchase in 12 months and one HSN at two rates are each set aside with the reason', () => {
    expect(isGtin('8901234567890')).toBe(true);
    expect(isGtin('8901234567911')).toBe(false);
    const out = run();
    expect(reasonOf(out, '1003')).toContain('no barcode with a right check digit');
    expect(reasonOf(out, '1002')).toContain('above the MRP');
    expect(reasonOf(out, '1004')).toContain('no purchase in the 12 months');
    expect(reasonOf(out, '1006')).toContain('HSN 19053100 has items at');
    expect(reasonOf(out, '1007')).toContain('HSN 19053100 has items at');
    expect(readCsv(out.hsnToCheckCsv).map((r) => [r['hsn_code'], r['rate_percent'], r['items']])).toEqual([['19053100', '5', '1'], ['19053100', '18', '1']]);
    expect(readCsv(out.setAsideCsv).length).toBe(out.setAside.length);
  });

  it('OB-733 (replacing OB-696): with no label facts the item is still written — its facts BLANK, never "none" — and listed in the sheet as not all read', () => {
    const out = run();
    expect(out.counts).toMatchObject({ ready: 1, factsStillToRead: 1 });
    expect(readCsv(out.files['products.csv'])).toEqual([{ item_code: '1001', description: 'TEST RICE 1KG', uom: 'pcs', category: PILOT_CATEGORY_ID, hsn_code: '10063020', status: 'active',
      allergens: '', country_of_origin: '', net_quantity: '', packer: '', consumer_care: '' }]);
    const sheet = readCsv(out.labelFactsSheet);
    expect(sheet.map((r) => [r['item_code'], r['all_facts_read']])).toEqual([['1001', 'no']]);
    expect(sheet[0]!['barcode']).toBe('8901234567890');
    // The real slice importer stages it with no exception, its facts marked to follow and listed.
    const staged = stageSlice({ department: { categoryId: PILOT_CATEGORY_ID, name: 'Packaged groceries', regulated: ['food', 'packed'] }, files: out.files });
    expect(staged.exceptions).toEqual([]);
    expect(staged.bundle.products.map((p) => [p.productId, p.labelFactsFollow, p.safety?.allergens])).toEqual([['1001', true, undefined]]);
    expect(staged.factsToRead.map((f) => [f.itemId, f.facts.length])).toEqual([['1001', 5]]);
  });

  it('OB-733: some facts read, the rest still to read — the read ones are written, the item is counted as still to read', () => {
    const out = run(new Map([['1001', { allergens: 'none', country_of_origin: 'India' }]]));
    expect(out.counts).toMatchObject({ ready: 1, factsStillToRead: 1 });
    expect(readCsv(out.files['products.csv'])[0]).toMatchObject({ allergens: 'none', country_of_origin: 'India', net_quantity: '', packer: '', consumer_care: '' });
    const staged = stageSlice({ department: { categoryId: PILOT_CATEGORY_ID, name: 'Packaged groceries', regulated: ['food', 'packed'] }, files: out.files });
    expect(staged.bundle.products[0]!.safety?.allergens).toEqual([]); // "none" read off the pack is the declaration "none"
    expect(staged.factsToRead[0]!.facts).toEqual(['net_quantity', 'packer', 'consumer_care']);
  });

  it('OB-695 + the five facts filled: the item is written with its NEWEST price, both barcodes, its tax class from the day the rates were read', () => {
    const out = run(FACTS);
    expect(out.counts).toMatchObject({ ready: 1, factsStillToRead: 0 });
    expect(readCsv(out.files['products.csv'])).toEqual([{ item_code: '1001', description: 'TEST RICE 1KG', uom: 'pcs', category: PILOT_CATEGORY_ID, hsn_code: '10063020', status: 'active',
      allergens: 'none', country_of_origin: 'India', net_quantity: '1 kg', packer: 'Test Foods, Testville', consumer_care: 'Test Foods 1800 000 000' }]);
    expect(readCsv(out.files['prices.csv'])).toEqual([{ item_code: '1001', mrp: '82.00', selling_price: '72.00', cost_price: '62.00' }]);
    expect(readCsv(out.files['barcodes.csv']).map((r) => r['barcode'])).toEqual(['8901234567890', '8901234567906']);
    expect(readCsv(out.files['tax-classes.csv'])).toEqual([{ hsn_code: '10063020', effective_from: '2026-11-06', rate_percent: '5' }]);
    // The sheet keeps the filled facts (marked all read), so the same file can be filled and given back again.
    expect(readCsv(out.labelFactsSheet)[0]).toMatchObject({ item_code: '1001', allergens: 'none', all_facts_read: 'yes' });
    expect(labelFactsFrom(readCsv(out.labelFactsSheet)).get('1001')?.packer).toBe('Test Foods, Testville');
  });

  it('the files it writes are what the real slice importer stages: the ready item stages whole, with no exception', () => {
    const out = run(FACTS);
    const staged = stageSlice({ department: { categoryId: PILOT_CATEGORY_ID, name: 'Packaged groceries', regulated: ['food', 'packed'] }, files: out.files });
    expect(staged.headerProblems).toEqual([]);
    expect(staged.exceptions).toEqual([]);
    expect(staged.bundle.products.map((p) => [p.productId, p.priceMinor, p.mrpMinor, p.barcodes?.length])).toEqual([['1001', 7200, 8200, 2]]);
    expect(staged.bundle.products[0]!.labelFactsFollow).toBeUndefined(); // all five read: the full rule, nothing to follow
    expect(staged.factsToRead).toEqual([]);
  });

  it('an item already loaded by an earlier slice is not written again', () => {
    const out = run(FACTS, new Set(['1001']));
    expect(out.counts.ready).toBe(0);
    expect(out.counts.alreadyLoaded).toBe(1);
  });

  it('an Excel day number, dd/mm/yyyy and yyyy-mm-dd are all read as the purchase day', () => {
    expect(purchaseDay('46328')).toBe('2026-11-02');
    expect(purchaseDay('02/11/2026')).toBe('2026-11-02');
    expect(purchaseDay('2026-11-02')).toBe('2026-11-02');
    expect(purchaseDay('yesterday')).toBeUndefined();
    // The 12-month report (store PC, 7 Nov 2026) writes a time after the date, or the month as a word.
    expect(purchaseDay('07/11/2026 13:27')).toBe('2026-11-07');
    expect(purchaseDay('7-11-2026 1:27:05 PM')).toBe('2026-11-07');
    expect(purchaseDay('07-Nov-2026')).toBe('2026-11-07');
    expect(purchaseDay('2026-11-07 13:27:00')).toBe('2026-11-07');
    expect(purchaseDay('46333.5625')).toBe('2026-11-07');
    expect(purchaseDay('31/02/2026')).toBeUndefined(); // no such day: never rolled over to March
  });

  it('P-08: a purchase report whose date or price columns cannot be read is named, with its own columns — never "no purchase" for every item', () => {
    const ok = readPurchaseReport(tableOf(BUYS));
    expect(ok.problems).toEqual([]);
    expect([ok.rows, ok.datedRows, ok.oldest, ok.newest]).toEqual([6, 6, '2024-07-27', '2026-11-02']);
    // An invoice-style report: its own names for the date and prices are read the same.
    const invoice = readPurchaseReport(tableOf([['Inv Date', 'Inv No', 'Item Id', 'MRP', 'Sales Rate', 'Purchase Rate'], ['07/11/2026 13:27', '9', '1001', '82', '72', '62']]));
    expect(invoice.problems).toEqual([]);
    const noPrices = readPurchaseReport(tableOf([['Purc Date', 'Item Id', 'Qty'], ['46328', '1001', '3']]));
    expect(noPrices.problems.join(' | ')).toContain('no column for the MRP');
    expect(noPrices.problems.join(' | ')).toContain('its columns are: Purc Date, Item Id, Qty');
    const badDates = readPurchaseReport(tableOf([['Purc Date', 'Item Id', 'MRP', 'Selling', 'Cost'], ['last week', '1001', '82', '72', '62']]));
    expect(badDates.problems.join(' | ')).toContain('no purchase date could be read (the first ones read "last week")');
  });

  it('the sheets a person opens in Excel carry the UTF-8 mark, so "—" and Tamil names read right (not "â€”")', () => {
    const out = run();
    for (const sheet of [out.labelFactsSheet, out.setAsideCsv, out.hsnToCheckCsv]) expect(sheet.charCodeAt(0)).toBe(0xfeff);
    for (const f of Object.values(out.files)) expect(f.charCodeAt(0)).not.toBe(0xfeff); // the slice files stay plain
  });
});

describe('the command on the store PC: three .xlsx reports in, the slice folder out', () => {
  beforeAll(() => {
    const b = spawnSync(process.execPath, ['scripts/build-service.mjs', 'tools', '--quiet'], { encoding: 'utf8' });
    expect(b.status, b.stderr).toBe(0);
  }, 120_000);

  const folder = () => {
    const dir = mkdtempSync(join(tmpdir(), 'bpal-'));
    writeFileSync(join(dir, 'EANCODE.xlsx'), xlsx([...SHOP, ...EAN]));
    writeFileSync(join(dir, 'HSN.xlsx'), xlsx([[''], ...SHOP, ...HSN]));
    writeFileSync(join(dir, 'BUYS.xlsx'), xlsx([...SHOP, ...BUYS]));
    return dir;
  };
  const cmd = (dir: string, extra: string[] = []) => spawnSync(process.execPath, ['scripts/dist/bpal-to-slice.js', '--ean', join(dir, 'EANCODE.xlsx'), '--hsn', join(dir, 'HSN.xlsx'),
    '--purchases', join(dir, 'BUYS.xlsx'), '--out', join(dir, 'slice'), '--rates-from', '2026-11-06', '--today', '2026-11-06',
    '--tenant', '00000000-0000-4000-8000-000000000001', '--store', 'TEST-STORE', '--operator', 'owner-01', ...extra], { encoding: 'utf8' });

  it('reads the reports under their shop-name lines, writes every file and slice.json, then takes the filled sheet back', () => {
    const dir = folder();
    expect(readXlsxTable(readFileSync(join(dir, 'HSN.xlsx')), 'Item Id')[0]!['Hsn Code']).toBe('10063020');
    const first = cmd(dir);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toContain('Ready to load (barcode, HSN and price): 1 item(s), 2 barcode(s), 1 tax class(es).');
    expect(first.stdout).toContain('Of those, label facts still to read off the pack: 1 item(s)');
    for (const f of ['tax-classes.csv', 'products.csv', 'prices.csv', 'barcodes.csv', 'label-facts.csv', 'bpal-set-aside.csv', 'hsn-to-check.csv', 'slice.json']) expect(existsSync(join(dir, 'slice', f)), f).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'slice', 'slice.json'), 'utf8'))).toMatchObject({ storeId: 'TEST-STORE', operator: 'owner-01', department: { categoryId: PILOT_CATEGORY_ID, regulated: ['food', 'packed'] }, files: {} });

    // Staff fill the sheet (as Excel saves it) and give it back.
    const sheet = readFileSync(join(dir, 'slice', 'label-facts.csv'), 'utf8').replace('1001,TEST RICE 1KG,8901234567890,400,,,,,,no', '1001,TEST RICE 1KG,8901234567890,400,none,India,1 kg,"Test Foods, Testville",Test Foods 1800 000 000,no');
    expect(sheet).toContain('none,India,1 kg');
    writeFileSync(join(dir, 'slice', 'label-facts.csv'), sheet);
    const second = cmd(dir, ['--label-facts', join(dir, 'slice', 'label-facts.csv')]);
    expect(second.status, second.stdout).toBe(0);
    expect(second.stdout).toContain('Ready to load (barcode, HSN and price): 1 item(s), 2 barcode(s), 1 tax class(es).');
    expect(second.stdout).toContain('Of those, label facts still to read off the pack: 0 item(s)');
    expect(second.stdout).toContain('slice.json was already there and was kept as it is.');
  });

  it('a purchase report with no price columns is refused before anything is written, naming its columns', () => {
    const dir = folder();
    writeFileSync(join(dir, 'BUYS.xlsx'), xlsx([...SHOP, ['Purc Date', 'Item Id', 'Qty'], ['46328', '1001', '3']]));
    const r = cmd(dir);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('cannot give the prices. Nothing was written');
    expect(r.stdout).toContain('its columns are: Purc Date, Item Id, Qty');
    expect(existsSync(join(dir, 'slice', 'products.csv'))).toBe(false);
  });

  it('a sealed folder is never written into (hard rule #6), and a file that is not an .xlsx is refused by name', () => {
    const dir = folder();
    expect(cmd(dir).status).toBe(0);
    const m = JSON.parse(readFileSync(join(dir, 'slice', 'slice.json'), 'utf8'));
    writeFileSync(join(dir, 'slice', 'slice.json'), JSON.stringify({ ...m, files: { 'products.csv': { seal: { digest: 'x', rowCount: 1 } } } }));
    const before = readFileSync(join(dir, 'slice', 'products.csv'), 'utf8');
    const sealed = cmd(dir);
    expect(sealed.status).toBe(2);
    expect(sealed.stdout).toContain('is already sealed');
    expect(readFileSync(join(dir, 'slice', 'products.csv'), 'utf8')).toBe(before);

    writeFileSync(join(dir, 'HSN.xlsx'), '<html><table><tr><td>Item Id</td></tr></table></html>');
    rmSync(join(dir, 'slice'), { recursive: true });
    const notXlsx = cmd(dir);
    expect(notXlsx.status).toBe(2);
    expect(notXlsx.stdout).toContain('this is not an .xlsx file');
  });
});
