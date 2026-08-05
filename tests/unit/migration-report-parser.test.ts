import { describe, it, expect } from 'vitest';
import {
  parseReportMoney, parseReportQuantity, classifyRow, parseReport, checkAgainstPrintedTotal,
} from '../../packages/migration/src/report-parser';

// Reading what a fifteen-year-old ERP actually exports (OB-06, MG-01, MG-04, §29.1).

describe('money comes off a report exactly, with no float anywhere', () => {
  const minor = (text: string): number | undefined => parseReportMoney(text)?.minor;

  it('reads INDIAN digit grouping — 4,12,000 is twelve lakh, not four thousand', () => {
    expect(minor('4,12,000.00')).toBe(41_200_000);
    expect(minor('1,23,45,678.90')).toBe(1_234_567_890);
    expect(minor('84,12,000.00')).toBe(841_200_000);
  });

  it('reads Western grouping identically, because both mean the same number', () => {
    // A parser that VALIDATES grouping against one convention rejects real files from the other.
    expect(minor('412,000.00')).toBe(minor('4,12,000.00'));
    expect(minor('1,234.56')).toBe(123_456);
  });

  it('never goes through a float — 19.99 is 1999 paise, not 1998.9999999999998', () => {
    // `parseFloat(x) * 100` is the line everybody writes and it is wrong in every language with
    // binary floating point. The decimal part is parsed as TEXT.
    expect(minor('19.99')).toBe(1_999);
    expect(minor('0.07')).toBe(7);
    expect(minor('1.10')).toBe(110);
    for (const [text, expected] of [['8.29', 829], ['12.21', 1_221], ['70.07', 7_007], ['1005.55', 100_555]] as const) {
      expect(minor(text), text).toBe(expected);
      expect(Number.isInteger(minor(text)!)).toBe(true);
    }
  });

  it('treats a lone dash as NIL — a number these reports print constantly, not a blank', () => {
    for (const dash of ['-', '–', '—', ' - ']) {
      expect(minor(dash), dash).toBe(0);
    }
  });

  it('reads CR as NEGATIVE — a credit balance read positive inverts every supplier balance', () => {
    expect(minor('12,500.00 CR')).toBe(-1_250_000);
    expect(minor('12,500.00 DR')).toBe(1_250_000);
    expect(minor('12,500.00CR')).toBe(-1_250_000);
    expect(minor('12,500.00 Cr.')).toBe(-1_250_000);
  });

  it('reads the accounting negatives these reports use', () => {
    expect(minor('(1,200.00)')).toBe(-120_000);
    expect(minor('1,200.00-')).toBe(-120_000);
    expect(minor('-1,200.00')).toBe(-120_000);
  });

  it('strips the currency marks and the non-breaking spaces Excel leaves behind', () => {
    expect(minor('₹ 1,234.56')).toBe(123_456);
    expect(minor('Rs. 1,234.56')).toBe(123_456);
    expect(minor('INR 1,234.56')).toBe(123_456);
    expect(minor(' 1,234.56 ')).toBe(123_456);
  });

  it('refuses text it cannot read rather than returning a plausible zero', () => {
    // A figure silently read as zero is how a stock valuation quietly loses a department.
    for (const bad of ['', '   ', 'N/A', 'nil', 'see note', '12.3.4', 'abc', '.']) {
      expect(parseReportMoney(bad), bad).toBeUndefined();
    }
  });

  it('keeps the source text, so an exception can quote the page (MG-04)', () => {
    expect(parseReportMoney('  ₹ 4,12,000.00 ')?.source).toBe('  ₹ 4,12,000.00 ');
  });

  it('reads quantities on the same conventions', () => {
    expect(parseReportQuantity('1,412')).toBe(1_412);
    expect(parseReportQuantity('12.5')).toBe(12.5);
    expect(parseReportQuantity('-')).toBe(0);
  });
});

describe('a row is classified so a subtotal can never be counted as data', () => {
  const header = ['Item Code', 'Description', 'Dept', 'Qty', 'Rate', 'Value'];
  const kind = (cells: readonly string[]): string =>
    classifyRow({ cells, lineNumber: 1, header }).kind;

  it('reads a data row as data', () => {
    expect(kind(['P00001', 'Aachi Rice Ponni 1kg', 'GRO', '412', '52.00', '21,424.00'])).toBe('data');
  });

  it('catches a group SUBTOTAL — the misread that doubles a department', () => {
    // "Total for GROCERY" read as data adds the group's own total back into the group. The
    // result is a valuation that is plausibly wrong rather than obviously wrong.
    expect(kind(['Total for GROCERY', '', '', '', '', '4,12,000.00'])).toBe('subtotal');
    expect(kind(['Sub-total', '', '', '', '', '4,12,000.00'])).toBe('subtotal');
    expect(kind(['Dept Total', '', '', '', '', '4,12,000.00'])).toBe('subtotal');
  });

  it('catches the grand total', () => {
    expect(kind(['GRAND TOTAL', '', '', '', '', '84,12,000.00'])).toBe('grand_total');
  });

  it('catches the header coming back after a page break', () => {
    expect(kind([...header])).toBe('repeated_header');
    // And is not fooled by different spacing or case, which page headers routinely have.
    expect(kind(['ITEM CODE', 'Description ', 'DEPT', 'Qty', 'Rate', 'VALUE'])).toBe('repeated_header');
  });

  it('catches titles, banners, blanks and page furniture', () => {
    expect(kind(['SRE HYPER MARKET', '', '', '', '', ''])).toBe('title');
    expect(kind(['', '', '', '', '', ''])).toBe('blank');
    expect(kind(['Page 3 of 47', '', '', '', '', ''])).toBe('footer');
    expect(kind(['Printed on 31/03/2026 by ADMIN', '', '', '', '', ''])).toBe('footer');
    expect(kind(['*** End of Report ***', '', '', '', '', ''])).toBe('footer');
  });

  it('gives a reason for every classification, not just a label', () => {
    const r = classifyRow({ cells: ['Total for GROCERY', '', '', '', '', '1.00'], lineNumber: 9, header });
    expect(r.why).toContain('must never be counted as a row of data');
    expect(r.lineNumber).toBe(9);
  });
});

describe('a whole report, as one of these systems actually prints it', () => {
  const GRID: readonly (readonly string[])[] = [
    ['SRE HYPER MARKET', '', '', '', '', ''],
    ['Stock Valuation Report', '', '', '', '', ''],
    ['As on 31/03/2026', '', '', '', '', ''],
    ['', '', '', '', '', ''],
    ['Item Code', 'Description', 'Dept', 'Qty', 'Rate', 'Value'],
    ['P00001', 'Aachi Rice Ponni 1kg', 'GRO', '400', '52.00', '20,800.00'],
    ['P00002', 'Sakthi Atta Premium 5kg', 'GRO', '100', '210.00', '21,000.00'],
    ['Total for GROCERY', '', '', '', '', '41,800.00'],
    ['', '', '', '', '', ''],
    ['Page 1 of 2', '', '', '', '', ''],
    ['SRE HYPER MARKET', '', '', '', '', ''],
    ['Item Code', 'Description', 'Dept', 'Qty', 'Rate', 'Value'],
    ['P00003', 'Amul Ghee Gold 1L', 'DAI', '50', '640.00', '32,000.00'],
    ['Total for DAIRY', '', '', '', '', '32,000.00'],
    ['GRAND TOTAL', '', '', '', '', '73,800.00'],
    ['Printed on 31/03/2026 by ADMIN', '', '', '', '', ''],
  ];

  const parsed = parseReport({ grid: GRID, expectColumn: 'Item Code' });

  it('FINDS the header instead of assuming line 1 — otherwise the columns are named after the shop', () => {
    expect(parsed.ok).toBe(true);
    expect(parsed.report?.headerLine).toBe(5);
    expect(parsed.report?.header[0]).toBe('Item Code');
  });

  it('returns only the three real data rows', () => {
    expect(parsed.report?.rows).toHaveLength(3);
    expect(parsed.report?.rows.map((r) => r['Item Code'])).toEqual(['P00001', 'P00002', 'P00003']);
  });

  it('keeps the source line for every row, so an exception can quote the page (MG-04)', () => {
    expect(parsed.report?.lineNumbers).toEqual([6, 7, 13]);
  });

  it('collects the subtotals and the grand total separately from the data', () => {
    expect(parsed.report?.subtotals.map((s) => s.label)).toEqual(['Total for GROCERY', 'Total for DAIRY']);
    expect(parsed.report?.subtotals[0]?.amount?.minor).toBe(4_180_000);
    expect(parsed.report?.grandTotal?.amount?.minor).toBe(7_380_000);
  });

  it('drops NOTHING silently — every dropped line is returned with its reason (P-08)', () => {
    const dropped = parsed.report!.dropped;
    // Every line in the file except the header and the three data rows — INCLUDING the banner
    // above the header, which it would be easy to skip and which would make the claim untrue for
    // the part of the file people actually ask about.
    expect(dropped.length).toBe(GRID.length - 1 - 3);
    expect(dropped.some((d) => d.lineNumber === 1 && d.kind === 'title')).toBe(true);
    for (const d of dropped) {
      expect(d.why.length, `line ${d.lineNumber}`).toBeGreaterThan(10);
    }
    expect(parsed.report?.detail).toContain('dropped');
  });

  it('drops the header that came back after the page break, without dropping the data after it', () => {
    expect(parsed.report!.dropped.some((d) => d.kind === 'repeated_header')).toBe(true);
    expect(parsed.report?.rows.some((r) => r['Item Code'] === 'P00003')).toBe(true);
  });

  it('REFUSES a file whose header it cannot find, rather than guessing', () => {
    const r = parseReport({ grid: GRID, expectColumn: 'Barcode' });
    expect(r.ok).toBe(false);
    expect(r.refusedBecause).toBe('no_header_found');
    expect(r.detail).toContain('names the columns after the shop');
  });

  it('REFUSES a header with nothing under it — an empty parse is a mis-read file', () => {
    const r = parseReport({
      grid: [['Item Code', 'Value'], ['', ''], ['Page 1 of 1', '']],
      expectColumn: 'Item Code',
    });
    expect(r.ok).toBe(false);
    expect(r.refusedBecause).toBe('no_data_rows');
  });
});

describe('the report checks our READING, and says plainly that it checks nothing else', () => {
  const rows = [
    { 'Item Code': 'P00001', Value: '20,800.00' },
    { 'Item Code': 'P00002', Value: '21,000.00' },
    { 'Item Code': 'P00003', Value: '32,000.00' },
  ];

  it('matches the printed grand total exactly when the parse was right', () => {
    const r = checkAgainstPrintedTotal({
      rows, amountColumn: 'Value', printed: parseReportMoney('73,800.00')!,
    });
    expect(r.matches).toBe(true);
    expect(r.ourTotalMinor).toBe(7_380_000);
    expect(r.checked).toBe(3);
  });

  it('catches a subtotal that was wrongly counted as data — the exact failure it exists for', () => {
    const withSubtotalCounted = [...rows, { 'Item Code': 'Total for GROCERY', Value: '41,800.00' }];
    const r = checkAgainstPrintedTotal({
      rows: withSubtotalCounted, amountColumn: 'Value', printed: parseReportMoney('73,800.00')!,
    });
    expect(r.matches).toBe(false);
    expect(r.differenceMinor).toBe(4_180_000);
    expect(r.detail).toContain('a subtotal counted as data');
  });

  it('catches a dropped page', () => {
    const r = checkAgainstPrintedTotal({
      rows: rows.slice(0, 2), amountColumn: 'Value', printed: parseReportMoney('73,800.00')!,
    });
    expect(r.matches).toBe(false);
    expect(r.differenceMinor).toBe(-3_200_000);
  });

  it('REFUSES to call this verification of the data — both sides came from the same system', () => {
    // The whole discipline of OB-06: this proves we read the report correctly and says nothing
    // about whether the report is right. The stock figure is still proved by counting shelves.
    const r = checkAgainstPrintedTotal({
      rows, amountColumn: 'Value', printed: parseReportMoney('73,800.00')!,
    });
    const verifies: false = r.verifiesTheData;
    expect(verifies).toBe(false);
    expect(r.detail).toContain('both sides came from the same system');
  });

  it('says so plainly when the report printed no total to check against', () => {
    const r = checkAgainstPrintedTotal({ rows, amountColumn: 'Value' });
    expect(r.matches).toBe(false);
    expect(r.detail).toContain('no free check on the parse');
  });
});
