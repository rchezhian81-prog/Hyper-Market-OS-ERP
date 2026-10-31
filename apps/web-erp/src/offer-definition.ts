// M05-FR-03 / M05-FR-04 (re-audit 30 Oct 2026) — the offer's RULE, as the Products and prices page's Offer tab defines it.
//
// Before this, the Offer tab worked out an offer's margin and pressed Start, and head office refused every Start of a new
// offer with `promotion_not_defined`: nothing on any screen had ever told head office what the offer IS — what it takes
// off, on which products, from when to when, whether it stacks. Only the "Bought together" page defined one, and only as
// a percent off. This module turns what a person typed on the Offer tab into EXACTLY the body head office's own definition
// route reads (`POST /v1/promotions/:promotionId/definition`, `readDefinition` in services/pricing/src/promotion-catalogue.ts):
// every kind the engine computes except the bank-card offer (built OFF until an integrated card machine, OB-305 — head
// office refuses one by name), the products or the line group it targets, the coupon it needs, members only, the
// exclusive group it competes in (no group = it stacks), the abuse cap on how many times it applies, and the minimum spend.
//
// The rules stay head office's: it reads the kind's parameters, refuses tobacco (B15) and carry bags (B19), and creates
// the offer as a DRAFT that applies to nothing until the governed launch switches it on (the margin check, and for a
// margin-losing offer a second person's own approval — ADR-0024 · §28). This module only checks what it must to build a
// body at all: a name, two readable days in order, and figures that are numbers. Money is typed in rupees and sent in
// exact paise; a percentage is sent in basis points.
//
// The days are whole SHOP days, as the owner decided for offers drafted from "Bought together" (OB-610, 29 Oct 2026):
// 00:00:00 on the first day to 23:59:59 on the last, in the shop's own zone — never UTC day edges.

import { instantOfTyped } from '../../../packages/calendar/src/shop-day';

/** The kinds this tab offers — the engine's list less `bank_offer` (OB-305: switched off; head office refuses it). */
export const OFFER_KINDS = Object.freeze([
  'percent_off', 'amount_off', 'buy_x_get_y', 'member_price', 'multibuy', 'bundle_price', 'mix_match',
] as const);
export type OfferKind = (typeof OFFER_KINDS)[number];

/** What a person typed on the Offer tab's "The offer's rule" step — text, as typed. Blank means "not given". */
export interface OfferDefinitionInput {
  readonly promotionId: string;
  readonly kind: string;
  /** First and last day the offer runs, YYYY-MM-DD, in the shop's calendar. */
  readonly startsOn: string;
  readonly endsOn: string;
  /** Item codes it applies to, separated by commas or spaces. Blank with no group = the whole basket. */
  readonly productIds?: string;
  /** Or a line group (a category tag) it applies to. */
  readonly group?: string;
  /** percent_off / mix_match: how much off, in %. */
  readonly percent?: string;
  /** amount_off: rupees off. */
  readonly amountOff?: string;
  /** buy_x_get_y / mix_match: buy this many… get this many. */
  readonly buyQty?: string;
  readonly getQty?: string;
  /** member_price: the member's price per unit, in rupees. */
  readonly memberPrice?: string;
  /** multibuy: "N for ₹X". */
  readonly multibuyQty?: string;
  readonly multibuyPrice?: string;
  /** bundle_price: "RICE x 2, DAL x 1" and the set's price in rupees. */
  readonly bundleItems?: string;
  readonly bundlePrice?: string;
  /** mix_match: the buy side and the get side — item codes or a group each. */
  readonly buyProductIds?: string;
  readonly buyGroup?: string;
  readonly getProductIds?: string;
  readonly getGroup?: string;
  /** Eligibility: a coupon code the customer must give; members only. */
  readonly coupon?: string;
  readonly memberOnly?: boolean;
  /** Stacking: offers in the same exclusive group compete (the best one for the customer wins); blank = it stacks. */
  readonly exclusiveGroup?: string;
  /** Abuse cap: the most times it applies to one bill. Blank = no cap set. */
  readonly maxApplications?: string;
  /** percent_off / amount_off: the least the eligible items must add up to, in rupees. */
  readonly minSpend?: string;
}

/** Why a definition could not be built on this screen — nothing was sent. */
export type OfferDefinitionProblem = 'needs_name' | 'needs_kind' | 'needs_days' | 'not_a_number' | 'bad_bundle_line';

export const OFFER_DEFINITION_PROBLEMS: readonly OfferDefinitionProblem[] = Object.freeze(['needs_name', 'needs_kind', 'needs_days', 'not_a_number', 'bad_bundle_line']);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const blank = (v: string | undefined): boolean => v === undefined || v.trim() === '';
const codes = (v: string | undefined): string[] => (v ?? '').split(/[\s,]+/).map((c) => c.trim()).filter((c) => c !== '');

/** A typed whole number, or `undefined` when blank; `null` when it is not one. */
function whole(v: string | undefined): number | undefined | null {
  if (blank(v)) return undefined;
  const t = v!.trim();
  return /^\d+$/.test(t) ? Number(t) : null;
}

/** Typed rupees into exact paise (never a float on the wire), `undefined` when blank, `null` when not a sum of money. */
function paise(v: string | undefined): number | undefined | null {
  if (blank(v)) return undefined;
  const t = v!.trim().replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [r, p = ''] = t.split('.');
  return Number(r) * 100 + Number(p.padEnd(2, '0'));
}

/** A typed percentage into basis points (12.5 → 1250), `undefined` when blank, `null` when not a percentage. */
function basisPoints(v: string | undefined): number | undefined | null {
  if (blank(v)) return undefined;
  const t = v!.trim().replace(/%$/, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  return Number(w) * 100 + Number(f.padEnd(2, '0'));
}

/**
 * Build EXACTLY the body of `POST /v1/promotions/:promotionId/definition` from what was typed, or say why it cannot be
 * built. Only the fields that were given are sent; head office judges the kind's parameters, the products and the window.
 */
export function offerDefinitionBody(input: OfferDefinitionInput, timeZone: string):
  | { readonly ok: true; readonly promotionId: string; readonly body: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly problem: OfferDefinitionProblem } {
  const promotionId = input.promotionId.trim();
  if (promotionId === '') return { ok: false, problem: 'needs_name' };
  if (!(OFFER_KINDS as readonly string[]).includes(input.kind)) return { ok: false, problem: 'needs_kind' };
  const kind = input.kind as OfferKind;
  const startsOn = input.startsOn.trim();
  const endsOn = input.endsOn.trim();
  if (!DAY.test(startsOn) || !DAY.test(endsOn) || endsOn < startsOn) return { ok: false, problem: 'needs_days' };
  // OB-610: whole shop days in the shop's zone.
  const startsAt = instantOfTyped(`${startsOn}T00:00`, timeZone);
  const endsAt = instantOfTyped(`${endsOn}T23:59:59`, timeZone);
  if (startsAt === '' || endsAt === '') return { ok: false, problem: 'needs_days' };

  const figures = {
    percentBps: basisPoints(input.percent), amountOffMinor: paise(input.amountOff),
    buyQty: whole(input.buyQty), getQty: whole(input.getQty), memberMinor: paise(input.memberPrice),
    multibuyQty: whole(input.multibuyQty), multibuyPriceMinor: paise(input.multibuyPrice), bundlePriceMinor: paise(input.bundlePrice),
    maxApplications: whole(input.maxApplications), minSpendMinor: paise(input.minSpend),
  };
  if (Object.values(figures).some((f) => f === null)) return { ok: false, problem: 'not_a_number' };

  const body: Record<string, unknown> = { kind, startsAt, endsAt };
  const products = codes(input.productIds);
  if (products.length > 0) body['productIds'] = products;
  if (!blank(input.group)) body['group'] = input.group!.trim();

  // The kind's own parameters — only that kind's, so a figure left in another kind's box is never sent.
  if (kind === 'percent_off' && figures.percentBps !== undefined) body['percentBps'] = figures.percentBps;
  if (kind === 'amount_off' && figures.amountOffMinor !== undefined) body['amountOffMinor'] = figures.amountOffMinor;
  if (kind === 'buy_x_get_y' || kind === 'mix_match') {
    if (figures.buyQty !== undefined) body['buyQty'] = figures.buyQty;
    if (figures.getQty !== undefined) body['getQty'] = figures.getQty;
  }
  if (kind === 'member_price' && figures.memberMinor !== undefined) body['memberUnitPrice'] = { minor: figures.memberMinor, currency: 'INR' };
  if (kind === 'multibuy') {
    if (figures.multibuyQty !== undefined) body['multibuyQty'] = figures.multibuyQty;
    if (figures.multibuyPriceMinor !== undefined) body['multibuyPriceMinor'] = figures.multibuyPriceMinor;
  }
  if (kind === 'bundle_price') {
    const lines = (input.bundleItems ?? '').split(',').map((l) => l.trim()).filter((l) => l !== '');
    const items: { productId: string; qty: number }[] = [];
    for (const line of lines) {
      const m = /^(\S+)\s*[x×*]\s*(\d+)$/i.exec(line);
      if (m === null) return { ok: false, problem: 'bad_bundle_line' };
      items.push({ productId: m[1]!, qty: Number(m[2]) });
    }
    if (items.length > 0) body['bundleItems'] = items;
    if (figures.bundlePriceMinor !== undefined) body['bundlePriceMinor'] = figures.bundlePriceMinor;
  }
  if (kind === 'mix_match') {
    const buy = codes(input.buyProductIds);
    const get = codes(input.getProductIds);
    if (buy.length > 0) body['buyProductIds'] = buy;
    if (!blank(input.buyGroup)) body['buyGroup'] = input.buyGroup!.trim();
    if (get.length > 0) body['getProductIds'] = get;
    if (!blank(input.getGroup)) body['getGroup'] = input.getGroup!.trim();
    if (figures.percentBps !== undefined) body['getPercentBps'] = figures.percentBps;
  }

  // Eligibility, stacking and the abuse cap — the same for every kind.
  if (!blank(input.coupon)) body['requiresCoupon'] = input.coupon!.trim();
  if (input.memberOnly === true) body['requiresMember'] = true;
  if (!blank(input.exclusiveGroup)) body['exclusiveGroup'] = input.exclusiveGroup!.trim();
  if (figures.maxApplications !== undefined) body['maxApplications'] = figures.maxApplications;
  if ((kind === 'percent_off' || kind === 'amount_off') && figures.minSpendMinor !== undefined) body['minSpendMinor'] = figures.minSpendMinor;

  return { ok: true, promotionId, body };
}
