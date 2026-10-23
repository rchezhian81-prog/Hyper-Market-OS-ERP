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

import type { EventStore } from '../../../packages/persistence/src/event-store';
import { InMemoryEventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { Transfer } from '../../../packages/warehouse/src/transfers';
import {
  STREAM, streamName, transfersAdapter, orgStructureAdapter, permissionsHeldBy, countPlansAdapter, stockGuardKey,
} from './adapters';
import { transferDispatchHooks } from './r3-tax-pay-adapters';
import { transferLifecycleRoutes, type TransferLifecycleDeps } from '../../inventory/src/warehouse-transfers';
import { branchOfLocationIn, type LocationBranches } from '../../inventory/src/location-scope';
import { frozenBy as countPlanFreezing } from '../../inventory/src/count-plans';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
interface Base { readonly store: EventStore; readonly now: () => string; readonly recordAudit?: Recorder }

/** PA-01-r1: which branch a stock location belongs to — the org hierarchy, read once per request (as main.ts reads it). */
const locationBranchesOf = (input: Base): LocationBranches =>
  async (tenantId) => branchOfLocationIn(await orgStructureAdapter({ store: input.store, now: input.now }).nodes(tenantId));

/** The transfers stream every transfer step is carried on (the same stream `transfersAdapter` folds). */
const TRANSFERS_STREAM = streamName(STREAM.warehouse, 'transfers');

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
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(input.store, tenantId, userId),
    recordCancelled: async (tenantId: string, transfer: Transfer, expectedStockVersion?: number) => {
      await input.store.appendBatch(tenantId, [{
        stream: TRANSFERS_STREAM,
        event: makeEvent({
          id: `transfer-cancelled-${transfer.transferId}`, type: 'TransferCancelled', occurredAt: transfer.cancelledAt ?? input.now(),
          idempotencyKey: `transfer-cancelled-${tenantId}-${transfer.transferId}`, source: 'api/inventory', payload: { transfer },
        }),
      }], expectedStockVersion === undefined ? undefined : { guard: { key: stockGuardKey(transfer.fromLocationId), expectedVersion: expectedStockVersion } });
    },
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  };
}

/** The routes this package adds to head office — one registration line in main.ts. */
export function lane2OfflineRoutes(input: { readonly store: EventStore | undefined; readonly now: () => string; readonly recordAudit?: Recorder }): readonly Route[] {
  const store = input.store ?? new InMemoryEventStore();
  const base: Base = { store, now: input.now, ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }) };
  return [
    ...transferLifecycleRoutes(transferLifecycleAdapter(base)),
  ];
}
