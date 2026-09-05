// Waste / write-off (M28-FR-01) — record what leaves as loss (wastage, damage,
// expiry, donation, destruction) as a reason-coded COMPENSATING stock movement
// (never an edit, hard rule #2), valued for finance (M23). A material loss needs an
// approval by a DIFFERENT person (§28) and captured EVIDENCE (photo/witness). This
// reuses the M08-FR-03 adjustment engine for the compensating movement and its
// separation-of-duties check, adding the loss-type framing and the evidence rule.
// Pure orchestration — the ledger and outbox are injected; idempotent on the id.

import { commitAdjustment, type CommitAdjustmentInput } from '../../adjustment/src/adjustment';
import type { Money } from '../../contracts/src/money';
import type { DecidedRequest } from '../../approvals/src/approvals';
import type { Ledger } from '../../ledger/src/ledger';
import type { SyncOutbox } from '../../sync/src/outbox';

export type LossType = 'wastage' | 'damage' | 'expiry' | 'donation' | 'destruction';

export interface WriteOffInput {
  readonly id: string;
  readonly productId: string;
  readonly locationId: string;
  /** Quantity written off, in the UOM's smallest unit (magnitude > 0; stock is removed). */
  readonly qty: number;
  readonly uom: string;
  readonly lossType: LossType;
  readonly reasonCode: string;
  /** Financial impact of the loss (magnitude used for the threshold; feeds M23). */
  readonly value: Money;
  readonly raisedBy: string;
  readonly at: string; // ISO-8601 UTC
  /** Value at/above which approval + evidence are required (per-tenant). */
  readonly thresholdMinor: number;
  /** Evidence reference (photo/witness) — required for a material loss. */
  readonly evidenceRef?: string;
  /** Approval for a material loss, by someone other than the raiser (§28). */
  readonly approval?: DecidedRequest;
}

export interface WrittenOff {
  readonly id: string;
  readonly productId: string;
  readonly lossType: LossType;
  readonly qtyRemoved: number;
  readonly value: Money;
  readonly requiredApproval: boolean;
  readonly evidenceRef: string | null;
  readonly at: string;
}

export class MissingReasonError extends Error {
  constructor(id: string) {
    super(`Write-off "${id}" needs a reason code (M28-FR-01).`);
    this.name = 'MissingReasonError';
  }
}

export class InvalidWriteOffError extends Error {
  constructor(id: string) {
    super(`Write-off "${id}" must remove a positive quantity.`);
    this.name = 'InvalidWriteOffError';
  }
}

export class MissingEvidenceError extends Error {
  constructor(id: string) {
    super(`Material write-off "${id}" needs captured evidence (photo/witness) (M28-FR-01).`);
    this.name = 'MissingEvidenceError';
  }
}

/**
 * The per-tenant material-loss threshold (M28-FR-01) — the write-off value at/above which captured
 * evidence AND a separate Manager/Owner approver are required. This is **configuration, not a per-request
 * input**: were the caller to send their own threshold, they could claim any loss "immaterial" and skip
 * the evidence and the second signature. The cloud route reads it from the tenant's stored policy (or the
 * default below); the owner may raise or lower it.
 */
export const DEFAULT_WRITE_OFF_THRESHOLD_MINOR = 50_000; // ₹500 in paise

/** Validate a proposed threshold from an untrusted body — a whole number of paise ≥ 0. */
export function readWriteOffThreshold(v: unknown): number | 'invalid' {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'invalid';
  const t = (v as Record<string, unknown>)['thresholdMinor'];
  if (typeof t !== 'number' || !Number.isInteger(t) || t < 0) return 'invalid';
  return t;
}

/**
 * Commit a write-off: validate a reason and (for a material value) evidence, then
 * append a reason-coded compensating stock movement via the adjustment engine —
 * which enforces the separate-approver rule for material losses (§28). The loss is
 * valued for finance. Idempotent on the id.
 */
export function commitWriteOff(
  input: WriteOffInput,
  stockLedger: Ledger,
  outbox: SyncOutbox,
): WrittenOff {
  if (input.reasonCode.trim() === '') {
    throw new MissingReasonError(input.id);
  }
  if (!Number.isSafeInteger(input.qty) || input.qty <= 0) {
    throw new InvalidWriteOffError(input.id);
  }

  const material = Math.abs(input.value.minor) >= input.thresholdMinor;
  if (material && (input.evidenceRef === undefined || input.evidenceRef.trim() === '')) {
    throw new MissingEvidenceError(input.id);
  }

  const adjustmentInput: CommitAdjustmentInput = {
    id: input.id,
    productId: input.productId,
    locationId: input.locationId,
    deltaMinor: -Math.abs(input.qty), // a loss removes stock
    uom: input.uom,
    reasonCode: `${input.lossType}:${input.reasonCode}`,
    value: input.value,
    adjustedBy: input.raisedBy,
    at: input.at,
    thresholdMinor: input.thresholdMinor,
    approval: input.approval,
  };
  const adjustment = commitAdjustment(adjustmentInput, stockLedger, outbox);

  return Object.freeze({
    id: input.id,
    productId: input.productId,
    lossType: input.lossType,
    qtyRemoved: input.qty,
    value: input.value,
    requiredApproval: adjustment.requiredApproval,
    evidenceRef: input.evidenceRef ?? null,
    at: input.at,
  });
}
