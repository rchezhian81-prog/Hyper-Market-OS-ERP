// Store / day close and controlled reopen (M14-FR-04) — settle the day and LOCK
// it, honouring the trading-day cut-off (M01-FR-02). Two hard gates from the
// roadmap acceptance: "the day cannot close with unresolved exceptions or unsent
// sales" — and (PF-08) not while a till shift of the day is still open — and a closed day is LOCKED (append-only corrections only) — a reopen
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
  /**
   * Till shifts of this trading day (or earlier) that are still OPEN — a float taken and no close counted (PF-08,
   * M14-FR-02/04). MUST be empty to close: a day cannot lock while a drawer's cash is unaccounted for. The store box,
   * which holds the till-cash log, always supplies it; a screen that only predicts the close may leave it out.
   */
  readonly openShifts?: readonly OpenShift[];
  /**
   * Card or UPI payments of this trading day (or earlier) that have NO final answer — the machine was asked and nothing
   * was recorded, or it gave no answer and the provider has not settled it (PF-06 · D04-FR-02 · WF-12 "tender
   * settlement"). MUST be empty to close: the day's takings are not known while a customer may or may not have paid.
   * The store box, which holds the payment-attempt log, always supplies it.
   */
  readonly pendingPayments?: readonly PendingPayment[];
  /**
   * OB-55 "A" (owner, 11 Oct 2026): the pending payments the manager CARRIES FORWARD to head office as named finance
   * exceptions instead of holding the close — allowed only with a SECOND person's approval (never the closer), naming
   * EVERY pending payment by its attempt id. Absent: the old refusal stands.
   */
  readonly carriedForward?: CarryForward;
}

/** OB-55: the second person's approval to close with the named pending payments carried forward. */
export interface CarryForward {
  /** The approval the store computer issued and spent for this close (its one-use approval register, PF-02). */
  readonly approvalId: string;
  /** Who approved — verified by their own PIN on the store computer; never the closer (§28). */
  readonly approvedBy: string;
  readonly reason: string;
  /** Each pending payment carried, by attempt id — must be exactly the pending set. */
  readonly attemptIds: readonly string[];
}

/** A card or UPI payment still waiting for its final answer. */
export interface PendingPayment {
  readonly attemptId: string;
  readonly laneId: string;
  readonly billRef: string;
  readonly kind: 'card' | 'upi';
  readonly amountMinor: number;
  readonly askedAt: string;
  /** `asked` — the machine was asked and no answer was ever recorded; `no_answer` — it gave none and the provider has not settled it. */
  readonly state: 'asked' | 'no_answer';
}

/** A till whose shift is still open — who holds it and since when. */
export interface OpenShift {
  readonly tillId: string;
  readonly custodian: string;
  readonly openedAt: string;
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

export class OpenShiftsError extends Error {
  constructor(id: string, open: readonly OpenShift[]) {
    const named = open.map((o) => `till ${o.tillId} (held by ${o.custodian} since ${o.openedAt})`).join(', ');
    super(`Day close "${id}" is blocked: ${open.length} till shift(s) still open — ${named}. Count and close each drawer first (M14-FR-02).`);
    this.name = 'OpenShiftsError';
  }
}

export class PendingPaymentsError extends Error {
  readonly pending: readonly PendingPayment[];
  constructor(id: string, pending: readonly PendingPayment[]) {
    const rupees = (m: number): string => `Rs ${(m / 100).toFixed(2)}`;
    const named = pending.map((p) => `${p.kind === 'upi' ? 'UPI' : 'card'} payment ${p.attemptId} on till ${p.laneId}, bill ${p.billRef}, ${rupees(p.amountMinor)}, since ${p.askedAt} (${p.state === 'asked' ? 'no answer was recorded from the machine' : 'the machine gave no answer and the provider has not settled it'})`).join('; ');
    super(`Day close "${id}" is blocked: ${pending.length} card/UPI payment(s) still have no final answer — ${named}. Check each one against the provider before the day can close; do not run the card again (D04-FR-02).`);
    this.name = 'PendingPaymentsError';
    this.pending = pending;
  }
}

export class CarryForwardRefusedError extends Error {
  constructor(id: string, why: string) {
    super(`Day close "${id}" cannot carry the pending card/UPI payments forward: ${why}`);
    this.name = 'CarryForwardRefusedError';
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
 * `StoreDayClosed` event and queues it for sync. Idempotent on the day-close id.
 *
 * The event's payload is the cloud's synced-day-close contract verbatim — the exact
 * fields `POST /v1/pos/day-close/:dayCloseId/synced` reads (`storeId`, `tradingDay`,
 * `closedBy`, `closedAt`) plus the id and its lock — so the sync agent relays
 * `event.payload` straight to that route with no separate translator (the day close
 * is minted here, not read back off a lane's disk like a refund).
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
  if (input.openShifts !== undefined && input.openShifts.length > 0) {
    throw new OpenShiftsError(input.id, input.openShifts);
  }
  const carried = carriedPayments(input);


  outbox.enqueue(
    makeEvent({
      id: `${input.id}:closed`,
      type: 'StoreDayClosed',
      occurredAt: input.closedAt,
      idempotencyKey: `day-close:${input.id}`,
      source: input.storeId,
      payload: {
        dayCloseId: input.id,
        storeId: input.storeId,
        tradingDay: input.tradingDay,
        closedBy: input.closedBy,
        // The cloud route reads `closedAt` from the body (the event's occurredAt is transport
        // metadata, not part of the posted payload), so carry it explicitly.
        closedAt: input.closedAt,
        locked: true,
        ...(carried.length === 0 ? {} : { carriedForward: carriedForwardOf(input.carriedForward!, carried) }),
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
 * OB-55: which pending payments this close carries forward — none when nothing is pending. Throws the old refusal when a
 * payment is pending and no carry-forward is given; refuses a carry-forward approved by the closer, or one that does not
 * name exactly the pending payments (a payment left out would be silently closed over; one named that is not pending
 * would be a false exception).
 */
export function carriedPayments(input: Pick<CloseDayInput, 'id' | 'closedBy' | 'pendingPayments' | 'carriedForward'>): readonly PendingPayment[] {
  const pending = input.pendingPayments ?? [];
  if (pending.length === 0) return [];
  const cf = input.carriedForward;
  if (cf === undefined) throw new PendingPaymentsError(input.id, pending);
  if (cf.approvedBy.trim() === '' || cf.approvedBy.trim() === input.closedBy.trim()) {
    throw new CarryForwardRefusedError(input.id, 'a second person must approve it — never the person closing the day (§28)');
  }
  if (cf.reason.trim() === '') throw new CarryForwardRefusedError(input.id, 'the approval needs a reason');
  const named = new Set(cf.attemptIds);
  const missing = pending.filter((p) => !named.has(p.attemptId)).map((p) => p.attemptId);
  const extra = [...named].filter((a) => !pending.some((p) => p.attemptId === a));
  if (missing.length > 0 || extra.length > 0 || named.size !== cf.attemptIds.length) {
    throw new CarryForwardRefusedError(input.id, `the approval must name each pending payment exactly once${missing.length > 0 ? ` — not named: ${missing.join(', ')}` : ''}${extra.length > 0 ? ` — not pending: ${extra.join(', ')}` : ''}`);
  }
  return pending;
}

/** The carried-forward block a close carries to head office — each payment by name, and the unresolved totals by kind. */
export function carriedForwardOf(cf: CarryForward, payments: readonly PendingPayment[]): {
  readonly approvalId: string; readonly approvedBy: string; readonly reason: string;
  readonly payments: readonly PendingPayment[]; readonly unresolvedMinor: { readonly card: number; readonly upi: number };
} {
  const sum = (k: 'card' | 'upi'): number => payments.filter((p) => p.kind === k).reduce((n, p) => n + p.amountMinor, 0);
  return {
    approvalId: cf.approvalId, approvedBy: cf.approvedBy, reason: cf.reason,
    payments: payments.map((p) => ({ attemptId: p.attemptId, laneId: p.laneId, billRef: p.billRef, kind: p.kind, amountMinor: p.amountMinor, askedAt: p.askedAt, state: p.state })),
    unresolvedMinor: { card: sum('card'), upi: sum('upi') },
  };
}

/**
 * Reopen a locked day close — controlled and audited (M14-FR-04). Requires a valid
 * approval for this day close, decided by someone OTHER than the person reopening
 * (§28). Emits a `StoreDayReopened` event and queues it for sync — its payload is the
 * exact body `POST /v1/pos/day-close/:dayCloseId/reopen/synced` reads (`reopenedBy`,
 * `reason`, `approvedBy`), which the cloud re-verifies. Idempotent on the day-close id.
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
      type: 'StoreDayReopened',
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
