// Loyalty points — earn / burn / reverse (M17-FR-01). Points are MONEY-LIKE, so
// they follow the ledger discipline: every movement is an append-only auditable
// event and the balance is PROJECTED from the events, never stored (mirror of hard
// rule #2). A burn can never take the balance negative, and an OFFLINE burn is
// capped to prevent double-spend across lanes before sync (M12-FR-03 / §31). A
// reversal (e.g. a returned sale) is a compensating credit, not an edit. Pure
// orchestration — the points ledger and outbox are injected; idempotent on the
// movement id (a replay collapses to one effect and does not re-run the guards).

import { makeEvent } from '../../contracts/src/event';
import type { Ledger } from '../../ledger/src/ledger';
import type { SyncOutbox } from '../../sync/src/outbox';

export type PointsReason = 'earn' | 'burn' | 'reversal' | 'expiry' | 'adjustment';

interface PointsPayload {
  readonly customerId: string;
  /** Signed points delta (+earned, −burned/expired). */
  readonly delta: number;
  readonly reason: PointsReason;
  readonly sourceRef: string | null;
}

export interface EarnInput {
  readonly id: string;
  readonly customerId: string;
  readonly points: number; // magnitude (> 0)
  readonly sourceRef?: string;
  readonly at: string; // ISO-8601 UTC
  readonly source: string; // lane / channel
}

export interface BurnInput extends EarnInput {
  /** True when redeemed on an offline lane — the offline cap then applies. */
  readonly offline?: boolean;
  /** Max points that may be burned offline in one movement (double-spend guard). */
  readonly offlineCap?: number;
}

export interface PointsMovementResult {
  readonly id: string;
  readonly customerId: string;
  readonly delta: number;
  readonly reason: PointsReason;
  /** Customer's points balance AFTER this movement (projected). */
  readonly balance: number;
  readonly at: string;
}

export class InvalidPointsError extends Error {
  constructor(id: string) {
    super(`Points movement "${id}" must have a positive point amount.`);
    this.name = 'InvalidPointsError';
  }
}

export class InsufficientPointsError extends Error {
  constructor(id: string) {
    super(`Points movement "${id}" would take the balance below zero.`);
    this.name = 'InsufficientPointsError';
  }
}

export class OfflineCapExceededError extends Error {
  constructor(id: string) {
    super(`Points burn "${id}" exceeds the offline cap (double-spend guard, M17-FR-01).`);
    this.name = 'OfflineCapExceededError';
  }
}

/** Customer points balance — projected from the events (never stored). */
export function pointsBalance(pointsLedger: Ledger, customerId: string): number {
  return pointsLedger.project(0, (bal, event) => {
    const p = event.payload as PointsPayload;
    return p.customerId === customerId ? bal + p.delta : bal;
  });
}

function isReplay(pointsLedger: Ledger, idempotencyKey: string): boolean {
  return pointsLedger.entries().some((r) => r.event.idempotencyKey === idempotencyKey);
}

function record(
  input: EarnInput,
  delta: number,
  reason: PointsReason,
  pointsLedger: Ledger,
  outbox: SyncOutbox,
  guard?: () => void,
): PointsMovementResult {
  const idempotencyKey = `points:${input.id}`;
  const event = makeEvent({
    id: `${input.id}:points`,
    type: 'PointsMovement' as const,
    occurredAt: input.at,
    idempotencyKey,
    source: input.source,
    payload: {
      customerId: input.customerId,
      delta,
      reason,
      sourceRef: input.sourceRef ?? null,
    },
  });

  if (!isReplay(pointsLedger, idempotencyKey)) {
    if (guard) guard();
    pointsLedger.append(event);
  }
  outbox.enqueue(event);

  return {
    id: input.id,
    customerId: input.customerId,
    delta,
    reason,
    balance: pointsBalance(pointsLedger, input.customerId),
    at: input.at,
  };
}

/** Earn points (e.g. from a sale) — an append-only positive movement. */
export function earnPoints(
  input: EarnInput,
  pointsLedger: Ledger,
  outbox: SyncOutbox,
): PointsMovementResult {
  if (!Number.isSafeInteger(input.points) || input.points <= 0) {
    throw new InvalidPointsError(input.id);
  }
  return record(input, input.points, 'earn', pointsLedger, outbox);
}

/**
 * Burn (redeem) points at tender. Guards: never below zero, and — offline — never
 * beyond the offline cap (double-spend prevention). Idempotent on the movement id.
 */
export function burnPoints(
  input: BurnInput,
  pointsLedger: Ledger,
  outbox: SyncOutbox,
): PointsMovementResult {
  if (!Number.isSafeInteger(input.points) || input.points <= 0) {
    throw new InvalidPointsError(input.id);
  }
  return record(input, -input.points, 'burn', pointsLedger, outbox, () => {
    if (input.offline && input.offlineCap !== undefined && input.points > input.offlineCap) {
      throw new OfflineCapExceededError(input.id);
    }
    if (pointsBalance(pointsLedger, input.customerId) - input.points < 0) {
      throw new InsufficientPointsError(input.id);
    }
  });
}

/**
 * Reverse a prior burn (e.g. a returned sale) — a compensating CREDIT, never an
 * edit of history. Idempotent on the movement id.
 */
export function reversePoints(
  input: EarnInput,
  pointsLedger: Ledger,
  outbox: SyncOutbox,
): PointsMovementResult {
  if (!Number.isSafeInteger(input.points) || input.points <= 0) {
    throw new InvalidPointsError(input.id);
  }
  return record(input, input.points, 'reversal', pointsLedger, outbox);
}
