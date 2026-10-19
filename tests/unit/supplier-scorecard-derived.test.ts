import { describe, it, expect } from 'vitest';
import {
  deriveSupplierScorecard, rejectedAfterCorrection,
  type ScorecardOrder, type ScorecardReceipt, type ScorecardMatchedInvoice,
} from '../../packages/purchasing/src/index';

// D-10 (R4): the supplier scorecard is built from its own purchase orders, goods receipts and matched invoices — fill
// rate, on time in full, lead-time reliability, invoice accuracy, rejection rate; "not rated" with no delivery; a
// corrected receipt replaces its figure and is counted once.

const PO1: ScorecardOrder = {
  poId: 'po-1', supplierId: 's-1', issuedOn: '2026-09-01', cancelledByProduct: {},
  lines: [{ productId: 'p1', orderedQty: 10, unitCostMinor: 500 }, { productId: 'p2', orderedQty: 4, unitCostMinor: 1000 }],
};
const PO2: ScorecardOrder = { poId: 'po-2', supplierId: 's-1', issuedOn: '2026-09-02', cancelledByProduct: {}, lines: [{ productId: 'p3', orderedQty: 5, unitCostMinor: 200 }] };
const GRN1: ScorecardReceipt = { receiptId: 'grn-1', poId: 'po-1', receivedOn: '2026-09-05', lines: [{ lineId: 'L1', productId: 'p1', receivedMinor: 10, rejectedMinor: 0 }, { lineId: 'L2', productId: 'p2', receivedMinor: 2, rejectedMinor: 0 }] };
const GRN2: ScorecardReceipt = { receiptId: 'grn-2', poId: 'po-1', receivedOn: '2026-09-12', lines: [{ lineId: 'L1', productId: 'p2', receivedMinor: 2, rejectedMinor: 2 }] };
const GRN3: ScorecardReceipt = { receiptId: 'grn-3', poId: 'po-2', receivedOn: '2026-09-06', lines: [{ lineId: 'L1', productId: 'p3', receivedMinor: 5, rejectedMinor: 0 }] };
const INV: ScorecardMatchedInvoice[] = [
  { invoiceId: 'inv-1', poId: 'po-1', lines: [{ productId: 'p1', unitPriceMinor: 500 }, { productId: 'p2', unitPriceMinor: 1050 }] },
  { invoiceId: 'inv-2', poId: 'po-2', lines: [{ productId: 'p3', unitPriceMinor: 200 }] },
];
const base = { supplierId: 's-1', from: '2026-09-01', to: '2026-09-30', orders: [PO1, PO2], invoices: INV, agreedLeadTimeDays: 7 };

describe('D-10 — a scorecard from orders, receipts and invoices', () => {
  it('fill rate, on time in full per order line, lead-time spread, invoice accuracy and rejection rate', () => {
    const card = deriveSupplierScorecard({ ...base, receipts: [GRN1, GRN2, GRN3] });
    expect(card.fillRate).toEqual({ kind: 'rated', bp: 10_000 }); // 19 of 19 arrived in the end
    // Due 2026-09-08 (po-1) and 2026-09-09 (po-2): p1 and p3 complete by then, p2 half by then and the rest late.
    expect(card.onTimeInFull).toEqual({ kind: 'rated', bp: 6_667 });
    expect(card.orderLines).toBe(3);
    expect(card.orderLinesOnTimeInFull).toBe(2);
    expect(card.leadTimeReliability).toEqual({ kind: 'rated', bp: 5_088 }); // 4, 11 and 4 days
    expect(card.invoiceAccuracy).toEqual({ kind: 'rated', bp: 6_667 });   // p2 billed ₹10.50 against an agreed ₹10.00
    expect(card.invoiceLinesAboveAgreedPrice).toBe(1);
    expect(card.rejectionRate).toEqual({ kind: 'rated', bp: 1_053 });     // 2 of 19 held back at the dock
    expect(card.deliveries).toBe(3);
    expect(card.sources).toEqual(['purchase_orders', 'goods_receipts', 'matched_invoices']);
    expect(card.summary).toMatch(/1 of 3 invoice line\(s\) billed above the agreed price/);
  });

  it('a corrected receipt replaces its figure, and a receipt seen twice is counted once', () => {
    const accepted: ScorecardReceipt = { ...GRN2, lines: [{ ...GRN2.lines[0]!, disposition: { kind: 'accept', quantityMinor: 2 } }] };
    const card = deriveSupplierScorecard({ ...base, receipts: [GRN1, GRN1, GRN2, accepted, GRN3] });
    expect(card.deliveries).toBe(3);
    expect(card.rejectionRate).toEqual({ kind: 'rated', bp: 0 });
    expect(card.fillRate).toEqual({ kind: 'rated', bp: 10_000 });
    expect(rejectedAfterCorrection({ lineId: 'x', productId: 'p', receivedMinor: 5, rejectedMinor: 5, disposition: { kind: 'return', quantityMinor: 5 } })).toBe(5);
    expect(rejectedAfterCorrection({ lineId: 'x', productId: 'p', receivedMinor: 5, rejectedMinor: 5 })).toBe(5);
  });

  it('a supplier with no delivery in the period reads "not rated", never a score', () => {
    const card = deriveSupplierScorecard({ ...base, receipts: [] });
    for (const r of [card.fillRate, card.onTimeInFull, card.leadTimeReliability, card.invoiceAccuracy, card.rejectionRate]) {
      expect(r).toEqual({ kind: 'not_rated', because: 'no delivery in the period' });
    }
    expect(card.ordersWithNothingReceived).toEqual(['po-1', 'po-2']);
    expect(card.summary).toMatch(/^not rated/);
    // A delivery outside the period does not rate it either.
    expect(deriveSupplierScorecard({ ...base, from: '2026-10-01', to: '2026-10-31', receipts: [GRN1] }).fillRate.kind).toBe('not_rated');
  });

  it('a short order is named, cancellations are not held against the supplier, and no contract leaves OTIF not rated', () => {
    const PO3: ScorecardOrder = { poId: 'po-3', supplierId: 's-1', issuedOn: '2026-09-03', cancelledByProduct: { p9: 2 }, lines: [{ productId: 'p9', orderedQty: 6, unitCostMinor: 100 }] };
    const { agreedLeadTimeDays: _unused, ...noContract } = base;
    void _unused;
    const card = deriveSupplierScorecard({ ...noContract, orders: [PO1, PO2, PO3], receipts: [GRN1, GRN3] });
    expect(card.ordersWithNothingReceived).toEqual(['po-3']);
    expect(card.fillRate).toEqual({ kind: 'rated', bp: Math.round((17 * 10_000) / 23) }); // 10+2+5 of 10+4+5+4
    expect(card.onTimeInFull).toMatchObject({ kind: 'not_rated', because: expect.stringMatching(/no agreed lead time/) });
    // Another supplier's orders and receipts are never counted.
    const other = deriveSupplierScorecard({ ...base, supplierId: 's-2', receipts: [GRN1] });
    expect(other.deliveries).toBe(0);
    expect(other.fillRate.kind).toBe('not_rated');
  });

  it('compares price per whole unit when a price buys several units (OB-46)', () => {
    const PO4: ScorecardOrder = { poId: 'po-4', supplierId: 's-1', issuedOn: '2026-09-01', cancelledByProduct: {}, lines: [{ productId: 'p4', orderedQty: 24, unitCostMinor: 25_000, unitCostPer: 24 }] };
    const G: ScorecardReceipt = { receiptId: 'g4', poId: 'po-4', receivedOn: '2026-09-02', lines: [{ lineId: 'L', productId: 'p4', receivedMinor: 24, rejectedMinor: 0 }] };
    const ok = deriveSupplierScorecard({ ...base, orders: [PO4], receipts: [G], invoices: [{ invoiceId: 'i4', poId: 'po-4', lines: [{ productId: 'p4', unitPriceMinor: 25_000, unitPricePer: 24 }] }] });
    expect(ok.invoiceAccuracy).toEqual({ kind: 'rated', bp: 10_000 });
    const dear = deriveSupplierScorecard({ ...base, orders: [PO4], receipts: [G], invoices: [{ invoiceId: 'i4', poId: 'po-4', lines: [{ productId: 'p4', unitPriceMinor: 1_100 }] }] });
    expect(dear.invoiceAccuracy).toEqual({ kind: 'rated', bp: 0 }); // ₹11.00 each against ₹250 ÷ 24 = ₹10.42
    const none = deriveSupplierScorecard({ ...base, orders: [PO4], receipts: [G], invoices: [] });
    expect(none.invoiceAccuracy).toEqual({ kind: 'not_rated', because: 'no matched invoice in the period' });
  });
});
