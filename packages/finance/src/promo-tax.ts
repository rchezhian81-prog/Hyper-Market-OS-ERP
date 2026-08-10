// GST treatment of promotional supplies (roadmap v2.1 A12), per the CBIC clarifications.
//
// The load-bearing distinction is that a "buy-one-get-one" offer is NOT a free supply and a genuine
// free sample IS — and they carry opposite input-tax-credit consequences, which is exactly the thing
// shops get wrong:
//
//   • BOGO (CBIC Circular 92/2019) — "buy one, get one free" is a single supply of two goods for one
//     price, not one supply plus one gift. GST is charged on the consideration actually received; the
//     "free" units add NO extra tax, and the ITC on them is NOT reversed (they were sold, for a price).
//   • True free sample / gift (s.17(5)(h)) — goods given away with NO consideration are not a supply
//     (no output GST), BUT the input tax credit on them must be REVERSED. Treating a free sample like
//     a BOGO (and keeping the ITC) is the error this encodes against.
//   • Voucher time of supply (s.12(4)/13(4)) — if the supply the voucher buys is identifiable when the
//     voucher is ISSUED, the time of supply is the issue date; otherwise it is the redemption date.
//
// Pure and deterministic — no storage, no I/O.

export class InvalidPromoTaxInput extends Error {
  constructor(detail: string) {
    super(`Cannot assess the promotional supply: ${detail}`);
    this.name = 'InvalidPromoTaxInput';
  }
}

const isNonNegInt = (n: number): boolean => Number.isInteger(n) && n >= 0;
const isPosInt = (n: number): boolean => Number.isInteger(n) && n > 0;
const isDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));

export interface BogoTaxTreatment {
  readonly paidUnits: number;
  readonly freeUnits: number;
  /** GST is charged on the consideration for the paid units; the free units add this much extra: 0. */
  readonly taxableConsiderationMinor: number;
  readonly extraTaxableOnFreeUnitsMinor: 0;
  readonly itcReversalRequired: false;
  readonly detail: string;
}

/**
 * BOGO: a single supply of (paidUnits + freeUnits) for the price of the paid units (A12 / CBIC
 * 92/2019). The free units add **no extra taxable value** and the ITC on them is **not** reversed.
 */
export function bogoTreatment(input: {
  readonly paidUnits: number;
  readonly freeUnits: number;
  readonly unitConsiderationMinor: number;
}): BogoTaxTreatment {
  if (!isPosInt(input.paidUnits)) throw new InvalidPromoTaxInput('paidUnits must be a positive whole number');
  if (!isNonNegInt(input.freeUnits)) throw new InvalidPromoTaxInput('freeUnits must be a whole, non-negative number');
  if (!isNonNegInt(input.unitConsiderationMinor)) throw new InvalidPromoTaxInput('the unit consideration must be a whole, non-negative amount of minor units');

  const taxableConsiderationMinor = input.paidUnits * input.unitConsiderationMinor;
  return {
    paidUnits: input.paidUnits,
    freeUnits: input.freeUnits,
    taxableConsiderationMinor,
    extraTaxableOnFreeUnitsMinor: 0,
    itcReversalRequired: false,
    detail: `a single supply of ${input.paidUnits + input.freeUnits} for the price of ${input.paidUnits} — GST is on ${taxableConsiderationMinor}; the ${input.freeUnits} free unit(s) add no extra tax and the ITC on them is not reversed (CBIC 92/2019)`,
  };
}

export interface FreeSampleTaxTreatment {
  /** No consideration → not a supply → no output GST. */
  readonly isSupply: false;
  readonly outputTaxMinor: 0;
  /** …but the ITC on a genuine free sample/gift must be reversed (s.17(5)(h)). */
  readonly itcReversalRequired: true;
  /** The ITC to reverse, if the amount claimed on the sampled goods is known. */
  readonly itcToReverseMinor: number;
  readonly detail: string;
}

/**
 * A genuine free sample / gift given with NO consideration (A12 / s.17(5)(h)): not a supply, so no
 * output tax — but the input tax credit on it must be REVERSED. (A conditional "free" unit is a BOGO,
 * not a free sample — use `bogoTreatment`.)
 */
export function freeSampleTreatment(input: { readonly itcClaimedMinor?: number } = {}): FreeSampleTaxTreatment {
  const itc = input.itcClaimedMinor ?? 0;
  if (!isNonNegInt(itc)) throw new InvalidPromoTaxInput('the ITC claimed must be a whole, non-negative amount of minor units');
  return {
    isSupply: false,
    outputTaxMinor: 0,
    itcReversalRequired: true,
    itcToReverseMinor: itc,
    detail: itc > 0
      ? `a free sample is not a supply (no output GST), but the ${itc} of ITC claimed on it must be reversed (s.17(5)(h))`
      : 'a free sample is not a supply (no output GST), but any ITC claimed on it must be reversed (s.17(5)(h))',
  };
}

export type VoucherTimeOfSupplyBasis = 'issue' | 'redemption';

export interface VoucherTiming {
  readonly timeOfSupply: string;
  readonly basis: VoucherTimeOfSupplyBasis;
  readonly detail: string;
}

/**
 * The time of supply of a voucher (A12 / s.12(4), s.13(4)): if the supply the voucher buys is
 * identifiable when the voucher is ISSUED, GST is due at issue; otherwise it is due at redemption.
 *
 * @throws InvalidPromoTaxInput on bad dates, or when redemption timing is needed but no redemption
 *   date is supplied (a voucher whose supply is not identifiable at issue cannot be timed until it is
 *   redeemed — that is a pending fact, never a guessed one).
 */
export function voucherTimeOfSupply(input: {
  readonly supplyIdentifiableAtIssue: boolean;
  readonly issueDate: string;
  readonly redemptionDate?: string;
}): VoucherTiming {
  if (!isDate(input.issueDate)) throw new InvalidPromoTaxInput('the issue date must be a valid YYYY-MM-DD');
  if (input.redemptionDate !== undefined && !isDate(input.redemptionDate)) {
    throw new InvalidPromoTaxInput('the redemption date, if given, must be a valid YYYY-MM-DD');
  }

  if (input.supplyIdentifiableAtIssue) {
    return {
      timeOfSupply: input.issueDate,
      basis: 'issue',
      detail: 'the supply is identifiable at issue — GST is due on the issue date (s.12(4)(a))',
    };
  }
  if (input.redemptionDate === undefined) {
    throw new InvalidPromoTaxInput('the supply is not identifiable at issue, so the time of supply is the redemption date — which has not happened yet');
  }
  return {
    timeOfSupply: input.redemptionDate,
    basis: 'redemption',
    detail: 'the supply is not identifiable at issue — GST is due on the redemption date (s.12(4)(b))',
  };
}
