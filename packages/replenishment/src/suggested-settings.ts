// REORDER FIGURES SUGGESTED FROM RECENT SALES, AND THE "IS THIS A SLIP?" CHECK — fix batch 4b · D-038 · D-039 · M09-FR-02 ·
// WF-03 · P-05 · P-07 · hard rule #5.
//
// D-038: the walkthrough found no reorder settings for any item, so the Reorder proposal stayed empty until someone typed
// "Most to hold" and "Reorder when down to" for every item, one by one. Here head office's own sales history (the store's
// banked sales, `GET /v1/inventory/sales-history`, trailing 28 days) gives a SUGGESTED pair for every item that sold:
//   • "Reorder when down to" = SUGGESTION_RULE.reorderDays days of sales (rounded up to a whole step);
//   • "Most to hold"         = SUGGESTION_RULE.holdDays days of sales (rounded up, and always above the reorder point).
// They are suggestions only: nothing is saved until a person ticks them and presses save, under their own name, and head
// office keeps every figure as a new version (append-only). Items that did not sell, or whose unit this screen was not
// told, are named and left out — never given a guessed figure.
//
// D-039: the page accepted "Most to hold" = 48200 where 48 was meant (a 1,000-times slip) and then proposed 48,112 packs.
// `bigChanges` names every figure that would move by more than JUMP_FACTOR times its current value (up or down), so the
// screen warns and asks again before saving. It is a check on typing, not a money limit — a value limit on an order is the
// owner's to set and is not invented here.
//
// Pure.

/** How many days of sales each suggested figure covers. A planning default, reversible, not a money rule. */
export const SUGGESTION_RULE = Object.freeze({ reorderDays: 7, holdDays: 14 });

/** A figure that moves by more than this many times its current value is asked about again before it is saved (D-039). */
export const JUMP_FACTOR = 5;

/** What head office's sales history says for the window (only the parts used here). */
export interface SalesWindow {
  readonly windowDays: number;
  readonly from?: string;
  readonly to?: string;
  readonly products: readonly { readonly productId: string; readonly totalQtyMinor: number }[];
}

export interface CurrentFigures {
  readonly maxLevel?: number;
  readonly reorderPoint?: number;
}

export interface SuggestedSettings {
  readonly productId: string;
  readonly uom: string;
  /** Sold per day over the window, in the item's smallest step (may be a fraction). */
  readonly perDayMinor: number;
  readonly reorderPointMinor: number;
  readonly maxLevelMinor: number;
  /** The figures in force now, when there are any — shown beside the suggestion. */
  readonly current?: CurrentFigures;
}

export type LeftOutReason = 'no_sales' | 'unit_unknown';

export interface SuggestionResult {
  readonly suggestions: readonly SuggestedSettings[];
  readonly leftOut: readonly { readonly productId: string; readonly why: LeftOutReason }[];
  readonly windowDays: number;
}

const COUNTED = new Set(['ea', 'each', 'pc', 'pcs', 'nos', 'unit']);
const isCounted = (uom: string): boolean => COUNTED.has(uom.trim().toLowerCase());

/** Round up to a whole step: a whole item for a counted good, a whole gram / millilitre for a weighed or poured one. */
const up = (minor: number): number => Math.max(1, Math.ceil(minor - 1e-9));

/**
 * Suggested "reorder when down to" and "most to hold" for every item that sold in the window. `allProductIds`, when given,
 * names the store's items that did not sell (left out as `no_sales`, to be set by hand). Ascending by item code.
 */
export function suggestedSettingsFromSales(input: {
  readonly history: SalesWindow;
  readonly uomOf: (productId: string) => string | undefined;
  readonly current?: ReadonlyMap<string, CurrentFigures>;
  readonly allProductIds?: readonly string[];
}): SuggestionResult {
  const days = input.history.windowDays;
  if (!Number.isInteger(days) || days < 1) return { suggestions: [], leftOut: [], windowDays: 0 };
  const suggestions: SuggestedSettings[] = [];
  const leftOut: { productId: string; why: LeftOutReason }[] = [];
  const sold = new Set<string>();
  for (const p of [...input.history.products].sort((a, b) => a.productId.localeCompare(b.productId))) {
    if (!(p.totalQtyMinor > 0)) continue;
    sold.add(p.productId);
    const uom = input.uomOf(p.productId);
    if (uom === undefined || uom.trim() === '') { leftOut.push({ productId: p.productId, why: 'unit_unknown' }); continue; }
    const perDay = p.totalQtyMinor / days;
    const reorderPointMinor = up(perDay * SUGGESTION_RULE.reorderDays);
    const maxLevelMinor = Math.max(up(perDay * SUGGESTION_RULE.holdDays), reorderPointMinor + 1);
    const current = input.current?.get(p.productId);
    suggestions.push({ productId: p.productId, uom, perDayMinor: perDay, reorderPointMinor, maxLevelMinor, ...(current === undefined ? {} : { current }) });
  }
  for (const id of [...new Set(input.allProductIds ?? [])].sort()) {
    if (!sold.has(id)) leftOut.push({ productId: id, why: 'no_sales' });
  }
  return { suggestions, leftOut, windowDays: days };
}

/** The figures that would move by more than JUMP_FACTOR times their current value, up or down (D-039). */
export function bigChanges(current: Readonly<Record<string, number | undefined>> | undefined, next: Readonly<Record<string, unknown>>): readonly { readonly field: string; readonly from: number; readonly to: number }[] {
  if (current === undefined) return [];
  const out: { field: string; from: number; to: number }[] = [];
  for (const [field, raw] of Object.entries(next)) {
    const from = current[field];
    if (typeof raw !== 'number' || typeof from !== 'number' || !(from > 0) || !(raw > 0)) continue;
    if (raw > from * JUMP_FACTOR || raw * JUMP_FACTOR < from) out.push({ field, from, to: raw });
  }
  return out;
}

/** Whether a counted good (whole items) — exported for the screen's wording. */
export const countedUnit = isCounted;
