import { describe, it, expect } from 'vitest';
import {
  OLD_ERP_REPORTS, columnValuesOf, headerRowOf, judgeMapping, oldErpTemplateCsv, quantityToThousandths, readBillWiseReport, readCsv,
  readItemWiseReport, readOldErpDate, rupeesToPaise, type ColumnMapping,
} from '../../packages/migration/src/old-erp-reports';

/**
 * OB-263 (owner, 21 Oct 2026, "Item-wise + bill-wise"): the old ERP's two evening reports, saved from Excel as CSV, are read
 * only through a mapping the owner chose from the file's own header row — never by a guessed column name — and exactly:
 * a byte-order mark, commas or semicolons, quoted cells (with "" and line breaks inside), report title lines above the
 * header, a total line at the foot, Indian grouping ("1,23,456.50"), rupees with or without paise, never through a
 * floating-point number. A file with a missing mapped column, an unreadable figure or another day's date is refused whole,
 * in words. A column that is not mapped is never read into what is kept — a customer's phone number goes nowhere.
 * Synthetic data only.
 */

const DAY = '2026-10-21';
const ITEM_MAP: ColumnMapping = {
  kind: 'item_wise',
  columns: { item_code: 'Item Code', quantity: 'Qty', value: 'Net Amount', tax: 'GST Amt', sale_date: 'Bill Date' },
  dateOrder: 'dmy', valueIncludesTax: true,
};
const BILL_MAP: ColumnMapping = { kind: 'bill_wise', columns: { bill_number: 'Bill No', bill_date: 'Date', bill_total: 'Bill Amount' }, dateOrder: 'dmy' };
const BILL_LINES_MAP: ColumnMapping = { kind: 'bill_wise', columns: { bill_number: 'Bill No', bill_date: 'Date', bill_total: 'Bill Amount', item_code: 'Item', quantity: 'Qty', line_value: 'Amount' }, dateOrder: 'dmy', lineValuesIncludeTax: true };

describe('the CSV as Excel writes it', () => {
  it('drops the byte-order mark, finds a semicolon separator, reads quoted cells with "" and line breaks inside', () => {
    const r = readCsv('\uFEFFItem;"Name; with semicolon";Qty\r\nP1;"Dal ""Gold""\r\n1kg";2\r\n\r\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.table.separator).toBe(';');
    expect(r.table.records).toEqual([
      { line: 1, cells: ['Item', 'Name; with semicolon', 'Qty'] },
      { line: 2, cells: ['P1', 'Dal "Gold"\r\n1kg', '2'] },
    ]);
    expect(readCsv('a,b\n1,2\n').ok && readCsv('a,b\n1,2\n')).toMatchObject({ table: { separator: ',' } });
  });

  it('refuses a quote that never closes, an empty file and binary data, in words', () => {
    expect(readCsv('a,b\n"open,2\n')).toMatchObject({ ok: false, problem: expect.stringContaining('never closed') });
    expect(readCsv('')).toMatchObject({ ok: false, problem: 'The file is empty.' });
    expect(readCsv('PK\u0003\u0004\u0000\u0000')).toMatchObject({ ok: false, problem: expect.stringContaining('not a CSV text file') });
  });

  it('finds the header row under the report\'s title lines', () => {
    const text = 'SRE Hyper Market\nItem wise sales 21/10/2026\n\nItem Code,Item Name,Qty,Net Amount,GST Amt\nP1,Dal,1,105,5\n';
    expect(headerRowOf(text)).toEqual({ ok: true, line: 4, columns: ['Item Code', 'Item Name', 'Qty', 'Net Amount', 'GST Amt'] });
    expect(headerRowOf('only one cell\n')).toMatchObject({ ok: false });
  });
});

describe('rupees to paise, by the digits', () => {
  it.each([
    ['1,23,456.50', 12_345_650], ['123,456.50', 12_345_650], ['1234', 123_400], ['₹ 1,234.5', 123_450], ['Rs. 12', 1200],
    ['INR 0.05', 5], ['-12.50', -1250], ['(12.50)', -1250], ['₹-3', -300], ['12.500', 1250], ['.75', 75], ['0', 0], ['  1,00,000 ', 10_000_000],
    // A float would make 0.1 + 0.2 ≠ 0.3 and 4.35 * 100 = 434.99999…; the digits never do.
    ['4.35', 435], ['1,00,00,001.01', 1_000_000_101],
  ])('"%s" → %i paise', (text, paise) => { expect(rupeesToPaise(text)).toBe(paise); });

  it.each([['12,50'], ['1,2,3'], ['12.345'], ['abc'], [''], ['1.2.3'], ['12-'], ['₹'], ['1e3']])('"%s" is not a rupee amount', (text) => {
    expect(rupeesToPaise(text)).toBeUndefined();
  });

  it('quantities to thousandths: weighed goods to the gram, counts whole', () => {
    expect(quantityToThousandths('1.234')).toBe(1234);
    expect(quantityToThousandths('2')).toBe(2000);
    expect(quantityToThousandths('1,000')).toBe(1_000_000);
    expect(quantityToThousandths('-1')).toBe(-1000);
    expect(quantityToThousandths('0.0005')).toBeUndefined();
    expect(quantityToThousandths('2 kg')).toBeUndefined();
  });
});

describe('dates, in the order the mapping says — never guessed', () => {
  it('reads day first, month first and year first; names of months; a time after the date; two-figure years', () => {
    expect(readOldErpDate('21/10/2026', 'dmy')).toBe(DAY);
    expect(readOldErpDate('03/04/2026', 'dmy')).toBe('2026-04-03');
    expect(readOldErpDate('03/04/2026', 'mdy')).toBe('2026-03-04');
    expect(readOldErpDate('2026-10-21', 'ymd')).toBe(DAY);
    expect(readOldErpDate('21-Oct-2026', 'dmy')).toBe(DAY);
    expect(readOldErpDate('21 October 2026'.replace(/ /g, '-'), 'dmy')).toBe(DAY);
    expect(readOldErpDate('21.10.26 14:32', 'dmy')).toBe(DAY);
    expect(readOldErpDate('2026-10-21T09:00:00', 'ymd')).toBe(DAY);
  });
  it('refuses what is not a real date', () => {
    for (const bad of ['31/02/2026', '21/13/2026', '2026/10', 'yesterday', '']) expect(readOldErpDate(bad, 'dmy')).toBeUndefined();
  });
});

describe('the mapping: chosen from the file\'s own header row, judged before it is saved', () => {
  it('our templates are header-only files with our own column names', () => {
    expect(oldErpTemplateCsv('item_wise')).toBe('item_code,quantity,value,tax,sale_date,department\r\n');
    expect(oldErpTemplateCsv('bill_wise')).toBe('bill_number,bill_date,bill_total,item_code,quantity,line_value\r\n');
    expect(OLD_ERP_REPORTS.item_wise.fields.filter((f) => f.required).map((f) => f.key)).toEqual(['item_code', 'quantity', 'value', 'tax']);
    for (const f of [...OLD_ERP_REPORTS.item_wise.fields, ...OLD_ERP_REPORTS.bill_wise.fields]) expect(f.words.ta).not.toBe('');
  });

  it('a good mapping is kept as chosen', () => {
    expect(judgeMapping('item_wise', { columns: ITEM_MAP.columns, dateOrder: 'dmy', valueIncludesTax: true }, ['Item Code', 'Qty', 'Net Amount', 'GST Amt', 'Bill Date', 'Customer Mobile'])).toEqual({ ok: true, mapping: ITEM_MAP });
  });

  it('refuses, naming each problem: a required field not chosen, one column twice, no date order, no tax answer, half a bill line, a column the file lacks', () => {
    const r = judgeMapping('item_wise', { columns: { item_code: 'Item Code', quantity: 'Item Code', sale_date: 'Bill Date' } }, ['Item Code', 'Qty']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toEqual(expect.arrayContaining([
      'choose the column for "Sales value (₹)"', 'choose the column for "Tax (₹)"',
      expect.stringContaining('cannot be both'), expect.stringContaining('how the report writes its dates'),
      expect.stringContaining('already includes the tax'), 'the file has no column "Bill Date" (chosen for "sale_date")',
    ]));
    const half = judgeMapping('bill_wise', { columns: { ...BILL_MAP.columns, item_code: 'Item' }, dateOrder: 'dmy' });
    expect(half).toMatchObject({ ok: false, problems: [expect.stringContaining('both the item code and the line value')] });
    expect(judgeMapping('bill_wise', { columns: { ...BILL_MAP.columns, nonsense: 'X' }, dateOrder: 'dmy' })).toMatchObject({ ok: false, problems: [expect.stringContaining('"nonsense" is not a field')] });
  });
});

describe('the item-wise report, through its mapping', () => {
  const report = [
    'SRE Hyper Market — Item wise sales',
    'Item Code,Item Name,Customer Mobile,Qty,Net Amount,GST Amt,Bill Date',
    'P1,Toor dal 1kg,9876543210,2,"2,100.00",100.00,21/10/2026',
    '\'0042,Loose rice,9123456780,1.250,"1,23,456.50",0,21/10/2026',
    ',Grocery sub-heading,,,,,',
    'Total,,,3.250,"1,25,556.50",100.00,',
  ].join('\r\n');

  it('keeps our fields only — never the mobile column — skips blank and total lines and says how many', () => {
    const r = readItemWiseReport({ text: report, mapping: ITEM_MAP, day: DAY });
    expect(r).toMatchObject({ ok: true, summary: { headerLine: 2, rowsRead: 2, withoutCode: 1, totalLines: 1, dateChecked: true } });
    if (!r.ok) return;
    expect(r.rows).toEqual([
      { line: 3, code: 'P1', quantityThousandths: 2000, valueMinor: 210_000, taxMinor: 10_000 },
      { line: 4, code: '0042', quantityThousandths: 1250, valueMinor: 12_345_650, taxMinor: 0 },
    ]);
    expect(JSON.stringify(r)).not.toContain('9876543210');
    expect(JSON.stringify(r)).not.toContain('Toor dal');
  });

  it('a value before tax gets its tax added (what the customer paid)', () => {
    const r = readItemWiseReport({ text: report, mapping: { ...ITEM_MAP, valueIncludesTax: false }, day: DAY });
    expect(r.ok && r.rows[0]).toMatchObject({ valueMinor: 220_000 });
  });

  it('refuses another day\'s report, a missing column, an unreadable figure and a code Excel turned into a number', () => {
    expect(readItemWiseReport({ text: report.replace(/21\/10\/2026/g, '20/10/2026'), mapping: ITEM_MAP, day: DAY })).toMatchObject({
      ok: false, refusedBecause: 'wrong_day', problems: [expect.stringContaining('this item-wise report is for 2026-10-20, not 2026-10-21')],
    });
    expect(readItemWiseReport({ text: report.replace('GST Amt', 'Tax'), mapping: ITEM_MAP, day: DAY })).toMatchObject({
      ok: false, refusedBecause: 'header_not_found', problems: [expect.stringContaining('the file has no column "GST Amt"')],
    });
    expect(readItemWiseReport({ text: report.replace('"2,100.00"', '"21,00"'), mapping: ITEM_MAP, day: DAY })).toMatchObject({
      ok: false, refusedBecause: 'unreadable_rows', problems: [expect.stringContaining('line 3: the value "21,00" is not a rupee amount')],
    });
    expect(readItemWiseReport({ text: report.replace('P1,', '8.90123E+12,'), mapping: ITEM_MAP, day: DAY })).toMatchObject({
      ok: false, refusedBecause: 'unreadable_rows', problems: [expect.stringContaining('turned into a number by Excel')],
    });
  });

  it('a report with no date column is read, and says its date was not checked', () => {
    const noDate: ColumnMapping = { kind: 'item_wise', columns: { item_code: 'Item Code', quantity: 'Qty', value: 'Net Amount', tax: 'GST Amt' }, valueIncludesTax: true };
    expect(readItemWiseReport({ text: report, mapping: noDate, day: DAY })).toMatchObject({ ok: true, summary: { dateChecked: false } });
  });
});

describe('the bill-wise list, through its mapping', () => {
  it('one row per bill: bill numbers kept in capitals, totals in paise, a bill twice refused', () => {
    const text = 'Bill No,Date,Customer,Bill Amount\nold/1,21/10/2026,Ravi,105.00\nOLD/2,21/10/2026,Meena,"1,050"\n';
    const r = readBillWiseReport({ text, mapping: BILL_MAP, day: DAY });
    expect(r).toMatchObject({ ok: true, withLines: false, bills: [{ billNumber: 'OLD/1', totalMinor: 10_500 }, { billNumber: 'OLD/2', totalMinor: 105_000 }] });
    expect(JSON.stringify(r)).not.toMatch(/Ravi|Meena/);
    expect(readBillWiseReport({ text: `${text}OLD/2,21/10/2026,Meena,1050\n`, mapping: BILL_MAP, day: DAY })).toMatchObject({ ok: false, refusedBecause: 'repeated_bill' });
  });

  it('a grouped report: item lines under their bill, the bill number on the first row only', () => {
    const text = [
      'Bill No,Date,Bill Amount,Item,Qty,Amount',
      'OLD/7,21/10/2026,315.00,P1,2,210.00',
      ',,,P2,1,105.00',
      'OLD/8,21/10/2026,-105.00,P1,-1,-105.00',
      'Grand Total,,210.00,,,',
    ].join('\n');
    const r = readBillWiseReport({ text, mapping: BILL_LINES_MAP, day: DAY });
    expect(r).toMatchObject({ ok: true, withLines: true, summary: { linesUnderBillAbove: 1, totalLines: 1 } });
    if (!r.ok) return;
    expect(r.bills).toEqual([
      { billNumber: 'OLD/7', line: 2, totalMinor: 31_500, lines: [{ line: 2, code: 'P1', quantityThousandths: 2000, valueMinor: 21_000 }, { line: 3, code: 'P2', quantityThousandths: 1000, valueMinor: 10_500 }] },
      { billNumber: 'OLD/8', line: 4, totalMinor: -10_500, lines: [{ line: 4, code: 'P1', quantityThousandths: -1000, valueMinor: -10_500 }] },
    ]);
  });

  it('refuses a bill-number column holding phone numbers (the mapping is wrong), and another day\'s bills', () => {
    const phones = 'Bill No,Date,Bill Amount\n9876543210,21/10/2026,10\n';
    expect(readBillWiseReport({ text: phones, mapping: BILL_MAP, day: DAY })).toMatchObject({ ok: false, refusedBecause: 'looks_personal', problems: [expect.stringContaining('look like phone, Aadhaar or card numbers')] });
    expect(readBillWiseReport({ text: 'Bill No,Date,Bill Amount\nOLD/1,20/10/2026,10\n', mapping: BILL_MAP, day: DAY })).toMatchObject({ ok: false, refusedBecause: 'wrong_day' });
    expect(readBillWiseReport({ text: 'Bill No,Date,Bill Amount\nOLD/1,21/10/2026,\n', mapping: BILL_MAP, day: DAY })).toMatchObject({ ok: false, refusedBecause: 'unreadable_rows', problems: [expect.stringContaining('has no total')] });
  });
});

describe('OB-263 A and B (owner, 21 Oct 2026): the department column, and bill lines before tax — asked once, in the mapping', () => {
  const report = [
    'Item Code,Dept,Customer Mobile,Qty,Net Amount,GST Amt',
    'P1,GROCERY,9876543210,2,210.00,10.00',
    'S1,Personal Care,9123456780,1,99.00,15.10',
    'X9,personal care,,1,not a number,0',
    'P3, Grocery ,,1,45.00,2.14',
    'P4,,,1,10.00,0',
    'Total,,,5,364.00,27.24',
  ].join('\n');
  const DEPT_MAP: ColumnMapping = { kind: 'item_wise', columns: { item_code: 'Item Code', department: 'Dept', quantity: 'Qty', value: 'Net Amount', tax: 'GST Amt' }, valueIncludesTax: true, pilotDepartmentValue: 'GROCERY' };

  it('A: the department column needs the pilot department\'s value, picked from the file\'s own values; it is kept with the mapping', () => {
    expect(columnValuesOf(report, 'dept')).toEqual(['GROCERY', 'Personal Care']);
    expect(judgeMapping('item_wise', { columns: DEPT_MAP.columns, valueIncludesTax: true })).toMatchObject({ ok: false, problems: [expect.stringContaining('which value of the department column is the pilot department')] });
    expect(judgeMapping('item_wise', { columns: DEPT_MAP.columns, valueIncludesTax: true, pilotDepartmentValue: ' GROCERY ' })).toEqual({ ok: true, mapping: DEPT_MAP });
    // Without the column the value means nothing, and is not kept.
    expect(judgeMapping('item_wise', { columns: { ...ITEM_MAP.columns }, dateOrder: 'dmy', valueIncludesTax: true, pilotDepartmentValue: 'GROCERY' })).toEqual({ ok: true, mapping: ITEM_MAP });
  });

  it('A: every other department\'s row is set aside before it is read — counted, never compared; a row with no department too', () => {
    const r = readItemWiseReport({ text: report, mapping: DEPT_MAP, day: DAY });
    expect(r).toMatchObject({ ok: true, summary: { rowsRead: 2, totalLines: 1, department: { pilotValue: 'GROCERY', otherDepartmentRows: 2, noDepartmentRows: 1 } } });
    expect(r.ok && r.rows.map((x) => x.code)).toEqual(['P1', 'P3']);
    // Not set: every row is read as before (and the unreadable figure in another department's row is then refused).
    expect(readItemWiseReport({ text: report, mapping: { ...DEPT_MAP, columns: { ...DEPT_MAP.columns, department: undefined }, pilotDepartmentValue: undefined }, day: DAY })).toMatchObject({ ok: false, refusedBecause: 'unreadable_rows' });
  });

  it('B: with item lines the bill-wise mapping asks whether their values include the tax, and keeps the answer', () => {
    const cols = BILL_LINES_MAP.columns;
    expect(judgeMapping('bill_wise', { columns: cols, dateOrder: 'dmy' })).toMatchObject({ ok: false, problems: [expect.stringContaining('bill lines\' values already include the tax')] });
    expect(judgeMapping('bill_wise', { columns: cols, dateOrder: 'dmy', lineValuesIncludeTax: false })).toEqual({ ok: true, mapping: { ...BILL_LINES_MAP, lineValuesIncludeTax: false } });
    // Without item lines there is nothing to ask, and nothing is kept.
    expect(judgeMapping('bill_wise', { columns: BILL_MAP.columns, dateOrder: 'dmy', lineValuesIncludeTax: false })).toEqual({ ok: true, mapping: BILL_MAP });
    const text = 'Bill No,Date,Bill Amount,Item,Qty,Amount\nOLD/7,21/10/2026,105.00,P1,1,100.00\n';
    expect(readBillWiseReport({ text, mapping: { ...BILL_LINES_MAP, lineValuesIncludeTax: false }, day: DAY })).toMatchObject({ ok: true, summary: { lineValuesIncludeTax: false } });
  });
});
