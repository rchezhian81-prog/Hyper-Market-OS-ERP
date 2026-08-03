import { describe, it, expect } from 'vitest';
import {
  reconcileCount,
  onHandMinor,
  InvalidCountError,
} from '../../packages/counts/src/index';
import { ApprovalRequiredError } from '../../packages/adjustment/src/index';
import { money } from '../../packages/contracts/src/money';
import { makeEvent } from '../../packages/contracts/src/event';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { requestApproval, decide, type Approver } from '../../packages/approvals/src/index';

// A blind count is checked against the projected ledger; a variance becomes a
// valued, reason-coded, approved compensating adjustment — and the counter can
// never approve their own variance (M09-FR-04 / §28).

const AT = '2026-08-02T14:00:00Z';

/** Seed on-hand for a product by appending an inbound movement to the ledger. */
function seedOnHand(ledger: Ledger, productId: string, qty: number) {
  ledger.append(
    makeEvent({
      id: `seed:${productId}`,
      type: 'InventoryMoved',
      occurredAt: AT,
      idempotencyKey: `seed:${productId}`,
      source: 'wh-1',
      payload: { productId, deltaMinor: qty, uom: 'ea' },
    }),
  );
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'count-1',
    productId: 'p1',
    locationId: 'loc-1',
    uom: 'ea',
    countedMinor: 8,
    counterId: 'counter-1',
    at: AT,
    reasonCode: 'cycle_count_variance',
    valuePerUnit: money(50_00, 'INR'), // ₹50 per item
    thresholdMinor: 500_00, // ₹500 material threshold
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

describe('reconcileCount', () => {
  it('reconciles with no adjustment when the count matches the ledger', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    seedOnHand(ledger, 'p1', 10);

    const result = reconcileCount(baseInput({ countedMinor: 10 }), ledger, outbox);
    expect(result.expectedMinor).toBe(10);
    expect(result.varianceMinor).toBe(0);
    expect(result.reconciled).toBe(true);
    expect(result.adjusted).toBe(false);
    expect(ledger.entries()).toHaveLength(1); // just the seed
    expect(outbox.unsentCount()).toBe(0);
  });

  it('derives the expected quantity from the ledger (blind — counter never supplies it)', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    seedOnHand(ledger, 'p1', 10);
    expect(onHandMinor(ledger, 'p1')).toBe(10);
    const result = reconcileCount(baseInput({ countedMinor: 8 }), ledger, outbox);
    expect(result.expectedMinor).toBe(10); // computed, not passed in
  });

  it('commits a small (immaterial) variance without approval and values it exactly', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    seedOnHand(ledger, 'p1', 10);

    const result = reconcileCount(baseInput({ countedMinor: 8 }), ledger, outbox);
    expect(result.varianceMinor).toBe(-2); // shrinkage
    expect(result.varianceValue).toEqual(money(100_00, 'INR')); // 2 × ₹50
    expect(result.adjusted).toBe(true);
    expect(result.requiredApproval).toBe(false);
    // the seed + one compensating InventoryAdjusted
    expect(ledger.entries()).toHaveLength(2);
    expect(ledger.entries()[1]?.event.type).toBe('InventoryAdjusted');
    expect(ledger.project(0, (s, e) => s + ((e.payload as { deltaMinor: number }).deltaMinor)))
      .toBe(8); // ledger now matches the count
  });

  it('blocks a material variance with no approval', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    seedOnHand(ledger, 'p1', 10);
    // count 4 → variance -6 → ₹300 value; drop the threshold so it is material
    expect(() =>
      reconcileCount(baseInput({ countedMinor: 4, thresholdMinor: 100_00 }), ledger, outbox),
    ).toThrow(ApprovalRequiredError);
    expect(ledger.entries()).toHaveLength(1); // only the seed — nothing committed
  });

  it('commits a material variance with a valid separate approval', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    seedOnHand(ledger, 'p1', 10);
    const result = reconcileCount(
      baseInput({ countedMinor: 4, thresholdMinor: 100_00, approval: approvalFor('count-1') }),
      ledger,
      outbox,
    );
    expect(result.requiredApproval).toBe(true);
    expect(result.adjusted).toBe(true);
    expect(ledger.entries()).toHaveLength(2);
  });

  it('rejects a variance approved by the counter themselves (§28)', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    seedOnHand(ledger, 'p1', 10);
    const selfApproval = approvalFor('count-1', 'counter-1'); // same person who counted
    expect(() =>
      reconcileCount(
        baseInput({ countedMinor: 4, thresholdMinor: 100_00, approval: selfApproval }),
        ledger,
        outbox,
      ),
    ).toThrow(ApprovalRequiredError);
  });

  it('rejects a negative count', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    seedOnHand(ledger, 'p1', 10);
    expect(() => reconcileCount(baseInput({ countedMinor: -1 }), ledger, outbox)).toThrow(
      InvalidCountError,
    );
  });

  it('is idempotent on the count id (one compensating adjustment)', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    seedOnHand(ledger, 'p1', 10);
    reconcileCount(baseInput({ countedMinor: 8 }), ledger, outbox);
    reconcileCount(baseInput({ countedMinor: 8 }), ledger, outbox);
    // seed + exactly one adjustment; the re-count now reconciles
    expect(ledger.entries()).toHaveLength(2);
    expect(outbox.unsentCount()).toBe(1);
  });
});
