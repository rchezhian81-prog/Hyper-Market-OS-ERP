// Stock states and availability (M08-FR-02 / §6.2) — the answer to the one question
// the whole shop depends on: **how much of this can I actually sell right now?**
//
// A single "quantity on hand" number is the lie at the centre of most retail systems.
// The stock is physically in the building, so the report says 12 — but 4 are reserved
// for an online order, 3 are quarantined after a damaged delivery, 2 expired
// yesterday, and 3 are still on a van from the other branch. The honest answer is 0,
// and a system that says 12 will oversell, disappoint a customer and hide a loss.
//
// So stock here is held **by state**, and availability is derived:
//
//     available = the states the tenant treats as sellable
//                 (never reserved, quarantine, damaged, expired or in-transit)
//
// A movement is a TRANSFER between states, which makes the model self-checking:
// quantity is conserved everywhere except at the boundary of the business
// (`from: null` is a receipt from a supplier, `to: null` is a sale or a write-off).
// Nothing is ever overwritten — the position is PROJECTED from the movements, the
// same discipline as the ledger (hard rule #2).
//
// Two rules are NOT configurable, whatever a tenant would prefer:
//   • expired stock is never sellable;
//   • quarantined stock is never sellable.
// Everything else — whether a damaged-goods bin is sellable, whether negative stock
// is blocked or merely flagged — is per-tenant policy.
//
// Pure and deterministic: no clock, no I/O.

/** Where a unit of stock stands. Only some of these can ever be sold. */
export type StockState =
  | 'on_hand'
  | 'reserved'
  | 'quarantine'
  | 'damaged'
  | 'expired'
  | 'in_transit';

export const STOCK_STATES: readonly StockState[] = [
  'on_hand',
  'reserved',
  'quarantine',
  'damaged',
  'expired',
  'in_transit',
];

/** States that can never be sold, whatever a tenant configures (M08-FR-02). */
export const NEVER_SELLABLE: readonly StockState[] = ['quarantine', 'expired'];

/** Stock is tracked per product, per location, per batch — never in one lump. */
export interface StockKey {
  readonly productId: string;
  readonly locationId: string;
  readonly batchId: string | null;
}

/**
 * A transfer of quantity between states. `from: null` means it entered the
 * business (a goods receipt); `to: null` means it left (a sale, a write-off).
 */
export interface StockMovement extends StockKey {
  readonly movementId: string;
  readonly from: StockState | null;
  readonly to: StockState | null;
  /** Always positive — direction is carried by `from`/`to`, never by a sign. */
  readonly quantityMinor: number;
  readonly uom: string;
  /** ISO-8601 UTC. */
  readonly at: string;
  readonly reason?: string;
}

/** Per-tenant choices about what counts as sellable and what negative stock means. */
export interface StockPolicy {
  /** States treated as sellable. Defaults to on-hand only. */
  readonly sellableStates?: readonly StockState[];
  /**
   * When false (the default) a movement that would take a state negative is
   * refused. When true it is allowed but raises a visible exception — never a
   * silent negative (P-08).
   */
  readonly allowNegative?: boolean;
}

/** The quantity in each state for one product/location/batch. */
export interface StockPosition extends StockKey {
  readonly uom: string;
  readonly byState: Readonly<Record<StockState, number>>;
  /** Everything physically in the building, whatever its state. */
  readonly physicalMinor: number;
  /** What can actually be sold, per the tenant's policy. */
  readonly availableMinor: number;
}

/** A negative state — surfaced, never absorbed (P-08 / hard rule #10). */
export interface StockException extends StockKey {
  readonly movementId: string;
  readonly state: StockState;
  readonly quantityMinor: number;
  readonly detail: string;
}

export class NegativeStockError extends Error {
  constructor(
    public readonly movementId: string,
    public readonly state: StockState,
    public readonly shortfall: number,
  ) {
    super(
      `Movement "${movementId}" would take ${state} stock ${shortfall} below zero — refused (M08-FR-03)`,
    );
    this.name = 'NegativeStockError';
  }
}

export class NeverSellableStateError extends Error {
  constructor(public readonly state: StockState) {
    super(`"${state}" stock can never be sellable — it is not a tenant choice (M08-FR-02)`);
    this.name = 'NeverSellableStateError';
  }
}

export class InvalidMovementError extends Error {
  constructor(
    public readonly movementId: string,
    reason: string,
  ) {
    super(`Movement "${movementId}" is invalid: ${reason}`);
    this.name = 'InvalidMovementError';
  }
}

function emptyStates(): Record<StockState, number> {
  return {
    on_hand: 0,
    reserved: 0,
    quarantine: 0,
    damaged: 0,
    expired: 0,
    in_transit: 0,
  };
}

function keyOf(k: StockKey): string {
  return `${k.productId}\u0000${k.locationId}\u0000${k.batchId ?? ''}`;
}

/** Resolve the sellable states, refusing a policy that breaks the standing rule. */
export function sellableStates(policy: StockPolicy = {}): readonly StockState[] {
  const chosen = policy.sellableStates ?? ['on_hand'];
  for (const state of chosen) {
    if (NEVER_SELLABLE.includes(state)) {
      throw new NeverSellableStateError(state);
    }
  }
  return chosen;
}

export interface StockProjection {
  readonly positions: readonly StockPosition[];
  /** Every place the movements produced a negative state (policy permitting). */
  readonly exceptions: readonly StockException[];
}

/**
 * Project a stock position from movements. The position is always derived — there
 * is no stored quantity to drift, and replaying the same movements gives the same
 * answer (hard rule #2).
 */
export function projectStock(
  movements: readonly StockMovement[],
  policy: StockPolicy = {},
): StockProjection {
  const sellable = sellableStates(policy);
  const buckets = new Map<string, { key: StockKey; uom: string; states: Record<StockState, number> }>();
  const exceptions: StockException[] = [];

  for (const movement of movements) {
    if (movement.quantityMinor <= 0) {
      throw new InvalidMovementError(movement.movementId, 'quantity must be positive');
    }
    if (movement.from === null && movement.to === null) {
      throw new InvalidMovementError(movement.movementId, 'it moves stock from nowhere to nowhere');
    }
    if (movement.from === movement.to) {
      throw new InvalidMovementError(movement.movementId, `it moves ${movement.from} to itself`);
    }

    const id = keyOf(movement);
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = {
        key: { productId: movement.productId, locationId: movement.locationId, batchId: movement.batchId },
        uom: movement.uom,
        states: emptyStates(),
      };
      buckets.set(id, bucket);
    }

    if (movement.from !== null) {
      const remaining = bucket.states[movement.from] - movement.quantityMinor;
      if (remaining < 0) {
        if (policy.allowNegative !== true) {
          throw new NegativeStockError(movement.movementId, movement.from, -remaining);
        }
        exceptions.push({
          ...bucket.key,
          movementId: movement.movementId,
          state: movement.from,
          quantityMinor: remaining,
          detail: `${movement.from} stock went ${-remaining} below zero — the count and the system disagree, someone must explain it`,
        });
      }
      bucket.states[movement.from] = remaining;
    }
    if (movement.to !== null) {
      bucket.states[movement.to] += movement.quantityMinor;
    }
  }

  const positions = [...buckets.values()].map((bucket): StockPosition => {
    const physical = STOCK_STATES.filter((s) => s !== 'in_transit').reduce(
      (sum, s) => sum + bucket.states[s],
      0,
    );
    return {
      ...bucket.key,
      uom: bucket.uom,
      byState: { ...bucket.states },
      physicalMinor: physical,
      availableMinor: sellable.reduce((sum, s) => sum + bucket.states[s], 0),
    };
  });

  return { positions, exceptions };
}

/** What a walk-in customer could buy right now, across every batch at a location. */
export function availableToSell(
  projection: StockProjection,
  productId: string,
  locationId?: string,
): number {
  return projection.positions
    .filter((p) => p.productId === productId && (locationId === undefined || p.locationId === locationId))
    .reduce((sum, p) => sum + p.availableMinor, 0);
}

/** Everything in the building — including what cannot be sold. Never the sellable figure. */
export function physicalStock(
  projection: StockProjection,
  productId: string,
  locationId?: string,
): number {
  return projection.positions
    .filter((p) => p.productId === productId && (locationId === undefined || p.locationId === locationId))
    .reduce((sum, p) => sum + p.physicalMinor, 0);
}

/** Quantity sitting in one state — for the quarantine, damage and in-transit reports. */
export function quantityInState(
  projection: StockProjection,
  state: StockState,
  productId?: string,
): number {
  return projection.positions
    .filter((p) => productId === undefined || p.productId === productId)
    .reduce((sum, p) => sum + p.byState[state], 0);
}

/**
 * Why a product's shelf figure and its sellable figure differ — the explanation the
 * manager actually needs when the report says 12 and the answer is 0.
 */
export function explainAvailability(
  projection: StockProjection,
  productId: string,
  locationId?: string,
  policy: StockPolicy = {},
): string {
  const sellable = sellableStates(policy);
  const relevant = projection.positions.filter(
    (p) => p.productId === productId && (locationId === undefined || p.locationId === locationId),
  );
  const totals = emptyStates();
  for (const p of relevant) {
    for (const state of STOCK_STATES) totals[state] += p.byState[state];
  }
  const held = STOCK_STATES.filter((s) => !sellable.includes(s) && totals[s] !== 0).map(
    (s) => `${totals[s]} ${s.replace('_', '-')}`,
  );
  const available = sellable.reduce((sum, s) => sum + totals[s], 0);
  if (held.length === 0) {
    return `${available} available`;
  }
  return `${available} available — ${held.join(', ')} not sellable`;
}
