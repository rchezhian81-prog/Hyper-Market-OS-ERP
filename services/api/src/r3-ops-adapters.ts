// R3 Lane 4 — store operations and people. Head office's wiring for D-14 · D-16 · D-11 · D-25 · D-19 · C21 · D-9, each
// register append-only on its own stream (hard rules #2, #6). Reads fold the streams; nothing here edits or deletes a
// record. One entry point, `r3OpsRoutes`, is registered from main.ts.

import { makeEvent } from '../../../packages/contracts/src/event';
import { InMemoryEventStore, type EventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import {
  STREAM, streamName, inventoryAdapter, adjustmentRequestAdapter, saleStockLocationOf, productUomFrom, orgStructureAdapter,
  productMasterAdapter, assortmentAdapter, priceListAdapter, purchaseOrdersAdapter, permissionsHeldBy,
  productionAdapter, lotTraceAdapter, rosterStoreAdapter,
} from './adapters';
import { biometricConsentRoutes, type BiometricConsentDeps, type AttendanceMark } from '../../finance/src/biometric-consent';
import type { BiometricConsentEvent } from '../../../packages/workforce/src/biometric-consent';
import { scheduleRoutes, type ScheduleDeps, type StoredDraft } from '../../finance/src/schedule-store';
import type { ServiceStandard } from '../../../packages/workforce/src/labour-demand';
import { hrComplianceAdapter } from './r2-hr-adapters';
import { tenantEntitlementResolver } from './access';
import { productionPlanRoutes, productionInputsOf, type ProductionPlanDeps, type ProductionTraceRun } from '../../inventory/src/production-plan';
import type { IngredientBatchOnHand, RunInputBatch } from '../../inventory/src/production';
import type { Recipe } from '../../../packages/production/src/recipe';
import { fefoBatchesAt } from '../../inventory/src/index';
import { channelPricingRoutes, channelPricingGate, type ChannelPricingDeps, type ChannelSwitchRequest, type ZoneMembership } from '../../pricing/src/channel-pricing';
import { dsdCheckInRoutes, type DsdCheckInDeps, type DsdCheckInRecord, type DsdRouteSheet } from '../../inventory/src/dsd-checkin';
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

// ── D-11 DSD door check-in ───────────────────────────────────────────────────────────────────────────────────────

const DSD = streamName(STREAM.inventory, 'dsd-checkins');

export function dsdCheckInAdapter(input: { readonly store: EventStore; readonly now: () => string; readonly recordAudit?: Recorder; readonly locationBranches?: LocationBranches }): DsdCheckInDeps {
  const { store, now } = input;
  const po = purchaseOrdersAdapter({ store, now });
  const latestBy = <T>(xs: readonly T[], key: (x: T) => string): Map<string, T> => { const m = new Map<string, T>(); for (const x of xs) m.set(key(x), x); return m; };
  const sheets = async (t: string) => latestBy(await all<DsdRouteSheet>(store, t, DSD, 'DsdRouteSheetRecorded'), (r) => r.routeId);
  const checkIns = async (t: string) => latestBy(await all<DsdCheckInRecord>(store, t, DSD, 'DsdCheckInRecorded'), (r) => r.checkInId);
  return {
    now,
    routeSheet: async (t, id) => (await sheets(t)).get(id),
    routeSheets: async (t) => [...(await sheets(t)).values()],
    recordRouteSheet: async (t, r) => {
      await store.append(t, DSD, makeEvent({ id: `dsd-route-${r.routeId}-v${r.version}`, type: 'DsdRouteSheetRecorded', occurredAt: r.recordedAt, idempotencyKey: `dsd-route-${t}-${r.routeId}-v${r.version}`, source: 'api/inventory', payload: r }));
    },
    // The ORDER's open lines — ordered less received less cancelled — at the order's own cost per whole unit.
    order: async (t, poId) => {
      const o = await po.order(t, poId);
      if (o === undefined) return undefined;
      return {
        poId, supplierId: o.supplierId, deliverToLocationId: o.deliverToLocationId ?? null, status: o.status,
        lines: o.lines.map((l) => ({
          productId: l.productId,
          expectedMinor: Math.max(0, l.orderedQty - (o.receivedByProduct[l.productId] ?? 0) - (o.cancelledByProduct[l.productId] ?? 0)),
          unitCostMinor: Math.round(l.unitCost.minor / (l.unitCost.per ?? 1)), uom: l.uom ?? 'ea',
        })),
      };
    },
    supplierActive: async (t, supplierId) => (await po.supplierStatus?.(t, supplierId)) === 'active',
    checkIn: async (t, id) => (await checkIns(t)).get(id),
    checkIns: async (t) => [...(await checkIns(t)).values()],
    recordCheckIn: async (t, r) => {
      await store.append(t, DSD, makeEvent({ id: `dsd-checkin-${r.checkInId}-v${r.version}`, type: 'DsdCheckInRecorded', occurredAt: r.recordedAt, idempotencyKey: `dsd-checkin-${t}-${r.checkInId}-v${r.version}`, source: 'api/inventory', payload: r }));
    },
    appendMovement: async (t, m) => { await inventoryAdapter({ store, now }).appendMovement(t, m); },
    permissionsOfUser: (t, u) => permissionsHeldBy(store, t, u),
    ...(input.locationBranches === undefined ? {} : { locationBranches: input.locationBranches }),
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  };
}

// ── D-25 production plan + prep-batch traceability ───────────────────────────────────────────────────────────────

const PRODUCTION = streamName(STREAM.inventory, 'production');

/** D-25: an ingredient's batches on hand at a place, earliest expiry first (OB-35's FEFO read). */
export function ingredientBatchesAt(input: { readonly store: EventStore; readonly now: () => string }): (tenantId: string, locationId: string, productId: string) => Promise<readonly IngredientBatchOnHand[]> {
  return async (tenantId, locationId, productId) =>
    fefoBatchesAt(await inventoryAdapter(input).batches!(tenantId, productId), locationId, productId)
      .map((b) => ({ batchId: b.batchId, onHandMinor: b.onHandMinor, ...(b.expiry === undefined ? {} : { expiry: b.expiry }) }));
}

/**
 * D-25 → D-26 (Lane 3's lot trace adds the production hop with this): the ingredient batches that went into one OUTPUT
 * batch, from the stored runs. `[]` when no run made it; `inputsRecorded: false` on a run recorded before D-25.
 */
export async function productionInputsForOutputBatch(input: { readonly store: EventStore; readonly now: () => string }, tenantId: string, outputBatchId: string): Promise<readonly { readonly runId: string; readonly outputProductId: string; readonly inputsRecorded: boolean; readonly inputBatches: readonly RunInputBatch[] }[]> {
  return productionInputsOf(await productionTraceRuns(input, tenantId), outputBatchId);
}

/** D-25 → D-26: every stored production run with the input batches it recorded (Lane 3's trace reads which runs USED a batch). */
export async function productionTraceRunsOf(input: { readonly store: EventStore; readonly now: () => string }, tenantId: string): Promise<readonly ProductionTraceRun[]> {
  return productionTraceRuns(input, tenantId);
}

async function productionTraceRuns(input: { readonly store: EventStore; readonly now: () => string }, tenantId: string): Promise<readonly ProductionTraceRun[]> {
  return (await productionAdapter({ ...input, entitledFeatures: tenantEntitlementResolver(input.store) }).runs(tenantId)) as readonly ProductionTraceRun[];
}

export function productionPlanAdapter(input: { readonly store: EventStore; readonly now: () => string; readonly locationBranches: LocationBranches }): ProductionPlanDeps {
  const { store, now } = input;
  const prod = () => productionAdapter({ store, now, entitledFeatures: tenantEntitlementResolver(store) });
  return {
    now,
    recipes: async (t) => {
      const latest = new Map<string, Recipe>();
      for (const r of await all<Recipe>(store, t, PRODUCTION, 'RecipeRegistered')) latest.set(r.recipeId, r);
      return [...latest.values()];
    },
    enabledDepartments: async (t) => prod().enabledDepartments(t),
    soldNear: async (t, locationId, from, to) => {
      const branchOf = await input.locationBranches(t);
      const store0 = branchOf(locationId);
      return (await soldLinesWithPlace(store, t, from, to)).filter((l) => branchOf(l.locationId) === store0).map((l) => ({ productId: l.productId, quantityMinor: l.quantityMinor, tradingDay: l.tradingDay }));
    },
    usableOnHand: async (t, locationId, productId, onDay) => {
      const branchOf = await input.locationBranches(t);
      const here = branchOf(locationId);
      return (await inventoryAdapter({ store, now }).batches!(t, productId))
        .filter((b) => branchOf(b.locationId) === here && b.onHandMinor > 0 && (b.expiry === undefined || b.expiry >= onDay))
        .reduce((n, b) => n + b.onHandMinor, 0);
    },
    runs: (t) => productionTraceRuns({ store, now }, t),
    soldOfBatch: async (t, batchId) => lotTraceAdapter({ store }).soldOfBatch(t, batchId),
    locationBranches: input.locationBranches,
  };
}

// ── D-19 zone / channel pricing (built, switched off) ────────────────────────────────────────────────────────────

const CHANNEL_PRICING = streamName(STREAM.pricing, 'channel-pricing');

export function channelPricingAdapter(input: { readonly store: EventStore; readonly now: () => string; readonly recordAudit?: Recorder }): ChannelPricingDeps {
  const { store, now } = input;
  return {
    now,
    requests: (t) => all<ChannelSwitchRequest>(store, t, CHANNEL_PRICING, 'ChannelPricingSwitchRequest'),
    recordRequest: async (t, r) => {
      await store.append(t, CHANNEL_PRICING, makeEvent({ id: `channel-switch-${r.requestId}-${r.status}`, type: 'ChannelPricingSwitchRequest', occurredAt: r.approvedAt ?? r.requestedAt, idempotencyKey: `channel-switch-${t}-${r.requestId}-${r.status}`, source: 'api/pricing', payload: r }));
    },
    zones: (t) => all<ZoneMembership>(store, t, CHANNEL_PRICING, 'StoreZoneSet'),
    recordZone: async (t, z) => {
      await store.append(t, CHANNEL_PRICING, makeEvent({ id: `store-zone-${z.storeId}-${z.zoneId}-${z.setAt}`, type: 'StoreZoneSet', occurredAt: z.setAt, idempotencyKey: `store-zone-${t}-${z.storeId}-${z.zoneId}-${z.setAt}`, source: 'api/pricing', payload: z }));
    },
    permissionsOfUser: (t, u) => permissionsHeldBy(store, t, u),
    priceLists: async (t) => {
      const ids = (await productMasterAdapter({ store, now }).products(t)).map((p) => p.productId);
      return Promise.all(ids.map(async (productId) => ({ productId, entries: await priceListAdapter({ store, now }).entries(t, productId) })));
    },
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  };
}

/** D-19: the gate the existing price-list routes ask (wired in main.ts beside them). */
export const channelPricingGateFor = (input: { readonly store: EventStore; readonly now: () => string }) => channelPricingGate(channelPricingAdapter(input));

// ── C21 fingerprint attendance consent ───────────────────────────────────────────────────────────────────────────

const BIOMETRIC = streamName(STREAM.workforce, 'biometric-consent');
const MARKS = streamName(STREAM.workforce, 'attendance-marks');

export function biometricConsentAdapter(input: { readonly store: EventStore; readonly now: () => string; readonly recordAudit?: Recorder }): BiometricConsentDeps {
  const { store, now } = input;
  return {
    now,
    events: (t) => all<BiometricConsentEvent>(store, t, BIOMETRIC, 'BiometricConsentRecorded'),
    recordEvent: async (t, e) => {
      await store.append(t, BIOMETRIC, makeEvent({ id: `biometric-consent-${e.eventId}`, type: 'BiometricConsentRecorded', occurredAt: e.at, idempotencyKey: `biometric-consent-${t}-${e.eventId}`, source: 'api/hr', payload: e }));
    },
    marks: async (t, date) => (await all<AttendanceMark>(store, t, MARKS, 'AttendanceMarked')).filter((m) => date === undefined || m.date === date),
    recordMark: async (t, m) => {
      await store.append(t, MARKS, makeEvent({ id: `attendance-mark-${m.markId}`, type: 'AttendanceMarked', occurredAt: m.at, idempotencyKey: `attendance-mark-${t}-${m.markId}`, source: 'api/hr', payload: m }));
    },
    employees: async (t) => (await rosterStoreAdapter({ store, now }).roster(t)).employees,
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  };
}

// ── D-9 labour demand + draft roster + actuals ───────────────────────────────────────────────────────────────────

const SCHEDULE = streamName(STREAM.workforce, 'schedule');

export function scheduleAdapter(input: { readonly store: EventStore; readonly now: () => string; readonly recordAudit?: Recorder; readonly locationBranches: LocationBranches }): ScheduleDeps {
  const { store, now } = input;
  const hr = hrComplianceAdapter({ store, now });
  const roster = rosterStoreAdapter({ store, now });
  return {
    now,
    settings: (t) => hr.settings(t),
    standards: (t) => all<ServiceStandard>(store, t, SCHEDULE, 'ServiceStandardSet'),
    recordStandard: async (t, st) => {
      await store.append(t, SCHEDULE, makeEvent({ id: `service-standard-${st.role}-${st.setAt}`, type: 'ServiceStandardSet', occurredAt: st.setAt, idempotencyKey: `service-standard-${t}-${st.role}-${st.billsPerStaffHour}-${st.setAt}`, source: 'api/hr', payload: st }));
    },
    billsAt: async (t, branchId, fromIso, toIso) => {
      const branchOf = await input.locationBranches(t);
      const out: { at: string }[] = [];
      for (const e of await store.readStream(t, STREAM.sales, { type: 'SaleCommitted', from: fromIso, to: toIso })) {
        const sale = e.event.payload as IncomingSale;
        const { locationId } = await saleStockLocationOf(store, t, sale);
        if (branchOf(locationId) === branchId) out.push({ at: sale.committedAt });
      }
      return out;
    },
    roster: (t) => Promise.resolve(roster.roster(t)),
    putShift: async (t, sh, key) => { await roster.putShift(t, sh, key); },
    putAssignment: async (t, a, key) => { await roster.putAssignment(t, a, key); },
    drafts: (t) => all<StoredDraft>(store, t, SCHEDULE, 'ScheduleDraftRecorded'),
    recordDraft: async (t, d) => {
      const state = d.committedBy === null ? 'drafted' : 'committed';
      await store.append(t, SCHEDULE, makeEvent({ id: `schedule-draft-${d.draftId}-${state}`, type: 'ScheduleDraftRecorded', occurredAt: d.committedAt ?? d.draftedAt, idempotencyKey: `schedule-draft-${t}-${d.draftId}-${state}`, source: 'api/hr', payload: d }));
    },
    marks: async (t) => (await biometricConsentAdapter({ store, now }).marks(t)),
    hours: (t, from, to) => hr.attendanceBetween(t, from, to),
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
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
    ...dsdCheckInRoutes(dsdCheckInAdapter(base)),
    ...productionPlanRoutes(productionPlanAdapter(base)),
    ...channelPricingRoutes(channelPricingAdapter(base)),
    ...biometricConsentRoutes(biometricConsentAdapter(base)),
    ...scheduleRoutes(scheduleAdapter(base)),
  ];
}
