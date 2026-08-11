// Single-use-plastic & carry-bag gate at the till (roadmap v2.1 B19 / M28·M12). India's Plastic Waste
// Management Rules put three hard rules on what leaves the store in a bag, enforced at the point of sale
// rather than left to the cashier's memory:
//
//   • **No banned single-use plastic.** A SKU on the CPCB banned-SUP list (from 1 Jul 2022 — plastic
//     cutlery, straws, stirrers, ear-bud sticks, thin PVC banners, and the rest) cannot be sold at all.
//   • **Carry bags at or above the minimum thickness.** A *plastic* carry bag must be at least 120 µm
//     thick (the threshold since 31 Dec 2022); a thinner one — or one whose thickness the master data
//     cannot even prove — is refused. Cloth, paper and certified-compostable bags are not subject to the
//     micron rule.
//   • **A carry bag is a separate priced line.** A bag must be billed as its own line for a price — it is
//     never bundled in free (free plastic-bag distribution is prohibited), so a carry-bag line at zero
//     price is refused.
//
// Like the age/tobacco gate, this names every failing line at once and commits nothing — the lines and
// their plastic attributes come from the offline price pack, so it works with the internet down (hard
// rule #1). The minimum thickness is configuration, so a rule change is data, never a code change.

export type PlasticBlockReason =
  | 'banned_single_use_plastic'
  | 'carry_bag_below_min_thickness'
  | 'carry_bag_not_priced';

export interface PlasticLine {
  readonly lineId: string;
  readonly productId: string;
  /** The line's unit price in minor units (paisa). A carry bag must be priced above zero. */
  readonly unitPriceMinor: number;
  /** From the product master: this SKU is a carry bag. */
  readonly isCarryBag?: boolean;
  /** The bag/item material. Only `plastic` is subject to the minimum-thickness rule. */
  readonly material?: 'plastic' | 'cloth' | 'paper' | 'compostable' | string;
  /** The plastic thickness in microns, where the master data records it. */
  readonly plasticThicknessMicrons?: number;
  /** From the product master: this SKU is on the banned single-use-plastic list. */
  readonly bannedSingleUsePlastic?: boolean;
}

export interface PlasticBlock {
  readonly lineId: string;
  readonly productId: string;
  readonly reason: PlasticBlockReason;
  readonly detail: string;
}

export interface PlasticSaleResult {
  readonly allowed: boolean;
  readonly blocks: readonly PlasticBlock[];
}

const DEFAULT_MIN_CARRY_BAG_MICRONS = 120;

/**
 * Decide whether a basket may complete under the single-use-plastic rules (B19). Every line is checked
 * against the banned list; every carry-bag line against the plastic-thickness minimum (plastic only) and
 * the separate-priced-line rule. The whole list of blocks is returned at once; `allowed` is true only
 * when there are none.
 */
export function checkSingleUsePlastic(input: {
  readonly lines: readonly PlasticLine[];
  readonly minCarryBagMicrons?: number;
}): PlasticSaleResult {
  const minMicrons = input.minCarryBagMicrons ?? DEFAULT_MIN_CARRY_BAG_MICRONS;
  const blocks: PlasticBlock[] = [];

  for (const line of input.lines) {
    // A banned single-use-plastic SKU cannot be sold at all — nothing else about the line matters.
    if (line.bannedSingleUsePlastic === true) {
      blocks.push({ lineId: line.lineId, productId: line.productId, reason: 'banned_single_use_plastic', detail: `${line.productId} is a banned single-use plastic (CPCB list) — it cannot be sold` });
      continue;
    }

    if (line.isCarryBag !== true) continue;

    // The 120 µm rule applies to plastic bags only. Treat a bag with a thickness but no stated material as
    // plastic (only plastic is measured in microns); cloth / paper / compostable are exempt.
    const isPlastic = line.material === 'plastic' || (line.material === undefined && line.plasticThicknessMicrons !== undefined);
    if (isPlastic) {
      if (line.plasticThicknessMicrons === undefined) {
        blocks.push({ lineId: line.lineId, productId: line.productId, reason: 'carry_bag_below_min_thickness', detail: `${line.productId} is a plastic carry bag with no recorded thickness — it cannot be proved to meet the ${minMicrons} µm minimum, so it cannot be sold` });
      } else if (line.plasticThicknessMicrons < minMicrons) {
        blocks.push({ lineId: line.lineId, productId: line.productId, reason: 'carry_bag_below_min_thickness', detail: `${line.productId} is a ${line.plasticThicknessMicrons} µm plastic carry bag, below the ${minMicrons} µm minimum — it cannot be sold` });
      }
    }

    // Every carry bag, whatever the material, must be billed as its own priced line — never free.
    if (!(line.unitPriceMinor > 0)) {
      blocks.push({ lineId: line.lineId, productId: line.productId, reason: 'carry_bag_not_priced', detail: `${line.productId} is a carry bag — it must be billed as a separate priced line, not given free` });
    }
  }

  return { allowed: blocks.length === 0, blocks };
}
