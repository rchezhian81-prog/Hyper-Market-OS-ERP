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
  /** Discontinued or blocked — suppress any suggestion (M09-FR-02 alt/error). */
  readonly blocked?: boolean;
}

export interface ReplenishmentProposal {
  readonly productId: string;
  /** on-hand + on-order − reserved. */
  readonly position: number;
  readonly reorderPoint: number;
  /** The suggested order quantity — advisory only, needs buyer approval. */
  readonly suggestedQty: number;
  readonly reason: 'below_reorder_point';
  /** Always true — this can never auto-commit a purchase (hard rule #5). */
  readonly advisoryOnly: true;
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
 * Propose a replenishment for one product, or null when none is needed (position
 * above the reorder point, or the item is blocked, or the target is already met).
 * The suggested quantity brings the position up to the max level, rounded up to the
 * order multiple and raised to the supplier minimum — never below. Advisory only.
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

  let suggestedQty = input.maxLevel - position; // order up to the max level
  if (suggestedQty <= 0) return null; // target already met (max misconfigured vs position)

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

  return {
    productId: input.productId,
    position,
    reorderPoint,
    suggestedQty,
    reason: 'below_reorder_point',
    advisoryOnly: true,
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
