// Effective-dated price lists (M05-FR-01) — one price truth (P-02) resolved by
// explicit precedence: customer > channel > zone > store base. Prices are
// effective-dated, so a scheduled price activates ONLY on its effective date (a
// future price never activates early), and price entries are append-only — a change
// is a new entry, never an overwrite (§29.1), giving a complete who-changed-what
// history. Resolution is pure and input-determined, so a sale can capture the exact
// entry it referenced and stay on that version even as new prices activate later
// ("in-flight sales keep the version they referenced", §31.1). Only a published
// ('active') entry can apply — a draft or rolled-back entry never does. Composes
// only the Money primitive.

import type { Money } from '../../contracts/src/money';
import { instantOf } from '../../calendar/src/trading-day';
import { DEFAULT_SHOP_CALENDAR } from '../../calendar/src/shop-clock';

/** Price scopes, highest precedence first. */
export type PriceScope = 'customer' | 'channel' | 'zone' | 'store';
const PRECEDENCE: readonly PriceScope[] = ['customer', 'channel', 'zone', 'store'];

export type PriceEntryStatus = 'draft' | 'active' | 'rolled_back';

/** An immutable, effective-dated price entry (append-only — a change is a new one). */
export interface PriceEntry {
  readonly id: string;
  readonly productId: string;
  readonly scope: PriceScope;
  /** The id of the customer / channel / zone / store this entry is for. */
  readonly scopeRef: string;
  readonly price: Money;
  readonly effectiveFrom: string; // ISO-8601 UTC
  /** Open-ended when null/absent. */
  readonly effectiveTo?: string | null;
  readonly status: PriceEntryStatus;
  /** Monotonic version for tie-breaks and for a sale to reference. */
  readonly version: number;
  /**
   * D-20 — the ONE batch this price is for (a markdown on a batch near its use-by). It is charged only when the barcode
   * carries that batch (a GS1 2D code); it never becomes the product's own price. Absent = the product's price.
   */
  readonly batchId?: string;
}

/** The context a price is resolved against at a moment in time. */
export interface ResolveContext {
  readonly productId: string;
  readonly at: string; // ISO-8601 UTC evaluation instant
  /** R1c (M01-FR-02): the shop's zone — a date-only effective date starts at the SHOP's midnight. Default: the shop default zone. */
  readonly timeZone?: string;
  readonly storeId: string;
  readonly zoneId?: string;
  readonly channel?: string;
  readonly customerId?: string;
  /** D-20 — resolve the price of THIS batch. Absent = the product's own price; a batch's price never answers for it. */
  readonly batchId?: string;
}

function scopeValue(scope: PriceScope, ctx: ResolveContext): string | undefined {
  switch (scope) {
    case 'customer':
      return ctx.customerId;
    case 'channel':
      return ctx.channel;
    case 'zone':
      return ctx.zoneId;
    case 'store':
      return ctx.storeId;
    default:
      return undefined;
  }
}

/** Published and within its effective window at `at` — a future price is not yet live. */
/**
 * An effective date as an instant. A date alone (YYYY-MM-DD) means the start of that day on the SHOP's clock (R1c ·
 * M01-FR-02) — read as UTC midnight, a price "from today" began only at 05:30 IST. An instant is taken as written.
 */
export function effectiveInstant(value: string, timeZone: string = DEFAULT_SHOP_CALENDAR.timeZone): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(instantOf(`${value}T00:00`, timeZone)) : Date.parse(value);
}

function isEffective(entry: PriceEntry, at: string, timeZone: string = DEFAULT_SHOP_CALENDAR.timeZone): boolean {
  if (entry.status !== 'active') return false;
  const t = Date.parse(at);
  const from = effectiveInstant(entry.effectiveFrom, timeZone);
  if (Number.isNaN(t) || Number.isNaN(from)) return false;
  if (t < from) return false;
  if (entry.effectiveTo !== undefined && entry.effectiveTo !== null) {
    const to = effectiveInstant(entry.effectiveTo, timeZone);
    if (Number.isNaN(to) || t > to) return false;
  }
  return true;
}

/**
 * Resolve the effective price entry for a product in a context. Walks the
 * precedence order (customer > channel > zone > store) and returns the winning
 * entry at the highest-precedence scope that has a match; within a scope, the most
 * recently effective entry wins (ties broken by version, then id) — the explicit
 * precedence for overlapping prices. Returns null when no price applies. The
 * returned entry carries its id/version, so a caller can lock the sale to it.
 */
export function resolvePrice(
  entries: readonly PriceEntry[],
  ctx: ResolveContext,
): PriceEntry | null {
  for (const scope of PRECEDENCE) {
    const ref = scopeValue(scope, ctx);
    if (ref === undefined) continue;
    const candidates = entries.filter(
      (e) =>
        e.productId === ctx.productId &&
        e.scope === scope &&
        e.scopeRef === ref &&
        (e.batchId ?? null) === (ctx.batchId ?? null) &&
        isEffective(e, ctx.at, ctx.timeZone),
    );
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => {
      const byFrom = Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom);
      if (byFrom !== 0) return byFrom;
      if (b.version !== a.version) return b.version - a.version;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
    return candidates[0] ?? null;
  }
  return null;
}

/**
 * The full, chronological price history for a product (every entry, any status) —
 * the append-only who-changed-what record (M05-FR-01 audit). Sorted by effective
 * date, then version.
 */
export function priceHistory(entries: readonly PriceEntry[], productId: string): PriceEntry[] {
  return entries
    .filter((e) => e.productId === productId)
    .sort((a, b) => {
      const byFrom = Date.parse(a.effectiveFrom) - Date.parse(b.effectiveFrom);
      if (byFrom !== 0) return byFrom;
      return a.version - b.version;
    });
}
