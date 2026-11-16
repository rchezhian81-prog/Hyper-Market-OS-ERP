// "ORDER THESE FROM THE USUAL SUPPLIER" — fix batch 4b · D-040 · M06-FR-02 · WF-03 · §28 · hard rule #5.
//
// The walkthrough found that ticking a reorder suggestion made a requisition, and getting from the weekly suggestions to an
// order meant requisition → quotes → propose → second person. Here the ticked suggestions become one PROPOSED purchase
// order per supplier:
//   • the USUAL SUPPLIER of an item is the supplier of the latest ISSUED order (approved by a second person) that carried it;
//   • the price is that order's agreed price for the item (per whole unit; a case price that does not divide exactly into
//     a price per unit is left out and named, never rounded into a different price);
//   • items with no issued order behind them (no usual supplier, no agreed price) are left out and named.
// It only PLANS. The orders are proposed through the same route as "Raise an order", and a second person still issues each
// one — nothing here issues, and no assistant commits anything. Reads head office's `GET /v1/purchase/orders` body. Pure.

export interface WantedLine {
  readonly productId: string;
  /** In the item's smallest step (grams for a kg item, items otherwise), whole and > 0. */
  readonly quantity: number;
}

export interface PlannedLine {
  readonly productId: string;
  readonly orderedQty: number;
  /** The agreed price per whole unit, in paise. */
  readonly unitCostMinor: number;
  /** The issued order the supplier and price come from. */
  readonly fromPoId: string;
  readonly fromNumber: string;
}

export interface PlannedOrder {
  readonly supplierId: string;
  readonly lines: readonly PlannedLine[];
}

export type LeftOutWhy = 'no_earlier_order' | 'price_not_per_unit' | 'quantity_not_whole';

export interface UsualSupplierPlan {
  readonly orders: readonly PlannedOrder[];
  readonly leftOut: readonly { readonly productId: string; readonly why: LeftOutWhy }[];
}

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

interface Usual { readonly supplierId: string; readonly unitCostMinor: number | undefined; readonly at: string; readonly poId: string; readonly number: string }

/** Each item's usual supplier and agreed price, from the latest issued order that carried it. */
export function usualSuppliers(ordersBody: unknown): ReadonlyMap<string, Usual> {
  const orders = isRec(ordersBody) && Array.isArray(ordersBody['orders']) ? ordersBody['orders'] : [];
  const out = new Map<string, Usual>();
  for (const o of orders) {
    if (!isRec(o) || o['status'] !== 'issued' || str(o['supplierId']) === '' || !Array.isArray(o['lines'])) continue;
    if (o['currency'] !== undefined && o['currency'] !== 'INR') continue;
    const at = str(o['issuedAt']) || str(o['at']);
    for (const l of o['lines']) {
      if (!isRec(l) || str(l['productId']) === '') continue;
      const cost = isRec(l['unitCost']) ? l['unitCost'] : undefined;
      const minor = cost !== undefined && Number.isSafeInteger(cost['minor']) ? cost['minor'] as number : undefined;
      const per = cost !== undefined && Number.isSafeInteger(cost['per']) && (cost['per'] as number) > 0 ? cost['per'] as number : 1;
      const unitCostMinor = minor === undefined || minor <= 0 || minor % per !== 0 ? undefined : minor / per;
      const productId = str(l['productId']);
      const had = out.get(productId);
      if (had !== undefined && had.at >= at) continue;
      out.set(productId, { supplierId: str(o['supplierId']), unitCostMinor, at, poId: str(o['poId']), number: str(o['number']) || str(o['poId']) });
    }
  }
  return out;
}

/** One proposed order per usual supplier for the wanted lines; the rest named. Orders and lines in a stable order. */
export function usualSupplierPlan(ordersBody: unknown, wanted: readonly WantedLine[]): UsualSupplierPlan {
  const usual = usualSuppliers(ordersBody);
  const bySupplier = new Map<string, PlannedLine[]>();
  const leftOut: { productId: string; why: LeftOutWhy }[] = [];
  for (const w of wanted) {
    if (!Number.isSafeInteger(w.quantity) || w.quantity <= 0) { leftOut.push({ productId: w.productId, why: 'quantity_not_whole' }); continue; }
    const u = usual.get(w.productId);
    if (u === undefined) { leftOut.push({ productId: w.productId, why: 'no_earlier_order' }); continue; }
    if (u.unitCostMinor === undefined) { leftOut.push({ productId: w.productId, why: 'price_not_per_unit' }); continue; }
    const lines = bySupplier.get(u.supplierId) ?? [];
    lines.push({ productId: w.productId, orderedQty: w.quantity, unitCostMinor: u.unitCostMinor, fromPoId: u.poId, fromNumber: u.number });
    bySupplier.set(u.supplierId, lines);
  }
  const orders = [...bySupplier.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([supplierId, lines]) => ({ supplierId, lines: [...lines].sort((a, b) => a.productId.localeCompare(b.productId)) }));
  return { orders, leftOut };
}
