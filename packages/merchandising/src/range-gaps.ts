// Range gaps and private label (D02-FR-04 · OB-319, owner, 23 Oct 2026, in writing: "a gap report from our own facts —
// short-picks, failed substitutions and no-result searches per category and price band — plus private-label margin against
// branded").
//
// A range gap is demand the shop saw and could not serve. Three of its own facts show it, each counted where it happened:
//   • a SHORT-PICK — an online order line the picker could not fill (and no substitute was given);
//   • a FAILED SUBSTITUTION — a substitute was offered and the customer did not take it;
//   • a NO-RESULT SEARCH — a customer searched the app and found nothing (no category: it is shown on its own, by the words
//     searched, because nothing matched to file it under).
// Each line is filed under the ordered product's category and a PRICE BAND. The bands are the reader's choice, passed in as
// edges (for example ₹0–₹50–₹200–₹1,000); none passed is ONE band, "all prices", and said — no band is invented.
//
// Private label against branded: per category, the margin of the shop's own-brand products (the EPR own-brand declaration —
// one fact, one place) against the branded ones. A product sold with no known cost has its margin NOT KNOWN, named, never
// costed at zero (P-08).
//
// Pure and deterministic.

export interface GapFact {
  readonly kind: 'short_pick' | 'failed_substitution';
  readonly productId: string;
  readonly quantityMinor: number;
  /** The ordered line's unit price, in minor units — what files it in a price band. Undefined: band not known. */
  readonly unitPriceMinor: number | undefined;
}

export interface SearchMiss {
  readonly words: string;
  readonly count: number;
}

export interface PriceBand {
  readonly fromMinor: number;
  /** Exclusive; null = no top. */
  readonly toMinor: number | null;
  readonly label: string;
}

/** Bands from ascending edges in minor units: [0, 5000, 20000] → under ₹50, ₹50–₹200, ₹200 and above. */
export function priceBands(edges: readonly number[]): readonly PriceBand[] {
  const sorted = [...new Set(edges.filter((e) => Number.isSafeInteger(e) && e > 0))].sort((a, b) => a - b);
  const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  if (sorted.length === 0) return [{ fromMinor: 0, toMinor: null, label: 'all prices' }];
  const out: PriceBand[] = [{ fromMinor: 0, toMinor: sorted[0]!, label: `under ${rupees(sorted[0]!)}` }];
  for (let i = 0; i < sorted.length; i += 1) {
    const to = sorted[i + 1] ?? null;
    out.push({ fromMinor: sorted[i]!, toMinor: to, label: to === null ? `${rupees(sorted[i]!)} and above` : `${rupees(sorted[i]!)} to ${rupees(to)}` });
  }
  return out;
}

export interface GapRow {
  readonly categoryId: string | null;
  readonly band: string;
  readonly shortPicks: number;
  readonly shortPickedQuantityMinor: number;
  readonly failedSubstitutions: number;
  readonly products: readonly string[];
}

export function rangeGaps(input: {
  readonly facts: readonly GapFact[];
  readonly categoryOf: (productId: string) => string | null;
  readonly bands: readonly PriceBand[];
}): readonly GapRow[] {
  const bandOf = (price: number | undefined): string => {
    if (price === undefined) return 'price not known';
    return input.bands.find((b) => price >= b.fromMinor && (b.toMinor === null || price < b.toMinor))?.label ?? 'price not known';
  };
  const rows = new Map<string, { categoryId: string | null; band: string; shortPicks: number; qty: number; failed: number; products: Set<string> }>();
  for (const f of input.facts) {
    const categoryId = input.categoryOf(f.productId);
    const band = bandOf(f.unitPriceMinor);
    const key = `${categoryId ?? ''}\u001f${band}`;
    const r = rows.get(key) ?? { categoryId, band, shortPicks: 0, qty: 0, failed: 0, products: new Set<string>() };
    if (f.kind === 'short_pick') { r.shortPicks += 1; r.qty += Math.max(0, f.quantityMinor); } else r.failed += 1;
    r.products.add(f.productId);
    rows.set(key, r);
  }
  return [...rows.values()]
    .map((r) => ({ categoryId: r.categoryId, band: r.band, shortPicks: r.shortPicks, shortPickedQuantityMinor: r.qty, failedSubstitutions: r.failed, products: [...r.products].sort() }))
    .sort((a, b) => (b.shortPicks + b.failedSubstitutions) - (a.shortPicks + a.failedSubstitutions) || (a.categoryId ?? '').localeCompare(b.categoryId ?? '') || a.band.localeCompare(b.band));
}

export interface SoldProduct {
  readonly productId: string;
  readonly netSalesMinor: number;
  readonly costMinor: number | undefined;
}

export interface LabelMargin {
  readonly netSalesMinor: number;
  /** Null when some product's cost is not known. */
  readonly marginMinor: number | null;
  /** Margin as basis points of net sales; null when the margin is not known or nothing sold. */
  readonly marginBps: number | null;
  readonly products: number;
  readonly costNotKnownFor: readonly string[];
}

export interface PrivateLabelRow {
  readonly categoryId: string | null;
  readonly privateLabel: LabelMargin;
  readonly branded: LabelMargin;
}

function marginOf(sold: readonly SoldProduct[]): LabelMargin {
  const unknown = sold.filter((s) => s.costMinor === undefined).map((s) => s.productId).sort();
  const net = sold.reduce((s, p) => s + p.netSalesMinor, 0);
  const margin = unknown.length > 0 ? null : sold.reduce((s, p) => s + p.netSalesMinor - (p.costMinor ?? 0), 0);
  return {
    netSalesMinor: net, marginMinor: margin,
    marginBps: margin === null || net <= 0 ? null : Math.round((margin * 10_000) / net),
    products: sold.length, costNotKnownFor: unknown,
  };
}

export function privateLabelMargins(input: {
  readonly sold: readonly SoldProduct[];
  readonly categoryOf: (productId: string) => string | null;
  readonly isPrivateLabel: (productId: string) => boolean;
}): readonly PrivateLabelRow[] {
  const byCategory = new Map<string, { categoryId: string | null; own: SoldProduct[]; brand: SoldProduct[] }>();
  for (const s of input.sold) {
    const categoryId = input.categoryOf(s.productId);
    const key = categoryId ?? '';
    const r = byCategory.get(key) ?? { categoryId, own: [], brand: [] };
    (input.isPrivateLabel(s.productId) ? r.own : r.brand).push(s);
    byCategory.set(key, r);
  }
  return [...byCategory.values()]
    .sort((a, b) => (a.categoryId ?? '￿').localeCompare(b.categoryId ?? '￿'))
    .map((r) => ({ categoryId: r.categoryId, privateLabel: marginOf(r.own), branded: marginOf(r.brand) }));
}
