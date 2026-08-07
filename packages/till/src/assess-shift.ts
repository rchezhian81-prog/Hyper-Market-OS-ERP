// The cloud-side shift-close guard (M14-FR-02) — the blind cash count and over/short.
//
// `packages/till/till.ts` computes the same figures but enqueues to an injected outbox — the offline
// lane's shape. The cloud is where the cash office reconciles over/short across tills, so this is the
// pure computation it runs: expected cash, variance against the blind count, and whether the variance
// is MATERIAL (needs a reason and escalates). It commits nothing — the service records the close.
//
//   expected cash = opening float + cash sales − pickups − cash refunds
//   variance      = counted − expected   (positive = over, negative = short)

export interface ShiftCloseInput {
  readonly openingFloatMinor: number;
  /** Cash taken in sales during the shift. */
  readonly cashSalesMinor: number;
  /** Cash removed to the safe (pickups/safe drops) — reduces the till. */
  readonly pickupsMinor: number;
  /** Cash paid out as refunds — reduces the till. */
  readonly cashRefundsMinor: number;
  /** The blind physical count total (entered by denomination upstream, never shown at count time). */
  readonly countedCashMinor: number;
  /** |over/short| at/above which the variance is material and escalates. */
  readonly toleranceMinor: number;
  /** Reason for a material over/short — required when the variance is material. */
  readonly reasonCode?: string;
}

export type ShiftCloseRefusal = 'material_variance_needs_a_reason';

export interface ShiftCloseAssessment {
  readonly ok: boolean;
  readonly refusedBecause?: ShiftCloseRefusal;
  readonly detail: string;
  /** float + cash sales − pickups − cash refunds. Never shown before the count (blind). */
  readonly expectedMinor: number;
  readonly countedMinor: number;
  /** counted − expected (positive = over, negative = short). */
  readonly varianceMinor: number;
  readonly isOver: boolean;
  readonly isShort: boolean;
  readonly withinTolerance: boolean;
  /** True when the variance is material — a reconciliation exception should be raised (P-03 / M15). */
  readonly exceptionRaised: boolean;
  readonly reasonCode: string | null;
}

/**
 * Assess a cashier shift close against the blind count. A material over/short (|variance| at or above
 * tolerance) needs a reason and is raised as an exception; within tolerance it closes clean.
 */
export function assessShiftClose(input: ShiftCloseInput): ShiftCloseAssessment {
  const expectedMinor = input.openingFloatMinor + input.cashSalesMinor - input.pickupsMinor - input.cashRefundsMinor;
  const varianceMinor = input.countedCashMinor - expectedMinor;
  const material = Math.abs(varianceMinor) >= input.toleranceMinor;
  const reasonGiven = (input.reasonCode ?? '').trim() !== '';

  const base = {
    expectedMinor, countedMinor: input.countedCashMinor, varianceMinor,
    isOver: varianceMinor > 0, isShort: varianceMinor < 0,
    withinTolerance: !material, exceptionRaised: material,
    reasonCode: reasonGiven ? input.reasonCode! : null,
  };

  if (material && !reasonGiven) {
    return {
      ...base, ok: false, refusedBecause: 'material_variance_needs_a_reason',
      detail: `a ${varianceMinor < 0 ? 'short' : 'over'} of ${Math.abs(varianceMinor)} is at or above the tolerance of ${input.toleranceMinor} and needs a reason — a material variance nobody explained is the one an audit stops on`,
    };
  }

  return {
    ...base, ok: true,
    detail: material
      ? `${varianceMinor < 0 ? 'short' : 'over'} by ${Math.abs(varianceMinor)} — recorded with a reason and raised for reconciliation`
      : `counted ${input.countedCashMinor} against an expected ${expectedMinor}: within tolerance`,
  };
}
