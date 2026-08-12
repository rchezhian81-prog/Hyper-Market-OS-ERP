import { describe, it, expect } from 'vitest';
import {
  salesToOutwardSupplies,
  InvalidSalesToOutwardInput,
  type SoldTaxLine,
  type ProductTaxEntry,
} from '../../packages/finance/src/outward-from-sales';

// A5 — turn banked B2C till sales into the GSTR-1 Table-12 HSN summary, pulling GST back out of the
// MRP-inclusive line totals against a caller-supplied product→{HSN, rate} table. Unmapped products are
// surfaced, never dropped. Pure and deterministic.

const SMALL = 1_000_000; // < ₹5cr turnover → 4-digit HSN accepted

describe('salesToOutwardSupplies', () => {
  it('pulls GST out of the inclusive line totals and aggregates a Table-12 by HSN/rate', () => {
    // ₹118 incl @18% intra → taxable 100, CGST 9, SGST 9. Two lines of the same product/HSN aggregate.
    const sales: SoldTaxLine[] = [
      { productId: 'MILK', quantityMinor: 1, uom: 'each', lineTotalMinor: 11_800 },
      { productId: 'MILK', quantityMinor: 1, uom: 'each', lineTotalMinor: 11_800 },
    ];
    const taxTable: ProductTaxEntry[] = [{ productId: 'MILK', hsnCode: '0401', rateBps: 1800 }];

    const r = salesToOutwardSupplies({ sales, taxTable, annualTurnoverMinor: SMALL });
    expect(r.unmapped).toEqual([]);
    expect(r.mappedLineCount).toBe(2);
    expect(r.table12.rows).toHaveLength(1);
    const row = r.table12.rows[0]!;
    expect(row.hsnCode).toBe('0401');
    expect(row.taxableMinor).toBe(20_000); // 2 × 10000
    expect(row.cgstMinor).toBe(1_800);     // 2 × 900
    expect(row.sgstMinor).toBe(1_800);
    expect(row.igstMinor).toBe(0);
    expect(r.table12.b2cTaxableMinor).toBe(20_000); // counter sales are all B2C
    expect(r.table12.b2bTaxableMinor).toBe(0);
    // A9 invariant end-to-end: taxable + tax reconciles to the gross the till charged (2 × 11800).
    expect(row.taxableMinor + row.cgstMinor + row.sgstMinor + row.igstMinor).toBe(23_600);
  });

  it('splits an inter-State supply as a single IGST', () => {
    const r = salesToOutwardSupplies({
      sales: [{ productId: 'P', quantityMinor: 1, uom: 'each', lineTotalMinor: 10_500 }],
      taxTable: [{ productId: 'P', hsnCode: '1006', rateBps: 500, placeOfSupply: 'inter_state' }],
      annualTurnoverMinor: SMALL,
    });
    const row = r.table12.rows[0]!;
    expect(row.igstMinor).toBe(500);
    expect(row.cgstMinor).toBe(0);
    expect(row.sgstMinor).toBe(0);
    expect(row.taxableMinor).toBe(10_000);
  });

  it('carries a zero-rated (exempt) line: taxable equals the gross, no tax', () => {
    const r = salesToOutwardSupplies({
      sales: [{ productId: 'SALT', quantityMinor: 1, uom: 'each', lineTotalMinor: 5_000 }],
      taxTable: [{ productId: 'SALT', hsnCode: '2501', rateBps: 0 }],
      annualTurnoverMinor: SMALL,
    });
    const row = r.table12.rows[0]!;
    expect(row.taxableMinor).toBe(5_000);
    expect(row.cgstMinor + row.sgstMinor + row.igstMinor).toBe(0);
  });

  it('surfaces a product with no tax mapping — counted and named, never on the return', () => {
    const r = salesToOutwardSupplies({
      sales: [
        { productId: 'MILK', quantityMinor: 1, uom: 'each', lineTotalMinor: 11_800 },
        { productId: 'MYSTERY', quantityMinor: 2, uom: 'each', lineTotalMinor: 4_000 },
        { productId: 'MYSTERY', quantityMinor: 1, uom: 'each', lineTotalMinor: 2_000 },
      ],
      taxTable: [{ productId: 'MILK', hsnCode: '0401', rateBps: 1800 }],
      annualTurnoverMinor: SMALL,
    });
    expect(r.mappedLineCount).toBe(1);        // only MILK filed
    expect(r.unmapped).toHaveLength(1);        // MYSTERY aggregated to one row
    const u = r.unmapped[0]!;
    expect(u.productId).toBe('MYSTERY');
    expect(u.reason).toBe('no_tax_mapping');
    expect(u.quantityMinor).toBe(3);           // 2 + 1
    expect(u.lineTotalMinor).toBe(6_000);      // 4000 + 2000
    // The mapped MILK value is still complete and unaffected by the unmapped product.
    expect(r.table12.totalTaxableMinor).toBe(10_000);
  });

  it('rejects a malformed HSN for the turnover as unmapped, not a thrown error', () => {
    // Big shop (> ₹5cr) needs 6-digit HSN; a 4-digit code is rejected for the line.
    const r = salesToOutwardSupplies({
      sales: [{ productId: 'RICE', quantityMinor: 1, uom: 'each', lineTotalMinor: 10_500 }],
      taxTable: [{ productId: 'RICE', hsnCode: '1006', rateBps: 500 }],
      annualTurnoverMinor: 5_000_000_001,
    });
    expect(r.mappedLineCount).toBe(0);
    expect(r.unmapped[0]!.reason).toBe('invalid_hsn');
  });

  it('surfaces a line whose intra-State rate cannot split into equal halves', () => {
    // An odd intra-State rate (1801 bps) cannot halve into whole-bps CGST + SGST.
    const r = salesToOutwardSupplies({
      sales: [{ productId: 'ODD', quantityMinor: 1, uom: 'each', lineTotalMinor: 11_801 }],
      taxTable: [{ productId: 'ODD', hsnCode: '1006', rateBps: 1801, placeOfSupply: 'intra_state' }],
      annualTurnoverMinor: SMALL,
    });
    expect(r.mappedLineCount).toBe(0);
    expect(r.unmapped[0]!.reason).toBe('cannot_split_tax');
  });

  it('files a line under its OWN frozen HSN/rate (captured at supply), ignoring the period table', () => {
    // The line carries hsnCode + rateBps; no table entry for it — it is still filed, under the frozen facts.
    const r = salesToOutwardSupplies({
      sales: [{ productId: 'MILK', quantityMinor: 1, uom: 'each', lineTotalMinor: 11_800, hsnCode: '0401', rateBps: 1800 }],
      taxTable: [], annualTurnoverMinor: SMALL,
    });
    expect(r.frozenLineCount).toBe(1);
    expect(r.mappedLineCount).toBe(1);
    expect(r.table12.rows[0]!.hsnCode).toBe('0401');
    expect(r.table12.rows[0]!.taxableMinor).toBe(10_000);
  });

  it('a frozen rate on the line wins over a different rate in the table (mid-period change correctness)', () => {
    // Same product sold twice at DIFFERENT frozen rates (a rate change mid-period) → two HSN/rate rows,
    // each split at what actually applied — not one blended rate from the table.
    const r = salesToOutwardSupplies({
      sales: [
        { productId: 'X', quantityMinor: 1, uom: 'each', lineTotalMinor: 10_500, hsnCode: '1006', rateBps: 500 },  // sold at 5%
        { productId: 'X', quantityMinor: 1, uom: 'each', lineTotalMinor: 11_200, hsnCode: '1006', rateBps: 1200 }, // sold at 12%
      ],
      taxTable: [{ productId: 'X', hsnCode: '1006', rateBps: 500 }], // the table would have filed both at 5%
      annualTurnoverMinor: SMALL,
    });
    expect(r.frozenLineCount).toBe(2);
    expect(r.table12.rows).toHaveLength(2); // 1006@500 and 1006@1200 kept apart
    const byRate = Object.fromEntries(r.table12.rows.map((row) => [row.rateBps, row.taxableMinor]));
    expect(byRate[500]).toBe(10_000);
    expect(byRate[1200]).toBe(10_000);
  });

  it('falls back to the table when only part of the frozen facts is present', () => {
    // hsnCode present but no rateBps → not usable as frozen; the table supplies the mapping.
    const r = salesToOutwardSupplies({
      sales: [{ productId: 'MILK', quantityMinor: 1, uom: 'each', lineTotalMinor: 11_800, hsnCode: '0401' }],
      taxTable: [{ productId: 'MILK', hsnCode: '0401', rateBps: 1800 }],
      annualTurnoverMinor: SMALL,
    });
    expect(r.frozenLineCount).toBe(0);
    expect(r.mappedLineCount).toBe(1);
    expect(r.table12.rows[0]!.rateBps).toBe(1800);
  });

  it('rejects malformed engine input', () => {
    const good = { sales: [], taxTable: [], annualTurnoverMinor: SMALL };
    expect(() => salesToOutwardSupplies({ ...good, annualTurnoverMinor: -1 })).toThrow(InvalidSalesToOutwardInput);
    expect(() => salesToOutwardSupplies({ ...good, placeOfSupply: 'moon' as never })).toThrow(InvalidSalesToOutwardInput);
  });
});
