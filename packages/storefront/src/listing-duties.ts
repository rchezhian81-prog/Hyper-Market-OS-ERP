// What the online store must show before payment, and whose goods it may sell (R4 · B23 · A26 · OB-211 · OB-223).
//
// Consumer Protection (E-Commerce) Rules 2020, Rule 5, as the owner signed it (OB-227): every product in the online store
// shows, BEFORE PAYMENT, its MRP, its selling price with tax included, the delivery fee and the total, the best-before or
// expiry date where the product carries one, the country of origin, the shop's legal name, address and GSTIN, the return
// and refund terms, and the grievance officer's name and contact. A product missing any of these is NOT published online
// ("online listing incomplete: <field>") — it still sells in the shop, because none of this touches the till.
//
// A26 · OB-211: the online store sells the shop's OWN goods only. Another seller's item — a concession tenant's included —
// is refused online by name ("other seller's goods: not sold online"), so no TCS under CGST s.52 arises; the GST page says
// "TCS (section 52): not applicable: own goods only".
//
// OB-223: the grievance officer is not named yet. Until the owner names one, every listing reads "not set" for it and none
// can be published — said, never filled in with a placeholder.
//
// The complaint clock (Rule 4(5)): an online complaint is acknowledged within 48 hours, and one not resolved within one
// month reaches the owner as an exception.
//
// Pure and deterministic: no clock (the caller passes `now`), no I/O.

/** The shop's own details every online listing carries — set by the owner, versioned, append-only. */
export interface OnlineShopDetails {
  readonly version: number;
  readonly legalName?: string;
  readonly address?: string;
  readonly gstin?: string;
  /** The return and refund terms, in words the customer reads before paying. */
  readonly returnTerms?: string;
  /** OB-223: PENDING — absent until the owner names the officer. */
  readonly grievanceOfficerName?: string;
  /** A phone number or e-mail the customer can reach the officer on. */
  readonly grievanceOfficerContact?: string;
  readonly setBy: string;
  readonly setAt: string;
}

/** The facts one product brings to its online listing — read from the published catalogue, master and ledgers. */
export interface OnlineListingFacts {
  readonly productId: string;
  readonly name: string;
  readonly mrpMinor?: number;
  /** The published shelf price — tax-inclusive, the same figure the till charges. */
  readonly sellingPriceMinor?: number;
  /** The GST rate the price carries (basis points), from the product's tax class. Absent = not known. */
  readonly taxRateBps?: number;
  /** The product carries a best-before / expiry date (it is batch-tracked, or food or medicine). */
  readonly carriesDate: boolean;
  /** The earliest best-before / expiry of the stock on hand (YYYY-MM-DD), where known. */
  readonly bestBefore?: string;
  readonly countryOfOrigin?: string;
  /** Whose goods these are: the shop's own, or another seller's (a concession tenant, a consignor). */
  readonly seller: { readonly own: true } | { readonly own: false; readonly sellerId: string };
}

/** The shop-level fact the delivery fee comes from — the serviceability policy in force. */
export interface OnlineDeliveryTerms {
  /** The delivery fee in force (0 is a fee the owner set to nothing). Absent = not set. */
  readonly deliveryFeeMinor?: number;
  readonly freeDeliveryAboveMinor?: number;
}

/** The fields, in the words of the listing refusal. */
export const LISTING_FIELDS = Object.freeze([
  'MRP', 'selling price with tax', 'delivery fee', 'best-before date', 'country of origin',
  'shop legal name', 'shop address', 'shop GSTIN', 'return and refund terms', 'grievance officer name', 'grievance officer contact',
] as const);
export type ListingField = (typeof LISTING_FIELDS)[number];

/** Shown, word for word, wherever a duty has no value yet. */
export const NOT_SET = 'not set';

export const OTHER_SELLER_REFUSAL = "other seller's goods: not sold online";
export const TCS_LINE = 'TCS (section 52): not applicable: own goods only';

const blank = (s: string | undefined): boolean => s === undefined || s.trim() === '';
const GSTIN = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$/;

/** Which of the shop's own details are not set (in LISTING_FIELDS words). A wrong-shaped GSTIN is not set. */
export function shopDetailsMissing(d: OnlineShopDetails | undefined): ListingField[] {
  const out: ListingField[] = [];
  if (blank(d?.legalName)) out.push('shop legal name');
  if (blank(d?.address)) out.push('shop address');
  if (blank(d?.gstin) || !GSTIN.test(d!.gstin!.trim())) out.push('shop GSTIN');
  if (blank(d?.returnTerms)) out.push('return and refund terms');
  if (blank(d?.grievanceOfficerName)) out.push('grievance officer name');
  if (blank(d?.grievanceOfficerContact)) out.push('grievance officer contact');
  return out;
}

/** The selling price split into the tax inside it — the same inclusive split the till prints (A9). */
export function taxInside(priceMinor: number, rateBps: number): { readonly netMinor: number; readonly taxMinor: number } {
  const netMinor = Math.round((priceMinor * 10_000) / (10_000 + rateBps));
  return { netMinor, taxMinor: priceMinor - netMinor };
}

export type ListingVerdict =
  | { readonly publishable: true; readonly missing: readonly []; readonly detail: string }
  | { readonly publishable: false; readonly refusal: string; readonly missing: readonly ListingField[]; readonly otherSeller?: string; readonly detail: string };

/** May this product be published to the online store? Another seller's goods first; then every missing duty, named. */
export function checkOnlineListing(facts: OnlineListingFacts, shop: OnlineShopDetails | undefined, delivery: OnlineDeliveryTerms): ListingVerdict {
  if (!facts.seller.own) {
    return { publishable: false, refusal: OTHER_SELLER_REFUSAL, missing: [], otherSeller: facts.seller.sellerId, detail: `${facts.name} belongs to ${facts.seller.sellerId}; the online store sells the shop's own goods only (OB-211)` };
  }
  const missing: ListingField[] = [];
  if (facts.mrpMinor === undefined || !Number.isInteger(facts.mrpMinor) || facts.mrpMinor <= 0) missing.push('MRP');
  if (facts.sellingPriceMinor === undefined || facts.taxRateBps === undefined || !Number.isInteger(facts.sellingPriceMinor) || facts.sellingPriceMinor <= 0) missing.push('selling price with tax');
  if (delivery.deliveryFeeMinor === undefined || !Number.isInteger(delivery.deliveryFeeMinor) || delivery.deliveryFeeMinor < 0) missing.push('delivery fee');
  if (facts.carriesDate && (facts.bestBefore === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(facts.bestBefore))) missing.push('best-before date');
  if (blank(facts.countryOfOrigin)) missing.push('country of origin');
  missing.push(...shopDetailsMissing(shop));
  if (missing.length === 0) return { publishable: true, missing: [], detail: `${facts.name} carries every detail the online store must show before payment` };
  return { publishable: false, refusal: `online listing incomplete: ${missing[0]}`, missing, detail: `${facts.name} cannot be published online until ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} set; it still sells in the shop` };
}

/** One duty as the customer reads it: its words, and the value or "not set". */
export interface ListingLine { readonly field: ListingField; readonly value: string }

const inr = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;

/**
 * What the customer reads before paying, every duty in order — each one's value or "not set" (never a blank or a zero).
 * `quantityMinor` is how many the basket holds (1 on a product page); the total is goods + delivery fee.
 */
export function listingLines(facts: OnlineListingFacts, shop: OnlineShopDetails | undefined, delivery: OnlineDeliveryTerms, quantityMinor = 1): {
  readonly lines: readonly ListingLine[];
  readonly goodsMinor?: number;
  readonly deliveryFeeMinor?: number;
  readonly totalMinor?: number;
} {
  const v = (s: string | undefined): string => (blank(s) ? NOT_SET : s!.trim());
  const goodsMinor = facts.sellingPriceMinor === undefined ? undefined : facts.sellingPriceMinor * quantityMinor;
  const fee = delivery.deliveryFeeMinor === undefined || goodsMinor === undefined ? undefined
    : delivery.freeDeliveryAboveMinor !== undefined && goodsMinor >= delivery.freeDeliveryAboveMinor ? 0 : delivery.deliveryFeeMinor;
  const tax = facts.sellingPriceMinor === undefined || facts.taxRateBps === undefined ? undefined : taxInside(facts.sellingPriceMinor, facts.taxRateBps);
  const lines: ListingLine[] = [
    { field: 'MRP', value: facts.mrpMinor === undefined ? NOT_SET : `${inr(facts.mrpMinor)} (inclusive of all taxes)` },
    { field: 'selling price with tax', value: facts.sellingPriceMinor === undefined || tax === undefined ? NOT_SET : `${inr(facts.sellingPriceMinor)} including ${inr(tax.taxMinor)} GST at ${(facts.taxRateBps! / 100).toFixed(2).replace(/\.00$/, '')}%` },
    { field: 'delivery fee', value: delivery.deliveryFeeMinor === undefined ? NOT_SET : fee === 0 ? 'free' : inr(fee ?? delivery.deliveryFeeMinor) },
    { field: 'best-before date', value: !facts.carriesDate ? 'does not carry one' : v(facts.bestBefore) },
    { field: 'country of origin', value: v(facts.countryOfOrigin) },
    { field: 'shop legal name', value: v(shop?.legalName) },
    { field: 'shop address', value: v(shop?.address) },
    { field: 'shop GSTIN', value: v(shop?.gstin) },
    { field: 'return and refund terms', value: v(shop?.returnTerms) },
    { field: 'grievance officer name', value: v(shop?.grievanceOfficerName) },
    { field: 'grievance officer contact', value: v(shop?.grievanceOfficerContact) },
  ];
  return {
    lines,
    ...(goodsMinor === undefined ? {} : { goodsMinor }),
    ...(fee === undefined ? {} : { deliveryFeeMinor: fee }),
    ...(goodsMinor === undefined || fee === undefined ? {} : { totalMinor: goodsMinor + fee }),
  };
}

/** Whether the online store as a whole may be published — every shop detail set (the grievance officer included). */
export function onlineStorePublishable(shop: OnlineShopDetails | undefined): { readonly publishable: boolean; readonly missing: readonly ListingField[]; readonly refusal?: string } {
  const missing = shopDetailsMissing(shop);
  return missing.length === 0 ? { publishable: true, missing } : { publishable: false, missing, refusal: `online listing incomplete: ${missing[0]}` };
}

// ── The complaint clock (48 hours to acknowledge, one month to resolve) ─────────────────────────────────────────────

export const ACK_WITHIN_HOURS = 48;

export type ComplaintClockState = 'awaiting_acknowledgement' | 'acknowledgement_overdue' | 'acknowledged' | 'redress_overdue' | 'resolved';

export interface ComplaintClock {
  readonly caseId: string;
  readonly state: ComplaintClockState;
  readonly acknowledgeBy: string;
  readonly resolveBy: string;
  readonly acknowledgedAt?: string;
  readonly resolvedAt?: string;
  /** True when this complaint is an exception for the owner: unresolved past one month. */
  readonly ownerException: boolean;
  readonly detail: string;
}

/** One calendar month after an instant (the same day of the next month, clamped to its last day). */
export function oneMonthAfter(iso: string): string {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), last);
  return new Date(Date.UTC(y, m, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds())).toISOString();
}

/** Where an online complaint stands on its clock — from its opening, its first reply a person sent, and its resolution. */
export function complaintClock(input: { readonly caseId: string; readonly openedAt: string; readonly acknowledgedAt?: string; readonly resolvedAt?: string; readonly now: string }): ComplaintClock {
  const acknowledgeBy = new Date(Date.parse(input.openedAt) + ACK_WITHIN_HOURS * 3_600_000).toISOString();
  const resolveBy = oneMonthAfter(input.openedAt);
  const base = { caseId: input.caseId, acknowledgeBy, resolveBy, ...(input.acknowledgedAt === undefined ? {} : { acknowledgedAt: input.acknowledgedAt }), ...(input.resolvedAt === undefined ? {} : { resolvedAt: input.resolvedAt }) };
  if (input.resolvedAt !== undefined) return { ...base, state: 'resolved', ownerException: false, detail: `resolved ${input.resolvedAt}${input.resolvedAt > resolveBy ? ' — later than one month' : ''}` };
  if (input.now > resolveBy) return { ...base, state: 'redress_overdue', ownerException: true, detail: `not resolved within one month (by ${resolveBy}) — an exception for the owner` };
  if (input.acknowledgedAt !== undefined) return { ...base, state: 'acknowledged', ownerException: false, detail: `acknowledged ${input.acknowledgedAt}; resolve by ${resolveBy}` };
  if (input.now > acknowledgeBy) return { ...base, state: 'acknowledgement_overdue', ownerException: false, detail: `not acknowledged within 48 hours (by ${acknowledgeBy})` };
  return { ...base, state: 'awaiting_acknowledgement', ownerException: false, detail: `acknowledge by ${acknowledgeBy}` };
}
