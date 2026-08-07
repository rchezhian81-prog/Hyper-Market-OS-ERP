// Stock adjustment (M08-FR-03) — a reason-coded correction to stock, applied as a
// COMPENSATING movement on the append-only ledger (never an edit, hard rule #2).
// A material adjustment (value at or above the tenant's threshold) requires an
// approval by someone OTHER than the person adjusting (§28 separation of duties).
// Pure orchestration — approvals happen upstream (packages/approvals); the ledger
// and outbox are injected.

import { makeEvent } from '../../contracts/src/event';
import type { Money } from '../../contracts/src/money';
import type { DecidedRequest } from '../../approvals/src/approvals';
import type { Ledger } from '../../ledger/src/ledger';
import type { SyncOutbox } from '../../sync/src/outbox';

export interface CommitAdjustmentInput {
  readonly id: string;
  readonly productId: string;
  readonly locationId: string;
  /** Signed stock change in the UOM's smallest unit (e.g. -3 shrinkage, +2 found). */
  readonly deltaMinor: number;
  readonly uom: string;
  /** Mandatory reason code. */
  readonly reasonCode: string;
  /** Financial impact of the adjustment (magnitude used for the threshold). */
  readonly value: Money;
  readonly adjustedBy: string;
  readonly at: string; // ISO-8601 UTC
  /** Value at/above which an approval is required (per-tenant config). */
  readonly thresholdMinor: number;
  /** An approval decision — required when |value| >= threshold. */
  readonly approval?: DecidedRequest;
}

export interface CommittedAdjustment {
  readonly id: string;
  readonly productId: string;
  readonly deltaMinor: number;
  readonly reasonCode: string;
  readonly value: Money;
  readonly requiredApproval: boolean;
  readonly at: string;
}

export class MissingReasonError extends Error {
  constructor(id: string) {
    super(`Adjustment "${id}" needs a reason code.`);
    this.name = 'MissingReasonError';
  }
}

export class ApprovalRequiredError extends Error {
  constructor(id: string) {
    super(`Adjustment "${id}" exceeds the threshold and needs a separate approver's approval.`);
    this.name = 'ApprovalRequiredError';
  }
}

/**
 * Commit a stock adjustment: validate a reason and (for material values) a valid
 * approval by a different person, then append a compensating `InventoryAdjusted`
 * movement to the ledger and queue it for sync. Idempotent on the adjustment id.
 */
export function commitAdjustment(
  input: CommitAdjustmentInput,
  stockLedger: Ledger,
  outbox: SyncOutbox,
): CommittedAdjustment {
  if (input.reasonCode.trim() === '') {
    throw new MissingReasonError(input.id);
  }

  const requiredApproval = Math.abs(input.value.minor) >= input.thresholdMinor;
  if (requiredApproval) {
    const a = input.approval;
    const valid =
      a !== undefined &&
      a.status === 'approved' &&
      a.subjectRef === input.id &&
      a.decidedBy !== input.adjustedBy; // separation of duties (§28)
    if (!valid) {
      throw new ApprovalRequiredError(input.id);
    }
  }

  const event = makeEvent({
    id: `${input.id}:adj`,
    type: 'InventoryAdjusted',
    occurredAt: input.at,
    idempotencyKey: `adj:${input.id}`,
    source: input.locationId,
    payload: {
      productId: input.productId,
      locationId: input.locationId,
      deltaMinor: input.deltaMinor,
      uom: input.uom,
      reasonCode: input.reasonCode,
      valueMinor: input.value.minor,
      currency: input.value.currency,
    },
  });
  stockLedger.append(event); // compensating movement (append-only)
  outbox.enqueue(event); // queue for cloud sync

  return Object.freeze({
    id: input.id,
    productId: input.productId,
    deltaMinor: input.deltaMinor,
    reasonCode: input.reasonCode,
    value: input.value,
    requiredApproval,
    at: input.at,
  });
}
