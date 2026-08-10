// Inclusive-GST extraction (roadmap v2.1 A9 + A8). In Indian retail the printed price IS the MRP and
// the GST is already inside it, so a sale, a label and a tax invoice all need the tax pulled BACK OUT
// of the MRP — not added on top. This is that primitive, and it is deliberately exact:
//
//   taxable = MRP × 10000 / (10000 + rateBps)   (rounded to the paisa, half-up)
//   tax     = MRP − taxable                      (the REMAINDER)
//
// Defining the tax as the remainder makes taxable + tax reconcile to the MRP **to the paisa by
// construction** (A9) — there is no rounding gap for a customer, an auditor or a GSTR-2B to find. It
// never rounds against the customer: the amount charged is exactly the MRP.
//
// Place of supply (A8) decides the split, not the total: an intra-State supply is CGST + SGST at half
// the rate each, an inter-State (out-of-State delivery) supply is a single IGST at the full rate. The
// two intra-State halves are split from the WHOLE tax so they always sum back to it — any single odd
// paisa lands deterministically on SGST, never duplicated and never dropped.
//
// Pure and deterministic — no storage, no I/O, integer math throughout (BigInt for the divide so a
// large basket total cannot overflow). Composes nothing but its own types.

export type PlaceOfSupply = 'intra_state' | 'inter_state';

/** One GST component pulled out of an inclusive price. Shape matches `TaxComponent` in credit-notes. */
export interface InclusiveTaxComponent {
  readonly component: 'CGST' | 'SGST' | 'IGST';
  readonly rateBps: number;
  readonly amountMinor: number;
}

export interface InclusiveGstBreakdown {
  /** The tax-inclusive price the tax was pulled out of (== the input MRP). */
  readonly grossMinor: number;
  /** The value of supply the tax is charged on. */
  readonly taxableMinor: number;
  /** grossMinor − taxableMinor — the sum of the components, exactly. */
  readonly totalTaxMinor: number;
  readonly components: readonly InclusiveTaxComponent[];
  readonly rateBps: number;
  readonly placeOfSupply: PlaceOfSupply;
  /** Always true — the invariant A9 asserts: taxable + tax == gross, to the paisa. */
  readonly reconcilesToGross: true;
}

export class InvalidInclusiveTaxInput extends Error {
  constructor(detail: string) {
    super(`Cannot extract GST from the MRP: ${detail}`);
    this.name = 'InvalidInclusiveTaxInput';
  }
}

const isNonNegInt = (n: number): boolean => Number.isInteger(n) && n >= 0;

/** Round-half-up of (a / b) for non-negative integers, exact via BigInt: floor((2a + b) / 2b). */
function roundHalfUpDiv(a: bigint, b: bigint): bigint {
  return (2n * a + b) / (2n * b);
}

/**
 * Pull the GST out of a tax-inclusive MRP (A9), split by place of supply (A8).
 *
 * @throws InvalidInclusiveTaxInput if the MRP is not a positive whole paisa, the rate is not a whole
 *   non-negative bps, or an intra-State rate cannot split into two equal whole-bps halves.
 */
export function extractInclusiveGst(input: {
  readonly mrpMinor: number;
  readonly rateBps: number;
  readonly placeOfSupply: PlaceOfSupply;
}): InclusiveGstBreakdown {
  const { mrpMinor, rateBps, placeOfSupply } = input;

  if (!Number.isInteger(mrpMinor) || mrpMinor <= 0) {
    throw new InvalidInclusiveTaxInput('the MRP must be a positive whole number of minor units (paisa)');
  }
  if (!isNonNegInt(rateBps)) {
    throw new InvalidInclusiveTaxInput('the GST rate must be a whole, non-negative number of basis points');
  }
  if (placeOfSupply !== 'intra_state' && placeOfSupply !== 'inter_state') {
    throw new InvalidInclusiveTaxInput("place of supply must be 'intra_state' or 'inter_state'");
  }
  // CGST and SGST are equal by law — an intra-State rate must halve into two whole-bps components.
  if (placeOfSupply === 'intra_state' && rateBps % 2 !== 0) {
    throw new InvalidInclusiveTaxInput(`an intra-State rate must be even to split into equal CGST + SGST halves (got ${rateBps} bps)`);
  }

  const denom = 10_000 + rateBps;
  const taxableMinor = Number(roundHalfUpDiv(BigInt(mrpMinor) * 10_000n, BigInt(denom)));
  const totalTaxMinor = mrpMinor - taxableMinor; // the remainder — reconciles to the paisa by construction

  let components: readonly InclusiveTaxComponent[];
  if (rateBps === 0) {
    components = []; // exempt / nil-rated — no tax lines, taxable == gross
  } else if (placeOfSupply === 'inter_state') {
    components = [{ component: 'IGST', rateBps, amountMinor: totalTaxMinor }];
  } else {
    // Split the WHOLE tax so the halves always sum back to it; any odd paisa lands on SGST.
    const cgstMinor = Math.floor(totalTaxMinor / 2);
    const sgstMinor = totalTaxMinor - cgstMinor;
    const halfRateBps = rateBps / 2;
    components = [
      { component: 'CGST', rateBps: halfRateBps, amountMinor: cgstMinor },
      { component: 'SGST', rateBps: halfRateBps, amountMinor: sgstMinor },
    ];
  }

  return {
    grossMinor: mrpMinor,
    taxableMinor,
    totalTaxMinor,
    components,
    rateBps,
    placeOfSupply,
    reconcilesToGross: true,
  };
}

/**
 * Round a paisa amount to the nearest whole rupee (A10): **≥50 paisa rounds UP, <50 paisa rounds
 * DOWN.** In minor units a rupee is 100 paisa. Correct for negative amounts too (a credit line).
 */
export function roundToNearestRupeeMinor(minor: number): number {
  if (!Number.isInteger(minor)) {
    throw new InvalidInclusiveTaxInput('a paisa amount to round must be a whole number of minor units');
  }
  const RUPEE = 100;
  const rem = ((minor % RUPEE) + RUPEE) % RUPEE; // 0..99, correct for negatives
  const floored = minor - rem;
  return rem >= 50 ? floored + RUPEE : floored;
}

export interface RoundedGstBreakdown {
  readonly taxableMinor: number;
  readonly components: readonly InclusiveTaxComponent[];
  readonly totalTaxMinor: number;
  readonly grossMinor: number;
  /** rounded gross − the exact inclusive gross — the invoice "Round Off" line, stated not hidden (may be ±). */
  readonly roundOffMinor: number;
}

/**
 * Round each part of an extracted breakdown to the nearest rupee **per tax component** (A10), and
 * state the resulting round-off explicitly (P-08 — a rounding that moves money is never silent). The
 * exact paisa breakdown (A9) is unchanged; this is the whole-rupee view an invoice prints beside a
 * single "Round Off" line.
 */
export function roundToNearestRupee(breakdown: InclusiveGstBreakdown): RoundedGstBreakdown {
  const taxableMinor = roundToNearestRupeeMinor(breakdown.taxableMinor);
  const components = breakdown.components.map((c) => ({ ...c, amountMinor: roundToNearestRupeeMinor(c.amountMinor) }));
  const totalTaxMinor = components.reduce((s, c) => s + c.amountMinor, 0);
  const grossMinor = taxableMinor + totalTaxMinor;
  return { taxableMinor, components, totalTaxMinor, grossMinor, roundOffMinor: grossMinor - breakdown.grossMinor };
}
