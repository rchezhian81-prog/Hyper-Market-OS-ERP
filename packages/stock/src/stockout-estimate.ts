// WHAT THE EMPTY SHELVES COST — the stockout estimate worked out from head office's own records (M08-FR-04 "stockouts" ·
// batch 20b · S4 · P-08). `stockoutImpact` (metrics.ts) estimates the margin a shelf lost when the CALLER says how many days
// it was empty, how many it normally sells and what each one earns. This works those three figures out from what head office
// already holds, and keeps every gap honest:
//
//   • DAYS EMPTY — a shop day counts as empty when the stock record showed none (zero or less) at the start of that day AND
//     nothing of the item was sold that day. A day before the item's first stock movement at that place is not counted at all
//     (the place did not carry it yet).
//   • NORMAL SALES A DAY — the units sold over the period ÷ the days it was NOT empty. If it was empty every day, its normal
//     sales are NOT KNOWN — never guessed.
//   • MARGIN EACH — the item's gross margin over the period (sales before GST less cost of goods, as head office works it out
//     for the GMROI figure) ÷ the units sold over the period. When head office cannot state the margin (a GST rate not held,
//     nothing sold) it is NOT KNOWN; when it was zero or less the item earned nothing on a sale, so nothing is claimed lost.
//
// It is an ESTIMATE of a sale that never happened, always labelled as one and never mixed into actual figures. Pure and
// exact: quantities in the item's smallest steps (OB-31: grams for kg), money in paise, one rounding at the end.

import { ratioBp } from './metrics';

/** One movement as this needs it: when, where, which way, how much. */
export interface DatedStockChange {
  readonly productId: string;
  readonly locationId: string;
  /** The shop date it happened on (YYYY-MM-DD, the shop's own clock). */
  readonly shopDate: string;
  /** +1 adds to on-hand, −1 takes from it. */
  readonly effect: 1 | -1;
  readonly quantityMinor: number;
  /** True for a till sale (the units sold). */
  readonly isSale: boolean;
}

/** What the record says about one item at one place over the period. */
export interface ShelfDays {
  readonly productId: string;
  readonly locationId: string;
  /** Days in the period the place carried the item (from its first stock movement there). */
  readonly daysCarried: number;
  readonly daysEmpty: number;
  /** Units sold over the period (smallest steps). */
  readonly unitsSoldMinor: number;
  /** On hand now (end of the record). */
  readonly onHandNowMinor: number;
}

const nextDay = (d: string): string => {
  const t = new Date(`${d}T00:00:00.000Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
};

/** Every shop date from `from` to `to`, both included. */
export function shopDatesBetween(from: string, to: string): readonly string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = nextDay(d)) out.push(d);
  return out;
}

/**
 * Walk each item-at-a-place day by day over [from, to] and count the empty days and the units sold. `changes` may hold the
 * whole history (what came before `from` makes the opening stock). Only places `covers` allows are read.
 */
export function shelfDaysOf(changes: readonly DatedStockChange[], from: string, to: string, covers: (locationId: string) => boolean = () => true): readonly ShelfDays[] {
  const days = shopDatesBetween(from, to);
  const byKey = new Map<string, DatedStockChange[]>();
  for (const c of changes) {
    if (!covers(c.locationId)) continue;
    const key = `${c.productId}\u001f${c.locationId}`;
    const list = byKey.get(key) ?? [];
    list.push(c);
    byKey.set(key, list);
  }
  const out: ShelfDays[] = [];
  for (const [key, list] of [...byKey].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const [productId, locationId] = key.split('\u001f') as [string, string];
    const first = list.reduce((m, c) => (c.shopDate < m ? c.shopDate : m), list[0]!.shopDate);
    // On hand at the start of each day = everything up to the day before; sales on each day.
    const netByDay = new Map<string, number>();
    const soldByDay = new Map<string, number>();
    let before = 0;
    for (const c of list) {
      const q = c.effect * c.quantityMinor;
      if (c.shopDate < from) before += q;
      else netByDay.set(c.shopDate, (netByDay.get(c.shopDate) ?? 0) + q);
      if (c.isSale && c.shopDate >= from && c.shopDate <= to) soldByDay.set(c.shopDate, (soldByDay.get(c.shopDate) ?? 0) + c.quantityMinor);
    }
    let opening = before;
    let daysCarried = 0; let daysEmpty = 0; let unitsSold = 0;
    for (const d of days) {
      if (d >= first) {
        daysCarried += 1;
        const sold = soldByDay.get(d) ?? 0;
        unitsSold += sold;
        if (opening <= 0 && sold === 0) daysEmpty += 1;
      }
      opening += netByDay.get(d) ?? 0;
    }
    // Movements after `to` are not in the period; on hand now is the whole record.
    const onHandNow = list.reduce((s, c) => s + c.effect * c.quantityMinor, 0);
    if (daysCarried > 0) out.push({ productId, locationId, daysCarried, daysEmpty, unitsSoldMinor: unitsSold, onHandNowMinor: onHandNow });
  }
  return out;
}

/** Why a figure could not be worked out — said in words on the screen, never shown as a number. */
export type StockoutUnknown = 'empty_every_day' | 'margin_not_held' | 'nothing_sold_anywhere';

export interface StockoutEstimateRow {
  readonly productId: string;
  readonly locationId: string;
  readonly daysCarried: number;
  readonly daysEmpty: number;
  /** Share of the carried days it was empty, in basis points. */
  readonly emptyBp: number;
  readonly onHandNowMinor: number;
  /** Units it normally sells a day when on the shelf (smallest steps, rounded), or null when not known. */
  readonly normalDailyMinor: number | null;
  /** Units the empty days are estimated to have lost, or null when not known. */
  readonly lostUnitsMinor: number | null;
  /** The margin those units would have earned (paise), or null when not known. */
  readonly lostMarginMinor: number | null;
  /** Why a figure is null. */
  readonly notKnownBecause: StockoutUnknown | null;
}

export interface StockoutEstimate {
  readonly rows: readonly StockoutEstimateRow[];
  /** The sum of the rows whose lost margin is known (paise). */
  readonly knownLostMarginMinor: number;
  /** How many rows could not be worked out — said beside the total, never summed as zero. */
  readonly notKnownCount: number;
}

/**
 * The estimate. `marginOf(productId)` is the item's gross margin over the period (paise) and the units sold over the period
 * across the places read — or undefined when head office cannot state the margin. Rows with no empty day, and rows whose
 * estimate is nothing (it never sold while on the shelf, or earned nothing), are left out: they cost nothing.
 */
export function estimateStockout(shelves: readonly ShelfDays[], marginOf: (productId: string) => { readonly grossMarginMinor: number; readonly unitsSoldMinor: number } | undefined): StockoutEstimate {
  const rows: StockoutEstimateRow[] = [];
  for (const s of shelves) {
    if (s.daysEmpty === 0) continue;
    const share = ratioBp(s.daysEmpty, s.daysCarried, 'carried no day');
    const base = { productId: s.productId, locationId: s.locationId, daysCarried: s.daysCarried, daysEmpty: s.daysEmpty, emptyBp: share.kind === 'ratio' ? share.bp : 0, onHandNowMinor: s.onHandNowMinor };
    const daysOnShelf = s.daysCarried - s.daysEmpty;
    if (daysOnShelf === 0) { rows.push({ ...base, normalDailyMinor: null, lostUnitsMinor: null, lostMarginMinor: null, notKnownBecause: 'empty_every_day' }); continue; }
    if (s.unitsSoldMinor === 0) continue; // it did not sell while on the shelf: the empty days lost nothing by this estimate
    // lost units = days empty × (units sold ÷ days on the shelf), rounded once (half up).
    const lostUnits = Number((BigInt(s.daysEmpty) * BigInt(s.unitsSoldMinor) * 2n + BigInt(daysOnShelf)) / (2n * BigInt(daysOnShelf)));
    const normalDaily = Number((BigInt(s.unitsSoldMinor) * 2n + BigInt(daysOnShelf)) / (2n * BigInt(daysOnShelf)));
    const m = marginOf(s.productId);
    if (m === undefined) { rows.push({ ...base, normalDailyMinor: normalDaily, lostUnitsMinor: lostUnits, lostMarginMinor: null, notKnownBecause: 'margin_not_held' }); continue; }
    if (m.unitsSoldMinor <= 0) { rows.push({ ...base, normalDailyMinor: normalDaily, lostUnitsMinor: lostUnits, lostMarginMinor: null, notKnownBecause: 'nothing_sold_anywhere' }); continue; }
    if (m.grossMarginMinor <= 0 || lostUnits === 0) continue; // it earned nothing on a sale: nothing is claimed lost
    // lost margin = lost units × (gross margin ÷ units sold), rounded once (half up) — never a per-gram margin rounded first.
    const lostMargin = Number((BigInt(lostUnits) * BigInt(m.grossMarginMinor) * 2n + BigInt(m.unitsSoldMinor)) / (2n * BigInt(m.unitsSoldMinor)));
    rows.push({ ...base, normalDailyMinor: normalDaily, lostUnitsMinor: lostUnits, lostMarginMinor: lostMargin, notKnownBecause: null });
  }
  rows.sort((a, b) => (b.lostMarginMinor ?? -1) - (a.lostMarginMinor ?? -1) || b.daysEmpty - a.daysEmpty || (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0) || (a.locationId < b.locationId ? -1 : 1));
  return {
    rows,
    knownLostMarginMinor: rows.reduce((s, r) => s + (r.lostMarginMinor ?? 0), 0),
    notKnownCount: rows.filter((r) => r.lostMarginMinor === null).length,
  };
}
