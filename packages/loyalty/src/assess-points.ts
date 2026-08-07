// The cloud-side loyalty guard (M17-FR-01, P-02) — one loyalty truth across every lane and channel.
//
// `packages/loyalty/loyalty.ts` enforces the money-like discipline against an injected ledger: a burn
// never takes the balance below zero, and the balance is PROJECTED from movements, never stored. That
// is the right rule in the wrong place to be authoritative — an offline lane only knows the balance it
// has seen sync, so two lanes can each burn the same last hundred points before either learns of the
// other. The authoritative balance is the one the cloud holds, where every movement is visible (P-02:
// one loyalty truth), and this is the guard that runs there.
//
// Pure and deterministic: the prior movements are passed in, the balance is folded, the answer is a
// signed delta to record or a typed refusal. It commits nothing — the service appends the event.

export type PointsKind = 'earn' | 'burn' | 'reversal';

/** A movement as it is stored — a signed delta against a customer (the balance is their sum). */
export interface StoredPointsMovement {
  readonly movementId: string;
  readonly customerId: string;
  readonly delta: number;
}

export interface PointsMovementRequest {
  readonly movementId: string;
  readonly customerId: string;
  /** earn/reversal add points; burn spends them. Magnitude only — the sign is the kind's job. */
  readonly kind: PointsKind;
  readonly points: number; // magnitude, > 0
}

export type PointsRefusal = 'points_not_positive' | 'insufficient_points';

export interface PointsAssessment {
  readonly ok: boolean;
  readonly refusedBecause?: PointsRefusal;
  readonly detail: string;
  /** The signed delta to record. Zero on a refusal — nothing moves. */
  readonly delta: number;
  readonly balanceAfter: number;
}

const SIGN: Readonly<Record<PointsKind, 1 | -1>> = { earn: 1, burn: -1, reversal: 1 };

/**
 * Assess a points movement against everything already recorded for the customer.
 *
 * As with the return guard, a movement does not count against itself: the prior history is filtered
 * by `movementId` first, so a lane retrying an unconfirmed burn is assessed as if it had not happened
 * and reaches the same answer — the service's append is idempotent on the id, so the retry writes
 * nothing new. Points are money-like and never go negative (M17-FR-01).
 */
export function assessPointsMovement(input: {
  readonly priorMovements: readonly StoredPointsMovement[];
  readonly request: PointsMovementRequest;
}): PointsAssessment {
  const { request } = input;
  const prior = input.priorMovements.filter((m) => m.customerId === request.customerId && m.movementId !== request.movementId);
  const balance = prior.reduce((b, m) => b + m.delta, 0);

  if (!Number.isSafeInteger(request.points) || request.points <= 0) {
    return { ok: false, refusedBecause: 'points_not_positive', detail: 'a points movement must carry a positive whole number of points', delta: 0, balanceAfter: balance };
  }

  const delta = SIGN[request.kind] * request.points;
  if (balance + delta < 0) {
    return {
      ok: false, refusedBecause: 'insufficient_points',
      detail: `burning ${request.points} would take ${request.customerId}'s balance below zero — it holds ${balance}, and points are money-like, so they never go negative`,
      delta: 0, balanceAfter: balance,
    };
  }

  return {
    ok: true,
    detail: `${request.kind} ${request.points} for ${request.customerId}: ${balance} → ${balance + delta}`,
    delta, balanceAfter: balance + delta,
  };
}
