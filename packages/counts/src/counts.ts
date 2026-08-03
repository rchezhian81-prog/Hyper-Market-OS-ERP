// Cycle / blind physical count reconciliation (M09-FR-04) — the honest count. The
// counter enters a BLIND physical count (they never see the system-expected
// quantity); this engine derives the expected on-hand by PROJECTING the stock
// ledger, computes and VALUES the variance, and — when there is a variance —
// produces a reason-coded, approved COMPENSATING adjustment (M08-FR-03). Because
// the expected quantity is computed here and is never an input the counter
// supplies, blind-count integrity is structural, not a matter of UI discipline.
// The counter can never be the sole approver of their own variance (§28) — that is
// enforced by the adjustment engine's separation-of-duties check. Composes
// packages/adjustment, the append-only ledger and the sync outbox; counts are
// captured offline and reconciled on sync (§31). Idempotent on the count id.

import { multiplyByInteger, type Money } from '../../contracts/src/money';
import { commitAdjustment, type CommitAdjustmentInput } from '../../adjustment/src/adjustment';
import type { DecidedRequest } from '../../approvals/src/approvals';
import type { Ledger } from '../../ledger/src/ledger';
import type { SyncOutbox } from '../../sync/src/outbox';

export interface ReconcileCountInput {
  readonly id: string; // count / count-line id
  readonly productId: string;
  readonly locationId: string;
  readonly uom: string;
  /** The blind physical count, in the UOM's smallest unit (magnitude >= 0). */
  readonly countedMinor: number;
  /** Who counted — becomes the adjuster, and can never be the sole approver (§28). */
  readonly counterId: string;
  readonly at: string; // ISO-8601 UTC
  /** Root-cause / count reason code (mandatory for any resulting adjustment). */
  readonly reasonCode: string;
  /** Value of ONE UOM-smallest-unit — used to value the variance exactly. */
  readonly valuePerUnit: Money;
  /** Variance value at/above which an approval is required (per-tenant). */
  readonly thresholdMinor: number;
  /** An approval decision — required when the valued variance is material. */
  readonly approval?: DecidedRequest;
}

export interface CountReconciliation {
  readonly id: string;
  readonly productId: string;
  readonly locationId: string;
  /** System on-hand, projected from the ledger — hidden from the counter. */
  readonly expectedMinor: number;
  readonly countedMinor: number;
  /** counted − expected (positive = found more; negative = shrinkage). */
  readonly varianceMinor: number;
  /** The exact money value of the variance (magnitude). */
  readonly varianceValue: Money;
  /** True when the count matches the ledger (no adjustment needed). */
  readonly reconciled: boolean;
  /** True when a compensating adjustment was applied. */
  readonly adjusted: boolean;
  readonly requiredApproval: boolean;
  readonly at: string;
}

export class InvalidCountError extends Error {
  constructor(id: string) {
    super(`Count "${id}" must be a non-negative quantity.`);
    this.name = 'InvalidCountError';
  }
}

/**
 * The on-hand quantity for a product, projected from the stock ledger (never
 * stored). Sums the signed `deltaMinor` of every movement for the product — the
 * only honest way to know the expected quantity a blind count is checked against.
 */
export function onHandMinor(stockLedger: Ledger, productId: string): number {
  return stockLedger.project(0, (qty, event) => {
    const p = event.payload as { productId?: string; deltaMinor?: number };
    return p.productId === productId && typeof p.deltaMinor === 'number' ? qty + p.deltaMinor : qty;
  });
}

/**
 * Reconcile a blind count against the ledger. Computes the expected on-hand and
 * the valued variance; if the count matches, nothing is written. If it differs, a
 * reason-coded compensating adjustment is committed (with a separate approver when
 * the value is material — the counter can never approve their own variance).
 * Idempotent on the count id (the adjustment engine dedupes on it).
 */
export function reconcileCount(
  input: ReconcileCountInput,
  stockLedger: Ledger,
  outbox: SyncOutbox,
): CountReconciliation {
  if (!Number.isSafeInteger(input.countedMinor) || input.countedMinor < 0) {
    throw new InvalidCountError(input.id);
  }

  const expectedMinor = onHandMinor(stockLedger, input.productId);
  const varianceMinor = input.countedMinor - expectedMinor; // counted − expected
  const varianceValue = multiplyByInteger(input.valuePerUnit, Math.abs(varianceMinor));

  if (varianceMinor === 0) {
    // The aisle reconciles to the ledger — nothing to correct (M09-FR-04).
    return Object.freeze({
      id: input.id,
      productId: input.productId,
      locationId: input.locationId,
      expectedMinor,
      countedMinor: input.countedMinor,
      varianceMinor,
      varianceValue,
      reconciled: true,
      adjusted: false,
      requiredApproval: false,
      at: input.at,
    });
  }

  const adjustmentInput: CommitAdjustmentInput = {
    id: input.id,
    productId: input.productId,
    locationId: input.locationId,
    deltaMinor: varianceMinor, // the compensating correction toward the counted truth
    uom: input.uom,
    reasonCode: input.reasonCode,
    value: varianceValue,
    adjustedBy: input.counterId,
    at: input.at,
    thresholdMinor: input.thresholdMinor,
    approval: input.approval,
  };
  const adjustment = commitAdjustment(adjustmentInput, stockLedger, outbox);

  return Object.freeze({
    id: input.id,
    productId: input.productId,
    locationId: input.locationId,
    expectedMinor,
    countedMinor: input.countedMinor,
    varianceMinor,
    varianceValue,
    reconciled: false,
    adjusted: true,
    requiredApproval: adjustment.requiredApproval,
    at: input.at,
  });
}
