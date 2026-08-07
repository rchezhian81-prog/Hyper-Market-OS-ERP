// Quantity — an exact amount of stock or product with its unit of measure.
//
// Requirement: `db/data-dictionary/*` — "quantities carry a UOM; weight precision
// is UOM-aware". Like Money, a Quantity is an integer count of the UOM's smallest
// unit (e.g. grams for kg) plus the UOM code, so weighed goods stay exact — no
// float ever enters. Unit conversion and pack-breaking (kg↔g, case↔each) belong
// to the product/pack model (M03) and are deliberately not offered here.

/** Supported units of measure and their fixed precision (decimal places). */
export const UOM_PRECISION = Object.freeze({
  ea: 0, // each (discrete items)
  kg: 3, // to the gram
  g: 0,
  L: 3, // to the millilitre
  ml: 0,
}) satisfies Readonly<Record<string, number>>;

/** A unit of measure known to this system. */
export type Uom = keyof typeof UOM_PRECISION;

/**
 * An exact quantity: an integer count of the UOM's smallest unit plus the UOM.
 * Immutable. Construct only via `quantity`, `parseQuantity` or `zero`.
 */
export interface Quantity {
  /** Signed integer count of the UOM's smallest unit (e.g. 1234 = 1.234 kg). */
  readonly minor: number;
  /** Unit of measure (e.g. "kg"). */
  readonly uom: Uom;
}

/** True if `code` is a unit of measure this system supports. */
export function isUom(code: string): code is Uom {
  return Object.prototype.hasOwnProperty.call(UOM_PRECISION, code);
}

/** Fixed precision (decimal places) for a unit of measure. */
export function precisionOf(uom: Uom): number {
  return UOM_PRECISION[uom];
}

function assertKnownUom(uom: string): asserts uom is Uom {
  if (!isUom(uom)) {
    throw new RangeError(`Unknown unit of measure "${uom}".`);
  }
}

function assertSameUom(a: Quantity, b: Quantity): void {
  if (a.uom !== b.uom) {
    throw new TypeError(`Cannot combine ${a.uom} with ${b.uom}.`);
  }
}

/**
 * Construct a Quantity from an integer count of the UOM's smallest unit. Throws
 * if `minor` is not a safe integer or the UOM is unknown.
 */
export function quantity(minor: number, uom: Uom): Quantity {
  assertKnownUom(uom);
  if (!Number.isSafeInteger(minor)) {
    throw new RangeError(`Quantity minor units must be a safe integer, got ${minor}.`);
  }
  return Object.freeze({ minor, uom });
}

/** Zero in the given unit of measure. */
export function zero(uom: Uom): Quantity {
  return quantity(0, uom);
}

/**
 * Parse an exact decimal string (e.g. "1.234", "3", "-0.5") into a Quantity.
 * Rejects malformed input and more fractional digits than the UOM allows — so a
 * quantity is never silently rounded on the way in.
 */
export function parseQuantity(decimal: string, uom: Uom): Quantity {
  assertKnownUom(uom);
  const precision = precisionOf(uom);
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
  if (!match) {
    throw new RangeError(`Invalid quantity string "${decimal}".`);
  }
  const sign = match[1] === '-' ? -1 : 1;
  const whole = match[2] ?? '';
  const frac = match[3] ?? '';
  if (frac.length > precision) {
    throw new RangeError(`"${decimal}" has more than ${precision} decimal places for ${uom}.`);
  }
  const magnitude = Number(`${whole}${frac.padEnd(precision, '0')}`);
  if (!Number.isSafeInteger(magnitude)) {
    throw new RangeError(`"${decimal}" is too large to represent exactly.`);
  }
  return quantity((sign * magnitude) || 0, uom);
}

/** Sum of two quantities of the same UOM. */
export function add(a: Quantity, b: Quantity): Quantity {
  assertSameUom(a, b);
  return quantity(a.minor + b.minor, a.uom);
}

/** Difference of two quantities of the same UOM. */
export function subtract(a: Quantity, b: Quantity): Quantity {
  assertSameUom(a, b);
  return quantity(a.minor - b.minor, a.uom);
}

/** The additive inverse (e.g. an outbound stock movement). */
export function negate(a: Quantity): Quantity {
  return quantity(-a.minor, a.uom);
}

/** Multiply by an integer factor (e.g. cases × units-per-case). Exact. */
export function multiplyByInteger(a: Quantity, factor: number): Quantity {
  if (!Number.isSafeInteger(factor)) {
    throw new RangeError(`multiplyByInteger requires an integer factor, got ${factor}.`);
  }
  return quantity(a.minor * factor, a.uom);
}

/** -1 if a < b, 0 if equal, 1 if a > b. Same UOM required. */
export function compare(a: Quantity, b: Quantity): -1 | 0 | 1 {
  assertSameUom(a, b);
  if (a.minor < b.minor) return -1;
  if (a.minor > b.minor) return 1;
  return 0;
}

export function equals(a: Quantity, b: Quantity): boolean {
  return a.uom === b.uom && a.minor === b.minor;
}

export function isZero(a: Quantity): boolean {
  return a.minor === 0;
}

export function isNegative(a: Quantity): boolean {
  return a.minor < 0;
}

export function isPositive(a: Quantity): boolean {
  return a.minor > 0;
}

/** Format as a locale-neutral decimal string (e.g. "1.234", "-0.500"). */
export function toDecimalString(a: Quantity): string {
  const precision = precisionOf(a.uom);
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
