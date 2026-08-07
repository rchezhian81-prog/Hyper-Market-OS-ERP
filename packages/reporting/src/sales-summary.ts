// Sales KPIs (M29-FR-01 / D13) — the numbers that matter, from governed, consistent
// definitions so a figure means the same everywhere (§8.3). Money is summed in exact
// integer minor units (never a float); derived ratios (margin %, average basket) are
// rounded display values computed from those exact sums. Pure and deterministic — it
// aggregates committed sale facts the caller has already gathered (each ties back to
// its immutable source for drill-through, M29-FR-02).

import type { CurrencyCode } from '../../contracts/src/money';

/** A committed sale reduced to its reporting facts (each ties to an immutable source). */
export interface SaleFact {
  readonly saleId: string;
  readonly netMinor: number; // pre-tax
  readonly taxMinor: number;
  readonly totalMinor: number; // net + tax
  readonly cogsMinor: number; // cost of goods sold
  readonly units: number;
  /** Primary tender kind (cash/card/upi/…) for the tender-mix breakdown. */
  readonly tender: string;
  readonly currency: CurrencyCode;
}

export interface SalesSummary {
  readonly currency: CurrencyCode;
  readonly grossSalesMinor: number; // Σ total
  readonly netSalesMinor: number; // Σ net
  readonly taxMinor: number; // Σ tax
  readonly cogsMinor: number; // Σ cogs
  readonly marginMinor: number; // net − cogs
  /** margin ÷ net, in basis points (0 when net is 0). */
  readonly marginPctBps: number;
  readonly basketCount: number;
  readonly unitsSold: number;
  /** gross ÷ baskets, rounded to minor units (0 when no baskets). */
  readonly avgBasketMinor: number;
  /** Σ total per tender kind, in minor units. */
  readonly tenderMix: Readonly<Record<string, number>>;
}

export class MixedCurrencyError extends Error {
  constructor() {
    super('Sales summary requires all sale facts to share one currency.');
    this.name = 'MixedCurrencyError';
  }
}

/**
 * Aggregate sale facts into the core KPIs. Money sums are exact (integer minor
 * units). Returns a zeroed summary for an empty input (currency defaults to INR).
 * Throws if the facts mix currencies (a KPI must not silently blend currencies).
 */
export function salesSummary(sales: readonly SaleFact[], currency: CurrencyCode = 'INR'): SalesSummary {
  let gross = 0;
  let net = 0;
  let tax = 0;
  let cogs = 0;
  let units = 0;
  const tenderMix: Record<string, number> = {};
  let ccy = currency;

  for (const [i, s] of sales.entries()) {
    if (i === 0) ccy = s.currency;
    else if (s.currency !== ccy) throw new MixedCurrencyError();
    gross += s.totalMinor;
    net += s.netMinor;
    tax += s.taxMinor;
    cogs += s.cogsMinor;
    units += s.units;
    tenderMix[s.tender] = (tenderMix[s.tender] ?? 0) + s.totalMinor;
  }

  const basketCount = sales.length;
  const marginMinor = net - cogs;
  const marginPctBps = net === 0 ? 0 : Math.round((marginMinor * 10_000) / net);
  const avgBasketMinor = basketCount === 0 ? 0 : Math.round(gross / basketCount);

  return {
    currency: ccy,
    grossSalesMinor: gross,
    netSalesMinor: net,
    taxMinor: tax,
    cogsMinor: cogs,
    marginMinor,
    marginPctBps,
    basketCount,
    unitsSold: units,
    avgBasketMinor,
    tenderMix,
  };
}
