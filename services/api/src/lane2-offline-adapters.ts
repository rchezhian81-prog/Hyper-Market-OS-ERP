// OB-288 lane 2 · package P2 — the STORE-BOX OFFLINE QUEUES on head office's side, and the daily expiry move.
//
// Head office's wiring for the work a store does with the line down and the store computer carries later (§31, P-01):
// transfer dispatch and receipt (WF-07, with the cancellation scenario), production runs and weighed runs (M11-FR-01/02),
// a production batch's quality release (M11-FR-03), food-safety / temperature records (M10-FR-02), and the automatic move
// of an expired batch to the "expired" state (M10-FR-01). Every register is append-only on its own stream (hard rules #2,
// #6); every relayed record re-runs head office's own rules over head office's own records and re-verifies the person it
// names from THEIR grants; a record that cannot be accepted is refused by name so the box keeps it as a visible exception
// (hard rule #10). Nothing here sets a price or moves money, and no AI writes anything (hard rule #5).
//
// One entry point, `lane2OfflineRoutes`, is registered from main.ts; `lane2ExpirySweep` runs on the ops-alert worker's pass.

import type { EventStore, PersistedEvent } from '../../../packages/persistence/src/event-store';
import { InMemoryEventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { makeEvent } from '../../../packages/contracts/src/event';
import { normaliseUom } from '../../../packages/contracts/src/quantity';
import type { Transfer } from '../../../packages/warehouse/src/transfers';
import {
  STREAM, streamName, transfersAdapter, orgStructureAdapter, permissionsHeldBy, countPlansAdapter, stockGuardKey,
  productionAdapter, weighedCostingAdapter, inventoryAdapter, writeOffAdapter, averageBuyingCosts,
} from './adapters';
import { tenantEntitlementResolver } from './access';
import { transferDispatchHooks } from './r3-tax-pay-adapters';
import { ingredientBatchesAt, productionPlanAdapter } from './r3-ops-adapters';
import { foodSafetyAdapter } from './r2-ops-adapters';
import { transferLifecycleRoutes, type TransferLifecycleDeps } from '../../inventory/src/warehouse-transfers';
import { syncedProductionRoutes, type SyncedProductionDeps } from '../../inventory/src/production';
import { syncedWeighedCostingRoutes, type SyncedWeighedRunDeps } from '../../inventory/src/weighed-costing';
import { syncedFoodSafetyRoutes, type SyncedFoodSafetyDeps } from '../../platform/src/food-safety';
import { expiryStateRoutes, sweepExpiredBatches, type ExpiryStateDeps, type ExpiredBatchMove } from '../../inventory/src/expiry';
import { branchOfLocationIn, type LocationBranches } from '../../inventory/src/location-scope';
import { frozenBy as countPlanFreezing } from '../../inventory/src/count-plans';
import { shopClock, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';
import { foodHandlingGateOf } from './r7d-workforce-adapters';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
interface Base { readonly store: EventStore; readonly now: () => string; readonly recordAudit?: Recorder; readonly calendar?: ShopCalendarOf }

/** PA-01-r1: which branch a stock location belongs to — the org hierarchy, read once per request (as main.ts reads it). */
const locationBranchesOf = (input: Base): LocationBranches =>
  async (tenantId) => branchOfLocationIn(await orgStructureAdapter({ store: input.store, now: input.now }).nodes(tenantId));
const withAudit = (input: Base): { recordAudit?: Recorder } => (input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit });
const people = (input: Base) => (tenantId: string, userId: string) => permissionsHeldBy(input.store, tenantId, userId);

/** The transfers stream every transfer step is carried on (the same stream `transfersAdapter` folds). */
const TRANSFERS_STREAM = streamName(STREAM.warehouse, 'transfers');
/** OB-288 lane 2: the expired-state register (M10-FR-01) — one `BatchExpired` per batch, ever. */
const EXPIRY_STATES_STREAM = streamName(STREAM.inventory, 'expiry-states');

/**
 * OB-198 · M01-FR-02 (re-audit T1): the shop's CALENDAR date for a moment, read from the tenant's own calendar (its time zone
 * from store setup — packages/calendar/src/shop-clock.ts), never a fixed +05:30 and never UTC. A best-before date, a
 * received-on date and "has this batch expired today" are calendar dates, so the trading-day cut-off does not move them;
 * a shop in another zone is dated by its own. With no calendar reader, the shop default (Asia/Kolkata).
 */
export const shopDateOf = (calendar?: ShopCalendarOf): ((iso: string, tenantId: string) => Promise<string>) => {
  const clock = shopClock(calendar);
  return (iso, tenantId) => clock.dateOf(tenantId, iso);
};

// ── WF-07: cancellation before dispatch, and the relayed dispatch / receipt ───────────────────────────────────────────

/**
 * The transfer lifecycle's deps: the SAME transfer adapter, location scope, count freeze and e-way-bill gate the direct
 * routes run on (main.ts), plus the cancellation write (a compensating `TransferCancelled` under the source's stock guard —
 * the guard a dispatch writes under) and the person check for a relayed step.
 */
export function transferLifecycleAdapter(input: Base): TransferLifecycleDeps {
  const plans = countPlansAdapter({ store: input.store, now: input.now });
  return {
    ...transfersAdapter({ store: input.store, now: input.now }),
    ...transferDispatchHooks({ store: input.store, now: input.now }),
    locationBranches: locationBranchesOf(input),
    countFreeze: async (t, l, p, k) => (await countPlanFreezing(plans, t, l, p, k))?.planId,
    permissionsOfUser: people(input),
    recordCancelled: async (tenantId: string, transfer: Transfer, expectedStockVersion?: number) => {
      await input.store.appendBatch(tenantId, [{
        stream: TRANSFERS_STREAM,
        event: makeEvent({
          id: `transfer-cancelled-${transfer.transferId}`, type: 'TransferCancelled', occurredAt: transfer.cancelledAt ?? input.now(),
          idempotencyKey: `transfer-cancelled-${tenantId}-${transfer.transferId}`, source: 'api/inventory', payload: { transfer },
        }),
      }], expectedStockVersion === undefined ? undefined : { guard: { key: stockGuardKey(transfer.fromLocationId), expectedVersion: expectedStockVersion } });
    },
    ...withAudit(input),
  };
}

// ── M11-FR-01/02/03: production, weighed runs and the quality release, relayed ─────────────────────────────────────────

/** The production deps the direct routes run on (main.ts), plus the recipes read and the person check for a relayed run. */
export function syncedProductionAdapter(input: Base): SyncedProductionDeps {
  const locationBranches = locationBranchesOf(input);
  return {
    ...productionAdapter({ store: input.store, now: input.now, entitledFeatures: tenantEntitlementResolver(input.store) }),
    locationBranches,
    ingredientBatchesAt: ingredientBatchesAt({ store: input.store, now: input.now }),
    recipes: productionPlanAdapter({ store: input.store, now: input.now, locationBranches }).recipes,
    permissionsOfUser: people(input),
    foodHandling: foodHandlingGateOf(input), // OB-502: a relayed run by a producer whose certificate was not valid is flagged
    ...withAudit(input),
  };
}

/**
 * The weighed-run deps (main.ts's), plus head office's own cost per kilogram at the store: the OB-39 average buying cost per
 * whole unit, only where the product master counts the product in kilograms — anything else is "no cost per kilo known",
 * never a guess.
 */
export function syncedWeighedRunAdapter(input: Base): SyncedWeighedRunDeps {
  const transfers = transfersAdapter({ store: input.store, now: input.now }); // its `productUom` reads the published product master
  return {
    ...weighedCostingAdapter({ store: input.store, now: input.now }),
    costPerKgAt: async (tenantId, storeId, productId) => {
      const uom = await transfers.productUom?.(tenantId, productId);
      if (uom === undefined || normaliseUom(uom) !== 'kg') return undefined;
      // OB-31: a kilogram product's quantities are grams, so what was received (grams) and what it cost give the kilo price.
      const row = (await averageBuyingCosts({ store: input.store, now: input.now }, tenantId)).rows.find((r) => r.productId === productId && r.storeId === storeId);
      return row === undefined || row.receivedMinor <= 0 ? undefined : { minor: Math.round((row.receivedValueMinor * 1000) / row.receivedMinor), currency: 'INR' };
    },
    permissionsOfUser: people(input),
    foodHandling: foodHandlingGateOf(input), // OB-502
    ...withAudit(input),
  };
}

// ── M10-FR-02: food-safety / temperature records, relayed ──────────────────────────────────────────────────────────────

export function syncedFoodSafetyAdapter(input: Base): SyncedFoodSafetyDeps {
  return { ...foodSafetyAdapter({ store: input.store, now: input.now, ...withAudit(input) }), permissionsOfUser: people(input) };
}

// ── M10-FR-01: the expired state ───────────────────────────────────────────────────────────────────────────────────────

export function expiryStateAdapter(input: Base): ExpiryStateDeps {
  const inv = inventoryAdapter({ store: input.store, now: input.now });
  const writeOffs = writeOffAdapter({ store: input.store, now: input.now });
  return {
    now: input.now,
    shopDayOf: shopDateOf(input.calendar),
    locationBranches: locationBranchesOf(input),
    moves: async (tenantId) => (await input.store.readStream(tenantId, EXPIRY_STATES_STREAM, { type: 'BatchExpired' }))
      .map((e: PersistedEvent) => e.event.payload as ExpiredBatchMove),
    batches: async (tenantId) => inv.batches === undefined ? [] : inv.batches(tenantId),
    writeOffs: async (tenantId) => (await writeOffs.writeOffs(tenantId)).map((w) => ({ id: w.id, productId: w.productId, locationId: w.locationId, batchId: w.batchId ?? null, qtyRemoved: w.qtyRemoved, at: w.at })),
    // One event per batch, ever: keyed on the batch's place, product and id, so a second sweep — the same day, a restart,
    // two processes — records nothing new (append-only, hard rule #2). One atomic write per sweep.
    recordMoves: async (tenantId, moves) => {
      await input.store.appendBatch(tenantId, moves.map((m) => ({
        stream: EXPIRY_STATES_STREAM,
        event: makeEvent({
          id: `batch-expired-${m.locationId}-${m.productId}-${m.batchId ?? 'none'}`, type: 'BatchExpired', occurredAt: m.movedAt,
          idempotencyKey: `batch-expired-${tenantId}-${m.locationId}-${m.productId}-${m.batchId ?? 'none'}`, source: 'api/inventory/expiry-sweep', payload: m,
        }),
      })));
    },
    ...withAudit(input),
  };
}

/**
 * The ops-alert worker's daily expiry move (M10-FR-01): once per shop day per shop, appends the day's `BatchExpired` facts.
 * Answers how many batches moved. A restart runs it once more that day, which moves nothing new (every move is keyed).
 */
export function lane2ExpirySweep(input: { readonly store: EventStore; readonly now: () => string; readonly calendar?: ShopCalendarOf }): (tenantId: string, at: string) => Promise<number> {
  const deps = expiryStateAdapter(input);
  const sweptOn = new Map<string, string>();
  return async (tenantId, at) => {
    const day = await deps.shopDayOf(at, tenantId);
    if (sweptOn.get(tenantId) === day) return 0;
    const moved = await sweepExpiredBatches(deps, tenantId, at);
    sweptOn.set(tenantId, day);
    return moved.length;
  };
}

/** The routes this package adds to head office — one registration line in main.ts. */
export function lane2OfflineRoutes(input: { readonly store: EventStore | undefined; readonly now: () => string; readonly recordAudit?: Recorder; readonly calendar?: ShopCalendarOf }): readonly Route[] {
  const store = input.store ?? new InMemoryEventStore();
  const base: Base = { store, now: input.now, ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }), ...(input.calendar === undefined ? {} : { calendar: input.calendar }) };
  return [
    ...transferLifecycleRoutes(transferLifecycleAdapter(base)),
    ...syncedProductionRoutes(syncedProductionAdapter(base)),
    ...syncedWeighedCostingRoutes(syncedWeighedRunAdapter(base)),
    ...syncedFoodSafetyRoutes(syncedFoodSafetyAdapter(base)),
    ...expiryStateRoutes(expiryStateAdapter(base)),
  ];
}
