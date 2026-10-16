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
import { STREAM, streamName, writeOffAdapter, wasteAdapter, productMasterAdapter } from './adapters';
import type { WasteAnalyticsDeps } from '../../inventory/src/waste-analytics';
import type { LocationBranches } from '../../inventory/src/location-scope';
import { SlotAlreadyRecordedError, type FoodSafetyDeps } from '../../platform/src/food-safety';
import type { FoodSafetyCheck, FoodSafetyCheckRecord } from '../../../packages/facilities/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';

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
  return {
    now: input.now,
    // The latest definition of each check wins (each version is kept: append-only).
    checks: async (tenantId) => {
      const byId = new Map<string, FoodSafetyCheck>();
      for (const c of await all<FoodSafetyCheck>(input.store, tenantId, FOOD_SAFETY, 'FoodSafetyCheckDefined')) byId.set(c.checkId, c);
      return [...byId.values()];
    },
    records,
    recordCheck: async (tenantId, check, by, at) => {
      // Keyed on the definition's content: the same definition again collapses; a change is a new, latest version.
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
