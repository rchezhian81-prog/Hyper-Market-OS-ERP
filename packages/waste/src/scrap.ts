// Scrap and recycling sales (M28-FR-02 / M23 / hard rule #6).
//
// Cardboard, plastic crates, dead freezers, cooking oil, damaged stock sold for salvage. In
// most shops this is the one revenue stream with **no paperwork and no controls**: a man with
// a van comes on a Tuesday, cash changes hands, and nothing anywhere records it.
//
// That is exactly why it is worth building carefully. Unrecorded proceeds are the easiest
// money in a store to take, and because nobody knows what a month of cardboard is *worth*,
// nobody can tell the difference between ₹4,000 and ₹12,000. The control is not suspicion —
// it is simply **making the number exist**.
//
//   • **PROCEEDS ARE INCOME AND MUST LAND IN THE BOOKS.** A scrap sale that never reaches
//     finance is off-books cash, whatever anyone intended.
//   • **AN UNEVIDENCED SCRAP SALE IS FLAGGED, NOT REFUSED.** Refusing it would simply push
//     the transaction outside the system, which is the situation we started from. It records,
//     and it is visible as an exception with a name against it.
//   • **A RATE THAT DRIFTS IS THE SIGNAL.** Nobody remembers what cardboard fetched last
//     month. The system does, and a rate well below the running average is the question worth
//     asking — asked of the *rate*, not of the person.
//
// Exact integer money (§29.1). Pure and deterministic: the clock is injected, no I/O.

export type ScrapCategory =
  | 'cardboard'
  | 'plastic'
  | 'metal'
  | 'e_waste'
  | 'used_oil'
  | 'damaged_stock'
  | 'expired_stock'
  | 'other';

export type ScrapDisposal = 'sold' | 'recycled' | 'donated' | 'destroyed';

export interface ScrapSale {
  readonly scrapId: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly category: ScrapCategory;
  readonly disposal: ScrapDisposal;
  readonly at: string;
  /** Weight in grams. Integer — scrap is weighed, and 12.5 kg is 12,500. */
  readonly grams: number;
  readonly proceedsMinor: number;
  readonly buyerName?: string;
  /** Weighbridge slip, receipt, photograph, authorised-recycler certificate. */
  readonly evidenceRefs?: readonly string[];
  readonly handledBy: string;
  /** Set once finance has taken it up (M23). */
  readonly postedToFinance?: boolean;
  /** For e-waste and used oil, the authorised recycler's registration. */
  readonly recyclerRegistration?: string;
}

export type ScrapFlag =
  | 'no_evidence'
  | 'no_buyer_named'
  | 'not_posted_to_finance'
  | 'rate_below_average'
  | 'sold_with_no_proceeds'
  | 'unauthorised_recycler';

export interface ScrapFinding {
  readonly scrapId: string;
  readonly category: ScrapCategory;
  readonly flag: ScrapFlag;
  readonly proceedsMinor: number;
  readonly detail: string;
}

export interface ScrapReview {
  readonly branchId: string;
  readonly from: string;
  readonly to: string;
  readonly sales: number;
  readonly totalProceedsMinor: number;
  readonly totalGrams: number;
  /** Proceeds finance has not taken up — off-books cash until it does. */
  readonly unpostedMinor: number;
  readonly findings: readonly ScrapFinding[];
  /** Average rate per tonne by category, so drift has something to drift from. */
  readonly ratesPerTonneMinor: Readonly<Record<string, number>>;
  readonly detail: string;
}

/** Categories where an authorised recycler is a legal requirement, not a preference. */
const REGULATED: ReadonlySet<ScrapCategory> = new Set(['e_waste', 'used_oil']);

/**
 * Review a period's scrap and recycling.
 *
 * The rate check is deliberately **against the category's own running average**, not against
 * a rate somebody typed into configuration. A shop's cardboard rate depends on the month, the
 * buyer and the market; a hard-coded expected rate would be wrong within a quarter and would
 * then be ignored. An average built from the shop's own history stays honest.
 *
 * Nothing here refuses a sale. Refusing would push the transaction out of the system, which
 * is precisely the problem this module exists to fix.
 */
export function reviewScrap(input: {
  readonly branchId: string;
  readonly sales: readonly ScrapSale[];
  readonly from: string;
  readonly to: string;
  /** How far below the category average counts as a question. Default 3,000bps (30%). */
  readonly rateToleranceBps?: number;
  /** Sales needed before an average means anything. Default 3. */
  readonly minimumForAverage?: number;
}): ScrapReview {
  const tolerance = input.rateToleranceBps ?? 3_000;
  const minimum = input.minimumForAverage ?? 3;

  const window = input.sales.filter(
    (s) => s.branchId === input.branchId && s.at >= input.from && s.at <= `${input.to}T23:59:59Z`,
  );

  // Rates from the shop's own history, category by category.
  const byCategory = new Map<ScrapCategory, ScrapSale[]>();
  for (const sale of window.filter((s) => s.disposal === 'sold' && s.grams > 0)) {
    byCategory.set(sale.category, [...(byCategory.get(sale.category) ?? []), sale]);
  }

  const ratesPerTonneMinor: Record<string, number> = {};
  for (const [category, sales] of byCategory) {
    const grams = sales.reduce((s, x) => s + x.grams, 0);
    const proceeds = sales.reduce((s, x) => s + x.proceedsMinor, 0);
    if (grams > 0) {
      ratesPerTonneMinor[category] = Number((BigInt(proceeds) * 1_000_000n) / BigInt(grams));
    }
  }

  const findings: ScrapFinding[] = [];
  const add = (sale: ScrapSale, flag: ScrapFlag, detail: string): void => {
    findings.push({ scrapId: sale.scrapId, category: sale.category, flag, proceedsMinor: sale.proceedsMinor, detail });
  };

  for (const sale of window) {
    const what = sale.category.replace(/_/g, ' ');

    if ((sale.evidenceRefs ?? []).length === 0) {
      add(sale, 'no_evidence', `${what} ${sale.disposal} for ${sale.proceedsMinor} with no slip, receipt or photograph — recorded and visible, because refusing it just puts the transaction back outside the system`);
    }
    if (sale.disposal === 'sold' && (sale.buyerName ?? '').trim() === '') {
      add(sale, 'no_buyer_named', `${what} sold to nobody in particular — a buyer with no name cannot be asked about the rate`);
    }
    if (sale.disposal === 'sold' && sale.proceedsMinor <= 0) {
      add(sale, 'sold_with_no_proceeds', `${what} recorded as sold for nothing — either it was given away, or the money did not reach the till`);
    }
    if (sale.proceedsMinor > 0 && sale.postedToFinance !== true) {
      add(sale, 'not_posted_to_finance', `${sale.proceedsMinor} of proceeds has not reached the books — until it does it is off-books cash, whatever anyone intended`);
    }
    if (REGULATED.has(sale.category) && (sale.recyclerRegistration ?? '').trim() === '') {
      add(sale, 'unauthorised_recycler', `${what} went to a handler with no recycler registration on file — for this category that is a legal requirement, not a preference`);
    }

    const peers = byCategory.get(sale.category) ?? [];
    const average = ratesPerTonneMinor[sale.category];
    if (
      sale.disposal === 'sold' &&
      sale.grams > 0 &&
      peers.length >= minimum &&
      average !== undefined &&
      average > 0
    ) {
      const rate = Number((BigInt(sale.proceedsMinor) * 1_000_000n) / BigInt(sale.grams));
      const shortfallBps = Number(((BigInt(average) - BigInt(rate)) * 10_000n) / BigInt(average));
      if (shortfallBps > tolerance) {
        add(
          sale,
          'rate_below_average',
          `${what} went at ${rate} per tonne against a ${average} average here — ${(shortfallBps / 100).toFixed(0)}% below. Ask about the RATE, not about the person`,
        );
      }
    }
  }

  const totalProceedsMinor = window.reduce((s, x) => s + x.proceedsMinor, 0);
  const unpostedMinor = window.filter((s) => s.postedToFinance !== true).reduce((s, x) => s + x.proceedsMinor, 0);

  return {
    branchId: input.branchId,
    from: input.from,
    to: input.to,
    sales: window.length,
    totalProceedsMinor,
    totalGrams: window.reduce((s, x) => s + x.grams, 0),
    unpostedMinor,
    findings: findings.sort((a, b) => b.proceedsMinor - a.proceedsMinor || a.scrapId.localeCompare(b.scrapId)),
    ratesPerTonneMinor,
    detail:
      window.length === 0
        ? 'no scrap recorded in this window — for a hypermarket that is itself worth a question, because the cardboard still left the building'
        : unpostedMinor > 0
          ? `${totalProceedsMinor} of proceeds across ${window.length} disposal(s), of which ${unpostedMinor} has NOT reached the books`
          : `${totalProceedsMinor} of proceeds across ${window.length} disposal(s), all posted`,
  };
}
