// The cloud-side till-cash guard (M14-FR-01) — the authoritative custody chain and drawer balance.
//
// `packages/cash/cash.ts` enforces the money discipline against an injected ledger: one custodian
// per till at a time, no overdraw, and the balance and custodian PROJECTED from events (never
// stored). That is the right rule in the wrong place to be authoritative across shifts and tills —
// a lane only knows its own chain. The cloud holds every till's full chain, so this is the guard
// that runs there. Pure: prior movements in, a signed delta or a typed refusal out; it commits
// nothing — the service appends the event.

import type { CashMovementKind } from './cash';

/** Whether a kind adds to (+1) or removes from (−1) the till drawer — the same signs as `cash.ts`. */
const DRAWER_SIGN: Readonly<Record<CashMovementKind, 1 | -1>> = Object.freeze({
  float_issue: 1, loan: 1, pickup: -1, safe_drop: -1, float_return: -1,
});

/** A movement as it is stored — a signed delta against a till, with the custodian at the time. */
export interface StoredCashMovement {
  readonly movementId: string;
  readonly tillId: string;
  readonly kind: CashMovementKind;
  readonly deltaMinor: number;
  readonly custodianId: string;
}

export interface CashMovementRequest {
  readonly movementId: string;
  readonly tillId: string;
  readonly kind: CashMovementKind;
  /** Magnitude, minor units, > 0. The sign is the kind's job. */
  readonly amountMinor: number;
  readonly custodianId: string;
}

export type CashRefusal =
  | 'amount_not_positive'
  | 'till_already_assigned'
  | 'till_not_held_by_this_custodian'
  | 'insufficient_till_cash';

export interface CashAssessment {
  readonly ok: boolean;
  readonly refusedBecause?: CashRefusal;
  readonly detail: string;
  readonly deltaMinor: number;
  readonly balanceAfterMinor: number;
  readonly custodianAfter: string | null;
}

/** The current open custodian of a till, or null — projected from the movements. */
export function custodianOf(movements: readonly StoredCashMovement[], tillId: string): string | null {
  let custodian: string | null = null;
  for (const m of movements) {
    if (m.tillId !== tillId) continue;
    if (m.kind === 'float_issue') custodian = m.custodianId;
    else if (m.kind === 'float_return') custodian = null;
  }
  return custodian;
}

/** The till drawer balance in minor units — projected, never stored. */
export function tillDrawerBalanceMinor(movements: readonly StoredCashMovement[], tillId: string): number {
  return movements.filter((m) => m.tillId === tillId).reduce((b, m) => b + m.deltaMinor, 0);
}

/**
 * Assess a till cash movement against the till's whole chain.
 *
 * As with the other cloud guards, a movement does not count against itself: the prior chain is
 * filtered by `movementId` first, so a lane retrying an unconfirmed drop reaches the same answer and
 * the service's idempotent append writes nothing new. One custodian at a time, and no overdraw.
 */
export function assessCashMovement(input: {
  readonly priorMovements: readonly StoredCashMovement[];
  readonly request: CashMovementRequest;
}): CashAssessment {
  const { request } = input;
  const prior = input.priorMovements.filter((m) => m.movementId !== request.movementId);
  const custodian = custodianOf(prior, request.tillId);
  const balance = tillDrawerBalanceMinor(prior, request.tillId);
  const refuse = (refusedBecause: CashRefusal, detail: string): CashAssessment =>
    ({ ok: false, refusedBecause, detail, deltaMinor: 0, balanceAfterMinor: balance, custodianAfter: custodian });

  if (!Number.isSafeInteger(request.amountMinor) || request.amountMinor <= 0) {
    return refuse('amount_not_positive', 'a cash movement must carry a positive whole amount');
  }

  if (request.kind === 'float_issue') {
    if (custodian !== null) {
      return refuse('till_already_assigned', `till ${request.tillId} is already held by ${custodian} — it cannot be issued to two cashiers at once`);
    }
  } else if (custodian !== request.custodianId) {
    return refuse('till_not_held_by_this_custodian', `till ${request.tillId} is not currently held by ${request.custodianId} (held by ${custodian ?? 'nobody'})`);
  }

  const delta = DRAWER_SIGN[request.kind] * request.amountMinor;
  if (delta < 0 && balance + delta < 0) {
    return refuse('insufficient_till_cash', `taking ${request.amountMinor} out of till ${request.tillId} would overdraw it — it holds ${balance}`);
  }

  const custodianAfter = request.kind === 'float_issue' ? request.custodianId
    : request.kind === 'float_return' ? null : custodian;
  return {
    ok: true,
    detail: `${request.kind} ${request.amountMinor} on till ${request.tillId}: ${balance} → ${balance + delta}`,
    deltaMinor: delta, balanceAfterMinor: balance + delta, custodianAfter,
  };
}
