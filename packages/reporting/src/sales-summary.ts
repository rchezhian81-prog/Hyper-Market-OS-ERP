// Sales KPIs (M29-FR-01 / D13) — the numbers that matter, from governed, consistent
// definitions so a figure means the same everywhere (§8.3). Money is summed in exact
// integer minor units (never a float); derived ratios (margin %, average basket) are
// rounded display values computed from those exact sums. Pure and deterministic — it
// aggregates committed sale facts the caller has already gathered (each ties back to
// its immutable source for drill-through, M29-FR-02).

import type { CurrencyCode } from '../../contracts/src/money';

/** One payment on a bill: the kind and the amount that kind actually paid (minor units). */
export interface TenderPart {
  readonly kind: string;
  readonly amountMinor: number;
}

/**
 * The key a tender mix carries for the part of a bill its recorded tenders do not explain (audit EA-02).
 *
 * A bill whose payments add to more or less than its total still has a real total; the gap is shown under its own
 * name so the mix always adds back to the takings and the difference is visible rather than folded into a kind.
 */
export const TENDER_DIFFERENCE = 'tender_difference';

/** A committed sale reduced to its reporting facts (each ties to an immutable source). */
export interface SaleFact {
  readonly saleId: string;
  readonly netMinor: number; // pre-tax
  readonly taxMinor: number;
  readonly totalMinor: number; // net + tax
  readonly cogsMinor: number; // cost of goods sold
  readonly units: number;
  /**
   * The bill's main tender kind (cash/card/upi/…) — a label for the bill, used for drill and basket views. The tender
   * MIX is built from `tenders` when the bill carries them, never by booking a whole split bill under this one kind.
   */
  readonly tender: string;
  /**
   * Every payment on the bill, by kind and amount (audit EA-02). A ₹300 bill paid ₹250 card + ₹50 cash counts ₹250
   * under card and ₹50 under cash. Absent or empty: the whole bill is reported under `tender`.
   */
  readonly tenders?: readonly TenderPart[];
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
  /**
   * Σ money per tender kind, in minor units — each payment on a split bill under its own kind (EA-02). Always adds
   * back to `grossSalesMinor`: a bill whose tenders do not add to its total carries the gap under `TENDER_DIFFERENCE`.
   */
  readonly tenderMix: Readonly<Record<string, number>>;
  /** How many bills used each tender kind. A split bill counts once under every kind it used. */
  readonly tenderBills: Readonly<Record<string, number>>;
}

/**
 * The money one bill puts under each tender kind (EA-02): each payment by its own amount, and any part the payments do
 * not explain under `TENDER_DIFFERENCE`, so the parts always add back to the bill's total.
 */
export function tenderSplit(sale: Pick<SaleFact, 'totalMinor' | 'tender' | 'tenders'>): Readonly<Record<string, number>> {
  const parts = sale.tenders ?? [];
  if (parts.length === 0) return { [sale.tender]: sale.totalMinor };
  const out: Record<string, number> = {};
  let paid = 0;
  for (const p of parts) {
    out[p.kind] = (out[p.kind] ?? 0) + p.amountMinor;
    paid += p.amountMinor;
  }
  if (paid !== sale.totalMinor) out[TENDER_DIFFERENCE] = (out[TENDER_DIFFERENCE] ?? 0) + (sale.totalMinor - paid);
  return out;
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
  const tenderBills: Record<string, number> = {};
  let ccy = currency;

  for (const [i, s] of sales.entries()) {
    if (i === 0) ccy = s.currency;
    else if (s.currency !== ccy) throw new MixedCurrencyError();
    gross += s.totalMinor;
    net += s.netMinor;
    tax += s.taxMinor;
    cogs += s.cogsMinor;
    units += s.units;
    for (const [kind, minor] of Object.entries(tenderSplit(s))) {
      tenderMix[kind] = (tenderMix[kind] ?? 0) + minor;
      tenderBills[kind] = (tenderBills[kind] ?? 0) + 1;
    }
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
    tenderBills,
  };
}
