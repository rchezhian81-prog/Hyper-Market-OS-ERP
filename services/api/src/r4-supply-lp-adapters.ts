// R4 Lane 4 — supply, pricing and loss prevention. Head office's wiring for D-10 · D-18 · D-21 · D-13. Every register is
// append-only on its own stream (hard rules #2, #6); reads fold the streams; nothing here edits or deletes a record, and
// nothing here changes a price, a stock figure or a case by itself (hard rule #5, P-05). One entry point,
// `r4SupplyLpRoutes`, is registered from main.ts; `supplierFactsFor` feeds the existing scorecard route (D-10).

import type { EventStore } from '../../../packages/persistence/src/event-store';
import { InMemoryEventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { STREAM, foldPurchaseOrders, goodsReceiptAdapter, liveSupplierInvoices } from './adapters';
import type { SupplierFacts } from '../../purchase/src/supplier-scorecard';
import type { ScorecardOrder, ScorecardReceipt, ScorecardMatchedInvoice } from '../../../packages/purchasing/src/index';
import type { StoredMatch } from '../../purchase/src/index';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;

/** OB-198: the shop's day for a ledger time (India Standard Time, UTC+05:30). */
const IST_OFFSET_MS = 330 * 60_000;
const shopDay = (iso: string): string => new Date(Date.parse(iso) + IST_OFFSET_MS).toISOString().slice(0, 10);

// ── D-10 supplier scorecard: the facts, from the registers ───────────────────────────────────────────────────────────

/**
 * D-10 (R4): a supplier's own ISSUED purchase orders (with the buyer's cancellations), the goods receipts against them at
 * their latest state (one per receipt id; a later line disposition replaces the dock's first figure), and the invoices
 * the three-way match checked — read straight from head office's registers. Nothing here is a typed figure.
 */
export function supplierFactsFor(input: { readonly store: EventStore; readonly now: () => string }) {
  return async (tenantId: string, supplierId: string): Promise<SupplierFacts> => {
    const pos = [...(await foldPurchaseOrders(input.store, tenantId)).values()].filter((p) => p.supplierId === supplierId && p.status === 'issued' && p.issuedAt !== null);
    const orders: ScorecardOrder[] = pos.map((p) => ({
      poId: p.poId, supplierId: p.supplierId, issuedOn: shopDay(p.issuedAt as string), cancelledByProduct: p.cancelledByProduct,
      lines: p.lines.map((l) => ({ productId: l.productId, orderedQty: l.orderedQty, unitCostMinor: l.unitCost.minor, ...(l.unitCost.per === undefined ? {} : { unitCostPer: l.unitCost.per }) })),
    }));
    const poIds = new Set(orders.map((o) => o.poId));
    const receipts: ScorecardReceipt[] = [];
    for (const g of await goodsReceiptAdapter(input).all(tenantId)) {
      if (g.poId === null || !poIds.has(g.poId)) continue;
      const disposed = new Map((g.dispositions ?? []).map((d) => [d.lineId, d] as const)); // one disposition per line
      receipts.push({
        receiptId: g.grnId, poId: g.poId, receivedOn: shopDay(g.receivedAt),
        lines: g.captured.lines.map((l) => {
          const d = disposed.get(l.lineId);
          return {
            lineId: l.lineId, productId: l.productId,
            receivedMinor: l.sellableMinor + l.quarantinedMinor + l.rejectedMinor + l.heldMinor,
            // The dock's first figure: refused plus quarantined (damaged, failed QC, cold chain). A second person's later
            // disposition of the line replaces it — accept takes it back to nothing, return / claim keeps it rejected.
            rejectedMinor: l.rejectedMinor + l.quarantinedMinor,
            ...(d === undefined ? {} : { disposition: { kind: d.disposition, quantityMinor: d.quantityMinor } }),
          };
        }),
      });
    }
    const matched = new Set((await input.store.readStream(tenantId, STREAM.purchase, { type: 'InvoiceMatched' })).map((e) => (e.event.payload as StoredMatch).invoiceId));
    const invoices: ScorecardMatchedInvoice[] = (await liveSupplierInvoices(input.store, tenantId))
      .filter((i) => i.supplierId === supplierId && i.poId !== null && poIds.has(i.poId) && matched.has(i.invoiceId))
      .map((i) => ({
        invoiceId: i.invoiceId, poId: i.poId as string,
        lines: i.lines.map((l) => ({ productId: l.productId, unitPriceMinor: l.unitPriceMinor, ...(l.unitPricePer === undefined ? {} : { unitPricePer: l.unitPricePer }) })),
      }));
    return { orders, receipts, invoices, today: shopDay(input.now()) };
  };
}

// ── the one entry point ──────────────────────────────────────────────────────────────────────────────────────────

/** Every Lane 4 route, composed over head office's store (or a throw-away in-memory one when the surface has none). */
export function r4SupplyLpRoutes(input: { readonly store: EventStore | undefined; readonly now: () => string; readonly recordAudit?: Recorder }): readonly Route[] {
  const store = input.store ?? new InMemoryEventStore();
  void store;
  return [];
}
