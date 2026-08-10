import { describe, it, expect } from 'vitest';
import { assessDiscountEligibility, InvalidDiscountInput } from '../../packages/finance/src/discount';

// Roadmap v2.1 A11 — CGST s.15(3) discount eligibility. A discount reduces the GST taxable value ONLY
// when it is on the invoice (given at/before supply), OR — after supply — it is pre-agreed AND linked
// to the specific invoices AND the recipient has reversed the proportionate ITC. Anything else is a
// commercial discount only: money off the price, tax stays on the pre-discount value.

const d = (over: Partial<Parameters<typeof assessDiscountEligibility>[0]> = {}) =>
  assessDiscountEligibility({ discountMinor: 10_00, onInvoice: false, ...over });

describe('assessDiscountEligibility — A11 / CGST s.15(3)', () => {
  it('a discount ON the invoice reduces the taxable value (s.15(3)(a))', () => {
    const r = d({ onInvoice: true });
    expect(r.reducesTaxableValue).toBe(true);
    expect(r.basis).toBe('on_invoice');
    expect(r.eligibleReductionMinor).toBe(10_00);
  });

  it('a post-supply discount reduces the taxable value only when pre-agreed AND invoice-linked AND ITC reversed (s.15(3)(b))', () => {
    const r = d({ onInvoice: false, preAgreed: true, invoiceLinked: true, itcReversed: true });
    expect(r.reducesTaxableValue).toBe(true);
    expect(r.basis).toBe('post_supply_agreement');
    expect(r.eligibleReductionMinor).toBe(10_00);
  });

  it('a post-supply discount missing ANY of the three conditions does NOT reduce the taxable value', () => {
    // Each of the three, dropped in turn — none alone is enough.
    for (const missing of ['preAgreed', 'invoiceLinked', 'itcReversed'] as const) {
      const all = { onInvoice: false, preAgreed: true, invoiceLinked: true, itcReversed: true };
      const r = d({ ...all, [missing]: false });
      expect(r.reducesTaxableValue, `missing ${missing}`).toBe(false);
      expect(r.basis).toBe('not_eligible');
      expect(r.eligibleReductionMinor).toBe(0); // the discount is commercial only — GST stays on the gross
    }
  });

  it('a bare post-supply discount (no conditions) is commercial only', () => {
    const r = d({ onInvoice: false });
    expect(r.reducesTaxableValue).toBe(false);
    expect(r.eligibleReductionMinor).toBe(0);
    expect(r.detail).toContain('commercial discount only');
  });

  it('on-invoice wins even if the post-supply flags are absent', () => {
    expect(d({ onInvoice: true, preAgreed: false, invoiceLinked: false, itcReversed: false }).reducesTaxableValue).toBe(true);
  });

  it('refuses a negative or non-whole discount', () => {
    expect(() => d({ discountMinor: -1 })).toThrow(InvalidDiscountInput);
    expect(() => d({ discountMinor: 10.5 })).toThrow(InvalidDiscountInput);
  });
});
