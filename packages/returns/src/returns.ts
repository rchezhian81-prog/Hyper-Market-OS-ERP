// Returns, exchanges and refunds (M13) — take goods back fairly and safely, put
// the returned stock into the RIGHT state, and record the refund honestly. This
// composes the foundation, so it works with the network cable out (M13-FR-01
// acceptance): returned stock goes to the local append-only ledger and a
// ReturnAccepted event is queued for sync. Three M13 rules are enforced here:
//   • a line is returned at most once — cumulative return may not exceed what was
//     sold (M13-FR-01), so there is never a double refund;
//   • returned stock re-enters SELLABLE stock only when disposition = resell —
//     damaged/quarantine goods come back in a non-available state (M13-FR-02);
//   • a refund above the tenant threshold (or any no-receipt return) needs an
//     approval by a DIFFERENT person (M13-FR-03 / §28), and a refund can never
//     exceed the original paid amount.
// A card/UPI refund is a provider reversal (M13-FR-04): it is queued as PENDING
// and never assumed successful — the mirror of the no-invented-approval rule.
// Pure orchestration — approvals happen upstream (packages/approvals); the ledger
// and outbox are injected. Idempotent on the return id (§31.1).

import { makeEvent } from '../../contracts/src/event';
import { isNegative, isPositive, compare, type Money } from '../../contracts/src/money';
import type { TenderKind } from '../../contracts/src/enums';
import type { DecidedRequest } from '../../approvals/src/approvals';
import type { Ledger } from '../../ledger/src/ledger';
import type { SyncOutbox } from '../../sync/src/outbox';

/** Where a returned unit goes. Only 'resell' re-enters sellable stock (M13-FR-02). */
export type Disposition = 'resell' | 'quarantine' | 'damaged' | 'scrap';

/** The on-hand availability state each disposition puts stock into (M08-FR-02).
 * 'scrap' keeps no stock (the unit is destroyed) — it records no stock movement. */
const DISPOSITION_STATE: Readonly<Record<Disposition, string | null>> = Object.freeze({
  resell: 'on_hand', // available again
  quarantine: 'quarantine', // held, not available
  damaged: 'damaged', // not available
  scrap: null, // destroyed — no stock kept
});

export interface ReturnLineInput {
  readonly productId: string;
  readonly uom: string;
  /** Quantity being returned now, in the UOM's smallest unit (magnitude > 0). */
  readonly quantityMinor: number;
  /** Quantity originally sold on this line (for the at-most-once check). */
  readonly originalQtyMinor: number;
  /** Quantity already returned against this original line (caller-projected). */
  readonly alreadyReturnedMinor?: number;
  readonly disposition: Disposition;
}

export interface CommitReturnInput {
  readonly id: string;
  readonly number: string;
  /** The original sale this return is against; null ONLY for a no-receipt return. */
  readonly originalSaleId: string | null;
  /** A controlled no-receipt return — always needs approval and a cap (M13-FR-01). */
  readonly noReceipt?: boolean;
  readonly laneId: string;
  readonly processedBy: string;
  readonly processedAt: string; // ISO-8601 UTC
  readonly reasonCode: string;
  readonly lines: readonly ReturnLineInput[];
  /** The refund amount to give the customer. */
  readonly refund: Money;
  /** How the refund is given (drives the offline/pending distinction). */
  readonly refundTender: TenderKind;
  /** Maximum refundable for these lines (e.g. the original paid amount). */
  readonly maxRefund: Money;
  /** Refund value at/above which a separate approval is required (per-tenant). */
  readonly approvalThresholdMinor: number;
  /** Refund cap for a no-receipt return (per-tenant); required when noReceipt. */
  readonly noReceiptCapMinor?: number;
  /** An approval decision — required for a material or no-receipt refund. */
  readonly approval?: DecidedRequest;
}

/** A refund to cash/store credit settles offline immediately; a card/UPI refund
 * is a provider reversal that is queued and NEVER assumed successful (M13-FR-04). */
export type RefundStatus = 'settled' | 'pending';

const OFFLINE_SETTLED_TENDERS: readonly TenderKind[] = ['cash', 'store_credit'];

export interface CommittedReturn {
  readonly id: string;
  readonly number: string;
  readonly originalSaleId: string | null;
  readonly noReceipt: boolean;
  readonly refund: Money;
  readonly refundTender: TenderKind;
  readonly refundStatus: RefundStatus;
  readonly requiredApproval: boolean;
  /** Lines whose disposition = resell — the units back in sellable stock. */
  readonly restockedLines: number;
  readonly processedAt: string;
}

export class EmptyReturnError extends Error {
  constructor(id: string) {
    super(`Return "${id}" has no lines.`);
    this.name = 'EmptyReturnError';
  }
}

export class MissingReasonError extends Error {
  constructor(id: string) {
    super(`Return "${id}" needs a reason code.`);
    this.name = 'MissingReasonError';
  }
}

export class MissingOriginalSaleError extends Error {
  constructor(id: string) {
    super(`Return "${id}" must reference an original sale (or be a no-receipt return).`);
    this.name = 'MissingOriginalSaleError';
  }
}

export class InvalidReturnQuantityError extends Error {
  constructor(id: string, productId: string) {
    super(`Return "${id}" line "${productId}" must return a positive quantity.`);
    this.name = 'InvalidReturnQuantityError';
  }
}

export class OverReturnError extends Error {
  constructor(id: string, productId: string) {
    super(`Return "${id}" line "${productId}" would return more than was sold (M13-FR-01).`);
    this.name = 'OverReturnError';
  }
}

export class ExcessRefundError extends Error {
  constructor(id: string) {
    super(`Return "${id}" refund exceeds the allowed amount (M13-FR-03).`);
    this.name = 'ExcessRefundError';
  }
}

export class ApprovalRequiredError extends Error {
  constructor(id: string) {
    super(`Return "${id}" needs an approval by a different person (M13-FR-03 / §28).`);
    this.name = 'ApprovalRequiredError';
  }
}

/**
 * Commit a return locally and durably, then queue it for sync. Validates the M13
 * rules (at-most-once per line, refund never exceeds the allowed amount, approval
 * for material/no-receipt refunds by a separate person), appends one stock
 * movement per kept line to the append-only ledger in the disposition's state,
 * and enqueues a ReturnAccepted event — all with no network call. A card/UPI
 * refund is recorded as a PENDING reversal (never assumed successful). Idempotent
 * on the return id.
 */
export function commitReturn(
  input: CommitReturnInput,
  stockLedger: Ledger,
  outbox: SyncOutbox,
): CommittedReturn {
  const noReceipt = input.noReceipt ?? false;

  if (input.lines.length === 0) {
    throw new EmptyReturnError(input.id);
  }
  if (input.reasonCode.trim() === '') {
    throw new MissingReasonError(input.id);
  }
  if (!noReceipt && (input.originalSaleId === null || input.originalSaleId.trim() === '')) {
    throw new MissingOriginalSaleError(input.id);
  }

  // Refund must be non-negative and within the allowed amount (never exceeds the
  // original paid — M13-FR-03; and within the no-receipt cap where it applies).
  if (isNegative(input.refund) || compare(input.refund, input.maxRefund) > 0) {
    throw new ExcessRefundError(input.id);
  }
  if (noReceipt) {
    const cap = input.noReceiptCapMinor;
    if (cap === undefined || input.refund.minor > cap) {
      throw new ExcessRefundError(input.id);
    }
  }

  // Per-line: a positive quantity, and cumulatively no more than was sold. The
  // sold-quantity check applies to receipted returns (a no-receipt return has no
  // original line to check against — the cap + approval are its controls).
  for (const line of input.lines) {
    if (line.quantityMinor <= 0) {
      throw new InvalidReturnQuantityError(input.id, line.productId);
    }
    if (!noReceipt) {
      const already = line.alreadyReturnedMinor ?? 0;
      if (line.quantityMinor + already > line.originalQtyMinor) {
        throw new OverReturnError(input.id, line.productId);
      }
    }
  }

  // Approval: a material refund or any no-receipt return needs a valid approval by
  // a DIFFERENT person (M13-FR-03 / §28). An AI agent can never authorise a refund
  // (AI-NFR-12) — the approval is a human DecidedRequest produced upstream.
  const materialRefund =
    isPositive(input.refund) && input.refund.minor >= input.approvalThresholdMinor;
  const requiredApproval = noReceipt || materialRefund;
  if (requiredApproval) {
    const a = input.approval;
    const valid =
      a !== undefined &&
      a.status === 'approved' &&
      a.subjectRef === input.id &&
      a.decidedBy !== input.processedBy; // separation of duties (§28)
    if (!valid) {
      throw new ApprovalRequiredError(input.id);
    }
  }

  // Append one stock movement per kept line (resell/quarantine/damaged); a scrapped
  // unit is destroyed and keeps no stock. Only resell re-enters sellable stock.
  let restockedLines = 0;
  for (const line of input.lines) {
    const state = DISPOSITION_STATE[line.disposition];
    if (state === null) {
      continue; // scrap: destroyed, no stock kept
    }
    if (line.disposition === 'resell') {
      restockedLines += 1;
    }
    stockLedger.append(
      makeEvent({
        id: `${input.id}:move:${line.productId}`,
        type: 'InventoryMoved',
        occurredAt: input.processedAt,
        idempotencyKey: `return-move:${input.id}:${line.productId}`,
        source: input.laneId,
        payload: {
          productId: line.productId,
          deltaMinor: Math.abs(line.quantityMinor), // inbound: stock comes back
          uom: line.uom,
          state, // availability depends on disposition (M13-FR-02)
          disposition: line.disposition,
        },
      }),
    );
  }

  const refundStatus: RefundStatus = OFFLINE_SETTLED_TENDERS.includes(input.refundTender)
    ? 'settled'
    : 'pending'; // card/UPI/split reversal — queued, never assumed successful (M13-FR-04)

  outbox.enqueue(
    makeEvent({
      id: `${input.id}:accepted`,
      type: 'ReturnAccepted',
      occurredAt: input.processedAt,
      idempotencyKey: `return:${input.id}`,
      source: input.laneId,
      payload: {
        returnId: input.id,
        number: input.number,
        originalSaleId: input.originalSaleId,
        noReceipt,
        laneId: input.laneId,
        processedBy: input.processedBy,
        reasonCode: input.reasonCode,
        refundMinor: input.refund.minor,
        currency: input.refund.currency,
        refundTender: input.refundTender,
        refundStatus,
        lineCount: input.lines.length,
      },
    }),
  );

  return Object.freeze({
    id: input.id,
    number: input.number,
    originalSaleId: input.originalSaleId,
    noReceipt,
    refund: input.refund,
    refundTender: input.refundTender,
    refundStatus,
    requiredApproval,
    restockedLines,
    processedAt: input.processedAt,
  });
}
