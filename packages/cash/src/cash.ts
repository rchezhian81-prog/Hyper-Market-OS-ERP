// Till cash movements (M14-FR-01) — float issue, loans, pickups and safe drops,
// each an append-only CashMovement event (hard rule #2). Two roadmap rules are
// enforced here: ONE custodian per till at a time ("a till cannot be issued to two
// cashiers at once"), and the auditable chain where a pickup reduces the till and
// (implicitly) adds to the safe. The till drawer balance and the current custodian
// are always PROJECTED from the events, never stored (mirror of the ledger rule).
// Cash operations are fully offline (§31 till/shift/close class). Pure
// orchestration — the cash ledger and outbox are injected. Idempotent on the
// movement id (§31.1).

import { makeEvent } from '../../contracts/src/event';
import { money, isPositive, type Money, type CurrencyCode } from '../../contracts/src/money';
import type { Ledger } from '../../ledger/src/ledger';
import type { SyncOutbox } from '../../sync/src/outbox';

/** Cash movement kinds. float_issue OPENS a custody; float_return CLOSES it. */
export type CashMovementKind = 'float_issue' | 'loan' | 'pickup' | 'safe_drop' | 'float_return';

/** Whether a kind adds to (+1) or removes from (−1) the till drawer. */
const DRAWER_SIGN: Readonly<Record<CashMovementKind, 1 | -1>> = Object.freeze({
  float_issue: 1, // cash office issues float INTO the till
  loan: 1, // additional cash INTO the till
  pickup: -1, // cash OUT of the till to the safe
  safe_drop: -1, // cash OUT of the till to the safe/bank
  float_return: -1, // remaining float returned OUT of the till, closes custody
});

interface CashMovePayload {
  readonly tillId: string;
  readonly kind: CashMovementKind;
  readonly deltaMinor: number;
  readonly currency: CurrencyCode;
  readonly custodianId: string;
  readonly tradingDay: string;
}

export interface CashMovementInput {
  readonly id: string;
  readonly tillId: string;
  readonly laneId: string;
  readonly kind: CashMovementKind;
  /** Magnitude of the movement (must be positive). */
  readonly amount: Money;
  /** The cashier who holds (or is being given) the till. */
  readonly custodianId: string;
  /** Who recorded the movement (cash office or the cashier). */
  readonly performedBy: string;
  readonly at: string; // ISO-8601 UTC
  readonly tradingDay: string;
}

export interface CommittedCashMovement {
  readonly id: string;
  readonly tillId: string;
  readonly kind: CashMovementKind;
  readonly amount: Money;
  readonly custodianId: string;
  /** The till drawer balance AFTER this movement (projected). */
  readonly tillBalance: Money;
  readonly at: string;
}

export class InvalidCashAmountError extends Error {
  constructor(id: string) {
    super(`Cash movement "${id}" must have a positive amount.`);
    this.name = 'InvalidCashAmountError';
  }
}

export class TillAlreadyAssignedError extends Error {
  constructor(tillId: string) {
    super(`Till "${tillId}" already has an open custody — it cannot be issued again (M14-FR-01).`);
    this.name = 'TillAlreadyAssignedError';
  }
}

export class TillNotAssignedError extends Error {
  constructor(tillId: string, custodianId: string) {
    super(`Till "${tillId}" is not currently held by "${custodianId}".`);
    this.name = 'TillNotAssignedError';
  }
}

export class InsufficientTillCashError extends Error {
  constructor(id: string) {
    super(`Cash movement "${id}" would take out more than the till holds.`);
    this.name = 'InsufficientTillCashError';
  }
}

/** The current open custodian of a till, or null if none — projected from events. */
export function tillCustodian(cashLedger: Ledger, tillId: string): string | null {
  return cashLedger.project<string | null>(null, (custodian, event) => {
    const p = event.payload as CashMovePayload;
    if (p.tillId !== tillId) return custodian;
    if (p.kind === 'float_issue') return p.custodianId;
    if (p.kind === 'float_return') return null;
    return custodian;
  });
}

/** The till drawer balance in minor units — projected from events (never stored). */
export function tillBalanceMinor(cashLedger: Ledger, tillId: string): number {
  return cashLedger.project(0, (bal, event) => {
    const p = event.payload as CashMovePayload;
    return p.tillId === tillId ? bal + p.deltaMinor : bal;
  });
}

/**
 * Record a till cash movement: enforce a positive amount, the one-custodian rule
 * (float_issue needs a free till; every other kind needs the till held by the
 * named custodian), and no overdraw (you cannot remove more than the drawer
 * holds). Appends a `CashMovement` event to the append-only cash ledger and queues
 * it for sync — no network call. Idempotent on the movement id.
 */
export function recordCashMovement(
  input: CashMovementInput,
  cashLedger: Ledger,
  outbox: SyncOutbox,
): CommittedCashMovement {
  if (!isPositive(input.amount)) {
    throw new InvalidCashAmountError(input.id);
  }

  const idempotencyKey = `cash-move:${input.id}`;
  const sign = DRAWER_SIGN[input.kind];
  const deltaMinor = sign * input.amount.minor;
  const event = makeEvent({
    id: `${input.id}:cash`,
    type: 'CashMovement' as const,
    occurredAt: input.at,
    idempotencyKey,
    source: input.laneId,
    payload: {
      tillId: input.tillId,
      kind: input.kind,
      deltaMinor,
      currency: input.amount.currency,
      custodianId: input.custodianId,
      tradingDay: input.tradingDay,
    },
  });

  // Replay (§31.1): a movement already on the chain collapses to one effect — the
  // stateful custody/overdraw rules are NOT re-checked (they passed the first time).
  const isReplay = cashLedger.entries().some((r) => r.event.idempotencyKey === idempotencyKey);
  if (!isReplay) {
    const currentCustodian = tillCustodian(cashLedger, input.tillId);
    if (input.kind === 'float_issue') {
      if (currentCustodian !== null) {
        throw new TillAlreadyAssignedError(input.tillId); // one custodian at a time
      }
    } else if (currentCustodian !== input.custodianId) {
      throw new TillNotAssignedError(input.tillId, input.custodianId);
    }
    // Cannot take out more cash than the drawer holds (auditable chain, M14-FR-01).
    if (sign < 0 && tillBalanceMinor(cashLedger, input.tillId) + deltaMinor < 0) {
      throw new InsufficientTillCashError(input.id);
    }
    cashLedger.append(event); // append-only cash chain
  }
  outbox.enqueue(event); // queue for cloud reconciliation (idempotent)

  const balanceMinor = tillBalanceMinor(cashLedger, input.tillId);
  return Object.freeze({
    id: input.id,
    tillId: input.tillId,
    kind: input.kind,
    amount: input.amount,
    custodianId: input.custodianId,
    tillBalance: money(balanceMinor, input.amount.currency),
    at: input.at,
  });
}
