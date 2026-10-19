// Product ratings — stars only, buyers only (R4 · M20-FR-04 · OB-74 · OB-218).
//
//   • A signed-in customer who BOUGHT the product (a delivered or collected order of theirs carries it) rates it 1 to 5
//     whole stars. One who never bought it is refused by name ("rate only what you bought").
//   • ONE rating per customer per product: a later rating REPLACES their own in the average — and the earlier one is kept
//     in the history (append-only, hard rule #2), never overwritten.
//   • STARS ONLY (OB-218): there is no text, no title, no photo — a rating that carries words is refused, not trimmed.
//   • The product shows the average and the count, NEVER a name: the summary carries no customer reference at all.
//
// Pure and deterministic.

export interface RatingRecord {
  readonly productId: string;
  readonly customerRef: string;
  readonly stars: number;
  /** 1 for the customer's first rating of this product, 2 for the one that replaced it, … */
  readonly version: number;
  readonly at: string;
}

export const RATE_ONLY_WHAT_YOU_BOUGHT = 'rate only what you bought';

/** Fields a rating may carry. Anything else — a review, a title, a photo — is refused (OB-218). */
const ALLOWED = new Set(['stars']);

export type RatingInputCheck = { readonly ok: true; readonly stars: number } | { readonly ok: false; readonly code: 'not_whole_stars' | 'stars_only'; readonly detail: string };

export function readRatingInput(body: unknown): RatingInputCheck {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, code: 'not_whole_stars', detail: 'a rating is { stars: 1 to 5 }' };
  const extra = Object.keys(body).filter((k) => !ALLOWED.has(k));
  if (extra.length > 0) return { ok: false, code: 'stars_only', detail: `a rating is stars only — there is no place for ${extra.join(', ')} (OB-218)` };
  const stars = (body as Record<string, unknown>)['stars'];
  if (typeof stars !== 'number' || !Number.isInteger(stars) || stars < 1 || stars > 5) return { ok: false, code: 'not_whole_stars', detail: 'stars must be a whole number from 1 to 5' };
  return { ok: true, stars };
}

/** Each customer's CURRENT rating of each product — the latest version wins; the earlier ones stay in `history`. */
export function currentRatings(history: readonly RatingRecord[]): readonly RatingRecord[] {
  const latest = new Map<string, RatingRecord>();
  for (const r of history) {
    const k = `${r.productId}\u0000${r.customerRef}`;
    const held = latest.get(k);
    if (held === undefined || r.version > held.version) latest.set(k, r);
  }
  return [...latest.values()];
}

/** What a product shows: the average (one decimal) and the count — no names, no references. */
export interface RatingSummary {
  readonly productId: string;
  readonly count: number;
  /** Absent when nobody has rated it — "not rated yet", never a zero. */
  readonly average?: number;
}

export function ratingSummary(history: readonly RatingRecord[], productId: string): RatingSummary {
  const mine = currentRatings(history).filter((r) => r.productId === productId);
  if (mine.length === 0) return { productId, count: 0 };
  const total = mine.reduce((t, r) => t + r.stars, 0);
  return { productId, count: mine.length, average: Math.round((total * 10) / mine.length) / 10 };
}

export function ratingSummaries(history: readonly RatingRecord[]): readonly RatingSummary[] {
  const ids = [...new Set(history.map((r) => r.productId))].sort();
  return ids.map((id) => ratingSummary(history, id));
}

/** The next version number for this customer's rating of this product. */
export function nextRatingVersion(history: readonly RatingRecord[], productId: string, customerRef: string): number {
  return 1 + history.filter((r) => r.productId === productId && r.customerRef === customerRef).reduce((m, r) => Math.max(m, r.version), 0);
}
