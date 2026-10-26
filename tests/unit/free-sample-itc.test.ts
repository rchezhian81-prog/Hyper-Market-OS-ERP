import { describe, it, expect } from 'vitest';
import { freeSampleItc, returnMonthFor, gstr3bPeriodOf, nextMonth, type PurchaseTaxLine } from '../../packages/input-tax/src/free-sample-itc';
import { itcWords } from '../../services/inventory/src/free-samples';

// FG-4 · A12 (1) · OB-386: the GST credit a free sample gives back, from its buying cost, at the heads and rate of the
// latest bill that charged the product; not computed (and said why) when the cost or the bill is missing — never a zero.

const bill = (over: Partial<PurchaseTaxLine>): PurchaseTaxLine => ({ invoiceId: 'B1', capturedAt: '2026-10-01T10:00:00Z', productId: 'rice', lineTotalMinor: 50_000, cgstMinor: 1_250, sgstMinor: 1_250, ...over });

describe('free-sample ITC give-back (A12 (1) · OB-386)', () => {
  it('applies the latest bill\'s heads to the buying value', () => {
    const bills = [bill({}), bill({ invoiceId: 'B2', capturedAt: '2026-10-10T10:00:00Z', cgstMinor: undefined, sgstMinor: undefined, igstMinor: 9_000 })];
    expect(freeSampleItc({ productId: 'rice', buyingValueMinor: 10_000, bills })).toEqual({ state: 'computed', fromInvoiceId: 'B2', buyingValueMinor: 10_000, cgstMinor: 0, sgstMinor: 0, igstMinor: 1_800, cessMinor: 0 });
    expect(freeSampleItc({ productId: 'rice', buyingValueMinor: 333, bills: [bill({})] })).toMatchObject({ cgstMinor: 8, sgstMinor: 8 }); // 8.325 → 8
  });

  it('never a zero for a gap: no cost, no bill; a bill with no GST gives back nothing and says so', () => {
    expect(freeSampleItc({ productId: 'rice', buyingValueMinor: undefined, bills: [bill({})] })).toEqual({ state: 'not_computed', why: 'no_buying_cost', buyingValueMinor: null });
    expect(freeSampleItc({ productId: 'dal', buyingValueMinor: 100, bills: [bill({})] })).toEqual({ state: 'not_computed', why: 'no_bill_for_the_product', buyingValueMinor: 100 });
    expect(freeSampleItc({ productId: 'rice', buyingValueMinor: 100, bills: [bill({ cgstMinor: 0, sgstMinor: 0 })] })).toEqual({ state: 'no_gst_on_the_bill', fromInvoiceId: 'B1', buyingValueMinor: 100 });
  });

  it('goes into the issue\'s month, or the first later month whose GSTR-3B is not locked', () => {
    expect(gstr3bPeriodOf('2026-10')).toBe('102026');
    expect([nextMonth('2026-10'), nextMonth('2026-12')]).toEqual(['2026-11', '2027-01']);
    expect(returnMonthFor('2026-10', new Set())).toEqual({ month: '2026-10' });
    expect(returnMonthFor('2026-12', new Set(['122026', '012027']))).toEqual({ month: '2027-02', movedFrom: '2026-12' });
  });

  it('says it in words the accountant reads', () => {
    expect(itcWords({ itc: { state: 'computed', fromInvoiceId: 'B1', buyingValueMinor: 10_000, cgstMinor: 250, sgstMinor: 250, igstMinor: 0, cessMinor: 0 }, returnMonth: '2026-11', movedFrom: '2026-10' }))
      .toBe('₹5.00 (CGST ₹2.50, SGST ₹2.50) on a buying value of ₹100.00, at the rate of bill B1; in the 2026-11 return (the 2026-10 return was already locked).');
    expect(itcWords({ itc: { state: 'no_gst_on_the_bill', fromInvoiceId: 'B1', buyingValueMinor: 1 } })).toMatch(/^Nothing to give back/);
  });
});
