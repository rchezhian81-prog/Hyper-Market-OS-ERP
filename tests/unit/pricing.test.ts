import { describe, it, expect } from 'vitest';
import { priceLine, sumLines, splitInclusive } from '../../packages/pricing/src/index';
import { extractInclusiveGst } from '../../packages/finance/src/inclusive-tax';
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

describe('priceLine with the tax INSIDE the price (pricesIncludeTax — a retail shelf price, A9 / F15)', () => {
  it('charges the shelf price and pulls the GST out of it: ₹480 at 5% → ₹457.14 taxable + ₹22.86 GST = ₹480.00', () => {
    const line = priceLine({ unitPrice: money(48_000, 'INR'), quantity: quantity(1, 'ea'), taxRate: rate(500), pricesIncludeTax: true });
    expect(line.gross.minor).toBe(48_000);
    expect(line.total.minor).toBe(48_000); // what the customer pays IS the price — never above the MRP
    expect(line.net.minor).toBe(45_714); // 48000 × 10000 / 10500 = 45714.28… → half-up
    expect(line.tax.minor).toBe(2_286); // the remainder
    expect(line.net.minor + line.tax.minor).toBe(line.total.minor);
  });

  it('agrees with the finance package\'s inclusive-GST extraction to the paisa, rate by rate', () => {
    for (const [priceMinor, bps] of [[48_000, 500], [10_000, 1800], [9_872, 1800], [7_77, 1200], [1_00_000, 2800], [5_000, 0]] as const) {
      const line = priceLine({ unitPrice: money(priceMinor, 'INR'), quantity: quantity(1, 'ea'), taxRate: rate(bps), pricesIncludeTax: true });
      const finance = extractInclusiveGst({ mrpMinor: priceMinor, rateBps: bps, placeOfSupply: 'intra_state' });
      expect({ net: line.net.minor, tax: line.tax.minor, total: line.total.minor })
        .toEqual({ net: finance.taxableMinor, tax: finance.totalTaxMinor, total: finance.grossMinor });
    }
  });

  it('takes a discount off the inclusive price and extracts the GST from what is actually charged (1.5 kg × ₹40/kg, 10% off, 5%)', () => {
    const line = priceLine({
      unitPrice: money(40_00, 'INR'), quantity: quantity(1_500, 'kg'), discountRate: rate(1000), taxRate: rate(500), pricesIncludeTax: true,
    });
    expect(line.gross.minor).toBe(60_00);
    expect(line.discount.minor).toBe(6_00);
    expect(line.total.minor).toBe(54_00); // gross − discount: the customer pays ₹54.00
    expect(line.net.minor).toBe(51_43); // 5400 × 10000 / 10500 = 5142.857… → ₹51.43 taxable
    expect(line.tax.minor).toBe(2_57);
  });

  it('keeps the inclusive invariants (total = gross − discount = net + tax) and a nil rate has no tax', () => {
    const line = priceLine({ unitPrice: money(7_77, 'INR'), quantity: quantity(3, 'ea'), discountRate: rate(1234), taxRate: rate(1800), pricesIncludeTax: true });
    expect(line.total.minor).toBe(line.gross.minor - line.discount.minor);
    expect(line.net.minor + line.tax.minor).toBe(line.total.minor);
    const nil = priceLine({ unitPrice: money(99_99, 'INR'), quantity: quantity(333, 'kg'), taxRate: rate(0), pricesIncludeTax: true });
    expect(nil).toMatchObject({ gross: money(33_30, 'INR'), net: money(33_30, 'INR'), tax: money(0, 'INR'), total: money(33_30, 'INR') });
  });

  it('splitInclusive on its own: the taxable value and the tax inside an amount, summing back exactly', () => {
    const split = splitInclusive(money(29_000, 'INR'), rate(1800)); // ₹290 charged after a ₹10 promotion
    expect(split.net.minor).toBe(24_576); // 29000 × 10000 / 11800 = 24576.27… → ₹245.76
    expect(split.tax.minor).toBe(4_424);
    expect(split.net.minor + split.tax.minor).toBe(29_000);
  });

  it('the default stays tax-EXCLUSIVE, so a purchase line is unchanged by the option\'s absence', () => {
    const line = priceLine({ unitPrice: money(48_000, 'INR'), quantity: quantity(1, 'ea'), taxRate: rate(500) });
    expect(line.total.minor).toBe(50_400);
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
