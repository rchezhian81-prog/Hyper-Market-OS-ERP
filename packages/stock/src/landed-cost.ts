// Landed cost into stock value (M07-FR-04 acceptance "landed cost reflects freight" · D03-FR-05 · M08-FR-04 · hard rule #2).
//
// Freight, duty and other charges on a supplier's bill are part of what the goods cost. When the bill is MATCHED (and may be
// paid), the charges are apportioned — to the paisa, no remainder dropped — first across the products by the value of the
// goods paid for, then across the places each product was received at by the quantity received there. The result is posted
// as COST-ADJUSTMENT events: value only, no quantity, never an edit of a receipt. A later match that changes the charges (or
// blocks the bill) posts only the DIFFERENCE from what is already posted — a compensating event, append-only.
//
// In the weighted-average fold (valuation.ts) an adjustment raises the value of the units still on hand; the share that
// belongs to units already sold goes to cost of goods sold. Stock value + COGS move by exactly the adjustment.
//
// Pure and deterministic.

import { allocateByRatios } from '../../contracts/src/money';

export interface LandedCostTarget {
  readonly productId: string;
  readonly locationId: string;
  /** The quantity received at this place for this product (smallest steps). */
  readonly quantityMinor: number;
}

export interface LandedCostShare extends LandedCostTarget {
  /** This place's share of the charges, in paise (signed in a delta). */
  readonly valueMinor: number;
}

const keyOf = (s: { productId: string; locationId: string }): string => `${s.productId}\u001f${s.locationId}`;

/**
 * Apportion `totalMinor` of charges: across products by goods value, then across each product's receiving places by
 * quantity. A product with no receipt place keeps nothing (there is no stock to carry it); its weight is dropped from the
 * split so the whole charge still lands on stock that exists. Returns shares that sum to `totalMinor` exactly — or no shares
 * when there is nothing to carry it.
 */
export function apportionLandedCharges(
  totalMinor: number,
  goods: readonly { readonly productId: string; readonly valueMinor: number }[],
  receipts: readonly LandedCostTarget[],
): readonly LandedCostShare[] {
  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0) return [];
  const placesOf = new Map<string, LandedCostTarget[]>();
  for (const r of receipts) {
    if (r.quantityMinor <= 0) continue;
    placesOf.set(r.productId, [...(placesOf.get(r.productId) ?? []), r]);
  }
  const weighted = goods.filter((g) => g.valueMinor > 0 && placesOf.has(g.productId));
  if (weighted.length === 0) return [];
  const byProduct = allocateByRatios({ minor: totalMinor, currency: 'INR' }, weighted.map((g) => g.valueMinor));
  const out: LandedCostShare[] = [];
  weighted.forEach((g, i) => {
    const places = placesOf.get(g.productId)!;
    const parts = allocateByRatios(byProduct[i]!, places.map((p) => p.quantityMinor));
    places.forEach((p, j) => { if (parts[j]!.minor !== 0) out.push({ ...p, valueMinor: parts[j]!.minor }); });
  });
  return out;
}

/**
 * What to post so that what is posted becomes `desired`: per product and place, desired − already posted. A place posted
 * before and no longer desired gets its whole value reversed. Zero differences are dropped.
 */
export function landedCostDeltas(desired: readonly LandedCostShare[], posted: readonly LandedCostShare[]): readonly LandedCostShare[] {
  const want = new Map(desired.map((d) => [keyOf(d), d] as const));
  const have = new Map<string, LandedCostShare>();
  for (const p of posted) {
    const cur = have.get(keyOf(p));
    have.set(keyOf(p), cur === undefined ? p : { ...cur, valueMinor: cur.valueMinor + p.valueMinor });
  }
  const out: LandedCostShare[] = [];
  for (const k of [...new Set([...want.keys(), ...have.keys()])].sort()) {
    const w = want.get(k);
    const h = have.get(k);
    const delta = (w?.valueMinor ?? 0) - (h?.valueMinor ?? 0);
    if (delta === 0) continue;
    const base = w ?? h!;
    out.push({ productId: base.productId, locationId: base.locationId, quantityMinor: base.quantityMinor, valueMinor: delta });
  }
  return out;
}
