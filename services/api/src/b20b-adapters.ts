// Batch 20b — head-office wiring for the stock history reads (services/inventory/src/stock-history.ts): earlier counts and
// count accuracy (S3), what the empty shelves cost (S4) and how to share stock (S5). Every read folds the append-only
// registers already kept; nothing is written here.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import type { DatedStockChange } from '../../../packages/stock/src/stockout-estimate';
import type { Movement } from '../../inventory/src/index';
import { EFFECT_ON_HAND } from '../../inventory/src/index';
import type { StoredReconciliation } from '../../inventory/src/counts';
import type { CountPlan } from '../../inventory/src/count-plans';
import type { StockHistoryDeps } from '../../inventory/src/stock-history';
import { STREAM, streamName, allOf, inventoryAdapter, productMasterAdapter } from './adapters';
import { transferSuggestionRows } from './ai-insights';

export function stockHistoryAdapter(input: { readonly store: EventStore; readonly now: () => string }): Omit<StockHistoryDeps, 'locationBranches'> {
  const { store, now } = input;
  const countsStream = streamName(STREAM.inventory, 'counts');
  const plansStream = streamName(STREAM.inventory, 'count-plans');
  return {
    now,
    // The count register: as recorded, then its decided state — the latest per count id (the same fold as the counts route).
    countRecords: async (tenantId) => {
      const byId = new Map<string, StoredReconciliation>();
      for (const r of await allOf<StoredReconciliation>(store, tenantId, countsStream, 'CountReconciled')) byId.set(r.countId, r);
      for (const d of await allOf<StoredReconciliation>(store, tenantId, countsStream, 'CountDecided')) byId.set(d.countId, d);
      return [...byId.values()];
    },
    // OB-850: a planned count carries its plan's number — the first number any step of the plan recorded.
    planNumbers: async (tenantId) => {
      const out = new Map<string, string>();
      for (const p of await allOf<{ plan: CountPlan }>(store, tenantId, plansStream, 'CountPlanRecorded')) {
        if (typeof p.plan.documentNumber === 'string' && !out.has(p.plan.planId)) out.set(p.plan.planId, p.plan.documentNumber);
      }
      return out;
    },
    stockChanges: async (tenantId) => (await store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' })).map((e) => {
      const m = e.event.payload as Movement;
      return { productId: m.productId, locationId: m.locationId, shopDate: shopDateIn(m.occurredAt), effect: EFFECT_ON_HAND[m.kind], quantityMinor: m.quantityMinor, isSale: m.kind === 'sold' } satisfies DatedStockChange;
    }),
    // GMROI's own gross margin per item (net of GST and returns, less the cost of what sold); absent where it cannot be stated.
    grossMargins: async (tenantId, opts) => {
      const perf = await inventoryAdapter({ store, now }).performance(tenantId, opts);
      return new Map(perf.byProduct.filter((p) => p.grossMargin !== undefined).map((p) => [p.productId, p.grossMargin!.minor] as const));
    },
    transferSuggestions: (tenantId) => transferSuggestionRows(store, tenantId, now()),
    productUoms: async (tenantId) => new Map((await productMasterAdapter({ store, now }).products(tenantId)).map((p) => [p.productId, p.baseUom] as const)),
  };
}
