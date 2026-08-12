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

export type PromotionKind = 'percent_off' | 'amount_off' | 'buy_x_get_y' | 'member_price';

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
}

export interface BasketLine {
  readonly lineId: string;
  readonly productId: string;
  /** Per-unit price before promotions. */
  readonly unitPrice: Money;
  /** Whole units on this line (>= 1). */
  readonly qty: number;
  /** Optional group tag for mix-match / group promotions. */
  readonly group?: string;
}

export interface PromoContext {
  /** Evaluation instant (ISO-8601 UTC) — decides which promotions are effective. */
  readonly at: string;
  readonly currency: CurrencyCode;
  readonly isMember?: boolean;
  readonly coupons?: readonly string[];
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
  return multiplyByInteger(line.unitPrice, line.qty);
}

/** Lines a promotion targets: explicit products and/or a group; neither = all. */
function eligibleLines(promo: Promotion, lines: readonly BasketLine[]): BasketLine[] {
  const hasProducts = promo.productIds !== undefined && promo.productIds.length > 0;
  const hasGroup = promo.group !== undefined;
  if (!hasProducts && !hasGroup) return [...lines];
  const products = new Set(promo.productIds ?? []);
  return lines.filter(
    (l) => (hasProducts && products.has(l.productId)) || (hasGroup && l.group === promo.group),
  );
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
    case 'member_price': {
      if (!ctx.isMember || promo.memberUnitPrice === undefined) return zero(currency);
      let total = zero(currency);
      for (const l of targeted) {
        const perUnit = subtract(l.unitPrice, promo.memberUnitPrice);
        if (isPositive(perUnit)) {
          total = add(total, multiplyByInteger(perUnit, l.qty));
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

  let discount = chosen.reduce((total, c) => add(total, c.discount), zero(currency));
  if (compare(discount, grossTotal) > 0) discount = grossTotal; // never below zero

  const applied: AppliedPromotion[] = chosen
    .map((c) => ({ promotionId: c.promo.id, kind: c.promo.kind, discount: c.discount }))
    .sort((a, b) => (a.promotionId < b.promotionId ? -1 : a.promotionId > b.promotionId ? 1 : 0));

  // Attribute the discount to the LINES it actually reduced, so a per-line / per-HSN taxable value is exact
  // (CGST s.15(3)): split each chosen promotion's discount across ITS eligible lines in proportion to gross,
  // accumulating per line. A discount can never exceed a promotion's eligible spend, so each split is valid.
  // If a pathological input (an overall discount capped at the basket, or stacking that would take a line
  // below zero) breaks the accumulation, fall back to spreading the final capped discount across the whole
  // basket by gross — always exact-summing and never negative.
  const grosses = lines.map((l) => lineGross(l).minor);
  const byLine = new Map<string, number>(lines.map((l) => [l.lineId, 0]));
  for (const c of chosen) {
    const elig = eligibleLines(c.promo, lines);
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
