import { describe, it, expect } from 'vitest';
import {
  closeDay,
  reopenDay,
  DayNotEndedError,
  UnresolvedExceptionsError,
  UnsyncedSalesError,
  OpenShiftsError,
  PendingPaymentsError,
  ReopenApprovalRequiredError,
} from '../../packages/day-close/src/index';
import { makeTradingDayRule } from '../../packages/calendar/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { money } from '../../packages/contracts/src/money';
import { requestApproval, decide, type Approver } from '../../packages/approvals/src/index';

// The store day close locks the day only when the trading day has ended and the
// day is fully reconciled (no open exceptions, no unsent items). A reopen is
// controlled and approved by a separate person (M14-FR-04).

// Cut-off 02:00 → trading day D runs 02:00 D to 02:00 D+1.
const RULE = makeTradingDayRule('02:00');

function baseClose(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dc-1',
    storeId: 'store-1',
    tradingDay: '2026-08-02',
    closedBy: 'manager-1',
    // 03:00 on 2026-08-03 is in trading day 2026-08-03 → 2026-08-02 has ended
    closedAtLocal: '2026-08-03T03:00',
    closedAt: '2026-08-02T21:30:00Z',
    tradingDayRule: RULE,
    unresolvedExceptions: 0,
    unsentSyncItems: 0,
    ...overrides,
  };
}

function reopenApproval(subjectRef: string, by = 'owner-1') {
  const req = requestApproval({
    id: subjectRef,
    subjectType: 'day_reopen',
    subjectRef,
    requestedBy: 'requester-0',
    value: money(0, 'INR'),
  });
  const approver: Approver = { userId: by, branchScope: 'all', authorityLimit: null };
  const outcome = decide(req, approver, 'approved', 'audit correction', '2026-08-03T10:00:00Z');
  if (!outcome.ok) throw new Error('expected approval');
  return outcome.request;
}

describe('closeDay', () => {
  it('locks the day when ended and fully reconciled', () => {
    const outbox = new SyncOutbox();
    const result = closeDay(baseClose(), outbox);
    expect(result.locked).toBe(true);
    expect(result.tradingDay).toBe('2026-08-02');
    expect(outbox.unsentCount()).toBe(1);
    const closed = outbox.pending()[0]?.event;
    expect(closed?.type).toBe('StoreDayClosed');
    // The payload is the cloud's synced-day-close contract verbatim, incl. closedAt (which the
    // cloud route reads from the body, not the event's transport-level occurredAt).
    expect(closed?.payload).toMatchObject({
      dayCloseId: 'dc-1', storeId: 'store-1', tradingDay: '2026-08-02',
      closedBy: 'manager-1', closedAt: '2026-08-02T21:30:00Z', locked: true,
    });
  });

  it('blocks closing a day that has not ended yet (before the cut-off)', () => {
    const outbox = new SyncOutbox();
    // 01:30 on 2026-08-03 is still trading day 2026-08-02 (before 02:00 cut-off)
    expect(() => closeDay(baseClose({ closedAtLocal: '2026-08-03T01:30' }), outbox)).toThrow(
      DayNotEndedError,
    );
    expect(outbox.unsentCount()).toBe(0);
  });

  it('blocks close while reconciliation exceptions are unresolved', () => {
    const outbox = new SyncOutbox();
    expect(() => closeDay(baseClose({ unresolvedExceptions: 2 }), outbox)).toThrow(
      UnresolvedExceptionsError,
    );
    expect(outbox.unsentCount()).toBe(0);
  });

  it('blocks close while unsent sales remain (M14-FR-04)', () => {
    const outbox = new SyncOutbox();
    expect(() => closeDay(baseClose({ unsentSyncItems: 5 }), outbox)).toThrow(UnsyncedSalesError);
  });

  it('PF-08: blocks while a till shift of the day is still open, naming the till and who holds it', () => {
    const outbox = new SyncOutbox();
    const open = [{ tillId: 'lane-2', custodian: 'u-meena', openedAt: '2026-08-02T03:30:00Z' }];
    expect(() => closeDay(baseClose({ openShifts: open }), outbox)).toThrow(OpenShiftsError);
    expect(() => closeDay(baseClose({ openShifts: open }), outbox)).toThrow(/till lane-2 \(held by u-meena/);
    expect(outbox.unsentCount()).toBe(0);
    expect(closeDay(baseClose({ openShifts: [] }), outbox).locked).toBe(true);
    expect(outbox.unsentCount()).toBe(1);
  });

  it('D04-FR-02 / PF-06: blocks while a card or UPI payment has no final answer, naming each one', () => {
    const outbox = new SyncOutbox();
    const pending = [
      { attemptId: 'PAY-1', laneId: 'lane-1', billRef: 'B-1', kind: 'card' as const, amountMinor: 64_000, askedAt: '2026-08-02T05:00:00Z', state: 'no_answer' as const },
      { attemptId: 'PAY-2', laneId: 'lane-2', billRef: 'B-2', kind: 'upi' as const, amountMinor: 41_000, askedAt: '2026-08-02T06:00:00Z', state: 'asked' as const },
    ];
    expect(() => closeDay(baseClose({ pendingPayments: pending }), outbox)).toThrow(PendingPaymentsError);
    expect(() => closeDay(baseClose({ pendingPayments: pending }), outbox)).toThrow(/2 card\/UPI payment\(s\) still have no final answer — card payment PAY-1 on till lane-1, bill B-1, Rs 640\.00/);
    expect(() => closeDay(baseClose({ pendingPayments: pending }), outbox)).toThrow(/UPI payment PAY-2 on till lane-2, bill B-2, Rs 410\.00, since 2026-08-02T06:00:00Z \(no answer was recorded from the machine\)/);
    expect(outbox.unsentCount()).toBe(0);
    expect(closeDay(baseClose({ pendingPayments: [] }), outbox).locked).toBe(true);
  });

  it('is idempotent on the day-close id', () => {
    const outbox = new SyncOutbox();
    closeDay(baseClose(), outbox);
    closeDay(baseClose(), outbox);
    expect(outbox.unsentCount()).toBe(1);
  });
});

describe('reopenDay', () => {
  const baseReopen = {
    id: 'dc-1',
    storeId: 'store-1',
    tradingDay: '2026-08-02',
    reopenedBy: 'manager-1',
    reopenedAt: '2026-08-03T10:05:00Z',
    reason: 'late supplier credit note',
  };

  it('reopens with a valid separate approval and records who approved it', () => {
    const outbox = new SyncOutbox();
    const result = reopenDay({ ...baseReopen, approval: reopenApproval('dc-1') }, outbox);
    expect(result.approvedBy).toBe('owner-1');
    const reopened = outbox.pending()[0]?.event;
    expect(reopened?.type).toBe('StoreDayReopened');
    // The payload is the cloud's synced-reopen contract: who reopened, the approver the cloud
    // re-verifies (§28), and the audited reason.
    expect(reopened?.payload).toMatchObject({
      dayCloseId: 'dc-1', reopenedBy: 'manager-1', approvedBy: 'owner-1', reason: 'late supplier credit note',
    });
  });

  it('blocks a reopen with no approval', () => {
    const outbox = new SyncOutbox();
    expect(() => reopenDay(baseReopen, outbox)).toThrow(ReopenApprovalRequiredError);
    expect(outbox.unsentCount()).toBe(0);
  });

  it('blocks a self-approved reopen (§28)', () => {
    const outbox = new SyncOutbox();
    const selfApproval = reopenApproval('dc-1', 'manager-1'); // same person reopening
    expect(() => reopenDay({ ...baseReopen, approval: selfApproval }, outbox)).toThrow(
      ReopenApprovalRequiredError,
    );
  });
});
