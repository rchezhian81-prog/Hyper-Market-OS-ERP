// OB-288 P3 (M07-FR-04 · D03-FR-05): the landed-cost adjustments a matched bill posts into stock value, and the ONE way every
// valuation reader folds them in beside the movement ledger. An adjustment is value only — it never moves on-hand, so the
// availability, count and transfer folds (which read `InventoryMoved`) never see it — and it is append-only: a correction is
// another adjustment of the difference (packages/stock/src/landed-cost.ts).

import type { ValuationMovement } from '../../../packages/stock/src/valuation';
import type { Movement } from './index';

/** One posted cost adjustment: this product at this place costs `valueMinor` more (or less) because of a bill's charges. */
export interface StockCostAdjustment {
  readonly adjustmentId: string;
  readonly invoiceId: string;
  readonly poId: string | null;
  readonly productId: string;
  readonly locationId: string;
  /** The units the charge belongs to (what was received there), smallest steps. */
  readonly quantityMinor: number;
  /** Signed paise: positive adds cost, negative is a compensating correction. */
  readonly valueMinor: number;
  readonly occurredAt: string;
  readonly postedBy: string;
  /** Which match verdict caused it. */
  readonly matchedAt: string;
  /**
   * OB-509: this posting is the cost of units that came in UNVALUED (cost not known) — the supplier's bill matched to their
   * receipt — not a landed charge on valued stock. The valuation brings those units into value at it.
   */
  readonly costKnown?: true;
  /** OB-509: the receipt (and line) whose cost became known. */
  readonly grnId?: string;
  readonly lineId?: string;
  /** OB-509: the unit those units are counted in (their smallest steps), so an average can be stated per whole unit. */
  readonly uom?: string;
}

/**
 * The valuation input with the adjustments merged in time order (an adjustment after the movements at the same instant).
 * `map` is the reader's own Movement → ValuationMovement rule, so this changes nothing else about how a reader values stock.
 */
export function withLandedCost(
  movements: readonly Movement[], adjustments: readonly StockCostAdjustment[], map: (m: Movement) => ValuationMovement,
): ValuationMovement[] {
  if (adjustments.length === 0) return movements.map(map);
  const adj = [...adjustments].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));
  const out: ValuationMovement[] = [];
  let i = 0;
  for (const m of movements) {
    while (i < adj.length && adj[i]!.occurredAt < m.occurredAt) out.push(asValuation(adj[i++]!));
    out.push(map(m));
  }
  while (i < adj.length) out.push(asValuation(adj[i++]!));
  return out;
}

const asValuation = (a: StockCostAdjustment): ValuationMovement => ({
  productId: a.productId, locationId: a.locationId, effect: 1, quantityMinor: a.quantityMinor, isPurchaseReceipt: false,
  isCostAdjustment: true, adjustmentMinor: a.valueMinor, ...(a.costKnown === true ? { isCostKnown: true } : {}),
});
