// Margin-floor / MRP price controls (M05-FR-02) — the guardrail that stops a price
// from ever going above the legal MRP ceiling or silently below the margin floor /
// cost. A price above MRP is REJECTED outright (no approval can authorise it — MRP
// is a legal ceiling in India). A price below the margin floor, or below landed
// cost, is not silently allowed: it is BLOCKED pending an explicit approval with a
// reason (P-03 / P-08), by someone other than the setter (§28). The checks are
// exact (BigInt margin maths, no float) and pure, so they run identically on the
// edge from cached cost/rules — deterministic best price offline (M05-FR-02
// offline rule). Composes the Money primitive and the approval engine (upstream).

import { compare, type Money } from '../../contracts/src/money';
import type { DecidedRequest } from '../../approvals/src/approvals';

export type PriceVerdict = 'ok' | 'above_mrp' | 'below_cost' | 'below_floor';

export interface CheckPriceInput {
  /** Price id — the subjectRef an approval must reference. */
  readonly id: string;
  readonly proposedPrice: Money;
  /** Maximum retail price (legal ceiling). */
  readonly mrp: Money;
  /** Landed cost (M07). */
  readonly cost: Money;
  /** Minimum gross margin as basis points of price (0–9999). 2000 = 20%. */
  readonly marginFloorBps: number;
  /** Who is setting the price (cannot self-approve a below-floor/cost price). */
  readonly setBy: string;
  /** An approval decision — required to allow a below-floor / below-cost price. */
  readonly approval?: DecidedRequest;
}

export interface PriceCheck {
  readonly verdict: PriceVerdict;
  /** True when the price may be published (ok, or a below-floor/cost price approved). */
  readonly allowed: boolean;
  /** True when the price needs an approval (below floor or below cost). */
  readonly requiresApproval: boolean;
  /** The approval reason when allowed via approval, else null. */
  readonly reason: string | null;
}

export class InvalidMarginFloorError extends Error {
  constructor(bps: number) {
    super(`marginFloorBps must be an integer 0–9999, got ${bps}.`);
    this.name = 'InvalidMarginFloorError';
  }
}

/** True if the price's gross margin is below the floor: exact, via BigInt.
 * margin = (price − cost) / price; below floor ⇔ price·(10000 − floorBps) < cost·10000. */
function belowMarginFloor(price: Money, cost: Money, floorBps: number): boolean {
  if (price.currency !== cost.currency) {
    throw new TypeError(`Cannot compare ${price.currency} price with ${cost.currency} cost.`);
  }
  const lhs = BigInt(price.minor) * BigInt(10_000 - floorBps);
  const rhs = BigInt(cost.minor) * 10_000n;
  return lhs < rhs;
}

function approvalValid(approval: DecidedRequest | undefined, id: string, setBy: string): boolean {
  return (
    approval !== undefined &&
    approval.status === 'approved' &&
    approval.subjectRef === id &&
    approval.decidedBy !== setBy // separation of duties (§28)
  );
}

/**
 * Check a proposed price against MRP, landed cost and the margin floor. Returns a
 * verdict and whether it may be published: above MRP is always rejected; a
 * below-cost or below-floor price is allowed only with a valid separate approval;
 * anything at/above the floor and at/below MRP is ok. Deterministic — identical
 * online and on the offline edge.
 */
export function checkPrice(input: CheckPriceInput): PriceCheck {
  if (!Number.isInteger(input.marginFloorBps) || input.marginFloorBps < 0 || input.marginFloorBps > 9999) {
    throw new InvalidMarginFloorError(input.marginFloorBps);
  }

  // Above MRP — hard reject, no approval path (legal ceiling).
  if (compare(input.proposedPrice, input.mrp) > 0) {
    return { verdict: 'above_mrp', allowed: false, requiresApproval: false, reason: null };
  }

  // Below landed cost — a loss-making price; exception with approval + reason.
  if (compare(input.proposedPrice, input.cost) < 0) {
    const ok = approvalValid(input.approval, input.id, input.setBy);
    return {
      verdict: 'below_cost',
      allowed: ok,
      requiresApproval: true,
      reason: ok ? (input.approval?.reason ?? null) : null,
    };
  }

  // Below the margin floor — blocked pending approval.
  if (belowMarginFloor(input.proposedPrice, input.cost, input.marginFloorBps)) {
    const ok = approvalValid(input.approval, input.id, input.setBy);
    return {
      verdict: 'below_floor',
      allowed: ok,
      requiresApproval: true,
      reason: ok ? (input.approval?.reason ?? null) : null,
    };
  }

  return { verdict: 'ok', allowed: true, requiresApproval: false, reason: null };
}
