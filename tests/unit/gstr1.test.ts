import { describe, it, expect } from 'vitest';
import { validateOutwardLine, gstr1Table12, gstr1Return, type OutwardSupplyLine, type ClassifiedLine, type OutwardDocument } from '../../packages/finance/src/index';

// A5 — GSTR-1 Table 12: the HSN-wise summary of outward supplies, B2B/B2C split, HSN from a closed master
// (no free text). Turnover ₹6cr → 6-digit HSN required (A4 reuse).

const OVER = 6_000_000_000;
const line = (o: Partial<OutwardSupplyLine> = {}): OutwardSupplyLine =>
  ({ hsnCode: '100610', quantityMinor: 1000, uom: 'kg', taxableMinor: 10000, rateBps: 500, cgstMinor: 250, sgstMinor: 250, igstMinor: 0, ...o });

describe('outward-supply line validation (A5)', () => {
  it('accepts a well-formed line and rejects a free-text or short HSN', () => {
    expect(validateOutwardLine(line(), { annualTurnoverMinor: OVER }).valid).toBe(true);
    // Free text — rejected (not from the closed master).
    expect(validateOutwardLine(line({ hsnCode: 'RICE' }), { annualTurnoverMinor: OVER }).valid).toBe(false);
    // 4-digit HSN below the 6-digit requirement at this turnover.
    expect(validateOutwardLine(line({ hsnCode: '1006' }), { annualTurnoverMinor: OVER }).valid).toBe(false);
  });

  it('rejects an inconsistent tax split (both CGST/SGST and IGST, or unequal CGST/SGST)', () => {
    expect(validateOutwardLine(line({ cgstMinor: 250, sgstMinor: 250, igstMinor: 500 }), { annualTurnoverMinor: OVER }).valid).toBe(false);
    expect(validateOutwardLine(line({ cgstMinor: 300, sgstMinor: 200 }), { annualTurnoverMinor: OVER }).valid).toBe(false);
  });
});

describe('GSTR-1 Table 12 summary (A5)', () => {
  it('groups by HSN + rate, sums tax, and splits B2B/B2C', () => {
    const lines: ClassifiedLine[] = [
      { ...line({ hsnCode: '100610', taxableMinor: 10000, cgstMinor: 250, sgstMinor: 250 }), supplyKind: 'b2b' },
      { ...line({ hsnCode: '100610', taxableMinor: 20000, cgstMinor: 500, sgstMinor: 500 }), supplyKind: 'b2c' },
      { ...line({ hsnCode: '220210', taxableMinor: 5000, rateBps: 1800, cgstMinor: 450, sgstMinor: 450 }), supplyKind: 'b2c' },
    ];
    const t12 = gstr1Table12(lines);
    expect(t12.rows).toHaveLength(2); // 100610@500 and 220210@1800
    const rice = t12.rows.find((r) => r.hsnCode === '100610')!;
    expect(rice.taxableMinor).toBe(30000);
    expect(rice.b2bTaxableMinor).toBe(10000);
    expect(rice.b2cTaxableMinor).toBe(20000);
    expect(rice.cgstMinor).toBe(750); // 250 + 500
    expect(t12.totalTaxableMinor).toBe(35000);
    expect(t12.b2bTaxableMinor).toBe(10000);
    expect(t12.totalTaxMinor).toBe(750 + 750 + 900); // cgst+sgst across both rows
  });
});

describe('GSTR-1 return assembly (A5): B2B invoice-level + B2C rate-wise', () => {
  const GSTIN = '33ABCDE1234F1Z5';
  const doc = (o: Partial<OutwardDocument>): OutwardDocument =>
    ({ documentId: 'd1', documentDate: '2026-08-05', supplyType: 'b2c', lines: [line()], ...o });

  it('reports B2B invoice-by-invoice and B2C rate-wise, agreeing with the HSN summary', () => {
    const ret = gstr1Return([
      doc({ documentId: 'INV-1', supplyType: 'b2b', recipientGstin: GSTIN, lines: [line({ taxableMinor: 10000, cgstMinor: 250, sgstMinor: 250 })] }),
      doc({ documentId: 'INV-2', supplyType: 'b2b', recipientGstin: GSTIN, lines: [line({ taxableMinor: 5000, cgstMinor: 125, sgstMinor: 125 })] }),
      doc({ documentId: 'RCPT-1', supplyType: 'b2c', lines: [line({ taxableMinor: 20000, cgstMinor: 500, sgstMinor: 500 })] }),
    ]);
    expect(ret.b2b).toHaveLength(2); // two invoices, both to the same GSTIN
    expect(ret.b2b[0]!.invoiceNumber).toBe('INV-1');
    expect(ret.b2b[0]!.invoiceValueMinor).toBe(10000 + 250 + 250);
    expect(ret.b2c).toHaveLength(1); // one rate
    expect(ret.b2c[0]!.taxableMinor).toBe(20000);
    expect(ret.totalTaxableMinor).toBe(35000);
    expect(ret.hsn.b2bTaxableMinor).toBe(15000);
  });

  it('files a B2B document with no recipient GSTIN as B2C — it cannot be a B2B invoice', () => {
    const ret = gstr1Return([doc({ documentId: 'X', supplyType: 'b2b', lines: [line({ taxableMinor: 8000, cgstMinor: 200, sgstMinor: 200 })] })]);
    expect(ret.b2b).toHaveLength(0);
    expect(ret.b2c[0]!.taxableMinor).toBe(8000);
  });
});
