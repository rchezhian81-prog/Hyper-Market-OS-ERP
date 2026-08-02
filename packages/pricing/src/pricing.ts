// Line pricing — composes the exact-maths primitives (Money, Quantity, Rate) into
// the core billing calculation for one sale/purchase line (M12 POS, M05 pricing,
// M23 tax). Everything is exact integer minor units; the only rounding is a single
// explicit step per money result. Pure and deterministic.
//
//   gross    = unit price × quantity
//   discount = gross × discount rate         (0 if no discount)
//   net      = gross − discount
//   tax      = net × tax rate
//   total    = net + tax

import { scaleMoney, add, subtract, zero, type Money, type Rounding } from '../../contracts/src/money';
import { applyRate, type Rate } from '../../contracts/src/rate';
import { precisionOf, type Quantity } from '../../contracts/src/quantity';

export interface LinePricingInput {
  /** Price of one UOM unit (per each, per kg, …), in the line's currency. */
  readonly unitPrice: Money;
  readonly quantity: Quantity;
  /** Optional line discount. */
  readonly discountRate?: Rate;
  /** Tax rate applied to the net (e.g. GST). */
  readonly taxRate: Rate;
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
  const net = subtract(gross, discount);
  const tax = applyRate(net, input.taxRate, rounding);
  const total = add(net, tax);
  return { gross, discount, net, tax, total };
}
