// CR-01 OI-13-A12 (OB-763 B) — the supplier-bill match explainer's rule (packages/purchasing/src/bill-mismatch-explainer.ts).
//
// Acceptance (docs/requirements/CR-01-OI-13-A12-supplier-bill-match-explainer.md):
//   AC-1 a bill whose latest match is clean gets NO explanation (nothing to explain is not a draft);
//   AC-2 each difference is one plain sentence naming the product and the figures it came from (billed vs received,
//        bill price vs order price, billed beyond the order, no order / order not issued / another supplier, nothing to compare);
//   AC-3 the money held back is said, and a supplier query is drafted only for what the SUPPLIER must correct;
//   AC-4 it never says the bill was paid, approved, or a debit note issued — it drafts, a person decides.
// Synthetic data only.
import { describe, it, expect } from 'vitest';
import { explainBillMismatch, inRupees, type BillMatchFacts } from '../../packages/purchasing/src/bill-mismatch-explainer';

const base: BillMatchFacts = {
  invoiceId: 'INV-DF-101', supplierId: 'sup-demo-foods', poId: 'po-demo-1', matchedAt: '2026-11-18T09:00:00.000Z',
  blocked: false, invoicedMinor: 60_000, payableMinor: 60_000, withheldMinor: 0,
  lines: [{ productId: 'p-marie', status: 'matched', quantityDifference: 0, priceDifferenceMinor: 0, payableMinor: 60_000 }],
  flags: [],
};

describe('A12 supplier-bill match explainer — the rule', () => {
  it('AC-1: a clean match is not explained (no draft)', () => {
    expect(explainBillMismatch(base)).toBeNull();
  });

  it('AC-2/3: billed more than received and a higher price — one sentence each, with the figures, and a supplier query', () => {
    const x = explainBillMismatch({
      ...base, blocked: true, invoicedMinor: 62_400, payableMinor: 57_600, withheldMinor: 4_800,
      lines: [{ productId: 'p-oil', status: 'blocked', quantityDifference: 2, priceDifferenceMinor: 1_200, payableMinor: 57_600 }],
      invoiceLines: [{ productId: 'p-oil', quantity: 50, unitPriceMinor: 1_248 }],
    });
    expect(x).not.toBeNull();
    const codes = x!.reasons.map((r) => r.code);
    expect(codes).toEqual(['billed_more_than_received', 'price_higher_than_order']);
    expect(x!.reasons[0]!.sentence).toBe('p-oil: the bill says 50, we received 48 — 2 more billed than received.');
    expect(x!.reasons[1]!.sentence).toBe('p-oil: the bill price is ₹12.00 a unit higher than the order.');
    expect(x!.heldBackMinor).toBe(4_800);
    expect(x!.needsAPerson).toBe(true);
    expect(x!.summary).toContain('INV-DF-101');
    expect(x!.summary).toContain('₹48.00 held back');
    expect(x!.supplierQuery).toContain('INV-DF-101');
    expect(x!.supplierQuery).toContain('2 more billed than received');
    expect(x!.supplierQuery).toContain('corrected bill or a credit note for ₹48.00');
  });

  it('AC-2: billed fewer than received, and a lower price, are said — but they are not the supplier\'s to correct', () => {
    const x = explainBillMismatch({
      ...base, blocked: false, invoicedMinor: 9_000, payableMinor: 9_000, withheldMinor: 0,
      lines: [{ productId: 'p-salt', status: 'within_tolerance', quantityDifference: -1, priceDifferenceMinor: -50, payableMinor: 9_000 }],
    });
    expect(x!.reasons.map((r) => r.code)).toEqual(['billed_less_than_received', 'price_lower_than_order', 'within_tolerance']);
    expect(x!.reasons[0]!.sentence).toBe('p-salt: 1 fewer billed than received — the supplier may send a second bill for the rest.');
    expect(x!.supplierQuery).toBeNull();
    expect(x!.needsAPerson).toBe(false);
  });

  it('AC-2: the order-level reasons — no order, order not issued, another supplier, billed beyond the order, nothing to compare', () => {
    const none = explainBillMismatch({ ...base, poId: null, blocked: true, lines: [], invoicedMinor: 0, payableMinor: 0, flags: ['no_purchase_order'] });
    expect(none!.reasons.map((r) => r.code)).toEqual(['no_purchase_order', 'nothing_to_compare']);
    const notIssued = explainBillMismatch({ ...base, blocked: true, lines: [], invoicedMinor: 0, payableMinor: 0, flags: ['order_not_issued'] });
    expect(notIssued!.reasons[0]!.sentence).toBe('Order po-demo-1 was not issued when the bill was matched, so nothing on the bill can be paid against it yet.');
    const other = explainBillMismatch({ ...base, flags: ['supplier_differs_from_order', 'order_over_invoiced'] });
    expect(other!.reasons.map((r) => r.code)).toEqual(['supplier_differs_from_order', 'billed_more_than_ordered']);
    const unknown = explainBillMismatch({ ...base, blocked: true, lines: [], invoicedMinor: 0, payableMinor: 0, flags: ['invoice_unknown'] });
    expect(unknown!.reasons.map((r) => r.code)).toEqual(['bill_not_on_file', 'nothing_to_compare']);
  });

  it('AC-4: it drafts — it never claims to have paid, approved, issued or written anything off', () => {
    const x = explainBillMismatch({
      ...base, blocked: true, invoicedMinor: 62_400, payableMinor: 57_600, withheldMinor: 4_800,
      lines: [{ productId: 'p-oil', status: 'blocked', quantityDifference: 2, priceDifferenceMinor: 1_200, payableMinor: 57_600 }],
    })!;
    const words = [x.summary, x.supplierQuery ?? '', ...x.reasons.map((r) => r.sentence)].join(' ').toLowerCase();
    for (const claim of ['has been paid', 'approved', 'debit note issued', 'written off', 'i have']) expect(words).not.toContain(claim);
    expect(x.summary.toLowerCase()).toContain('a person decides');
  });

  it('rupees are written the Indian way', () => {
    expect(inRupees(12_345_678)).toBe('₹1,23,456.78');
    expect(inRupees(-4_800)).toBe('−₹48.00');
    expect(inRupees(5)).toBe('₹0.05');
  });
});
