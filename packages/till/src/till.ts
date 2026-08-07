// Cashier shift / till close (M14-FR-02) — the blind cash count and over/short.
// The cashier counts the drawer WITHOUT seeing the system-expected figure (the
// blind count protects integrity); this engine computes the expected cash and the
// over/short, records a reason when the variance is material, and — for a material
// variance — raises a valued reconciliation exception that escalates (P-03 / M15).
//
//   expected cash = opening float + cash sales − pickups − cash refunds  (M14-FR-02)
//   variance      = counted − expected   (positive = over, negative = short)
//
// Cash operations are FULLY offline (§31 till/shift/close class): this never makes
// or waits on a network call — the close and any exception are queued for cloud
// reconciliation later. Pure orchestration — the outbox is injected. Idempotent on
// the shift id (§31.1).

import { makeEvent } from '../../contracts/src/event';
import { add, subtract, isPositive, isNegative, type Money } from '../../contracts/src/money';
import type { SyncOutbox } from '../../sync/src/outbox';

export interface CloseShiftInput {
  readonly id: string; // shift / till-session id
  readonly tillId: string;
  readonly laneId: string;
  readonly cashierId: string;
  readonly tradingDay: string;
  readonly closedAt: string; // ISO-8601 UTC
  readonly openingFloat: Money;
  /** Cash taken in sales during the shift. */
  readonly cashSales: Money;
  /** Cash removed to the safe (pickups/safe drops) — reduces the till. */
  readonly pickups: Money;
  /** Cash paid out as refunds — reduces the till. */
  readonly cashRefunds: Money;
  /** The blind physical count total (entered by denomination upstream). */
  readonly countedCash: Money;
  /** |over/short| at/above which the variance is material and escalates. */
  readonly toleranceMinor: number;
  /** Reason for a material over/short — required when the variance is material. */
  readonly reasonCode?: string;
}

export interface ShiftCloseResult {
  readonly id: string;
  readonly tillId: string;
  readonly laneId: string;
  readonly cashierId: string;
  readonly tradingDay: string;
  /** float + cash sales − pickups − cash refunds (never shown at count time). */
  readonly expectedCash: Money;
  readonly countedCash: Money;
  /** counted − expected (positive = over, negative = short). */
  readonly variance: Money;
  readonly isOver: boolean;
  readonly isShort: boolean;
  readonly withinTolerance: boolean;
  /** True when the variance is material — a reconciliation exception was raised. */
  readonly exceptionRaised: boolean;
  readonly reasonCode: string | null;
  readonly closedAt: string;
}

export class MissingVarianceReasonError extends Error {
  constructor(id: string) {
    super(`Shift "${id}" has a material over/short and needs a reason code (M14-FR-02).`);
    this.name = 'MissingVarianceReasonError';
  }
}

/**
 * Close a cashier shift: compute the expected cash and the over/short against the
 * blind count, require a reason for a material variance, emit a `TillClosed` event
 * and — for a material variance — a `ReconciliationExceptionRaised` event, and
 * queue both for sync. No network call (fully offline). Idempotent on the shift id.
 */
export function closeShift(input: CloseShiftInput, outbox: SyncOutbox): ShiftCloseResult {
  const expectedCash = subtract(
    subtract(add(input.openingFloat, input.cashSales), input.pickups),
    input.cashRefunds,
  );
  const variance = subtract(input.countedCash, expectedCash); // counted − expected
  const exceptionRaised = Math.abs(variance.minor) >= input.toleranceMinor;

  if (exceptionRaised && (input.reasonCode === undefined || input.reasonCode.trim() === '')) {
    throw new MissingVarianceReasonError(input.id);
  }
  const reasonCode = input.reasonCode?.trim() ? input.reasonCode : null;

  outbox.enqueue(
    makeEvent({
      id: `${input.id}:closed`,
      type: 'TillClosed',
      occurredAt: input.closedAt,
      idempotencyKey: `till-close:${input.id}`,
      source: input.laneId,
      payload: {
        shiftId: input.id,
        tillId: input.tillId,
        laneId: input.laneId,
        cashierId: input.cashierId,
        tradingDay: input.tradingDay,
        expectedMinor: expectedCash.minor,
        countedMinor: input.countedCash.minor,
        varianceMinor: variance.minor,
        currency: expectedCash.currency,
        exceptionRaised,
        reasonCode,
      },
    }),
  );

  if (exceptionRaised) {
    outbox.enqueue(
      makeEvent({
        id: `${input.id}:variance`,
        type: 'ReconciliationExceptionRaised',
        occurredAt: input.closedAt,
        idempotencyKey: `till-exception:${input.id}`,
        source: input.laneId,
        payload: {
          shiftId: input.id,
          tillId: input.tillId,
          kind: 'cash_over_short',
          varianceMinor: variance.minor,
          currency: variance.currency,
          reasonCode,
        },
      }),
    );
  }

  return Object.freeze({
    id: input.id,
    tillId: input.tillId,
    laneId: input.laneId,
    cashierId: input.cashierId,
    tradingDay: input.tradingDay,
    expectedCash,
    countedCash: input.countedCash,
    variance,
    isOver: isPositive(variance),
    isShort: isNegative(variance),
    withinTolerance: !exceptionRaised,
    exceptionRaised,
    reasonCode,
    closedAt: input.closedAt,
  });
}
