// Put-away, bin movement and handheld warehouse scanning (M09-FR-01 / §31.1).
//
// The warehouse handheld has the same failure shape as the receiving one, and it
// matters for the same reason: **a movement command that is not uniquely identified
// is a movement that can happen twice.** Stock moved twice from a bin that only held
// it once produces a negative bin, and negative bins are how a warehouse stops
// believing its own numbers.
//
// So every movement carries a globally unique command id, a repeat is a no-op that
// says so, and the whole thing is queue-capable: the handheld works in a dead spot
// at the back of the racking and reconciles on sync (§31).
//
// Three refusals, each protecting something a later report cannot reconstruct:
//
//   • AN UNKNOWN BIN is queued, never invented. "Put it somewhere near aisle 4" is
//     how stock becomes unfindable.
//   • A FULL BIN is blocked. Capacity is not advisory: stock crammed into a bin that
//     does not hold it ends up on the floor, in the next bin, or in neither.
//   • MOVING MORE THAN THE BIN HOLDS is refused outright, because the alternative is
//     a negative bin and every count afterwards inherits the error.
//
// And one that protects the business rather than the data: **quarantined, expired or
// recalled stock cannot be moved into a pickable location.** The commonest way bad
// stock reaches a customer is not a decision — it is a put-away.
//
// Pure and deterministic: the timestamp is injected; the caller supplies current bin
// contents, so the decision is a function of the facts.

import type { StockMovement, StockState } from '../../stock/src/position';

export interface Bin {
  readonly binId: string;
  readonly storeId: string;
  readonly locationId?: string;
  /** Units this bin holds. Zero means "not a storage bin" and is refused. */
  readonly capacityMinor: number;
  /** A pickable bin feeds the shop floor or an order; a holding bin does not. */
  readonly pickable: boolean;
  readonly zone?: 'ambient' | 'chilled' | 'frozen' | 'secure' | 'quarantine';
}

export type MovementKind =
  | 'put_away'
  | 'bin_to_bin'
  | 'pick'
  | 'pack'
  | 'dispatch'
  | 'return_to_bin';

/** One scanned action. `commandId` is minted by the handheld and is unique. */
export interface MovementCommand {
  readonly commandId: string;
  readonly kind: MovementKind;
  readonly storeId: string;
  readonly productId: string;
  readonly batchId: string | null;
  readonly quantityMinor: number;
  readonly uom: string;
  /** Null for a put-away arriving from goods-in. */
  readonly fromBinId: string | null;
  /** Null for a dispatch leaving the building. */
  readonly toBinId: string | null;
  readonly movedBy: string;
  readonly at: string;
  /** The state the stock is in — quarantine never reaches a pickable bin. */
  readonly stockState?: StockState;
  readonly reason?: string;
}

export type MovementOutcome =
  | 'moved'
  | 'duplicate_ignored'
  | 'unknown_bin'
  | 'bin_full'
  | 'insufficient_in_bin'
  | 'not_pickable_state'
  | 'invalid_command';

export interface MovementResult {
  readonly commandId: string;
  readonly outcome: MovementOutcome;
  readonly accepted: boolean;
  readonly detail: string;
  /** The ledger movement to append — empty when refused (hard rule #2). */
  readonly movements: readonly StockMovement[];
  readonly resolutionRequired?: boolean;
}

/** What each bin currently holds, per product+batch, supplied by the caller. */
export type BinContents = Readonly<Record<string, number>>;

export function binKey(binId: string, productId: string, batchId: string | null): string {
  return `${binId}|${productId}|${batchId ?? ''}`;
}

/** Total units currently in a bin, across every product. */
export function binOccupancy(binId: string, contents: BinContents): number {
  return Object.entries(contents)
    .filter(([key]) => key.startsWith(`${binId}|`))
    .reduce((sum, [, qty]) => sum + qty, 0);
}

/** States that must never be put away into a bin someone picks from. */
const NEVER_PICKABLE: readonly StockState[] = ['quarantine', 'expired', 'damaged'];

/**
 * Apply one scanned movement. Returns the ledger movements to append, or a refusal
 * with the reason — it never mutates anything itself, so the decision is testable
 * and auditable on its own.
 */
export function applyMovement(input: {
  readonly command: MovementCommand;
  readonly appliedCommandIds: readonly string[];
  readonly bins: readonly Bin[];
  readonly contents: BinContents;
}): MovementResult {
  const { command } = input;
  const base = { commandId: command.commandId, movements: [] as readonly StockMovement[] };

  // The double scan, checked before anything stateful.
  if (input.appliedCommandIds.includes(command.commandId)) {
    return {
      ...base,
      outcome: 'duplicate_ignored',
      accepted: false,
      detail: 'this movement has already been recorded — scanning again changes nothing',
    };
  }

  if (command.quantityMinor <= 0) {
    return { ...base, outcome: 'invalid_command', accepted: false, detail: 'a movement of nothing is not a movement' };
  }
  if (command.fromBinId === null && command.toBinId === null) {
    return {
      ...base,
      outcome: 'invalid_command',
      accepted: false,
      detail: 'a movement must come from somewhere or go somewhere',
    };
  }

  const from = command.fromBinId === null ? undefined : input.bins.find((b) => b.binId === command.fromBinId);
  const to = command.toBinId === null ? undefined : input.bins.find((b) => b.binId === command.toBinId);

  if (command.fromBinId !== null && !from) {
    return {
      ...base,
      outcome: 'unknown_bin',
      accepted: false,
      detail: `bin "${command.fromBinId}" is not a bin in this store — it goes to the resolution queue rather than being invented`,
      resolutionRequired: true,
    };
  }
  if (command.toBinId !== null && !to) {
    return {
      ...base,
      outcome: 'unknown_bin',
      accepted: false,
      detail: `bin "${command.toBinId}" is not a bin in this store — "somewhere near aisle 4" is how stock becomes unfindable`,
      resolutionRequired: true,
    };
  }

  // Never put bad stock where someone will pick it. This is the commonest route by
  // which quarantined goods reach a customer — not a decision, a put-away.
  if (
    to?.pickable === true &&
    command.stockState !== undefined &&
    NEVER_PICKABLE.includes(command.stockState)
  ) {
    return {
      ...base,
      outcome: 'not_pickable_state',
      accepted: false,
      detail: `${command.stockState} stock cannot go into a pickable bin — put it in a holding or quarantine bin`,
    };
  }

  // Taking more out of a bin than it holds would make it negative, and every count
  // afterwards would inherit the error.
  if (from) {
    const held = input.contents[binKey(from.binId, command.productId, command.batchId)] ?? 0;
    if (held < command.quantityMinor) {
      return {
        ...base,
        outcome: 'insufficient_in_bin',
        accepted: false,
        detail: `bin ${from.binId} holds ${held}, not ${command.quantityMinor} — moving more than is there would make the bin negative`,
      };
    }
  }

  if (to) {
    if (to.capacityMinor <= 0) {
      return { ...base, outcome: 'bin_full', accepted: false, detail: `bin ${to.binId} is not a storage bin` };
    }
    const occupied = binOccupancy(to.binId, input.contents);
    if (occupied + command.quantityMinor > to.capacityMinor) {
      return {
        ...base,
        outcome: 'bin_full',
        accepted: false,
        detail: `bin ${to.binId} holds ${to.capacityMinor} and already has ${occupied} — the overflow ends up on the floor or in the wrong bin`,
      };
    }
  }

  // A movement between bins is a location change, not a state change, so the ledger
  // records it as out of the source and into the destination at the same state.
  const state = command.stockState ?? 'on_hand';
  const movements: StockMovement[] = [];
  if (from) {
    movements.push({
      movementId: `${command.commandId}-out`,
      productId: command.productId,
      locationId: from.binId,
      batchId: command.batchId,
      from: state,
      to: null,
      quantityMinor: command.quantityMinor,
      uom: command.uom,
      at: command.at,
      reason: `${command.kind} by ${command.movedBy}`,
    });
  }
  if (to) {
    movements.push({
      movementId: `${command.commandId}-in`,
      productId: command.productId,
      locationId: to.binId,
      batchId: command.batchId,
      from: null,
      to: state,
      quantityMinor: command.quantityMinor,
      uom: command.uom,
      at: command.at,
      reason: `${command.kind} by ${command.movedBy}`,
    });
  }

  return {
    commandId: command.commandId,
    outcome: 'moved',
    accepted: true,
    detail:
      from && to
        ? `${command.quantityMinor} moved from ${from.binId} to ${to.binId}`
        : to
          ? `${command.quantityMinor} put away into ${to.binId}`
          : `${command.quantityMinor} dispatched from ${from?.binId}`,
    movements,
  };
}

export interface PutAwaySuggestion {
  readonly productId: string;
  readonly batchId: string | null;
  readonly quantityMinor: number;
  readonly binId: string;
  readonly detail: string;
}

/**
 * Suggest where received stock should go. Prefers a bin that already holds the same
 * product (so one product does not scatter across the racking), then any bin with
 * room — and never suggests a pickable bin for stock that is not sellable.
 */
export function suggestPutAway(input: {
  readonly productId: string;
  readonly batchId: string | null;
  readonly quantityMinor: number;
  readonly state?: StockState;
  readonly bins: readonly Bin[];
  readonly contents: BinContents;
}): PutAwaySuggestion | { readonly detail: string } {
  const held = NEVER_PICKABLE.includes(input.state ?? 'on_hand');
  const candidates = input.bins.filter((bin) => {
    if (bin.capacityMinor <= 0) return false;
    if (held && bin.pickable) return false;
    return binOccupancy(bin.binId, input.contents) + input.quantityMinor <= bin.capacityMinor;
  });

  if (candidates.length === 0) {
    return {
      detail: held
        ? 'no holding bin has room — quarantined stock must not be put in a pickable bin to make space'
        : 'no bin has room for this quantity',
    };
  }

  const sameProduct = candidates.find(
    (bin) => (input.contents[binKey(bin.binId, input.productId, input.batchId)] ?? 0) > 0,
  );
  const chosen = sameProduct ?? candidates[0]!;

  return {
    productId: input.productId,
    batchId: input.batchId,
    quantityMinor: input.quantityMinor,
    binId: chosen.binId,
    detail: sameProduct
      ? `${chosen.binId} already holds this product — keeping it in one place`
      : `${chosen.binId} has room`,
  };
}
