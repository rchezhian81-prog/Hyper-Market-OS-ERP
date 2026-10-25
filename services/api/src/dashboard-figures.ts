// The owner's dashboard, every domain M29-FR-01 names (OB-288 P2 · M29-FR-01 · D13 · P-08 · §28 · §31).
//
// The dashboard showed only sales: what the tills took, how many bills and how people paid. M29-FR-01 asks for "sales,
// margin, cash, stock, purchase, customer, fulfilment" — each tied to its source, each with its freshness, a manager
// seeing only their own branches. Every one of those figures already has a governed producer behind a catalogue report
// (`report-producers.ts`, `report-producers-more.ts`); this file COMPOSES the dashboard from them rather than computing
// any number a second time (CORE-02):
//
//   sales       Sales by day (`sales_by_day`) and How people paid (`tender_mix`)    — the bills, in the reader's branches
//   margin      Margin (`margin`)                                                    — at the average buying cost (OB-39)
//   cash        the till closes (counted, over/short) and Money in the bank (`reconciliation`)
//   stock       Stock on hand (`stock_on_hand`)
//   purchase    Purchases by supplier (`purchases_by_supplier`), summed
//   customer    Customers coming back (`customer_repeat`) and Loyalty (`loyalty`)
//   fulfilment  Online orders (`orders_and_substitutions`)
//
// Each domain is its own block with its own figures, its own sources and its own "as at" (§31 "prominent freshness per
// branch/domain"): a stock ledger nobody has written to yet is "not available" in the stock block and does not make the
// sales block look stale, and a sales feed that stopped is stale in the sales block without hiding the stock value.
// A producer that refuses a branch-limited reader (a company-wide register) says so in words in its block — never a
// part shown as if it were the whole (§28). Read-only: nothing here appends anything.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import { tradingDayIn, type TradingCalendar } from '../../../packages/calendar/src/index';
import type { BranchScope } from '../../kernel/src/index';
import { dashboard, figure, sourceFreshness, type Figure, type SourceFreshness, type Staleness, type ProducedReportView } from '../../reporting/src/index';
import type { ClosedShiftRecord } from '../../pos/src/shift';
import { STREAM, streamName } from './adapters';

/** The seven domains M29-FR-01 names, in the order the owner reads them. */
export const KPI_DOMAINS = ['sales', 'margin', 'cash', 'stock', 'purchase', 'customer', 'fulfilment'] as const;
export type KpiDomain = typeof KPI_DOMAINS[number];

/** One domain's block on the dashboard: its figures, the sources behind them, and how current it is. */
export interface KpiBlock {
  readonly domain: KpiDomain;
  /** The catalogue reports the block is built from — the drill-through goes to these (M29-FR-02). */
  readonly reports: readonly string[];
  readonly figures: readonly Figure[];
  readonly sources: readonly SourceFreshness[];
  readonly worstStaleness: Staleness;
  readonly asAt: string | null;
  readonly detail: string;
  readonly tradingDay?: string;
  readonly period?: { readonly from: string; readonly to: string };
}

export type Produce = (tenantId: string, reportId: string, options: { readonly tradingDay?: string; readonly scope: BranchScope }) => Promise<ProducedReportView>;

export interface DashboardKpiInput {
  readonly store: EventStore;
  readonly now: () => string;
  readonly produce: Produce;
  readonly calendar: (tenantId: string) => Promise<TradingCalendar> | TradingCalendar;
  readonly thresholds?: { readonly laggingAfterMinutes?: number; readonly staleAfterMinutes?: number };
}

/** A figure under a dashboard name — the same value, time and freshness as the report's; only the label changes. */
export function renamed(f: Figure, name: string): Figure {
  return { ...f, name, detail: f.detail.startsWith(`${f.name}:`) ? `${name}:${f.detail.slice(f.name.length + 1)}` : `${name}: ${f.detail}` };
}

/** The report's figure called `from`, under the dashboard's name — or "not available", saying the report did not give it. */
function pick(view: ProducedReportView, from: string, name: string, now: string, report: string): Figure {
  const f = view.figures.find((x) => x.name === from);
  if (f !== undefined) return renamed(f, name);
  // A report that refused (company-wide for a branch-limited reader) gives one figure saying why: carry that reason.
  const refusal = view.figures.find((x) => x.valueMinor === undefined && x.notAvailableBecause !== undefined);
  return figure({
    name, unit: 'count', asAt: refusal?.asAt ?? null, now,
    notAvailableBecause: refusal?.notAvailableBecause ?? `the ${report} report gave no "${from}" figure`,
  });
}

const block = (domain: KpiDomain, reports: readonly string[], figures: readonly Figure[], sources: readonly SourceFreshness[], now: string, extra: { tradingDay?: string; period?: { from: string; to: string } } = {}): KpiBlock => {
  const d = dashboard(figures, now, sources);
  return { domain, reports, figures, sources, worstStaleness: d.worstStaleness, asAt: d.asAt, detail: d.detail, ...extra };
};

/** Every block of the owner's dashboard, in the reader's server-derived scope (§28), for the shop's trading day. */
export async function dashboardKpis(input: DashboardKpiInput, tenantId: string, scope: BranchScope): Promise<readonly KpiBlock[]> {
  const now = input.now();
  const calendar = await input.calendar(tenantId);
  const day = tradingDayIn(now, calendar);
  const run = (reportId: string): Promise<ProducedReportView> => input.produce(tenantId, reportId, { tradingDay: day, scope });
  const [salesDay, tenders, margin, recon, stock, purchases, repeat, loyalty, orders] = await Promise.all([
    run('sales_by_day'), run('tender_mix'), run('margin'), run('reconciliation'), run('stock_on_hand'),
    run('purchases_by_supplier'), run('customer_repeat'), run('loyalty'), run('orders_and_substitutions'),
  ]);

  // ── sales ──
  const salesFigures: Figure[] = [
    pick(salesDay, 'Taken', 'Sales today', now, 'Sales by day'),
    pick(salesDay, 'Bills', 'Sales today — receipts', now, 'Sales by day'),
    ...tenders.figures.filter((f) => !f.name.startsWith('refunded — ') && !f.name.startsWith('unresolved — ') && !f.name.startsWith('Bills outside'))
      .map((f) => renamed(f, `Sales today — ${f.name}`)),
    pick(salesDay, 'Returned', 'Returned today', now, 'Sales by day'),
    pick(salesDay, 'Taken net of returns', 'Sales today net of returns', now, 'Sales by day'),
    ...salesDay.figures.filter((f) => f.name.startsWith('Bills outside')),
  ];

  // ── margin ──
  const marginFigures = [
    pick(margin, 'Margin', 'Margin today', now, 'Margin'),
    pick(margin, 'Margin (basis points of net)', 'Margin today (basis points of net)', now, 'Margin'),
    pick(margin, 'Cost of goods sold', 'Cost of goods sold today', now, 'Margin'),
  ];

  // ── cash: the till closes of the day (what was counted, and over/short), and the bank reconciliation ──
  const closes = (await input.store.readStream(tenantId, streamName(STREAM.cash, 'shifts'), { type: 'TillClosed' }))
    .map((e) => ({ c: e.event.payload as ClosedShiftRecord, at: e.event.occurredAt }));
  const inScope = (branch: string): boolean => scope === 'all' || scope.includes(branch);
  const today = closes.filter(({ c }) => c.tradingDay === day && inScope(c.storeId ?? c.tillId));
  const closesAsAt = closes.length === 0 ? null : closes.map((x) => x.at).reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
  const neverClosed = 'no till has ever been closed at head office, so there is no counted cash to report';
  const cashMk = (name: string, valueMinor: number, unit: Figure['unit']): Figure =>
    figure({ name, unit, asAt: closesAsAt, now, ...input.thresholds, ...(closesAsAt === null ? { notAvailableBecause: neverClosed } : { valueMinor }) });
  const cashFigures = [
    cashMk('Tills closed today', today.length, 'count'),
    cashMk('Cash counted at close today', today.reduce((t, { c }) => t + c.countedMinor, 0), 'minor_currency'),
    cashMk('Cash over (+) or short (−) at close today', today.reduce((t, { c }) => t + c.varianceMinor, 0), 'minor_currency'),
    pick(recon, 'Card and UPI payments not yet settled', 'Card and UPI payments not yet settled', now, 'Money in the bank'),
    pick(recon, 'Payouts not yet in the bank', 'Payouts not yet in the bank', now, 'Money in the bank'),
  ];
  // The card and UPI figures are as current as the sales they reconcile, so the sales sources stand behind them too.
  const cashSources = [sourceFreshness({ source: 'till closes', domain: 'cash', lastEventAt: closesAsAt, now, ...input.thresholds }), ...recon.sources];

  // ── stock ──
  const stockFigures = [
    pick(stock, 'Value on hand', 'Stock value on hand', now, 'Stock on hand'),
    pick(stock, 'Lines with stock at no known cost', 'Stock lines at no known cost', now, 'Stock on hand'),
  ];

  // ── purchase: the order register, summed over every supplier (company-wide) ──
  const refusedPurchases = purchases.figures.find((f) => f.valueMinor === undefined && f.notAvailableBecause !== undefined);
  const poAsAt = purchases.sources[0]?.lastEventAt ?? null;
  const purchaseFigures: Figure[] = refusedPurchases !== undefined
    ? [renamed(refusedPurchases, 'Ordered from suppliers')]
    : [
      figure({
        name: 'Ordered from suppliers', unit: 'minor_currency', asAt: poAsAt, now, ...input.thresholds,
        ...(poAsAt === null ? { notAvailableBecause: 'no purchase order has ever been raised at head office' } : { valueMinor: purchases.rows.reduce((t, r) => t + Number(r['orderedMinor'] ?? 0), 0) }),
      }),
      figure({
        name: 'Suppliers ordered from', unit: 'count', asAt: poAsAt, now, ...input.thresholds,
        ...(poAsAt === null ? { notAvailableBecause: 'no purchase order has ever been raised at head office' } : { valueMinor: purchases.rows.length }),
      }),
    ];

  // ── customer ──
  const customerFigures = [
    pick(repeat, 'Customers named on a bill', 'Customers named on a bill this month', now, 'Customers coming back'),
    pick(repeat, 'Customers who came back', 'Customers who came back this month', now, 'Customers coming back'),
    pick(loyalty, 'Points outstanding', 'Loyalty points outstanding', now, 'Loyalty'),
    pick(loyalty, 'What the points are worth', 'What the loyalty points are worth', now, 'Loyalty'),
  ];

  // ── fulfilment ──
  const fulfilmentFigures = [
    pick(orders, 'Orders placed', 'Online orders this month', now, 'Online orders'),
    pick(orders, 'Lines substituted', 'Lines substituted this month', now, 'Online orders'),
    pick(orders, 'Refunds due from substitutions', 'Refunds due from substitutions this month', now, 'Online orders'),
  ];

  return [
    block('sales', ['sales_by_day', 'tender_mix'], salesFigures, salesDay.sources, now, { tradingDay: day }),
    block('margin', ['margin'], marginFigures, margin.sources, now, { tradingDay: day }),
    block('cash', ['reconciliation'], cashFigures, cashSources, now, { tradingDay: day }),
    block('stock', ['stock_on_hand'], stockFigures, stock.sources, now),
    block('purchase', ['purchases_by_supplier'], purchaseFigures, purchases.sources, now),
    block('customer', ['customer_repeat', 'loyalty'], customerFigures, [...repeat.sources, ...loyalty.sources], now, ...(repeat.period === undefined ? [] : [{ period: repeat.period }])),
    block('fulfilment', ['orders_and_substitutions'], fulfilmentFigures, orders.sources, now, ...(orders.period === undefined ? [] : [{ period: orders.period }])),
  ];
}
