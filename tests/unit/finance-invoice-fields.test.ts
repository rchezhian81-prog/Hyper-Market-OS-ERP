import { describe, it, expect } from 'vitest';
import { checkTaxInvoiceFields, type TaxInvoiceFields } from '../../packages/finance/src/invoice-fields';

// Roadmap v2.1 A1 — the mandatory CGST Rule 46 tax-invoice fields. A tax invoice missing a mandatory
// field is not a valid tax invoice; the checker names every field that is absent or malformed.

const VALID: TaxInvoiceFields = {
  documentType: 'Tax Invoice',
  supplierGstin: '29ABCDE1234F1Z5',
  invoiceNumber: 'INV/2026/000001', // 15 chars
  invoiceDate: '2026-08-10',
  hsnCode: '1006',
  taxableMinor: 100_00,
  rateBps: 1800,
  placeOfSupply: 'intra_state',
  taxComponents: ['CGST', 'SGST'],
};

describe('checkTaxInvoiceFields — A1 / CGST Rule 46', () => {
  it('passes a complete, well-formed tax invoice', () => {
    const r = checkTaxInvoiceFields(VALID);
    expect(r.valid).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it('fails, naming the field, when any mandatory field is missing', () => {
    const fields = ['documentType', 'supplierGstin', 'invoiceNumber', 'invoiceDate', 'hsnCode', 'taxableMinor', 'rateBps', 'placeOfSupply'] as const;
    for (const f of fields) {
      const without = { ...VALID };
      delete (without as Record<string, unknown>)[f];
      const r = checkTaxInvoiceFields(without as TaxInvoiceFields);
      expect(r.valid, `missing ${f}`).toBe(false);
      expect(r.problems.some((p) => p.startsWith(f)), `problem names ${f}: ${r.problems.join('; ')}`).toBe(true);
    }
  });

  it('rejects malformed fields — a bad GSTIN, a >16-char number, a bad date, a non-positive taxable', () => {
    expect(checkTaxInvoiceFields({ ...VALID, supplierGstin: 'NOTAGSTIN' }).valid).toBe(false);
    expect(checkTaxInvoiceFields({ ...VALID, invoiceNumber: 'INV/2026/0000000001' }).valid).toBe(false); // 19 chars
    expect(checkTaxInvoiceFields({ ...VALID, invoiceDate: '10-08-2026' }).valid).toBe(false);
    expect(checkTaxInvoiceFields({ ...VALID, taxableMinor: 0 }).valid).toBe(false);
    expect(checkTaxInvoiceFields({ ...VALID, documentType: 'Bill of Supply' }).valid).toBe(false);
  });

  it('requires the tax split to match the place of supply', () => {
    // Intra-State must carry CGST+SGST, never IGST.
    expect(checkTaxInvoiceFields({ ...VALID, taxComponents: ['IGST'] }).valid).toBe(false);
    expect(checkTaxInvoiceFields({ ...VALID, taxComponents: ['CGST'] }).valid).toBe(false); // missing SGST
    // Inter-State must carry IGST, never CGST/SGST.
    expect(checkTaxInvoiceFields({ ...VALID, placeOfSupply: 'inter_state', taxComponents: ['IGST'] }).valid).toBe(true);
    expect(checkTaxInvoiceFields({ ...VALID, placeOfSupply: 'inter_state', taxComponents: ['CGST', 'SGST'] }).valid).toBe(false);
  });
});
