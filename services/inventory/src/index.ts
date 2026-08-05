// API-04 Inventory — movements, availability, batches, adjustments, counts.
//
// **Movements are appended; balances are projected** (hard rule #2, M08). Nothing here updates a
// quantity, and there is no endpoint that could: a correction is a compensating movement with its
// own reason and its own approver, so the ledger reads as what happened rather than as what
// somebody last decided it should look like.
//
// Two consequences that shape the surface:
//
//   • **Arrival order does not matter.** A handheld back from the chiller and a lane back from
//     three days offline both send movements out of order. Because the balance is a projection of
//     an append-only set, the same movements in any order give the same figure — asserted, not
//     assumed.
//
//   • **Negative available stock is reported, not blocked.** A shelf that has gone negative is a
//     shelf that was already wrong before this service heard about it, and refusing the movement
//     would leave the ledger disagreeing with the aisle while the aisle wins. It becomes a visible
//     exception (P-08, hard rule #10).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';

export type MovementKind =
  | 'received' | 'sold' | 'returned' | 'transferred_in' | 'transferred_out'
  | 'adjusted' | 'wasted' | 'counted';

/** What each kind does to on-hand. Declared, never inferred from a sign on the quantity. */
export const EFFECT_ON_HAND: Readonly<Record<MovementKind, 1 | -1>> = {
  received: 1, returned: 1, transferred_in: 1, counted: 1, adjusted: 1,
  sold: -1, transferred_out: -1, wasted: -1,
};

export interface Movement {
  readonly movementId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly kind: MovementKind;
  /** Always positive; `kind` carries the direction. */
  readonly quantityMinor: number;
  readonly uom: string;
  readonly occurredAt: string;
  readonly batchId?: string;
  /** Required for `adjusted` and `wasted` — a quantity change with no reason is untraceable. */
  readonly reason?: string;
  readonly approvedBy?: string;
  readonly enteredBy: string;
}

export interface Availability {
  readonly productId: string;
  readonly locationId: string;
  readonly onHandMinor: number;
  readonly movements: number;
  /** Projected from the ledger at this instant, and stamped so staleness is visible (P-08). */
  readonly asAt: string;
}

/**
 * Project on-hand from an append-only movement set. Order-independent by construction.
 *
 * `opening` is a balance already projected from the movements **before** this set — a snapshot.
 * Folding from the beginning of time is correct and unbounded: a hypermarket generates a few
 * thousand movements a day, so a year is well over a million, and every availability lookup was
 * replaying all of them. A snapshot is not a second source of truth, because it is derived from
 * the ledger and can be thrown away and rebuilt; what it is not allowed to be is *editable*, which
 * is why it is itself an event.
 */
export function project(
  movements: readonly Movement[], asAt: string, opening: readonly Availability[] = [],
): readonly Availability[] {
  const byKey = new Map<string, { productId: string; locationId: string; qty: number; n: number }>();
  for (const a of opening) {
    byKey.set(`${a.productId}\u001f${a.locationId}`, {
      productId: a.productId, locationId: a.locationId, qty: a.onHandMinor, n: a.movements,
    });
  }
  for (const m of movements) {
    const key = `${m.productId}\u001f${m.locationId}`;
    const acc = byKey.get(key) ?? { productId: m.productId, locationId: m.locationId, qty: 0, n: 0 };
    acc.qty += m.quantityMinor * EFFECT_ON_HAND[m.kind];
    acc.n += 1;
    byKey.set(key, acc);
  }
  return [...byKey.values()]
    .sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : a.locationId < b.locationId ? -1 : 1))
    .map((a) => ({
      productId: a.productId, locationId: a.locationId,
      onHandMinor: a.qty, movements: a.n, asAt,
    }));
}

export type MovementRefusal = 'adjustment_without_a_reason' | 'adjustment_not_approved' | 'quantity_not_positive';

export interface MovementCheck {
  readonly ok: boolean;
  readonly refusedBecause?: MovementRefusal;
  readonly detail: string;
}

/**
 * The only refusals: a quantity change nobody explained, and one nobody approved.
 *
 * Everything else that arrives is something that already happened in the building.
 */
export function checkMovement(m: Movement): MovementCheck {
  if (!Number.isInteger(m.quantityMinor) || m.quantityMinor <= 0) {
    return {
      ok: false, refusedBecause: 'quantity_not_positive',
      detail: 'a movement quantity is a magnitude and its kind carries the direction. A signed quantity here is how a receipt becomes an issue when somebody reads it back',
    };
  }
  if ((m.kind === 'adjusted' || m.kind === 'wasted')) {
    if (m.reason === undefined || m.reason.trim().length < 4) {
      return {
        ok: false, refusedBecause: 'adjustment_without_a_reason',
        detail: `a ${m.kind} movement with no reason is a quantity change nobody can account for later. Shrinkage, damage and a miscount need telling apart at the year end`,
      };
    }
    if (m.approvedBy === undefined || m.approvedBy === m.enteredBy) {
      return {
        ok: false, refusedBecause: 'adjustment_not_approved',
        detail: `${m.enteredBy} entered and approved this ${m.kind}. Writing stock off is the one movement that makes a difference disappear, so it takes two people (§28)`,
      };
    }
  }
  return { ok: true, detail: `${m.kind} ${m.quantityMinor} of ${m.productId} at ${m.locationId}` };
}

export interface NegativeStock {
  readonly productId: string;
  readonly locationId: string;
  readonly onHandMinor: number;
  readonly detail: string;
  readonly ownerAction: string;
}

/** Negative on-hand, reported rather than prevented. */
export const negativeStock = (rows: readonly Availability[]): readonly NegativeStock[] =>
  rows.filter((r) => r.onHandMinor < 0).map((r) => ({
    productId: r.productId, locationId: r.locationId, onHandMinor: r.onHandMinor,
    detail: `${r.productId} at ${r.locationId} projects to ${r.onHandMinor}`,
    ownerAction: 'The shelf cannot hold less than nothing, so something was sold that was never received or received against the wrong code. Count the line — do not adjust it to zero, which hides whichever of those it was.',
  }));

export interface InventoryDeps {
  readonly appendMovement: (tenantId: string, m: Movement) => Promise<void> | void;
  /**
   * Has this exact movement already been recorded?
   *
   * Was `known(tenantId) => Set<string>` — every movement id the shop has ever recorded, loaded so
   * that one `.has()` could be run against it. A handheld back from the chiller sending forty
   * movements paid that forty times.
   */
  readonly isKnown: (tenantId: string, movementId: string) => Promise<boolean> | boolean;
  /**
   * On-hand, already projected — snapshot plus whatever has happened since.
   *
   * This was `movements(tenantId, productId?) => Movement[]`, and the route folded them. That put
   * an **unbounded read** behind every availability lookup: a few thousand movements a day is well
   * over a million a year, all replayed to answer "how many bags of rice are there?". The domain
   * still owns *how* to project (`project` above); the adapter owns *from where*.
   */
  readonly availability: (tenantId: string, productId?: string) => Promise<readonly Availability[]> | readonly Availability[];
  readonly now: () => string;
}

export function inventoryRoutes(deps: InventoryDeps): readonly Route[] {
  return [
    {
      api: 'API-04', method: 'POST', path: '/v1/inventory/movements',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const m = ctx.body as Movement;
        if (m === null || typeof m !== 'object' || typeof m.movementId !== 'string') {
          throw apiError(400, {
            code: 'not_readable_as_a_movement',
            whatHappened: 'This payload could not be read as a stock movement.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Keep it queued on the device and raise it. A movement that cannot be sent still happened on the floor.',
          });
        }
        const check = checkMovement(m);
        if (!check.ok) {
          throw apiError(422, {
            code: check.refusedBecause!,
            whatHappened: check.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was appended. Add what is missing and send it again — the stock has not moved in the system either way.',
          });
        }
        if (!(await deps.isKnown(ctx.tenantId, m.movementId))) {
          await deps.appendMovement(ctx.tenantId, m);
        }
        return { status: 202, body: { movementId: m.movementId, appended: true } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/inventory/availability',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const productId = ctx.query['productId'];
        const rows = await deps.availability(ctx.tenantId, productId);
        return { status: 200, body: { rows, asAt: deps.now() } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/inventory/exceptions',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const rows = await deps.availability(ctx.tenantId);
        return { status: 200, body: { negative: negativeStock(rows), asAt: deps.now() } };
      },
    },
  ];
}
