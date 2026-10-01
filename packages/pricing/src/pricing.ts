// Line pricing — composes the exact-maths primitives (Money, Quantity, Rate) into
// the core billing calculation for one sale/purchase line (M12 POS, M05 pricing,
// M23 tax). Everything is exact integer minor units; the only rounding is a single
// explicit step per money result. Pure and deterministic.
//
// A price EXCLUSIVE of tax (the default — a purchase line, a B2B quote):
//
//   gross    = unit price × quantity
//   discount = gross × discount rate         (0 if no discount)
//   net      = gross − discount
//   tax      = net × tax rate
//   total    = net + tax
//
// A price INCLUSIVE of tax (`pricesIncludeTax: true` — a retail shelf price, which by Legal
// Metrology is the MRP or below with the GST already inside it; roadmap addendum A9):
//
//   gross    = unit price × quantity          (tax already inside)
//   discount = gross × discount rate
//   total    = gross − discount               (what the customer pays — never more than the price)
//   net      = total × 10000 / (10000 + rate) (the taxable value, rounded once)
//   tax      = total − net                    (the remainder, so net + tax == total to the paisa)
//
// The two never mix on one line: a line is priced one way or the other, and the invariant that
// holds in BOTH modes is `total == net + tax`. Audit finding F15 (1 Oct 2026) was the till adding
// the GST on top of an inclusive shelf price and charging above the MRP — the inclusive mode is
// how a retail till prices, and `apps/pos/src/session.ts` uses nothing else.

import {
  scaleMoney,
  add,
  subtract,
  zero,
  type Money,
  type Rounding,
  type CurrencyCode,
} from '../../contracts/src/money';
import { applyRate, type Rate } from '../../contracts/src/rate';
import { precisionOf, type Quantity } from '../../contracts/src/quantity';

export interface LinePricingInput {
  /** Price of one UOM unit (per each, per kg, …), in the line's currency. */
  readonly unitPrice: Money;
  readonly quantity: Quantity;
  /** Optional line discount. */
  readonly discountRate?: Rate;
  /** Tax rate applied to the net (e.g. GST) — or, when `pricesIncludeTax`, the rate EXTRACTED from the price. */
  readonly taxRate: Rate;
  /**
   * The unit price already carries the tax (a retail shelf price / MRP, A9): the customer pays `gross − discount`
   * and the taxable value and tax are pulled OUT of that amount. Default false: tax is added on top of the net.
   */
  readonly pricesIncludeTax?: boolean;
  /** Rounding for every money result (default half-up). */
  readonly rounding?: Rounding;
}

export interface LinePricing {
  readonly gross: Money;
  readonly discount: Money;
  readonly net: Money;
  readonly tax: Money;
  readonly total: Money;
}

/**
 * Price one line. The quantity is applied as an exact fraction of its UOM's
 * smallest unit (e.g. 1.234 kg = 1234 grams / 1000), so weighed goods price
 * exactly, with one rounding step.
 */
export function priceLine(input: LinePricingInput): LinePricing {
  const rounding: Rounding = input.rounding ?? 'half_up';
  const denominator = 10 ** precisionOf(input.quantity.uom);
  const gross = scaleMoney(input.unitPrice, input.quantity.minor, denominator, rounding);
  const discount = input.discountRate
    ? applyRate(gross, input.discountRate, rounding)
    : zero(gross.currency);
  if (input.pricesIncludeTax === true) {
    const total = subtract(gross, discount);
    const { net, tax } = splitInclusive(total, input.taxRate, rounding);
    return { gross, discount, net, tax, total };
  }
  const net = subtract(gross, discount);
  const tax = applyRate(net, input.taxRate, rounding);
  const total = add(net, tax);
  return { gross, discount, net, tax, total };
}

/** The taxable value and the tax inside a tax-inclusive amount. */
export interface InclusiveSplit {
  /** The taxable value: `total × 10000 / (10000 + rate bps)`, rounded once. */
  readonly net: Money;
  /** The tax: the remainder, so `net + tax == total` to the paisa by construction. */
  readonly tax: Money;
}

/**
 * Pull the tax OUT of an amount that already includes it (A9: given an inclusive price and a rate, taxable
 * value + tax reconcile to the price to the paisa). The same arithmetic as the finance package's
 * `extractInclusiveGst`, on Money, so the till, the day book and the GST return agree on every paisa.
 */
export function splitInclusive(total: Money, taxRate: Rate, rounding: Rounding = 'half_up'): InclusiveSplit {
  const net = scaleMoney(total, 10_000, 10_000 + taxRate.bps, rounding);
  return { net, tax: subtract(total, net) };
}

/** Bill-level totals across many priced lines. */
export interface BillTotals {
  readonly gross: Money;
  readonly discount: Money;
  readonly net: Money;
  readonly tax: Money;
  readonly total: Money;
}

/**
 * Sum priced lines into bill totals. Single-currency by construction (`add`
 * rejects a line in a different currency); an empty bill totals to zero.
 */
export function sumLines(lines: readonly LinePricing[], currency: CurrencyCode): BillTotals {
  let gross = zero(currency);
  let discount = zero(currency);
  let net = zero(currency);
  let tax = zero(currency);
  let total = zero(currency);
  for (const line of lines) {
    gross = add(gross, line.gross);
    discount = add(discount, line.discount);
    net = add(net, line.net);
    tax = add(tax, line.tax);
    total = add(total, line.total);
  }
  return { gross, discount, net, tax, total };
}
