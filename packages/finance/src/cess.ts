// GST Compensation Cess on tobacco / pan-masala (roadmap v2.1 A7). A short list of "demerit" goods —
// cigarettes, pan-masala, chewing tobacco, gutkha — carry a GST **Compensation Cess** over and above the
// GST, under the GST (Compensation to States) Act 2017. GST 2.0 (Sept 2025) moved most goods off the old
// 28%+cess regime onto a single 40% demerit slab AND was to end the cess — but these tobacco/pan-masala
// HSNs were **held over on 28% GST + compensation cess** while the cess-fund loan obligations are
// discharged. So the store now stocks goods whose correct tax is 28% GST **plus** a cess this engine
// computes; billing them at GST alone under-declares the tax, and billing them at the 40% demerit slab
// AND a cess taxes them twice.
//
// The cess itself takes two shapes the law uses together (cigarettes carry both): an **ad-valorem** part,
// a percentage of the same taxable value GST is charged on (Compensation Cess Act s.8 → CGST s.15), and a
// **specific** part, a fixed amount per block of units (e.g. ₹ per 1000 sticks), charged pro-rata on the
// quantity sold. A good with neither is simply not cess-liable and its cess is zero — which is every
// ordinary grocery line, so the cess is data-gated: no spec, no cess.
//
// Pure and deterministic — the rates are DATA (a per-HSN spec), never hard-coded here; integer math
// throughout (BigInt for the divides so a large basket cannot overflow), rounded half-up to the paisa.

/** The compensation-cess rate for one HSN. Both parts are optional-by-zero; a spec of all zeros is a
 *  good that is simply not cess-liable. Rates are data — this engine carries none of its own. */
export interface CompensationCessSpec {
  readonly hsnCode: string;
  /** Ad-valorem cess as basis points of the taxable value (e.g. 6000 = 60%). 0 = no ad-valorem cess. */
  readonly advaloremBps: number;
  /** Specific cess in minor units (paisa) per `perQuantity` units of the good (e.g. ₹4170 = 417000 paisa
   *  per 1000 sticks). 0 = no specific cess. */
  readonly specificPerQuantityMinor: number;
  /** The quantity block the specific rate is quoted per (e.g. 1000 sticks). Must be a positive integer
   *  whenever `specificPerQuantityMinor` > 0; ignored when it is 0. */
  readonly perQuantity: number;
}

export interface CessAssessment {
  readonly hsnCode: string;
  /** True when the spec carries any cess at all — the data gate: false ⇒ every amount below is 0. */
  readonly cessLiable: boolean;
  readonly taxableMinor: number;
  readonly quantity: number;
  /** taxable × advaloremBps / 10000, rounded half-up to the paisa. */
  readonly advaloremCessMinor: number;
  /** specificPerQuantityMinor × quantity / perQuantity, rounded half-up to the paisa (pro-rata on qty). */
  readonly specificCessMinor: number;
  /** advaloremCessMinor + specificCessMinor — the cess line that sits ALONGSIDE the GST components. */
  readonly totalCessMinor: number;
}

/** How a good sits under the GST 2.0 demerit reform, given whether it is compensation-cess-liable and the
 *  GST rate it was resolved to (A6). Names the double-tax misconfiguration rather than let it bill. */
export type DemeritBand = 'cess_holdover_28' | 'demerit_40' | 'standard';

export interface DemeritHoldoverCheck {
  /** False only for the double-tax case: a cess-liable good ALSO put on the 40% demerit slab. */
  readonly ok: boolean;
  readonly band: DemeritBand;
  readonly detail: string;
}

export class InvalidCessInput extends Error {
  constructor(detail: string) {
    super(`Cannot compute the compensation cess: ${detail}`);
    this.name = 'InvalidCessInput';
  }
}

const DEMERIT_RATE_BPS = 4000; // GST 2.0 single demerit slab, 40%
const CESS_HOLDOVER_GST_BPS = 2800; // tobacco / pan-masala held over on 28% GST + cess

const isNonNegInt = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;

/** Round-half-up of (a / b) for non-negative integers, exact via BigInt: floor((2a + b) / 2b). */
function roundHalfUpDiv(a: bigint, b: bigint): bigint {
  return (2n * a + b) / (2n * b);
}

/**
 * Compute the GST Compensation Cess for a line (A7) from a per-HSN spec, a taxable value and a quantity.
 *
 * A good with no ad-valorem and no specific cess is not cess-liable and every amount is 0 (the data gate
 * — an ordinary grocery line). Otherwise the ad-valorem part is a percentage of the taxable value and the
 * specific part is charged pro-rata on the quantity; the total is their sum, to sit alongside the GST.
 *
 * @throws InvalidCessInput if the HSN is not 2–8 digits, a rate/amount is not a whole non-negative number,
 *   the taxable value or quantity is not a whole non-negative number, or a specific rate is quoted with a
 *   non-positive `perQuantity` block (there is nothing to charge it per).
 */
export function assessCompensationCess(input: {
  readonly spec: CompensationCessSpec;
  readonly taxableMinor: number;
  readonly quantity: number;
}): CessAssessment {
  const { spec, taxableMinor, quantity } = input;

  if (typeof spec.hsnCode !== 'string' || !/^\d{2,8}$/.test(spec.hsnCode)) {
    throw new InvalidCessInput('the HSN code must be 2 to 8 digits');
  }
  if (!isNonNegInt(spec.advaloremBps)) {
    throw new InvalidCessInput('the ad-valorem cess must be a whole, non-negative number of basis points');
  }
  if (!isNonNegInt(spec.specificPerQuantityMinor)) {
    throw new InvalidCessInput('the specific cess must be a whole, non-negative number of minor units');
  }
  if (!isNonNegInt(taxableMinor)) {
    throw new InvalidCessInput('the taxable value must be a whole, non-negative number of minor units (paisa)');
  }
  if (!isNonNegInt(quantity)) {
    throw new InvalidCessInput('the quantity must be a whole, non-negative number');
  }
  if (spec.specificPerQuantityMinor > 0 && !(Number.isInteger(spec.perQuantity) && spec.perQuantity > 0)) {
    throw new InvalidCessInput('a specific cess needs a positive whole `perQuantity` block to charge it per (e.g. 1000 sticks)');
  }

  const cessLiable = spec.advaloremBps > 0 || spec.specificPerQuantityMinor > 0;

  const advaloremCessMinor = spec.advaloremBps > 0
    ? Number(roundHalfUpDiv(BigInt(taxableMinor) * BigInt(spec.advaloremBps), 10_000n))
    : 0;
  const specificCessMinor = spec.specificPerQuantityMinor > 0
    ? Number(roundHalfUpDiv(BigInt(spec.specificPerQuantityMinor) * BigInt(quantity), BigInt(spec.perQuantity)))
    : 0;

  return {
    hsnCode: spec.hsnCode,
    cessLiable,
    taxableMinor,
    quantity,
    advaloremCessMinor,
    specificCessMinor,
    totalCessMinor: advaloremCessMinor + specificCessMinor,
  };
}

/**
 * Check the GST 2.0 holdover invariant (A7): a compensation-cess-liable good (tobacco / pan-masala) keeps
 * the **28% GST + cess** treatment and must NOT also be placed on the **40% demerit** slab — doing both
 * taxes it twice. A non-cess good at 40% is a legitimate demerit good (e.g. an aerated drink under GST
 * 2.0); anything else is standard.
 *
 * @throws InvalidCessInput if the GST rate is not a whole non-negative number of basis points.
 */
export function checkDemeritHoldover(input: {
  readonly cessLiable: boolean;
  readonly gstRateBps: number;
}): DemeritHoldoverCheck {
  if (!isNonNegInt(input.gstRateBps)) {
    throw new InvalidCessInput('the GST rate must be a whole, non-negative number of basis points');
  }
  const { cessLiable, gstRateBps } = input;

  if (cessLiable && gstRateBps === DEMERIT_RATE_BPS) {
    return {
      ok: false,
      band: 'demerit_40',
      detail: 'a compensation-cess-liable good is on the 40% demerit slab AND carries cess — it is taxed twice; tobacco / pan-masala is held over on 28% GST + cess, not the 40% slab',
    };
  }
  if (cessLiable) {
    return {
      ok: true,
      band: 'cess_holdover_28',
      detail: gstRateBps === CESS_HOLDOVER_GST_BPS
        ? 'tobacco / pan-masala: 28% GST + compensation cess (GST 2.0 holdover)'
        : `cess-liable good on ${gstRateBps / 100}% GST + compensation cess`,
    };
  }
  if (gstRateBps === DEMERIT_RATE_BPS) {
    return { ok: true, band: 'demerit_40', detail: 'demerit good on the 40% GST slab, no compensation cess (GST 2.0)' };
  }
  return { ok: true, band: 'standard', detail: `standard good on ${gstRateBps / 100}% GST, no compensation cess` };
}

// ── A7 at the till: the cess INSIDE the MRP, on a line, from the signed pack ──────────────────────────────────────────
//
// A shelf price is the MRP with every tax inside it (A9). For a cess-liable good the MRP carries the GST AND the
// compensation cess, so the line's value of supply comes out of the MRP with both pulled back:
//
//   specific = specificPerQuantityMinor × quantity / perQuantity            (rounded half-up)
//   taxable  = (gross − specific) × 10000 / (10000 + gstBps + advaloremBps) (rounded half-up)
//   advalorem cess = taxable × advaloremBps / 10000                         (rounded half-up)
//   GST      = gross − specific − taxable − advalorem cess                  (the REMAINDER)
//
// so taxable + GST + cess == gross to the paisa, by construction — the same exactness A9 gives an ordinary line, and an
// ordinary line (no cess) splits to exactly what `extractInclusiveGst` gives. The rates are DATA from head office (per
// HSN, effective-dated, CA-confirmed); none is written here.

/** A good's compensation-cess rate as it rides the signed pack: the ad-valorem part and the specific part. */
export interface CessRate {
  readonly advaloremBps: number;
  readonly specificPerQuantityMinor: number;
  /** The quantity block the specific rate is quoted per, in the line's own quantity steps (e.g. 1000 sticks). */
  readonly perQuantity: number;
}

/** One effective-dated cess rate for an HSN (append-only; a change is a later period). */
export interface CessRatePeriod extends CessRate {
  readonly effectiveFrom: string;
}

/** A cess rate read strictly from untrusted data (a pack, a sale line) — undefined when it is not one, or carries no cess. */
export function readCessRate(v: unknown): CessRate | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  const a = r['advaloremBps'];
  const s = r['specificPerQuantityMinor'];
  const p = r['perQuantity'];
  if (!isNonNegInt(a) || !isNonNegInt(s)) return undefined;
  const block = Number.isInteger(p) && (p as number) > 0 ? (p as number) : undefined;
  if (s > 0 && block === undefined) return undefined;
  if (a === 0 && s === 0) return undefined;
  return { advaloremBps: a, specificPerQuantityMinor: s, perQuantity: block ?? 1 };
}

/** The cess rate in force on a day (YYYY-MM-DD): the latest period on or before it; undefined = not cess-liable that day. */
export function cessRateOn(schedule: readonly CessRatePeriod[], day: string): CessRate | undefined {
  const inForce = [...schedule]
    .filter((p) => typeof p.effectiveFrom === 'string' && p.effectiveFrom <= day)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0))
    .at(-1);
  return inForce === undefined ? undefined : readCessRate(inForce);
}

export interface InclusiveCessSplit {
  readonly grossMinor: number;
  readonly taxableMinor: number;
  /** The GST inside the line (CGST + SGST, or IGST). */
  readonly gstMinor: number;
  readonly advaloremCessMinor: number;
  readonly specificCessMinor: number;
  readonly cessMinor: number;
}

/**
 * Pull the GST AND the compensation cess out of a tax-inclusive line amount (A7 inside A9). With no cess the result is the
 * ordinary inclusive split. Pure; integer maths.
 *
 * @throws InvalidCessInput when an amount is not a whole non-negative number, the cess rate is unreadable, or the
 *   specific cess alone is above the price.
 */
export function splitInclusiveWithCess(input: {
  readonly grossMinor: number;
  readonly gstRateBps: number;
  readonly cess?: CessRate;
  /** The line's quantity, in the steps the specific rate is quoted in. */
  readonly quantity: number;
}): InclusiveCessSplit {
  const { grossMinor, gstRateBps, quantity } = input;
  if (!isNonNegInt(grossMinor)) throw new InvalidCessInput('the line amount must be a whole, non-negative number of paisa');
  if (!isNonNegInt(gstRateBps)) throw new InvalidCessInput('the GST rate must be a whole, non-negative number of basis points');
  if (!isNonNegInt(quantity)) throw new InvalidCessInput('the quantity must be a whole, non-negative number');
  const cess = input.cess === undefined ? undefined : readCessRate(input.cess);
  if (input.cess !== undefined && cess === undefined && (input.cess.advaloremBps !== 0 || input.cess.specificPerQuantityMinor !== 0)) {
    throw new InvalidCessInput('the cess rate is not readable (whole basis points, whole paisa, and a positive quantity block for a specific rate)');
  }
  const advBps = cess?.advaloremBps ?? 0;
  const specificCessMinor = cess !== undefined && cess.specificPerQuantityMinor > 0
    ? Number(roundHalfUpDiv(BigInt(cess.specificPerQuantityMinor) * BigInt(quantity), BigInt(cess.perQuantity)))
    : 0;
  const remaining = grossMinor - specificCessMinor;
  if (remaining < 0) throw new InvalidCessInput(`the specific cess (${specificCessMinor} paisa) is above the price charged (${grossMinor} paisa)`);
  const taxableMinor = Number(roundHalfUpDiv(BigInt(remaining) * 10_000n, BigInt(10_000 + gstRateBps + advBps)));
  let advaloremCessMinor = advBps === 0 ? 0 : Number(roundHalfUpDiv(BigInt(taxableMinor) * BigInt(advBps), 10_000n));
  let gstMinor = remaining - taxableMinor - advaloremCessMinor;
  // With no GST the remainder belongs to the cess (there is no GST to carry an odd paisa).
  if (gstRateBps === 0) { advaloremCessMinor += gstMinor; gstMinor = 0; }
  if (gstMinor < 0 || advaloremCessMinor < 0) throw new InvalidCessInput('the amount is too small to carry this GST and cess');
  return { grossMinor, taxableMinor, gstMinor, advaloremCessMinor, specificCessMinor, cessMinor: advaloremCessMinor + specificCessMinor };
}
