// OB-676 (owner, 2 Nov 2026, in writing) — head office's wiring for two of the three values that were written in code and
// now are the owner's to confirm on screen: which roles staff each delivery-exception queue (the driver cash hand-over limit
// is wired with the delivery package, fulfilment-delivery-adapters.ts), and the concessionaire's own login's reads
// (M27-FR-02 "only the concessionaire accesses it").
//
// Every register here is append-only on its own stream (hard rules #2 #6): a staffing version is a new record keyed on its
// number; nothing is edited or deleted.

import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { STREAM, streamName, concessionAdapter, concessionaireBoundTo, ownedStockRows } from './adapters';
import { concessionInvoiceAdapter } from './finance-bridge-adapters';
import type { ConcessionContract } from '../../../packages/concession/src/index';
import type { ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';
import type { ConcessionPortalDeps } from '../../finance/src/concession-portal';
import { ROLE_CATALOGUE } from './roles';
import { QUEUES_STAFFED_BY } from '../../orders/src/exception-ownership';
import {
  queueStaffingStanding, staffingFromRoleMap, type QueueStaffing, type QueueStaffingDeps, type QueueStaffingStanding, type QueueStaffingVersion,
} from '../../orders/src/exception-queue-staffing';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;

const STAFFING_STREAM = streamName(STREAM.orders, 'exception-queue-staffing');

/** The roles that may work delivery exceptions at all — the only ones a queue may name (least privilege). */
export const ROLES_THAT_MAY_WORK_EXCEPTIONS: readonly string[] = Object.freeze(
  ROLE_CATALOGUE.filter((r) => r.permissions.includes('order.exception.work')).map((r) => r.id).sort(),
);

/** The starting suggestion — the map the code ran on before OB-676, as queue → roles (only roles that may work them). */
export const SUGGESTED_QUEUE_STAFFING: QueueStaffing = staffingFromRoleMap(QUEUES_STAFFED_BY, ROLES_THAT_MAY_WORK_EXCEPTIONS);

const versionsOf = async (store: EventStore, tenantId: string): Promise<QueueStaffingVersion[]> =>
  (await store.readStream(tenantId, STAFFING_STREAM, { type: 'ExceptionQueueStaffingConfirmed' }))
    .map((e) => e.event.payload as unknown as QueueStaffingVersion)
    .sort((a, b) => a.version - b.version);

export function queueStaffingAdapter(input: { readonly store: EventStore; readonly now: () => string; readonly recordAudit?: Recorder }): QueueStaffingDeps {
  return {
    suggested: SUGGESTED_QUEUE_STAFFING,
    rolesThatMayWork: ROLES_THAT_MAY_WORK_EXCEPTIONS,
    now: input.now,
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
    versions: (t) => versionsOf(input.store, t),
    recordVersion: async (t, v) => {
      await input.store.append(t, STAFFING_STREAM, makeEvent({
        id: `exception-queue-staffing-v${v.version}`, type: 'ExceptionQueueStaffingConfirmed', occurredAt: v.at,
        idempotencyKey: `exception-queue-staffing-${t}-v${v.version}`, source: 'api/orders', payload: v as unknown as Record<string, unknown>,
      }));
    },
  };
}

/** The staffing in force for the exception routes (the owner's latest version, else the suggestion, unconfirmed). */
export function queueStaffingOf(input: { readonly store: EventStore }): (tenantId: string) => Promise<QueueStaffingStanding> {
  return async (t) => queueStaffingStanding(SUGGESTED_QUEUE_STAFFING, await versionsOf(input.store, t));
}

// ── M27-FR-02 · OB-676: the concessionaire's own login ──────────────────────────────────────────────────────────────────

const CONCESSION_CONTRACT_INDEX = streamName(STREAM.concession, 'contracts', 'index');

/** Everything the concessionaire's own reads need — each scoped by the route to the login's bound concessionaire. */
export function concessionPortalAdapter(input: { readonly store: EventStore; readonly now: () => string; readonly recordAudit?: Recorder; readonly calendar?: ShopCalendarOf }): ConcessionPortalDeps {
  const { store, now } = input;
  const concessions = concessionAdapter({ store, now });
  return {
    now,
    ...(input.calendar === undefined ? {} : { calendar: input.calendar }),
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
    boundConcessionaire: (t, userId) => concessionaireBoundTo(store, t, userId),
    contracts: async (t) => {
      const ids = [...new Set((await store.readStream(t, CONCESSION_CONTRACT_INDEX, { type: 'ConcessionContractIndexed' })).map((e) => (e.event.payload as { contractId: string }).contractId))].sort();
      const out: ConcessionContract[] = [];
      for (const id of ids) { const c = await concessions.contract(t, id); if (c !== undefined) out.push(c); }
      return out;
    },
    sales: async (t, contractId) => concessions.sales(t, contractId),
    depositMovements: async (t, id) => concessions.depositMovements(t, id),
    stockOwnedBy: async (t, concessionaireId) => (await ownedStockRows(store, t))
      .filter((r) => r.ownership === 'concession' && r.ownerId === concessionaireId && r.onHandMinor !== 0)
      .map((r) => ({ productId: r.productId, locationId: r.locationId, onHandMinor: r.onHandMinor, valueMinor: r.valueMinor })),
    invoices: (t) => concessionInvoiceAdapter({ store, now }).invoices(t),
  };
}
