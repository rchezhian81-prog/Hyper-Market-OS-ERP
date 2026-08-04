// Promotion simulation, abuse limits, vendor funding and effectiveness
// (M05-FR-04 / D06-FR-04 / M23).
//
// A promotion is a decision to give away margin in exchange for volume. Shops make
// that decision on optimism and measure it, if at all, months later. Three things
// here turn it into arithmetic:
//
//   1. SIMULATE BEFORE APPROVING. Work out what the offer costs at the volume you
//      expect, and say plainly whether the line still makes money. The failure this
//      prevents is the classic one: a "20% off" that turns a 15% margin negative,
//      launched because nobody multiplied it out. The simulation WARNS BEFORE
//      APPROVAL, not after the month-end.
//
//   2. CAP THE ABUSE. A coupon with no limit is a coupon somebody uses forty times.
//      Limits are enforced at the till from the promo pack, so they hold OFFLINE too
//      — an abuse cap that only works online is not a cap, because the shop's busiest
//      hour and its worst connectivity are often the same hour.
//
//   3. TRACK WHO IS PAYING. Supplier-funded promotions are agreed in conversations
//      and forgotten by finance. Funding recorded here reconciles against what was
//      actually received (M23), so "the supplier is covering it" is a number rather
//      than a memory.
//
// Effectiveness compares against a baseline, and reports **incremental margin** —
// the only figure that answers "was it worth doing?". Uplift in units alone can be a
// loss.
//
// Money is exact minor units; ratios are BigInt basis points; a ratio that cannot be
// computed says so rather than returning zero (P-08).

import type { Money } from '../../contracts/src/money';

export interface SimulationInput {
  readonly promotionId: string;
  readonly description: string;
  /** Normal selling price per unit. */
  readonly normalPrice: Money;
  /** Price the customer pays under the offer. */
  readonly promoPrice: Money;
  /** What the unit costs us — landed, including process loss where relevant. */
  readonly unitCost: Money;
  /** Units expected to sell in the period WITHOUT the promotion. */
  readonly baselineUnits: number;
  /** Units expected WITH it — the volume the offer is meant to buy. */
  readonly expectedUnits: number;
  /** Per-unit supplier contribution, where the supplier funds the offer. */
  readonly vendorFundingPerUnit?: Money;
  /** Fixed costs of running it (display, print, staff time). */
  readonly fixedCost?: Money;
}

export type SimulationVerdict =
  | 'improves_margin'
  | 'margin_reduced_but_positive'
  | 'sells_below_cost'
  | 'destroys_margin';

export interface SimulationResult {
  readonly promotionId: string;
  readonly verdict: SimulationVerdict;
  /** Margin per unit at the promotional price, funding included. */
  readonly promoUnitMargin: Money;
  readonly baselineUnitMargin: Money;
  /** Total margin without the promotion, at baseline volume. */
  readonly baselineTotalMargin: Money;
  /** Total margin with it, at expected volume, less fixed costs. */
  readonly promoTotalMargin: Money;
  /** promo − baseline. Negative means the offer costs more than it brings. */
  readonly incrementalMargin: Money;
  /** Extra units needed just to break even against the baseline. */
  readonly breakEvenUnits: number | 'unreachable';
  /** True when it must not be approved without an explicit override. */
  readonly blocksApproval: boolean;
  readonly detail: string;
}

/**
 * Simulate a promotion before it launches. The number that matters is
 * **incremental margin**: what the shop keeps with the offer minus what it would
 * have kept without it.
 */
export function simulatePromotion(input: SimulationInput): SimulationResult {
  const funding = input.vendorFundingPerUnit?.minor ?? 0;
  const fixed = input.fixedCost?.minor ?? 0;
  const currency = input.normalPrice.currency;

  const baselineUnitMargin = input.normalPrice.minor - input.unitCost.minor;
  const promoUnitMargin = input.promoPrice.minor + funding - input.unitCost.minor;

  const baselineTotal = baselineUnitMargin * input.baselineUnits;
  const promoTotal = promoUnitMargin * input.expectedUnits - fixed;
  const incremental = promoTotal - baselineTotal;

  // How many units at the promo margin would match the baseline? If the promo
  // margin is zero or negative, no volume ever gets there — selling more loses more.
  const breakEvenUnits =
    promoUnitMargin <= 0
      ? ('unreachable' as const)
      : Math.ceil((baselineTotal + fixed) / promoUnitMargin);

  const verdict: SimulationVerdict =
    promoUnitMargin < 0
      ? 'sells_below_cost'
      : incremental < 0
        ? 'destroys_margin'
        : promoUnitMargin < baselineUnitMargin
          ? 'margin_reduced_but_positive'
          : 'improves_margin';

  const detail =
    verdict === 'sells_below_cost'
      ? `every unit sold loses ${-promoUnitMargin} minor units — volume makes this worse, not better`
      : verdict === 'destroys_margin'
        ? `at ${input.expectedUnits} units this returns ${-incremental} minor units LESS than doing nothing; it would need ${
            breakEvenUnits === 'unreachable' ? 'an unreachable volume' : `${breakEvenUnits} units`
          } to break even`
        : verdict === 'margin_reduced_but_positive'
          ? `margin per unit falls but the extra volume more than covers it: ${incremental} minor units better than the baseline`
          : `better on both margin and volume: ${incremental} minor units better than the baseline`;

  return {
    promotionId: input.promotionId,
    verdict,
    promoUnitMargin: { minor: promoUnitMargin, currency },
    baselineUnitMargin: { minor: baselineUnitMargin, currency },
    baselineTotalMargin: { minor: baselineTotal, currency },
    promoTotalMargin: { minor: promoTotal, currency },
    incrementalMargin: { minor: incremental, currency },
    breakEvenUnits,
    // Selling below cost, or returning less than doing nothing, needs a human to say
    // yes on purpose — there are good reasons (footfall, clearance), but never by
    // accident.
    blocksApproval: verdict === 'sells_below_cost' || verdict === 'destroys_margin',
    detail,
  };
}

export interface PromotionApproval {
  readonly subjectRef: string;
  readonly status: 'approved' | 'rejected' | 'pending';
  readonly decidedBy: string;
  readonly rationale?: string;
}

export class PromotionApprovalRequiredError extends Error {
  constructor(
    public readonly promotionId: string,
    public readonly why: string,
  ) {
    super(`Promotion "${promotionId}" cannot launch: ${why}`);
    this.name = 'PromotionApprovalRequiredError';
  }
}

/**
 * Gate a promotion on its simulation. One that damages margin may still launch —
 * a loss-leader is a legitimate decision — but only with a named approver and a
 * written rationale (§28).
 */
export function approveForLaunch(
  simulation: SimulationResult,
  approval: PromotionApproval | undefined,
  proposedBy: string,
): { readonly mayLaunch: true; readonly approvedBy?: string } {
  if (!simulation.blocksApproval) {
    return { mayLaunch: true };
  }
  if (approval === undefined || approval.status !== 'approved') {
    throw new PromotionApprovalRequiredError(
      simulation.promotionId,
      `the simulation says it ${simulation.detail} — launching anyway needs an explicit approval`,
    );
  }
  if (approval.subjectRef !== simulation.promotionId) {
    throw new PromotionApprovalRequiredError(simulation.promotionId, 'the approval is for a different promotion');
  }
  if (approval.decidedBy === proposedBy) {
    throw new PromotionApprovalRequiredError(
      simulation.promotionId,
      'the person proposing a margin-losing offer cannot approve it themselves (§28)',
    );
  }
  if ((approval.rationale ?? '').trim().length < 10) {
    throw new PromotionApprovalRequiredError(
      simulation.promotionId,
      'a deliberate margin loss needs a written reason — otherwise nobody can tell it from a mistake',
    );
  }
  return { mayLaunch: true, approvedBy: approval.decidedBy };
}

// --- abuse limits --------------------------------------------------------------

export interface AbuseLimit {
  readonly promotionId: string;
  /** Times one customer may use it. Omit for unlimited (rare, and stated). */
  readonly perCustomer?: number;
  /** Times it may be used in one basket. */
  readonly perBasket?: number;
  /** Total uses across the whole promotion — the budget. */
  readonly totalUses?: number;
}

export interface AbuseCheckInput {
  readonly limit: AbuseLimit;
  readonly usedByThisCustomer: number;
  readonly usedInThisBasket: number;
  readonly usedInTotal: number;
  /** True when the lane is offline and counting from its cached pack (§31). */
  readonly offline?: boolean;
}

export type AbuseVerdict = 'allowed' | 'customer_limit' | 'basket_limit' | 'budget_exhausted';

export interface AbuseCheck {
  readonly verdict: AbuseVerdict;
  readonly allowed: boolean;
  readonly detail: string;
  /** Set offline, where the count may be behind — visible, never silent (P-08). */
  readonly countMayBeStale?: boolean;
}

/**
 * Enforce a promotion's limits. Deliberately works from counts the caller supplies,
 * so **the same rule runs at an offline lane from its cached pack**. An abuse cap
 * that only holds online is not a cap: the busiest hour and the worst connectivity
 * are often the same hour.
 */
export function checkAbuseLimit(input: AbuseCheckInput): AbuseCheck {
  const stale = input.offline === true ? { countMayBeStale: true } : {};

  if (input.limit.perBasket !== undefined && input.usedInThisBasket >= input.limit.perBasket) {
    return {
      verdict: 'basket_limit',
      allowed: false,
      detail: `this offer applies ${input.limit.perBasket} time(s) per basket`,
      ...stale,
    };
  }
  if (input.limit.perCustomer !== undefined && input.usedByThisCustomer >= input.limit.perCustomer) {
    return {
      verdict: 'customer_limit',
      allowed: false,
      detail: `this customer has already used the offer ${input.usedByThisCustomer} time(s) of ${input.limit.perCustomer}`,
      ...stale,
    };
  }
  if (input.limit.totalUses !== undefined && input.usedInTotal >= input.limit.totalUses) {
    return {
      verdict: 'budget_exhausted',
      allowed: false,
      detail: `the offer's budget of ${input.limit.totalUses} uses is spent`,
      ...stale,
    };
  }
  return { verdict: 'allowed', allowed: true, detail: 'within limits', ...stale };
}

// --- vendor funding and effectiveness -------------------------------------------

export interface VendorFundingClaim {
  readonly promotionId: string;
  readonly supplierId: string;
  /** What the supplier agreed to contribute per unit. */
  readonly agreedPerUnit: Money;
  readonly unitsSold: number;
  /** What finance has actually received against it (M23). */
  readonly receivedAmount?: Money;
  readonly approvedBy?: string;
}

export interface FundingReconciliation {
  readonly promotionId: string;
  readonly supplierId: string;
  readonly claimable: Money;
  readonly received: Money;
  readonly outstanding: Money;
  readonly reconciled: boolean;
  readonly detail: string;
}

/** Claimed vs received — so "the supplier is covering it" is a number, not a memory. */
export function reconcileVendorFunding(
  claim: VendorFundingClaim,
  currency: Money['currency'],
): FundingReconciliation {
  const claimable = claim.agreedPerUnit.minor * claim.unitsSold;
  const received = claim.receivedAmount?.minor ?? 0;
  const outstanding = claimable - received;
  return {
    promotionId: claim.promotionId,
    supplierId: claim.supplierId,
    claimable: { minor: claimable, currency },
    received: { minor: received, currency },
    outstanding: { minor: outstanding, currency },
    reconciled: outstanding === 0,
    detail:
      outstanding === 0
        ? 'fully funded as agreed'
        : outstanding > 0
          ? `${outstanding} minor units of agreed funding not yet received — the discount was given, the contribution was not`
          : `${-outstanding} minor units received above the agreed claim — check the agreement or refund the difference`,
  };
}

export interface EffectivenessInput {
  readonly promotionId: string;
  readonly baselineUnits: number;
  readonly actualUnits: number;
  readonly baselineMargin: Money;
  readonly actualMargin: Money;
  readonly vendorFundingReceived?: Money;
}

export interface EffectivenessResult {
  readonly promotionId: string;
  readonly upliftUnits: number;
  readonly upliftBp: number;
  /** The only figure that answers "was it worth doing?". */
  readonly incrementalMargin: Money;
  readonly worthDoing: boolean;
  readonly detail: string;
}

/**
 * Measure a finished promotion against its baseline. Unit uplift alone is not
 * success — a promotion can sell 40% more and still leave the shop poorer, which is
 * exactly why this reports incremental MARGIN as the verdict.
 */
export function measureEffectiveness(input: EffectivenessInput): EffectivenessResult {
  const currency = input.baselineMargin.currency;
  const funding = input.vendorFundingReceived?.minor ?? 0;
  const incremental = input.actualMargin.minor + funding - input.baselineMargin.minor;
  const uplift = input.actualUnits - input.baselineUnits;
  const upliftBp =
    input.baselineUnits === 0 ? 0 : Math.round((uplift * 10_000) / input.baselineUnits);

  return {
    promotionId: input.promotionId,
    upliftUnits: uplift,
    upliftBp,
    incrementalMargin: { minor: incremental, currency },
    worthDoing: incremental > 0,
    detail:
      incremental > 0
        ? `sold ${uplift} more units and kept ${incremental} minor units more margin`
        : uplift > 0
          ? `sold ${uplift} more units but kept ${-incremental} minor units LESS — busier, and poorer`
          : `neither more units nor more margin`,
  };
}
