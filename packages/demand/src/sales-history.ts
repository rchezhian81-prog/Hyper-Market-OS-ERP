// Sales-history demand read (M09 — the demand foundation for replenishment D-3, and for the
// forecast D-1 and the markdown ladder D-4 that will build on it).
//
// **The store already keeps its sales.** Every sale is a `SaleCommitted` event whose payload is
// the whole bill, lines and all (hard rule #2 — the events ARE the record, never edited). What was
// missing was not the storage but the READ: turning those banked lines into "how much of each
// product sells, per day" — the demand rate every reorder decision needs.
//
// So this is a pure projection, not a write path: it never touches the sale-commit path (hard rule
// #1) and stores nothing new. Given the sold lines the caller has gathered over a window, it folds
// them into per-product daily quantities and an **average daily demand** — the exact `avgDailyDemand`
// the replenishment engine consumes. Deterministic: no clock, no I/O.

/** One sold line reduced to its demand facts: which product, how much, on which trading day. */
export interface SoldLine {
  readonly productId: string;
  /** The quantity sold, in the line's own minor unit — eaches for a counted good, grams for a weighed one. */
  readonly quantityMinor: number;
  /** The trading day the sale was booked to (YYYY-MM-DD) — a shop trading past midnight books to the open day. */
  readonly tradingDay: string;
}

/** How much of one product sold, and how fast, across the observed window. */
export interface ProductDemand {
  readonly productId: string;
  /** Total quantity sold across the window, in the line's minor unit. */
  readonly totalQtyMinor: number;
  /** Distinct trading days on which this product sold at least once (≤ windowDays). */
  readonly sellingDays: number;
  /** Quantity per trading day, ascending by day. Days with no sale are omitted (their demand is zero). */
  readonly byDay: readonly { readonly day: string; readonly qtyMinor: number }[];
  /**
   * Σ quantity ÷ **window days** (not selling days), rounded to a whole unit — the demand RATE, counting
   * days with no sale as zero. This is what "how much will sell in the next N days" needs, and it is the
   * `avgDailyDemand` the replenishment / shelf-life engine consumes. `totalQtyMinor` and the window's
   * `windowDays` are both reported, so a consumer wanting a per-selling-day figure can recompute it.
   */
  readonly avgDailyDemandMinor: number;
}

export interface SalesHistory {
  /** The window asked for (YYYY-MM-DD, inclusive). */
  readonly from: string;
  readonly to: string;
  /** Whole calendar days in [from, to] inclusive — the denominator for average daily demand. */
  readonly windowDays: number;
  /** One row per product that sold in the window, ascending by productId (a stable, diffable order). */
  readonly products: readonly ProductDemand[];
}

export class InvalidDemandWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDemandWindowError';
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days since the epoch for a YYYY-MM-DD at UTC midnight, or NaN if it is not a real date. */
function dayIndex(day: string): number {
  const t = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isNaN(t) ? NaN : Math.floor(t / 86_400_000);
}

/**
 * Fold sold lines into per-product demand over the window [from, to] (both YYYY-MM-DD, inclusive).
 *
 * Only lines whose `tradingDay` falls in the window are counted, so the caller may over-read the event
 * window (cheap) and let this be exact. A malformed trading day or a non-positive quantity is skipped
 * rather than crashing the read. Throws `InvalidDemandWindowError` for a malformed window or from > to.
 */
export function salesHistory(input: {
  readonly lines: readonly SoldLine[];
  readonly from: string;
  readonly to: string;
}): SalesHistory {
  if (!DAY.test(input.from) || !DAY.test(input.to)) {
    throw new InvalidDemandWindowError('from and to must be YYYY-MM-DD dates');
  }
  const fromIdx = dayIndex(input.from);
  const toIdx = dayIndex(input.to);
  if (Number.isNaN(fromIdx) || Number.isNaN(toIdx)) {
    throw new InvalidDemandWindowError('from and to must be real calendar dates');
  }
  if (toIdx < fromIdx) {
    throw new InvalidDemandWindowError('from must be on or before to');
  }
  const windowDays = toIdx - fromIdx + 1;

  // productId → (tradingDay → summed quantity)
  const byProduct = new Map<string, Map<string, number>>();
  for (const line of input.lines) {
    if (!DAY.test(line.tradingDay)) continue;
    const idx = dayIndex(line.tradingDay);
    if (Number.isNaN(idx) || idx < fromIdx || idx > toIdx) continue;
    if (!Number.isInteger(line.quantityMinor) || line.quantityMinor <= 0) continue;
    let days = byProduct.get(line.productId);
    if (days === undefined) {
      days = new Map<string, number>();
      byProduct.set(line.productId, days);
    }
    days.set(line.tradingDay, (days.get(line.tradingDay) ?? 0) + line.quantityMinor);
  }

  const products: ProductDemand[] = [...byProduct.entries()]
    .map(([productId, days]) => {
      const byDay = [...days.entries()]
        .map(([day, qtyMinor]) => ({ day, qtyMinor }))
        .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
      const totalQtyMinor = byDay.reduce((s, d) => s + d.qtyMinor, 0);
      return {
        productId,
        totalQtyMinor,
        sellingDays: byDay.length,
        byDay,
        avgDailyDemandMinor: Math.round(totalQtyMinor / windowDays),
      };
    })
    .sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));

  return { from: input.from, to: input.to, windowDays, products };
}
