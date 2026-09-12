// The denomination breakdown of a blind cash count (M14-FR-02) — the notes and coins a cashier
// actually counted, and the integrity check that they add up to the total they declared.
//
// The blind count already computes over/short from a single counted total. But "₹4,000 short" and
// "₹4,000 short, and the drawer is missing exactly eight ₹500 notes" are different investigations —
// the second is the one the cash office and the CA can actually act on. So the breakdown is captured,
// verified to SUM to the counted total (a breakdown that does not sum to the cashier's own total is an
// entry error caught at the drawer, not a mystery found at audit), and kept for the evidence pack.
//
// It changes nothing about the blind property: the expected figure is still never shown at count time;
// the cashier enters what they physically see, denomination by denomination.
//
// Pure and deterministic: no clock, no I/O.

/** Indian currency in paise — the notes and coins that can appear in a shop drawer, largest first. */
export const INR_DENOMINATIONS: readonly number[] = [
  200_000, // ₹2000 note
  50_000,  // ₹500 note
  20_000,  // ₹200 note
  10_000,  // ₹100 note
  5_000,   // ₹50 note
  2_000,   // ₹20 note
  1_000,   // ₹10 note (and coin)
  500,     // ₹5 coin
  200,     // ₹2 coin
  100,     // ₹1 coin
];

export interface DenominationCount {
  /** The face value in paise — must be one of INR_DENOMINATIONS. */
  readonly denominationMinor: number;
  /** How many of this note/coin were counted. A whole, non-negative number. */
  readonly count: number;
}

/** Σ (face value × count), in paise. */
export function sumDenominations(counts: readonly DenominationCount[]): number {
  return counts.reduce((total, d) => total + d.denominationMinor * d.count, 0);
}

export type DenominationRefusal =
  | 'unknown_denomination'
  | 'negative_or_fractional_count'
  | 'does_not_sum_to_the_count';

export interface DenominationCheck {
  readonly ok: boolean;
  readonly refusedBecause?: DenominationRefusal;
  readonly sumMinor: number;
  readonly detail: string;
}

/**
 * Check a denomination breakdown: every entry is a real Indian denomination with a whole,
 * non-negative count, and the breakdown SUMS to the total the cashier declared. A mismatch is an
 * entry error to fix at the drawer — never a variance to explain later.
 */
export function checkDenominationCount(input: {
  readonly denominations: readonly DenominationCount[];
  readonly countedCashMinor: number;
}): DenominationCheck {
  for (const d of input.denominations) {
    if (!INR_DENOMINATIONS.includes(d.denominationMinor)) {
      return {
        ok: false,
        refusedBecause: 'unknown_denomination',
        sumMinor: 0,
        detail: `${d.denominationMinor} paise is not an Indian note or coin — the breakdown can only be counted in real denominations`,
      };
    }
    if (!Number.isInteger(d.count) || d.count < 0) {
      return {
        ok: false,
        refusedBecause: 'negative_or_fractional_count',
        sumMinor: 0,
        detail: `a count of ${d.count} for the ${d.denominationMinor / 100} rupee denomination is not a whole, non-negative number of notes/coins`,
      };
    }
  }

  const sumMinor = sumDenominations(input.denominations);
  if (sumMinor !== input.countedCashMinor) {
    return {
      ok: false,
      refusedBecause: 'does_not_sum_to_the_count',
      sumMinor,
      detail: `the notes and coins add up to ₹${(sumMinor / 100).toFixed(2)}, but the counted total was entered as ₹${(input.countedCashMinor / 100).toFixed(2)} — fix the breakdown at the drawer before closing, not at audit`,
    };
  }

  return { ok: true, sumMinor, detail: `${input.denominations.length} denomination(s) counted, summing to ₹${(sumMinor / 100).toFixed(2)}` };
}
