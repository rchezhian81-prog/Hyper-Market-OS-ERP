import { describe, it, expect } from 'vitest';
import { priceLine, sumLines } from '../../packages/pricing/src/index';
import { money } from '../../packages/contracts/src/money';
import { quantity } from '../../packages/contracts/src/quantity';
import { rate } from '../../packages/contracts/src/rate';

// Line pricing composes Money × Quantity × Rate into the core billing sum, exact
// to the paisa. Values are in minor units (paise): 100_00 = ₹100.00.

describe('priceLine', () => {
  it('prices a discrete line with tax (3 × ₹10.00, 18% GST)', () => {
    const line = priceLine({
      unitPrice: money(10_00, 'INR'),
      quantity: quantity(3, 'ea'),
      taxRate: rate(1800),
    });
    expect(line.gross.minor).toBe(30_00);
    expect(line.discount.minor).toBe(0);
    expect(line.net.minor).toBe(30_00);
    expect(line.tax.minor).toBe(5_40);
    expect(line.total.minor).toBe(35_40);
  });

  it('prices a weighed line with discount and tax (1.5 kg × ₹40.00/kg, 10% off, 5% GST)', () => {
    const line = priceLine({
      unitPrice: money(40_00, 'INR'),
      quantity: quantity(1_500, 'kg'), // 1.500 kg = 1500 grams
      discountRate: rate(1000), // 10%
      taxRate: rate(500), // 5%
    });
    expect(line.gross.minor).toBe(60_00);
    expect(line.discount.minor).toBe(6_00);
    expect(line.net.minor).toBe(54_00);
    expect(line.tax.minor).toBe(2_70);
    expect(line.total.minor).toBe(56_70);
  });

  it('rounds a fractional weighed gross exactly once (half-up default)', () => {
    // 0.333 kg × ₹99.99/kg = 3329.667 paise → 3330
    const line = priceLine({
      unitPrice: money(99_99, 'INR'),
      quantity: quantity(333, 'kg'),
      taxRate: rate(0),
    });
    expect(line.gross.minor).toBe(33_30);
    expect(line.total.minor).toBe(33_30); // 0% tax
  });

  it('keeps the internal invariants (gross = net + discount, total = net + tax)', () => {
    const line = priceLine({
      unitPrice: money(7_77, 'INR'),
      quantity: quantity(2, 'ea'),
      discountRate: rate(1234),
      taxRate: rate(1800),
    });
    expect(line.net.minor + line.discount.minor).toBe(line.gross.minor);
    expect(line.net.minor + line.tax.minor).toBe(line.total.minor);
    expect(line.total.currency).toBe('INR');
  });
});

describe('sumLines (bill totals)', () => {
  it('sums priced lines into bill totals', () => {
    const a = priceLine({ unitPrice: money(10_00, 'INR'), quantity: quantity(2, 'ea'), taxRate: rate(1800) });
    const b = priceLine({ unitPrice: money(5_00, 'INR'), quantity: quantity(1, 'ea'), taxRate: rate(1800) });
    const bill = sumLines([a, b], 'INR');
    expect(bill.net.minor).toBe(25_00); // 20.00 + 5.00
    expect(bill.tax.minor).toBe(4_50); // 3.60 + 0.90
    expect(bill.total.minor).toBe(29_50);
  });

  it('an empty bill totals to zero in the given currency', () => {
    const bill = sumLines([], 'INR');
    expect(bill.total.minor).toBe(0);
    expect(bill.total.currency).toBe('INR');
  });

  it('rejects mixing currencies in one bill', () => {
    const inr = priceLine({ unitPrice: money(10_00, 'INR'), quantity: quantity(1, 'ea'), taxRate: rate(0) });
    expect(() => sumLines([inr], 'USD')).toThrow(TypeError);
  });
});
