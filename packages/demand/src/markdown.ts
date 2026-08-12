// Expiry markdown ladder (D-4, M05·M10) — what to knock off the price of stock that is about to expire,
// so it sells instead of being written off. This is the commercial partner to the perishables work: B8
// stops an expired item being sold, D-3 stops the shop over-buying, and this clears what is already on the
// shelf and running out of time.
//
// **Two inputs, exactly as the roadmap says: remaining shelf life AND sell-through.**
//   • Sell-through decides WHETHER to mark down. At the current rate of sale, will this batch clear before
//     it expires? Projected sales = demand × days left. If the whole holding will sell, there is nothing to
//     discount — a markdown on stock that was going to sell anyway is margin given away. Only the SURPLUS
//     (what will not clear in time) is the problem this solves.
//   • Remaining shelf life decides HOW DEEP. The markdown ladder deepens as the use-by approaches — a light
//     nudge with a week to go, a real cut on the last day. The ladder is DATA (a per-tenant policy), so a
//     change is a config edit, not a code change.
//
// **It proposes; a person commits (hard rule #5).** Every proposal is `advisoryOnly: true`, and there is no
// function here that changes a price — committing a markdown goes through the real price-change approval
// path, and a test reads this module's exports to prove no shortcut exists. Pure and deterministic.

/** One rung of the ladder: within `maxDaysLeft` of expiry, this discount applies. */
export interface MarkdownTier {
  /** Applies when remaining shelf life ≤ this (whole days, ≥ 0). */
  readonly maxDaysLeft: number;
  /** Basis points off the current price (0…10000). */
  readonly markdownBps: number;
}

/** The per-tenant markdown ladder — data, not code (OC-10-style policy). */
export interface MarkdownPolicy {
  readonly ladder: readonly MarkdownTier[];
}

/** A sensible default: 10% within a week of the use-by, 25% within three days, 50% on the last day. */
export const DEFAULT_MARKDOWN_LADDER: MarkdownPolicy = {
  ladder: [
    { maxDaysLeft: 7, markdownBps: 1000 },
    { maxDaysLeft: 3, markdownBps: 2500 },
    { maxDaysLeft: 1, markdownBps: 5000 },
  ],
};

export type MarkdownReason =
  /** At the current rate of sale the whole holding clears before the use-by — no markdown needed. */
  | 'will_clear'
  /** A surplus will not clear in time, and the use-by is near enough to trigger the ladder. */
  | 'marked_down'
  /** A surplus will not clear in time, but the use-by is not near enough yet for the ladder — watch it. */
  | 'too_early';

export interface MarkdownProposal {
  readonly productId: string;
  readonly batchId?: string;
  readonly remainingShelfLifeDays: number;
  readonly onHandMinor: number;
  readonly avgDailyDemandMinor: number;
  /** Units expected to sell before the use-by at the current rate (demand × remaining shelf life). */
  readonly projectedSalesMinor: number;
  /** Units that will NOT clear before the use-by at the current rate (0 if it all clears). */
  readonly surplusMinor: number;
  /** The proposed discount, basis points off. 0 = no markdown proposed. */
  readonly markdownBps: number;
  readonly currentPriceMinor: number;
  /** current × (1 − markdown), rounded — the price a person would approve. */
  readonly newPriceMinor: number;
  readonly reason: MarkdownReason;
  /** Always true — this can never re-price by itself; a person commits (hard rule #5). */
  readonly advisoryOnly: true;
  readonly detail: string;
}

export class InvalidMarkdownInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMarkdownInputError';
  }
}

function requireWholeAtLeast(field: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new InvalidMarkdownInputError(`${field} must be a whole number of at least ${min}`);
  }
}

function validatePolicy(policy: MarkdownPolicy): void {
  if (!Array.isArray(policy.ladder) || policy.ladder.length === 0) {
    throw new InvalidMarkdownInputError('a markdown policy needs at least one ladder tier');
  }
  for (const tier of policy.ladder) {
    requireWholeAtLeast('maxDaysLeft', tier.maxDaysLeft, 0);
    if (!Number.isInteger(tier.markdownBps) || tier.markdownBps < 0 || tier.markdownBps > 10_000) {
      throw new InvalidMarkdownInputError('markdownBps must be a whole number between 0 and 10000');
    }
  }
}

/**
 * Propose a markdown for one near-expiry batch, or none when it will clear at the current rate of sale.
 * The ladder deepens as the use-by approaches; the sell-through surplus gates whether the ladder applies at
 * all. Advisory only — a person commits (hard rule #5). Throws `InvalidMarkdownInputError` on bad input.
 */
export function proposeMarkdown(input: {
  readonly productId: string;
  readonly batchId?: string;
  readonly remainingShelfLifeDays: number;
  readonly onHandMinor: number;
  readonly avgDailyDemandMinor: number;
  readonly currentPriceMinor: number;
  readonly policy?: MarkdownPolicy;
}): MarkdownProposal {
  requireWholeAtLeast('remainingShelfLifeDays', input.remainingShelfLifeDays, 0);
  requireWholeAtLeast('onHandMinor', input.onHandMinor, 0);
  requireWholeAtLeast('avgDailyDemandMinor', input.avgDailyDemandMinor, 0);
  requireWholeAtLeast('currentPriceMinor', input.currentPriceMinor, 1);
  const policy = input.policy ?? DEFAULT_MARKDOWN_LADDER;
  validatePolicy(policy);

  const projectedSalesMinor = input.avgDailyDemandMinor * input.remainingShelfLifeDays;
  const surplusMinor = Math.max(0, input.onHandMinor - projectedSalesMinor);

  let markdownBps = 0;
  let reason: MarkdownReason;
  if (surplusMinor === 0) {
    reason = 'will_clear';
  } else {
    // The deepest discount whose window we are inside (the use-by is within its maxDaysLeft).
    const applicable = policy.ladder.filter((t) => input.remainingShelfLifeDays <= t.maxDaysLeft);
    if (applicable.length === 0) {
      reason = 'too_early';
    } else {
      markdownBps = Math.max(...applicable.map((t) => t.markdownBps));
      reason = 'marked_down';
    }
  }

  const newPriceMinor = markdownBps === 0
    ? input.currentPriceMinor
    : Math.round((input.currentPriceMinor * (10_000 - markdownBps)) / 10_000);

  const detail = reason === 'will_clear'
    ? `will clear: ${input.onHandMinor} on hand, ~${projectedSalesMinor} will sell in ${input.remainingShelfLifeDays} day(s) at ${input.avgDailyDemandMinor}/day`
    : reason === 'too_early'
      ? `${surplusMinor} will not clear before the use-by, but ${input.remainingShelfLifeDays} day(s) is outside the ladder — watch it`
      : `${surplusMinor} of ${input.onHandMinor} will not clear in ${input.remainingShelfLifeDays} day(s) → ${markdownBps / 100}% off, ${input.currentPriceMinor} → ${newPriceMinor} (a person approves)`;

  return {
    productId: input.productId,
    ...(input.batchId === undefined ? {} : { batchId: input.batchId }),
    remainingShelfLifeDays: input.remainingShelfLifeDays,
    onHandMinor: input.onHandMinor,
    avgDailyDemandMinor: input.avgDailyDemandMinor,
    projectedSalesMinor,
    surplusMinor,
    markdownBps,
    currentPriceMinor: input.currentPriceMinor,
    newPriceMinor,
    reason,
    advisoryOnly: true,
    detail,
  };
}
