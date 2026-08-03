// Store / day close and controlled reopen (M14-FR-04) — settle the day and LOCK
// it, honouring the trading-day cut-off (M01-FR-02). Two hard gates from the
// roadmap acceptance: "the day cannot close with unresolved exceptions or unsent
// sales", and a closed day is LOCKED (append-only corrections only) — a reopen
// requires approval and is audited. This composes the foundation: the trading-day
// calendar (a day can only close once its cut-off has passed), the sync outbox
// (the day close and reopen are queued), and the approval engine (reopen needs a
// separate approver). Pure orchestration; the outbox is injected. Idempotent on
// the day-close id (§31.1).

import { makeEvent } from '../../contracts/src/event';
import { tradingDate, type TradingDayRule } from '../../calendar/src/trading-day';
import type { DecidedRequest } from '../../approvals/src/approvals';
import type { SyncOutbox } from '../../sync/src/outbox';

export interface CloseDayInput {
  readonly id: string; // day-close id
  readonly storeId: string;
  /** The trading day (YYYY-MM-DD) being closed. */
  readonly tradingDay: string;
  readonly closedBy: string;
  /** Store-local wall-clock moment of the close ("YYYY-MM-DDTHH:MM"). */
  readonly closedAtLocal: string;
  /** ISO-8601 UTC timestamp for the event. */
  readonly closedAt: string;
  readonly tradingDayRule: TradingDayRule;
  /** Reconciliation exceptions still open — MUST be 0 to close. */
  readonly unresolvedExceptions: number;
  /** Locally-committed items not yet synced to cloud — MUST be 0 to close. */
  readonly unsentSyncItems: number;
}

export interface DayCloseResult {
  readonly id: string;
  readonly storeId: string;
  readonly tradingDay: string;
  readonly closedBy: string;
  readonly closedAt: string;
  /** A closed day is locked — corrections are new compensating events only. */
  readonly locked: true;
}

export interface ReopenDayInput {
  readonly id: string; // the day-close id being reopened
  readonly storeId: string;
  readonly tradingDay: string;
  readonly reopenedBy: string;
  readonly reopenedAt: string; // ISO-8601 UTC
  readonly reason: string;
  /** A valid approval for this reopen, decided by a DIFFERENT person (§28). */
  readonly approval?: DecidedRequest;
}

export interface DayReopenResult {
  readonly id: string;
  readonly storeId: string;
  readonly tradingDay: string;
  readonly reopenedBy: string;
  readonly approvedBy: string;
  readonly reason: string;
  readonly reopenedAt: string;
}

export class DayNotEndedError extends Error {
  constructor(tradingDay: string) {
    super(`Trading day "${tradingDay}" has not ended yet (before the cut-off) — cannot close.`);
    this.name = 'DayNotEndedError';
  }
}

export class UnresolvedExceptionsError extends Error {
  constructor(id: string, count: number) {
    super(`Day close "${id}" is blocked: ${count} unresolved exception(s) remain (M14-FR-04).`);
    this.name = 'UnresolvedExceptionsError';
  }
}

export class UnsyncedSalesError extends Error {
  constructor(id: string, count: number) {
    super(`Day close "${id}" is blocked: ${count} unsent item(s) not yet reconciled (M14-FR-04).`);
    this.name = 'UnsyncedSalesError';
  }
}

export class ReopenApprovalRequiredError extends Error {
  constructor(id: string) {
    super(`Reopening day close "${id}" needs an approval by a different person (M14-FR-04 / §28).`);
    this.name = 'ReopenApprovalRequiredError';
  }
}

/**
 * Close the store day and lock it. Blocks unless the trading day has ended (its
 * cut-off has passed), all reconciliation exceptions are resolved, and there are
 * no unsent items — matching the M14-FR-04 acceptance. On success, emits a locked
 * `PeriodClosed` event and queues it for sync. Idempotent on the day-close id.
 */
export function closeDay(input: CloseDayInput, outbox: SyncOutbox): DayCloseResult {
  // A day can only close once its trading-day cut-off has passed (M01-FR-02): the
  // current trading date must be later than the day being closed.
  const currentTradingDate = tradingDate(input.closedAtLocal, input.tradingDayRule);
  if (!(currentTradingDate > input.tradingDay)) {
    throw new DayNotEndedError(input.tradingDay);
  }
  if (input.unresolvedExceptions > 0) {
    throw new UnresolvedExceptionsError(input.id, input.unresolvedExceptions);
  }
  if (input.unsentSyncItems > 0) {
    throw new UnsyncedSalesError(input.id, input.unsentSyncItems);
  }

  outbox.enqueue(
    makeEvent({
      id: `${input.id}:closed`,
      type: 'PeriodClosed',
      occurredAt: input.closedAt,
      idempotencyKey: `day-close:${input.id}`,
      source: input.storeId,
      payload: {
        dayCloseId: input.id,
        storeId: input.storeId,
        tradingDay: input.tradingDay,
        closedBy: input.closedBy,
        locked: true,
      },
    }),
  );

  return Object.freeze({
    id: input.id,
    storeId: input.storeId,
    tradingDay: input.tradingDay,
    closedBy: input.closedBy,
    closedAt: input.closedAt,
    locked: true,
  });
}

/**
 * Reopen a locked day close — controlled and audited (M14-FR-04). Requires a valid
 * approval for this day close, decided by someone OTHER than the person reopening
 * (§28). Emits a `PeriodReopened` event and queues it for sync. Idempotent on the
 * day-close id.
 */
export function reopenDay(input: ReopenDayInput, outbox: SyncOutbox): DayReopenResult {
  const a = input.approval;
  const valid =
    a !== undefined &&
    a.status === 'approved' &&
    a.subjectRef === input.id &&
    a.decidedBy !== input.reopenedBy; // separation of duties (§28)
  if (!valid) {
    throw new ReopenApprovalRequiredError(input.id);
  }

  outbox.enqueue(
    makeEvent({
      id: `${input.id}:reopened`,
      type: 'PeriodReopened',
      occurredAt: input.reopenedAt,
      idempotencyKey: `day-reopen:${input.id}`,
      source: input.storeId,
      payload: {
        dayCloseId: input.id,
        storeId: input.storeId,
        tradingDay: input.tradingDay,
        reopenedBy: input.reopenedBy,
        approvedBy: a.decidedBy,
        reason: input.reason,
      },
    }),
  );

  return Object.freeze({
    id: input.id,
    storeId: input.storeId,
    tradingDay: input.tradingDay,
    reopenedBy: input.reopenedBy,
    approvedBy: a.decidedBy,
    reason: input.reason,
    reopenedAt: input.reopenedAt,
  });
}
