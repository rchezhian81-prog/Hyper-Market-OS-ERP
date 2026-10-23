// API-03 The open-commitment report (M06-FR-04 "… open-commitment tracking"; acceptance "cancelling part of a PO reduces the
// open commitment correctly … open commitments reconcile to receipts") — grouped by BUYING SCOPE (OB-289), supplier and store.
//
// Per line of every ISSUED order: ordered − received − cancelled, valued at the order's cost by the tested
// `computeOpenCommitment` (a proposed order is not a commitment yet). Beside each line, the receipts that make up its
// "received" — each receipt posting against the order by id — and whether they add up to what the order holds (`agrees`).
// An over-receipt is a negative open quantity, listed as an exception, never hidden. An order raised before every order
// carried a scope is grouped as `scope_not_recorded`, never guessed into one. Read-only; a store-scoped reader sees only
// the orders delivered to their branches.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { computeOpenCommitment, isBuyingScope } from '../../../packages/purchasing/src/index';
import { stockReadScope, type LocationBranches } from '../../inventory/src/location-scope';
import type { StoredPurchaseOrder } from './purchase-orders';
import type { PurchaseOrderLineInput } from '../../../packages/purchasing/src/index';

export interface ReceiptPosting {
  readonly poId: string;
  readonly receiptId: string;
  readonly receivedByProduct: Readonly<Record<string, number>>;
  readonly at: string;
}

export interface CommitmentReportDeps {
  readonly orders: (tenantId: string) => Promise<readonly StoredPurchaseOrder[]> | readonly StoredPurchaseOrder[];
  /** Every receipt posting against an order (the goods receipts' and the manual ones), as the order's register holds them. */
  readonly receiptPostings: (tenantId: string) => Promise<readonly ReceiptPosting[]> | readonly ReceiptPosting[];
  readonly locationBranches?: LocationBranches;
  readonly now: () => string;
}

export const SCOPE_NOT_RECORDED = 'scope_not_recorded';

export interface CommitmentLine {
  readonly poId: string;
  readonly number: string;
  readonly supplierId: string;
  readonly deliverTo: string;
  readonly buyingScope: string;
  readonly productId: string;
  readonly orderedQty: number;
  readonly receivedQty: number;
  readonly cancelledQty: number;
  readonly openQty: number;
  readonly openValueMinor: number;
  readonly receipts: readonly { readonly receiptId: string; readonly quantity: number }[];
  /** The receipts listed add up to the order's received figure. */
  readonly agrees: boolean;
}

interface Group { readonly key: string; readonly orders: number; readonly lines: number; readonly openValueMinor: number }

const group = (lines: readonly CommitmentLine[], keyOf: (l: CommitmentLine) => string): Group[] => {
  const by = new Map<string, { orders: Set<string>; lines: number; open: number }>();
  for (const l of lines) {
    const k = keyOf(l);
    const g = by.get(k) ?? { orders: new Set<string>(), lines: 0, open: 0 };
    g.orders.add(l.poId); g.lines += 1; g.open += l.openValueMinor;
    by.set(k, g);
  }
  return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([key, g]) => ({ key, orders: g.orders.size, lines: g.lines, openValueMinor: g.open }));
};

/** The report over the given orders and receipt postings. Pure. */
export function openCommitmentReport(orders: readonly StoredPurchaseOrder[], postings: readonly ReceiptPosting[]) {
  const lines: CommitmentLine[] = [];
  for (const po of orders) {
    if (po.status !== 'issued') continue;
    // One row per product: a product split over several lines is merged (at its first line's cost) so what was received
    // and cancelled for it is netted once, never once per line.
    const merged = new Map<string, PurchaseOrderLineInput>();
    for (const l of po.lines) {
      const cur = merged.get(l.productId);
      merged.set(l.productId, cur === undefined ? l : { ...cur, orderedQty: cur.orderedQty + l.orderedQty });
    }
    const open = computeOpenCommitment([...merged.values()], po.receivedByProduct, po.cancelledByProduct);
    const mine = postings.filter((p) => p.poId === po.poId);
    for (const l of open.lines) {
      const receipts = mine.filter((p) => (p.receivedByProduct[l.productId] ?? 0) > 0).map((p) => ({ receiptId: p.receiptId, quantity: p.receivedByProduct[l.productId]! }));
      lines.push({
        poId: po.poId, number: po.number, supplierId: po.supplierId, deliverTo: po.deliverToLocationId ?? 'store_not_named',
        buyingScope: isBuyingScope(po.buyingScope) ? po.buyingScope : SCOPE_NOT_RECORDED,
        productId: l.productId, orderedQty: l.orderedQty, receivedQty: l.receivedQty, cancelledQty: l.cancelledQty, openQty: l.openQty,
        openValueMinor: l.openValue.minor,
        receipts, agrees: receipts.reduce((s, r) => s + r.quantity, 0) === l.receivedQty,
      });
    }
  }
  const totalOpenMinor = lines.reduce((s, l) => s + l.openValueMinor, 0);
  return {
    lines,
    byScope: group(lines, (l) => l.buyingScope),
    bySupplier: group(lines, (l) => l.supplierId),
    byStore: group(lines, (l) => l.deliverTo),
    totalOpenMinor,
    overReceived: lines.filter((l) => l.openQty < 0).map((l) => ({ poId: l.poId, productId: l.productId, overByQty: -l.openQty })),
    receiptsDisagree: lines.filter((l) => !l.agrees).map((l) => ({ poId: l.poId, productId: l.productId })),
  };
}

export function commitmentReportRoutes(deps: CommitmentReportDeps): readonly Route[] {
  return [
    {
      // ?buyingScope= &supplierId= &storeId= narrow it; a store-scoped reader sees their branches' orders only.
      api: 'API-03', method: 'GET', path: '/v1/purchase/commitments/report',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const scopeAsked = ctx.query['buyingScope'];
        if (scopeAsked !== undefined && scopeAsked !== SCOPE_NOT_RECORDED && !isBuyingScope(scopeAsked)) {
          throw apiError(400, { code: 'unknown_buying_scope', whatHappened: `"${scopeAsked}" is not a buying scope (central_via_warehouse, central_direct_to_store, local, ${SCOPE_NOT_RECORDED}).`, wasItSaved: 'not_saved', nextSafeAction: 'Ask for one of those, or for all. Nothing was changed.' });
        }
        const filter = await stockReadScope(ctx, deps.locationBranches);
        const supplierId = ctx.query['supplierId'];
        const storeId = ctx.query['storeId'];
        const branchOf = deps.locationBranches === undefined ? ((l: string) => l) : await deps.locationBranches(ctx.tenantId);
        const orders = (await deps.orders(ctx.tenantId)).filter((po) =>
          (po.deliverToLocationId === undefined ? filter.everything : filter.covers(po.deliverToLocationId))
          && (supplierId === undefined || po.supplierId === supplierId)
          && (storeId === undefined || (po.deliverToLocationId !== undefined && (po.deliverToLocationId === storeId || branchOf(po.deliverToLocationId) === storeId)))
          && (scopeAsked === undefined || (isBuyingScope(po.buyingScope) ? po.buyingScope : SCOPE_NOT_RECORDED) === scopeAsked));
        const report = openCommitmentReport(orders, await deps.receiptPostings(ctx.tenantId));
        return { status: 200, body: { ...report, issuedOrders: orders.filter((o) => o.status === 'issued').length, asAt: deps.now() } };
      },
    },
  ];
}
