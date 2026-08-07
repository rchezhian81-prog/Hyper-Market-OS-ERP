// Money — the exact monetary value type for SRE Retail OS.
//
// Requirement: roadmap §29.1 — "money carries an explicit currency and fixed
// precision; it is never a floating-point number" — and M01-FR-02 (currency and
// fixed decimal precision). This primitive underpins every price, tender, ledger
// entry and total (M12, M23, M08). A value is an integer count of MINOR UNITS
// (e.g. paise for INR) plus an ISO-4217 currency code; no float ever enters it.

/** Supported currencies and their fixed minor-unit precision (decimal places). */
export const CURRENCY_PRECISION = Object.freeze({
  INR: 2, // paise
  USD: 2,
  EUR: 2,
  GBP: 2,
}) satisfies Readonly<Record<string, number>>;

/** An ISO-4217 currency code known to this system. */
export type CurrencyCode = keyof typeof CURRENCY_PRECISION;

/**
 * An exact monetary amount: an integer count of minor units plus its currency.
 * Immutable (frozen). Construct only via `money`, `parseMoney` or `zero`.
 */
export interface Money {
  /** Signed integer number of minor units (e.g. 1050 = ₹10.50). */
  readonly minor: number;
  /** ISO-4217 currency code (e.g. "INR"). */
  readonly currency: CurrencyCode;
}

/** True if `code` is a currency this system supports. */
export function isCurrencyCode(code: string): code is CurrencyCode {
  return Object.prototype.hasOwnProperty.call(CURRENCY_PRECISION, code);
}

/** Fixed minor-unit precision (decimal places) for a currency. */
export function precisionOf(currency: CurrencyCode): number {
  return CURRENCY_PRECISION[currency];
}

function assertKnownCurrency(currency: string): asserts currency is CurrencyCode {
  if (!isCurrencyCode(currency)) {
    throw new RangeError(`Unknown currency "${currency}". Register it in CURRENCY_PRECISION.`);
  }
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`Cannot combine ${a.currency} with ${b.currency}.`);
  }
}

/**
 * Construct Money from an integer count of minor units. Throws if `minor` is not
 * a safe integer (no float, no silent overflow) or the currency is unknown.
 */
export function money(minor: number, currency: CurrencyCode): Money {
  assertKnownCurrency(currency);
  if (!Number.isSafeInteger(minor)) {
    throw new RangeError(`Money minor units must be a safe integer, got ${minor}.`);
  }
  return Object.freeze({ minor, currency });
}

/** Zero in the given currency. */
export function zero(currency: CurrencyCode): Money {
  return money(0, currency);
}

/**
 * Parse an exact decimal string (e.g. "10.50", "-3", "0.05") into Money.
 * Rejects malformed input and input with MORE fractional digits than the
 * currency's precision — so money is never silently rounded on the way in.
 */
export function parseMoney(decimal: string, currency: CurrencyCode): Money {
  assertKnownCurrency(currency);
  const precision = precisionOf(currency);
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
  if (!match) {
    throw new RangeError(`Invalid money string "${decimal}".`);
  }
  const sign = match[1] === '-' ? -1 : 1;
  const whole = match[2] ?? '';
  const frac = match[3] ?? '';
  if (frac.length > precision) {
    throw new RangeError(`"${decimal}" has more than ${precision} decimal places for ${currency}.`);
  }
  const magnitude = Number(`${whole}${frac.padEnd(precision, '0')}`);
  if (!Number.isSafeInteger(magnitude)) {
    throw new RangeError(`"${decimal}" is too large to represent exactly.`);
  }
  return money((sign * magnitude) || 0, currency);
}

/** Sum of two amounts of the same currency. */
export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor + b.minor, a.currency);
}

/** Difference of two amounts of the same currency. */
export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor - b.minor, a.currency);
}

/** The additive inverse (used for refunds/compensating entries). */
export function negate(a: Money): Money {
  return money(-a.minor, a.currency);
}

/**
 * Multiply by an integer factor (e.g. a whole-unit quantity). Exact.
 * Fractional (weighed-goods) pricing rounds to minor units at the pricing layer
 * with an explicit rule (M12) — it is deliberately not offered here.
 */
export function multiplyByInteger(a: Money, factor: number): Money {
  if (!Number.isSafeInteger(factor)) {
    throw new RangeError(`multiplyByInteger requires an integer factor, got ${factor}.`);
  }
  return money(a.minor * factor, a.currency);
}

/** -1 if a < b, 0 if equal, 1 if a > b. Same currency required. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.minor < b.minor) return -1;
  if (a.minor > b.minor) return 1;
  return 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minor === b.minor;
}

export function isZero(a: Money): boolean {
  return a.minor === 0;
}

export function isNegative(a: Money): boolean {
  return a.minor < 0;
}

export function isPositive(a: Money): boolean {
  return a.minor > 0;
}

/**
 * Split into `parts` equal shares, distributing any leftover minor units one at
 * a time so the shares sum EXACTLY back to the original — no lost paise.
 */
export function allocate(a: Money, parts: number): Money[] {
  if (!Number.isSafeInteger(parts) || parts <= 0) {
    throw new RangeError(`allocate requires a positive integer parts, got ${parts}.`);
  }
  const base = Math.trunc(a.minor / parts);
  let remainder = a.minor - base * parts; // |remainder| < parts, same sign as a.minor
  const step = remainder >= 0 ? 1 : -1;
  const shares: Money[] = [];
  for (let i = 0; i < parts; i += 1) {
    let share = base;
    if (remainder !== 0) {
      share += step;
      remainder -= step;
    }
    shares.push(money(share, a.currency));
  }
  return shares;
}

/**
 * Split by non-negative integer ratios (weights), giving leftover minor units to
 * the largest fractional remainders so the shares sum EXACTLY back to the
 * original — no lost paise. Supports non-negative amounts.
 */
export function allocateByRatios(a: Money, ratios: readonly number[]): Money[] {
  if (a.minor < 0) {
    throw new RangeError('allocateByRatios supports non-negative amounts only.');
  }
  if (ratios.length === 0) {
    throw new RangeError('allocateByRatios requires at least one ratio.');
  }
  let total = 0;
  for (const r of ratios) {
    if (!Number.isSafeInteger(r) || r < 0) {
      throw new RangeError(`allocateByRatios ratios must be non-negative integers, got ${r}.`);
    }
    total += r;
  }
  if (total === 0) {
    throw new RangeError('allocateByRatios requires the ratios to sum to more than zero.');
  }
  const parts = ratios.map((r) => {
    const numerator = a.minor * r;
    return { base: Math.trunc(numerator / total), rem: numerator % total };
  });
  const distributed = parts.reduce((sum, p) => sum + p.base, 0);
  let leftover = a.minor - distributed; // 0 <= leftover < ratios.length
  const byRemainder = parts
    .map((p, index) => ({ index, rem: p.rem }))
    .sort((x, y) => y.rem - x.rem || x.index - y.index);
  const bumps = Array.from({ length: ratios.length }, () => 0);
  for (const entry of byRemainder) {
    if (leftover <= 0) break;
    bumps[entry.index] = 1;
    leftover -= 1;
  }
  return parts.map((p, index) => money(p.base + (bumps[index] ?? 0), a.currency));
}

/**
 * Format as a locale-neutral decimal string (e.g. "10.50", "-3.00"). Display
 * formatting (currency symbol, locale, Tamil numerals) is a UI concern and is
 * intentionally not part of the value.
 */
export function toDecimalString(a: Money): string {
  const precision = precisionOf(a.currency);
  const magnitude = Math.abs(a.minor);
  const scale = 10 ** precision;
  const whole = Math.trunc(magnitude / scale);
  const sign = a.minor < 0 ? '-' : '';
  if (precision === 0) {
    return `${sign}${whole}`;
  }
  const frac = String(magnitude % scale).padStart(precision, '0');
  return `${sign}${whole}.${frac}`;
}

/** How to round a fractional money result to whole minor units. */
export type Rounding = 'half_up' | 'half_even' | 'down';

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
    // 'down' truncates toward zero — quotient already is that.
  }
  const asNumber = Number(result);
  if (!Number.isSafeInteger(asNumber)) {
    throw new RangeError('Scaled money result is too large to represent exactly.');
  }
  return asNumber;
}

/**
 * Multiply a Money amount by the exact fraction numerator/denominator, rounding
 * to whole minor units. Uses BigInt so it is exact and cannot overflow — the
 * shared fractional maths behind rate application (rate.ts) and quantity-based
 * line pricing. `denominator` must be a positive integer.
 */
export function scaleMoney(
  amount: Money,
  numerator: number,
  denominator: number,
  rounding: Rounding = 'half_up',
): Money {
  if (!Number.isSafeInteger(numerator)) {
    throw new RangeError(`scaleMoney numerator must be a safe integer, got ${numerator}.`);
  }
  if (!Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new RangeError(`scaleMoney denominator must be a positive integer, got ${denominator}.`);
  }
  const scaled = divideRounded(
    BigInt(amount.minor) * BigInt(numerator),
    BigInt(denominator),
    rounding,
  );
  return money(scaled, amount.currency);
}
