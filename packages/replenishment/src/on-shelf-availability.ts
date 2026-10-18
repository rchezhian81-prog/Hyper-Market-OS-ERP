// D-14 (R3) — on-shelf availability / phantom-stock detection. OB-147 "A": per item, from its own usual selling rate,
// with the owner's minimum number of days.
//
// Signed test sentence (OB-188): "a product with on-hand > 0 and no sale for longer than its expected gap (from its own
// sales rate …) is raised as a suspected phantom. It proposes a targeted count task. A count confirming zero posts a
// compensating adjustment through the existing approval path. It never auto-adjusts stock."
//
// This file is the pure rule only: which (product, place) pairs are suspected. It reads stock and sales, and returns a
// list. It has no write port of any kind, so it cannot change stock (hard rules #2, #5) — the guardrail
// tests/guardrails/a-suspected-phantom-never-moves-stock.test.ts holds that.
//
// The rule, in full:
//   • the window is the `lookbackDays` trading days ending on `asOf` (inclusive);
//   • a product's EXPECTED GAP is its own selling rate turned into days between sales: windowDays ÷ selling days in the
//     window, rounded up (a product that sold on 7 of 28 days is expected to sell about every 4 days);
//   • the THRESHOLD is the larger of that gap and the owner's minimum days (OB-147) — the minimum stops a fast seller
//     being raised after one quiet day;
//   • it is SUSPECTED when on-hand is above zero and the days since its last sale are MORE than the threshold;
//   • a product with stock and no sale at all in the window has no selling rate to judge by: its days without a sale are
//     at least the whole window (said as "at least"), and only the owner's minimum applies — never a made-up rate;
//   • with no minimum set by the owner, nothing is judged and the state says so (P-08: never a silent empty list).

export interface OsaStockRow {
  readonly productId: string;
  readonly locationId: string;
  readonly onHandMinor: number;
}

export interface OsaSoldLine {
  readonly productId: string;
  readonly locationId: string;
  /** YYYY-MM-DD — the trading day the sale was booked to. */
  readonly tradingDay: string;
  readonly quantityMinor: number;
}

export type OsaBasis = 'own_selling_rate' | 'owner_minimum' | 'no_sale_in_window';

export interface PhantomSuspect {
  readonly productId: string;
  readonly locationId: string;
  readonly onHandMinor: number;
  /** The last trading day it sold here inside the window; null when it did not sell in the window at all. */
  readonly lastSaleDay: string | null;
  /** Whole days from the last sale to `asOf`. With no sale in the window this is the window length, a lower bound. */
  readonly daysWithoutSale: number;
  /** True when `daysWithoutSale` is "at least" (no sale in the window, so the real figure is not known). */
  readonly daysWithoutSaleIsAtLeast: boolean;
  readonly sellingDays: number;
  readonly windowDays: number;
  /** windowDays ÷ sellingDays rounded up; null when it did not sell in the window (no rate to judge by). */
  readonly expectedGapDays: number | null;
  readonly ownerMinimumDays: number;
  /** max(expectedGapDays, ownerMinimumDays). */
  readonly thresholdDays: number;
  /** Which figure set the threshold. */
  readonly basis: OsaBasis;
}

export type OsaResult =
  | { readonly state: 'minimum_not_set'; readonly detail: string; readonly windowDays: number; readonly from: string; readonly to: string }
  | {
    readonly state: 'judged';
    readonly windowDays: number; readonly from: string; readonly to: string;
    readonly ownerMinimumDays: number;
    /** How many (product, place) pairs with stock above zero were judged. */
    readonly judged: number;
    /** The suspects, longest without a sale first. */
    readonly suspects: readonly PhantomSuspect[];
  };

export class InvalidOsaInputError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidOsaInputError'; }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayNo = (d: string): number => Math.round(Date.parse(`${d}T00:00:00.000Z`) / 86_400_000);
const dayOf = (n: number): string => new Date(n * 86_400_000).toISOString().slice(0, 10);

/** The first trading day of a `lookbackDays` window ending on `asOf` (inclusive). */
export const osaWindowStart = (asOf: string, lookbackDays: number): string => dayOf(dayNo(asOf) - lookbackDays + 1);

export function findPhantomSuspects(input: {
  readonly asOf: string;
  readonly lookbackDays: number;
  /** The owner's minimum days (OB-147); undefined while the owner has not set it. */
  readonly ownerMinimumDays: number | undefined;
  readonly stock: readonly OsaStockRow[];
  readonly sales: readonly OsaSoldLine[];
}): OsaResult {
  if (!DAY.test(input.asOf) || Number.isNaN(Date.parse(input.asOf))) throw new InvalidOsaInputError(`asOf must be a YYYY-MM-DD day, not "${input.asOf}".`);
  if (!Number.isSafeInteger(input.lookbackDays) || input.lookbackDays < 1 || input.lookbackDays > 366) throw new InvalidOsaInputError('lookbackDays must be a whole number of days from 1 to 366.');
  const min = input.ownerMinimumDays;
  if (min !== undefined && (!Number.isSafeInteger(min) || min < 1)) throw new InvalidOsaInputError('The owner\'s minimum must be a whole number of days, 1 or more.');
  const to = input.asOf;
  const from = osaWindowStart(to, input.lookbackDays);
  const windowDays = input.lookbackDays;
  if (min === undefined) {
    return { state: 'minimum_not_set', windowDays, from, to, detail: 'The owner has not set the minimum number of days an item may go without a sale before it is checked (OB-147). Nothing is judged until it is set.' };
  }
  const lo = dayNo(from); const hi = dayNo(to);
  const key = (p: string, l: string): string => `${p}\u001f${l}`;
  const sold = new Map<string, Set<number>>();
  for (const s of input.sales) {
    if (!DAY.test(s.tradingDay) || s.quantityMinor <= 0) continue; // a returned or zero line is not a sale of the item
    const n = dayNo(s.tradingDay);
    if (n < lo || n > hi) continue;
    const k = key(s.productId, s.locationId);
    const days = sold.get(k) ?? new Set<number>();
    days.add(n); sold.set(k, days);
  }
  const suspects: PhantomSuspect[] = [];
  let judged = 0;
  for (const row of input.stock) {
    if (row.onHandMinor <= 0) continue;
    judged += 1;
    const days = sold.get(key(row.productId, row.locationId));
    const sellingDays = days?.size ?? 0;
    let lastSaleDay: string | null = null;
    let daysWithoutSale: number;
    let expectedGapDays: number | null = null;
    let threshold: number;
    let basis: OsaBasis;
    if (days === undefined || sellingDays === 0) {
      daysWithoutSale = windowDays;
      threshold = min;
      basis = 'no_sale_in_window';
    } else {
      const last = Math.max(...days);
      lastSaleDay = dayOf(last);
      daysWithoutSale = hi - last;
      expectedGapDays = Math.ceil(windowDays / sellingDays);
      threshold = Math.max(expectedGapDays, min);
      basis = expectedGapDays > min ? 'own_selling_rate' : 'owner_minimum';
    }
    if (daysWithoutSale > threshold) {
      suspects.push({
        productId: row.productId, locationId: row.locationId, onHandMinor: row.onHandMinor,
        lastSaleDay, daysWithoutSale, daysWithoutSaleIsAtLeast: lastSaleDay === null,
        sellingDays, windowDays, expectedGapDays, ownerMinimumDays: min, thresholdDays: threshold, basis,
      });
    }
  }
  suspects.sort((a, b) => b.daysWithoutSale - a.daysWithoutSale || (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : a.locationId < b.locationId ? -1 : 1));
  return { state: 'judged', windowDays, from, to, ownerMinimumDays: min, judged, suspects };
}
