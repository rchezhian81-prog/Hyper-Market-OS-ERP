// R4 Lane 4 — supply, pricing and loss prevention. Head office's wiring for D-10 · D-18 · D-21 · D-13. Every register is
// append-only on its own stream (hard rules #2, #6); reads fold the streams; nothing here edits or deletes a record, and
// nothing here changes a price, a stock figure or a case by itself (hard rule #5, P-05). One entry point,
// `r4SupplyLpRoutes`, is registered from main.ts; `supplierFactsFor` feeds the existing scorecard route (D-10).

import type { EventStore } from '../../../packages/persistence/src/event-store';
import { InMemoryEventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { makeEvent } from '../../../packages/contracts/src/event';
import {
  STREAM, streamName, foldPurchaseOrders, goodsReceiptAdapter, liveSupplierInvoices,
  productMasterAdapter, priceListAdapter, storeRulesAdapter, averageBuyingCosts,
} from './adapters';
import { competitorPriceAdapter } from './round8-adapters';
import type { SupplierFacts } from '../../purchase/src/supplier-scorecard';
import type { ScorecardOrder, ScorecardReceipt, ScorecardMatchedInvoice } from '../../../packages/purchasing/src/index';
import type { StoredMatch } from '../../purchase/src/index';
import { competitorDraftRoutes, type CompetitorDraftDeps, type StoredCompetitorRule } from '../../pricing/src/competitor-drafts';
import type { ProductPriceFacts } from '../../../packages/pricing/src/competitor-rule';
import { resolvePrice } from '../../../packages/price-list/src/price-list';
import { toMaster } from '../../catalogue/src/catalogue-preview';

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

// ── D-18 competitor prices draft a price change ─────────────────────────────────────────────────────────────────────

const COMPETITOR_RULE = streamName(STREAM.pricing, 'competitor-rule');

/**
 * D-18 (R4, OB-216): the owner's competitor rule (versions on its own stream) and, per store, what head office holds for
 * each product a competitor was seen selling there — the sightings, the shop's own price now (`resolvePrice`, as the pack
 * is built), the MRP in force on the product master, the store's average buying cost (OB-39) and the margin floor in the
 * store's rules. Every read only; the drafts are computed by the tested engine and recorded nowhere.
 */
export function competitorDraftAdapter(input: { readonly store: EventStore; readonly now: () => string; readonly recordAudit?: Recorder }): CompetitorDraftDeps {
  const { store, now } = input;
  return {
    now,
    rules: async (t) => (await store.readStream(t, COMPETITOR_RULE, { type: 'CompetitorRuleSet' })).map((e) => e.event.payload as StoredCompetitorRule),
    recordRule: async (t, r) => {
      await store.append(t, COMPETITOR_RULE, makeEvent({
        id: `competitor-rule-v${r.version}`, type: 'CompetitorRuleSet', occurredAt: r.setAt,
        idempotencyKey: `competitor-rule-${t}-v${r.version}`, source: 'api/pricing', payload: r,
      }));
    },
    productFacts: async (t, storeId) => {
      const sightings = (await competitorPriceAdapter({ store, now }).observations(t)).filter((o) => o.storeId === storeId);
      const productIds = [...new Set(sightings.map((o) => o.productId))].sort();
      if (productIds.length === 0) return [];
      const at = now();
      const asOf = at.slice(0, 10);
      const [costs, rules] = await Promise.all([averageBuyingCosts({ store, now }, t), storeRulesAdapter({ store }).rules(t, storeId)]);
      const master = productMasterAdapter({ store, now });
      const prices = priceListAdapter({ store, now });
      const out: ProductPriceFacts[] = [];
      for (const productId of productIds) {
        const record = await master.product(t, productId);
        const mrp = record === undefined ? undefined : toMaster(record, asOf).mrpMinor;
        const ours = resolvePrice(await prices.entries(t, productId), { productId, at, storeId });
        const cost = costs.costOf(productId, storeId);
        out.push({
          productId, storeId, currency: 'INR',
          ourPriceMinor: ours === null ? null : ours.price.minor,
          ...(mrp === undefined ? {} : { mrpMinor: mrp }),
          ...(cost === undefined ? {} : { costMinor: cost }),
          ...(rules?.marginFloorBps === undefined ? {} : { marginFloorBps: rules.marginFloorBps }),
          sightings: sightings.filter((o) => o.productId === productId).map((o) => ({ observationId: o.observationId, competitor: o.competitor, priceMinor: o.priceMinor, observedAt: o.observedAt })),
        });
      }
      return out;
    },
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  };
}

// ── the one entry point ──────────────────────────────────────────────────────────────────────────────────────────

/** Every Lane 4 route, composed over head office's store (or a throw-away in-memory one when the surface has none). */
export function r4SupplyLpRoutes(input: { readonly store: EventStore | undefined; readonly now: () => string; readonly recordAudit?: Recorder }): readonly Route[] {
  const store = input.store ?? new InMemoryEventStore();
  const base = { store, now: input.now, ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }) };
  return [
    ...competitorDraftRoutes(competitorDraftAdapter(base)),
  ];
}
