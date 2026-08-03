// Branch opening, temporary closure and permanent closure (M01-FR-04).
//
// Opening and closing a branch touches stock, cash, staff access and reporting all
// at once. Done ad-hoc it leaks all four: stock that belongs to nobody, a till float
// nobody counted, staff who still have access to a shop that no longer exists, and
// a month-end that silently loses a branch's sales.
//
// So each transition has PRECONDITIONS THAT ARE CHECKED, not remembered, and the
// blocking reasons are returned in full rather than one at a time — the manager
// needs the whole list to plan the day, not a door that opens one inch per attempt.
//
// The hard one is permanent closure. It is blocked while ANY of these is true:
//   • stock remains (sell it, transfer it, or write it off with approval);
//   • cash remains in a till or safe;
//   • orders or documents are still open;
//   • the edge has UNSENT SYNC ITEMS — closing a branch whose till still holds
//     unsynced sales destroys those sales (§31, hard rule #6);
//   • unresolved sync conflicts or exceptions exist.
//
// What closure never does: delete anything. Access is revoked, trading stops, the
// branch leaves the live reports — and the audit history stays fully readable for
// ever (hard rule #6). "Closed" is a state, not an erasure.
//
// Pure and deterministic: the timestamp is injected, there is no clock.

import type { Money } from '../../contracts/src/money';

export type BranchState = 'draft' | 'open' | 'temporarily_closed' | 'permanently_closed';

export type BranchTransition = 'open' | 'temporarily_close' | 'reopen' | 'permanently_close';

/** What is actually true at the branch right now — measured, never assumed. */
export interface BranchReadiness {
  readonly branchId: string;
  /** Stock still held, valued. Zero means genuinely nothing left. */
  readonly stockValue: Money;
  readonly stockUnits: number;
  /** Cash in tills and the safe. */
  readonly cashBalance: Money;
  /** Orders, purchase orders and documents not yet closed. */
  readonly openDocuments: number;
  /** Items the edge has not yet synced to the cloud (§31). */
  readonly unsentSyncItems: number;
  /** Sync conflicts and reconciliation exceptions nobody has resolved. */
  readonly unresolvedExceptions: number;
  /** Users still holding access to this branch. */
  readonly activeUserCount: number;
  /** Set for opening: the branch has been configured and staffed. */
  readonly configured?: boolean;
  readonly devicesAssigned?: number;
}

export interface ClosureApproval {
  readonly subjectRef: string;
  readonly status: 'approved' | 'rejected' | 'pending';
  readonly decidedBy: string;
}

export interface TransitionRequest {
  readonly branchId: string;
  readonly transition: BranchTransition;
  readonly requestedBy: string;
  readonly reason: string;
  /** ISO-8601 UTC. */
  readonly at: string;
  /** For a temporary closure: when trading is expected to resume. */
  readonly reopensOn?: string;
}

export interface Blocker {
  readonly code:
    | 'stock_remains'
    | 'cash_remains'
    | 'open_documents'
    | 'unsent_sync'
    | 'unresolved_exceptions'
    | 'not_configured'
    | 'no_devices'
    | 'wrong_state'
    | 'no_reason'
    | 'approval_required'
    | 'self_approved';
  /** Plain English, with the number — the manager needs to know how much. */
  readonly detail: string;
}

export interface TransitionResult {
  readonly branchId: string;
  readonly transition: BranchTransition;
  readonly allowed: boolean;
  readonly fromState: BranchState;
  /** The state it moves to when allowed; unchanged when blocked. */
  readonly toState: BranchState;
  /** Every reason it is blocked — the whole list, at once. */
  readonly blockers: readonly Blocker[];
  /** Actions the transition performs when it completes. */
  readonly effects: readonly string[];
  readonly at: string;
}

const NEXT_STATE: Readonly<Record<BranchTransition, BranchState>> = {
  open: 'open',
  temporarily_close: 'temporarily_closed',
  reopen: 'open',
  permanently_close: 'permanently_closed',
};

const VALID_FROM: Readonly<Record<BranchTransition, readonly BranchState[]>> = {
  open: ['draft'],
  temporarily_close: ['open'],
  reopen: ['temporarily_closed'],
  permanently_close: ['open', 'temporarily_closed'],
};

function moneyText(m: Money): string {
  const sign = m.minor < 0 ? '-' : '';
  const abs = Math.abs(m.minor);
  return `${sign}${m.currency} ${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Decide whether a branch transition may proceed, and return every blocking reason
 * at once. Never mutates anything — the caller applies the result, which is what
 * makes the decision testable and auditable on its own.
 */
export function evaluateTransition(input: {
  readonly request: TransitionRequest;
  readonly currentState: BranchState;
  readonly readiness: BranchReadiness;
  readonly approval?: ClosureApproval;
}): TransitionResult {
  const { request, currentState, readiness, approval } = input;
  const blockers: Blocker[] = [];
  const effects: string[] = [];

  if (!VALID_FROM[request.transition].includes(currentState)) {
    blockers.push({
      code: 'wrong_state',
      detail: `the branch is ${currentState.replace('_', ' ')}, so it cannot be ${request.transition.replace('_', ' ')}d`,
    });
  }
  if (request.reason.trim() === '') {
    blockers.push({ code: 'no_reason', detail: 'no reason was given for the change' });
  }

  // Every transition except reopening is owner-approved, and the person executing
  // is never the person approving (§28).
  const needsApproval = request.transition !== 'reopen';
  if (needsApproval) {
    if (approval === undefined || approval.status !== 'approved') {
      blockers.push({
        code: 'approval_required',
        detail: 'opening or closing a branch needs the owner’s approval',
      });
    } else if (approval.decidedBy === request.requestedBy) {
      blockers.push({
        code: 'self_approved',
        detail: 'the person making the change cannot also approve it (§28)',
      });
    }
  }

  switch (request.transition) {
    case 'open': {
      if (readiness.configured !== true) {
        blockers.push({ code: 'not_configured', detail: 'the branch is not configured yet' });
      }
      if ((readiness.devicesAssigned ?? 0) === 0) {
        blockers.push({ code: 'no_devices', detail: 'no till or device is assigned to the branch' });
      }
      effects.push('branch starts trading', 'assigned users and devices become active');
      break;
    }

    case 'temporarily_close': {
      // Deliberately NOT blocked on stock or cash — a temporary closure preserves
      // state. Reservations and unsent sync items survive and resume on reopen.
      effects.push(
        'trading suspended',
        'stock, cash, reservations and unsent sync items preserved',
        request.reopensOn === undefined
          ? 'no reopening date set'
          : `expected to reopen on ${request.reopensOn}`,
      );
      break;
    }

    case 'reopen': {
      effects.push('trading resumes', 'preserved reservations and sync items resume');
      break;
    }

    case 'permanently_close': {
      if (readiness.stockUnits !== 0 || readiness.stockValue.minor !== 0) {
        blockers.push({
          code: 'stock_remains',
          detail: `${readiness.stockUnits} units worth ${moneyText(readiness.stockValue)} still at the branch — sell, transfer, or write off with approval first`,
        });
      }
      if (readiness.cashBalance.minor !== 0) {
        blockers.push({
          code: 'cash_remains',
          detail: `${moneyText(readiness.cashBalance)} still in tills or the safe`,
        });
      }
      if (readiness.openDocuments !== 0) {
        blockers.push({
          code: 'open_documents',
          detail: `${readiness.openDocuments} open order(s) or document(s) still to settle`,
        });
      }
      if (readiness.unsentSyncItems !== 0) {
        // Closing over unsent items would destroy sales that were legitimately made.
        blockers.push({
          code: 'unsent_sync',
          detail: `${readiness.unsentSyncItems} item(s) never reached the cloud — closing now would lose them (§31)`,
        });
      }
      if (readiness.unresolvedExceptions !== 0) {
        blockers.push({
          code: 'unresolved_exceptions',
          detail: `${readiness.unresolvedExceptions} unresolved exception(s) — each one is a difference nobody has explained`,
        });
      }
      effects.push(
        'trading stops permanently',
        `access revoked for ${readiness.activeUserCount} user(s)`,
        'branch removed from live trading reports',
        'audit history and closure evidence retained in full — nothing is deleted',
      );
      break;
    }
  }

  const allowed = blockers.length === 0;
  return {
    branchId: request.branchId,
    transition: request.transition,
    allowed,
    fromState: currentState,
    toState: allowed ? NEXT_STATE[request.transition] : currentState,
    blockers,
    effects,
    at: request.at,
  };
}

/** A branch that has stopped trading, permanently or for now, sells nothing. */
export function isTrading(state: BranchState): boolean {
  return state === 'open';
}

/**
 * Closed branches leave the live trading reports but stay in history — the
 * distinction that keeps last year's comparison honest (M01-FR-04).
 */
export function includeInLiveReports(state: BranchState): boolean {
  return state === 'open' || state === 'temporarily_closed';
}

/** The record kept when a branch closes. Retained for ever (hard rule #6). */
export interface ClosureEvidence {
  readonly branchId: string;
  readonly closedAt: string;
  readonly closedBy: string;
  readonly approvedBy: string;
  readonly reason: string;
  readonly finalStockValue: Money;
  readonly finalCashBalance: Money;
  readonly accessRevokedFor: number;
}

/** Build the closure evidence pack from a completed permanent closure. */
export function closureEvidence(
  result: TransitionResult,
  request: TransitionRequest,
  readiness: BranchReadiness,
  approvedBy: string,
): ClosureEvidence {
  return {
    branchId: result.branchId,
    closedAt: result.at,
    closedBy: request.requestedBy,
    approvedBy,
    reason: request.reason,
    finalStockValue: readiness.stockValue,
    finalCashBalance: readiness.cashBalance,
    accessRevokedFor: readiness.activeUserCount,
  };
}
