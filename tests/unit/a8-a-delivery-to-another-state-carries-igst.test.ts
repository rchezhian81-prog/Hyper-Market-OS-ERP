import { describe, it, expect } from 'vitest';
import { buildTaxInvoice, taxInvoiceRows, invoiceRenderProblems, taxInvoiceText } from '../../packages/receipt/src/tax-invoice';
import { gstSplitOf, type B2BLine } from '../../packages/b2b/src/documents';

/**
 * **A8 (roadmap v2.1 · IGST Act s.10(1)(a)) — the place of supply decides the tax on the DOCUMENT, not only in a
 * calculator: a counter sale (or a delivery inside Tamil Nadu) carries CGST + SGST; goods delivered to another State carry
 * one IGST at the full rate.** Both legs on the real-trading tax invoice the till prints, and on the B2B tax invoice.
 */

const SHOP = { legalName: 'SRE Hyper Market Private Limited', gstin: '33AABCS1429B1Z1', placeOfBusiness: ['12 Main Road', 'Tiruppur 641601, Tamil Nadu'] };
const base = {
  identity: SHOP, number: 'N-000001', committedAt: '2026-10-23T09:00:00.000Z', laneId: 'lane-1', cashierId: 'u-meena',
  lines: [
    { description: 'Toor dal 1kg', hsnCode: '071360', quantityMinor: 2, uom: 'ea', unitPriceMinor: 10_500, lineTotalMinor: 21_000, taxRateBps: 500 },
    { description: 'Shampoo 200ml', hsnCode: '330510', quantityMinor: 1, uom: 'ea', unitPriceMinor: 11_800, lineTotalMinor: 11_800, taxRateBps: 1_800 },
  ],
};

describe('A8 — the tax invoice: intra-State and inter-State legs', () => {
  it('no delivery State, or Tamil Nadu (33): intra-State, CGST + SGST, no IGST', () => {
    for (const extra of [{}, { placeOfSupplyStateCode: '33' }]) {
      const built = buildTaxInvoice({ ...base, ...extra });
      if (!built.ok) throw new Error(built.laneMessage);
      expect(built.doc.placeOfSupply).toEqual({ kind: 'intra_state', stateCode: '33', stateName: 'Tamil Nadu' });
      expect(built.doc.igstMinor).toBe(0);
      expect(built.doc.lines.every((l) => l.igstMinor === 0 && l.cgstMinor > 0 && l.sgstMinor > 0)).toBe(true);
    }
  });

  it('delivered to Kerala (32): inter-State — one IGST at the full rate per line and band, no CGST or SGST; the paper says so and is complete', () => {
    const built = buildTaxInvoice({ ...base, placeOfSupplyStateCode: '32' });
    if (!built.ok) throw new Error(built.laneMessage);
    const doc = built.doc;
    expect(doc.placeOfSupply).toEqual({ kind: 'inter_state', stateCode: '32', stateName: 'Kerala' });
    expect(doc.cgstMinor + doc.sgstMinor).toBe(0);
    for (const l of doc.lines) {
      expect(l.cgstMinor + l.sgstMinor).toBe(0);
      expect(l.taxableMinor + l.igstMinor).toBe(l.lineTotalMinor);
    }
    expect(doc.bands.map((b) => b.igstMinor)).toEqual(doc.lines.map((l) => l.igstMinor));
    expect(doc.igstExactMinor).toBe(doc.lines.reduce((s, l) => s + l.igstMinor, 0));
    expect(doc.igstMinor % 100).toBe(0); // A10: rounded to the rupee
    expect(doc.totalMinor).toBeLessThanOrEqual(doc.goodsMinor); // OB-285: never above the MRP total
    const rows = taxInvoiceRows(doc);
    expect(invoiceRenderProblems(rows, doc)).toEqual([]);
    const text = taxInvoiceText(rows).join('\n');
    expect(rows.find((r) => r.fields.includes('place_of_supply'))?.text).toBe('Place of supply: Kerala (32) · inter-State supply');
    expect(text).toMatch(/IGST @ 18%/);
    expect(text).not.toMatch(/CGST/);
    // A render that left the IGST off is not a complete invoice.
    expect(invoiceRenderProblems(rows.filter((r) => !r.fields.includes('igst_total')), doc)).toContain('the IGST, rounded to the rupee');
  });

  it('a delivery State that is no GST State is refused before the bill is issued', () => {
    const built = buildTaxInvoice({ ...base, placeOfSupplyStateCode: '99' });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.problems.map((p) => p.code)).toContain('place_of_supply');
  });
});

describe('A8 — the B2B tax invoice: the split by where the goods were delivered', () => {
  const lines: B2BLine[] = [
    { lineId: 'l1', productId: 'p1', description: 'Rice 25kg', qty: 10, unitPriceMinor: 10_000, taxRateBps: 500 },
    { lineId: 'l2', productId: 'p2', description: 'Oil 15L', qty: 5, unitPriceMinor: 20_002, taxRateBps: 500 },
  ];
  it('inside the State: CGST + SGST (the odd paisa on SGST); to another State: IGST; the tax is the same either way', () => {
    const intra = gstSplitOf(lines, { supplierStateCode: '33', deliveryStateCode: '33' });
    const inter = gstSplitOf(lines, { supplierStateCode: '33', deliveryStateCode: '29' });
    expect(intra).toMatchObject({ placeOfSupply: 'intra_state', basis: 'delivery_state', igstMinor: 0 });
    expect(inter).toMatchObject({ placeOfSupply: 'inter_state', deliveryStateCode: '29', cgstMinor: 0, sgstMinor: 0 });
    expect(intra.cgstMinor + intra.sgstMinor).toBe(inter.igstMinor);
    expect(intra.lines[1]).toMatchObject({ cgstMinor: 2_500, sgstMinor: 2_501 });
  });
  it('no delivery State named: the store\'s own State, and the document says it was assumed', () => {
    expect(gstSplitOf(lines, { supplierStateCode: '33' })).toMatchObject({ placeOfSupply: 'intra_state', basis: 'store_state_assumed', deliveryStateCode: '33' });
  });
});
