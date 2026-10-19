// D-22 (R4, signed OB-227) — personal offers drafted from a member's OWN purchase history. Pure and deterministic.
//
// The signed sentence: "From a consenting adult member's own purchase history, the system drafts personal offers. A
// person approves each batch before any is issued. A member without both profiling and marketing consent gets none
// ("no consent"); a member under 18 or with no age confirmed gets none ("child or age unknown"). No member gets more than
// your cap of 2 offers in 7 days (OB-42). An offer never takes a price below cost or above MRP. No AI issues or commits an
// offer."
//
// The rule here is a plain one a person can check by hand: the member's most-bought product over the look-back (by the
// number of bills it was on, then the quantity, then the product code) gets an offer at the discount the PERSON drafting
// the batch chose. Then the floors:
//   • the offer price is the shelf price less the discount, and is never below the product's cost ("below cost") — a cost
//     the books do not know is "cost not known", never treated as zero;
//   • it is never above the MRP — an MRP not on file is "MRP not known", never assumed.
// Each member left out is listed with the reason, never silently dropped (P-08). This engine DRAFTS; it issues nothing.

/** OB-42: no member gets more than this many offers in this many days. */
export const OFFER_CAP = { offers: 2, days: 7 } as const;

export type OfferExclusion =
  | 'no_consent'
  | 'child_or_age_unknown'
  | 'cap_reached'
  | 'no_purchase_history'
  | 'price_not_known'
  | 'cost_not_known'
  | 'mrp_not_known'
  | 'below_cost'
  | 'above_mrp';

export const OFFER_EXCLUSION_WORDS: Readonly<Record<OfferExclusion, string>> = {
  no_consent: 'no consent',
  child_or_age_unknown: 'child or age unknown',
  cap_reached: 'cap reached (2 offers in 7 days)',
  no_purchase_history: 'no purchase history in the look-back',
  price_not_known: 'shelf price not known',
  cost_not_known: 'cost not known',
  mrp_not_known: 'MRP not known',
  below_cost: 'below cost',
  above_mrp: 'above MRP',
};

export interface OfferMember {
  readonly customerRef: string;
  readonly profilingConsent: boolean;
  readonly marketingConsent: boolean;
  /** 'adult' only when a person has confirmed the member is 18 or over; anything else gets no offer. */
  readonly age: 'adult' | 'child' | 'unknown';
}

export interface MemberPurchaseLine {
  readonly customerRef: string;
  readonly saleId: string;
  readonly productId: string;
  readonly quantityMinor: number;
  /** The trading day (YYYY-MM-DD). */
  readonly day: string;
}

export interface OfferPricing {
  readonly priceMinor?: number;
  readonly mrpMinor?: number;
  readonly costMinor?: number;
}

export interface DraftedOffer {
  readonly customerRef: string;
  readonly productId: string;
  readonly shelfPriceMinor: number;
  readonly offerPriceMinor: number;
  readonly discountMinor: number;
  readonly discountBps: number;
  readonly costMinor: number;
  readonly mrpMinor: number;
  /** Why this product: the member's own history, in words. */
  readonly basis: string;
}

export interface ExcludedMember {
  readonly customerRef: string;
  readonly reason: OfferExclusion;
  readonly words: string;
}

export interface OfferDraftResult {
  readonly offers: readonly DraftedOffer[];
  readonly excluded: readonly ExcludedMember[];
}

export class InvalidOfferDraftError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidOfferDraftError'; }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayIdx = (d: string): number => Math.floor(Date.parse(`${d}T00:00:00.000Z`) / 86_400_000);

/** How many offers this member was issued in the cap window ending on `asOfDay` (inclusive). */
export function offersInCapWindow(issuedDays: readonly string[], asOfDay: string): number {
  const to = dayIdx(asOfDay);
  return issuedDays.filter((d) => DAY.test(d) && dayIdx(d) <= to && dayIdx(d) > to - OFFER_CAP.days).length;
}

/** The gate every offer passes, at drafting AND again at issue: consent, an adult, and the cap. */
export function offerGate(member: OfferMember, issuedDays: readonly string[], asOfDay: string): OfferExclusion | undefined {
  if (!member.profilingConsent || !member.marketingConsent) return 'no_consent';
  if (member.age !== 'adult') return 'child_or_age_unknown';
  if (offersInCapWindow(issuedDays, asOfDay) >= OFFER_CAP.offers) return 'cap_reached';
  return undefined;
}

/** The offer price at a discount, with both floors. Returns the price or the reason it cannot be offered. */
export function priceTheOffer(pricing: OfferPricing, discountBps: number): { readonly ok: true; readonly offerPriceMinor: number; readonly discountMinor: number } | { readonly ok: false; readonly reason: OfferExclusion } {
  if (pricing.priceMinor === undefined) return { ok: false, reason: 'price_not_known' };
  if (pricing.costMinor === undefined) return { ok: false, reason: 'cost_not_known' };
  if (pricing.mrpMinor === undefined) return { ok: false, reason: 'mrp_not_known' };
  const discountMinor = Math.floor((pricing.priceMinor * discountBps) / 10_000);
  const offerPriceMinor = pricing.priceMinor - discountMinor;
  if (offerPriceMinor > pricing.mrpMinor) return { ok: false, reason: 'above_mrp' };
  if (offerPriceMinor < pricing.costMinor) return { ok: false, reason: 'below_cost' };
  return { ok: true, offerPriceMinor, discountMinor };
}

/**
 * Draft one personal offer per eligible member from their own purchase lines in [fromDay, asOfDay]. `discountBps` is the
 * person's choice for the batch (1–9999). `issuedDays` gives, per member, the days they were already issued an offer.
 */
export function draftPersonalOffers(input: {
  readonly members: readonly OfferMember[];
  readonly purchases: readonly MemberPurchaseLine[];
  readonly pricing: (productId: string) => OfferPricing;
  readonly issuedDays: (customerRef: string) => readonly string[];
  readonly discountBps: number;
  readonly fromDay: string;
  readonly asOfDay: string;
}): OfferDraftResult {
  if (!Number.isInteger(input.discountBps) || input.discountBps < 1 || input.discountBps > 9_999) {
    throw new InvalidOfferDraftError('the discount must be a whole number of basis points from 1 to 9999 (1% = 100)');
  }
  if (!DAY.test(input.fromDay) || !DAY.test(input.asOfDay) || input.fromDay > input.asOfDay) {
    throw new InvalidOfferDraftError('the look-back needs from and as-of days (YYYY-MM-DD), from on or before as-of');
  }
  const offers: DraftedOffer[] = [];
  const excluded: ExcludedMember[] = [];
  const out = (customerRef: string, reason: OfferExclusion) => { excluded.push({ customerRef, reason, words: OFFER_EXCLUSION_WORDS[reason] }); };
  for (const m of [...input.members].sort((a, b) => a.customerRef.localeCompare(b.customerRef))) {
    const gate = offerGate(m, input.issuedDays(m.customerRef), input.asOfDay);
    if (gate !== undefined) { out(m.customerRef, gate); continue; }
    const mine = input.purchases.filter((p) => p.customerRef === m.customerRef && p.day >= input.fromDay && p.day <= input.asOfDay && p.quantityMinor > 0);
    if (mine.length === 0) { out(m.customerRef, 'no_purchase_history'); continue; }
    const byProduct = new Map<string, { bills: Set<string>; qty: number }>();
    for (const p of mine) {
      const row = byProduct.get(p.productId) ?? { bills: new Set<string>(), qty: 0 };
      row.bills.add(p.saleId); row.qty += p.quantityMinor;
      byProduct.set(p.productId, row);
    }
    const [productId, row] = [...byProduct].sort((a, b) => b[1].bills.size - a[1].bills.size || b[1].qty - a[1].qty || a[0].localeCompare(b[0]))[0]!;
    const pricing = input.pricing(productId);
    const priced = priceTheOffer(pricing, input.discountBps);
    if (!priced.ok) { out(m.customerRef, priced.reason); continue; }
    offers.push({
      customerRef: m.customerRef, productId,
      shelfPriceMinor: pricing.priceMinor!, offerPriceMinor: priced.offerPriceMinor, discountMinor: priced.discountMinor, discountBps: input.discountBps,
      costMinor: pricing.costMinor!, mrpMinor: pricing.mrpMinor!,
      basis: `bought on ${row.bills.size} bill(s) between ${input.fromDay} and ${input.asOfDay} — the member's most-bought product`,
    });
  }
  return { offers, excluded };
}
