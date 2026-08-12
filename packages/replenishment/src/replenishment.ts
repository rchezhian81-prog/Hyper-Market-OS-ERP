// Replenishment suggestions (M09-FR-02) — work out WHAT to reorder and HOW MUCH,
// from per-product parameters (reorder point / safety stock / max level, or a
// demand + lead-time computation). The output is a PROPOSAL a buyer approves — it
// is advisory only and can never become a purchase order by itself (hard rule #5 /
// AI-NFR-12: AI or automation may recommend a reorder, only an authorised human
// commits the PO). Parameters drive every number (M09-FR-02 acceptance). Pure and
// deterministic — no storage, no I/O — so it runs the same on the edge or in the
// cloud. A blocked/discontinued item is suppressed. Composes nothing but plain maths.

export interface ReplenishmentInput {
  readonly productId: string;
  /** Current available on-hand (units). */
  readonly onHand: number;
  /** Units already on order / in transit (count toward the inventory position). */
  readonly onOrder?: number;
  /** Units reserved/allocated (reduce the position). */
  readonly reserved?: number;
  /** Order-up-to level (the target after reordering). */
  readonly maxLevel: number;
  /** Buffer against variability. */
  readonly safetyStock?: number;
  /** Explicit reorder point; if absent it is computed from demand × lead + safety. */
  readonly reorderPoint?: number;
  /** Average daily demand — used to compute the reorder point when not explicit. */
  readonly avgDailyDemand?: number;
  /** Supplier lead time (days) — safety stock must respect it (M09-FR-02). */
  readonly leadTimeDays?: number;
  /** Supplier minimum order quantity. */
  readonly minOrderQty?: number;
  /** Pack / case size — the order rounds UP to a multiple of this. */
  readonly orderMultiple?: number;
  /** Remaining shelf life (days) of the batch on offer. With `avgDailyDemand`, this bounds the order so it
   *  never exceeds what can sell before the batch expires (D-3, perishables). Optional — absent → no bound,
   *  and with the demand rate unknown it does NOT cap (it never guesses). */
  readonly remainingShelfLifeDays?: number;
  /** Discontinued or blocked — suppress any suggestion (M09-FR-02 alt/error). */
  readonly blocked?: boolean;
}

export interface ReplenishmentProposal {
  readonly productId: string;
  /** on-hand + on-order − reserved. */
  readonly position: number;
  readonly reorderPoint: number;
  /** The suggested order quantity — advisory only, needs buyer approval. May be 0 with reason
   *  `held_shelf_life`: an order was due but ordering any compliant quantity would over-stock a perishable. */
  readonly suggestedQty: number;
  readonly reason: 'below_reorder_point' | 'held_shelf_life';
  /** Always true — this can never auto-commit a purchase (hard rule #5). */
  readonly advisoryOnly: true;
  /** D-3: the most units that can sell before this perishable expires (avgDailyDemand × remainingShelfLifeDays),
   *  present only when both are known. */
  readonly shelfLifeCap?: number;
  /** D-3: true when that ceiling actually reduced or suppressed the order — the buyer would otherwise be
   *  over-ordering a perishable (P-03: the exception is surfaced, not hidden). */
  readonly shelfLifeCapped?: boolean;
}

export class InvalidReplenishmentParameterError extends Error {
  constructor(productId: string, detail: string) {
    super(`Replenishment parameters for "${productId}" are invalid: ${detail}.`);
    this.name = 'InvalidReplenishmentParameterError';
  }
}

function requireInteger(productId: string, name: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new InvalidReplenishmentParameterError(productId, `${name} must be an integer >= ${min}`);
  }
}

/** The reorder point in effect — explicit, or safety + ceil(demand × lead time). */
function effectiveReorderPoint(input: ReplenishmentInput): number {
  if (input.reorderPoint !== undefined) {
    requireInteger(input.productId, 'reorderPoint', input.reorderPoint, 0);
    return input.reorderPoint;
  }
  const safety = input.safetyStock ?? 0;
  const demand = input.avgDailyDemand ?? 0;
  const lead = input.leadTimeDays ?? 0;
  if (safety < 0 || demand < 0 || lead < 0) {
    throw new InvalidReplenishmentParameterError(input.productId, 'safety/demand/lead must be >= 0');
  }
  return safety + Math.ceil(demand * lead);
}

/**
 * D-3: the days-of-supply ceiling — the most units that can sell before the batch on offer expires
 * (`avgDailyDemand × remainingShelfLifeDays`). Needs BOTH a remaining shelf life AND a demand rate; with
 * either unknown we cannot judge and do not cap (never guess — the same discipline as the lane's expiry
 * block). Returns `undefined` when no bound applies.
 */
function shelfLifeCapOf(input: ReplenishmentInput): number | undefined {
  if (input.remainingShelfLifeDays === undefined || input.avgDailyDemand === undefined) return undefined;
  requireInteger(input.productId, 'remainingShelfLifeDays', input.remainingShelfLifeDays, 0);
  if (input.avgDailyDemand < 0) {
    throw new InvalidReplenishmentParameterError(input.productId, 'avgDailyDemand must be >= 0');
  }
  return Math.floor(input.avgDailyDemand * input.remainingShelfLifeDays);
}

/**
 * Propose a replenishment for one product, or null when none is needed (position
 * above the reorder point, or the item is blocked, or the target is already met).
 * The suggested quantity brings the position up to the max level, rounded up to the
 * order multiple and raised to the supplier minimum — never below. Advisory only.
 *
 * D-3 (perishables): when the batch's remaining shelf life and the demand rate are both known, the
 * order-up-to level is additionally bounded by what can sell before the batch expires, and the order never
 * lifts the holding above that ceiling. If even the smallest compliant order (a full pack, the supplier
 * minimum) would breach it, NO order is placed and the item is surfaced as a `held_shelf_life` exception —
 * an over-order of a perishable is prevented, visibly (P-03 / P-08).
 */
export function proposeReplenishment(input: ReplenishmentInput): ReplenishmentProposal | null {
  if (input.blocked) return null;

  requireInteger(input.productId, 'maxLevel', input.maxLevel, 1);
  const onOrder = input.onOrder ?? 0;
  const reserved = input.reserved ?? 0;
  requireInteger(input.productId, 'onOrder', onOrder, 0);
  requireInteger(input.productId, 'reserved', reserved, 0);
  if (!Number.isSafeInteger(input.onHand)) {
    throw new InvalidReplenishmentParameterError(input.productId, 'onHand must be an integer');
  }

  const position = input.onHand + onOrder - reserved;
  const reorderPoint = effectiveReorderPoint(input);
  if (position > reorderPoint) return null; // enough stock/coverage — no reorder

  // D-3: a perishable's order-up-to is bounded by what can sell before it expires. When both the batch's
  // remaining shelf life and the demand rate are known, the target never rises above that ceiling.
  const shelfLifeCap = shelfLifeCapOf(input);
  const orderUpTo = shelfLifeCap === undefined ? input.maxLevel : Math.min(input.maxLevel, shelfLifeCap);
  let shelfLifeBound = shelfLifeCap !== undefined && orderUpTo < input.maxLevel; // the ceiling lowered the target

  let suggestedQty = orderUpTo - position; // order up to the (shelf-life-capped) target
  if (suggestedQty > 0) {
    const multiple = input.orderMultiple;
    if (multiple !== undefined) {
      requireInteger(input.productId, 'orderMultiple', multiple, 1);
      suggestedQty = Math.ceil(suggestedQty / multiple) * multiple; // round up to a full pack
    }
    const moq = input.minOrderQty;
    if (moq !== undefined) {
      requireInteger(input.productId, 'minOrderQty', moq, 1);
      if (suggestedQty < moq) suggestedQty = moq;
    }
    // The pack / MOQ round-up must not breach the shelf-life ceiling: fit whole packs UNDER it instead, and
    // if not even one compliant pack fits, place NO order (an over-order is prevented, D-3).
    if (shelfLifeCap !== undefined && position + suggestedQty > shelfLifeCap) {
      const grain = input.orderMultiple ?? 1;
      const fits = Math.floor((shelfLifeCap - position) / grain) * grain;
      suggestedQty = fits > 0 && fits >= (input.minOrderQty ?? 1) ? fits : 0;
      shelfLifeBound = true;
    }
  }

  if (suggestedQty <= 0) {
    // The order was suppressed. If a shelf-life ceiling is the reason (we WOULD have ordered up toward the
    // max level), surface it as a visible exception rather than a silent null (P-03 / P-08). Otherwise (the
    // target is simply already met) keep the existing behaviour and return null.
    if (shelfLifeCap !== undefined && input.maxLevel - position > 0) {
      return {
        productId: input.productId,
        position,
        reorderPoint,
        suggestedQty: 0,
        reason: 'held_shelf_life',
        advisoryOnly: true,
        shelfLifeCap,
        shelfLifeCapped: true,
      };
    }
    return null; // target already met (max misconfigured vs position) — unchanged behaviour
  }

  return {
    productId: input.productId,
    position,
    reorderPoint,
    suggestedQty,
    reason: 'below_reorder_point',
    advisoryOnly: true,
    ...(shelfLifeCap !== undefined ? { shelfLifeCap } : {}),
    ...(shelfLifeBound ? { shelfLifeCapped: true } : {}),
  };
}

/**
 * Propose replenishments across many products; returns only those that need a
 * reorder, in input order. Every entry is advisory and needs buyer approval.
 */
export function proposeReplenishmentBatch(
  inputs: readonly ReplenishmentInput[],
): ReplenishmentProposal[] {
  const proposals: ReplenishmentProposal[] = [];
  for (const input of inputs) {
    const proposal = proposeReplenishment(input);
    if (proposal !== null) proposals.push(proposal);
  }
  return proposals;
}
