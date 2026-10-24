// OB-288 package P5 (migration controls) — head office's wiring for the MG-09 export diff, the MG-10 books side of a
// parallel day and the MG-11 backup check, rollback limits and night check (`services/migration/src/migration-controls.ts`).
//
// Every register is append-only on its own stream (hard rules #2, #6): the owner's rollback limits (a new version each
// time), the raised rollback triggers, the export-diff runs and the books-side day records. The head-office figures the
// books side compares are READ from the registers that own them — the supplier bills captured, the purchase register's
// supplier accounts (less supplier advances set against them), the credit-customer ledger, the stock ledger at the
// average buying cost, and the day book — nothing is typed. Spread into the migration routes' deps in main.ts
// (`controls: migrationControlsAdapter(...)`).

import { createHash } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import { minorPerUnitOf, valueAtCost } from '../../../packages/contracts/src/quantity';
import { project, ownershipOf, type Movement } from '../../inventory/src/index';
import type { MigrationControlsDeps, ExportDiffRun, BooksDayRecord, RaisedRollbackTrigger } from '../../migration/src/migration-controls';
import type { RollbackLimits, BackupReport } from '../../../packages/migration/src/rollback-limits';
import type { HeadOfficeBooksDay } from '../../../packages/migration/src/books-comparison';
import type { CutoverGo } from '../../migration/src/opening-reversal';
import type { RecordedReceivable } from '../../finance/src/b2b-credit';
import type { StoredPostingMap } from '../../finance/src/day-book';
import { STREAM, streamName, liveSupplierInvoices, payablesAdapter, averageBuyingCosts, storeOfLocationResolver, dayBookAdapter } from './adapters';
import { shopDayOf } from './lane2-offline-adapters';
import { finBridgeRaiseToOwners } from './finance-bridge-adapters';
import { appliedForSupplier, type SupplierAdvanceJournal } from '../../finance/src/supplier-advances';

interface Base { readonly store: EventStore; readonly now: () => string }

const LIMITS = (): string => streamName(STREAM.migration, 'rollback-limits');
const TRIGGERS = (): string => streamName(STREAM.migration, 'rollback-triggers');
const DIFFS = (): string => streamName(STREAM.migration, 'export-diffs');
const BOOKS = (): string => streamName(STREAM.migration, 'books-days');

const digest = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 32);
const payloads = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);
const put = async (store: EventStore, tenantId: string, stream: string, type: string, key: string, occurredAt: string, payload: unknown): Promise<void> => {
  const d = digest(key);
  await store.append(tenantId, stream, makeEvent({ id: `${type}-${d}`, type, occurredAt, idempotencyKey: `${type}-${tenantId}-${d}`, source: 'api/migration', payload: payload as Record<string, unknown> }));
};

interface SaleForBooks { readonly saleId: string; readonly tradingDay: string; readonly locationId?: string; readonly lines: readonly { readonly productId: string; readonly quantityMinor: number; readonly uom?: string }[] }

/** What head office holds for one business date, from its own registers. A figure it cannot work out is null, said. */
async function headOfficeBooks(input: Base, tenantId: string, day: string): Promise<HeadOfficeBooksDay> {
  const { store } = input;
  const dayEnd = `${day}T23:59:59.999Z`;
  // Purchases: the supplier bills captured for the day (the paper's date, else the day it was captured), with tax.
  const purchases = (await liveSupplierInvoices(store, tenantId))
    .filter((r) => (r.supplierInvoiceDate ?? shopDayOf(r.capturedAt)) === day)
    .map((r) => ({ supplierId: r.supplierId, billNumber: r.supplierInvoiceNo ?? r.invoiceId, valueMinor: r.declaredTotalMinor }));
  // Supplier balances: the purchase register's owed, less what supplier advances have settled (D10-FR-01).
  const advances = (await payloads<{ supplierAdvance?: SupplierAdvanceJournal['supplierAdvance'] }>(store, tenantId, STREAM.finance, 'JournalPosted'))
    .filter((j): j is SupplierAdvanceJournal => j.supplierAdvance !== undefined);
  const supplierBalances = (await payablesAdapter(input).supplierAccounts(tenantId)).map((a) => ({
    supplierId: a.supplierId,
    owedMinor: a.invoices.filter((i) => i.matched).reduce((s, i) => s + i.payableMinor, 0) - a.debitNotes.reduce((s, d) => s + d.valueMinor, 0)
      - a.payments.reduce((s, p) => s + p.amountMinor, 0) + (a.openings ?? []).filter((o) => o.signed && o.reversed !== true).reduce((s, o) => s + o.amountMinor, 0)
      - appliedForSupplier(advances, a.supplierId),
  }));
  // Customer balances: the credit-customer ledger's movements up to the end of the day.
  const customers = [...new Set((await payloads<{ customerId: string }>(store, tenantId, streamName(STREAM.finance, 'b2b-postables'), 'B2BPostable')).map((p) => p.customerId))].sort();
  const customerBalances: { customerId: string; owedMinor: number }[] = [];
  for (const c of customers) {
    const moves = await payloads<RecordedReceivable>(store, tenantId, streamName(STREAM.b2b, c), 'B2BReceivableMovement');
    customerBalances.push({ customerId: c, owedMinor: moves.filter((m) => m.at <= dayEnd).reduce((s, m) => s + m.deltaMinor, 0) });
  }
  // Stock: the shop's own stock on hand at the end of the day, per product, valued at the average buying cost.
  const [{ storeOf }, avg] = await Promise.all([storeOfLocationResolver(input, tenantId), averageBuyingCosts(input, tenantId)]);
  const movements = (await store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' })).map((e) => e.event.payload as Movement)
    .filter((m) => ownershipOf(m) === 'own' && m.occurredAt <= dayEnd);
  const uomOf = new Map<string, string>();
  for (const m of movements) if (!uomOf.has(m.productId)) uomOf.set(m.productId, m.uom);
  const byProduct = new Map<string, { thousandths: number; valueMinor: number | null }>();
  for (const a of project(movements, dayEnd)) {
    if (a.onHandMinor === 0) continue;
    const uom = uomOf.get(a.productId) ?? 'ea';
    const unit = avg.costOf(a.productId, storeOf(a.locationId));
    const cur = byProduct.get(a.productId) ?? { thousandths: 0, valueMinor: 0 };
    const value = unit === undefined || cur.valueMinor === null ? null : cur.valueMinor + valueAtCost(a.onHandMinor, uom, { minor: unit });
    byProduct.set(a.productId, { thousandths: cur.thousandths + (a.onHandMinor * 1000) / minorPerUnitOf(uom), valueMinor: value });
  }
  const stock = [...byProduct.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([productId, v]) => ({ productId, ...v }));
  // Margin: the day book's sales net of tax (the accountant's sale rule's net account), and the cost of what was sold at
  // the average buying cost, less what came back.
  const db = dayBookAdapter(input);
  const journals = await db.dayBookJournals(tenantId, day);
  const map = (await store.latestOfType(tenantId, STREAM.finance, 'PostingMapDefined'))?.event.payload as StoredPostingMap | undefined;
  const netAccounts = map?.rules.find((r) => r.kind === 'sale')?.legs.filter((l) => l.side === 'credit' && l.component === 'net').map((l) => l.account) ?? [];
  const salesNetMinor = journals.length === 0 || netAccounts.length === 0 ? null
    : journals.flatMap((j) => j.lines).filter((l) => netAccounts.includes(l.accountCode)).reduce((s, l) => s + l.creditMinor - l.debitMinor, 0);
  const sales = (await db.salesOn(tenantId, day)) as unknown as readonly SaleForBooks[];
  const missing = new Set<string>();
  let cost = 0;
  for (const s of sales) {
    for (const l of s.lines) {
      const unit = avg.costOf(l.productId, storeOf(s.locationId ?? ''));
      if (unit === undefined) { missing.add(l.productId); continue; }
      cost += valueAtCost(l.quantityMinor, l.uom ?? uomOf.get(l.productId) ?? 'ea', { minor: unit });
    }
  }
  const whyNot = journals.length === 0 ? `the day book for ${day} is not posted yet, so the books hold no sales for it`
    : netAccounts.length === 0 ? 'the posting map names no sales account' : missing.size > 0 ? `head office holds no buying cost for ${[...missing].sort().join(', ')}` : undefined;
  return {
    purchases, supplierBalances, customerBalances, stock,
    margin: { salesNetMinor, costMinor: missing.size > 0 ? null : cost, ...(whyNot === undefined ? {} : { whyNot }) },
  };
}

export function migrationControlsAdapter(input: Base): MigrationControlsDeps {
  const { store, now } = input;
  return {
    rollbackLimits: async (t) => (await payloads<RollbackLimits>(store, t, LIMITS(), 'RollbackLimitsSet')).at(-1),
    recordRollbackLimits: (t, l) => put(store, t, LIMITS(), 'RollbackLimitsSet', `v${l.version}`, l.setAt, l),
    backups: (t) => payloads<BackupReport>(store, t, streamName(STREAM.platform, 'backups'), 'BackupTaken'),
    cutoverGo: async (t) => (await payloads<CutoverGo>(store, t, streamName(STREAM.migration, 'cutover-go'), 'CutoverGoRecorded'))[0],
    triggers: (t) => payloads<RaisedRollbackTrigger>(store, t, TRIGGERS(), 'RollbackTriggerRaised'),
    recordTrigger: (t, x) => put(store, t, TRIGGERS(), 'RollbackTriggerRaised', `${x.cutoverId}|${x.limit}`, x.raisedAt, x),
    raiseToOwners: async (t, alertId, component, detail, at) => { await finBridgeRaiseToOwners(store, now, t, alertId, component, detail, 'system:cutover-night-check', at, alertId); },
    exportDiffs: (t) => payloads<ExportDiffRun>(store, t, DIFFS(), 'ExportDiffRecorded'),
    recordExportDiff: (t, run) => put(store, t, DIFFS(), 'ExportDiffRecorded', run.diffId, run.at, run),
    headOfficeBooks: (t, day) => headOfficeBooks(input, t, day),
    booksDays: (t) => payloads<BooksDayRecord>(store, t, BOOKS(), 'BooksDayRecorded'),
    recordBooksDay: (t, r) => put(store, t, BOOKS(), 'BooksDayRecorded', `${r.businessDate}|${r.dayDigest}|${r.at}`, r.at, r),
  };
}
