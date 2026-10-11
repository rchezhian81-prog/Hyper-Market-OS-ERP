// WF-08 / D05-FR-05 · OB-59 "A" (owner, 11 Oct 2026, "Adjustments & write-offs") — the stock-count FREEZE on every
// head-office path that writes an adjustment or a write-off (P-08 · hard rule #10).
//
// While a count plan is open (`counting`) at a place, the kinds it froze — by default adjustments (`adjusted`) and
// write-offs (`wasted`) — must not land there for a counted product. Round 8 refused them only on the plain movements
// route; every OTHER head-office route that writes one (the write-off route, a held returned unit's write-off decision,
// an adjustment request's approval, an ad-hoc count's correction and its decision, a transfer's found-stock and
// arrived-damaged postings) asks here first and is refused by name (`frozen_by_a_stock_count`, 409, nothing written).
//
// A record RELAYED by the store computer (a decision made on the floor while the line was down, a device's receipt) is
// a fact that already happened: it is never refused into the void. It is kept, and because it lands at the counted
// place under the freeze, the plan raises it as a visible exception (`freezeBreaches`) and the product must be counted
// again after it (`moved_during_freeze` / `expected_changed`) before the plan can be approved.

import { apiError } from '../../kernel/src/index';

/** Which open count plan (its id) freezes a movement of `kind` at this place for this product right now, if any. */
export type CountFreezeCheck = (tenantId: string, locationId: string, productId: string, kind: string) => Promise<string | undefined> | string | undefined;

/** One movement a route is about to write — what the freeze is judged on. */
export interface FreezeCandidate {
  readonly productId: string;
  readonly locationId: string;
  readonly kind: string;
}

/** The refusal every head-office path gives — the same code and words as the plain movements route. */
export function frozenByCountError(planId: string, m: FreezeCandidate, what: string) {
  return apiError(409, {
    code: 'frozen_by_a_stock_count',
    whatHappened: `${m.productId} is being counted at ${m.locationId} under count plan ${planId}, which freezes "${m.kind}" movements there until the count is approved or cancelled — so this ${what} cannot be recorded now (OB-59).`,
    wasItSaved: 'not_saved',
    nextSafeAction: 'Hold it until the count closes (approved or cancelled), then send it again. Nothing was recorded and no stock moved.',
  });
}

/**
 * The first open plan that freezes any of these movements — `undefined` when none does (or no check is wired, as on a
 * bare stub). `exceptPlanId` lets a plan's OWN correction through (its approval posts its counts' variances).
 */
export async function freezingPlanOf(check: CountFreezeCheck | undefined, tenantId: string, moves: readonly FreezeCandidate[], exceptPlanId?: string): Promise<{ planId: string; move: FreezeCandidate } | undefined> {
  if (check === undefined) return undefined;
  for (const move of moves) {
    const planId = await check(tenantId, move.locationId, move.productId, move.kind);
    if (planId !== undefined && planId !== exceptPlanId) return { planId, move };
  }
  return undefined;
}

/** Refuse (throws `frozen_by_a_stock_count`, 409) when an open count freezes any of these movements. */
export async function assertNotFrozenByCount(check: CountFreezeCheck | undefined, tenantId: string, moves: readonly FreezeCandidate[], what: string, exceptPlanId?: string): Promise<void> {
  const hit = await freezingPlanOf(check, tenantId, moves, exceptPlanId);
  if (hit !== undefined) throw frozenByCountError(hit.planId, hit.move, what);
}
