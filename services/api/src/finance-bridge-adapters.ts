// OB-288 package P5 (finance bridge) — head office's wiring for the daily Tally file outbox (OB-293 · M23-FR-04 · M32-FR-04
// · D10-FR-06 · D14-FR-03), the trial balance and the cost / profit centre report (M23-FR-01), supplier advances
// (D10-FR-01), rebate accruals in the books (D10-FR-04) and the close's further checks (WF-18: output GST against the
// return, supplier advances, rebate accruals, books against the Tally files).
//
// Every register here is append-only on its own stream (hard rules #2, #6): the outbox's facts and its stored files; the
// journals are the ledger's own `JournalPosted` facts. Nothing here edits or deletes a record. Entry points registered
// from main.ts: `financeBridgeRoutes` (routes), `finBridgeJournalHooks` / `finBridgeEvidenceHooks` (spread into existing
// route deps), `finBridgeCloseChecks` (one line in the close's book checks) and `finBridgeSweep` (the worker's pass).

import { createHash } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import { InMemoryEventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import type { PostingMap } from '../../../packages/finance/src/posting';
import type { GlJournal } from '../../../packages/tally-export/src/index';
import { gstAccountsOf } from '../../../packages/tally-export/src/index';
import type { CentreAttribution, LedgerJournal } from '../../../packages/finance/src/trial-balance';
import { STREAM, streamName, financeAdapter, orgStructureAdapter, storeOfLocationResolver, alertLifecycleAdapter, effectiveGrants, rebatesAdapter, payablesAdapter, supplierMasterAdapter, approvalRequestsAdapter, periodBooksAdapter, categoryRegisterAdapter, productMasterAdapter, averageBuyingCosts } from './adapters';
import { DEPARTMENT_LINKS_STREAM } from './p1-identity-adapters';
import { currentLinks, type DepartmentLinkRecord } from '../../platform/src/org-departments';
import { departmentOfCategory } from '../../../packages/org/src/departments';
import { valueAtUnitCost } from '../../../packages/contracts/src/quantity';
import type { DepartmentCost } from '../../../packages/finance/src/trial-balance';
import { stockAdjustmentSources } from '../../finance/src/period-books';
import { OWNER_ROLE_ID } from './roles';
import { tallyExportAdapter } from './p3-procure-adapters';
import { shopDayOf } from './lane2-offline-adapters';
import { r3GstLedger } from './r3-gst-adapters';
import type { AlertLifecycleEvent } from '../../platform/src/alert-lifecycle';
import type { JournalEntry, ControlTotalCheck } from '../../finance/src/index';
import type { StoredPostingMap } from '../../finance/src/day-book';
import { tallyOutboxRoutes, foldOutbox, deadLetteredInPeriod, runTallyOutbox, type TallyOutboxDeps, type TallyOutboxFact, type TallyDayFile } from '../../finance/src/tally-outbox';
import { ledgerReportRoutes, type LedgerReportDeps } from '../../finance/src/ledger-reports';
import { supplierAdvanceRoutes, advancePositions, advancesAccount, appliedForSupplier, type SupplierAdvanceDeps, type SupplierAdvanceJournal } from '../../finance/src/supplier-advances';
import { rebateAccrualRoutes, rebateAccrualPosition, accrualAccounts, type RebateAccrualDeps, type RebateAccrualJournal } from '../../finance/src/rebate-accruals';
import type { RebateReceiptJournal } from '../../finance/src/rebate-receipts';
import type { AccountClass } from '../../finance/src/period-books';

interface Base { readonly store: EventStore; readonly now: () => string }

export const TALLY_OUTBOX_STREAM = streamName(STREAM.finance, 'tally-outbox');
export const TALLY_FILES_STREAM = streamName(STREAM.finance, 'tally-files');

const digest = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 32);
const payloads = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);
const put = async (store: EventStore, tenantId: string, stream: string, type: string, key: string, occurredAt: string, payload: unknown): Promise<void> => {
  const d = digest(key);
  await store.append(tenantId, stream, makeEvent({
    id: `${type}-${d}`, type, occurredAt, idempotencyKey: `${type}-${tenantId}-${d}`, source: 'api/finance', payload: payload as Record<string, unknown>,
  }));
};

/** Every journal on the ledger — the `JournalPosted` facts, whatever route posted them. */
const allJournals = <T = JournalEntry>(store: EventStore, tenantId: string): Promise<T[]> => payloads<T>(store, tenantId, STREAM.finance, 'JournalPosted');
const postingMapOf = async (store: EventStore, tenantId: string): Promise<StoredPostingMap | undefined> =>
  (await store.latestOfType(tenantId, STREAM.finance, 'PostingMapDefined'))?.event.payload as StoredPostingMap | undefined;
const accountClassesOf = (input: Base, tenantId: string): Promise<Readonly<Record<string, AccountClass>> | undefined> =>
  periodBooksAdapter(input).accountClasses(tenantId);

/** Raise one alert to every owner of the shop, once while it is open (the same lifecycle every owner alert rides). */
async function raiseToOwners(store: EventStore, now: () => string, tenantId: string, alertId: string, component: string, detail: string, by: string, at: string, key: string): Promise<boolean> {
  const lifecycle = alertLifecycleAdapter({ store, now });
  const owners = [...new Set((await effectiveGrants(store, tenantId)).filter((g) => g.roleId === OWNER_ROLE_ID).map((g) => g.userId))].sort();
  if (owners.length === 0) return false;
  const current = (await lifecycle.alerts(tenantId)).find((a) => a.alert.alertId === alertId);
  if (current !== undefined && current.state !== 'cleared') return false;
  const event: AlertLifecycleEvent = {
    alertId, change: 'raised', by, at,
    alert: { alertId, component, status: 'degraded', ownerUserId: owners[0]!, ownerName: owners[0]!, detail, raisedAt: at, ackDueBy: at, ...(owners.length > 1 ? { alsoToUserIds: owners.slice(1) } : {}) },
  };
  await lifecycle.recordAlertEvent(tenantId, event, `${alertId}|${key}|${current?.clearedAt ?? 'first'}`);
  return true;
}
export { raiseToOwners as finBridgeRaiseToOwners };

// ── OB-293 — the daily Tally file outbox ─────────────────────────────────────────────────────────────────────────

export function tallyOutboxAdapter(input: Base): TallyOutboxDeps {
  const { store, now } = input;
  const names = tallyExportAdapter(input);
  return {
    now, shopDayOf,
    journals: (t) => allJournals<GlJournal>(store, t),
    ledgerNames: (t) => names.ledgerNames(t),
    postingMap: (t) => postingMapOf(store, t),
    facts: (t) => payloads<TallyOutboxFact>(store, t, TALLY_OUTBOX_STREAM, 'TallyOutboxFact'),
    record: (t, fact, key) => put(store, t, TALLY_OUTBOX_STREAM, 'TallyOutboxFact', key, fact.at, fact),
    files: (t) => payloads<TallyDayFile>(store, t, TALLY_FILES_STREAM, 'TallyDayFileStored'),
    storeFile: (t, file) => put(store, t, TALLY_FILES_STREAM, 'TallyDayFileStored', `${file.postingId}|${file.sha256}`, file.builtAt, file),
    raiseDeadLetter: async (t, posting, at) => {
      await raiseToOwners(store, now, t, `tally-dead-letter:${posting.postingId}`, `Tally file ${posting.day}`,
        `The Tally file for ${posting.day} could not be made and is in the dead letter: ${posting.lastFailure ?? 'see the Tally files page'}. The shop's books are unaffected; the accountant fixes the cause and requeues the day.`,
        'system:tally-outbox', at, posting.postingId);
    },
  };
}

/** The month's dead-lettered Tally days — what the evidence pack reads (hook spread into its registration in main.ts). */
export function finBridgeEvidenceHooks(input: Base): { readonly deadLetteredInPeriod: (tenantId: string, period: string) => Promise<number> } {
  return {
    deadLetteredInPeriod: async (t, period) => deadLetteredInPeriod(foldOutbox(await payloads<TallyOutboxFact>(input.store, t, TALLY_OUTBOX_STREAM, 'TallyOutboxFact')), period),
  };
}

/** The worker's per-shop pass: the Tally outbox runs once a pass (queue the ended days, attempt the due ones). */
export function finBridgeSweep(input: Base): (tenantId: string, at: string) => Promise<number> {
  const deps = tallyOutboxAdapter(input);
  return async (tenantId) => {
    const pass = await runTallyOutbox(deps, tenantId, 'system:tally-outbox');
    return pass.posted.length + pass.deadLettered.length;
  };
}

// ── M23-FR-01 — trial balance and centres ────────────────────────────────────────────────────────────────────────

interface SaleForCentre { readonly saleId: string; readonly locationId?: string; readonly totalMinor: number; readonly lines?: readonly { readonly productId: string; readonly quantityMinor: number; readonly uom?: string }[] }
interface ReturnForCentre { readonly returnId: string; readonly originalSaleId: string | null; readonly refundMinor: number; readonly locationId?: string; readonly lines?: readonly { readonly productId: string; readonly quantityMinor: number }[] }

// ── OB-340 — which department owns a product, through its category (the organisation's department ownership) ──────

/** Product → its department now: the product's primary category, owned by a department directly or through a parent. */
export async function departmentResolver(input: Base, tenantId: string): Promise<(productId: string) => string | undefined> {
  const [records, categories, products] = await Promise.all([
    payloads<DepartmentLinkRecord>(input.store, tenantId, DEPARTMENT_LINKS_STREAM, 'DepartmentCategoriesSet'),
    categoryRegisterAdapter(input).categories(tenantId),
    productMasterAdapter(input).products(tenantId),
  ]);
  const links = currentLinks(records);
  if (links.length === 0) return () => undefined;
  const parentOf = new Map(categories.map((c) => [c.categoryId, c.parentId] as const));
  const categoryOf = new Map(products.map((p) => [p.productId, p.primaryCategoryId] as const));
  const memo = new Map<string, string | undefined>();
  return (productId) => {
    if (!memo.has(productId)) memo.set(productId, departmentOfCategory(links, (c) => parentOf.get(c) ?? null, categoryOf.get(productId) ?? null));
    return memo.get(productId);
  };
}

/** The day book's department split (spread into its registration in main.ts): each line's net to its product's department. */
export function finBridgeDayBookHooks(input: Base): { readonly departmentOf: (tenantId: string) => Promise<(productId: string) => string | undefined> } {
  return { departmentOf: (t) => departmentResolver(input, t) };
}

/**
 * OB-340: what each department's goods sold in the month cost — every line of the sales the month's day-book vouchers carry,
 * at its average buying cost as it stood at the month's close (OB-39, the profitability report's rule), less the goods the
 * month's returns brought back. A product with no average makes its department's cost "not known", by name — never zero.
 */
async function departmentCostsOf(input: Base, tenantId: string, period: string, journals: readonly LedgerJournal[]): Promise<readonly DepartmentCost[]> {
  const vouchers = journals.filter((j) => j.period === period) as (LedgerJournal & { dayBook?: { kind: string; sourceIds: readonly string[] } })[];
  const saleIds = new Set(vouchers.filter((j) => j.dayBook?.kind === 'sale').flatMap((j) => j.dayBook!.sourceIds));
  const returnIds = new Set(vouchers.filter((j) => j.dayBook?.kind === 'sale_return').flatMap((j) => j.dayBook!.sourceIds));
  if (saleIds.size === 0 && returnIds.size === 0) return [];
  const [departmentOf, { storeOf }, avg] = await Promise.all([departmentResolver(input, tenantId), storeOfLocationResolver(input, tenantId), averageBuyingCosts(input, tenantId, { throughPeriod: period })]);
  const sales = new Map((await payloads<SaleForCentre>(input.store, tenantId, STREAM.sales, 'SaleCommitted')).map((x) => [x.saleId, x] as const));
  const acc = new Map<string, { cost: number; notCosted: Set<string> }>();
  const add = (productId: string, quantityMinor: number, uom: string, storeId: string, sign: 1 | -1): void => {
    const d = departmentOf(productId);
    if (d === undefined) return;
    const a = acc.get(d) ?? { cost: 0, notCosted: new Set<string>() };
    const unit = avg.costOf(productId, storeId);
    if (unit === undefined) a.notCosted.add(productId);
    else a.cost += sign * valueAtUnitCost(quantityMinor, uom, unit);
    acc.set(d, a);
  };
  const storeOfSale = (x: SaleForCentre | undefined): string => (x?.locationId === undefined || x.locationId === '' ? 'no-branch-named' : storeOf(x.locationId));
  for (const id of saleIds) {
    const sale = sales.get(id);
    for (const l of sale?.lines ?? []) add(l.productId, l.quantityMinor, l.uom ?? 'ea', storeOfSale(sale), 1);
  }
  if (returnIds.size > 0) {
    for (const r of await payloads<ReturnForCentre>(input.store, tenantId, STREAM.returns, 'ReturnRecorded')) {
      if (!returnIds.has(r.returnId)) continue;
      const sale = r.originalSaleId === null ? undefined : sales.get(r.originalSaleId);
      const storeId = sale !== undefined ? storeOfSale(sale) : (r.locationId === undefined || r.locationId === '' ? 'no-branch-named' : storeOf(r.locationId));
      for (const l of r.lines ?? []) add(l.productId, l.quantityMinor, sale?.lines?.find((x) => x.productId === l.productId)?.uom ?? 'ea', storeId, -1);
    }
  }
  return [...acc.entries()].map(([departmentId, a]) => ({ departmentId, costMinor: a.notCosted.size > 0 ? null : a.cost, notCosted: [...a.notCosted].sort() }));
}

/** The centres the organisation has: its branches and departments (and every store head office knows). */
async function knownCentresOf(input: Base, tenantId: string): Promise<{ readonly centres: readonly { centre: string; kind: string; name: string }[]; readonly ids: ReadonlySet<string> }> {
  const nodes = await orgStructureAdapter(input).nodes(tenantId);
  const centres = nodes.filter((n) => n.kind === 'branch' || n.kind === 'department').map((n) => ({ centre: n.nodeId, kind: n.kind, name: n.name }));
  const { knownStores } = await storeOfLocationResolver(input, tenantId);
  for (const s of knownStores) if (!centres.some((c) => c.centre === s)) centres.push({ centre: s, kind: 'branch', name: s });
  return { centres, ids: new Set(centres.map((c) => c.centre)) };
}

export function ledgerReportAdapter(input: Base): LedgerReportDeps {
  const { store, now } = input;
  return {
    now,
    journals: (t) => allJournals<LedgerJournal>(store, t),
    accountClasses: (t) => accountClassesOf(input, t),
    centres: async (t) => (await knownCentresOf(input, t)).centres,
    periodState: async (t, period) => (await financeAdapter(input).periodStates(t)).get(period) ?? 'open',
    // OB-340: the organisation's departments, the revenue accounts in force, and what each department's goods cost.
    departmentFacts: async (t, period, journals) => {
      const [nodes, map, costs] = await Promise.all([orgStructureAdapter(input).nodes(t), postingMapOf(store, t), departmentCostsOf(input, t, period, journals)]);
      const revenueAccounts = [...new Set((map?.rules ?? []).filter((r) => r.kind === 'sale' || r.kind === 'sale_return').flatMap((r) => r.legs.filter((l) => l.component === 'net').map((l) => l.account)))].sort();
      return { departments: nodes.filter((n) => n.kind === 'department').map((n) => ({ departmentId: n.nodeId, name: n.name })), revenueAccounts, costs };
    },
    attributor: async (t) => {
      const { storeOf } = await storeOfLocationResolver(input, t);
      const saleStore = new Map<string, { store: string | undefined; totalMinor: number }>();
      for (const s of await payloads<SaleForCentre>(store, t, STREAM.sales, 'SaleCommitted')) {
        saleStore.set(s.saleId, { store: s.locationId === undefined || s.locationId === '' ? undefined : storeOf(s.locationId), totalMinor: s.totalMinor });
      }
      const pb = periodBooksAdapter(input);
      const adjustmentStore = new Map(stockAdjustmentSources(await pb.counts(t), await pb.writeOffs(t)).map((x) => [x.sourceId, storeOf(x.locationId)] as const));
      const returns = new Map<string, ReturnForCentre>();
      for (const r of await payloads<ReturnForCentre>(store, t, STREAM.returns, 'ReturnRecorded')) returns.set(r.returnId, r);
      const placeOfSource = (sourceKind: string, id: string): { store: string | undefined; weight: number } => {
        const bare = id.replace(/^(earn|takeback):/, '');
        if (sourceKind === 'return' || id.startsWith('takeback:')) {
          const r = returns.get(bare);
          const sale = r?.originalSaleId === null || r === undefined ? undefined : saleStore.get(r.originalSaleId);
          return { store: sale?.store, weight: Math.max(1, r?.refundMinor ?? 1) };
        }
        const sale = saleStore.get(bare);
        return { store: sale?.store, weight: Math.max(1, sale?.totalMinor ?? 1) };
      };
      return (j: LedgerJournal): CentreAttribution => {
        const g = j as LedgerJournal & {
          dayBook?: { sourceKind: string; sourceIds: readonly string[] };
          stockAdjustment?: { sourceId: string };
          fixedAsset?: { storeId?: string };
          displayFunding?: { storeId?: string };
        };
        if (g.fixedAsset?.storeId !== undefined) return { kind: 'whole', centre: g.fixedAsset.storeId, basis: 'the asset\'s store' };
        if (g.displayFunding?.storeId !== undefined) return { kind: 'whole', centre: g.displayFunding.storeId, basis: 'the display contract\'s store' };
        if (g.dayBook !== undefined) {
          const places = g.dayBook.sourceIds.map((id) => placeOfSource(g.dayBook!.sourceKind, id));
          if (places.length === 0 || places.some((p) => p.store === undefined)) return { kind: 'unassigned', reason: 'a receipt in this day-book voucher does not name the stock location it sold from, so its store is not known' };
          const byStore = new Map<string, number>();
          for (const p of places) byStore.set(p.store!, (byStore.get(p.store!) ?? 0) + p.weight);
          if (byStore.size === 1) return { kind: 'whole', centre: [...byStore.keys()][0]!, basis: 'the store every receipt in it was sold from' };
          return { kind: 'shared', shares: [...byStore.entries()].map(([centre, weightMinor]) => ({ centre, weightMinor })), basis: 'each store\'s share of the receipts it is made of' };
        }
        if (g.stockAdjustment !== undefined) {
          const at = adjustmentStore.get(g.stockAdjustment.sourceId);
          return at === undefined ? { kind: 'unassigned', reason: `the count or write-off ${g.stockAdjustment.sourceId} is no longer on the stock register` } : { kind: 'whole', centre: at, basis: 'the store of the location it was counted or written off at' };
        }
        return { kind: 'unassigned', reason: 'this journal names no store, location or centre of its own (for example a supplier bill, which is the company\'s)' };
      };
    },
  };
}

/** The centres a manual journal line may name (hook spread into the journal route's deps in main.ts). */
export function finBridgeJournalHooks(input: Base): { readonly knownCentres: (tenantId: string) => Promise<ReadonlySet<string>> } {
  return { knownCentres: async (t) => (await knownCentresOf(input, t)).ids };
}

// ── D10-FR-01 — supplier advances ────────────────────────────────────────────────────────────────────────────────

const advanceJournalsOf = async (store: EventStore, t: string): Promise<SupplierAdvanceJournal[]> =>
  (await allJournals<JournalEntry & Partial<SupplierAdvanceJournal>>(store, t)).filter((j): j is SupplierAdvanceJournal => j.supplierAdvance !== undefined);

export function supplierAdvanceAdapter(input: Base): SupplierAdvanceDeps {
  const { store, now } = input;
  const fin = financeAdapter(input);
  return {
    now, periodStates: fin.periodStates, nextOpenPeriod: fin.nextOpenPeriod, appendJournal: fin.appendJournal,
    postingMap: (t) => postingMapOf(store, t),
    advanceJournals: (t) => advanceJournalsOf(store, t),
    supplierExists: async (t, id) => (await supplierMasterAdapter(input).record(t, id)) !== undefined,
    supplierPosition: async (t, supplierId) => {
      const account = (await payablesAdapter(input).supplierAccounts(t)).find((a) => a.supplierId === supplierId);
      if (account === undefined) return { bills: [], owedMinor: 0 };
      const owedMinor = account.invoices.filter((i) => i.matched).reduce((s, i) => s + i.payableMinor, 0)
        - account.debitNotes.reduce((s, d) => s + d.valueMinor, 0) - account.payments.reduce((s, p) => s + p.amountMinor, 0)
        + (account.openings ?? []).filter((o) => o.signed && o.reversed !== true).reduce((s, o) => s + o.amountMinor, 0);
      return { bills: account.invoices.map((i) => ({ invoiceId: i.invoiceId, supplierId, payableMinor: i.payableMinor, matched: i.matched })), owedMinor };
    },
    ledgerBalance: async (t, account) => (await allJournals(store, t)).flatMap((j) => j.lines).filter((l) => l.accountCode === account).reduce((s, l) => s + l.debitMinor - l.creditMinor, 0),
    approvals: approvalRequestsAdapter(input),
  };
}

// ── D10-FR-04 — rebate accruals ──────────────────────────────────────────────────────────────────────────────────

const rebateAccrualJournalsOf = async (store: EventStore, t: string): Promise<RebateAccrualJournal[]> =>
  (await allJournals<JournalEntry & Partial<RebateAccrualJournal>>(store, t)).filter((j): j is RebateAccrualJournal => j.rebateAccrual !== undefined);
const rebateReceiptJournalsOf = async (store: EventStore, t: string): Promise<RebateReceiptJournal[]> =>
  (await allJournals<JournalEntry & Partial<RebateReceiptJournal>>(store, t)).filter((j): j is RebateReceiptJournal => j.rebateReceipt !== undefined);

export function rebateAccrualAdapter(input: Base): RebateAccrualDeps {
  const { store, now } = input;
  const fin = financeAdapter(input);
  const rebates = rebatesAdapter(input);
  return {
    now, shopDayOf, periodStates: fin.periodStates, nextOpenPeriod: fin.nextOpenPeriod, appendJournal: fin.appendJournal,
    postingMap: (t) => postingMapOf(store, t),
    schemes: (t) => rebates.schemes(t),
    accruedFor: async (t, schemeId) => (await rebates.accruals(t, schemeId)).reduce((s, a) => s + a.accrued.minor, 0),
    accrualJournals: (t) => rebateAccrualJournalsOf(store, t),
    receiptJournals: (t) => rebateReceiptJournalsOf(store, t),
  };
}

// ── WF-18 — the close's further checks ───────────────────────────────────────────────────────────────────────────

const OUTPUT_KINDS = ['sale', 'sale_return', 'b2b:invoice'];
const mmyyyy = (period: string): string => `${period.slice(5, 7)}${period.slice(0, 4)}`;

/**
 * The checks this package adds to a month's close (`bookChecksFor`, one line there): output GST in the books against the
 * GST return's figures for the same month; supplier advances on the register against the ledger; rebate accruals on the
 * register against the ledger; and, once the accountant has named the Tally ledgers, the month's books against the Tally
 * files. Each is two figures reached two different ways; a pair with nothing on either side is said, not passed.
 */
export async function finBridgeCloseChecks(input: Base, tenantId: string, period: string): Promise<{ readonly checks: readonly ControlTotalCheck[]; readonly notChecked: readonly string[] }> {
  const { store } = input;
  const checks: ControlTotalCheck[] = [];
  const notChecked: string[] = [];
  const [journals, map] = await Promise.all([allJournals<GlJournal>(store, tenantId), postingMapOf(store, tenantId)]);
  const inMonth = journals.filter((j) => j.documentDate.slice(0, 7) === period);

  // Output GST: the books against the GST return (GSTR-1's figures for the month, folded from the tills and documents).
  const outputAccounts = map === undefined ? [] : gstAccountsOf({ rules: map.rules.filter((r) => OUTPUT_KINDS.includes(r.kind)) });
  if (map === undefined || outputAccounts.length === 0) {
    notChecked.push('Output GST: the mapping names no output-tax account, so the books\' GST cannot be compared with the return.');
  } else {
    const books = inMonth.flatMap((j) => j.lines).filter((l) => outputAccounts.includes(l.accountCode)).reduce((s, l) => s + l.creditMinor - l.debitMinor, 0);
    let returned: number | undefined;
    let notOnReturn = 0;
    try {
      const month = await r3GstLedger({ store, now: input.now }).month(tenantId, mmyyyy(period), 0);
      const h = month.current.figures.total.heads;
      returned = h.cgstMinor + h.sgstMinor + h.igstMinor;
      notOnReturn = month.current.salesLedger.notOnReturn.length;
    } catch { returned = undefined; }
    if (returned === undefined) notChecked.push(`Output GST: the GST return for ${period} could not be worked out.`);
    // A sold line the return cannot carry (no HSN or rate in the catalogue) makes the two figures incomparable — said by
    // name with the count, and listed line by line on the GSTR-3B page; never compared as if the return were whole.
    else if (notOnReturn > 0) notChecked.push(`Output GST: ${notOnReturn} sold or returned line(s) of ${period} cannot be put on the GST return (no HSN or rate in the catalogue), so the books' output tax (${books} paise) cannot be compared with the return until each has one — the GSTR-3B page lists them.`);
    else if (books === 0 && returned === 0) notChecked.push(`Output GST: neither the books nor the GST return hold output tax for ${period}.`);
    else {
      checks.push({
        name: `Output GST for ${period}`, leftMinor: books, rightMinor: returned,
        leftDerivation: `finance ledger: credits less debits on the output-tax accounts (${outputAccounts.join(', ')}) for supplies dated in the month`,
        rightDerivation: 'the GST return: GSTR-1\'s CGST, SGST and IGST for the month, folded from the tills\' banked sales less returns and the outward documents',
      });
    }
  }

  // Supplier advances: what the register says is left against the advances account in the ledger, as at the month's end.
  const advances = (await advanceJournalsOf(store, tenantId)).filter((j) => j.supplierAdvance.on.slice(0, 7) <= period);
  const advAccount = advancesAccount(map);
  if (advances.length === 0) notChecked.push('Supplier advances: none paid by the end of the month.');
  else {
    const left = advancePositions(advances).reduce((s, p) => s + p.leftMinor, 0);
    const ledger = advAccount === undefined ? 0 : journals.filter((j) => j.documentDate.slice(0, 7) <= period).flatMap((j) => j.lines).filter((l) => l.accountCode === advAccount).reduce((s, l) => s + l.debitMinor - l.creditMinor, 0);
    checks.push({
      name: `Supplier advances as at the close of ${period}`, leftMinor: left, rightMinor: ledger,
      leftDerivation: 'the supplier-advance register: every advance paid with a second person\'s approval, less what was set against bills',
      rightDerivation: advAccount === undefined ? 'finance ledger: no supplier-advance account is named by the mapping in force' : `finance ledger: debits less credits on ${advAccount} across every journal to the month's end`,
    });
  }

  // Rebate accruals: the purchase register's accrual against the ledger's (only once any is posted or the rule is mapped).
  const accounts = accrualAccounts(map);
  if (accounts === undefined) notChecked.push('Rebate accruals: the mapping names no "supplier_rebate_accrual" rule, so earned rebates are not in the books yet.');
  else {
    const ra = rebateAccrualAdapter(input);
    const schemes = (await ra.schemes(tenantId)).filter((s) => s.approvedBy !== undefined);
    const accrued = new Map<string, number>();
    for (const s of schemes) accrued.set(s.schemeId, await ra.accruedFor(tenantId, s.schemeId));
    const lines = rebateAccrualPosition({ schemes, accrued, accruals: await rebateAccrualJournalsOf(store, tenantId), receipts: await rebateReceiptJournalsOf(store, tenantId), accounts });
    const reg = lines.reduce((s, l) => s + l.registerAccruedMinor, 0);
    const led = lines.reduce((s, l) => s + l.ledgerAccruedMinor, 0);
    if (reg === 0 && led === 0) notChecked.push('Rebate accruals: no approved scheme has accrued anything.');
    else checks.push({
      name: `Supplier rebates earned as at the close of ${period}`, leftMinor: reg, rightMinor: led,
      leftDerivation: 'the purchase register: what every approved rebate scheme has accrued from matched bills',
      rightDerivation: 'finance ledger: the rebate-accrual journals posted for those schemes',
    });
  }

  // Books against the Tally files — once the accountant has named the Tally ledgers (before that, the books are not sent).
  const names = await tallyExportAdapter(input).ledgerNames(tenantId);
  if (names === undefined) notChecked.push('Tally: the accountant has not named the Tally company and ledgers, so no daily file is sent yet.');
  else if (inMonth.length > 0) {
    const files = await payloads<TallyDayFile>(store, tenantId, TALLY_FILES_STREAM, 'TallyDayFileStored');
    const postings = foldOutbox(await payloads<TallyOutboxFact>(store, tenantId, TALLY_OUTBOX_STREAM, 'TallyOutboxFact'));
    const delivered = new Set(postings.filter((p) => p.state === 'posted').map((p) => p.postingId));
    const sent = files.filter((f) => delivered.has(f.postingId) && f.day.slice(0, 7) === period)
      .filter((f, i, all) => all.findIndex((g) => g.postingId === f.postingId) === i)
      .reduce((s, f) => s + f.controlTotals.debitMinor, 0);
    checks.push({
      name: `Books sent to Tally for ${period}`, leftMinor: inMonth.reduce((s, j) => s + j.lines.reduce((t, l) => t + l.debitMinor, 0), 0), rightMinor: sent,
      leftDerivation: 'finance ledger: the debits of every journal dated in the month',
      rightDerivation: 'the daily Tally files ready for the accountant: the debits their vouchers carry',
    });
  }
  return { checks, notChecked };
}

/** WF-18 / D10-FR-01: what supplier advances have taken off the payables control (spread into the payables check). */
export async function advanceApplicationsAgainstPayables(input: Base, tenantId: string, control: string | null): Promise<{ readonly registerMinor: number; readonly ledgerMinor: number }> {
  const journals = await advanceJournalsOf(input.store, tenantId);
  const suppliers = [...new Set(journals.map((j) => j.supplierAdvance.supplierId))];
  return {
    registerMinor: suppliers.reduce((s, id) => s + appliedForSupplier(journals, id), 0),
    ledgerMinor: control === null ? 0 : journals.filter((j) => j.supplierAdvance.change === 'applied').flatMap((j) => j.lines).filter((l) => l.accountCode === control).reduce((s, l) => s + l.debitMinor - l.creditMinor, 0),
  };
}

// ── the entry point ───────────────────────────────────────────────────────────────────────────────────────────────

/** Every route of this package on head office's surface. With no store, an in-memory one (the bare surface the guardrails build). */
export function financeBridgeRoutes(input: { readonly store: EventStore | undefined; readonly now: () => string }): readonly Route[] {
  const base: Base = { store: input.store ?? new InMemoryEventStore(), now: input.now };
  return [
    ...tallyOutboxRoutes(tallyOutboxAdapter(base)),
    ...ledgerReportRoutes(ledgerReportAdapter(base)),
    ...supplierAdvanceRoutes(supplierAdvanceAdapter(base)),
    ...rebateAccrualRoutes(rebateAccrualAdapter(base)),
  ];
}

/** For tests: the posting map type this package reads. */
export type { PostingMap };
