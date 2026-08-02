// Rate — an exact proportional rate (discount, tax, margin) applied to Money.
//
// Requirement: pricing (M05) and tax (M23) need exact percentage maths with a
// defined rounding rule (§29.1 — money is never a float). A Rate is stored as an
// integer number of BASIS POINTS (1% = 100 bp; 18% GST = 1800 bp), so the rate
// itself is exact; applying it to Money rounds to whole minor units with an
// explicit rounding mode (default: half-up, i.e. .5 rounds away from zero). This
// realises the exact fractional maths deliberately kept out of `money.ts`.

import { money, type Money } from './money';

/** A proportional rate in integer basis points (1% = 100 bp; 1800 = 18%). */
export interface Rate {
  readonly bps: number;
}

/** How to round a rate application to whole minor units. */
export type Rounding = 'half_up' | 'half_even' | 'down';

/** Construct a Rate from integer basis points. */
export function rate(bps: number): Rate {
  if (!Number.isSafeInteger(bps)) {
    throw new RangeError(`Rate basis points must be a safe integer, got ${bps}.`);
  }
  return Object.freeze({ bps });
}

/** Build a Rate from a percentage given as an exact decimal string ("18", "2.5"). */
export function parseRatePercent(percent: string): Rate {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(percent.trim());
  if (!match) {
    throw new RangeError(`Invalid percentage "${percent}".`);
  }
  const sign = match[1] === '-' ? -1 : 1;
  const whole = match[2] ?? '';
  const frac = match[3] ?? '';
  if (frac.length > 2) {
    throw new RangeError(`"${percent}" has more precision than basis points allow (2 dp).`);
  }
  const magnitude = Number(`${whole}${frac.padEnd(2, '0')}`); // percent → bps
  if (!Number.isSafeInteger(magnitude)) {
    throw new RangeError(`"${percent}" is too large to represent exactly.`);
  }
  return rate((sign * magnitude) || 0);
}

function divideRounded(numerator: bigint, denominator: bigint, rounding: Rounding): number {
  const quotient = numerator / denominator; // truncates toward zero
  const remainder = numerator - quotient * denominator;
  let result = quotient;
  if (remainder !== 0n) {
    const sign = numerator < 0n ? -1n : 1n;
    const twiceRem = (remainder < 0n ? -remainder : remainder) * 2n;
    if (rounding === 'half_up') {
      if (twiceRem >= denominator) result = quotient + sign;
    } else if (rounding === 'half_even') {
      if (twiceRem > denominator) result = quotient + sign;
      else if (twiceRem === denominator && quotient % 2n !== 0n) result = quotient + sign;
    }
    // 'down' truncates toward zero — quotient is already that.
  }
  const asNumber = Number(result);
  if (!Number.isSafeInteger(asNumber)) {
    throw new RangeError('Rate application result is too large to represent exactly.');
  }
  return asNumber;
}

/**
 * Apply a rate to a Money amount, rounding to whole minor units. Uses BigInt
 * internally so it is exact and cannot overflow. Default rounding is half-up.
 */
export function applyRate(amount: Money, r: Rate, rounding: Rounding = 'half_up'): Money {
  const numerator = BigInt(amount.minor) * BigInt(r.bps);
  return money(divideRounded(numerator, 10000n, rounding), amount.currency);
}

/** Format as a percentage string with two decimals (e.g. "18.00", "2.50"). */
export function toPercentString(r: Rate): string {
  const sign = r.bps < 0 ? '-' : '';
  const abs = Math.abs(r.bps);
  const whole = Math.trunc(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}${whole}.${frac}`;
}
