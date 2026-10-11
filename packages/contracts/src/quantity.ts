// Quantity — an exact amount of stock or product with its unit of measure.
//
// Requirement: `db/data-dictionary/*` — "quantities carry a UOM; weight precision
// is UOM-aware". Like Money, a Quantity is an integer count of the UOM's smallest
// unit (e.g. grams for kg) plus the UOM code, so weighed goods stay exact — no
// float ever enters. Pack-breaking (case → inner → base) belongs to the product/pack
// model (M03, `packages/product/src/pack.ts`) and is not offered here.
//
// ── THE QUANTITY SCALE — owner decision OB-31 "A" (10 Oct 2026), one rule for every section ──────────────────────
//
//   1. Every stored or sent quantity (`quantityMinor`, `countedMinor`, `orderedQty`, a bin's contents, an indent line, a
//      count, a write-off, a pack section) is an INTEGER COUNT OF THE PRODUCT'S UNIT'S SMALLEST STEP:
//        ea → one item · kg → one GRAM · L → one MILLILITRE · g → one gram · ml → one millilitre.
//      So 2.5 kg of loose rice is 2500, never 2.5 and never 3. Weighed goods are counted in grams EVERYWHERE.
//   2. A unit COST or PRICE is per WHOLE unit: per item, per KG, per LITRE (per gram / per ml only for a product whose
//      unit is g / ml). Never per gram for a kg product — ₹45/kg is 4500 paise, which per gram is not a whole paisa.
//   3. VALUE = quantityMinor × unit cost ÷ 10^precision, ROUNDED ONCE (half up, on the last paisa) — `valueAtUnitCost`.
//      2500 g of rice at ₹45.00/kg = 2500 × 4500 ÷ 1000 = 11250 paise = ₹112.50. For `ea` the divisor is 1 (no rounding).
//   4. Unit SPELLING is normalised at every boundary (a body, a file, a relayed device event) with `normaliseUom`:
//      ea/each/EA/pcs/nos → ea, KG/kgs → kg, l/ltr/litre → L, gm/gms → g, ML → ml. A unit that is not one of these, and is
//      not a pack level the product master defines (case, inner …, converted to base units by `packages/product/src/
//      pack.ts`), is refused by name — never guessed.
//   5. A pack level counts in the product's base UNITS (a 25 kg bag of a kg product contains 25 kg = 25000 g).

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

// ── OB-31: the boundary rules ───────────────────────────────────────────────────────────────────────────────────────

/** Spellings people and older screens use for each unit, mapped to the one code the system stores (OB-31 rule 4). */
const UOM_ALIASES: Readonly<Record<string, Uom>> = Object.freeze({
  ea: 'ea', each: 'ea', pc: 'ea', pcs: 'ea', piece: 'ea', pieces: 'ea', nos: 'ea', no: 'ea', unit: 'ea', units: 'ea',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  g: 'g', gm: 'g', gms: 'g', gram: 'g', grams: 'g',
  l: 'L', ltr: 'L', ltrs: 'L', litre: 'L', litres: 'L', liter: 'L', liters: 'L',
  ml: 'ml', mls: 'ml', millilitre: 'ml', millilitres: 'ml',
});

/** The stored code for a unit spelling, or `undefined` when it is not a unit this system knows (OB-31 rule 4). */
export function normaliseUom(code: string): Uom | undefined {
  const key = code.trim().toLowerCase();
  if (key === '') return undefined;
  return UOM_ALIASES[key];
}

/** How many smallest steps make one whole unit: 1 for ea/g/ml, 1000 for kg (grams) and L (millilitres). */
export function minorPerUnit(uom: Uom): number {
  return 10 ** precisionOf(uom);
}

/** The same, from any spelling; an unknown spelling counts as a whole unit (1) — callers refuse unknown units first. */
export function minorPerUnitOf(code: string): number {
  const uom = normaliseUom(code);
  return uom === undefined ? 1 : minorPerUnit(uom);
}

/**
 * OB-31 rule 3 — the value of `quantityMinor` smallest steps at `unitCostMinor` per whole unit, rounded ONCE, half up on
 * the last minor unit. Integer arithmetic throughout (BigInt), so nothing drifts and nothing overflows.
 */
export function valueAtUnitCost(quantityMinor: number, uomCode: string, unitCostMinor: number): number {
  const scale = minorPerUnitOf(uomCode);
  if (scale === 1) return quantityMinor * unitCostMinor;
  const n = BigInt(quantityMinor) * BigInt(unitCostMinor);
  const d = BigInt(scale);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const q = abs / d;
  const r = abs % d;
  const rounded = r * 2n >= d ? q + 1n : q;
  return Number(neg ? -rounded : rounded);
}

/**
 * OB-46 "A" (owner, 11 Oct 2026, "Keep the case cost exact"): a cost that buys `per` whole units at once — ₹250 for a case of
 * 24 is `{ minor: 25_000, per: 24 }` — so a pack cost that does not divide into whole paise per unit is CARRIED, never
 * refused and never rounded per unit. Absent `per` ⇒ 1 (a cost per whole unit, as before).
 */
export interface CostBasis {
  readonly minor: number;
  readonly per?: number;
}

/**
 * OB-46 / OB-31 rule 3 — the value of `quantityMinor` smallest steps at a cost of `cost.minor` per `cost.per` whole units:
 * quantity × cost ÷ (per × steps per unit), rounded ONCE, half up. With `per` absent this is exactly `valueAtUnitCost`.
 */
export function valueAtCost(quantityMinor: number, uomCode: string, cost: CostBasis): number {
  const per = cost.per ?? 1;
  if (per === 1) return valueAtUnitCost(quantityMinor, uomCode, cost.minor);
  const n = BigInt(quantityMinor) * BigInt(cost.minor);
  const d = BigInt(minorPerUnitOf(uomCode)) * BigInt(per);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const q = abs / d;
  const r = abs % d;
  const rounded = r * 2n >= d ? q + 1n : q;
  return Number(neg ? -rounded : rounded);
}
