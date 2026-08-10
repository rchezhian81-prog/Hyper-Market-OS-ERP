// Unit sale price on the label (roadmap v2.1 B3 — Legal Metrology / Packaged Commodities Rules).
//
// A pre-packed commodity must show its price PER STANDARD UNIT next to the MRP — ₹ per kg for goods
// sold by weight, ₹ per litre by volume, ₹ per piece by count — so a shopper can compare a 480 g pack
// against a 500 g one without arithmetic. This computes that figure from the MRP and the net quantity,
// normalising grams to a kilogram and millilitres to a litre.
//
// Two exemptions the rules allow are surfaced, not hidden: a very small package (principal display
// panel ≤ 100 cm²) and a low-value item (retail price ≤ ₹35). Where an exemption applies the figure is
// STILL computed (it is useful) but flagged as display-not-mandatory, rather than silently omitted.
//
// Pure and deterministic — integer money throughout (BigInt for the divide).

export type NetQuantityUnit = 'g' | 'kg' | 'ml' | 'l' | 'unit' | 'piece';
export type StandardUnit = 'kg' | 'l' | 'unit';

/** Principal-display-panel area at or below which the unit-price display is exempt (cm²). */
export const UNIT_PRICE_SMALL_PANEL_CM2 = 100;
/** Retail price at or below which the unit-price display is exempt (minor units — ₹35). */
export const UNIT_PRICE_LOW_VALUE_MINOR = 35_00;

export interface UnitSalePrice {
  readonly unitPriceMinor: number;
  readonly per: StandardUnit;
  /** True when the rules do not require the display (still computed — an exemption is not a reason to hide it). */
  readonly exempt: boolean;
  readonly exemptReason?: string;
  readonly detail: string;
}

export class InvalidUnitPriceInput extends Error {
  constructor(detail: string) {
    super(`Cannot compute the unit sale price: ${detail}`);
    this.name = 'InvalidUnitPriceInput';
  }
}

/** Round-half-up of a/b for non-negative integers, exact via BigInt. */
function roundHalfUpDiv(a: number, b: number): number {
  return Number((2n * BigInt(a) + BigInt(b)) / (2n * BigInt(b)));
}

/**
 * Compute the unit sale price for a pre-packed commodity (B3). Grams normalise to a kilogram and
 * millilitres to a litre; count units stay per piece.
 *
 * @throws InvalidUnitPriceInput if the MRP is not a positive whole amount, the net quantity is not a
 *   positive whole number, or the unit is unknown.
 */
export function unitSalePrice(input: {
  readonly mrpMinor: number;
  readonly netQuantity: number;
  readonly unit: NetQuantityUnit;
  /** The principal-display-panel area in cm², for the small-package exemption. */
  readonly principalPanelAreaCm2?: number;
}): UnitSalePrice {
  if (!Number.isInteger(input.mrpMinor) || input.mrpMinor <= 0) {
    throw new InvalidUnitPriceInput('the MRP must be a positive whole amount of minor units');
  }
  if (!Number.isInteger(input.netQuantity) || input.netQuantity <= 0) {
    throw new InvalidUnitPriceInput('the net quantity must be a positive whole number (use g/ml for sub-unit sizes)');
  }

  let per: StandardUnit;
  let unitPriceMinor: number;
  switch (input.unit) {
    case 'g':  per = 'kg'; unitPriceMinor = roundHalfUpDiv(input.mrpMinor * 1000, input.netQuantity); break;
    case 'kg': per = 'kg'; unitPriceMinor = roundHalfUpDiv(input.mrpMinor, input.netQuantity); break;
    case 'ml': per = 'l';  unitPriceMinor = roundHalfUpDiv(input.mrpMinor * 1000, input.netQuantity); break;
    case 'l':  per = 'l';  unitPriceMinor = roundHalfUpDiv(input.mrpMinor, input.netQuantity); break;
    case 'unit':
    case 'piece': per = 'unit'; unitPriceMinor = roundHalfUpDiv(input.mrpMinor, input.netQuantity); break;
    default: throw new InvalidUnitPriceInput(`unknown unit "${String(input.unit)}" — use g, kg, ml, l, unit or piece`);
  }

  const smallPanel = input.principalPanelAreaCm2 !== undefined && input.principalPanelAreaCm2 <= UNIT_PRICE_SMALL_PANEL_CM2;
  const lowValue = input.mrpMinor <= UNIT_PRICE_LOW_VALUE_MINOR;
  const exempt = smallPanel || lowValue;
  const exemptReason = smallPanel
    ? `principal display panel ≤ ${UNIT_PRICE_SMALL_PANEL_CM2} cm²`
    : lowValue
      ? `retail price ≤ ₹${UNIT_PRICE_LOW_VALUE_MINOR / 100}`
      : undefined;

  return {
    unitPriceMinor,
    per,
    exempt,
    ...(exemptReason === undefined ? {} : { exemptReason }),
    detail: exempt
      ? `${unitPriceMinor} per ${per} — display not mandatory (${exemptReason})`
      : `${unitPriceMinor} per ${per}`,
  };
}
