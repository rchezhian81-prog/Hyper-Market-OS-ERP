import { describe, it, expect } from 'vitest';
import {
  buildReceipt, renderText, cashierShown, buildTaxInvoice, taxInvoiceRows, taxInvoiceText, invoiceRenderProblems,
  type BuildReceiptInput, type TaxInvoiceInput,
} from '../../packages/receipt/src/index';
import { returnableWords } from '../../apps/pos/src/refund-view';

/**
 * **Daily-work walkthrough D-006 and D-004 — the words, below the screen.**
 *
 *   • D-006: the bill names the cashier by the display NAME the people register gave ("Till: Lane Cashier"); with no name
 *     known (absent or blank) it prints the login id, as before. The plain receipt and the tax invoice both. Words only:
 *     the document still carries the staff CODE.
 *   • D-004: what may still come back reads in its unit — "0.850 kg" for 850 g of a kg product, "3" for a count.
 *
 * Synthetic data only. (The cashier's own steps are proven in a real browser: tests/e2e/the-served-till-daily-work-d002-d004-d006.e2e.ts.)
 */

const RECEIPT: BuildReceiptInput = {
  number: 'S-0001', saleId: 'sale-1', tradingDay: '2026-11-15', committedAt: '2026-11-15T06:00:00Z', laneId: 'lane-1', cashierId: 'pilot-cashier',
  currency: 'INR', lines: [{ description: 'Curd 400g', quantityMinor: 1, uom: 'ea', unitPriceMinor: 4_500, lineTotalMinor: 4_500 }],
  taxBands: [{ rateBps: 0, netMinor: 4_500, taxMinor: 0 }], netMinor: 4_500, taxMinor: 0, totalMinor: 4_500,
  tenders: [{ kind: 'cash', amountMinor: 4_500 }], header: [], footer: [],
};

const SHOP = { legalName: 'Demo Shop Private Limited', gstin: '33ABCDE1234F1Z5', placeOfBusiness: ['12 Main Road', 'Tiruppur 641601, Tamil Nadu'] };
const INVOICE: TaxInvoiceInput = {
  identity: SHOP, number: 'L1-000123', committedAt: '2026-11-15T06:00:00.000Z', laneId: 'lane-1', cashierId: 'pilot-cashier',
  lines: [{ description: 'Toor dal 1kg', hsnCode: '071360', quantityMinor: 1, uom: 'ea', unitPriceMinor: 10_000, lineTotalMinor: 10_000, taxRateBps: 0 }],
  tenders: [{ kind: 'cash', amountMinor: 10_000 }],
};

describe('D-006 — the bill prints the cashier\'s name, not the login id', () => {
  it('the receipt reads "Till: Lane Cashier" when the name is known, and still carries the code on the document', () => {
    const doc = buildReceipt({ ...RECEIPT, cashierName: 'Lane Cashier' });
    const text = renderText(doc, 48).join('\n');
    expect(text).toMatch(/Till: Lane Cashier$/m);
    expect(text).not.toContain('pilot-cashier');
    expect(doc.cashierId).toBe('pilot-cashier');
  });

  it('with no name known — absent, blank, or spaces — the login id, as before', () => {
    expect(renderText(buildReceipt(RECEIPT), 48).join('\n')).toMatch(/Till: pilot-cashier$/m);
    expect(renderText(buildReceipt({ ...RECEIPT, cashierName: '   ' }), 48).join('\n')).toMatch(/Till: pilot-cashier$/m);
    expect(cashierShown('pilot-cashier', undefined)).toBe('pilot-cashier');
    expect(cashierShown('pilot-cashier', ' Ravi ')).toBe('Ravi');
  });

  it('the tax invoice says "Cashier Lane Cashier" (and in Tamil "காசாளர் Lane Cashier"); no name → the id; the render stays complete', () => {
    const built = buildTaxInvoice(INVOICE);
    if (!built.ok) throw new Error(built.laneMessage);
    const named = taxInvoiceRows(built.doc, { cashierName: 'Lane Cashier' });
    expect(taxInvoiceText(named).join('\n')).toContain('Till lane-1 · Cashier Lane Cashier');
    expect(taxInvoiceText(taxInvoiceRows(built.doc, { cashierName: 'Lane Cashier', language: 'ta' })).join('\n')).toContain('காசாளர் Lane Cashier');
    expect(invoiceRenderProblems(named, built.doc)).toEqual([]);
    expect(taxInvoiceText(taxInvoiceRows(built.doc)).join('\n')).toContain('Cashier pilot-cashier');
  });
});

describe('D-004 — what may come back reads in its unit', () => {
  it('850 g of a kg product is "0.850 kg"; 1250 g is "1.250 kg"; a count stays a count; a litre product reads in L', () => {
    expect(returnableWords(850, 'kg')).toBe('0.850 kg');
    expect(returnableWords(1_250, 'KG')).toBe('1.250 kg');
    expect(returnableWords(3, 'ea')).toBe('3');
    expect(returnableWords(500, 'L')).toBe('0.500 L');
  });
});
