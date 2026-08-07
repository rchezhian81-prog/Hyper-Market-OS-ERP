import { describe, it, expect } from 'vitest';
import {
  commitAdjustment,
  MissingReasonError,
  ApprovalRequiredError,
} from '../../packages/adjustment/src/index';
import { money } from '../../packages/contracts/src/money';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { requestApproval, decide, type Approver } from '../../packages/approvals/src/index';

// A stock adjustment is a reason-coded compensating movement; a material one needs
// a separate approver (§28), and history is never edited (hard rule #2).

interface Move {
  deltaMinor: number;
}

const AT = '2026-08-02T11:00:00Z';

function baseInput(overrides = {}) {
  return {
    id: 'adj-1',
    productId: 'p1',
    locationId: 'loc-1',
    deltaMinor: -3, // shrinkage
    uom: 'ea',
    reasonCode: 'shrinkage',
    value: money(2_00, 'INR'),
    adjustedBy: 'clerk-1',
    at: AT,
    thresholdMinor: 100_00, // ₹100 threshold
    ...overrides,
  };
}

/** An approval for `subjectRef`, decided by `by`. Requester is distinct from the
 * decider so the approval engine allows it; the adjustment engine then applies its
 * own separation-of-duties check against the adjuster. */
function approvalFor(subjectRef: string, by = 'manager-9') {
  const req = requestApproval({
    id: subjectRef,
    subjectType: 'stock_adjustment',
    subjectRef,
    requestedBy: 'requester-0',
    value: money(500_00, 'INR'),
  });
  const approver: Approver = { userId: by, branchScope: 'all', authorityLimit: null };
  const outcome = decide(req, approver, 'approved', 'verified', AT);
  if (!outcome.ok) throw new Error('expected approval');
  return outcome.request;
}

describe('commitAdjustment', () => {
  it('commits a small adjustment without approval and appends a compensating movement', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const adj = commitAdjustment(baseInput(), ledger, outbox);
    expect(adj.requiredApproval).toBe(false);
    expect(ledger.entries()).toHaveLength(1);
    expect(outbox.unsentCount()).toBe(1);
    expect(ledger.project(0, (s, e) => s + (e.payload as Move).deltaMinor)).toBe(-3);
  });

  it('requires a reason code', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    expect(() => commitAdjustment(baseInput({ reasonCode: '  ' }), ledger, outbox)).toThrow(
      MissingReasonError,
    );
    expect(ledger.entries()).toHaveLength(0);
  });

  it('blocks a material adjustment without a valid approval', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const big = baseInput({ value: money(500_00, 'INR') }); // above ₹100 threshold
    expect(() => commitAdjustment(big, ledger, outbox)).toThrow(ApprovalRequiredError);
    expect(ledger.entries()).toHaveLength(0);
  });

  it('commits a material adjustment with a valid separate approval', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const big = baseInput({ value: money(500_00, 'INR'), approval: approvalFor('adj-1') });
    const adj = commitAdjustment(big, ledger, outbox);
    expect(adj.requiredApproval).toBe(true);
    expect(ledger.entries()).toHaveLength(1);
  });

  it('rejects self-approval on a material adjustment (§28)', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    // approval decided by the same person doing the adjustment is not valid here
    const selfApproval = approvalFor('adj-1', 'clerk-1');
    const big = baseInput({ value: money(500_00, 'INR'), approval: selfApproval });
    expect(() => commitAdjustment(big, ledger, outbox)).toThrow(ApprovalRequiredError);
  });

  it('is idempotent on the adjustment id', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    commitAdjustment(baseInput(), ledger, outbox);
    commitAdjustment(baseInput(), ledger, outbox);
    expect(ledger.entries()).toHaveLength(1);
    expect(outbox.unsentCount()).toBe(1);
  });
});
