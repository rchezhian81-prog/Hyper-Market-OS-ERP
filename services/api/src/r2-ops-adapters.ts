// R2 store-operations wiring (roadmap v2.1 addendum D-5 · D-6 · D-7 · D-8), each register append-only on its own stream
// (hard rules #2, #6). Reads fold the streams; nothing here edits or deletes a record.
//
//   • D-5 — waste analytics read the committed write-offs and the sustainability waste records, and the product master's
//     department (primary category) for each product;
//   • D-6 — food-safety / HACCP checks: their schedule, each check as done (with its reading, result and corrective action),
//     each sealed into the tamper-evident audit chain;
//   • D-7 — price integrity: shelf / app price observations, read beside the price of record and what the till charged;
//   • D-8 — assigned store tasks: the task, the assignee's completion with its evidence.

import { createHash } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import { ConcurrencyConflictError, type EventStore } from '../../../packages/persistence/src/event-store';
import { STREAM, streamName, writeOffAdapter, wasteAdapter, productMasterAdapter, priceListAdapter, saleStockLocationOf, sopStoreAdapter, permissionsHeldBy } from './adapters';
import type { WasteAnalyticsDeps } from '../../inventory/src/waste-analytics';
import type { LocationBranches } from '../../inventory/src/location-scope';
import { SlotAlreadyRecordedError, type FoodSafetyDeps } from '../../platform/src/food-safety';
import type { FoodSafetyCheck, FoodSafetyCheckRecord } from '../../../packages/facilities/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { PriceIntegrityAgeingDeps } from '../../pricing/src/price-integrity-ageing';
import type { PriceObservation, ChargedLine } from '../../../packages/self-checkout/src/index';
import type { IncomingSale } from '../../pos/src/sale-intake';
import { locationIsItsOwnBranch } from '../../inventory/src/location-scope';
import type { AssignedTaskDeps } from '../../finance/src/assigned-tasks';
import type { ReceivingChecklistOnFile } from '../../inventory/src/goods-receipt';
import type { AssignedTask, AssignedTaskCompletion } from '../../../packages/workforce/src/assigned-tasks';

const digest = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 16);
const all = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);

// ── D-5 waste analytics ────────────────────────────────────────────────────────────────────────────────────────

export function wasteAnalyticsAdapter(input: { readonly store: EventStore; readonly now: () => string; readonly locationBranches?: LocationBranches }): WasteAnalyticsDeps {
  return {
    now: input.now,
    writeOffs: (tenantId) => writeOffAdapter(input).writeOffs(tenantId),
    wasteRecords: (tenantId) => wasteAdapter(input).records(tenantId),
    // The department of a product is the product master's primary category — the rule "units by category" uses.
    departmentOf: async (tenantId) =>
      new Map((await productMasterAdapter(input).products(tenantId)).map((p) => [p.productId, p.primaryCategoryId] as const)),
    ...(input.locationBranches === undefined ? {} : { locationBranches: input.locationBranches }),
  };
}

// ── D-6 food-safety / HACCP checks ─────────────────────────────────────────────────────────────────────────────

const FOOD_SAFETY = streamName(STREAM.facilities, 'food-safety');

export function foodSafetyAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}): FoodSafetyDeps {
  const records = (tenantId: string) => all<FoodSafetyCheckRecord>(input.store, tenantId, FOOD_SAFETY, 'FoodSafetyCheckRecorded');
  const versions = async (tenantId: string): Promise<FoodSafetyCheck[]> =>
    (await all<FoodSafetyCheck & { definedAt?: string }>(input.store, tenantId, FOOD_SAFETY, 'FoodSafetyCheckDefined'))
      .map((c) => (c.effectiveFrom !== undefined || c.definedAt === undefined ? c : { ...c, effectiveFrom: c.definedAt }));
  return {
    now: input.now,
    // The latest definition of each check is the one in force now (each version is kept: append-only).
    checks: async (tenantId) => {
      const byId = new Map<string, FoodSafetyCheck>();
      for (const c of await versions(tenantId)) byId.set(c.checkId, c);
      return [...byId.values()];
    },
    // NEW-8: every version, each stamped with when it came into force (a version stored before NEW-8: when it was defined).
    checkVersions: versions,
    records,
    recordCheck: async (tenantId, check, by, at) => {
      // Keyed on the definition's content AND when it came into force: a change is a new, latest version — even one that
      // returns to an earlier definition (A → B → A is three versions, never collapsed back into the first).
      const d = digest(JSON.stringify(check));
      await input.store.append(tenantId, FOOD_SAFETY, makeEvent({
        id: `food-safety-check-${check.checkId}-${d}`, type: 'FoodSafetyCheckDefined', occurredAt: at,
        idempotencyKey: `food-safety-check-${tenantId}-${check.checkId}-${d}`, source: 'api/platform', payload: { ...check, definedBy: by, definedAt: at },
      }));
    },
    recordRecord: async (tenantId, rec) => {
      // One record per scheduled slot, even with two people at the chiller at once: the slot's write guard is read, the
      // slot is re-checked, and the append holds only while the guard has not moved — the loser is told, never folded away.
      const slotKey = rec.slotDueAt === undefined ? undefined : `food-safety-slot:${rec.checkId}:${rec.slotDueAt}`;
      const expectedVersion = slotKey === undefined ? undefined : await input.store.guardVersion(tenantId, slotKey);
      if (slotKey !== undefined && (await records(tenantId)).some((r) => r.checkId === rec.checkId && r.slotDueAt === rec.slotDueAt)) {
        throw new SlotAlreadyRecordedError(rec.checkId, rec.slotDueAt!);
      }
      try {
        await input.store.appendBatch(tenantId, [{ stream: FOOD_SAFETY, event: makeEvent({
          id: `food-safety-record-${rec.recordId}`, type: 'FoodSafetyCheckRecorded', occurredAt: rec.performedAt,
          idempotencyKey: `food-safety-record-${tenantId}-${rec.recordId}`, source: 'api/platform', payload: rec,
        }) }], slotKey === undefined ? undefined : { guard: { key: slotKey, expectedVersion: expectedVersion! } });
      } catch (e) {
        if (e instanceof ConcurrencyConflictError) throw new SlotAlreadyRecordedError(rec.checkId, rec.slotDueAt!);
        throw e;
      }
    },
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  };
}

/**
 * OB-164: the D-6 receiving checklist recorded against a delivery — a record of a `receiving` check whose subjectRef is the
 * goods receipt id (the earliest, when more than one). Read by every goods-receipt route; head office's record, never the body.
 */
export function receivingChecklistLookup(input: { readonly store: EventStore }): (tenantId: string, grnId: string) => Promise<ReceivingChecklistOnFile | undefined> {
  return async (tenantId, grnId) => {
    const receiving = new Set((await all<FoodSafetyCheck>(input.store, tenantId, FOOD_SAFETY, 'FoodSafetyCheckDefined')).filter((c) => c.kind === 'receiving').map((c) => c.checkId));
    const rec = (await all<FoodSafetyCheckRecord>(input.store, tenantId, FOOD_SAFETY, 'FoodSafetyCheckRecorded'))
      .filter((r) => receiving.has(r.checkId) && r.subjectRef === grnId)
      .sort((a, b) => a.performedAt.localeCompare(b.performedAt))[0];
    return rec === undefined ? undefined : { recordId: rec.recordId, checkId: rec.checkId, outcome: rec.outcome, performedBy: rec.performedBy, performedAt: rec.performedAt };
  };
}

// ── D-7 price integrity: observations beside the price of record and the till's charges ────────────────────────

const PRICE_OBSERVATIONS = streamName(STREAM.pricing, 'integrity-observations');

export function priceIntegrityAgeingAdapter(input: { readonly store: EventStore; readonly now: () => string; readonly locationBranches?: LocationBranches }): PriceIntegrityAgeingDeps {
  const observations = (tenantId: string) => all<PriceObservation>(input.store, tenantId, PRICE_OBSERVATIONS, 'PriceObservationRecorded');
  return {
    now: input.now,
    observations: async (tenantId, branchId) => (await observations(tenantId)).filter((o) => o.branchId === branchId),
    observation: async (tenantId, observationId) => (await observations(tenantId)).find((o) => o.observationId === observationId),
    recordObservation: async (tenantId, obs) => {
      await input.store.append(tenantId, PRICE_OBSERVATIONS, makeEvent({
        id: `price-observation-${obs.observationId}`, type: 'PriceObservationRecorded', occurredAt: obs.observedAt,
        idempotencyKey: `price-observation-${tenantId}-${obs.observationId}`, source: 'api/pricing', payload: obs,
      }));
    },
    priceEntries: async (tenantId, productIds) => {
      const list = priceListAdapter(input);
      return (await Promise.all(productIds.map((p) => list.entries(tenantId, p)))).flat();
    },
    // The till's charges are READ from the banked sale records — the till itself is never asked or changed. A sale's store
    // is where its stock left from (the one rule banking uses), placed in its branch by the org structure.
    chargedAt: async (tenantId, branchId, fromIso, toIso) => {
      const branchOf = await (input.locationBranches ?? locationIsItsOwnBranch)(tenantId);
      const out: ChargedLine[] = [];
      for (const e of await input.store.readStream(tenantId, STREAM.sales, { type: 'SaleCommitted', from: fromIso, to: toIso })) {
        const sale = e.event.payload as IncomingSale;
        const { locationId } = await saleStockLocationOf(input.store, tenantId, sale);
        if (branchOf(locationId) !== branchId) continue;
        for (const line of sale.lines ?? []) {
          out.push({
            saleId: sale.saleId, productId: line.productId, unitPriceMinor: line.unitPriceMinor, committedAt: sale.committedAt,
            approvedOverride: line.priceOverride !== undefined && typeof line.priceOverride.approvedBy === 'string' && line.priceOverride.approvedBy !== '',
          });
        }
      }
      return out;
    },
  };
}

// ── D-8 assigned store tasks ───────────────────────────────────────────────────────────────────────────────────

const ASSIGNED_TASKS = streamName(STREAM.facilities, 'assigned-tasks');

export function assignedTaskAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}): AssignedTaskDeps {
  const completions = (tenantId: string) => all<AssignedTaskCompletion>(input.store, tenantId, ASSIGNED_TASKS, 'StoreTaskCompleted');
  return {
    now: input.now,
    // Each assignment is a version; the latest of each task is the one in force (every version is kept).
    tasks: async (tenantId) => {
      const byId = new Map<string, AssignedTask>();
      for (const t of await all<AssignedTask>(input.store, tenantId, ASSIGNED_TASKS, 'StoreTaskAssigned')) byId.set(t.taskId, t);
      return [...byId.values()];
    },
    completions,
    recordTask: async (tenantId, task) => {
      const d = digest(`${task.taskId}|${task.assignedAt}|${JSON.stringify(task)}`);
      await input.store.append(tenantId, ASSIGNED_TASKS, makeEvent({
        id: `store-task-${task.taskId}-${d}`, type: 'StoreTaskAssigned', occurredAt: task.assignedAt,
        idempotencyKey: `store-task-${tenantId}-${task.taskId}-${d}`, source: 'api/workforce', payload: task,
      }));
    },
    // One completion per task: keyed on the task, so a second completion can never be appended beside the first.
    recordCompletion: async (tenantId, c) => {
      await input.store.append(tenantId, ASSIGNED_TASKS, makeEvent({
        id: `store-task-done-${c.taskId}`, type: 'StoreTaskCompleted', occurredAt: c.doneAt,
        idempotencyKey: `store-task-done-${tenantId}-${c.taskId}`, source: 'api/workforce', payload: c,
      }));
    },
    sop: async (tenantId, sopId) => {
      const found = (await sopStoreAdapter(input).sops(tenantId)).find((s) => s.sopId === sopId);
      return found === undefined ? undefined : { title: found.title, version: found.version };
    },
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(input.store, tenantId, userId),
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  };
}
