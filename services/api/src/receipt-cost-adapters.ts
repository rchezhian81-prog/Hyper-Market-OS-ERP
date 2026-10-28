// Round 6 (M07-FR-01/02 · hard rule #10) — head office's wiring for "a direct goods receipt is booked at the cost the ISSUED
// purchase order agreed, never at the cost the receiver typed". The handheld path already reads the order's cost
// (`orderUnitCostFrom`); this gives the direct `POST /v1/inventory/goods-receipt/:grnId` the same record, with the order
// line's full cost basis (a case cost `per` N units travels exactly, OB-46). Read-only: it folds the purchase-order stream.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import { foldPurchaseOrders } from './adapters';
import type { OrderLineCost } from '../../inventory/src/goods-receipt';

/** The unit cost an ISSUED order agreed for a product (its first line naming it); undefined when unknown, unissued or not named. */
export async function orderLineCostFrom(store: EventStore, tenantId: string, poId: string, productId: string): Promise<OrderLineCost | undefined> {
  const po = (await foldPurchaseOrders(store, tenantId)).get(poId);
  if (po === undefined || po.status !== 'issued') return undefined;
  const line = po.lines.find((l) => l.productId === productId);
  if (line === undefined) return undefined;
  const { minor, currency, per } = line.unitCost;
  return { minor, currency, ...(per === undefined ? {} : { per }) };
}

/** Spread into the direct goods-receipt route's deps (main.ts). */
export function receiptCostHooks(input: { readonly store: EventStore }) {
  return {
    orderLineCost: (tenantId: string, poId: string, productId: string) => orderLineCostFrom(input.store, tenantId, poId, productId),
  };
}
