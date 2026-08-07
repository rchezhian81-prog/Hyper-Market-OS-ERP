// Supplier contracts, rebates, lead times and scorecards (M06-FR-03 / D03-FR-03 / M23).
//
// Buyers judge suppliers on the relationship. The numbers usually say something
// different, and the gap is expensive:
//
//   • FILL RATE. A supplier who ships 82% of what you order is not a 5% cheaper
//     supplier — they are the reason your shelf is empty on a Saturday, and the lost
//     sale dwarfs the price advantage.
//   • LEAD TIME VARIABILITY matters more than lead time. A reliable seven days beats
//     an average of four that is sometimes eleven, because you can only plan around
//     the number you can trust. So this scores the SPREAD, not just the mean.
//   • PRICE VARIANCE. What was invoiced against what was agreed, from the three-way
//     match — the supplier whose invoices always drift upward by 2%.
//   • REBATES. Agreed in a meeting, accrued nowhere, claimed late or never. An
//     unclaimed rebate is money the shop has already earned and not collected.
//
// Every score is computed from things that actually happened — receipts, invoices,
// dates — never from an opinion. Weights are per tenant, because a shop that competes
// on availability should weight fill rate above price, and one that competes on price
// should not.
//
// Exact integer basis points throughout; a score with no evidence behind it reports
// `not_rated` rather than a flattering default (P-08).

import type { Money } from '../../contracts/src/money';

export interface SupplierContract {
  readonly contractId: string;
  readonly supplierId: string;
  readonly startsOn: string;
  readonly endsOn: string;
  /** Agreed days from order to delivery — the promise to measure against. */
  readonly agreedLeadTimeDays: number;
  readonly approvedBy?: string;
}

/** One delivery, as it actually happened. */
export interface ReceiptFact {
  readonly poId: string;
  readonly supplierId: string;
  readonly orderedOn: string;
  readonly receivedOn: string;
  readonly orderedQtyMinor: number;
  readonly receivedQtyMinor: number;
  /** Quantity rejected on arrival — damaged, out of spec, expired. */
  readonly rejectedQtyMinor?: number;
  readonly agreedValue: Money;
  readonly invoicedValue: Money;
}

export type Rating =
  | { readonly kind: 'rated'; readonly bp: number }
  | { readonly kind: 'not_rated'; readonly because: string };

export interface ScorecardWeights {
  readonly fillRateBp: number;
  readonly onTimeBp: number;
  readonly leadTimeReliabilityBp: number;
  readonly priceAdherenceBp: number;
  readonly qualityBp: number;
}

/** Availability-first by default; a price-led tenant reweights it. */
export const DEFAULT_WEIGHTS: ScorecardWeights = {
  fillRateBp: 3_000,
  onTimeBp: 2_500,
  leadTimeReliabilityBp: 1_500,
  priceAdherenceBp: 1_500,
  qualityBp: 1_500,
};

export interface SupplierScorecard {
  readonly supplierId: string;
  readonly deliveries: number;
  /** Received ÷ ordered. The one that empties shelves when it slips. */
  readonly fillRate: Rating;
  /** Delivered within the agreed lead time. */
  readonly onTime: Rating;
  /**
   * Reliability of the lead time, not its length: 100% when every delivery takes the
   * same number of days, falling as the spread widens.
   */
  readonly leadTimeReliability: Rating;
  /** Invoiced value against agreed value. */
  readonly priceAdherence: Rating;
  /** Accepted ÷ received — the quality of what turned up. */
  readonly quality: Rating;
  readonly overall: Rating;
  readonly averageLeadTimeDays: number | null;
  readonly worstLeadTimeDays: number | null;
  /** Plain English, worst signal first. */
  readonly summary: string;
}

function rate(numerator: number, denominator: number, because: string): Rating {
  if (denominator <= 0) return { kind: 'not_rated', because };
  return { kind: 'rated', bp: Math.round((numerator * 10_000) / denominator) };
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

/** Score a supplier from what actually happened. */
export function scoreSupplier(input: {
  readonly supplierId: string;
  readonly receipts: readonly ReceiptFact[];
  readonly contract?: SupplierContract;
  readonly weights?: ScorecardWeights;
}): SupplierScorecard {
  const receipts = input.receipts.filter((r) => r.supplierId === input.supplierId);
  const weights = input.weights ?? DEFAULT_WEIGHTS;

  if (receipts.length === 0) {
    const none: Rating = { kind: 'not_rated', because: 'no deliveries in the period' };
    return {
      supplierId: input.supplierId,
      deliveries: 0,
      fillRate: none,
      onTime: none,
      leadTimeReliability: none,
      priceAdherence: none,
      quality: none,
      overall: none,
      averageLeadTimeDays: null,
      worstLeadTimeDays: null,
      summary: 'no deliveries in the period — nothing to judge, which is not the same as good',
    };
  }

  const ordered = receipts.reduce((s, r) => s + r.orderedQtyMinor, 0);
  const received = receipts.reduce((s, r) => s + r.receivedQtyMinor, 0);
  const rejected = receipts.reduce((s, r) => s + (r.rejectedQtyMinor ?? 0), 0);
  const agreedValue = receipts.reduce((s, r) => s + r.agreedValue.minor, 0);
  const invoicedValue = receipts.reduce((s, r) => s + r.invoicedValue.minor, 0);

  const leadTimes = receipts.map((r) => daysBetween(r.orderedOn, r.receivedOn));
  const averageLeadTime = leadTimes.reduce((s, d) => s + d, 0) / leadTimes.length;
  const worstLeadTime = Math.max(...leadTimes);

  const agreedLead = input.contract?.agreedLeadTimeDays;
  const onTimeCount =
    agreedLead === undefined ? 0 : leadTimes.filter((d) => d <= agreedLead).length;

  // Reliability from the spread: mean absolute deviation as a share of the mean,
  // inverted. A reliable seven days beats an average four that is sometimes eleven,
  // because you can only plan around a number you can trust.
  const meanDeviation =
    leadTimes.reduce((s, d) => s + Math.abs(d - averageLeadTime), 0) / leadTimes.length;
  const reliabilityBp =
    averageLeadTime === 0
      ? 10_000
      : Math.max(0, 10_000 - Math.round((meanDeviation * 10_000) / averageLeadTime));

  const fillRate = rate(Math.min(received, ordered), ordered, 'nothing was ordered');
  const onTime =
    agreedLead === undefined
      ? ({ kind: 'not_rated', because: 'no contracted lead time to measure against' } as Rating)
      : rate(onTimeCount, receipts.length, 'no deliveries');
  const leadTimeReliability: Rating = { kind: 'rated', bp: reliabilityBp };
  // Invoiced at or below agreed is full marks; above it loses proportionally.
  const priceAdherence =
    agreedValue <= 0
      ? ({ kind: 'not_rated', because: 'no agreed value to compare against' } as Rating)
      : ({
          kind: 'rated',
          bp: Math.max(0, Math.min(10_000, Math.round(((2 * agreedValue - invoicedValue) * 10_000) / agreedValue))),
        } as Rating);
  const quality = rate(received - rejected, received, 'nothing was received');

  const parts: { rating: Rating; weight: number }[] = [
    { rating: fillRate, weight: weights.fillRateBp },
    { rating: onTime, weight: weights.onTimeBp },
    { rating: leadTimeReliability, weight: weights.leadTimeReliabilityBp },
    { rating: priceAdherence, weight: weights.priceAdherenceBp },
    { rating: quality, weight: weights.qualityBp },
  ];
  const rated = parts.filter((p) => p.rating.kind === 'rated');
  const weightTotal = rated.reduce((s, p) => s + p.weight, 0);
  const overall: Rating =
    weightTotal === 0
      ? { kind: 'not_rated', because: 'nothing measurable in the period' }
      : {
          kind: 'rated',
          bp: Math.round(
            rated.reduce(
              (s, p) => s + (p.rating.kind === 'rated' ? p.rating.bp : 0) * p.weight,
              0,
            ) / weightTotal,
          ),
        };

  const signals: string[] = [];
  if (fillRate.kind === 'rated' && fillRate.bp < 9_500) {
    signals.push(
      `fill rate ${(fillRate.bp / 100).toFixed(1)}% — short deliveries empty the shelf, and the lost sale dwarfs any price advantage`,
    );
  }
  if (onTime.kind === 'rated' && onTime.bp < 9_000) {
    signals.push(`on time ${(onTime.bp / 100).toFixed(1)}% against an agreed ${agreedLead} days`);
  }
  if (reliabilityBp < 8_000) {
    signals.push(
      `lead time swings between ${Math.min(...leadTimes)} and ${worstLeadTime} days — you can only plan around a number you can trust`,
    );
  }
  if (priceAdherence.kind === 'rated' && invoicedValue > agreedValue) {
    // Any drift above the agreed value is worth naming — the supplier whose
    // invoices creep up 2% is invisible until someone adds the year together.
    signals.push(
      `invoices run above the agreed value by ${(((invoicedValue - agreedValue) * 10_000) / agreedValue / 100).toFixed(1)}%`,
    );
  }
  if (quality.kind === 'rated' && quality.bp < 9_800) {
    signals.push(`${((10_000 - quality.bp) / 100).toFixed(1)}% of what arrived was rejected`);
  }

  return {
    supplierId: input.supplierId,
    deliveries: receipts.length,
    fillRate,
    onTime,
    leadTimeReliability,
    priceAdherence,
    quality,
    overall,
    averageLeadTimeDays: Math.round(averageLeadTime * 10) / 10,
    worstLeadTimeDays: worstLeadTime,
    summary: signals.length === 0 ? 'no concerns in the period' : signals.join('; '),
  };
}

// --- rebates and schemes --------------------------------------------------------

export type RebateBasis = 'volume_units' | 'purchase_value' | 'growth_over_baseline';

export interface RebateScheme {
  readonly schemeId: string;
  readonly supplierId: string;
  readonly basis: RebateBasis;
  /** Rate in basis points applied to the basis. */
  readonly rateBp: number;
  /** Nothing accrues until this threshold is passed. */
  readonly thresholdMinor?: number;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly approvedBy?: string;
}

export interface RebateAccrual {
  readonly schemeId: string;
  readonly supplierId: string;
  /** The measured basis for the period. */
  readonly basisAmount: Money;
  /** What has accrued and may be claimed. */
  readonly accrued: Money;
  /** What finance has actually received (M23). */
  readonly received: Money;
  readonly outstanding: Money;
  readonly thresholdMet: boolean;
  readonly detail: string;
}

/**
 * Accrue a rebate. Accrual is deliberately separate from receipt: an accrued rebate
 * is money the shop has **already earned** and not yet collected, and the gap between
 * the two is the number nobody tracks.
 */
export function accrueRebate(input: {
  readonly scheme: RebateScheme;
  readonly basisAmount: Money;
  readonly received?: Money;
  readonly baselineAmount?: Money;
}): RebateAccrual {
  const currency = input.basisAmount.currency;
  const threshold = input.scheme.thresholdMinor ?? 0;

  const measurable =
    input.scheme.basis === 'growth_over_baseline'
      ? Math.max(0, input.basisAmount.minor - (input.baselineAmount?.minor ?? 0))
      : input.basisAmount.minor;

  const thresholdMet = measurable >= threshold;
  const accrued = thresholdMet ? Math.round((measurable * input.scheme.rateBp) / 10_000) : 0;
  const received = input.received?.minor ?? 0;

  return {
    schemeId: input.scheme.schemeId,
    supplierId: input.scheme.supplierId,
    basisAmount: input.basisAmount,
    accrued: { minor: accrued, currency },
    received: { minor: received, currency },
    outstanding: { minor: accrued - received, currency },
    thresholdMet,
    detail: !thresholdMet
      ? `below the ${threshold} threshold — ${threshold - measurable} more to earn anything`
      : accrued - received > 0
        ? `${accrued - received} minor units earned and NOT YET CLAIMED — this is money already made`
        : 'fully claimed and received',
  };
}

export interface ContractAlert {
  readonly contractId: string;
  readonly supplierId: string;
  readonly daysRemaining: number;
  readonly finding: 'active' | 'expiring_soon' | 'expired' | 'unapproved';
  readonly detail: string;
}

/** Expiring contracts, worst first — an expired one means buying on no terms at all. */
export function reviewContracts(
  contracts: readonly SupplierContract[],
  onDate: string,
  warnDays = 45,
): readonly ContractAlert[] {
  return contracts
    .map((contract): ContractAlert => {
      const daysRemaining = daysBetween(onDate, contract.endsOn);
      const base = { contractId: contract.contractId, supplierId: contract.supplierId, daysRemaining };
      if (contract.approvedBy === undefined || contract.approvedBy.trim() === '') {
        return { ...base, finding: 'unapproved', detail: 'no approver recorded on the contract terms (§28)' };
      }
      if (daysRemaining < 0) {
        return {
          ...base,
          finding: 'expired',
          detail: `expired ${-daysRemaining} days ago — every order since has been placed on no agreed terms`,
        };
      }
      if (daysRemaining <= warnDays) {
        return { ...base, finding: 'expiring_soon', detail: `ends in ${daysRemaining} days — renegotiate now, not after` };
      }
      return { ...base, finding: 'active', detail: `runs for another ${daysRemaining} days` };
    })
    .sort((a, b) => a.daysRemaining - b.daysRemaining);
}
