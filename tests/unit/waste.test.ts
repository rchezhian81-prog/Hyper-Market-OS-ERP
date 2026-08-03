import { describe, it, expect } from 'vitest';
import {
  commitWriteOff,
  MissingReasonError,
  MissingEvidenceError,
  InvalidWriteOffError,
} from '../../packages/waste/src/index';
import { ApprovalRequiredError } from '../../packages/adjustment/src/index';
import { money } from '../../packages/contracts/src/money';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { requestApproval, decide, type Approver } from '../../packages/approvals/src/index';

// A write-off is a reason-coded compensating loss; a material one needs a separate
// approver and captured evidence (M28-FR-01 / §28 / hard rule #2).

interface Move {
  deltaMinor: number;
}

const AT = '2026-08-02T10:00:00Z';

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wo-1',
    productId: 'p1',
    locationId: 'loc-1',
    qty: 2,
    uom: 'ea',
    lossType: 'expiry' as const,
    reasonCode: 'past_use_by',
    value: money(2_00, 'INR'),
    raisedBy: 'clerk-1',
    at: AT,
    thresholdMinor: 100_00,
    ...overrides,
  };
}

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

describe('commitWriteOff', () => {
  it('commits a small loss and appends one compensating removal', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const wo = commitWriteOff(baseInput(), ledger, outbox);
    expect(wo.requiredApproval).toBe(false);
    expect(ledger.entries()).toHaveLength(1);
    expect(ledger.project(0, (s, e) => s + (e.payload as Move).deltaMinor)).toBe(-2); // stock out
    expect(outbox.unsentCount()).toBe(1);
  });

  it('requires a reason code', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    expect(() => commitWriteOff(baseInput({ reasonCode: ' ' }), ledger, outbox)).toThrow(
      MissingReasonError,
    );
  });

  it('rejects a non-positive quantity', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    expect(() => commitWriteOff(baseInput({ qty: 0 }), ledger, outbox)).toThrow(InvalidWriteOffError);
  });

  it('requires evidence for a material loss', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const big = baseInput({ value: money(500_00, 'INR'), approval: approvalFor('wo-1') });
    expect(() => commitWriteOff(big, ledger, outbox)).toThrow(MissingEvidenceError);
  });

  it('requires a separate approval for a material loss', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const big = baseInput({ value: money(500_00, 'INR'), evidenceRef: 'photo-1' });
    expect(() => commitWriteOff(big, ledger, outbox)).toThrow(ApprovalRequiredError);
  });

  it('commits a material loss with evidence and a separate approval', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const big = baseInput({
      value: money(500_00, 'INR'),
      evidenceRef: 'photo-1',
      approval: approvalFor('wo-1'),
    });
    const wo = commitWriteOff(big, ledger, outbox);
    expect(wo.requiredApproval).toBe(true);
    expect(wo.evidenceRef).toBe('photo-1');
    expect(ledger.entries()).toHaveLength(1);
  });

  it('rejects a self-approved material loss (§28)', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const selfApproval = approvalFor('wo-1', 'clerk-1');
    const big = baseInput({ value: money(500_00, 'INR'), evidenceRef: 'photo-1', approval: selfApproval });
    expect(() => commitWriteOff(big, ledger, outbox)).toThrow(ApprovalRequiredError);
  });

  it('is idempotent on the write-off id', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    commitWriteOff(baseInput(), ledger, outbox);
    commitWriteOff(baseInput(), ledger, outbox);
    expect(ledger.entries()).toHaveLength(1);
  });
});
