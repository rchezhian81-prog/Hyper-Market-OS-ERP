// Customer catalogue, search, cart and lists (M20-FR-01 / M20-FR-02 / P-02 / NFR-08).
//
// The app and the till must sell **the same shop**. That is principle P-02 — one
// commerce truth — and it is broken in the same way every time: the storefront gets its
// own product list, its own prices and its own idea of what is in stock, because that
// was easier than reaching into the real one. Six weeks later the app is selling
// something the shop discontinued, at last month's price.
//
// So this module holds **no catalogue of its own**. It takes the same published product
// and price data the lane's `CatalogueCache` is built from, and applies the customer-
// facing concerns on top: search, language, and a cart. The consequences follow:
//
//   • **AN ITEM THE TILL WOULD REFUSE IS NOT SHOWN AS BUYABLE.** Recalled, discontinued
//     or unpriced items are excluded from search and, if one is already in a cart, the
//     cart says so at review rather than at the door.
//   • **STOCK IS SHOWN HONESTLY OR NOT AT ALL.** "In stock" from a figure that is two
//     hours old is a promise the shop may not keep, so availability carries its age and
//     a stale figure is labelled, never presented as live (P-08).
//   • **SEARCH TOLERATES TYPOS** (D01), because a customer who searches "aashirwad" and
//     gets nothing concludes the shop does not stock it.
//   • **RECOMMENDATIONS ARE CONSENT-SCOPED** (M16-FR-02): "customers also bought" from
//     aggregate data is fine for anyone; "because you bought X" is profiling and needs
//     consent. The two are different features and the module keeps them apart.
//
// Language is English or Tamil throughout (NFR-08) — including the reasons an item
// cannot be bought, which are exactly the strings a shop leaves untranslated.
//
// Pure and deterministic: no clock, no I/O, no network.

export type Language = 'en' | 'ta';

export type SellStatus = 'sellable' | 'out_of_stock' | 'not_sellable' | 'recalled';

export interface StorefrontProduct {
  readonly productId: string;
  readonly name: string;
  readonly nameTa?: string;
  readonly brand?: string;
  readonly categoryId: string;
  readonly unitPriceMinor: number;
  readonly uom: string;
  readonly barcodes: readonly string[];
  /** Straight from the published catalogue — never a storefront-local flag. */
  readonly status: 'active' | 'draft' | 'discontinued';
  readonly recallBlock?: boolean;
  readonly availableMinor: number;
  /** How old the availability figure is. Absent means unknown, which is not "fresh". */
  readonly availabilityAgeMinutes?: number;
  readonly ageRestricted?: boolean;
}

const WORDS: Record<Language, Record<string, string>> = {
  en: {
    out_of_stock: 'Out of stock',
    not_sellable: 'Not available at the moment',
    recalled: 'Withdrawn from sale',
    stale: 'Stock last checked',
    minutesAgo: 'minutes ago',
    ageRestricted: 'Identification required at delivery',
  },
  ta: {
    out_of_stock: 'இருப்பில் இல்லை',
    not_sellable: 'தற்போது கிடைக்கவில்லை',
    recalled: 'விற்பனையிலிருந்து விலக்கப்பட்டது',
    stale: 'இருப்பு கடைசியாக சரிபார்க்கப்பட்டது',
    minutesAgo: 'நிமிடங்களுக்கு முன்பு',
    ageRestricted: 'விநியோகத்தின் போது அடையாள அட்டை தேவை',
  },
};

export interface ProductView {
  readonly productId: string;
  readonly name: string;
  readonly unitPriceMinor: number;
  readonly uom: string;
  readonly status: SellStatus;
  readonly buyable: boolean;
  /** In the requested language, including the reason it cannot be bought. */
  readonly detail: string;
  readonly availabilityStale?: boolean;
}

/** Decide what the customer may actually buy, from the same rules the till applies. */
export function viewProduct(
  product: StorefrontProduct,
  language: Language = 'en',
  staleAfterMinutes = 30,
): ProductView {
  const w = WORDS[language];
  const name = language === 'ta' ? (product.nameTa ?? product.name) : product.name;
  const base = {
    productId: product.productId,
    name,
    unitPriceMinor: product.unitPriceMinor,
    uom: product.uom,
  };

  // Recall is checked first and beats every other state — same order as the lane.
  if (product.recallBlock === true) {
    return { ...base, status: 'recalled', buyable: false, detail: w['recalled']! };
  }
  if (product.status !== 'active') {
    return { ...base, status: 'not_sellable', buyable: false, detail: w['not_sellable']! };
  }
  if (product.availableMinor <= 0) {
    return { ...base, status: 'out_of_stock', buyable: false, detail: w['out_of_stock']! };
  }

  const age = product.availabilityAgeMinutes;
  // Unknown age is treated as stale. "We don't know how old this is" is not "fresh".
  const stale = age === undefined || age > staleAfterMinutes;
  const parts: string[] = [];
  if (stale && age !== undefined) parts.push(`${w['stale']} ${age} ${w['minutesAgo']}`);
  if (product.ageRestricted === true) parts.push(w['ageRestricted']!);

  return {
    ...base,
    status: 'sellable',
    buyable: true,
    ...(stale ? { availabilityStale: true } : {}),
    detail: parts.join(' · '),
  };
}

/** Fold accents, case and spacing so "5kg" and "5 KG" are the same word. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9஀-௿ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Edit distance, capped — we only care whether it is small. */
function withinDistance(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    if (Math.min(...current) > max) return false;
    previous = current;
  }
  return (previous[b.length] ?? max + 1) <= max;
}

export interface SearchHit {
  readonly product: ProductView;
  /** exact > prefix > fuzzy — so a typo never outranks a real match. */
  readonly match: 'barcode' | 'exact' | 'prefix' | 'fuzzy';
}

/**
 * Search the catalogue. A scanned **barcode** wins outright; then exact and prefix word
 * matches; then a **typo-tolerant** pass (D01), which is the one that decides whether a
 * customer believes the shop stocks something.
 *
 * Items the till would refuse are **excluded entirely** rather than shown greyed out — a
 * recalled item in a search result is an invitation to ask why they cannot have it.
 */
export function searchCatalogue(input: {
  readonly query: string;
  readonly products: readonly StorefrontProduct[];
  readonly language?: Language;
  readonly staleAfterMinutes?: number;
  readonly limit?: number;
}): readonly SearchHit[] {
  const language = input.language ?? 'en';
  const raw = input.query.trim();
  if (raw === '') return [];

  const sellable = input.products.filter(
    (p) => p.recallBlock !== true && p.status === 'active',
  );

  const byBarcode = sellable.find((p) => p.barcodes.includes(raw));
  if (byBarcode !== undefined) {
    return [{ product: viewProduct(byBarcode, language, input.staleAfterMinutes), match: 'barcode' }];
  }

  const q = normalise(raw);
  const terms = q.split(' ').filter((t) => t.length > 0);
  const hits: SearchHit[] = [];

  for (const p of sellable) {
    const haystack = normalise([p.name, p.nameTa ?? '', p.brand ?? ''].join(' '));
    const words = haystack.split(' ');

    if (haystack === q) {
      hits.push({ product: viewProduct(p, language, input.staleAfterMinutes), match: 'exact' });
      continue;
    }
    if (terms.every((t) => words.some((w) => w.startsWith(t)))) {
      hits.push({ product: viewProduct(p, language, input.staleAfterMinutes), match: 'prefix' });
      continue;
    }
    // The typo pass: one edit for a short word, two for a longer one.
    const fuzzy = terms.every((t) =>
      words.some((w) => withinDistance(t, w, t.length <= 4 ? 1 : 2)),
    );
    if (fuzzy) {
      hits.push({ product: viewProduct(p, language, input.staleAfterMinutes), match: 'fuzzy' });
    }
  }

  const rank: Record<SearchHit['match'], number> = { barcode: 0, exact: 1, prefix: 2, fuzzy: 3 };
  return hits
    .sort((a, b) => rank[a.match] - rank[b.match] || a.product.name.localeCompare(b.product.name))
    .slice(0, input.limit ?? 50);
}

// --- cart, lists and repeat order --------------------------------------------------

export interface CartLine {
  readonly productId: string;
  readonly quantityMinor: number;
}

export interface ReviewedLine {
  readonly productId: string;
  readonly name: string;
  readonly requestedMinor: number;
  /** What can actually be supplied — may be less, and the difference is stated. */
  readonly availableMinor: number;
  readonly unitPriceMinor: number;
  readonly lineTotalMinor: number;
  readonly status: SellStatus;
  readonly detail: string;
}

export interface CartReview {
  readonly lines: readonly ReviewedLine[];
  readonly subtotalMinor: number;
  /** Lines that cannot be supplied at all. */
  readonly unavailable: readonly ReviewedLine[];
  readonly shortfalls: readonly ReviewedLine[];
  readonly hasProblems: boolean;
  readonly detail: string;
}

/**
 * Review a cart against the live catalogue **before checkout**, not at the door.
 *
 * A customer who reaches the payment screen and is then told two items are gone has
 * already decided to buy them; telling them at review costs nothing and keeps the order.
 * Every line is priced from the same published price the till would use (P-02).
 */
export function reviewCart(input: {
  readonly lines: readonly CartLine[];
  readonly products: readonly StorefrontProduct[];
  readonly language?: Language;
  readonly staleAfterMinutes?: number;
}): CartReview {
  const language = input.language ?? 'en';
  const byId = new Map(input.products.map((p) => [p.productId, p]));

  const lines = input.lines.map((line): ReviewedLine => {
    const product = byId.get(line.productId);
    if (product === undefined) {
      return {
        productId: line.productId,
        name: line.productId,
        requestedMinor: line.quantityMinor,
        availableMinor: 0,
        unitPriceMinor: 0,
        lineTotalMinor: 0,
        status: 'not_sellable',
        detail: WORDS[language]['not_sellable']!,
      };
    }
    const view = viewProduct(product, language, input.staleAfterMinutes);
    const supplied = view.buyable ? Math.min(line.quantityMinor, product.availableMinor) : 0;
    return {
      productId: product.productId,
      name: view.name,
      requestedMinor: line.quantityMinor,
      availableMinor: supplied,
      unitPriceMinor: product.unitPriceMinor,
      lineTotalMinor: supplied * product.unitPriceMinor,
      status: view.status,
      detail:
        !view.buyable
          ? view.detail
          : supplied < line.quantityMinor
            ? `only ${supplied} of ${line.quantityMinor} available`
            : view.detail,
    };
  });

  const unavailable = lines.filter((l) => l.availableMinor === 0);
  const shortfalls = lines.filter((l) => l.availableMinor > 0 && l.availableMinor < l.requestedMinor);
  const subtotalMinor = lines.reduce((s, l) => s + l.lineTotalMinor, 0);

  return {
    lines,
    subtotalMinor,
    unavailable,
    shortfalls,
    hasProblems: unavailable.length + shortfalls.length > 0,
    detail:
      unavailable.length + shortfalls.length === 0
        ? `${lines.length} item(s), ${subtotalMinor}`
        : `${unavailable.length} item(s) unavailable and ${shortfalls.length} short — shown now rather than at the payment screen`,
  };
}

export interface SavedList {
  readonly listId: string;
  readonly customerRef: string;
  readonly name: string;
  readonly lines: readonly CartLine[];
}

export interface RepeatOrderResult {
  readonly lines: readonly CartLine[];
  readonly review: CartReview;
  /** Items from the previous order that can no longer be supplied. */
  readonly droppedProductIds: readonly string[];
  readonly detail: string;
}

/**
 * Rebuild a cart from a previous order or a saved list — the one-tap repeat that is the
 * whole reason a grocery app gets used twice.
 *
 * Items that can no longer be supplied are **dropped and named**, not silently omitted:
 * a repeat order that quietly loses the milk is the reason people stop trusting the
 * button.
 */
export function repeatOrder(input: {
  readonly previousLines: readonly CartLine[];
  readonly products: readonly StorefrontProduct[];
  readonly language?: Language;
}): RepeatOrderResult {
  const review = reviewCart({ lines: input.previousLines, products: input.products, language: input.language });
  const dropped = review.lines.filter((l) => l.availableMinor === 0);
  const lines = review.lines
    .filter((l) => l.availableMinor > 0)
    .map((l) => ({ productId: l.productId, quantityMinor: l.availableMinor }));

  return {
    lines,
    review,
    droppedProductIds: dropped.map((l) => l.productId),
    detail:
      dropped.length === 0
        ? `${lines.length} item(s) added again`
        : `${lines.length} item(s) added again; ${dropped.length} could not be: ${dropped.map((l) => l.name).join(', ')}`,
  };
}

export type RecommendationBasis = 'aggregate' | 'personal';

export interface Recommendation {
  readonly productId: string;
  readonly basis: RecommendationBasis;
  readonly reason: string;
}

/**
 * Recommend products. **The two kinds are kept apart on purpose.**
 *
 * *"Customers who bought this also bought"* is computed from aggregate behaviour and
 * identifies nobody — it is shown to anyone. *"Because you bought X last month"* is
 * profiling of a named person, needs their consent (M16-FR-02), and is **omitted with a
 * reason** rather than silently degraded, so nobody wonders why the app feels emptier
 * for some customers and quietly removes the check.
 */
export function recommend(input: {
  readonly customerRef?: string;
  readonly consents?: readonly string[];
  readonly aggregateAlsoBought: readonly { readonly productId: string; readonly count: number }[];
  readonly personalHistory?: readonly { readonly productId: string; readonly lastBoughtAt: string }[];
  readonly limit?: number;
}): { readonly recommendations: readonly Recommendation[]; readonly personalisationOmitted?: string } {
  const limit = input.limit ?? 6;
  const aggregate: Recommendation[] = [...input.aggregateAlsoBought]
    .sort((a, b) => b.count - a.count || a.productId.localeCompare(b.productId))
    .map((r) => ({
      productId: r.productId,
      basis: 'aggregate' as const,
      reason: 'Customers who bought this also bought it',
    }));

  const mayPersonalise =
    input.customerRef !== undefined && (input.consents ?? []).includes('profiling');

  if (!mayPersonalise) {
    return {
      recommendations: aggregate.slice(0, limit),
      ...(input.personalHistory === undefined || input.personalHistory.length === 0
        ? {}
        : {
            personalisationOmitted:
              'personal suggestions are switched off for this customer because they have not consented to profiling — the aggregate list is shown instead',
          }),
    };
  }

  const personal: Recommendation[] = [...(input.personalHistory ?? [])]
    .sort((a, b) => b.lastBoughtAt.localeCompare(a.lastBoughtAt))
    .map((h) => ({
      productId: h.productId,
      basis: 'personal' as const,
      reason: 'You bought this before',
    }));

  const seen = new Set<string>();
  const merged = [...personal, ...aggregate].filter((r) => {
    if (seen.has(r.productId)) return false;
    seen.add(r.productId);
    return true;
  });

  return { recommendations: merged.slice(0, limit) };
}
