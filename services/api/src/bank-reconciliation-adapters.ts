// The production adapters behind the bank reconciliation line-by-line view and the receivables view (U6 · M23-FR-01 ·
// M23-FR-03). Both READ the streams other adapters already write — the imported bank statements, the provider settlement
// files, the cash deposits, the credit customers' receivables — and the reconciliation's own two facts (an exception
// raised, an exception resolved) go on their own append-only stream under the contract's event names (§30.2).
// Kept in its own file so the one giant adapters file is not touched for it.

import type { EventStore, PersistedEvent } from '../../../packages/persistence/src/event-store';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';
import type { SettlementBatch } from '../../finance/src/settlement';
import type { ImportedStatement } from '../../finance/src/independent-evidence';
import { cashDepositViews } from '../../finance/src/cash-deposits';
import type { BankReconciliationDeps, BankLineException, BankLineExceptionResolved } from '../../finance/src/bank-reconciliation';
import type { ReceivablesViewDeps } from '../../finance/src/receivables-view';
import { STREAM, streamName, cashDepositAdapter, b2bCollectionsAdapter, b2bReceivableCustomers, supplierAccountAdapter } from './adapters';

const BANK_STATEMENTS = streamName(STREAM.settlement, 'bank-statements');
/** The reconciliation's own facts: `ReconciliationExceptionRaised` and `ReconciliationExceptionResolved`, append-only. */
export const BANK_RECONCILIATION = streamName(STREAM.settlement, 'bank-reconciliation');

async function payloads<T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<readonly T[]> {
  const events: readonly PersistedEvent[] = await store.readStream(tenantId, stream, { type });
  return events.map((e) => e.event.payload as T);
}

export function bankReconciliationAdapter(input: { readonly store: EventStore; readonly now: () => string; readonly calendar?: ShopCalendarOf }): Omit<BankReconciliationDeps, 'recordAudit'> {
  const deposits = cashDepositAdapter({ store: input.store, now: input.now });
  return {
    now: input.now,
    ...(input.calendar === undefined ? {} : { calendar: input.calendar }),
    statements: (t) => payloads<ImportedStatement>(input.store, t, BANK_STATEMENTS, 'BankStatementImported'),
    batches: (t) => payloads<SettlementBatch>(input.store, t, STREAM.settlement, 'SettlementBatchImported'),
    // U7 · OB-724: the supplier payments recorded on the books (SP-7c, second-person approved) — a debit line names one.
    supplierPayments: async (t) => supplierAccountAdapter({ store: input.store, now: input.now }).payments(t),
    depositViews: async (t) => cashDepositViews({ deposits: await deposits.deposits(t), cancelled: await deposits.cancellations(t), statements: await deposits.statements(t) }),
    exceptionsRaised: (t) => payloads<BankLineException>(input.store, t, BANK_RECONCILIATION, 'ReconciliationExceptionRaised'),
    exceptionsResolved: (t) => payloads<BankLineExceptionResolved>(input.store, t, BANK_RECONCILIATION, 'ReconciliationExceptionResolved'),
    recordRaised: async (t, e) => {
      await input.store.append(t, BANK_RECONCILIATION, makeEvent({
        id: `bank-exception-${e.exceptionId}`, type: 'ReconciliationExceptionRaised', occurredAt: e.raisedAt,
        // Once per exception id — a retry collapses; the route refuses a different exception under a used id by name.
        idempotencyKey: `bank-exception-${t}-${e.exceptionId}`, source: 'api/finance', payload: e,
      }));
    },
    recordResolved: async (t, r) => {
      await input.store.append(t, BANK_RECONCILIATION, makeEvent({
        id: `bank-exception-resolved-${r.exceptionId}`, type: 'ReconciliationExceptionResolved', occurredAt: r.at,
        // One resolution per exception — the first stands (hard rule #2: never edited, never replaced).
        idempotencyKey: `bank-exception-resolved-${t}-${r.exceptionId}`, source: 'api/finance', payload: r,
      }));
    },
  };
}

export function receivablesViewAdapter(input: { readonly store: EventStore; readonly now: () => string; readonly calendar?: ShopCalendarOf }): ReceivablesViewDeps {
  const collections = b2bCollectionsAdapter({ store: input.store, now: input.now });
  return {
    now: input.now,
    ...(input.calendar === undefined ? {} : { calendar: input.calendar }),
    customers: (t) => b2bReceivableCustomers(input.store, t),
    invoices: (t, c) => collections.invoices(t, c),
    outstandingMinor: (t, c) => collections.outstandingMinor(t, c),
  };
}
