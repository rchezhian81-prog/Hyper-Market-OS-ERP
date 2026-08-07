import { describe, it, expect } from 'vitest';
import {
  closeDay,
  reopenDay,
  DayNotEndedError,
  UnresolvedExceptionsError,
  UnsyncedSalesError,
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
    expect(outbox.pending()[0]?.event.type).toBe('PeriodClosed');
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
    expect(outbox.unsentCount()).toBe(0);
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
    expect(outbox.pending()[0]?.event.type).toBe('PeriodReopened');
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
