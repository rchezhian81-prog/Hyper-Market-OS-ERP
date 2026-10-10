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
import { figure, sourceFreshness, type Figure, type SourceFreshness } from '../../reporting/src/index';
import { STREAM, streamName, inventoryAdapter, productMasterAdapter, foldPurchaseOrders } from './adapters';

/** The report ids head office can work out from its own records — each a `case` in `produce` below. */
export const PRODUCED_AT_HEAD_OFFICE: readonly string[] = Object.freeze([
  'sales_by_day', 'tender_mix', 'sales_by_cashier', 'units_by_category', 'stock_on_hand', 'purchases_by_supplier', 'loyalty',
]);

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
    const sources = newest.size === 0
      ? [sourceFreshness({ source: 'any till', domain: 'sales', lastEventAt: null, now, ...thresholds })]
      : [...newest.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        .map(([source, at]) => sourceFreshness({ source, domain: 'sales', lastEventAt: at, now, ...thresholds }));
    // As current as the stalest source; `null` when nothing has ever arrived (the figures then refuse, never ₹0).
    const asAt = newest.size === 0 ? null : [...newest.values()].reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
    return { sales: visible, withheld: all.length - visible.length, sources, asAt };
  };

  const at = (asAt: string | null, never: string) => (name: string, valueMinor: number | undefined, unit: Figure['unit'], because?: string): Figure =>
    figure({
      name, unit, asAt, now: input.now(), ...thresholds,
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
        const { sales, withheld, sources, asAt } = await salesOf(tenantId, day, options.scope);
        const mk = at(asAt, neverSales);
        const taken = sales.reduce((t, s) => t + s.totalMinor, 0);
        return {
          tradingDay: day, sources,
          figures: [mk('Taken', taken, 'minor_currency'), mk('Bills', sales.length, 'count'), ...withheldFigure(mk, withheld)],
          rows: sales.map((s) => ({ saleId: s.saleId, at: s.committedAt, totalMinor: String(s.totalMinor), tender: primaryTender(s) })),
          drill: { Taken: sales.map((s) => saleTxn(s, s.totalMinor, `bill ${s.receiptNumber}`)) },
        };
      }

      case 'tender_mix': {
        // Each payment under its own kind by its own amount (EA-02); a bill counts once under each kind it used.
        const { sales, withheld, sources, asAt } = await salesOf(tenantId, day, options.scope);
        const mk = at(asAt, neverSales);
        const totals = new Map<string, { total: number; bills: number; txns: SourceTransaction[] }>();
        for (const s of sales) {
          for (const [kind, minor] of Object.entries(tenderSplit({ totalMinor: s.totalMinor, tender: primaryTender(s), tenders: s.tenders }))) {
            const held = totals.get(kind) ?? { total: 0, bills: 0, txns: [] };
            held.total += minor; held.bills += 1; held.txns.push(saleTxn(s, minor, `bill ${s.receiptNumber} — ${kind}`));
            totals.set(kind, held);
          }
        }
        const ordered = [...totals.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        return {
          tradingDay: day, sources,
          figures: [...ordered.map(([kind, t]) => mk(kind, t.total, 'minor_currency')), ...withheldFigure(mk, withheld)],
          rows: ordered.map(([kind, t]) => ({ key: kind, totalMinor: String(t.total), bills: String(t.bills) })),
          drill: Object.fromEntries(ordered.map(([kind, t]) => [kind, t.txns])),
        };
      }

      case 'sales_by_cashier': {
        const { sales, withheld, sources, asAt } = await salesOf(tenantId, day, options.scope);
        const mk = at(asAt, neverSales);
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
        // Units AND money per department, from the lines the till charged and the department the product master gives
        // each product. A product the master places nowhere is counted under its own name, never folded into one.
        const { sales, withheld, sources, asAt } = await salesOf(tenantId, day, options.scope);
        const mk = at(asAt, neverSales);
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
        const ordered = [...by.entries()].sort((a, b) => b[1].money - a[1].money || a[0].localeCompare(b[0]));
        return {
          tradingDay: day, sources,
          figures: [
            ...ordered.map(([dept, t]) => mk(dept, t.money, 'minor_currency')),
            // Shown, never hidden: what the bills took that no line explains (a bill-level adjustment), so the
            // departments plus this always equal the day's takings.
            ...(billMoney === lineMoney ? [] : [mk('Taken but on no line', billMoney - lineMoney, 'minor_currency')]),
            ...withheldFigure(mk, withheld),
          ],
          rows: ordered.map(([dept, t]) => ({ department: dept, units: String(t.units), totalMinor: String(t.money) })),
          drill: Object.fromEntries(ordered.map(([dept, t]) => [dept, t.txns])),
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

      default:
        // Unreachable through the route: it refuses a report not in `PRODUCED_AT_HEAD_OFFICE` before it gets here.
        // Thrown rather than answered with the dashboard — an unrelated figure under a report's name is the audit's fault.
        throw new Error(`no head-office producer for report "${reportId}"`);
    }
  };

  return { produced: PRODUCED_AT_HEAD_OFFICE, produce };
}
