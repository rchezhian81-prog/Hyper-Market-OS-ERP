// Promotions best-price engine (M05-FR-03) — one promotion truth (P-02) that
// yields a DETERMINISTIC best price for a basket from the approved, effective-dated
// rule set: the same basket gives the same price online and offline (M05-FR-03
// acceptance). Two §31 rules are structural here: an unpublished (not 'active') or
// expired/not-yet-started promotion NEVER applies, and evaluation is pure and
// input-determined (no clock, no I/O), so an offline lane computes exactly what the
// cloud would. Exclusivity is honoured deterministically: within an exclusive
// group only the single best-for-the-customer promotion applies; everything else
// stacks. This engine only computes discounts — approval/publishing happen upstream
// (maker-checker, M05-FR-03 permissions). Composes only the Money primitive.

import {
  add,
  subtract,
  zero,
  compare,
  scaleMoney,
  multiplyByInteger,
  isPositive,
  money,
  type Money,
  type CurrencyCode,
} from '../../contracts/src/money';
import { allocateDiscount } from '../../contracts/src/allocate';

export type PromotionKind = 'percent_off' | 'amount_off' | 'buy_x_get_y' | 'member_price'
  // OB-288 P2 (M05-FR-03 · D06-FR-03): "3 for ₹99"; a named set of items at one price (OB-306, the price-offer bundle);
  // buy from one set, get from another; and a bank-card offer — built switched OFF until an integrated card machine (OB-305).
  | 'multibuy' | 'bundle_price' | 'mix_match' | 'bank_offer';

/** Every kind the engine computes, in one list — the catalogue reads a definition against it. */
export const PROMOTION_KINDS: readonly PromotionKind[] = Object.freeze([
  'percent_off', 'amount_off', 'buy_x_get_y', 'member_price', 'multibuy', 'bundle_price', 'mix_match', 'bank_offer',
] as const);

/** One item of a price-offer bundle (`bundle_price`): the product and how many whole units of it make one set. */
export interface BundleItem {
  readonly productId: string;
  readonly qty: number;
}

/** Only an 'active' promotion can apply; 'draft'/'stopped' never do (§31). */
export type PromotionStatus = 'draft' | 'active' | 'stopped';

export interface Promotion {
  readonly id: string;
  readonly kind: PromotionKind;
  /** Effective window (ISO-8601 UTC), inclusive of both ends. */
  readonly startsAt: string;
  readonly endsAt: string;
  readonly status: PromotionStatus;
  /** Targeting — by explicit products and/or a line group tag; empty = whole basket. */
  readonly productIds?: readonly string[];
  readonly group?: string;
  /** Eligibility gates. */
  readonly requiresMember?: boolean;
  readonly requiresCoupon?: string;
  /** Exclusivity: within a group only the single best applies; absent = stacks. */
  readonly exclusiveGroup?: string;
  /** Abuse cap on how many times a repeatable promo (buy_x_get_y) applies. */
  readonly maxApplications?: number;
  /** percent_off: discount as basis points (1000 = 10%). */
  readonly percentBps?: number;
  /** amount_off: fixed discount in minor units. */
  readonly amountOffMinor?: number;
  /** percent_off / amount_off: minimum eligible spend to qualify (minor units). */
  readonly minSpendMinor?: number;
  /** buy_x_get_y: buy X … */
  readonly buyQty?: number;
  /** buy_x_get_y: … get Y cheapest free per (X+Y) block. */
  readonly getQty?: number;
  /** member_price: the special per-unit price for members. */
  readonly memberUnitPrice?: Money;
  /** multibuy: how many whole units make one deal ("3" of "3 for ₹99"). */
  readonly multibuyQty?: number;
  /** multibuy: what one deal of `multibuyQty` units costs, in minor units ("₹99" of "3 for ₹99"). */
  readonly multibuyPriceMinor?: number;
  /** bundle_price: the named items that make one set, each with how many whole units. */
  readonly bundleItems?: readonly BundleItem[];
  /** bundle_price: what one whole set costs, in minor units. */
  readonly bundlePriceMinor?: number;
  /** mix_match: the BUY side — products and/or a line group. `buyQty` units of it… */
  readonly buyProductIds?: readonly string[];
  readonly buyGroup?: string;
  /** mix_match: …earn `getQty` units of the GET side (products and/or a group) at `getPercentBps` off (10000 = free). */
  readonly getProductIds?: readonly string[];
  readonly getGroup?: string;
  readonly getPercentBps?: number;
  /**
   * bank_offer: the card issuer the offer is for, exactly as an INTEGRATED card machine reports it. OB-305: no till has one,
   * so the till never says which bank a card is from and the offer never applies (head office refuses to define one).
   */
  readonly bankIssuer?: string;
}

export interface BasketLine {
  readonly lineId: string;
  readonly productId: string;
  /** Per-unit price before promotions. */
  readonly unitPrice: Money;
  /** Whole units on this line (>= 1). */
  readonly qty: number;
  /**
   * Verifier r2final NEW-2: the line's ACTUAL gross — what it charges before any promotion (a weighed line: weight × the
   * price per kg, as the till rounds it). When given, it IS the line's gross for the cap, the minimum spend and the
   * spread, so a 333 g line at a per-kg price never counts as a whole kilo. Absent → `unitPrice` × `qty`.
   */
  readonly lineTotal?: Money;
  /** Optional group tag for mix-match / group promotions. */
  readonly group?: string;
  /**
   * OB-173 (owner, 17 Oct 2026, "Never discount bags" · B19): this line is a CARRY BAG. No promotion ever reaches it — not a
   * basket-wide offer, not a category or group offer, not one that names it — so it is always charged its full list price,
   * and no share of any discount is ever spread onto it. It does not count toward an offer's minimum spend either.
   */
  readonly carryBag?: boolean;
  /**
   * B15 (COTPA 2003 s.5): this line is a TOBACCO product. No promotion ever reaches it — tobacco may not be advertised or
   * promoted — so it is charged its full price, takes no share of any discount and counts toward no offer's minimum spend.
   */
  readonly tobacco?: boolean;
}

export interface PromoContext {
  /** Evaluation instant (ISO-8601 UTC) — decides which promotions are effective. */
  readonly at: string;
  readonly currency: CurrencyCode;
  readonly isMember?: boolean;
  readonly coupons?: readonly string[];
  /**
   * bank_offer (OB-305): the card issuer an INTEGRATED card machine reported for this payment, and whether bank offers are
   * switched on at all. Both absent at every till today (standalone bank terminals never tell the till the bank), so a
   * bank offer never applies — the engine computes it only when both are given.
   */
  readonly cardIssuer?: string;
  readonly bankOffersOn?: boolean;
}

export interface AppliedPromotion {
  readonly promotionId: string;
  readonly kind: PromotionKind;
  /** The amount saved (positive). */
  readonly discount: Money;
}

/** How much of the total discount fell on one basket line — its SHARE of the saving. */
export interface PerLineDiscount {
  readonly lineId: string;
  readonly discountMinor: number;
}

export interface PromotionResult {
  readonly grossTotal: Money;
  readonly discount: Money;
  readonly netTotal: Money;
  /** The promotions that applied, ordered by promotion id (deterministic). */
  readonly applied: readonly AppliedPromotion[];
  /**
   * The total discount attributed to each basket line (one entry per line, in input order). A targeted
   * promotion reduces only the lines it applied to, so a line's taxable value / GST can be computed
   * exactly per line (CGST s.15(3)). The shares sum to `discount` and no line's share exceeds its gross.
   */
  readonly perLine: readonly PerLineDiscount[];
}

function lineGross(line: BasketLine): Money {
  return line.lineTotal ?? multiplyByInteger(line.unitPrice, line.qty);
}

/** Whether the line's actual gross is exactly `unitPrice` × `qty` (a line sold in whole units). */
function soldInWholeUnits(line: BasketLine): boolean {
  return line.lineTotal === undefined || line.lineTotal.minor === line.unitPrice.minor * line.qty;
}

/** OB-173 · B15: the lines any promotion may reach — every line but a carry bag or a tobacco product. */
function discountable(lines: readonly BasketLine[]): BasketLine[] {
  return lines.filter((l) => l.carryBag !== true && l.tobacco !== true);
}

/** Lines matching a product list and/or a group; neither given = `whenNeither`. */
function matching(lines: readonly BasketLine[], productIds: readonly string[] | undefined, group: string | undefined, whenNeither: boolean): BasketLine[] {
  const hasProducts = productIds !== undefined && productIds.length > 0;
  const hasGroup = group !== undefined;
  if (!hasProducts && !hasGroup) return whenNeither ? [...lines] : [];
  const products = new Set(productIds ?? []);
  return lines.filter((l) => (hasProducts && products.has(l.productId)) || (hasGroup && l.group === group));
}

/** mix_match: the BUY side and the GET side. A line on both is the BUY side's — one unit is never both bought and given. */
function mixMatchSides(promo: Promotion, basket: readonly BasketLine[]): { readonly buy: BasketLine[]; readonly get: BasketLine[] } {
  const lines = discountable(basket);
  const buy = matching(lines, promo.buyProductIds, promo.buyGroup, false);
  const buyIds = new Set(buy.map((l) => l.lineId));
  const get = matching(lines, promo.getProductIds, promo.getGroup, false).filter((l) => !buyIds.has(l.lineId));
  return { buy, get };
}

/**
 * Lines a promotion targets: explicit products and/or a group; neither = all. A bundle names its items; a mix-match its
 * two sides. A carry bag or a tobacco line is never one (OB-173 · B15).
 */
function eligibleLines(promo: Promotion, basket: readonly BasketLine[]): BasketLine[] {
  const lines = discountable(basket);
  if (promo.kind === 'bundle_price') {
    const items = new Set((promo.bundleItems ?? []).map((i) => i.productId));
    return lines.filter((l) => items.has(l.productId));
  }
  if (promo.kind === 'mix_match') {
    const { buy, get } = mixMatchSides(promo, basket);
    return [...buy, ...get];
  }
  return matching(lines, promo.productIds, promo.group, true);
}

/** The lines a promotion's discount is SPREAD over: a mix-match gives its saving on the GET side; the rest on what they target. */
function attributionLines(promo: Promotion, basket: readonly BasketLine[]): BasketLine[] {
  return promo.kind === 'mix_match' ? mixMatchSides(promo, basket).get : eligibleLines(promo, basket);
}

/**
 * The basket lines a promotion reaches — its targets as the engine reads them (OB-288 P2). Head office folds a promotion's
 * units sold from banked bills with this, so the count is exactly what the till's engine would have applied the offer to.
 */
export function promotionLines(promo: Promotion, basket: readonly BasketLine[]): readonly BasketLine[] {
  return eligibleLines(promo, basket);
}

/** The products a promotion names, whichever kind it is — empty when it targets a group or the whole basket only. */
export function promotionProductIds(promo: Promotion): readonly string[] {
  const ids = [
    ...(promo.productIds ?? []), ...(promo.bundleItems ?? []).map((i) => i.productId),
    ...(promo.buyProductIds ?? []), ...(promo.getProductIds ?? []),
  ];
  return [...new Set(ids)].sort();
}

/** Each whole unit's price on these lines, one entry per unit. A line not sold in whole units (weighed) has none. */
function wholeUnitPrices(lines: readonly BasketLine[]): number[] {
  const out: number[] = [];
  for (const l of lines) {
    if (!soldInWholeUnits(l)) continue;
    for (let i = 0; i < l.qty; i += 1) out.push(l.unitPrice.minor);
  }
  return out;
}

/** Is the promotion published and within its effective window at `at`? (§31) */
function isEffective(promo: Promotion, at: string): boolean {
  if (promo.status !== 'active') return false;
  const t = Date.parse(at);
  const start = Date.parse(promo.startsAt);
  const end = Date.parse(promo.endsAt);
  if (Number.isNaN(t) || Number.isNaN(start) || Number.isNaN(end)) return false;
  return t >= start && t <= end;
}

function passesGates(promo: Promotion, ctx: PromoContext): boolean {
  if (promo.requiresMember && !ctx.isMember) return false;
  if (promo.requiresCoupon !== undefined && !(ctx.coupons ?? []).includes(promo.requiresCoupon)) {
    return false;
  }
  return true;
}

function sumGross(lines: readonly BasketLine[], currency: CurrencyCode): Money {
  return lines.reduce((total, l) => add(total, lineGross(l)), zero(currency));
}

/** The discount a single promotion yields against the original basket (>= 0). */
function discountFor(promo: Promotion, lines: readonly BasketLine[], ctx: PromoContext): Money {
  const currency = ctx.currency;
  const targeted = eligibleLines(promo, lines);
  if (targeted.length === 0) return zero(currency);

  switch (promo.kind) {
    case 'percent_off': {
      if (promo.percentBps === undefined || promo.percentBps <= 0) return zero(currency);
      const spend = sumGross(targeted, currency);
      if (promo.minSpendMinor !== undefined && spend.minor < promo.minSpendMinor) {
        return zero(currency);
      }
      return scaleMoney(spend, promo.percentBps, 10_000, 'half_up');
    }
    case 'amount_off': {
      if (promo.amountOffMinor === undefined || promo.amountOffMinor <= 0) return zero(currency);
      const spend = sumGross(targeted, currency);
      if (promo.minSpendMinor !== undefined && spend.minor < promo.minSpendMinor) {
        return zero(currency);
      }
      // Never discount more than the eligible spend (no negative prices).
      const cap = Math.min(promo.amountOffMinor, spend.minor);
      return money(cap, currency);
    }
    case 'buy_x_get_y': {
      const x = promo.buyQty ?? 0;
      const y = promo.getQty ?? 0;
      if (x <= 0 || y <= 0) return zero(currency);
      // Expand eligible units and free the CHEAPEST y per (x+y) block.
      const unitPrices: number[] = [];
      for (const l of targeted) {
        // NEW-2: a line not sold in whole units (a weighed line) is ONE unit worth what it actually charges.
        if (!soldInWholeUnits(l)) { unitPrices.push(lineGross(l).minor); continue; }
        for (let i = 0; i < l.qty; i += 1) unitPrices.push(l.unitPrice.minor);
      }
      const block = x + y;
      let blocks = Math.floor(unitPrices.length / block);
      if (promo.maxApplications !== undefined) {
        blocks = Math.min(blocks, promo.maxApplications);
      }
      if (blocks <= 0) return zero(currency);
      const freeUnits = blocks * y;
      unitPrices.sort((a, b) => a - b); // cheapest first are free
      let freed = 0;
      for (let i = 0; i < freeUnits; i += 1) freed += unitPrices[i] ?? 0;
      return money(freed, currency);
    }
    case 'multibuy': {
      // "N for ₹X": the dearest whole units form the deals first (the customer's best price), each deal saving what its N
      // units would have cost less ₹X — never a negative saving. A weighed line is not counted in units, so takes no part.
      const n = promo.multibuyQty ?? 0;
      const price = promo.multibuyPriceMinor ?? -1;
      if (n <= 0 || price < 0) return zero(currency);
      const units = wholeUnitPrices(targeted).sort((a, b) => b - a);
      let deals = Math.floor(units.length / n);
      if (promo.maxApplications !== undefined) deals = Math.min(deals, promo.maxApplications);
      let saved = 0;
      for (let d = 0; d < deals; d += 1) {
        const dealSum = units.slice(d * n, d * n + n).reduce((a, b) => a + b, 0);
        saved += Math.max(0, dealSum - price);
      }
      return money(saved, currency);
    }
    case 'bundle_price': {
      // A named set of items at one price: as many whole sets as the basket holds every item for, each from the dearest units
      // of each item first; each set saves what its items would have cost less the set price — never negative.
      const items = promo.bundleItems ?? [];
      const price = promo.bundlePriceMinor ?? -1;
      if (items.length === 0 || price < 0 || items.some((i) => !Number.isSafeInteger(i.qty) || i.qty <= 0)) return zero(currency);
      const byItem = items.map((i) => ({ qty: i.qty, units: wholeUnitPrices(targeted.filter((l) => l.productId === i.productId)).sort((a, b) => b - a) }));
      let sets = Math.min(...byItem.map((i) => Math.floor(i.units.length / i.qty)));
      if (promo.maxApplications !== undefined) sets = Math.min(sets, promo.maxApplications);
      let saved = 0;
      for (let k = 0; k < sets; k += 1) {
        const setSum = byItem.reduce((sum, i) => sum + i.units.slice(k * i.qty, k * i.qty + i.qty).reduce((a, b) => a + b, 0), 0);
        saved += Math.max(0, setSum - price);
      }
      return money(saved, currency);
    }
    case 'mix_match': {
      // Buy `buyQty` from one set, get `getQty` from another at `getPercentBps` off: the cheapest GET units are the ones given.
      const x = promo.buyQty ?? 0;
      const y = promo.getQty ?? 0;
      const bps = promo.getPercentBps ?? 0;
      if (x <= 0 || y <= 0 || bps <= 0 || bps > 10_000) return zero(currency);
      const { buy, get } = mixMatchSides(promo, lines);
      const buyUnits = wholeUnitPrices(buy);
      const getUnits = wholeUnitPrices(get).sort((a, b) => a - b);
      let blocks = Math.min(Math.floor(buyUnits.length / x), Math.floor(getUnits.length / y));
      if (promo.maxApplications !== undefined) blocks = Math.min(blocks, promo.maxApplications);
      if (blocks <= 0) return zero(currency);
      const given = getUnits.slice(0, blocks * y).reduce((a, b) => a + b, 0);
      return scaleMoney(money(given, currency), bps, 10_000, 'half_up');
    }
    case 'bank_offer': {
      // OB-305: only with bank offers switched on AND the issuer reported by an integrated card machine — neither exists today.
      if (ctx.bankOffersOn !== true || ctx.cardIssuer === undefined || promo.bankIssuer === undefined) return zero(currency);
      if (ctx.cardIssuer.trim().toLowerCase() !== promo.bankIssuer.trim().toLowerCase()) return zero(currency);
      const spend = sumGross(targeted, currency);
      if (promo.minSpendMinor !== undefined && spend.minor < promo.minSpendMinor) return zero(currency);
      if (promo.percentBps !== undefined && promo.percentBps > 0) {
        const off = scaleMoney(spend, promo.percentBps, 10_000, 'half_up');
        return promo.amountOffMinor !== undefined && promo.amountOffMinor > 0 && off.minor > promo.amountOffMinor ? money(promo.amountOffMinor, currency) : off;
      }
      if (promo.amountOffMinor !== undefined && promo.amountOffMinor > 0) return money(Math.min(promo.amountOffMinor, spend.minor), currency);
      return zero(currency);
    }
    case 'member_price': {
      if (!ctx.isMember || promo.memberUnitPrice === undefined) return zero(currency);
      let total = zero(currency);
      for (const l of targeted) {
        const perUnit = subtract(l.unitPrice, promo.memberUnitPrice);
        if (isPositive(perUnit)) {
          // NEW-2: never more off a line than the line actually charges.
          const off = multiplyByInteger(perUnit, l.qty);
          total = add(total, compare(off, lineGross(l)) > 0 ? lineGross(l) : off);
        }
      }
      return total;
    }
    default:
      return zero(currency);
  }
}

/**
 * Compute the deterministic best price for a basket. Only published, in-window,
 * eligible promotions are considered; within an exclusive group the single largest
 * discount wins (ties broken by promotion id), and all non-exclusive promotions
 * stack. The total discount is capped at the basket gross (no negative prices).
 * Pure and input-determined — identical online and offline.
 */
export function bestPrice(
  lines: readonly BasketLine[],
  promotions: readonly Promotion[],
  ctx: PromoContext,
): PromotionResult {
  const currency = ctx.currency;
  const grossTotal = sumGross(lines, currency);

  // Compute each candidate's discount against the original basket (order-free).
  const candidates = promotions
    .filter((p) => isEffective(p, ctx.at) && passesGates(p, ctx))
    .map((p) => ({ promo: p, discount: discountFor(p, lines, ctx) }))
    .filter((c) => isPositive(c.discount));

  // Resolve exclusivity: within an exclusive group keep only the single best
  // (largest discount; ties → lowest promotion id). Non-exclusive promotions stack.
  const bestByGroup = new Map<string, { promo: Promotion; discount: Money }>();
  const chosen: { promo: Promotion; discount: Money }[] = [];
  for (const c of candidates) {
    if (c.promo.exclusiveGroup === undefined) {
      chosen.push(c);
      continue;
    }
    const current = bestByGroup.get(c.promo.exclusiveGroup);
    if (
      current === undefined ||
      compare(c.discount, current.discount) > 0 ||
      (compare(c.discount, current.discount) === 0 && c.promo.id < current.promo.id)
    ) {
      bestByGroup.set(c.promo.exclusiveGroup, c);
    }
  }
  for (const c of bestByGroup.values()) chosen.push(c);

  // Never below zero — and never onto a carry bag or tobacco (OB-173 · B15): the cap is what the DISCOUNTABLE lines are worth.
  const discountableGross = sumGross(discountable(lines), currency);
  let discount = chosen.reduce((total, c) => add(total, c.discount), zero(currency));
  if (compare(discount, discountableGross) > 0) discount = discountableGross;

  const applied: AppliedPromotion[] = chosen
    .map((c) => ({ promotionId: c.promo.id, kind: c.promo.kind, discount: c.discount }))
    .sort((a, b) => (a.promotionId < b.promotionId ? -1 : a.promotionId > b.promotionId ? 1 : 0));

  // Attribute the discount to the LINES it actually reduced, so a per-line / per-HSN taxable value is exact
  // (CGST s.15(3)): split each chosen promotion's discount across ITS eligible lines in proportion to gross,
  // accumulating per line. A discount can never exceed a promotion's eligible spend, so each split is valid.
  // If a pathological input (an overall discount capped at the basket, or stacking that would take a line
  // below zero) breaks the accumulation, fall back to spreading the final capped discount across the whole
  // basket by gross — always exact-summing and never negative. A carry bag takes no share on either path (OB-173): it
  // counts as worth nothing to the spread, so it is charged in full.
  const grosses = lines.map((l) => (l.carryBag === true || l.tobacco === true ? 0 : lineGross(l).minor));
  const byLine = new Map<string, number>(lines.map((l) => [l.lineId, 0]));
  for (const c of chosen) {
    const elig = attributionLines(c.promo, lines);
    if (elig.length === 0) continue;
    const shares = allocateDiscount(elig.map((l) => lineGross(l).minor), c.discount.minor);
    elig.forEach((l, i) => byLine.set(l.lineId, (byLine.get(l.lineId) ?? 0) + shares[i]!));
  }
  const attributedTotal = [...byLine.values()].reduce((a, b) => a + b, 0);
  const withinGross = lines.every((l, i) => (byLine.get(l.lineId) ?? 0) <= grosses[i]!);
  let perLineMap: Map<string, number>;
  if (attributedTotal === discount.minor && withinGross) {
    perLineMap = byLine;
  } else {
    const shares = allocateDiscount(grosses, discount.minor);
    perLineMap = new Map(lines.map((l, i) => [l.lineId, shares[i]!]));
  }
  const perLine: PerLineDiscount[] = lines.map((l) => ({ lineId: l.lineId, discountMinor: perLineMap.get(l.lineId) ?? 0 }));

  return {
    grossTotal,
    discount,
    netTotal: subtract(grossTotal, discount),
    applied,
    perLine,
  };
}
