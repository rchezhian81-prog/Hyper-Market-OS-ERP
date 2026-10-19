// D-23 (R4, signed OB-227) — bought-together analysis over banked baskets. Pure and deterministic: baskets in, pairs out.
//
// The signed sentence: "From banked sales for a period and department, the system lists product pairs bought together
// more often than chance, each with its basket count, support, confidence and lift. Pairs seen in fewer than the minimum
// number of baskets are not shown. Returns are taken out of the baskets they came from. Suggestions (place side by side,
// bundle, promotion) are drafts; a promotion made from one goes through the existing promotion approval."
//
//   • A BASKET is one banked bill. What came back against it is taken OUT first: a line whose whole quantity was returned
//     is no longer in the basket, so a pair that only "happened" because both items came back is not a pair.
//   • SUPPORT(A,B) = baskets with both ÷ all baskets. CONFIDENCE(A→B) = baskets with both ÷ baskets with A.
//     LIFT = support(A,B) ÷ (support(A) × support(B)) — above 1 means bought together more often than chance.
//   • Only pairs with lift above 1 AND seen in at least `minBaskets` baskets are listed. The minimum is the person's
//     input — never a number this engine picks.
//   • Every figure is computed from whole counts; the ratios are rounded to 4 places for reading, the counts are exact.
//   • A SUGGESTION is a draft and nothing else. This engine writes nothing and has no way to.

export interface BasketLine {
  readonly productId: string;
  readonly quantityMinor: number;
}

export interface Basket {
  /** The bill's own id (the sale id). */
  readonly basketId: string;
  readonly lines: readonly BasketLine[];
}

/** What came back against one bill — taken out of that bill's basket before anything is counted. */
export interface BasketReturn {
  readonly basketId: string;
  readonly lines: readonly BasketLine[];
}

export type AffinitySuggestionKind = 'place_side_by_side' | 'bundle' | 'promotion';

export interface AffinitySuggestion {
  readonly kind: AffinitySuggestionKind;
  /** Always true: a suggestion is never acted on by this engine (or by anything it returns). */
  readonly draft: true;
  readonly detail: string;
}

export interface AffinityPair {
  readonly productA: string;
  readonly productB: string;
  /** Baskets holding both products (after returns). */
  readonly basketCount: number;
  readonly basketsWithA: number;
  readonly basketsWithB: number;
  readonly support: number;
  /** Confidence that a basket with A also holds B, and the other way round. */
  readonly confidenceAtoB: number;
  readonly confidenceBtoA: number;
  readonly lift: number;
  readonly suggestions: readonly AffinitySuggestion[];
}

export interface AffinityResult {
  /** Baskets counted (a bill emptied entirely by returns is not counted). */
  readonly basketCount: number;
  /** Bills whose every line came back — not counted, and said. */
  readonly emptiedByReturns: number;
  readonly minBaskets: number;
  readonly pairs: readonly AffinityPair[];
  /** Pairs above chance that were seen in too few baskets to show — counted, never listed. */
  readonly belowMinimum: number;
}

export class InvalidAffinityInputError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidAffinityInputError'; }
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** The basket as it stands after its returns: per product, what was bought less what came back; nothing left → gone. */
export function netBasket(basket: Basket, returns: readonly BasketReturn[]): ReadonlySet<string> {
  const held = new Map<string, number>();
  for (const l of basket.lines) held.set(l.productId, (held.get(l.productId) ?? 0) + l.quantityMinor);
  for (const r of returns) {
    if (r.basketId !== basket.basketId) continue;
    for (const l of r.lines) if (held.has(l.productId)) held.set(l.productId, (held.get(l.productId) ?? 0) - l.quantityMinor);
  }
  return new Set([...held].filter(([, q]) => q > 0).map(([p]) => p));
}

/**
 * List the product pairs bought together more often than chance. `minBaskets` is the person's minimum: a pair seen in
 * fewer baskets is not shown (counted in `belowMinimum`). Throws on a minimum that is not a whole number of at least 1.
 */
export function basketAffinity(input: {
  readonly baskets: readonly Basket[];
  readonly returns?: readonly BasketReturn[];
  readonly minBaskets: number;
}): AffinityResult {
  if (!Number.isInteger(input.minBaskets) || input.minBaskets < 1) {
    throw new InvalidAffinityInputError('the minimum number of baskets must be a whole number of at least 1');
  }
  const returns = input.returns ?? [];
  const byBasket = new Map<string, BasketReturn[]>();
  for (const r of returns) byBasket.set(r.basketId, [...(byBasket.get(r.basketId) ?? []), r]);

  const sets: ReadonlySet<string>[] = [];
  let emptied = 0;
  for (const b of input.baskets) {
    const s = netBasket(b, byBasket.get(b.basketId) ?? []);
    if (s.size === 0) { if (b.lines.length > 0) emptied += 1; continue; }
    sets.push(s);
  }
  const n = sets.length;
  const single = new Map<string, number>();
  const both = new Map<string, number>();
  for (const s of sets) {
    const items = [...s].sort();
    for (const p of items) single.set(p, (single.get(p) ?? 0) + 1);
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const k = `${items[i]}\u001f${items[j]}`;
        both.set(k, (both.get(k) ?? 0) + 1);
      }
    }
  }
  const pairs: AffinityPair[] = [];
  let belowMinimum = 0;
  for (const [k, ab] of both) {
    const [a, b] = k.split('\u001f') as [string, string];
    const na = single.get(a) ?? 0;
    const nb = single.get(b) ?? 0;
    // lift = (ab/n) / ((na/n)(nb/n)) = ab·n / (na·nb) — whole numbers until the one division.
    const lift = (ab * n) / (na * nb);
    if (!(lift > 1)) continue;
    if (ab < input.minBaskets) { belowMinimum += 1; continue; }
    pairs.push({
      productA: a, productB: b, basketCount: ab, basketsWithA: na, basketsWithB: nb,
      support: round4(ab / n), confidenceAtoB: round4(ab / na), confidenceBtoA: round4(ab / nb), lift: round4(lift),
      suggestions: [
        { kind: 'place_side_by_side', draft: true, detail: `Place ${a} and ${b} side by side — a draft for a person to decide.` },
        { kind: 'bundle', draft: true, detail: `Bundle ${a} with ${b} — a draft for a person to decide.` },
        { kind: 'promotion', draft: true, detail: `A promotion on ${a} with ${b} — a draft; it goes through the promotion approval before it applies.` },
      ],
    });
  }
  pairs.sort((x, y) => y.lift - x.lift || y.basketCount - x.basketCount || x.productA.localeCompare(y.productA) || x.productB.localeCompare(y.productB));
  return { basketCount: n, emptiedByReturns: emptied, minBaskets: input.minBaskets, pairs, belowMinimum };
}
