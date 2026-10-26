// FG-3 · OB-383 — head office's wiring for withdrawing a recall started by mistake (WF-09 "cancellation").
//
// The route is `services/inventory/src/recall-withdrawal.ts`. This file gives it head office's own facts:
//   • the recall register (the same event-sourced `recallAdapter` the start and the closure use);
//   • how far the recall has gone — the customers ticked as phoned on its call list (OB-387), the customers a recall message was sent or attempted to (the append-only notice
//     attempts, `lane2-recall-adapters.ts`), and the batch's stock disposed of since the recall started (every `wasted`
//     movement — a write-off, a destruction — and every return to the supplier, on that batch);
//   • the `RecallWithdrawn` event on the recall's own stream, and the owner's recall alert cleared (kept, with history).
//
// `recallWithdrawSurface(surface, …)` is the one registration line in `main.ts`.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { RecallRegistry } from '../../../packages/traceability/src/index';
import { makeEvent } from '../../../packages/contracts/src/event';
import { recallWithdrawalRoutes, type RecallWithdrawalDeps, type RecallReach } from '../../inventory/src/recall-withdrawal';
import { STREAM, streamName, recallAdapter } from './adapters';
import { RECALL_NOTICE_STREAM, clearRecallAlert, recallPhonedTicksOf } from './lane2-recall-adapters';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;

/** Movements that take a recalled batch's stock out of the shop for good — "return/dispose" (WF-09). */
const DISPOSAL_KINDS: ReadonlySet<string> = new Set(['wasted', 'returned_to_supplier']);

/** How far the recall on `batchId` has gone since `since` (OB-383's two conditions), from head office's own records. */
export async function recallReachOf(store: EventStore, tenantId: string, batchId: string, since: string): Promise<RecallReach> {
  const contacted = new Set<string>();
  for (const e of await store.readStream(tenantId, RECALL_NOTICE_STREAM, { type: 'RecallNoticeAttempted' })) {
    const a = e.event.payload as { batchId?: string; customerRef?: string; at?: string };
    if (a.batchId === batchId && typeof a.customerRef === 'string' && (a.at ?? '') >= since) contacted.add(a.customerRef);
  }
  // OB-387: every customer on this recall's call list ticked as phoned (the recall that started at `since`).
  const phoned = new Set((await recallPhonedTicksOf(store, tenantId, batchId, since)).map((t) => t.customerRef));
  let disposed = 0;
  for (const e of await store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' })) {
    const m = e.event.payload as { kind?: string; batchId?: string; quantityMinor?: number; occurredAt?: string };
    if (m.batchId !== batchId || !DISPOSAL_KINDS.has(m.kind ?? '')) continue;
    // Recorded at head office after the recall started (a late-synced disposal counts by when it reached head office).
    if (e.event.occurredAt < since && (m.occurredAt ?? '') < since) continue;
    disposed += Math.abs(typeof m.quantityMinor === 'number' ? m.quantityMinor : 0) || 1;
  }
  return { customersContacted: contacted.size, customersPhoned: phoned.size, stockDisposed: disposed };
}

export function recallWithdrawalAdapter(input: { readonly store: EventStore; readonly now: () => string; readonly recordAudit?: Recorder }): RecallWithdrawalDeps {
  const { store, now } = input;
  const recalls = recallAdapter({ store, now });
  const stream = streamName(STREAM.inventory, 'recalls');
  return {
    now,
    registry: (tenantId) => recalls.registry(tenantId),
    reach: (tenantId, batchId, since) => recallReachOf(store, tenantId, batchId, since),
    recordWithdrawn: async (tenantId, record, key) => {
      await store.append(tenantId, stream, makeEvent({
        id: `recall-${record.batchId}-withdraw-${key}`,
        type: 'RecallWithdrawn',
        occurredAt: now(),
        idempotencyKey: `recall-${tenantId}-${record.batchId}-withdraw-${key}`,
        source: 'api/inventory',
        payload: record,
      }));
      // The owner was told when it started; the same alert is cleared, saying why (its history kept).
      await clearRecallAlert({ store, now }, tenantId, record);
    },
    recordAudit: async (tenantId, entry) => {
      if (input.recordAudit === undefined) {
        throw new Error('the audit trail is not connected, so a recall withdrawal cannot be sealed');
      }
      await input.recordAudit(tenantId, entry);
    },
  };
}

/** OB-383 on the head-office surface: the withdrawal route, beside the recall's start and closure. */
export function recallWithdrawSurface(surface: Route[], input: { readonly store: EventStore | undefined; readonly now: () => string; readonly recordAudit?: Recorder }): void {
  const { store, now } = input;
  surface.push(...recallWithdrawalRoutes(store === undefined
    ? { now, registry: () => new RecallRegistry(), reach: async () => ({ customersContacted: 0, customersPhoned: 0, stockDisposed: 0 }), recordWithdrawn: () => {}, recordAudit: () => {} }
    : recallWithdrawalAdapter({ store, now, ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }) })));
}
