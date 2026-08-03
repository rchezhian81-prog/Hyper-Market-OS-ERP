// Stock health metrics (M08-FR-04) — ageing, turns, GMROI and stockouts.
//
// These four numbers answer the question the owner actually asks: **is the money
// tied up in this stock working, or is it sitting there dying?** A hypermarket can
// look profitable on margin and still be starved of cash because the cash is on the
// shelves.
//
//   • AGEING     — how long the money has been asleep, in buckets.
//   • TURNS      — how many times a year the stock sells through. Low turns on a
//                  high-margin line still means slow money.
//   • GMROI      — gross margin return on inventory investment: the rupees of
//                  margin earned per rupee of stock held. The single most honest
//                  measure of whether a line deserves its shelf space.
//   • STOCKOUTS  — what was not on the shelf when someone wanted it. The loss that
//                  never appears in any sales report, because the sale never
//                  happened.
//
// All maths is exact: money stays in integer minor units and ratios are returned in
// basis points computed with BigInt, so nothing is lost to floating point (§29.1).
// A ratio with a zero denominator is reported as "not meaningful" rather than as
// Infinity, NaN or a silent zero — a made-up number is worse than an absent one
// (P-08).
//
// Pure and deterministic: "now" is passed in, there is no clock.

import type { Money } from '../../contracts/src/money';

/** A ratio in basis points, or an honest statement that it cannot be computed. */
export type Ratio =
  | { readonly kind: 'ratio'; readonly bp: number }
  | { readonly kind: 'not_meaningful'; readonly because: string };

/** Exact ratio in basis points — BigInt throughout, half-up on the final digit. */
export function ratioBp(numerator: number, denominator: number, because: string): Ratio {
  if (denominator === 0) {
    return { kind: 'not_meaningful', because };
  }
  const n = BigInt(numerator) * 10_000n;
  const d = BigInt(denominator);
  const quotient = n / d;
  const remainder = n % d;
  const rounded =
    (remainder < 0n ? -remainder : remainder) * 2n >= (d < 0n ? -d : d)
      ? quotient + (numerator < 0 !== denominator < 0 ? -1n : 1n)
      : quotient;
  return { kind: 'ratio', bp: Number(rounded) };
}

/** Render a ratio the way the owner reads it: "3.20×", or why it is absent. */
export function formatRatio(r: Ratio): string {
  return r.kind === 'ratio' ? `${(r.bp / 10_000).toFixed(2)}×` : `not meaningful — ${r.because}`;
}

// --- ageing -----------------------------------------------------------------

/** One lot of stock on hand, with the date it arrived and what it cost. */
export interface StockLot {
  readonly productId: string;
  readonly batchId: string | null;
  readonly quantityMinor: number;
  /** ISO-8601 date (YYYY-MM-DD) the stock was received. */
  readonly receivedOn: string;
  /** Cost of the whole lot — what the money asleep here is worth. */
  readonly value: Money;
}

export interface AgeingBucket {
  readonly label: string;
  /** Inclusive lower bound in days. */
  readonly fromDays: number;
  /** Exclusive upper bound in days; omit for "and older". */
  readonly toDays?: number;
}

/** Per-tenant ageing buckets — chosen, never hard-coded. */
export const DEFAULT_AGEING_BUCKETS: readonly AgeingBucket[] = [
  { label: '0-30 days', fromDays: 0, toDays: 31 },
  { label: '31-60 days', fromDays: 31, toDays: 61 },
  { label: '61-90 days', fromDays: 61, toDays: 91 },
  { label: 'over 90 days', fromDays: 91 },
];

export interface AgeingRow {
  readonly label: string;
  readonly quantityMinor: number;
  readonly value: Money;
  /** Share of the total stock value sitting in this bucket, in basis points. */
  readonly shareBp: number;
}

export interface AgeingReport {
  readonly asOfDate: string;
  readonly rows: readonly AgeingRow[];
  readonly totalValue: Money;
  /** Value older than the last bucket's lower bound — the money most at risk. */
  readonly oldestBucketValue: Money;
}

function daysBetweenDates(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** How long the money has been asleep, bucketed and valued (M08-FR-04). */
export function stockAgeing(
  lots: readonly StockLot[],
  asOfDate: string,
  currency: Money['currency'],
  buckets: readonly AgeingBucket[] = DEFAULT_AGEING_BUCKETS,
): AgeingReport {
  const totals = buckets.map(() => ({ quantityMinor: 0, minor: 0 }));

  for (const lot of lots) {
    const age = daysBetweenDates(lot.receivedOn, asOfDate);
    const index = buckets.findIndex(
      (b) => age >= b.fromDays && (b.toDays === undefined || age < b.toDays),
    );
    // Stock dated in the future (a data error) falls in the newest bucket rather
    // than vanishing from the report — a missing row hides the problem.
    const target = totals[index === -1 ? 0 : index];
    if (target) {
      target.quantityMinor += lot.quantityMinor;
      target.minor += lot.value.minor;
    }
  }

  const totalMinor = totals.reduce((sum, t) => sum + t.minor, 0);
  const rows = buckets.map((bucket, i): AgeingRow => {
    const t = totals[i] ?? { quantityMinor: 0, minor: 0 };
    const share = ratioBp(t.minor, totalMinor, 'there is no stock to compare against');
    return {
      label: bucket.label,
      quantityMinor: t.quantityMinor,
      value: { minor: t.minor, currency },
      shareBp: share.kind === 'ratio' ? share.bp : 0,
    };
  });

  return {
    asOfDate,
    rows,
    totalValue: { minor: totalMinor, currency },
    oldestBucketValue: { minor: totals[totals.length - 1]?.minor ?? 0, currency },
  };
}

// --- turns and GMROI --------------------------------------------------------

export interface TurnsInput {
  /** Cost of goods sold over the period. */
  readonly cogs: Money;
  /** Average stock value held over the same period, at cost. */
  readonly averageInventory: Money;
  /** Days the period covers — used to annualise. */
  readonly periodDays: number;
}

export interface TurnsResult {
  /** Turns during the period itself. */
  readonly turns: Ratio;
  /** The same rate projected over a year, for comparison across periods. */
  readonly annualisedTurns: Ratio;
  /** Days of stock on hand at the current rate of sale. */
  readonly daysOfCover: Ratio;
}

/** How many times the stock sold through — and how long the shelf would last. */
export function inventoryTurns(input: TurnsInput): TurnsResult {
  const turns = ratioBp(input.cogs.minor, input.averageInventory.minor, 'no stock was held');
  const annualised =
    turns.kind === 'ratio' && input.periodDays > 0
      ? ratioBp(turns.bp * 365, input.periodDays * 10_000, 'the period has no length')
      : { kind: 'not_meaningful' as const, because: 'turns could not be computed' };
  const daysOfCover =
    input.cogs.minor === 0
      ? { kind: 'not_meaningful' as const, because: 'nothing sold in the period' }
      : ratioBp(input.averageInventory.minor * input.periodDays, input.cogs.minor, 'nothing sold');
  return { turns, annualisedTurns: annualised, daysOfCover };
}

export interface GmroiInput {
  /** Gross margin earned on the product over the period. */
  readonly grossMargin: Money;
  /** Average stock value held, at cost. */
  readonly averageInventory: Money;
}

/**
 * Gross margin return on inventory investment — rupees of margin per rupee of stock.
 * Below 1.00× the line is consuming more cash than it returns, however good its
 * percentage margin looks.
 */
export function gmroi(input: GmroiInput): Ratio {
  return ratioBp(
    input.grossMargin.minor,
    input.averageInventory.minor,
    'no stock was held, so there is no investment to return on',
  );
}

// --- stockouts ---------------------------------------------------------------

export interface StockoutInput {
  readonly productId: string;
  /** Days in the period the product was not available to sell. */
  readonly daysOutOfStock: number;
  readonly periodDays: number;
  /** Typical units sold per trading day when it IS on the shelf. */
  readonly averageDailyUnits: number;
  /** Margin earned per unit — what each missed sale actually cost. */
  readonly marginPerUnit: Money;
}

export interface StockoutRow {
  readonly productId: string;
  readonly daysOutOfStock: number;
  /** Share of the period the shelf was empty, in basis points. */
  readonly outOfStockBp: number;
  readonly estimatedLostUnits: number;
  /** The margin that was never earned — an estimate, and labelled as one. */
  readonly estimatedLostMargin: Money;
}

/**
 * What the empty shelf cost. This is an ESTIMATE built from the product's own
 * normal rate of sale — it is reported as such, never mixed into actuals, because
 * a sale that did not happen leaves no receipt to verify it against.
 */
export function stockoutImpact(
  inputs: readonly StockoutInput[],
  currency: Money['currency'],
): { readonly rows: readonly StockoutRow[]; readonly totalLostMargin: Money } {
  const rows = inputs.map((input): StockoutRow => {
    const share = ratioBp(input.daysOutOfStock, input.periodDays, 'the period has no length');
    const lostUnits = Math.round(input.daysOutOfStock * input.averageDailyUnits);
    return {
      productId: input.productId,
      daysOutOfStock: input.daysOutOfStock,
      outOfStockBp: share.kind === 'ratio' ? share.bp : 0,
      estimatedLostUnits: lostUnits,
      estimatedLostMargin: { minor: lostUnits * input.marginPerUnit.minor, currency },
    };
  });
  return {
    rows,
    totalLostMargin: {
      minor: rows.reduce((sum, r) => sum + r.estimatedLostMargin.minor, 0),
      currency,
    },
  };
}
