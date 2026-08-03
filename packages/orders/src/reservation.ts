// Stock reservation — no oversell (M18-FR-02 / §6.2). When an online order is
// confirmed, its stock is RESERVED and thereby excluded from what a walk-in can buy
// (M08-FR-02): available-to-promise = physical on-hand − active reservations. A
// reservation that would exceed availability is refused (OversellError) — the store
// never promises stock it doesn't have. Reservations are append-only events on a
// reservation ledger and the reserved quantity is PROJECTED from them (never
// stored); a cancellation releases the reservation. Idempotent on the reservation
// id. Pure orchestration — the reservation ledger and outbox are injected; the
// caller supplies the physical on-hand (projected from the stock ledger).

import { makeEvent } from '../../contracts/src/event';
import type { Ledger } from '../../ledger/src/ledger';
import type { SyncOutbox } from '../../sync/src/outbox';

interface ReservationPayload {
  readonly productId: string;
  readonly orderId: string;
  readonly delta: number; // +reserved, −released
}

export interface ReserveInput {
  readonly id: string; // reservation id
  readonly orderId: string;
  readonly productId: string;
  readonly qty: number; // whole units (> 0)
  readonly at: string; // ISO-8601 UTC
  readonly source: string;
}

export interface ReservationResult {
  readonly id: string;
  readonly orderId: string;
  readonly productId: string;
  readonly qty: number;
  /** Reserved quantity for the product AFTER this movement (projected). */
  readonly reservedQty: number;
  readonly availableToPromise: number;
  readonly at: string;
}

export interface ReleaseResult {
  readonly id: string;
  readonly orderId: string;
  readonly productId: string;
  readonly qty: number;
  /** Reserved quantity for the product AFTER the release (projected). */
  readonly reservedQty: number;
  readonly at: string;
}

export class InvalidReservationError extends Error {
  constructor(id: string) {
    super(`Reservation "${id}" must reserve a positive quantity.`);
    this.name = 'InvalidReservationError';
  }
}

export class OversellError extends Error {
  constructor(id: string) {
    super(`Reservation "${id}" would exceed available stock — refused (no oversell, §6.2).`);
    this.name = 'OversellError';
  }
}

/** Active reserved quantity for a product — projected from the reservation ledger. */
export function reservedQty(reservationLedger: Ledger, productId: string): number {
  return reservationLedger.project(0, (qty, event) => {
    const p = event.payload as ReservationPayload;
    return p.productId === productId ? qty + p.delta : qty;
  });
}

/** Available-to-promise = physical on-hand − active reservations. */
export function availableToPromise(
  reservationLedger: Ledger,
  productId: string,
  physicalOnHand: number,
): number {
  return physicalOnHand - reservedQty(reservationLedger, productId);
}

function isReplay(reservationLedger: Ledger, idempotencyKey: string): boolean {
  return reservationLedger.entries().some((r) => r.event.idempotencyKey === idempotencyKey);
}

/**
 * Reserve stock for an order. Refuses to reserve more than is available to promise
 * (physical on-hand − existing reservations) — no oversell. Appends a StockReserved
 * event and queues it for sync. Idempotent on the reservation id.
 */
export function reserveStock(
  input: ReserveInput,
  reservationLedger: Ledger,
  outbox: SyncOutbox,
  physicalOnHand: number,
): ReservationResult {
  if (!Number.isSafeInteger(input.qty) || input.qty <= 0) {
    throw new InvalidReservationError(input.id);
  }
  const idempotencyKey = `reserve:${input.id}`;
  const event = makeEvent({
    id: `${input.id}:reserve`,
    type: 'StockReserved' as const,
    occurredAt: input.at,
    idempotencyKey,
    source: input.source,
    payload: { productId: input.productId, orderId: input.orderId, delta: input.qty },
  });

  if (!isReplay(reservationLedger, idempotencyKey)) {
    if (availableToPromise(reservationLedger, input.productId, physicalOnHand) < input.qty) {
      throw new OversellError(input.id);
    }
    reservationLedger.append(event);
  }
  outbox.enqueue(event);

  return {
    id: input.id,
    orderId: input.orderId,
    productId: input.productId,
    qty: input.qty,
    reservedQty: reservedQty(reservationLedger, input.productId),
    availableToPromise: availableToPromise(reservationLedger, input.productId, physicalOnHand),
    at: input.at,
  };
}

/**
 * Release a reservation (e.g. on cancellation, M18-FR-04) — a compensating negative
 * movement, never an edit. Idempotent on the release id.
 */
export function releaseReservation(
  input: ReserveInput,
  reservationLedger: Ledger,
  outbox: SyncOutbox,
): ReleaseResult {
  if (!Number.isSafeInteger(input.qty) || input.qty <= 0) {
    throw new InvalidReservationError(input.id);
  }
  const idempotencyKey = `release:${input.id}`;
  const event = makeEvent({
    id: `${input.id}:release`,
    type: 'ReservationReleased' as const,
    occurredAt: input.at,
    idempotencyKey,
    source: input.source,
    payload: { productId: input.productId, orderId: input.orderId, delta: -input.qty },
  });

  if (!isReplay(reservationLedger, idempotencyKey)) {
    reservationLedger.append(event);
  }
  outbox.enqueue(event);

  return {
    id: input.id,
    orderId: input.orderId,
    productId: input.productId,
    qty: input.qty,
    reservedQty: reservedQty(reservationLedger, input.productId),
    at: input.at,
  };
}
