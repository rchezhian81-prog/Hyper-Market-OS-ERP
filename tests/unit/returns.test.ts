import { describe, it, expect } from 'vitest';
import {
  commitReturn,
  EmptyReturnError,
  MissingReasonError,
  MissingOriginalSaleError,
  OverReturnError,
  ExcessRefundError,
  ApprovalRequiredError,
} from '../../packages/returns/src/index';
import { money } from '../../packages/contracts/src/money';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { requestApproval, decide, type Approver } from '../../packages/approvals/src/index';

// A return puts goods back in the right stock state, refunds honestly, and gates
// material/no-receipt refunds on a separate human approver (M13). History is never
// edited (hard rule #2) — everything is a new append-only movement/event.

interface Move {
  deltaMinor: number;
  state?: string;
  disposition?: string;
}

const AT = '2026-08-02T12:00:00Z';

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ret-1',
    number: 'R-0001',
    originalSaleId: 'sale-1',
    laneId: 'lane-1',
    processedBy: 'clerk-1',
    processedAt: AT,
    reasonCode: 'changed_mind',
    lines: [
      {
        productId: 'p1',
        uom: 'ea',
        quantityMinor: 2,
        originalQtyMinor: 3,
        disposition: 'resell' as const,
      },
    ],
    refund: money(50_00, 'INR'),
    refundTender: 'cash' as const,
    maxRefund: money(150_00, 'INR'),
    approvalThresholdMinor: 100_00, // ₹100
    ...overrides,
  };
}

/** An approval for `subjectRef`, decided by `by` (distinct requester so the
 * approval engine allows it; commitReturn then applies its own SoD check). */
function approvalFor(subjectRef: string, by = 'manager-9') {
  const req = requestApproval({
    id: subjectRef,
    subjectType: 'refund',
    subjectRef,
    requestedBy: 'requester-0',
    value: money(500_00, 'INR'),
  });
  const approver: Approver = { userId: by, branchScope: 'all', authorityLimit: null };
  const outcome = decide(req, approver, 'approved', 'verified', AT);
  if (!outcome.ok) throw new Error('expected approval');
  return outcome.request;
}

describe('commitReturn', () => {
  it('commits a small receipted refund, restocks a resell line, and queues ReturnAccepted', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const ret = commitReturn(baseInput(), ledger, outbox);

    expect(ret.requiredApproval).toBe(false);
    expect(ret.refundStatus).toBe('settled'); // cash refund settles offline
    expect(ret.restockedLines).toBe(1);
    expect(ledger.entries()).toHaveLength(1);
    // stock comes back (positive) into sellable on_hand
    expect(ledger.project(0, (s, e) => s + (e.payload as Move).deltaMinor)).toBe(2);
    const move = ledger.entries()[0]?.event.payload as Move;
    expect(move.state).toBe('on_hand');
    const accepted = outbox.pending()[0]?.event;
    expect(accepted?.type).toBe('ReturnAccepted');
    expect(outbox.unsentCount()).toBe(1);
  });

  it('preserves batch/lot and condition through the return — onto the stock movement AND the event (M13-FR-02)', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    commitReturn(baseInput({
      lines: [{
        productId: 'p1', uom: 'ea', quantityMinor: 2, originalQtyMinor: 3,
        disposition: 'resell' as const, condition: 'sealed', batchId: 'LOT-42',
      }],
    }), ledger, outbox);

    // The stock movement carries the batch, so a recall (M10) can trace this returned unit to its lot.
    const move = ledger.entries()[0]?.event.payload as Move & { batchId?: string };
    expect(move.batchId).toBe('LOT-42');
    // The ReturnAccepted event carries both batch and condition, line by line.
    const line = (outbox.pending()[0]?.event.payload as { lines: { batchId?: string; condition?: string }[] }).lines[0];
    expect(line?.batchId).toBe('LOT-42');
    expect(line?.condition).toBe('sealed');
  });

  it('omits batch/condition cleanly when a return line names none (a non-batched product)', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    commitReturn(baseInput(), ledger, outbox); // baseInput has no batchId/condition

    const move = ledger.entries()[0]?.event.payload as Record<string, unknown>;
    expect('batchId' in move).toBe(false);
    const line = (outbox.pending()[0]?.event.payload as { lines: Record<string, unknown>[] }).lines[0];
    expect('batchId' in line!).toBe(false);
    expect('condition' in line!).toBe(false);
  });

  it('carries customerRef on ReturnAccepted for a store-credit refund, so the cloud issues the credit on sync (M13-FR-03/§31)', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    commitReturn(baseInput({ refundTender: 'store_credit', customerRef: 'c-asha' }), ledger, outbox);
    const payload = outbox.pending()[0]?.event.payload as { refundTender: string; customerRef?: string };
    expect(payload.refundTender).toBe('store_credit');
    expect(payload.customerRef).toBe('c-asha');
  });

  it('omits customerRef cleanly when a refund names no customer (a plain cash refund)', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    commitReturn(baseInput(), ledger, outbox); // baseInput has no customerRef
    const payload = outbox.pending()[0]?.event.payload as Record<string, unknown>;
    expect('customerRef' in payload).toBe(false);
  });

  it('forces a returned recalled batch OFF resale — held in quarantine, never back on the shelf (M13-FR-02 / M10)', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const ret = commitReturn(baseInput({
      lines: [{
        productId: 'p1', uom: 'ea', quantityMinor: 2, originalQtyMinor: 3,
        disposition: 'resell' as const, batchId: 'LOT-RECALL',
      }],
    }), ledger, outbox, (b) => b === 'LOT-RECALL');

    // The refund still happens — a recall WANTS the goods back — but the unit is held, not resold.
    expect(ret.refundStatus).toBe('settled');
    expect(ret.restockedLines).toBe(0);
    expect(ret.recallHeldLines).toBe(1);
    const move = ledger.entries()[0]?.event.payload as Move & { recallHeld?: boolean };
    expect(move.state).toBe('quarantine'); // NOT on_hand
    expect(move.disposition).toBe('quarantine');
    expect(move.recallHeld).toBe(true);
    const evLine = (outbox.pending()[0]?.event.payload as { lines: { disposition?: string; recallHeld?: boolean }[] }).lines[0];
    expect(evLine?.disposition).toBe('quarantine');
    expect(evLine?.recallHeld).toBe(true);
  });

  it('leaves a resell line alone when its batch is NOT recalled (and by default nothing is recalled)', () => {
    const recalledLine = [{ productId: 'p1', uom: 'ea', quantityMinor: 2, originalQtyMinor: 3, disposition: 'resell' as const, batchId: 'LOT-OK' }];

    const l1 = new Ledger(new InMemoryLedgerStore());
    const o1 = new SyncOutbox();
    const notRecalled = commitReturn(baseInput({ lines: recalledLine }), l1, o1, () => false);
    expect(notRecalled.restockedLines).toBe(1);
    expect(notRecalled.recallHeldLines).toBe(0);
    expect((l1.entries()[0]?.event.payload as Move).state).toBe('on_hand');

    const l2 = new Ledger(new InMemoryLedgerStore());
    const o2 = new SyncOutbox();
    const defaulted = commitReturn(baseInput({ lines: recalledLine }), l2, o2); // no predicate → nothing recalled
    expect(defaulted.restockedLines).toBe(1);
    expect(defaulted.recallHeldLines).toBe(0);
  });

  it('does not touch a recalled line that was not going to be resold (quarantine/scrap already)', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const ret = commitReturn(baseInput({
      lines: [{ productId: 'p1', uom: 'ea', quantityMinor: 2, originalQtyMinor: 3, disposition: 'scrap' as const, batchId: 'LOT-RECALL' }],
    }), ledger, outbox, (b) => b === 'LOT-RECALL');
    // Scrap keeps no stock and was never resell, so there is nothing to force and no hold to count.
    expect(ret.recallHeldLines).toBe(0);
    expect(ret.restockedLines).toBe(0);
    expect(ledger.entries()).toHaveLength(0); // scrap: destroyed, no movement
  });

  it('requires a reason code', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    expect(() => commitReturn(baseInput({ reasonCode: '  ' }), ledger, outbox)).toThrow(
      MissingReasonError,
    );
    expect(ledger.entries()).toHaveLength(0);
  });

  it('requires an original sale for a receipted return', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    expect(() => commitReturn(baseInput({ originalSaleId: null }), ledger, outbox)).toThrow(
      MissingOriginalSaleError,
    );
  });

  it('rejects an empty return', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    expect(() => commitReturn(baseInput({ lines: [] }), ledger, outbox)).toThrow(EmptyReturnError);
  });

  it('blocks returning more than was sold — a line is returned at most once (M13-FR-01)', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const over = baseInput({
      lines: [
        {
          productId: 'p1',
          uom: 'ea',
          quantityMinor: 2,
          originalQtyMinor: 3,
          alreadyReturnedMinor: 2, // 2 + 2 > 3
          disposition: 'resell' as const,
        },
      ],
    });
    expect(() => commitReturn(over, ledger, outbox)).toThrow(OverReturnError);
    expect(ledger.entries()).toHaveLength(0);
  });

  it('blocks a refund that exceeds the allowed amount (M13-FR-03)', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const excess = baseInput({ refund: money(200_00, 'INR'), maxRefund: money(150_00, 'INR') });
    expect(() => commitReturn(excess, ledger, outbox)).toThrow(ExcessRefundError);
  });

  it('blocks a material refund without a valid approval', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const big = baseInput({ refund: money(120_00, 'INR') }); // above ₹100 threshold
    expect(() => commitReturn(big, ledger, outbox)).toThrow(ApprovalRequiredError);
    expect(ledger.entries()).toHaveLength(0);
  });

  it('commits a material refund with a valid separate approval', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const big = baseInput({ refund: money(120_00, 'INR'), approval: approvalFor('ret-1') });
    const ret = commitReturn(big, ledger, outbox);
    expect(ret.requiredApproval).toBe(true);
    expect(ledger.entries()).toHaveLength(1);
  });

  it('rejects self-approval on a material refund (§28)', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const selfApproval = approvalFor('ret-1', 'clerk-1'); // same person processing
    const big = baseInput({ refund: money(120_00, 'INR'), approval: selfApproval });
    expect(() => commitReturn(big, ledger, outbox)).toThrow(ApprovalRequiredError);
  });

  it('always requires approval and a cap for a no-receipt return (M13-FR-01)', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    // small refund, but no receipt → approval mandatory
    const noReceipt = baseInput({
      originalSaleId: null,
      noReceipt: true,
      refund: money(20_00, 'INR'),
      noReceiptCapMinor: 50_00,
    });
    expect(() => commitReturn(noReceipt, ledger, outbox)).toThrow(ApprovalRequiredError);

    const approved = commitReturn({ ...noReceipt, approval: approvalFor('ret-1') }, ledger, outbox);
    expect(approved.requiredApproval).toBe(true);
    expect(approved.noReceipt).toBe(true);
  });

  it('blocks a no-receipt refund above the cap', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const overCap = baseInput({
      originalSaleId: null,
      noReceipt: true,
      refund: money(80_00, 'INR'),
      noReceiptCapMinor: 50_00,
      approval: approvalFor('ret-1'),
    });
    expect(() => commitReturn(overCap, ledger, outbox)).toThrow(ExcessRefundError);
  });

  it('does not return damaged stock to sellable availability (M13-FR-02)', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const damaged = baseInput({
      lines: [
        {
          productId: 'p1',
          uom: 'ea',
          quantityMinor: 1,
          originalQtyMinor: 3,
          disposition: 'damaged' as const,
        },
      ],
    });
    const ret = commitReturn(damaged, ledger, outbox);
    expect(ret.restockedLines).toBe(0);
    const move = ledger.entries()[0]?.event.payload as Move;
    expect(move.state).toBe('damaged'); // held, not available
  });

  it('keeps no stock for a scrapped return (destroyed)', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const scrap = baseInput({
      lines: [
        {
          productId: 'p1',
          uom: 'ea',
          quantityMinor: 1,
          originalQtyMinor: 3,
          disposition: 'scrap' as const,
        },
      ],
    });
    const ret = commitReturn(scrap, ledger, outbox);
    expect(ret.restockedLines).toBe(0);
    expect(ledger.entries()).toHaveLength(0); // no stock kept
    expect(outbox.unsentCount()).toBe(1); // but the return is still recorded
  });

  it('records a card refund as a pending reversal — never assumed successful (M13-FR-04)', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const card = baseInput({ refundTender: 'card' as const });
    const ret = commitReturn(card, ledger, outbox);
    expect(ret.refundStatus).toBe('pending');
  });

  it('is idempotent on the return id', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    commitReturn(baseInput(), ledger, outbox);
    commitReturn(baseInput(), ledger, outbox);
    expect(ledger.entries()).toHaveLength(1);
    expect(outbox.unsentCount()).toBe(1);
  });
});
