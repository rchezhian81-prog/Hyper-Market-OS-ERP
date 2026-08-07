// Salesperson commission (M22-FR-03) — computed with EXACT money (no float). A
// commission is a basis-points rate applied to a commissionable base, rounded to
// whole minor units via the shared exact fractional multiply (scaleMoney), with an
// optional cap. Pure and deterministic.

import { scaleMoney, money, compare, type Money } from '../../contracts/src/money';

export class InvalidCommissionRateError extends Error {
  constructor(bps: number) {
    super(`Commission rate must be an integer 0–10000 bps, got ${bps}.`);
    this.name = 'InvalidCommissionRateError';
  }
}

/**
 * Commission on a base amount at `rateBps` basis points (1000 = 10%), rounded to
 * whole minor units (half-up). An optional `capMinor` limits the payout. Exact.
 */
export function computeCommission(base: Money, rateBps: number, capMinor?: number): Money {
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
    throw new InvalidCommissionRateError(rateBps);
  }
  const commission = scaleMoney(base, rateBps, 10_000, 'half_up');
  if (capMinor !== undefined) {
    const cap = money(capMinor, base.currency);
    if (compare(commission, cap) > 0) return cap;
  }
  return commission;
}
