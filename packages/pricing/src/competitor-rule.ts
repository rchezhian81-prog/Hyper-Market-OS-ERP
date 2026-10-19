// D-18 (R4, OB-216) — competitor prices DRAFT a price change; they never make one.
//
// When a competitor's latest recorded price for the same product is at least the owner's gap (5% by default) below the
// shop's own price, and that sighting is younger than the owner's age limit (14 days by default), this drafts a price
// change to the competitor's price. Both figures are settings the owner can change. The draft is judged by the SAME
// price guard the governed price route uses (`checkPrice`), with no approval:
//
//   • never above MRP — a draft above the printed MRP is brought down to it (MRP is a legal ceiling);
//   • never below cost or the margin floor — such a draft is REFUSED ("draft refused: below margin floor"), not trimmed:
//     whether to sell below the floor is a person's decision on the price route, with its second-person approval;
//   • a sighting 14 days old or more is not used ("sighting too old");
//   • a figure head office does not hold (our price, the MRP, the cost, the store's floor) is said, never guessed.
//
// A draft is advice. Nothing here records, sends or applies anything: a person commits a draft through the existing
// price route (`POST /v1/prices/changes`), which runs its own MRP / cost / floor checks again. No AI is involved.
// Pure and deterministic: no clock (now is passed in), no I/O.

import { checkPrice } from '../../price-guard/src/price-guard';
import { money, type CurrencyCode } from '../../contracts/src/money';

export interface CompetitorRule {
  /** How far below the shop's price a competitor must be, in basis points of the shop's price (500 = 5%). */
  readonly gapBps: number;
  /** A sighting this many days old or more is not used. */
  readonly maxAgeDays: number;
}

/** OB-216 (owner, 19 Oct 2026): 5% lower, under 14 days. The owner may change either. */
export const COMPETITOR_RULE_DEFAULTS: CompetitorRule = Object.freeze({ gapBps: 500, maxAgeDays: 14 });

export interface CompetitorSighting {
  readonly observationId: string;
  readonly competitor: string;
  readonly priceMinor: number;
  readonly observedAt: string;
}

export interface ProductPriceFacts {
  readonly productId: string;
  readonly storeId: string;
  /** The shop's own price at the store now; null when it has none. */
  readonly ourPriceMinor: number | null;
  readonly mrpMinor?: number;
  readonly costMinor?: number;
  readonly marginFloorBps?: number;
  readonly currency: CurrencyCode;
  readonly sightings: readonly CompetitorSighting[];
}

export interface PriceDraft {
  readonly productId: string;
  readonly storeId: string;
  readonly fromPriceMinor: number;
  readonly draftPriceMinor: number;
  readonly mrpMinor: number;
  readonly costMinor: number;
  readonly marginFloorBps: number;
  readonly currency: CurrencyCode;
  readonly competitor: string;
  readonly competitorPriceMinor: number;
  readonly observationId: string;
  readonly observedAt: string;
  readonly ageDays: number;
  readonly gapBps: number;
  /** True when the competitor's price was above MRP and the draft was brought down to it. */
  readonly cappedAtMrp: boolean;
  readonly detail: string;
}

export type NotDraftedReason =
  | 'draft_refused_below_margin_floor'
  | 'sighting_too_old'
  | 'gap_below_setting'
  | 'no_shop_price'
  | 'mrp_not_known'
  | 'cost_not_known'
  | 'margin_floor_not_set';

/** The words the owner sees for each reason. */
export const NOT_DRAFTED_WORDS: Readonly<Record<NotDraftedReason, string>> = Object.freeze({
  draft_refused_below_margin_floor: 'draft refused: below margin floor',
  sighting_too_old: 'sighting too old',
  gap_below_setting: 'competitor not far enough below',
  no_shop_price: 'no shop price at this store',
  mrp_not_known: 'MRP not known',
  cost_not_known: 'cost not known',
  margin_floor_not_set: 'margin floor not set for this store',
});

export interface NotDrafted {
  readonly productId: string;
  readonly storeId: string;
  readonly reason: NotDraftedReason;
  readonly words: string;
  readonly competitor?: string;
  readonly competitorPriceMinor?: number;
  readonly observationId?: string;
  readonly ageDays?: number;
  readonly detail: string;
}

const DAY_MS = 86_400_000;

/** The rule's own check: whole basis points 1–9999 and whole days 1–365. */
export function competitorRuleProblem(rule: { readonly gapBps?: unknown; readonly maxAgeDays?: unknown }): string | undefined {
  if (!Number.isInteger(rule.gapBps) || (rule.gapBps as number) < 1 || (rule.gapBps as number) > 9_999) return 'gapBps must be a whole number of basis points from 1 to 9999 (500 = 5%)';
  if (!Number.isInteger(rule.maxAgeDays) || (rule.maxAgeDays as number) < 1 || (rule.maxAgeDays as number) > 365) return 'maxAgeDays must be a whole number of days from 1 to 365';
  return undefined;
}

/** Each competitor's LATEST sighting — an older, lower one is never used once a newer one exists. */
export function latestPerCompetitor(sightings: readonly CompetitorSighting[]): readonly CompetitorSighting[] {
  const by = new Map<string, CompetitorSighting>();
  for (const s of sightings) {
    const held = by.get(s.competitor);
    if (held === undefined || Date.parse(s.observedAt) > Date.parse(held.observedAt)) by.set(s.competitor, s);
  }
  return [...by.values()];
}

/** Draft a price change for one product at one store, or say why not. Never applies anything. */
export function draftFromCompetitors(facts: ProductPriceFacts, rule: CompetitorRule, now: string): { readonly draft?: PriceDraft; readonly notDrafted: readonly NotDrafted[] } {
  const { productId, storeId } = facts;
  const nowMs = Date.parse(now);
  const notDrafted: NotDrafted[] = [];
  const latest = latestPerCompetitor(facts.sightings).map((s) => ({ s, ageDays: Math.floor((nowMs - Date.parse(s.observedAt)) / DAY_MS) }));
  const fresh = latest.filter((x) => x.ageDays < rule.maxAgeDays);
  for (const x of latest.filter((y) => y.ageDays >= rule.maxAgeDays)) {
    notDrafted.push({
      productId, storeId, reason: 'sighting_too_old', words: NOT_DRAFTED_WORDS.sighting_too_old, competitor: x.s.competitor, competitorPriceMinor: x.s.priceMinor,
      observationId: x.s.observationId, ageDays: x.ageDays, detail: `${x.s.competitor}'s price was seen ${x.ageDays} day(s) ago — ${rule.maxAgeDays} days or more is too old to act on`,
    });
  }
  if (fresh.length === 0) return { notDrafted };
  const say = (reason: NotDraftedReason, detail: string, x?: { s: CompetitorSighting; ageDays: number }): { notDrafted: NotDrafted[] } => ({
    notDrafted: [...notDrafted, {
      productId, storeId, reason, words: NOT_DRAFTED_WORDS[reason], detail,
      ...(x === undefined ? {} : { competitor: x.s.competitor, competitorPriceMinor: x.s.priceMinor, observationId: x.s.observationId, ageDays: x.ageDays }),
    }],
  });
  // The lowest fresh competitor price is the one that matters.
  const best = [...fresh].sort((a, b) => a.s.priceMinor - b.s.priceMinor || a.s.competitor.localeCompare(b.s.competitor))[0]!;
  const ours = facts.ourPriceMinor;
  if (ours === null) return say('no_shop_price', 'the shop has no price for this product at this store today, so there is nothing to compare', best);
  const gapBps = Math.floor(((ours - best.s.priceMinor) * 10_000) / ours);
  if ((ours - best.s.priceMinor) * 10_000 < rule.gapBps * ours) {
    return say('gap_below_setting', `${best.s.competitor} is ${(gapBps / 100).toFixed(1)}% below the shop's price — the setting asks for ${(rule.gapBps / 100).toFixed(1)}% or more`, best);
  }
  if (facts.mrpMinor === undefined) return say('mrp_not_known', 'the product master holds no MRP in force, so a draft could not be shown to be at or below it', best);
  if (facts.costMinor === undefined) return say('cost_not_known', 'head office holds no buying cost for this product at this store, so the margin floor cannot be checked', best);
  if (facts.marginFloorBps === undefined) return say('margin_floor_not_set', 'the owner has not set this store\'s margin floor in its rules, so a draft cannot be judged against it', best);

  const cappedAtMrp = best.s.priceMinor > facts.mrpMinor;
  const draftPriceMinor = Math.min(best.s.priceMinor, facts.mrpMinor);
  const check = checkPrice({
    id: `competitor-draft-${productId}-${storeId}`,
    proposedPrice: money(draftPriceMinor, facts.currency), mrp: money(facts.mrpMinor, facts.currency), cost: money(facts.costMinor, facts.currency),
    marginFloorBps: facts.marginFloorBps, setBy: 'competitor-rule',
  });
  if (check.verdict === 'below_cost' || check.verdict === 'below_floor') {
    return say('draft_refused_below_margin_floor', `matching ${best.s.competitor} at ${draftPriceMinor} would be ${check.verdict === 'below_cost' ? 'below the buying cost' : 'below the store\'s margin floor'} (cost ${facts.costMinor}, floor ${(facts.marginFloorBps / 100).toFixed(1)}%) — no draft; only a person may choose a loss-making price, with a second person's approval`, best);
  }
  return {
    notDrafted,
    draft: {
      productId, storeId, fromPriceMinor: ours, draftPriceMinor, mrpMinor: facts.mrpMinor, costMinor: facts.costMinor, marginFloorBps: facts.marginFloorBps,
      currency: facts.currency, competitor: best.s.competitor, competitorPriceMinor: best.s.priceMinor, observationId: best.s.observationId,
      observedAt: best.s.observedAt, ageDays: best.ageDays, gapBps, cappedAtMrp,
      detail: `${best.s.competitor} sells it at ${best.s.priceMinor}, ${(gapBps / 100).toFixed(1)}% below the shop's ${ours} (seen ${best.ageDays} day(s) ago) — a draft to ${draftPriceMinor} for a person to approve`,
    },
  };
}
