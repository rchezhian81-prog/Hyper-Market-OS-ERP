// Restricted-sale gate at the till (roadmap v2.1 B14 / COTPA 2003 s.6 & s.7 / M12). Two hard rules the
// law puts on tobacco, enforced at the point of sale rather than left to the cashier's memory:
//
//   • **Age-18 gate.** An age-restricted line cannot be sold until the customer's age is confirmed at or
//     above the store's minimum (18 by default, OB-03). No confirmation, or a confirmed age below the
//     minimum, blocks the line — hard, not a warning.
//   • **No loose single-stick.** A tobacco line below one whole pack is refused (COTPA s.7 prohibits the
//     sale of individual cigarettes), so `quantityMinor` under the product's `minSaleQuantityMinor` is a
//     block.
//
// The gate names every failing line at once (a cashier fixes the basket once, not one refusal at a time),
// and each block carries a customer-neutral reason a person can act on. Pure and deterministic: the lines
// and the age confirmation go in, the verdict comes out — the till commits nothing until it is allowed.

export type RestrictionKind = 'tobacco' | 'liquor' | 'other_age_restricted';

export interface RestrictedLine {
  readonly lineId: string;
  readonly productId: string;
  /** Integer minor units — 1000 is one whole unit/pack. */
  readonly quantityMinor: number;
  readonly uom: string;
  /** From the product master: whether this item is age-restricted at all. */
  readonly ageRestricted?: boolean;
  readonly restrictionKind?: RestrictionKind;
  /** The smallest quantity that may be sold (one pack), in minor units. Below it is a loose single stick. */
  readonly minSaleQuantityMinor?: number;
}

export interface AgeVerification {
  /** True once the cashier has confirmed the customer's age at the till. */
  readonly verified: boolean;
  /** The confirmed age in whole years, where an ID gave one. */
  readonly ageYears?: number;
  readonly method?: string;
}

export type RestrictedBlockReason = 'age_not_verified' | 'underage' | 'below_pack_minimum';

export interface RestrictedBlock {
  readonly lineId: string;
  readonly productId: string;
  readonly reason: RestrictedBlockReason;
  readonly detail: string;
}

export interface RestrictedSaleResult {
  readonly allowed: boolean;
  readonly blocks: readonly RestrictedBlock[];
}

const DEFAULT_MIN_AGE = 18;

/**
 * Decide whether a basket may complete under the restricted-goods rules. Every age-restricted line is
 * checked against the age confirmation, and every tobacco line against the pack minimum; the whole list of
 * blocks is returned at once. `allowed` is true only when there are none.
 */
export function checkRestrictedSale(input: {
  readonly lines: readonly RestrictedLine[];
  readonly ageVerification?: AgeVerification;
  readonly minimumAge?: number;
}): RestrictedSaleResult {
  const minAge = input.minimumAge ?? DEFAULT_MIN_AGE;
  const av = input.ageVerification;
  const blocks: RestrictedBlock[] = [];

  for (const line of input.lines) {
    if (line.ageRestricted !== true) continue;

    if (av === undefined || av.verified !== true) {
      blocks.push({ lineId: line.lineId, productId: line.productId, reason: 'age_not_verified', detail: `${line.productId} is age-restricted — confirm the customer is ${minAge} or over before selling it` });
    } else if (av.ageYears !== undefined && av.ageYears < minAge) {
      blocks.push({ lineId: line.lineId, productId: line.productId, reason: 'underage', detail: `the customer is ${av.ageYears}, below the minimum age of ${minAge} for ${line.productId}` });
    }

    if (line.restrictionKind === 'tobacco' && line.minSaleQuantityMinor !== undefined && line.quantityMinor < line.minSaleQuantityMinor) {
      blocks.push({ lineId: line.lineId, productId: line.productId, reason: 'below_pack_minimum', detail: `${line.productId}: a below-pack quantity is a loose single cigarette — prohibited by COTPA s.7; sell whole packs only` });
    }
  }

  return { allowed: blocks.length === 0, blocks };
}
