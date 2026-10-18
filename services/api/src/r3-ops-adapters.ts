// R3 Lane 4 — store operations and people. Head office's wiring for D-14 · D-16 · D-11 · D-25 · D-19 · C21 · D-9, each
// register append-only on its own stream (hard rules #2, #6). Reads fold the streams; nothing here edits or deletes a
// record. One entry point, `r3OpsRoutes`, is registered from main.ts.

import { makeEvent } from '../../../packages/contracts/src/event';
import { InMemoryEventStore, type EventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import {
  STREAM, streamName, inventoryAdapter, adjustmentRequestAdapter, saleStockLocationOf, productUomFrom, orgStructureAdapter,
  productMasterAdapter, assortmentAdapter, priceListAdapter,
} from './adapters';
import { assertBranchInScope } from '../../kernel/src/index';
import { rangeStatusOf } from '../../inventory/src/assortment';
import { resolvePrice } from '../../../packages/price-list/src/price-list';
import { clearanceMarkdownRoutes, type ClearanceMarkdownDeps } from '../../pricing/src/clearance-markdowns';
import type { IncomingSale } from '../../pos/src/sale-intake';
import { branchOfLocationIn, type LocationBranches } from '../../inventory/src/location-scope';
import {
  onShelfAvailabilityRoutes, type OnShelfAvailabilityDeps, type OsaCountTask, type OsaMinimumSetting,
} from '../../inventory/src/on-shelf-availability';
import type { OsaSoldLine } from '../../../packages/replenishment/src/on-shelf-availability';

const all = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;

// ── D-14 on-shelf availability ───────────────────────────────────────────────────────────────────────────────────

const OSA = streamName(STREAM.inventory, 'on-shelf-availability');

/** The banked sales' lines with their stock place, for trading days in [fromDay, toDay]. */
export async function soldLinesWithPlace(store: EventStore, tenantId: string, fromDay: string, toDay: string): Promise<OsaSoldLine[]> {
  // A sale booked to a trading day can be committed after midnight, so the read is padded; the trading day decides.
  const sales = await store.readStream(tenantId, STREAM.sales, { type: 'SaleCommitted', from: `${addDays(fromDay, -1)}T00:00:00.000Z`, to: `${addDays(toDay, 2)}T00:00:00.000Z` });
  const out: OsaSoldLine[] = [];
  for (const e of sales) {
    const sale = e.event.payload as IncomingSale;
    if (sale.tradingDay < fromDay || sale.tradingDay > toDay) continue;
    const { locationId } = await saleStockLocationOf(store, tenantId, sale);
    for (const l of sale.lines ?? []) out.push({ productId: l.productId, locationId, tradingDay: sale.tradingDay, quantityMinor: l.quantityMinor });
  }
  return out;
}

export function onShelfAvailabilityAdapter(input: { readonly store: EventStore; readonly now: () => string; readonly recordAudit?: Recorder; readonly locationBranches?: LocationBranches }): OnShelfAvailabilityDeps {
  const { store, now } = input;
  const adj = adjustmentRequestAdapter({ store, now });
  const inv = inventoryAdapter({ store, now });
  return {
    now,
    minimum: async (t) => (await all<OsaMinimumSetting>(store, t, OSA, 'OsaMinimumSet')).at(-1),
    recordMinimum: async (t, s) => {
      await store.append(t, OSA, makeEvent({ id: `osa-minimum-v${s.version}`, type: 'OsaMinimumSet', occurredAt: s.setAt, idempotencyKey: `osa-minimum-${t}-v${s.version}`, source: 'api/inventory', payload: s }));
    },
    stock: async (t) => (await inv.availability(t)).map((a) => ({ productId: a.productId, locationId: a.locationId, onHandMinor: a.onHandMinor })),
    soldLines: (t, from, to) => soldLinesWithPlace(store, t, from, to),
    tasks: (t) => all<OsaCountTask>(store, t, OSA, 'OsaCountTaskRecorded'),
    recordTask: async (t, task) => {
      await store.append(t, OSA, makeEvent({ id: `osa-task-${task.taskId}-${task.state}`, type: 'OsaCountTaskRecorded', occurredAt: task.countedAt ?? task.raisedAt, idempotencyKey: `osa-task-${t}-${task.taskId}-${task.state}`, source: 'api/inventory', payload: task }));
    },
    adjustmentRequest: (t, id) => adj.request(t, id),
    raiseAdjustmentRequest: (t, r) => adj.recordRequest(t, r),
    permissionsOfUser: (t, u) => adj.permissionsOfUser(t, u),
    unitValueMinor: (t, p) => adj.unitValueMinor(t, p),
    uomOf: (t, p) => productUomFrom({ store, now }, t, p),
    ...(input.locationBranches === undefined ? {} : { locationBranches: input.locationBranches }),
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  };
}

// ── D-16 lifecycle stops ordering + clearance suggestions ────────────────────────────────────────────────────────

/** D-16: the product master's lifecycle for a product (undefined when the master does not know it). */
export function masterLifecycleOf(input: { readonly store: EventStore; readonly now: () => string }): (tenantId: string, productId: string) => Promise<string | undefined> {
  return async (tenantId, productId) => (await productMasterAdapter(input).product(tenantId, productId))?.lifecycle;
}

/** Today's shelf price at a store: the store-scope price-list entry in force (the one price truth, P-02). */
export async function shelfPriceAt(input: { readonly store: EventStore; readonly now: () => string }, tenantId: string, productId: string, storeId: string, at: string): Promise<number | undefined> {
  const entry = resolvePrice(await priceListAdapter(input).entries(tenantId, productId), { productId, at, storeId });
  return entry === null ? undefined : entry.price.minor;
}

export function clearanceMarkdownAdapter(input: { readonly store: EventStore; readonly now: () => string; readonly locationBranches: LocationBranches }): ClearanceMarkdownDeps {
  const { store, now } = input;
  const storeOf = async (t: string) => input.locationBranches(t);
  return {
    now,
    clearanceProducts: async (t, storeId, onDate) => {
      const out = new Map<string, 'product_master' | 'store_range'>();
      for (const p of await productMasterAdapter({ store, now }).products(t)) if (p.lifecycle === 'clearance') out.set(p.productId, 'product_master');
      const entries = await assortmentAdapter({ store, now }).entries(t, storeId);
      for (const productId of new Set(entries.map((e) => e.productId))) {
        if (!out.has(productId) && rangeStatusOf(entries, storeId, productId, onDate) === 'clearance') out.set(productId, 'store_range');
      }
      return [...out].map(([productId, source]) => ({ productId, source })).sort((a, b) => (a.productId < b.productId ? -1 : 1));
    },
    batchesAtStore: async (t, storeId) => {
      const branchOf = await storeOf(t);
      return (await inventoryAdapter({ store, now }).batches!(t)).filter((b) => branchOf(b.locationId) === storeId);
    },
    soldAtStore: async (t, storeId, from, to) => {
      const branchOf = await storeOf(t);
      return (await soldLinesWithPlace(store, t, from, to)).filter((l) => branchOf(l.locationId) === storeId);
    },
    shelfPriceMinor: (t, p, storeId, at) => shelfPriceAt({ store, now }, t, p, storeId, at),
    assertStoreInScope: async (ctx) => { assertBranchInScope(ctx, (ctx.query['storeId'] ?? '').trim()); },
  };
}

// ── the one entry point ──────────────────────────────────────────────────────────────────────────────────────────

/** Every Lane 4 route, composed over head office's store (or a throw-away in-memory one when the surface has none). */
export function r3OpsRoutes(input: { readonly store: EventStore | undefined; readonly now: () => string; readonly recordAudit?: Recorder }): readonly Route[] {
  const store = input.store ?? new InMemoryEventStore();
  const now = input.now;
  const locationBranches: LocationBranches = async (t) => branchOfLocationIn(await orgStructureAdapter({ store, now }).nodes(t));
  const base = { store, now, locationBranches, ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }) };
  return [
    ...onShelfAvailabilityRoutes(onShelfAvailabilityAdapter(base)),
    ...clearanceMarkdownRoutes(clearanceMarkdownAdapter(base)),
  ];
}
