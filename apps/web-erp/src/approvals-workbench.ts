// Approvals workbench (M02 / §28) — the ERP screen where a manager clears the
// maker-checker queue. It is a thin, tested composition over the approval engine,
// and its job is to make the SEPARATION OF DUTIES obvious on screen rather than a
// surprise at submit time:
//
//   • a request the user MADE is never shown as actionable to them (§28) — it is
//     listed as theirs, waiting on someone else;
//   • a request beyond their authority or branch scope is shown but marked
//     "escalate", with the reason, instead of offering a button that will fail;
//   • deciding requires a reason, always (audit);
//   • the queue is ordered by value, so the biggest exposure is cleared first.
//
// Every actual decision still goes through `packages/approvals`, which is the single
// place the rules live — this workbench only prepares and delegates.

import { compare, type Money } from '../../../packages/contracts/src/money';
import {
  decide,
  type ApprovalRequest,
  type Approver,
  type Decision,
  type DecisionOutcome,
} from '../../../packages/approvals/src/approvals';

/** Why a queued request is not actionable by this user right now. */
export type BlockedReason = 'own_request' | 'out_of_scope' | 'exceeds_authority';

/** A queued request as the workbench presents it. */
export interface QueueRow {
  readonly request: ApprovalRequest;
  /** True when this user may decide it themselves. */
  readonly actionable: boolean;
  /** Why not, when `actionable` is false — shown instead of a dead button. */
  readonly blockedReason?: BlockedReason;
  /** Plain-English line for the row. */
  readonly sentence: string;
}

function rupees(value: Money | null): string {
  if (value === null) return 'no value';
  return `₹${(value.minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function inScope(approver: Approver, branchId: string | null): boolean {
  if (approver.branchScope === 'all') return true;
  if (branchId === null) return false;
  return approver.branchScope.includes(branchId);
}

function withinAuthority(approver: Approver, value: Money | null): boolean {
  if (value === null || approver.authorityLimit === null) return true;
  if (approver.authorityLimit.currency !== value.currency) return false;
  return compare(value, approver.authorityLimit) <= 0;
}

/** Classify why (or whether) this approver may act on a request. */
function classify(request: ApprovalRequest, approver: Approver): { actionable: boolean; reason?: BlockedReason } {
  // §28 first: the maker can never decide their own request, whatever their limit.
  if (request.requestedBy === approver.userId) {
    return { actionable: false, reason: 'own_request' };
  }
  if (!inScope(approver, request.branchId)) {
    return { actionable: false, reason: 'out_of_scope' };
  }
  if (!withinAuthority(approver, request.value)) {
    // Visible, but must be escalated — never a button that fails on submit.
    return { actionable: false, reason: 'exceeds_authority' };
  }
  return { actionable: true };
}

const BLOCKED_WORDS: Readonly<Record<BlockedReason, string>> = Object.freeze({
  own_request: 'your own request — someone else must decide it',
  out_of_scope: 'outside your branch scope',
  exceeds_authority: 'above your approval limit — escalate',
});

/**
 * Build the approver's queue: every pending request, marked actionable or not with
 * the reason, ordered by value (largest first) so the biggest exposure is cleared
 * first. Nothing is hidden — a request this user cannot decide is still visible, so
 * they can chase the right person.
 */
export function buildQueue(
  requests: readonly ApprovalRequest[],
  approver: Approver,
): QueueRow[] {
  return [...requests]
    .sort((a, b) => (b.value?.minor ?? 0) - (a.value?.minor ?? 0))
    .map((request) => {
      const { actionable, reason } = classify(request, approver);
      const subject = request.subjectType.replace(/_/g, ' ');
      const sentence =
        `${subject} for ${rupees(request.value)} from ${request.requestedBy}` +
        (actionable ? '' : ` — ${BLOCKED_WORDS[reason!]}`);
      return { request, actionable, ...(reason ? { blockedReason: reason } : {}), sentence };
    });
}

/** How many rows this approver can actually clear right now. */
export function actionableCount(rows: readonly QueueRow[]): number {
  return rows.filter((r) => r.actionable).length;
}

export class ReasonRequiredError extends Error {
  constructor() {
    super('A decision needs a reason — it is recorded in the audit trail.');
    this.name = 'ReasonRequiredError';
  }
}

/**
 * Decide a request from the workbench. The reason is mandatory here (so the screen
 * refuses before the engine has to), then the decision is delegated to the approval
 * engine, which remains the single place the §28 rules are enforced.
 */
export function submitDecision(
  request: ApprovalRequest,
  approver: Approver,
  decision: Decision,
  reason: string,
  decidedAt: string,
): DecisionOutcome {
  if (reason.trim() === '') {
    throw new ReasonRequiredError();
  }
  return decide(request, approver, decision, reason, decidedAt);
}
