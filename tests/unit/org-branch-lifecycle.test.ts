import { describe, it, expect } from 'vitest';
import {
  evaluateTransition,
  isTrading,
  includeInLiveReports,
  closureEvidence,
  type BranchReadiness,
  type ClosureApproval,
  type TransitionRequest,
} from '../../packages/org/src/index';
import { money } from '../../packages/contracts/src/money';

// M01-FR-04 — opening and closing a branch touches stock, cash, staff access and
// reporting at once. Done ad-hoc it leaks all four. Every blocking reason is
// returned together, so the manager can plan the day rather than discover the next
// obstacle one attempt at a time.

const INR = 'INR' as const;
const AT = '2026-08-03T09:00:00Z';

function readiness(over: Partial<BranchReadiness> = {}): BranchReadiness {
  return {
    branchId: 'br-1',
    stockValue: money(0, INR),
    stockUnits: 0,
    cashBalance: money(0, INR),
    openDocuments: 0,
    unsentSyncItems: 0,
    unresolvedExceptions: 0,
    activeUserCount: 12,
    configured: true,
    devicesAssigned: 4,
    ...over,
  };
}

function request(over: Partial<TransitionRequest> = {}): TransitionRequest {
  return {
    branchId: 'br-1',
    transition: 'permanently_close',
    requestedBy: 'manager-1',
    reason: 'lease ended',
    at: AT,
    ...over,
  };
}

const OWNER_APPROVAL: ClosureApproval = {
  subjectRef: 'br-1',
  status: 'approved',
  decidedBy: 'owner-1',
};

describe('opening a branch', () => {
  it('opens a configured, staffed branch with the owner’s approval', () => {
    const result = evaluateTransition({
      request: request({ transition: 'open', reason: 'new branch ready' }),
      currentState: 'draft',
      readiness: readiness(),
      approval: OWNER_APPROVAL,
    });
    expect(result.allowed).toBe(true);
    expect(result.toState).toBe('open');
    expect(result.effects).toContain('branch starts trading');
  });

  it('refuses to open a branch that is not configured or has no till', () => {
    const result = evaluateTransition({
      request: request({ transition: 'open', reason: 'go live' }),
      currentState: 'draft',
      readiness: readiness({ configured: false, devicesAssigned: 0 }),
      approval: OWNER_APPROVAL,
    });
    expect(result.allowed).toBe(false);
    expect(result.blockers.map((b) => b.code)).toEqual(['not_configured', 'no_devices']);
    expect(result.toState).toBe('draft'); // unchanged
  });
});

describe('temporary closure — preserves state, blocks nothing', () => {
  it('closes temporarily with stock and cash still in place', () => {
    const result = evaluateTransition({
      request: request({ transition: 'temporarily_close', reason: 'annual maintenance', reopensOn: '2026-08-20' }),
      currentState: 'open',
      readiness: readiness({ stockUnits: 4_000, stockValue: money(1_500_000, INR), cashBalance: money(50_000, INR) }),
      approval: OWNER_APPROVAL,
    });
    expect(result.allowed).toBe(true);
    expect(result.toState).toBe('temporarily_closed');
    expect(result.effects).toContain('stock, cash, reservations and unsent sync items preserved');
    expect(result.effects).toContain('expected to reopen on 2026-08-20');
  });

  it('reopens without needing a fresh approval', () => {
    const result = evaluateTransition({
      request: request({ transition: 'reopen', requestedBy: 'manager-1', reason: 'maintenance finished' }),
      currentState: 'temporarily_closed',
      readiness: readiness(),
    });
    expect(result.allowed).toBe(true);
    expect(result.toState).toBe('open');
    expect(result.effects).toContain('preserved reservations and sync items resume');
  });

  it('a temporarily closed branch trades nothing but stays in the live reports', () => {
    expect(isTrading('temporarily_closed')).toBe(false);
    expect(includeInLiveReports('temporarily_closed')).toBe(true);
    expect(isTrading('open')).toBe(true);
    expect(includeInLiveReports('permanently_closed')).toBe(false);
  });
});

describe('permanent closure — blocked until nothing is left behind', () => {
  it('blocks closure with unsold stock, naming the amount (acceptance)', () => {
    const result = evaluateTransition({
      request: request(),
      currentState: 'open',
      readiness: readiness({ stockUnits: 812, stockValue: money(2_450_000, INR) }),
      approval: OWNER_APPROVAL,
    });
    expect(result.allowed).toBe(false);
    expect(result.blockers[0]?.code).toBe('stock_remains');
    expect(result.blockers[0]?.detail).toContain('812 units worth INR 24500.00');
    expect(result.blockers[0]?.detail).toContain('write off with approval');
  });

  it('returns every blocking reason at once, not one per attempt', () => {
    const result = evaluateTransition({
      request: request(),
      currentState: 'open',
      readiness: readiness({
        stockUnits: 100,
        stockValue: money(100_000, INR),
        cashBalance: money(7_550, INR),
        openDocuments: 3,
        unsentSyncItems: 6,
        unresolvedExceptions: 2,
      }),
      approval: OWNER_APPROVAL,
    });
    expect(result.blockers.map((b) => b.code)).toEqual([
      'stock_remains',
      'cash_remains',
      'open_documents',
      'unsent_sync',
      'unresolved_exceptions',
    ]);
    expect(result.blockers[1]?.detail).toContain('INR 75.50');
  });

  it('never closes over unsent sync items — that would destroy real sales (§31)', () => {
    const result = evaluateTransition({
      request: request(),
      currentState: 'open',
      readiness: readiness({ unsentSyncItems: 1 }),
      approval: OWNER_APPROVAL,
    });
    expect(result.allowed).toBe(false);
    expect(result.blockers[0]?.detail).toContain('never reached the cloud');
  });

  it('closes cleanly when nothing is left, and says exactly what it does', () => {
    const result = evaluateTransition({
      request: request(),
      currentState: 'open',
      readiness: readiness(),
      approval: OWNER_APPROVAL,
    });
    expect(result.allowed).toBe(true);
    expect(result.toState).toBe('permanently_closed');
    expect(result.effects).toContain('access revoked for 12 user(s)');
    // Closure is a state, not an erasure.
    expect(result.effects).toContain(
      'audit history and closure evidence retained in full — nothing is deleted',
    );
  });

  it('needs the owner’s approval, and never the closer’s own (§28)', () => {
    const unapproved = evaluateTransition({
      request: request(),
      currentState: 'open',
      readiness: readiness(),
    });
    expect(unapproved.blockers.map((b) => b.code)).toContain('approval_required');

    const selfApproved = evaluateTransition({
      request: request(),
      currentState: 'open',
      readiness: readiness(),
      approval: { subjectRef: 'br-1', status: 'approved', decidedBy: 'manager-1' },
    });
    expect(selfApproved.allowed).toBe(false);
    expect(selfApproved.blockers[0]?.code).toBe('self_approved');
  });

  it('refuses a transition that makes no sense from the current state', () => {
    const result = evaluateTransition({
      request: request({ transition: 'reopen', reason: 'oops' }),
      currentState: 'permanently_closed',
      readiness: readiness(),
    });
    expect(result.blockers[0]?.code).toBe('wrong_state');
    expect(result.blockers[0]?.detail).toContain('permanently closed');
  });

  it('refuses any transition with no reason recorded', () => {
    const result = evaluateTransition({
      request: request({ reason: '   ' }),
      currentState: 'open',
      readiness: readiness(),
      approval: OWNER_APPROVAL,
    });
    expect(result.blockers.map((b) => b.code)).toContain('no_reason');
  });
});

describe('closureEvidence — the pack kept for ever', () => {
  it('records who closed it, who approved it, and the final balances', () => {
    const state = readiness();
    const req = request();
    const result = evaluateTransition({
      request: req,
      currentState: 'open',
      readiness: state,
      approval: OWNER_APPROVAL,
    });
    const evidence = closureEvidence(result, req, state, 'owner-1');
    expect(evidence).toEqual({
      branchId: 'br-1',
      closedAt: AT,
      closedBy: 'manager-1',
      approvedBy: 'owner-1',
      reason: 'lease ended',
      finalStockValue: money(0, INR),
      finalCashBalance: money(0, INR),
      accessRevokedFor: 12,
    });
  });
});
