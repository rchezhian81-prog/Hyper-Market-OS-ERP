// Supplier bank-change verification (M06-FR-01) — a key fraud control. Any change
// to a supplier's bank details requires INDEPENDENT verification and approval before
// any payment can be made, and the person who requested the change can never be the
// one who approves it (§28 — the user who creates/edits a supplier cannot approve
// its bank details). An unverified change blocks payment (never silent). Pure — the
// approval is a human DecidedRequest produced upstream (packages/approvals).

import type { DecidedRequest } from '../../approvals/src/approvals';

export interface BankDetailChange {
  /** Change-request id — the subjectRef an approval must reference. */
  readonly id: string;
  readonly supplierId: string;
  /** The maker who requested the change. */
  readonly requestedBy: string;
  /** A masked/tokenised bank account reference (PRV: no raw account stored here). */
  readonly newAccountRef: string;
  readonly at: string; // ISO-8601 UTC
  /** The independent verification/approval, by a different person (§28). */
  readonly approval?: DecidedRequest;
}

export interface VerifiedBankChange {
  readonly supplierId: string;
  readonly accountRef: string;
  readonly verifiedBy: string;
  readonly status: 'verified';
  readonly at: string;
}

export class BankChangeUnverifiedError extends Error {
  constructor(id: string) {
    super(`Bank change "${id}" is not independently verified — payment is blocked (M06-FR-01 / §28).`);
    this.name = 'BankChangeUnverifiedError';
  }
}

/**
 * Verify a supplier bank-detail change. Requires a valid approval for THIS change,
 * decided by someone OTHER than the requester (§28). Returns the verified change, or
 * throws `BankChangeUnverifiedError` (which must block payment). Deterministic.
 */
export function verifyBankChange(change: BankDetailChange): VerifiedBankChange {
  const a = change.approval;
  const valid =
    a !== undefined &&
    a.status === 'approved' &&
    a.subjectRef === change.id &&
    a.decidedBy !== change.requestedBy; // maker ≠ approver
  if (!valid) {
    throw new BankChangeUnverifiedError(change.id);
  }
  return {
    supplierId: change.supplierId,
    accountRef: change.newAccountRef,
    verifiedBy: a.decidedBy,
    status: 'verified',
    at: change.at,
  };
}

/** True if a supplier may be paid: not blocked, and no unverified bank change pending. */
export function isPayable(state: {
  readonly blocked?: boolean;
  readonly hasUnverifiedBankChange?: boolean;
}): boolean {
  return !state.blocked && !state.hasUnverifiedBankChange;
}
