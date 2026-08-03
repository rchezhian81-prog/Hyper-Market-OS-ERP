// Purchase orders — issue with separation of duties (M06-FR-02) and open-commitment
// tracking (M06-FR-04). Buying is a controlled, approved commitment: a PO can only
// be issued with a valid approval by someone OTHER than the person who requisitioned
// it (§28 — a user cannot both raise and approve the same purchase), the approver's
// value authority having been checked when the approval was decided (packages/
// approvals). A blocked supplier can never be POed. Open commitment is ordered −
// received − cancelled, so it reconciles to receipts (M07). Pure and deterministic;
// composes the Money primitive and the approval engine (approval produced upstream).

import { add, zero, multiplyByInteger, type Money, type CurrencyCode } from '../../contracts/src/money';
import type { DecidedRequest } from '../../approvals/src/approvals';

export interface PurchaseOrderLineInput {
  readonly productId: string;
  readonly orderedQty: number; // whole units (> 0)
  readonly unitCost: Money;
}

export interface IssuePurchaseOrderInput {
  readonly id: string;
  readonly number: string;
  readonly supplierId: string;
  readonly requisitionedBy: string;
  readonly at: string; // ISO-8601 UTC
  readonly lines: readonly PurchaseOrderLineInput[];
  /** A blocked supplier can never receive a PO (M06-FR-01). */
  readonly supplierBlocked?: boolean;
  /** Approval for this PO, decided by someone other than the requisitioner (§28). */
  readonly approval?: DecidedRequest;
}

export interface IssuedPurchaseOrder {
  readonly id: string;
  readonly number: string;
  readonly supplierId: string;
  readonly requisitionedBy: string;
  readonly approvedBy: string;
  readonly total: Money;
  readonly status: 'issued';
  readonly at: string;
}

export class EmptyPurchaseOrderError extends Error {
  constructor(id: string) {
    super(`Purchase order "${id}" has no lines.`);
    this.name = 'EmptyPurchaseOrderError';
  }
}

export class BlockedSupplierError extends Error {
  constructor(supplierId: string) {
    super(`Supplier "${supplierId}" is blocked and cannot be issued a PO (M06-FR-01).`);
    this.name = 'BlockedSupplierError';
  }
}

export class ApprovalRequiredError extends Error {
  constructor(id: string) {
    super(`Purchase order "${id}" needs an approval by someone other than the requisitioner (M06-FR-02 / §28).`);
    this.name = 'ApprovalRequiredError';
  }
}

export class InvalidPurchaseOrderLineError extends Error {
  constructor(id: string, productId: string) {
    super(`Purchase order "${id}" line "${productId}" must order a positive quantity.`);
    this.name = 'InvalidPurchaseOrderLineError';
  }
}

function poTotal(lines: readonly PurchaseOrderLineInput[]): Money {
  const currency: CurrencyCode = lines[0]!.unitCost.currency;
  return lines.reduce((sum, l) => add(sum, multiplyByInteger(l.unitCost, l.orderedQty)), zero(currency));
}

/**
 * Issue a purchase order. Requires at least one valid line, an unblocked supplier,
 * and a valid approval by a DIFFERENT person than the requisitioner (§28). Returns
 * the issued PO with its total and the approver on record. Throws on any violation.
 */
export function issuePurchaseOrder(input: IssuePurchaseOrderInput): IssuedPurchaseOrder {
  if (input.lines.length === 0) {
    throw new EmptyPurchaseOrderError(input.id);
  }
  for (const line of input.lines) {
    if (!Number.isSafeInteger(line.orderedQty) || line.orderedQty <= 0) {
      throw new InvalidPurchaseOrderLineError(input.id, line.productId);
    }
  }
  if (input.supplierBlocked) {
    throw new BlockedSupplierError(input.supplierId);
  }

  const a = input.approval;
  const valid =
    a !== undefined &&
    a.status === 'approved' &&
    a.subjectRef === input.id &&
    a.decidedBy !== input.requisitionedBy; // separation of duties (§28)
  if (!valid) {
    throw new ApprovalRequiredError(input.id);
  }

  return {
    id: input.id,
    number: input.number,
    supplierId: input.supplierId,
    requisitionedBy: input.requisitionedBy,
    approvedBy: a.decidedBy,
    total: poTotal(input.lines),
    status: 'issued',
    at: input.at,
  };
}

export interface OpenCommitmentLine {
  readonly productId: string;
  readonly orderedQty: number;
  readonly receivedQty: number;
  readonly cancelledQty: number;
  /** ordered − received − cancelled (negative signals over-receipt). */
  readonly openQty: number;
  readonly openValue: Money;
}

export interface OpenCommitment {
  readonly lines: readonly OpenCommitmentLine[];
  readonly totalOpenValue: Money;
  /** True when nothing remains open (every line received/cancelled). */
  readonly fullyReceived: boolean;
}

/**
 * Compute the open commitment for a PO: for each line, ordered − received −
 * cancelled, valued at the PO unit cost. An over-receipt shows as a negative open
 * quantity (a signal, not silently hidden). Reconciles to receipts (M06-FR-04).
 */
export function computeOpenCommitment(
  lines: readonly PurchaseOrderLineInput[],
  receivedByProduct: Readonly<Record<string, number>> = {},
  cancelledByProduct: Readonly<Record<string, number>> = {},
): OpenCommitment {
  if (lines.length === 0) {
    throw new EmptyPurchaseOrderError('(open-commitment)');
  }
  const currency: CurrencyCode = lines[0]!.unitCost.currency;
  let totalOpenValue = zero(currency);
  const outLines = lines.map((line) => {
    const receivedQty = receivedByProduct[line.productId] ?? 0;
    const cancelledQty = cancelledByProduct[line.productId] ?? 0;
    const openQty = line.orderedQty - receivedQty - cancelledQty;
    const openValue = multiplyByInteger(line.unitCost, openQty);
    totalOpenValue = add(totalOpenValue, openValue);
    return { productId: line.productId, orderedQty: line.orderedQty, receivedQty, cancelledQty, openQty, openValue };
  });
  return {
    lines: outLines,
    totalOpenValue,
    fullyReceived: outLines.every((l) => l.openQty <= 0),
  };
}
