// Maker-checker approval engine — §28 separation of duties and M02 (maker-checker,
// value-limit routing, escalation). The core invariant: the person who MAKES a
// request can never be the one who APPROVES it (§28, and the spirit of hard rule
// #5 — a critical action needs an authorised human, not the requester). Pure
// domain logic: no storage, no I/O. A decision is validated and produces a new
// immutable record; a decided request is terminal (a change is a new request).

import { compare, type Money } from '../../contracts/src/money';

/** A pending request routed for approval. */
export interface ApprovalRequest {
  readonly id: string;
  /** What needs approval, e.g. "price_change", "refund", "purchase_order". */
  readonly subjectType: string;
  readonly subjectRef: string;
  /** The maker (requesting user). */
  readonly requestedBy: string;
  /** Branch scope; null = company-wide. */
  readonly branchId: string | null;
  /** Value for threshold routing (M02-FR-03); null = no monetary value. */
  readonly value: Money | null;
  readonly status: 'pending';
}

/** An approver's authority: where they may approve, and up to what value. */
export interface Approver {
  readonly userId: string;
  /** Branches they may approve in, or "all" for company-wide authority. */
  readonly branchScope: readonly string[] | 'all';
  /** Maximum value they may approve; null = unlimited. */
  readonly authorityLimit: Money | null;
}

export type Decision = 'approved' | 'rejected';

/** A decided (terminal) request. */
export interface DecidedRequest {
  readonly id: string;
  readonly subjectType: string;
  readonly subjectRef: string;
  readonly requestedBy: string;
  readonly branchId: string | null;
  readonly value: Money | null;
  readonly status: Decision;
  readonly decidedBy: string;
  readonly reason: string;
  /** ISO-8601 UTC timestamp (injected by the caller). */
  readonly decidedAt: string;
}

export type RefusalReason =
  | 'self_approval_forbidden' // §28: the maker cannot decide their own request
  | 'reason_required' // every decision must carry a reason (audit)
  | 'out_of_scope' // the approver is not authorised for this branch
  | 'exceeds_authority'; // the value exceeds the approver's limit — escalate

export type DecisionOutcome =
  | { readonly ok: true; readonly request: DecidedRequest }
  | { readonly ok: false; readonly refusal: RefusalReason };

function requireNonEmpty(field: string, value: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RangeError(`Approval ${field} must be a non-empty string.`);
  }
}

export interface NewApprovalRequest {
  readonly id: string;
  readonly subjectType: string;
  readonly subjectRef: string;
  readonly requestedBy: string;
  readonly branchId?: string | null;
  readonly value?: Money | null;
}

/** Create a pending approval request (immutable). */
export function requestApproval(input: NewApprovalRequest): ApprovalRequest {
  requireNonEmpty('id', input.id);
  requireNonEmpty('subjectType', input.subjectType);
  requireNonEmpty('subjectRef', input.subjectRef);
  requireNonEmpty('requestedBy', input.requestedBy);
  return Object.freeze({
    id: input.id,
    subjectType: input.subjectType,
    subjectRef: input.subjectRef,
    requestedBy: input.requestedBy,
    branchId: input.branchId ?? null,
    value: input.value ?? null,
    status: 'pending',
  });
}

function isInScope(approver: Approver, branchId: string | null): boolean {
  if (approver.branchScope === 'all') return true;
  if (branchId === null) return false; // a company-wide request needs an "all"-scope approver
  return approver.branchScope.includes(branchId);
}

function hasAuthorityFor(approver: Approver, value: Money | null): boolean {
  if (value === null) return true; // no monetary value — any authorised approver may act
  if (approver.authorityLimit === null) return true; // unlimited authority
  if (approver.authorityLimit.currency !== value.currency) return false; // cannot compare across currencies
  return compare(value, approver.authorityLimit) <= 0; // value <= limit
}

/**
 * Decide a pending request. Enforces (in order): separation of duties (§28), a
 * mandatory reason, branch scope, and — for an approval — the approver's value
 * authority (M02-FR-03). Returns a typed refusal for a business rejection and a
 * decided, immutable request on success. Rejecting a request needs scope but not
 * spending authority — you don't need a budget to say no.
 */
export function decide(
  request: ApprovalRequest,
  approver: Approver,
  decision: Decision,
  reason: string,
  decidedAt: string,
): DecisionOutcome {
  if (approver.userId === request.requestedBy) {
    return { ok: false, refusal: 'self_approval_forbidden' };
  }
  if (reason.trim() === '') {
    return { ok: false, refusal: 'reason_required' };
  }
  if (!isInScope(approver, request.branchId)) {
    return { ok: false, refusal: 'out_of_scope' };
  }
  if (decision === 'approved' && !hasAuthorityFor(approver, request.value)) {
    return { ok: false, refusal: 'exceeds_authority' };
  }
  const decided: DecidedRequest = Object.freeze({
    id: request.id,
    subjectType: request.subjectType,
    subjectRef: request.subjectRef,
    requestedBy: request.requestedBy,
    branchId: request.branchId,
    value: request.value,
    status: decision,
    decidedBy: approver.userId,
    reason,
    decidedAt,
  });
  return { ok: true, request: decided };
}
