// Store clusters and season plans (D02-FR-02 "seasonal assortment and store clustering" · OB-288 P2).
//
// OB-318 (owner, 23 Oct 2026, in writing): the CLUSTER is the price-zone register — one register (store → zone) drives both
// the zone price and the range, so a store can never be in one group for its prices and another for what it stocks. A range
// decision made for a cluster is written as the ordinary per-store range entry for EVERY store in it (the assortment stays
// the one record every check reads), each naming the cluster decision it came from.
//
// A SEASON PLAN lists products for a cluster (or one store) from a date to a date: the listing is written ahead, dated from
// the season's first day, and on the season's last day the plan ends AUTOMATICALLY — each product leaves the range through
// the ordinary drop rule, so one with stock still on the shelf goes to CLEARANCE (sellable until it is gone) and one with
// none is delisted. Reason `seasonal_end`, always. Ending is idempotent: a plan ends once.
//
// Pure and deterministic: "today" and the stock are passed in.

import { dropFromRange, type AssortmentEntry } from './assortment';

export interface ClusterMembership {
  readonly storeId: string;
  readonly zoneId: string;
  readonly setAt: string;
}

/** The stores in a cluster now: each store's LATEST zone membership decides (a store moved out is no longer in it). */
export function clusterStores(memberships: readonly ClusterMembership[], zoneId: string): readonly string[] {
  const latest = new Map<string, ClusterMembership>();
  for (const m of memberships) {
    const cur = latest.get(m.storeId);
    if (cur === undefined || cur.setAt <= m.setAt) latest.set(m.storeId, m);
  }
  return [...latest.values()].filter((m) => m.zoneId === zoneId).map((m) => m.storeId).sort();
}

export interface SeasonPlan {
  readonly planId: string;
  /** The cluster the season is for, or a single store. Exactly one. */
  readonly zoneId?: string;
  readonly storeId?: string;
  /** The stores it was written for, fixed when the plan was made (a later move between clusters does not rewrite history). */
  readonly storeIds: readonly string[];
  readonly productIds: readonly string[];
  /** First and last day of the season (YYYY-MM-DD). */
  readonly listFrom: string;
  readonly listTo: string;
  readonly reason: string;
  readonly setBy: string;
  readonly setAt: string;
}

export interface SeasonEndDecision {
  readonly storeId: string;
  readonly productId: string;
  readonly entry: AssortmentEntry;
  readonly outcome: 'clearance' | 'delisted';
}

/** The day after a YYYY-MM-DD date — the season's range ends from the day after its last day. */
export function dayAfter(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** Whether a season plan is due to end on `today` — its last day has passed. */
export function seasonEnded(plan: Pick<SeasonPlan, 'listTo'>, today: string): boolean {
  return today > plan.listTo;
}

/**
 * The range decisions that END a season: for every store × product, the ordinary drop (clearance with stock, delisted
 * without), effective the day after the season's last day, decided by `decidedBy` (the person or sweep that ended it).
 */
export function seasonEndDecisions(input: {
  readonly plan: SeasonPlan;
  readonly onHand: (storeId: string, productId: string) => number;
  readonly decidedBy: string;
}): readonly SeasonEndDecision[] {
  const effectiveFrom = dayAfter(input.plan.listTo);
  const out: SeasonEndDecision[] = [];
  for (const storeId of input.plan.storeIds) {
    for (const productId of input.plan.productIds) {
      const d = dropFromRange({
        storeId, productId, onHandMinor: Math.max(0, input.onHand(storeId, productId)), reason: 'seasonal_end',
        reasonNote: `season plan ${input.plan.planId} ended (${input.plan.listFrom} to ${input.plan.listTo})`,
        decidedBy: input.decidedBy, effectiveFrom,
      });
      out.push({ storeId, productId, entry: d.entry, outcome: d.entry.status === 'clearance' ? 'clearance' : 'delisted' });
    }
  }
  return out;
}
