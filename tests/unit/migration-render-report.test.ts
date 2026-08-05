import { describe, it, expect } from 'vitest';
import { formatIndianMoney, renderStockReport, checkRoundTrip } from '../../packages/migration/src/render-report';
import { parseReport, parseReportMoney } from '../../packages/migration/src/report-parser';
import { generateLegacyDataset } from '../../packages/migration/src/synthetic';

// OB-06 — the round trip. We generated the data, so we know what should come back.

describe('money is printed the way these reports print it', () => {
  it('groups Indian-style: three, then every two', () => {
    expect(formatIndianMoney(41_200_000)).toBe('4,12,000.00');
    expect(formatIndianMoney(1_234_567_890)).toBe('1,23,45,678.90');
    expect(formatIndianMoney(123_456)).toBe('1,234.56');
  });

  it('always prints two decimals, including for round figures and paise-only amounts', () => {
    expect(formatIndianMoney(100)).toBe('1.00');
    expect(formatIndianMoney(7)).toBe('0.07');
    expect(formatIndianMoney(0)).toBe('0.00');
  });

  it('round-trips through the parser exactly, in both directions', () => {
    // If the formatter and the parser were both wrong in the same way, the round trip below
    // would agree with itself while both ends were wrong. This pins the format independently.
    for (const minor of [0, 7, 100, 999, 123_456, 41_200_000, 1_234_567_890, -120_000]) {
      expect(parseReportMoney(formatIndianMoney(minor))?.minor, String(minor)).toBe(minor);
    }
  });
});

describe('a generated dataset survives being printed and read back', () => {
  const dataset = generateLegacyDataset();
  const grid = renderStockReport(dataset, { rowsPerPage: 25 });
  const parsed = parseReport({ grid, expectColumn: 'Item Code' });

  it('renders real page furniture — banners, breaks, repeated headers, subtotals', () => {
    const flat = grid.map((r) => r.join('|')).join('\n');
    expect(flat).toContain('SRE HYPER MARKET');
    expect(flat).toContain('Total for');
    expect(flat).toContain('GRAND TOTAL');
    expect(flat).toContain('Printed on');
    // More printed lines than data rows: the furniture is really there.
    expect(grid.length).toBeGreaterThan(dataset.stock.length + 50);
  });

  it('parses back LOSSLESSLY — every row and every paisa', () => {
    expect(parsed.ok).toBe(true);
    const trip = checkRoundTrip({
      dataset, parsedRows: parsed.report!.rows, parseMoney: parseReportMoney,
    });
    expect(trip.lossless, trip.detail).toBe(true);
    expect(trip.parsedRows).toBe(trip.expectedRows);
    expect(trip.parsedTotalMinor).toBe(trip.expectedTotalMinor);
    expect(trip.detail).toContain('page breaks, repeated headers and group subtotals');
  });

  it('keeps the subtotals out of the data and available separately', () => {
    expect(parsed.report!.subtotals.length).toBeGreaterThan(0);
    expect(parsed.report!.rows.some((r) => (r['Item Code'] ?? '').startsWith('Total'))).toBe(false);
  });

  it('is lossless at any page size — the break must not eat a row wherever it falls', () => {
    // A page break landing between a row and its group subtotal is the case that breaks naive
    // parsers, so it is exercised at several sizes rather than one convenient one.
    for (const rowsPerPage of [7, 13, 25, 60, 500]) {
      const g = renderStockReport(dataset, { rowsPerPage });
      const p = parseReport({ grid: g, expectColumn: 'Item Code' });
      expect(p.ok, `rowsPerPage=${rowsPerPage}`).toBe(true);
      const trip = checkRoundTrip({ dataset, parsedRows: p.report!.rows, parseMoney: parseReportMoney });
      expect(trip.lossless, `rowsPerPage=${rowsPerPage}: ${trip.detail}`).toBe(true);
    }
  });

  it('is lossless without department grouping too', () => {
    const g = renderStockReport(dataset, { groupByDepartment: false });
    const p = parseReport({ grid: g, expectColumn: 'Item Code' });
    const trip = checkRoundTrip({ dataset, parsedRows: p.report!.rows, parseMoney: parseReportMoney });
    expect(trip.lossless, trip.detail).toBe(true);
  });
});

describe('and the round-trip check FIRES on each way a parse can lose data', () => {
  const dataset = generateLegacyDataset({ products: 40, documents: 10, customers: 10 });
  const grid = renderStockReport(dataset, { rowsPerPage: 9 });
  const rows = parseReport({ grid, expectColumn: 'Item Code' }).report!.rows;

  it('catches a dropped row, and NAMES which product went missing', () => {
    const trip = checkRoundTrip({
      dataset, parsedRows: rows.slice(1), parseMoney: parseReportMoney,
    });
    expect(trip.lossless).toBe(false);
    expect(trip.missing).toHaveLength(1);
    // Named, not counted: "one row short" sends somebody through 400 lines by hand.
    expect(trip.missing[0]).toContain(rows[0]!['Item Code']);
    expect(trip.detail).toContain('LOST something');
  });

  it('catches a SUBTOTAL wrongly counted as a product — the misread that doubles a department', () => {
    const withSubtotal = [...rows, { 'Item Code': 'Total for GRO', Value: '4,12,000.00' }];
    const trip = checkRoundTrip({ dataset, parsedRows: withSubtotal, parseMoney: parseReportMoney });
    expect(trip.lossless).toBe(false);
    expect(trip.extra.some((e) => e.includes('Total for GRO'))).toBe(true);
  });

  it('catches a row LOST when the same product appears at two locations', () => {
    // Counting distinct ids would hide this: the product is still "present". A page break eats
    // one of its two rows and the stock for a whole location vanishes.
    const duplicated = rows.find((r) => rows.filter((x) => x['Item Code'] === r['Item Code']).length > 1);
    if (duplicated === undefined) return; // fixture has no multi-location product; nothing to prove
    const index = rows.findIndex((r) => r['Item Code'] === duplicated['Item Code']);
    const trip = checkRoundTrip({
      dataset, parsedRows: [...rows.slice(0, index), ...rows.slice(index + 1)], parseMoney: parseReportMoney,
    });
    expect(trip.lossless).toBe(false);
    expect(trip.missing[0]).toContain(duplicated['Item Code']);
  });

  it('catches a misread figure even when every row is present', () => {
    const nudged = rows.map((r, i) => (i === 0 ? { ...r, Value: '1.00' } : r));
    const trip = checkRoundTrip({ dataset, parsedRows: nudged, parseMoney: parseReportMoney });
    expect(trip.lossless).toBe(false);
    expect(trip.missing).toEqual([]);
    expect(trip.extra).toEqual([]);
    // Rows all present, money wrong — which is the failure a row count alone never sees.
    expect(trip.parsedTotalMinor).not.toBe(trip.expectedTotalMinor);
  });
});
