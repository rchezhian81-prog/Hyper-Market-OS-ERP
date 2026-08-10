// HSN digit-count by turnover (roadmap v2.1 A4). A tax invoice must carry the HSN code to the number of
// digits the law requires FOR THAT SHOP'S SIZE: an annual aggregate turnover over ₹5 crore must state 6
// digits; at or below ₹5 crore, 4 digits. A too-short HSN on an invoice is a non-compliant invoice, so
// this both decides the required count and validates a code against it — a code with fewer digits than
// required FAILS rather than being padded or accepted.
//
// Pure and deterministic. Turnover is in minor units (paisa); the threshold is ₹5,00,00,000.

/** ₹5 crore in minor units (paisa): ₹5,00,00,000 (= ₹50,000,000) × 100 = 5,000,000,000 paisa.
 *  Turnover strictly above this needs 6 digits. */
export const HSN_SIX_DIGIT_TURNOVER_THRESHOLD_MINOR = 5_000_000_000;

export type HsnDigitCount = 4 | 6;

export class InvalidHsnInput extends Error {
  constructor(detail: string) {
    super(`Cannot assess the HSN: ${detail}`);
    this.name = 'InvalidHsnInput';
  }
}

/**
 * The number of HSN digits a tax invoice must state, given the shop's annual aggregate turnover (A4):
 * 6 if turnover is over ₹5 crore, otherwise 4.
 *
 * @throws InvalidHsnInput if the turnover is not a whole, non-negative amount of minor units.
 */
export function requiredHsnDigits(annualTurnoverMinor: number): HsnDigitCount {
  if (!Number.isInteger(annualTurnoverMinor) || annualTurnoverMinor < 0) {
    throw new InvalidHsnInput('the annual turnover must be a whole, non-negative amount of minor units');
  }
  return annualTurnoverMinor > HSN_SIX_DIGIT_TURNOVER_THRESHOLD_MINOR ? 6 : 4;
}

export interface HsnValidation {
  readonly hsnCode: string;
  readonly requiredDigits: HsnDigitCount;
  readonly providedDigits: number;
  readonly valid: boolean;
  readonly detail: string;
}

/**
 * Validate an HSN code against the digit count the turnover requires (A4). A code with AT LEAST the
 * required digits is valid (a more specific 8-digit code satisfies a 6-digit requirement); fewer fails.
 *
 * @throws InvalidHsnInput if the turnover is invalid, or the code is not purely digits of a plausible
 *   HSN length (4, 6 or 8) — a malformed code is refused, never silently treated as compliant.
 */
export function validateHsnForTurnover(input: {
  readonly hsnCode: string;
  readonly annualTurnoverMinor: number;
}): HsnValidation {
  const requiredDigits = requiredHsnDigits(input.annualTurnoverMinor); // validates turnover
  if (typeof input.hsnCode !== 'string' || !/^\d+$/.test(input.hsnCode)) {
    throw new InvalidHsnInput('the HSN code must be a string of digits');
  }
  const providedDigits = input.hsnCode.length;
  if (providedDigits !== 4 && providedDigits !== 6 && providedDigits !== 8) {
    throw new InvalidHsnInput(`an HSN code is 4, 6 or 8 digits; "${input.hsnCode}" has ${providedDigits}`);
  }

  const valid = providedDigits >= requiredDigits;
  return {
    hsnCode: input.hsnCode,
    requiredDigits,
    providedDigits,
    valid,
    detail: valid
      ? `${providedDigits}-digit HSN satisfies the ${requiredDigits}-digit requirement for this turnover`
      : `a ${requiredDigits}-digit HSN is required at this turnover, but "${input.hsnCode}" has only ${providedDigits} — the invoice would be non-compliant`,
  };
}
