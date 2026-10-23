// B15 (roadmap v2.1 · COTPA 2003 s.5 and s.6 · OWNER_DECISIONS D3): tobacco may not be advertised or promoted. The
// statutory warning board (at least 60 × 30 cm) is physical — it is a go-live checklist line, not software. What the
// software must do is never PROMOTE a tobacco product itself: no offer, no bundle, no price-offer set, no campaign, no
// recommendation, no online listing and no customer-display offer may name one.
//
// This is the one rule every one of those surfaces asks, so the answer is the same everywhere: given what a promotion (or
// a campaign, a bundle, a recommendation) names and which of those the product master says are tobacco, it either passes
// or names the tobacco products and says why. There is no override — the prohibition is in the Act.
//
// Pure and deterministic: which products are tobacco is the product master's fact (`safety.tobacco`), passed in.

export type AdvertisingSurface =
  | 'promotion' | 'bundle' | 'campaign' | 'recommendation' | 'online_listing' | 'customer_display' | 'substitute';

export interface TobaccoAdvertisingRefusal {
  readonly code: 'tobacco_may_not_be_promoted';
  readonly surface: AdvertisingSurface;
  readonly tobaccoProductIds: readonly string[];
  readonly whatHappened: string;
}

const SURFACE_WORDS: Readonly<Record<AdvertisingSurface, string>> = Object.freeze({
  promotion: 'an offer',
  bundle: 'a bundle',
  campaign: 'a campaign',
  recommendation: 'a recommendation',
  online_listing: 'the online store',
  customer_display: 'the customer display',
  substitute: 'a suggested substitute',
});

/**
 * Refuse a promotion-like thing that names tobacco. `named` is every product it names; `isTobacco` the product master's
 * answer for each. Undefined when nothing named is tobacco.
 */
export function tobaccoAdvertisingRefusal(
  surface: AdvertisingSurface,
  named: readonly string[],
  isTobacco: (productId: string) => boolean,
): TobaccoAdvertisingRefusal | undefined {
  const tobacco = [...new Set(named.filter((id) => isTobacco(id)))].sort();
  if (tobacco.length === 0) return undefined;
  return {
    code: 'tobacco_may_not_be_promoted',
    surface,
    tobaccoProductIds: tobacco,
    whatHappened: `${SURFACE_WORDS[surface][0]!.toUpperCase()}${SURFACE_WORDS[surface].slice(1)} cannot name ${tobacco.length === 1 ? 'a tobacco product' : 'tobacco products'} (${tobacco.join(', ')}): tobacco may not be advertised or promoted (COTPA 2003 s.5 · B15). Tobacco is sold at its price, behind the counter, to customers aged 18 or over only.`,
  };
}
