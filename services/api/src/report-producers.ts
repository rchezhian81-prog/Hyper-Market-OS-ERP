// Head office's named report producers (audit EA-06 · EA-05 · M29-FR-01/02 · D13 · P-08).
//
// The report hub listed every report D13 names, and the cloud route answered EVERY name with the dashboard's sales
// figures — "Stock on hand" came back as today's takings. Each producer here reads the GOVERNED source records head
// office holds (the sales ledger, the stock ledger through the inventory engine, the purchase-order register, the
// loyalty points ledger) and returns three things that must agree:
//
//   • the figures, each stamped with its SOURCE's freshness (EA-01), never the read time;
//   • the rows behind them, in the report's declared columns;
//   • for each money/count figure, the source transactions it is the sum of — so a drill reaches the immutable record
//     that made the number (EA-05), and the reconciliation tests can assert report = Σ source.
//
// A report is registered as produced ONLY here, in `PRODUCED_AT_HEAD_OFFICE`, and only when it returns governed source
// rows. Read-only by construction: nothing in this file appends an event (the AI and reporting never write — rule #5).

import type { EventStore, PersistedEvent } from '../../../packages/persistence/src/event-store';
import { tradingDayIn, tradingDayWindow, type TradingCalendar } from '../../../packages/calendar/src/index';
import { tenderSplit } from '../../../packages/reporting/src/index';
import type { SourceTransaction } from '../../../packages/owner-control/src/index';
import type { BranchScope } from '../../kernel/src/index';
import type { IncomingSale } from '../../pos/src/sale-intake';
import { figure, sourceFreshness, syncedThrough, type Figure, type SourceFreshness } from '../../reporting/src/index';
import { STREAM, streamName, inventoryAdapter, productMasterAdapter, foldPurchaseOrders, mergeStoreSync, dayBookAdapter, independentEvidenceAdapter, payablesAdapter, averageBuyingCosts, type StoreSyncView } from './adapters';
import { valueAtUnitCost } from '../../../packages/contracts/src/quantity';
import type { HeldVersionsReport } from '../../platform/src/store-packs';
import { returnedValue, refundLegs } from '../../../packages/finance/src/day-book';

/** The report ids head office can work out from its own records — each a `case` in `produce` below. */
export const PRODUCED_AT_HEAD_OFFICE: readonly string[] = Object.freeze([
  'sales_by_day', 'tender_mix', 'sales_by_cashier', 'units_by_category', 'stock_on_hand', 'purchases_by_supplier', 'loyalty',
  // Round 4: from the posted day book, the imported settlement and bank files, and what each store computer reports.
  'gst', 'reconciliation', 'profitability', 'sync_health', 'data_freshness',
]);

/**
 * Round 4 (P-08): each store computer's LATEST report to head office (`POST /v1/store-packs/:storeId/held`) — what it trades
 * on and how many records it still holds unsent (PA-04). The only thing head office knows about a box's queue is what the
 * box says; a store that has never reported is absent, never "0 unsent".
 */
export async function latestStoreReports(store: EventStore, tenantId: string): Promise<ReadonlyMap<string, HeldVersionsReport>> {
  const latest = new Map<string, HeldVersionsReport>();
  for (const e of await store.readStream(tenantId, streamName(STREAM.org, 'store-held-versions'), { type: 'StoreHeldVersionsReported' })) {
    const r = e.event.payload as HeldVersionsReport;
    const held = latest.get(r.storeId);
    if (held === undefined || Date.parse(r.reportedAt) >= Date.parse(held.reportedAt)) latest.set(r.storeId, r);
  }
  return latest;
}

/**
 * Round 4 (P-08): the moment every store behind these sales sources last said it had NOTHING unsent, after its newest
 * record here — so an old figure is old because nothing new happened. `undefined` when any source cannot vouch for that.
 */
export function nothingUnsentAtFor(reports: ReadonlyMap<string, HeldVersionsReport>, sources: readonly { readonly source: string; readonly lastEventAt: string | null }[]): string | undefined {
  if (sources.length === 0) return undefined;
  let earliest: string | undefined;
  for (const s of sources) {
    if (!s.source.startsWith('store:') || s.lastEventAt === null) return undefined;
    const r = reports.get(s.source.slice('store:'.length));
    if (r === undefined || r.unsentItems !== 0 || Date.parse(r.reportedAt) < Date.parse(s.lastEventAt)) return undefined;
    if (earliest === undefined || Date.parse(r.reportedAt) < Date.parse(earliest)) earliest = r.reportedAt;
  }
  return earliest;
}

/** What a head-office producer hands back. */
export interface ProducedReport {
  readonly figures: readonly Figure[];
  readonly rows: readonly Readonly<Record<string, string>>[];
  readonly sources: readonly SourceFreshness[];
  /** Figure name → the source transactions it is the exact sum of (the governed drill, EA-05). */
  readonly drill: Readonly<Record<string, readonly SourceTransaction[]>>;
  /** The trading day a day-report covers; absent for a position report (stock on hand, loyalty outstanding). */
  readonly tradingDay?: string;
}

export interface ProduceOptions {
  /** The shop's trading day to report (YYYY-MM-DD); absent = today, by the shop's own calendar. */
  readonly tradingDay?: string;
  /** The branches the reader holds the report permission for — the SERVER's answer (§28 · EA-03). */
  readonly scope: BranchScope;
}

export interface ReportProducers {
  readonly produced: readonly string[];
  produce(tenantId: string, reportId: string, options: ProduceOptions): Promise<ProducedReport>;
}

interface LoyaltyRuleLike { readonly pointValuePaise: number }

const LOYALTY_MEMBERS = (): string => streamName(STREAM.loyalty, 'members');
const PURCHASE_ORDERS = (): string => streamName(STREAM.purchase, 'orders');

/** Where a sale came from: the store location its lane sells from, else the lane (EA-01). */
export const saleSourceOf = (s: IncomingSale): string =>
  (typeof s.locationId === 'string' && s.locationId !== '' ? `store:${s.locationId}` : `lane:${s.laneId}`);

/** The branch a sale belongs to for scope: its store location. A sale with none belongs to no branch a scope can name. */
const saleBranch = (s: IncomingSale): string => (typeof s.locationId === 'string' && s.locationId !== '' ? s.locationId : 'no-branch-named');

const inScope = (scope: BranchScope, branchId: string): boolean => scope === 'all' || scope.includes(branchId);

const primaryTender = (s: IncomingSale): string =>
  (s.tenders.length === 0 ? 'unrecorded' : [...s.tenders].sort((a, b) => b.amountMinor - a.amountMinor)[0]!.kind);

const newestOf = (times: readonly string[]): string | null =>
  (times.length === 0 ? null : times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)));

export function reportProducers(input: {
  readonly store: EventStore;
  readonly now: () => string;
  readonly calendar: (tenantId: string) => Promise<TradingCalendar> | TradingCalendar;
  readonly loyaltyRule: (tenantId: string) => Promise<LoyaltyRuleLike> | LoyaltyRuleLike;
  readonly thresholds?: { readonly laggingAfterMinutes: number; readonly staleAfterMinutes: number };
  /** EA-01 (round 4): the store computers' own sync reports — a store's sales are as at the later of its newest sale and its box's watermark. */
  readonly storeSync?: (tenantId: string) => Promise<StoreSyncView>;
}): ReportProducers {
  const thresholds = input.thresholds ?? {};
  const inventory = inventoryAdapter({ store: input.store, now: input.now });
  const products = productMasterAdapter({ store: input.store, now: input.now });

  /** The day's sales head office holds, within the reader's scope, and every source's watermark (EA-01). */
  const salesOf = async (tenantId: string, day: string, scope: BranchScope) => {
    const calendar = await input.calendar(tenantId);
    const window = tradingDayWindow(day, calendar);
    const events = await input.store.readStream(tenantId, STREAM.sales, { type: 'SaleCommitted', from: window.from, to: window.to });
    const latestEver = await input.store.latestOfType(tenantId, STREAM.sales, 'SaleCommitted');
    const newest = new Map<string, string>();
    const note = (e: PersistedEvent): void => {
      const s = e.event.payload as IncomingSale;
      if (!inScope(scope, saleBranch(s))) return;
      const src = saleSourceOf(s);
      const held = newest.get(src);
      if (held === undefined || Date.parse(e.event.occurredAt) > Date.parse(held)) newest.set(src, e.event.occurredAt);
    };
    for (const e of events) note(e);
    if (latestEver !== undefined) note(latestEver);
    const all = events.map((e) => e.event.payload as IncomingSale).filter((s) => s.tradingDay === day);
    const visible = all.filter((s) => inScope(scope, saleBranch(s)));
    const now = input.now();
    const marks = [...newest.entries()].map(([source, lastEventAt]) => ({ source, lastEventAt }));
    const sources = input.storeSync !== undefined
      ? mergeStoreSync(marks, await input.storeSync(tenantId), now, thresholds, scope)
      : newest.size === 0
        ? [sourceFreshness({ source: 'any till', domain: 'sales', lastEventAt: null, now, ...thresholds })]
        : [...newest.entries()].sort((a, b) => a[0].localeCompare(b[0]))
          .map(([source, at]) => sourceFreshness({ source, domain: 'sales', lastEventAt: at, now, ...thresholds }));
    // As current as the stalest source that has a time; `null` when nothing has ever arrived (the figures then refuse,
    // never ₹0). With the store computers' reports (EA-01 round 4) a store's time is its last complete sync.
    const timed = sources.map(syncedThrough).filter((t): t is string => t !== null);
    const asAt = timed.length === 0 ? null : timed.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
    const nothingUnsentAt = nothingUnsentAtFor(await latestStoreReports(input.store, tenantId), marks);
    return { sales: visible, withheld: all.length - visible.length, sources, asAt, nothingUnsentAt };
  };

  /**
   * Round 4 (M29 · P-08): the day's RETURNS, exactly as the day book reads them (by the day they were processed, each with
   * the value of any points it gave back — OB-34), within the reader's scope. A return belongs to the branch its bill was
   * sold at (or, with no bill, where its goods went back). Shown BESIDE "Taken" — never folded into it.
   */
  const returnsOf = async (tenantId: string, day: string, scope: BranchScope) => {
    const all = await dayBookAdapter({ store: input.store, now: input.now }).returnsOn(tenantId, day);
    const out: { returnId: string; at: string; branchId: string; by: string; valueMinor: number; legs: readonly { kind: string; amountMinor: number }[]; saleId: string | null }[] = [];
    for (const r of all) {
      const rec = r as typeof r & { processedAt: string; processedBy: string; locationId?: string };
      let branchId = rec.locationId ?? 'no-branch-named';
      if (r.originalSaleId !== null) {
        const held = await input.store.findByIdempotencyKey(tenantId, `sale-${tenantId}-${r.originalSaleId}`);
        if (held !== undefined) branchId = saleBranch(held.event.payload as IncomingSale);
      }
      if (!inScope(scope, branchId)) continue;
      out.push({ returnId: r.returnId, at: rec.processedAt, branchId, by: rec.processedBy, valueMinor: returnedValue(r), legs: refundLegs(r), saleId: r.originalSaleId });
    }
    return out;
  };
  const returnTxn = (r: { returnId: string; at: string; branchId: string; by: string; saleId: string | null }, amountMinor: number, description: string): SourceTransaction => ({
    transactionId: r.returnId, at: r.at, branchId: r.branchId, staffId: r.by, amountMinor, description,
  });

  const at = (asAt: string | null, never: string, nothingUnsentAt?: string) => (name: string, valueMinor: number | undefined, unit: Figure['unit'], because?: string): Figure =>
    figure({
      name, unit, asAt, now: input.now(), ...thresholds, ...(nothingUnsentAt === undefined ? {} : { nothingUnsentAt }),
      ...(asAt === null ? { notAvailableBecause: never } : because !== undefined ? { notAvailableBecause: because } : valueMinor === undefined ? {} : { valueMinor }),
    });

  const saleTxn = (s: IncomingSale, amountMinor: number, description: string): SourceTransaction => ({
    transactionId: s.saleId, at: s.committedAt, branchId: saleBranch(s), staffId: s.cashierId, amountMinor, description,
  });

  const withheldFigure = (mk: ReturnType<typeof at>, withheld: number): Figure[] =>
    (withheld === 0 ? [] : [mk('Bills outside your branches (not in these figures)', withheld, 'count')]);

  const produce = async (tenantId: string, reportId: string, options: ProduceOptions): Promise<ProducedReport> => {
    const calendar = await input.calendar(tenantId);
    const day = options.tradingDay ?? tradingDayIn(input.now(), calendar);
    const neverSales = 'no till has ever sent a sale to head office, so there is nothing to report yet';

    switch (reportId) {
      case 'sales_by_day': {
        const { sales, withheld, sources, asAt, nothingUnsentAt } = await salesOf(tenantId, day, options.scope);
        const mk = at(asAt, neverSales, nothingUnsentAt);
        const taken = sales.reduce((t, s) => t + s.totalMinor, 0);
        // Round 4: what came back the same day, valued as the day book values it, and the takings net of it — "Taken"
        // keeps its meaning (what the bills took); the returns and the net are shown beside it.
        const returns = await returnsOf(tenantId, day, options.scope);
        const returned = returns.reduce((t, r) => t + r.valueMinor, 0);
        const saleTxns = sales.map((s) => saleTxn(s, s.totalMinor, `bill ${s.receiptNumber}`));
        const returnTxns = returns.map((r) => returnTxn(r, r.valueMinor, `return ${r.returnId}${r.saleId === null ? ' (no bill)' : ` against ${r.saleId}`}`));
        return {
          tradingDay: day, sources,
          figures: [
            mk('Taken', taken, 'minor_currency'), mk('Bills', sales.length, 'count'),
            mk('Returned', returned, 'minor_currency'), mk('Returns', returns.length, 'count'),
            mk('Taken net of returns', taken - returned, 'minor_currency'),
            ...withheldFigure(mk, withheld),
          ],
          rows: sales.map((s) => ({ saleId: s.saleId, at: s.committedAt, totalMinor: String(s.totalMinor), tender: primaryTender(s) })),
          drill: {
            Taken: saleTxns,
            Returned: returnTxns,
            'Taken net of returns': [...saleTxns, ...returnTxns.map((t) => ({ ...t, amountMinor: -t.amountMinor }))],
          },
        };
      }

      case 'tender_mix': {
        // Each payment under its own kind by its own amount (EA-02); a bill counts once under each kind it used.
        const { sales, withheld, sources, asAt, nothingUnsentAt } = await salesOf(tenantId, day, options.scope);
        const mk = at(asAt, neverSales, nothingUnsentAt);
        const totals = new Map<string, { total: number; bills: number; txns: SourceTransaction[] }>();
        for (const s of sales) {
          for (const [kind, minor] of Object.entries(tenderSplit({ totalMinor: s.totalMinor, tender: primaryTender(s), tenders: s.tenders }))) {
            const held = totals.get(kind) ?? { total: 0, bills: 0, txns: [] };
            held.total += minor; held.bills += 1; held.txns.push(saleTxn(s, minor, `bill ${s.receiptNumber} — ${kind}`));
            totals.set(kind, held);
          }
        }
        const ordered = [...totals.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        // Round 4: how each return's value left the shop — by the tender it was refunded in (OB-34: a points share
        // goes back as points) — shown beside what came in, as "refunded — <kind>".
        const refunds = new Map<string, { total: number; txns: SourceTransaction[] }>();
        for (const r of await returnsOf(tenantId, day, options.scope)) {
          for (const leg of r.legs) {
            const held = refunds.get(leg.kind) ?? { total: 0, txns: [] };
            held.total += leg.amountMinor; held.txns.push(returnTxn(r, leg.amountMinor, `return ${r.returnId} — ${leg.kind}`));
            refunds.set(leg.kind, held);
          }
        }
        const refunded = [...refunds.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        return {
          tradingDay: day, sources,
          figures: [
            ...ordered.map(([kind, t]) => mk(kind, t.total, 'minor_currency')),
            ...refunded.map(([kind, t]) => mk(`refunded — ${kind}`, t.total, 'minor_currency')),
            ...withheldFigure(mk, withheld),
          ],
          rows: ordered.map(([kind, t]) => ({ key: kind, totalMinor: String(t.total), bills: String(t.bills) })),
          drill: Object.fromEntries([...ordered.map(([kind, t]) => [kind, t.txns]), ...refunded.map(([kind, t]) => [`refunded — ${kind}`, t.txns])]),
        };
      }

      case 'sales_by_cashier': {
        const { sales, withheld, sources, asAt, nothingUnsentAt } = await salesOf(tenantId, day, options.scope);
        const mk = at(asAt, neverSales, nothingUnsentAt);
        const by = new Map<string, IncomingSale[]>();
        for (const s of sales) by.set(s.cashierId, [...(by.get(s.cashierId) ?? []), s]);
        const ordered = [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        return {
          tradingDay: day, sources,
          figures: [...ordered.map(([who, list]) => mk(who, list.reduce((t, s) => t + s.totalMinor, 0), 'minor_currency')), ...withheldFigure(mk, withheld)],
          rows: ordered.map(([who, list]) => ({ key: who, totalMinor: String(list.reduce((t, s) => t + s.totalMinor, 0)), bills: String(list.length) })),
          drill: Object.fromEntries(ordered.map(([who, list]) => [who, list.map((s) => saleTxn(s, s.totalMinor, `bill ${s.receiptNumber}`))])),
        };
      }

      case 'units_by_category': {
        // Units per department — the same figure the store box gives — and, because head office holds what the till
        // charged on every LINE, the money per department beside it as "<department> — taken". A product the master
        // places nowhere is counted under its own name, never folded into one; what the bills took that no line
        // explains is shown, so the departments' money always adds back to the day's takings.
        const { sales, withheld, sources, asAt, nothingUnsentAt } = await salesOf(tenantId, day, options.scope);
        const mk = at(asAt, neverSales, nothingUnsentAt);
        const master = new Map((await products.products(tenantId)).map((p) => [p.productId, p.primaryCategoryId] as const));
        const NONE = 'in no department';
        const by = new Map<string, { units: number; money: number; txns: SourceTransaction[] }>();
        let lineMoney = 0;
        for (const s of sales) {
          for (const [i, line] of s.lines.entries()) {
            const dept = master.get(line.productId) ?? null;
            const key = dept === null ? NONE : dept;
            const held = by.get(key) ?? { units: 0, money: 0, txns: [] };
            held.units += line.uom === 'ea' ? line.quantityMinor : 1;
            held.money += line.lineTotalMinor;
            held.txns.push({ ...saleTxn(s, line.lineTotalMinor, `bill ${s.receiptNumber} line ${i + 1} — ${line.productId}`), transactionId: `${s.saleId}#${i + 1}`, categoryId: key });
            by.set(key, held);
            lineMoney += line.lineTotalMinor;
          }
        }
        const billMoney = sales.reduce((t, s) => t + s.totalMinor, 0);
        const ordered = [...by.entries()].sort((a, b) => b[1].units - a[1].units || a[0].localeCompare(b[0]));
        return {
          tradingDay: day, sources,
          figures: [
            ...ordered.map(([dept, t]) => mk(dept, t.units, 'count')),
            ...ordered.map(([dept, t]) => mk(`${dept} — taken`, t.money, 'minor_currency')),
            ...(billMoney === lineMoney ? [] : [mk('Taken but on no line', billMoney - lineMoney, 'minor_currency')]),
            ...withheldFigure(mk, withheld),
          ],
          rows: ordered.map(([dept, t]) => ({ department: dept, units: String(t.units) })),
          drill: Object.fromEntries(ordered.map(([dept, t]) => [`${dept} — taken`, t.txns])),
        };
      }

      case 'stock_on_hand': {
        // Read through the inventory engine (Batch 2's projection and weighted-average valuation) — never re-folded here.
        const valuation = (await inventory.valuation(tenantId)).filter((v) => inScope(options.scope, v.locationId) && v.onHandMinor !== 0);
        const latest = await input.store.latestOfType(tenantId, STREAM.inventory, 'InventoryMoved');
        const asAt = latest?.event.occurredAt ?? null;
        const now = input.now();
        const mk = at(asAt, 'no stock movement has ever been recorded at head office');
        const value = valuation.reduce((t, v) => t + v.value.minor, 0);
        const unvalued = valuation.filter((v) => v.unvaluedMinor > 0).length;
        return {
          sources: [sourceFreshness({ source: 'stock ledger', domain: 'stock', lastEventAt: asAt, now, ...thresholds })],
          figures: [
            mk('Value on hand', value, 'minor_currency'),
            mk('Product lines held', valuation.length, 'count'),
            // Stock that arrived with no cost is held but NOT in the value — said beside it, never folded in as zero.
            mk('Lines with stock at no known cost', unvalued, 'count'),
          ],
          rows: valuation.map((v) => ({
            productId: v.productId, locationId: v.locationId, onHandMinor: String(v.onHandMinor), valueMinor: String(v.value.minor),
            unitCostMinor: v.unitCostMinor === 'not_known' ? 'not known' : String(v.unitCostMinor),
          })),
          drill: {
            'Value on hand': valuation.map((v) => ({
              transactionId: `${v.productId}@${v.locationId}`, at: asAt ?? now, branchId: v.locationId, amountMinor: v.value.minor,
              description: `${v.onHandMinor} of ${v.productId} at ${v.locationId}`,
            })),
          },
        };
      }

      case 'purchases_by_supplier': {
        // Purchase orders are company records (head-office buying); a branch-limited reader is told, not shown a partial.
        const orders = [...(await foldPurchaseOrders(input.store, tenantId)).values()];
        // As at the newest fact on the order register (a raise, an approval, a receipt posted against an order).
        const asAt = newestOf((await input.store.readStream(tenantId, PURCHASE_ORDERS())).map((e) => e.event.occurredAt));
        const now = input.now();
        const mk = at(asAt, 'no purchase order has ever been raised at head office');
        if (options.scope !== 'all') {
          return {
            sources: [], rows: [], drill: {},
            figures: [mk('Ordered', undefined, 'minor_currency', 'purchase orders are company-wide records; this needs company-wide report access')],
          };
        }
        const by = new Map<string, { orders: number; ordered: number; txns: SourceTransaction[] }>();
        for (const o of orders) {
          const held = by.get(o.supplierId) ?? { orders: 0, ordered: 0, txns: [] };
          held.orders += 1; held.ordered += o.totalMinor;
          held.txns.push({ transactionId: o.poId, at: o.at, branchId: 'company', vendorId: o.supplierId, amountMinor: o.totalMinor, description: `order ${o.number} (${o.status})` });
          by.set(o.supplierId, held);
        }
        const ordered = [...by.entries()].sort((a, b) => b[1].ordered - a[1].ordered || a[0].localeCompare(b[0]));
        return {
          sources: [sourceFreshness({ source: 'purchase orders', domain: 'purchasing', lastEventAt: asAt, now, ...thresholds })],
          figures: ordered.map(([supplier, t]) => mk(supplier, t.ordered, 'minor_currency')),
          rows: ordered.map(([supplier, t]) => ({ supplierId: supplier, orders: String(t.orders), orderedMinor: String(t.ordered) })),
          drill: Object.fromEntries(ordered.map(([supplier, t]) => [supplier, t.txns])),
        };
      }

      case 'loyalty': {
        // What the shop owes its members: every member's points from the points ledger, valued at the owner's rule.
        const now = input.now();
        if (options.scope !== 'all') {
          return {
            sources: [], rows: [], drill: {},
            figures: [figure({ name: 'Points outstanding', unit: 'count', asAt: null, now, notAvailableBecause: 'loyalty is a company-wide liability; this needs company-wide report access' })],
          };
        }
        const memberEvents = await input.store.readStream(tenantId, LOYALTY_MEMBERS(), { type: 'LoyaltyMember' });
        const members = [...new Set(memberEvents.map((e) => (e.event.payload as { memberRef: string }).memberRef))].sort();
        const rule = await input.loyaltyRule(tenantId);
        const times: string[] = memberEvents.map((e) => e.event.occurredAt);
        const rows: Record<string, string>[] = [];
        const txns: SourceTransaction[] = [];
        let points = 0;
        for (const ref of members) {
          const moves = await input.store.readStream(tenantId, streamName(STREAM.loyalty, ref), { type: 'PointsMovement' });
          const balance = moves.reduce((t, e) => t + (e.event.payload as { delta: number }).delta, 0);
          for (const e of moves) times.push(e.event.occurredAt);
          points += balance;
          rows.push({ memberRef: ref, points: String(balance), valueMinor: String(balance * rule.pointValuePaise) });
          txns.push({ transactionId: ref, at: newestOf(moves.map((e) => e.event.occurredAt)) ?? now, branchId: 'company', amountMinor: balance * rule.pointValuePaise, description: `member ${ref}: ${balance} points` });
        }
        const asAt = newestOf(times);
        const mk = at(asAt, 'no loyalty member has ever been enrolled at head office');
        return {
          sources: [sourceFreshness({ source: 'loyalty ledger', domain: 'loyalty', lastEventAt: asAt, now, ...thresholds })],
          figures: [
            mk('Points outstanding', points, 'count'),
            mk('What the points are worth', points * rule.pointValuePaise, 'minor_currency'),
            mk('Members', members.length, 'count'),
          ],
          rows,
          drill: { 'What the points are worth': txns },
        };
      }

      case 'gst': {
        // GST collected, from what the day book POSTED for the day (the books, not a re-count of the tills) — output tax net
        // of returns, by component — and GST PAID ON PURCHASES, from the supplier bills the accountant POSTED to the books
        // for the day (a matched bill's input tax, less what its debit notes reversed); the net is the one less the other.
        // Each side read from the books only; a side the books do not carry is said, never a zero.
        const now = input.now();
        if (options.scope !== 'all') {
          return { sources: [], rows: [], drill: {}, figures: [figure({ name: 'GST collected', unit: 'minor_currency', asAt: null, now, notAvailableBecause: 'the books are company-wide; this needs company-wide report access' })] };
        }
        const journals = await dayBookAdapter({ store: input.store, now: input.now }).dayBookJournals(tenantId, day);
        const bills = (await payablesAdapter({ store: input.store, now: input.now }).payablesJournals(tenantId)).filter((j) => j.documentDate === day);
        const posted = await input.store.latestOfType(tenantId, STREAM.finance, 'JournalPosted');
        const asAt = journals.length === 0 ? null : (posted?.event.occurredAt ?? null);
        const billsAt = bills.length === 0 ? null : (posted?.event.occurredAt ?? null);
        const mk = at(asAt, `the day book for ${day} has not been posted yet — post the day's book and GST is read from it`);
        const mkIn = at(billsAt, `no supplier bill matched on ${day} has been posted to the books — post the payables (POST /v1/finance/payables/post) and GST paid on purchases is read from them`);
        const by = new Map<string, { net: number; txns: SourceTransaction[] }>();
        const take = (entryId: string, documentDate: string, what: string, lines: readonly { accountCode: string; debitMinor: number; creditMinor: number }[]): void => {
          for (const l of lines) {
            if (!l.accountCode.startsWith('gst_')) continue;
            const held = by.get(l.accountCode) ?? { net: 0, txns: [] };
            const amount = l.creditMinor - l.debitMinor;
            held.net += amount;
            held.txns.push({ transactionId: `${entryId}:${l.accountCode}`, at: documentDate, branchId: 'company', amountMinor: amount, description: what });
            by.set(l.accountCode, held);
          }
        };
        for (const j of journals) take(j.entryId, j.documentDate, `${j.dayBook.kind} — ${j.narrative}`, j.lines);
        for (const j of bills) take(j.entryId, j.documentDate, j.narrative, j.lines);
        const output = [...by.entries()].filter(([code]) => code.startsWith('gst_output')).sort((a, b) => a[0].localeCompare(b[0]));
        const inputTax = [...by.entries()].filter(([code]) => code.startsWith('gst_input')).sort((a, b) => a[0].localeCompare(b[0]));
        const collected = output.reduce((t, [, v]) => t + v.net, 0);
        // Input tax sits on the debit side: what was paid is debits less credits (a debit note's reversal comes off it).
        const paid = -inputTax.reduce((t, [, v]) => t + v.net, 0);
        const inputKnown = inputTax.length > 0;
        return {
          tradingDay: day,
          sources: [
            sourceFreshness({ source: 'day book', domain: 'books', lastEventAt: asAt, now, ...thresholds }),
            sourceFreshness({ source: 'supplier bills posted', domain: 'books', lastEventAt: billsAt, now, ...thresholds }),
          ],
          figures: [
            mk('GST collected', collected, 'minor_currency'),
            ...output.map(([code, v]) => mk(`GST collected — ${code.replace('gst_output_', '').toUpperCase()}`, v.net, 'minor_currency')),
            inputKnown
              ? mkIn('GST paid on purchases', paid, 'minor_currency')
              : mkIn('GST paid on purchases', undefined, 'minor_currency', bills.length === 0
                ? `no supplier bill matched on ${day} has been posted to the books — supplier bills are not posted for this day`
                : 'the supplier bills posted for this day carry no GST'),
            ...inputTax.map(([code, v]) => mkIn(`GST paid on purchases — ${code.replace('gst_input_', '').toUpperCase()}`, -v.net, 'minor_currency')),
            asAt !== null && inputKnown
              ? mk('Net GST (collected less paid on purchases)', collected - paid, 'minor_currency')
              : mk('Net GST (collected less paid on purchases)', undefined, 'minor_currency', asAt === null ? `the day book for ${day} has not been posted yet` : 'GST paid on purchases is not in the books for this day, so a net figure would overstate what is owed'),
          ],
          rows: [...output, ...inputTax].map(([code, v]) => ({ account: code, netMinor: String(v.net) })),
          drill: {
            'GST collected': output.flatMap(([, v]) => v.txns),
            ...Object.fromEntries(output.map(([code, v]) => [`GST collected — ${code.replace('gst_output_', '').toUpperCase()}`, v.txns])),
            ...(inputKnown ? { 'GST paid on purchases': inputTax.flatMap(([, v]) => v.txns) } : {}),
          },
        };
      }

      case 'reconciliation': {
        // Money in the bank: the month's card and UPI takings against the provider's settlement files, and the provider's
        // payouts against the bank statements — the same independent evidence the month close is signed on.
        const now = input.now();
        const period = day.slice(0, 7);
        if (options.scope !== 'all') {
          return { sources: [], rows: [], drill: {}, figures: [figure({ name: 'Card and UPI takings', unit: 'minor_currency', asAt: null, now, notAvailableBecause: 'the bank is company-wide; this needs company-wide report access' })] };
        }
        const e = await independentEvidenceAdapter({ store: input.store, now: input.now }).evidenceFor(tenantId, period);
        const { sources, asAt } = await salesOf(tenantId, day, 'all');
        const mk = at(asAt, neverSales);
        const figures: Figure[] = [];
        for (const c of e.checks) {
          figures.push(mk(`${c.name} — ours`, c.leftMinor, 'minor_currency'), mk(`${c.name} — theirs`, c.rightMinor, 'minor_currency'), mk(`${c.name} — difference`, c.leftMinor - c.rightMinor, 'minor_currency'));
        }
        if (e.checks.length === 0) figures.push(mk('Card and UPI takings', undefined, 'minor_currency', 'no provider settlement file or bank statement has been imported for this month'));
        figures.push(mk('Card and UPI payments not yet settled', e.unsettledTenders.length, 'count'), mk('Payouts not yet in the bank', e.payoutsNotInBank.length, 'count'));
        for (const why of e.notChecked) figures.push(mk(why.split(':')[0] ?? why, undefined, 'minor_currency', why));
        return {
          tradingDay: day, sources, figures,
          rows: e.checks.map((c) => ({ check: c.name, ourMinor: String(c.leftMinor), theirMinor: String(c.rightMinor), differenceMinor: String(c.leftMinor - c.rightMinor) })),
          drill: {},
        };
      }

      case 'profitability': {
        // What the books say the day earned. Revenue is POSTED (the day book: net of GST and returns). The COST of what was
        // sold is each sold line at head office's AVERAGE BUYING COST for the product at the store it was sold from (OB-39
        // "B", owner 11 Oct 2026 — the same cost the store computer's Today margin uses), less the goods that came back.
        // A product the store never bought at a cost has no average: then the cost — and so the profit — is NOT AVAILABLE,
        // naming the products, never costed at zero (a zero cost is a 100% margin).
        const now = input.now();
        if (options.scope !== 'all') {
          return { sources: [], rows: [], drill: {}, figures: [figure({ name: 'Profit', unit: 'minor_currency', asAt: null, now, notAvailableBecause: 'the books are company-wide; this needs company-wide report access' })] };
        }
        const journals = await dayBookAdapter({ store: input.store, now: input.now }).dayBookJournals(tenantId, day);
        const posted = await input.store.latestOfType(tenantId, STREAM.finance, 'JournalPosted');
        const asAt = journals.length === 0 ? null : (posted?.event.occurredAt ?? null);
        const mk = at(asAt, `the day book for ${day} has not been posted yet`);
        const revenue = journals.flatMap((j) => j.lines).filter((l) => l.accountCode === 'sales_revenue').reduce((t, l) => t + l.creditMinor - l.debitMinor, 0);
        const costs = await averageBuyingCosts({ store: input.store, now: input.now }, tenantId);
        const day_ = await salesOf(tenantId, day, 'all');
        const missing = new Set<string>();
        const txns: SourceTransaction[] = [];
        const rows: Record<string, string>[] = [];
        let cogs = 0;
        for (const sale of day_.sales) {
          const storeId = saleBranch(sale);
          let cost = 0;
          for (const l of sale.lines) {
            const unit = costs.costOf(l.productId, storeId);
            if (unit === undefined) { missing.add(l.productId); continue; }
            cost += valueAtUnitCost(l.quantityMinor, l.uom, unit);
          }
          cogs += cost;
          txns.push(saleTxn(sale, cost, `${sale.saleId}: ${sale.lines.length} line(s) at the average buying cost`));
        }
        for (const r of await dayBookAdapter({ store: input.store, now: input.now }).returnsOn(tenantId, day)) {
          const held = r.originalSaleId === null ? undefined : await input.store.findByIdempotencyKey(tenantId, `sale-${tenantId}-${r.originalSaleId}`);
          const sale = held?.event.payload as IncomingSale | undefined;
          const rec = r as typeof r & { processedAt?: string; processedBy?: string; locationId?: string };
          const storeId = sale !== undefined ? saleBranch(sale) : (rec.locationId ?? 'no-branch-named');
          let back = 0;
          for (const l of r.lines) {
            const unit = costs.costOf(l.productId, storeId);
            if (unit === undefined) { missing.add(l.productId); continue; }
            const uom = sale?.lines.find((x) => x.productId === l.productId)?.uom ?? (await products.product(tenantId, l.productId))?.baseUom ?? 'ea';
            back += valueAtUnitCost(l.quantityMinor, uom, unit);
          }
          cogs -= back;
          txns.push({ transactionId: r.returnId, at: rec.processedAt ?? day, branchId: storeId, ...(rec.processedBy === undefined ? {} : { staffId: rec.processedBy }), amountMinor: -back, description: `${r.returnId}: goods back, at the average buying cost` });
        }
        for (const c of costs.rows) rows.push({ productId: c.productId, storeId: c.storeId, averageBuyingCostMinor: String(c.unitCostMinor), receivedMinor: String(c.receivedMinor), receivedValueMinor: String(c.receivedValueMinor) });
        const noCost = missing.size === 0 ? undefined
          : `no average buying cost for ${[...missing].sort().join(', ')} — the store has not received it at a cost, so what it cost to sell is not known (never costed at zero)`;
        return {
          tradingDay: day,
          sources: [
            sourceFreshness({ source: 'day book', domain: 'books', lastEventAt: asAt, now, ...thresholds }),
            ...day_.sources,
          ],
          figures: [
            mk('Revenue net of GST and returns', revenue, 'minor_currency'),
            mk('Cost of goods sold', noCost === undefined ? cogs : undefined, 'minor_currency', noCost),
            mk('Profit', noCost === undefined ? revenue - cogs : undefined, 'minor_currency', noCost),
          ],
          rows,
          drill: noCost === undefined ? { 'Cost of goods sold': txns } : {},
        };
      }

      case 'sync_health': {
        // Anything not sent yet: what each store computer last SAID it holds unsent (its own report, PA-04) — the only
        // thing head office can know about a box's queue. A store that never said is not available, never "0".
        const now = input.now();
        const reports = [...(await latestStoreReports(input.store, tenantId)).values()].filter((r) => inScope(options.scope, r.storeId)).sort((a, b) => a.storeId.localeCompare(b.storeId));
        const asAt = reports.length === 0 ? null : reports.map((r) => r.reportedAt).reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
        const mk = at(asAt, 'no store computer has reported to head office yet');
        const known = reports.filter((r) => typeof r.unsentItems === 'number');
        return {
          sources: reports.map((r) => sourceFreshness({ source: `store:${r.storeId}`, domain: 'store computer report', lastEventAt: r.reportedAt, now, ...thresholds })),
          figures: [
            known.length === reports.length
              ? mk('Records not yet sent', known.reduce((t, r) => t + (r.unsentItems ?? 0), 0), 'count')
              : mk('Records not yet sent', undefined, 'count', 'a store computer reported without saying how much it holds unsent'),
            ...reports.map((r) => (typeof r.unsentItems === 'number'
              ? at(r.reportedAt, '')(`${r.storeId} — not yet sent`, r.unsentItems, 'count')
              : at(r.reportedAt, '')(`${r.storeId} — not yet sent`, undefined, 'count', 'this store computer did not say'))),
          ],
          rows: reports.map((r) => ({ storeId: r.storeId, unsent: typeof r.unsentItems === 'number' ? String(r.unsentItems) : 'not said', reportedAt: r.reportedAt })),
          drill: {},
        };
      }

      case 'data_freshness': {
        // How current these figures are: every source's newest record here, and each store computer's last word on what
        // it still holds — so "old" can be told apart from "behind".
        const now = input.now();
        const reports = await latestStoreReports(input.store, tenantId);
        const sales = await salesOf(tenantId, day, options.scope);
        const stock = await input.store.latestOfType(tenantId, STREAM.inventory, 'InventoryMoved');
        const sources: SourceFreshness[] = [
          ...sales.sources,
          sourceFreshness({ source: 'stock ledger', domain: 'stock', lastEventAt: stock?.event.occurredAt ?? null, now, ...thresholds }),
          ...[...reports.values()].filter((r) => inScope(options.scope, r.storeId)).sort((a, b) => a.storeId.localeCompare(b.storeId))
            .map((r) => sourceFreshness({ source: `store:${r.storeId} report`, domain: 'store computer report', lastEventAt: r.reportedAt, now, ...thresholds })),
        ];
        const minutes = (t: string | null): number | undefined => (t === null ? undefined : Math.max(0, Math.round((Date.parse(now) - Date.parse(t)) / 60_000)));
        return {
          sources,
          figures: sources.map((s) => at(s.lastEventAt, `${s.source}: nothing has ever arrived`, s.source.startsWith('store:') && !s.source.endsWith(' report') ? sales.nothingUnsentAt : undefined)(`${s.source} — minutes since its newest record`, minutes(s.lastEventAt), 'count')),
          rows: sources.map((s) => ({ source: s.source, lastSyncedAt: s.lastEventAt ?? 'never', state: s.staleness })),
          drill: {},
        };
      }

      default:
        // Unreachable through the route: it refuses a report not in `PRODUCED_AT_HEAD_OFFICE` before it gets here.
        // Thrown rather than answered with the dashboard — an unrelated figure under a report's name is the audit's fault.
        throw new Error(`no head-office producer for report "${reportId}"`);
    }
  };

  return { produced: PRODUCED_AT_HEAD_OFFICE, produce };
}

