// Weighted-average stock valuation (M08-FR-04 / M23 / OB — owner chose weighted-average, 9 Aug 2026).
//
// The owner's accounting policy: value stock at the WEIGHTED AVERAGE of what it cost to buy. Each
// receipt at a new cost re-averages the price of everything on hand; each issue (a sale, a wastage,
// a transfer out) leaves at that running average, and what it takes with it is the cost of goods
// sold. This is the ONE authoritative cost basis the shop values stock and measures margin against —
// FIFO or standard cost would give different numbers, and mixing methods is how two reports about
// the same shelf disagree.
//
// Why it lives with the ledger, not beside it: the average is a FOLD over the movements in order,
// exactly like on-hand (M08-FR-01). It is never a stored, editable field — a cost you can overwrite
// is a valuation nobody can audit (hard rule #2).
//
//   • A receipt WITH a unit cost re-averages: newValue = oldValue + qty×unitCost.
//   • A receipt with NO cost (a historical or uncosted movement) adds the units but not a value, and
//     the quantity is reported as UNVALUED rather than folded in at zero — a zero cost would drag the
//     average down and quietly understate every margin after it (P-08: an absent number is not zero).
//   • An issue leaves at the current average: cogs += round(value × qty / onHand); value -= that.
//   • A TRANSFER OUT (SP-5, F05) also leaves at the current average — but the value has not been SOLD, it
//     has gone to another of the shop's own locations, so it is booked as `transferredOut`, never as
//     cost of goods sold. COGS that rose every time the warehouse fed the floor would halve the margin.
//   • A TRANSFER IN that carries the SENDER's average as its cost re-averages at the destination like a
//     receipt does (`isPurchaseReceipt` with a unit cost): the value follows the stock. One without a
//     cost (the sender's stock was unvalued) re-enters at the destination's average, or is unvalued.
//   • Any other increase (a return, a positive count/adjustment) re-enters at the current average — it
//     carries no new purchase cost, so it must not change the average.
//
// Exact integer minor units throughout; the average is derived (value ÷ quantity), never rounded and
// stored, so it cannot drift. Order matters and is the caller's: movements are folded as given.
// Pure and deterministic — no clock, no I/O.

import type { Money } from '../../contracts/src/money';

/** The direction each movement kind has on quantity — mirrors the inventory ledger's own table. */
export type ValuationEffect = 1 | -1;

/** One movement to value: its product/location, direction, quantity, and (for a receipt) unit cost. */
export interface ValuationMovement {
  readonly productId: string;
  readonly locationId: string;
  readonly effect: ValuationEffect;
  /** Always positive; `effect` carries the direction. */
  readonly quantityMinor: number;
  /**
   * True for an entry that carries its OWN cost basis and re-averages: a purchase receipt, or a transfer-in valued
   * at the sending location's average (SP-5). A return or a positive count re-enters at the current average.
   */
  readonly isPurchaseReceipt: boolean;
  /** Unit cost for a cost-carrying entry, in minor units. Absent ⇒ the entry's quantity is unvalued. */
  readonly unitCostMinor?: number;
  /**
   * True for a transfer OUT to another of the shop's own locations (SP-5, F05): the issue leaves at the average like
   * any other, but its value is booked as `transferredOut`, not as cost of goods sold — nothing was sold.
   */
  readonly isTransferOut?: boolean;
  /**
   * OB-31 "A": how many `quantityMinor` steps make one whole costed unit — 1000 for a kg product (counted in grams, costed
   * per kg), 1 for an item. A receipt's value is `quantityMinor × unitCostMinor ÷ minorPerUnit`, rounded once. Absent ⇒ 1.
   */
  readonly minorPerUnit?: number;
  /** OB-46 "A": the receipt's `unitCostMinor` buys this many whole units (a case cost carried exactly). Absent ⇒ 1. */
  readonly costPerUnits?: number;
}

export interface ProductValuation {
  readonly productId: string;
  readonly locationId: string;
  /** On-hand quantity (all of it, valued or not). */
  readonly onHandMinor: number;
  /** Value of the on-hand stock at weighted-average cost. */
  readonly value: Money;
  /** Weighted-average cost per WHOLE unit (per item, per kg — OB-31), or `not_known` when nothing valued is on hand. */
  readonly unitCostMinor: number | 'not_known';
  /** Cumulative cost of goods issued (sold / wasted / written off) at the average — feeds margin. NOT transfers. */
  readonly cogs: Money;
  /** Cumulative value that left this location for ANOTHER of the shop's locations, at the average (SP-5). Not a cost. */
  readonly transferredOut: Money;
  /** On-hand quantity received WITHOUT a cost, so it is NOT in `value` — surfaced, never hidden. */
  readonly unvaluedMinor: number;
}

interface Acc {
  productId: string;
  locationId: string;
  qty: number; // on-hand
  valuedQty: number; // quantity that has a cost basis
  valueMinor: number; // value of valuedQty at WAC
  cogsMinor: number;
  transferredOutMinor: number;
  unvaluedMinor: number;
  /** OB-31: quantity steps per whole costed unit for this product (1 for items, 1000 for kg). */
  scale: number;
}

/** value × qty ÷ divisor, rounded half-up on the last minor unit — integer, so nothing drifts. */
export function share(valueMinor: number, qty: number, divisor: number): number {
  if (divisor <= 0) return 0;
  const n = BigInt(valueMinor) * BigInt(qty);
  const d = BigInt(divisor);
  const q = n / d;
  const r = n % d;
  return Number(r * 2n >= d ? q + 1n : q);
}

/**
 * Fold movements into a weighted-average valuation per product+location.
 *
 * The average is maintained over the VALUED quantity only. An issue removes value in proportion to
 * the valued quantity it draws from; if part of the on-hand is unvalued (an uncosted receipt), an
 * issue draws proportionally and the unvalued pool shrinks too, so `value ÷ valuedQty` stays the
 * honest average of what is actually costed.
 */
export function weightedAverageValuation(
  movements: readonly ValuationMovement[],
  currency: Money['currency'],
): readonly ProductValuation[] {
  const byKey = new Map<string, Acc>();
  const keyOf = (m: ValuationMovement): string => `${m.productId}\u001f${m.locationId}`;

  for (const m of movements) {
    const key = keyOf(m);
    const acc = byKey.get(key)
      ?? { productId: m.productId, locationId: m.locationId, qty: 0, valuedQty: 0, valueMinor: 0, cogsMinor: 0, transferredOutMinor: 0, unvaluedMinor: 0, scale: m.minorPerUnit ?? 1 };

    if (m.effect === 1) {
      if (m.isPurchaseReceipt && m.unitCostMinor !== undefined) {
        // OB-31: per-whole-unit cost over smallest-step quantity, rounded once (exact for items).
        acc.valueMinor += share(m.unitCostMinor, m.quantityMinor, (m.minorPerUnit ?? 1) * (m.costPerUnits ?? 1)); // OB-46: rounded once
        acc.valuedQty += m.quantityMinor;
      } else if (m.isPurchaseReceipt) {
        // A receipt with no cost: units enter, value does not. Reported as unvalued, not folded at 0.
        acc.unvaluedMinor += m.quantityMinor;
      } else {
        // A return / transfer-in / positive count carries no new purchase cost: re-enter at the
        // current average so the average is unchanged (value ÷ valuedQty constant).
        const reValue = share(acc.valueMinor, m.quantityMinor, acc.valuedQty);
        if (acc.valuedQty > 0) {
          acc.valueMinor += reValue;
          acc.valuedQty += m.quantityMinor;
        } else {
          acc.unvaluedMinor += m.quantityMinor; // no basis to value it against
        }
      }
      acc.qty += m.quantityMinor;
    } else {
      // An issue draws from valued and unvalued stock in proportion; the valued part leaves at WAC.
      const drawValued = acc.qty > 0 ? Math.min(acc.valuedQty, share(acc.valuedQty, m.quantityMinor, acc.qty)) : 0;
      const issueValue = share(acc.valueMinor, drawValued, acc.valuedQty);
      // Sold or written off → cost of goods sold. Sent to another of our own locations → value moved, not spent.
      if (m.isTransferOut === true) acc.transferredOutMinor += issueValue; else acc.cogsMinor += issueValue;
      acc.valueMinor -= issueValue;
      acc.valuedQty -= drawValued;
      acc.unvaluedMinor = Math.max(0, acc.unvaluedMinor - (m.quantityMinor - drawValued));
      acc.qty -= m.quantityMinor;
      if (acc.qty <= 0) { acc.qty = Math.max(0, acc.qty); } // guard; negatives are an M08 exception, valued at 0
      if (acc.valuedQty <= 0) { acc.valuedQty = 0; acc.valueMinor = Math.max(0, acc.valueMinor); }
    }
    byKey.set(key, acc);
  }

  return [...byKey.values()]
    .sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : a.locationId < b.locationId ? -1 : 1))
    .map((a): ProductValuation => ({
      productId: a.productId,
      locationId: a.locationId,
      onHandMinor: a.qty,
      value: { minor: a.valueMinor, currency },
      unitCostMinor: a.valuedQty > 0 ? share(a.valueMinor, a.scale, a.valuedQty) : 'not_known',
      cogs: { minor: a.cogsMinor, currency },
      transferredOut: { minor: a.transferredOutMinor, currency },
      unvaluedMinor: a.unvaluedMinor,
    }));
}
