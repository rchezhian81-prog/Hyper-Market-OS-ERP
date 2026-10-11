// The other sixteen of D13's catalogue reports, produced at head office (round 8 · D13 · M29-FR-01/02 · EA-05 · EA-06).
//
// `report-producers.ts` produced twelve of the twenty-eight reports the catalogue names; the rest were listed and refused
// as "this version cannot work it out yet". Each producer here reads the GOVERNED register the matching domain already
// writes — never a copy, never a number typed into a body — and returns, as the first twelve do:
//
//   • the figures, each stamped with its SOURCE's freshness (EA-01), never the read time;
//   • the rows behind them, in the report's declared columns (packages/reporting/src/catalogue.ts);
//   • for each money/count figure a governed drill can reach, the source records it is the exact sum of (EA-05).
//
// Where a figure cannot honestly be produced — a cost head office does not hold, a register nobody has written to yet,
// a company-wide register asked for by a branch-limited reader — it is NOT AVAILABLE with the reason in words. Never a
// zero: "Waste this month: ₹0" is the number this whole catalogue exists to prevent.
//
// Margins and goods costs are at head office's AVERAGE BUYING COST for the product at the store (OB-39 "B", owner
// 11 Oct 2026) — the same cost the profitability report and the store computer's Today margin use.
//
// Read-only by construction: nothing in this file appends an event (reporting never writes; hard rule #5 for the AI).

import type { EventStore } from '../../../packages/persistence/src/event-store';
import { tradingDayIn, tradingDayWindow, shiftDate, wallClockIn, type TradingCalendar } from '../../../packages/calendar/src/index';
import type { SourceTransaction } from '../../../packages/owner-control/src/index';
import { splitInclusive } from '../../../packages/finance/src/day-book';
import { valueAtUnitCost } from '../../../packages/contracts/src/quantity';
import type { BranchScope } from '../../kernel/src/index';
import type { IncomingSale } from '../../pos/src/sale-intake';
import type { StoredWriteOff } from '../../inventory/src/write-off';
import type { StoredReconciliation } from '../../inventory/src/counts';
import type { TillActivity, RaisedException } from '../../pos/src/loss-prevention';
import type { StoredSubstitution, PlacedOrder } from '../../orders/src/index';
import type { SlotBooking } from '../../orders/src/delivery-service';
import type { DeliveryStateRecord } from '../../fulfilment/src/index';
import type { RouteAssignment } from '../../fulfilment/src/assignments';
import type { ServiceCase } from '../../../packages/service-desk/src/service-cases';
import type { CampaignSendRecord, DeliveryCallback } from '../../customer/src/campaign-send';
import type { Proposal } from '../../ai/src/index';
import type { StoredMatch } from '../../purchase/src/index';
import { figure, sourceFreshness, type Figure, type SourceFreshness } from '../../reporting/src/index';
import {
  STREAM, streamName, foldPurchaseOrders, ordersForExport, averageBuyingCosts, dayBookAdapter, nearExpiryAdapter, orgStructureAdapter,
} from './adapters';

/** The ids this file produces — each a `case` in `produceMore` below. */
export const PRODUCED_FROM_DOMAIN_REGISTERS: readonly string[] = Object.freeze([
  'sales_by_hour', 'basket', 'day_on_day', 'margin', 'customer_repeat',
  'shrinkage', 'waste', 'expiry', 'exceptions',
  'supplier_service', 'invoice_differences',
  'orders_and_substitutions', 'delivery_sla', 'delivery_contribution',
  'marketing', 'ai_outcomes',
]);

/** What a producer hands back (the same shape as report-producers.ts, plus the period a month report covers). */
export interface MoreProducedReport {
  readonly figures: readonly Figure[];
  readonly rows: readonly Readonly<Record<string, string>>[];
  readonly sources: readonly SourceFreshness[];
  readonly drill: Readonly<Record<string, readonly SourceTransaction[]>>;
  readonly tradingDay?: string;
  /** A month report's period: the first of the month to the asked day, both inclusive, by the shop's trading days. */
  readonly period?: { readonly from: string; readonly to: string };
}

/** The pieces of report-producers.ts these producers share, so a sale is read, scoped and dated ONE way. */
export interface ProducerKit {
  readonly store: EventStore;
  readonly now: () => string;
  readonly thresholds: { readonly laggingAfterMinutes?: number; readonly staleAfterMinutes?: number };
  readonly salesOf: (tenantId: string, day: string, scope: BranchScope) => Promise<{
    readonly sales: readonly IncomingSale[]; readonly withheld: number; readonly sources: readonly SourceFreshness[];
    readonly asAt: string | null; readonly nothingUnsentAt: string | undefined;
  }>;
  readonly at: (asAt: string | null, never: string, nothingUnsentAt?: string) =>
    (name: string, valueMinor: number | undefined, unit: Figure['unit'], because?: string) => Figure;
  readonly saleTxn: (s: IncomingSale, amountMinor: number, description: string) => SourceTransaction;
  readonly saleBranch: (s: IncomingSale) => string;
  readonly withheldFigure: (mk: (name: string, valueMinor: number | undefined, unit: Figure['unit']) => Figure, withheld: number) => Figure[];
}

const inScope = (scope: BranchScope, branchId: string): boolean => scope === 'all' || scope.includes(branchId);
const newestOf = (times: readonly string[]): string | null =>
  (times.length === 0 ? null : times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)));
const sum = (xs: readonly number[]): number => xs.reduce((t, x) => t + x, 0);
const NEVER_SALES = 'no till has ever sent a sale to head office, so there is nothing to report yet';
const COMPANY_WIDE = 'this needs company-wide report access';

/** Every payload of one type on one stream, with the time the record was made. */
async function recordsOf<T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<{ readonly p: T; readonly at: string }[]> {
  return (await store.readStream(tenantId, stream, { type })).map((e) => ({ p: e.event.payload as T, at: e.event.occurredAt }));
}

export function produceMore(kit: ProducerKit) {
  const fresh = (source: string, domain: string, lastEventAt: string | null): SourceFreshness =>
    sourceFreshness({ source, domain, lastEventAt, now: kit.now(), ...kit.thresholds });
  /** A report refused in words for a branch-limited reader: the register is company-wide (never shown in part). */
  const companyOnly = (name: string, unit: Figure['unit'], what: string): MoreProducedReport => ({
    sources: [], rows: [], drill: {},
    figures: [figure({ name, unit, asAt: null, now: kit.now(), notAvailableBecause: `${what} ${COMPANY_WIDE}` })],
  });

  return async (tenantId: string, reportId: string, options: { readonly scope: BranchScope }, day: string, calendar: TradingCalendar): Promise<MoreProducedReport> => {
    const scope = options.scope;
    const period = { from: `${day.slice(0, 8)}01`, to: day };
    /** Whether an instant falls on a trading day inside this month's period, by the shop's own calendar. */
    const inPeriod = (instant: string): boolean => {
      const d = tradingDayIn(instant, calendar);
      return d >= period.from && d <= period.to;
    };

    switch (reportId) {
      // ── sales ─────────────────────────────────────────────────────────────────────────────────────────────────
      case 'sales_by_hour': {
        // Each bill under the shop's local hour it was rung in; the hours add back to the day's takings exactly.
        const { sales, withheld, sources, asAt, nothingUnsentAt } = await kit.salesOf(tenantId, day, scope);
        const mk = kit.at(asAt, NEVER_SALES, nothingUnsentAt);
        const by = new Map<string, IncomingSale[]>();
        for (const s of sales) {
          const hour = `${wallClockIn(s.committedAt, calendar.timeZone).slice(11, 13)}:00`;
          by.set(hour, [...(by.get(hour) ?? []), s]);
        }
        const ordered = [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        return {
          tradingDay: day, sources,
          figures: [
            ...ordered.map(([hour, list]) => mk(hour, sum(list.map((s) => s.totalMinor)), 'minor_currency')),
            mk('Taken', sum(sales.map((s) => s.totalMinor)), 'minor_currency'),
            ...kit.withheldFigure(mk, withheld),
          ],
          rows: ordered.map(([hour, list]) => ({ key: hour, totalMinor: String(sum(list.map((s) => s.totalMinor))), bills: String(list.length) })),
          drill: Object.fromEntries(ordered.map(([hour, list]) => [hour, list.map((s) => kit.saleTxn(s, s.totalMinor, `bill ${s.receiptNumber}`))])),
        };
      }

      case 'basket': {
        // What one visit spends: the day's takings over its bills. No bill → no average (never ₹0).
        const { sales, withheld, sources, asAt, nothingUnsentAt } = await kit.salesOf(tenantId, day, scope);
        const mk = kit.at(asAt, NEVER_SALES, nothingUnsentAt);
        const taken = sum(sales.map((s) => s.totalMinor));
        const unitsOf = (s: IncomingSale): number => sum(s.lines.map((l) => (l.uom === 'ea' ? l.quantityMinor : 1)));
        const none = sales.length === 0 ? `no bill was rung on ${day}, so there is no basket to average` : undefined;
        return {
          tradingDay: day, sources,
          figures: [
            mk('Bills', sales.length, 'count'),
            mk('Taken', taken, 'minor_currency'),
            mk('Average basket', none === undefined ? Math.round(taken / sales.length) : undefined, 'minor_currency', none),
            mk('Items sold', sum(sales.map(unitsOf)), 'count'),
            ...kit.withheldFigure(mk, withheld),
          ],
          rows: sales.map((s) => ({ saleId: s.saleId, totalMinor: String(s.totalMinor), units: String(unitsOf(s)) })),
          drill: { Taken: sales.map((s) => kit.saleTxn(s, s.totalMinor, `bill ${s.receiptNumber}`)) },
        };
      }

      case 'day_on_day': {
        // The asked day against the last day (within 31 before it) on which this scope sold anything at head office.
        const today = await kit.salesOf(tenantId, day, scope);
        const mk = kit.at(today.asAt, NEVER_SALES, today.nothingUnsentAt);
        let prior: { day: string; sales: readonly IncomingSale[] } | undefined;
        for (let back = 1; back <= 31 && prior === undefined; back += 1) {
          const d = shiftDate(day, -back);
          const held = await kit.salesOf(tenantId, d, scope);
          if (held.sales.length > 0) prior = { day: d, sales: held.sales };
        }
        const takenToday = sum(today.sales.map((s) => s.totalMinor));
        const noPrior = prior === undefined ? `no sale reached head office on any of the 31 days before ${day}` : undefined;
        const takenBefore = prior === undefined ? undefined : sum(prior.sales.map((s) => s.totalMinor));
        return {
          tradingDay: day, sources: today.sources,
          figures: [
            mk(`Taken on ${day}`, takenToday, 'minor_currency'),
            mk('Taken on the last day traded before', takenBefore, 'minor_currency', noPrior),
            mk('Difference', takenBefore === undefined ? undefined : takenToday - takenBefore, 'minor_currency', noPrior),
            ...kit.withheldFigure(mk, today.withheld),
          ],
          rows: [
            { tradingDay: day, totalMinor: String(takenToday), bills: String(today.sales.length) },
            ...(prior === undefined ? [] : [{ tradingDay: prior.day, totalMinor: String(takenBefore), bills: String(prior.sales.length) }]),
          ],
          drill: {
            [`Taken on ${day}`]: today.sales.map((s) => kit.saleTxn(s, s.totalMinor, `bill ${s.receiptNumber}`)),
            ...(prior === undefined ? {} : { 'Taken on the last day traded before': prior.sales.map((s) => kit.saleTxn(s, s.totalMinor, `bill ${s.receiptNumber} (${prior!.day})`)) }),
          },
        };
      }

      case 'margin': {
        // Per bill: what it took net of GST (the line's own frozen rate, else the catalogue's), less what the goods cost
        // at the average buying cost for that store (OB-39). A bill with any line whose cost or tax rate head office does
        // not hold is shown as "not known", and the day's totals are then not available — naming the products.
        const { sales, withheld, sources, asAt, nothingUnsentAt } = await kit.salesOf(tenantId, day, scope);
        const mk = kit.at(asAt, NEVER_SALES, nothingUnsentAt);
        const costs = await averageBuyingCosts({ store: kit.store, now: kit.now }, tenantId);
        const rates = await dayBookAdapter({ store: kit.store, now: kit.now }).taxRates(tenantId);
        const noCost = new Set<string>();
        const noRate = new Set<string>();
        const rows: Record<string, string>[] = [];
        const netTx: SourceTransaction[] = []; const cogsTx: SourceTransaction[] = []; const marginTx: SourceTransaction[] = [];
        for (const s of sales) {
          let net = 0; let cogs = 0; let known = true;
          for (const l of s.lines) {
            const rate = l.taxRateBps ?? rates.get(l.productId);
            if (rate === undefined) { noRate.add(l.productId); known = false; } else net += splitInclusive(l.lineTotalMinor, rate).net;
            const unit = costs.costOf(l.productId, kit.saleBranch(s));
            if (unit === undefined) { noCost.add(l.productId); known = false; } else cogs += valueAtUnitCost(l.quantityMinor, l.uom, unit);
          }
          rows.push({ saleId: s.saleId, netMinor: known ? String(net) : 'not known', cogsMinor: known ? String(cogs) : 'not known', marginMinor: known ? String(net - cogs) : 'not known' });
          if (known) {
            netTx.push(kit.saleTxn(s, net, `bill ${s.receiptNumber}: taken net of GST`));
            cogsTx.push(kit.saleTxn(s, cogs, `bill ${s.receiptNumber}: goods at the average buying cost`));
            marginTx.push(kit.saleTxn(s, net - cogs, `bill ${s.receiptNumber}: margin`));
          }
        }
        const why = [
          ...(noRate.size === 0 ? [] : [`no GST rate for ${[...noRate].sort().join(', ')}`]),
          ...(noCost.size === 0 ? [] : [`no average buying cost for ${[...noCost].sort().join(', ')} — the store has not received it at a cost (never costed at zero)`]),
        ].join('; ');
        const because = why === '' ? undefined : why;
        const net = sum(netTx.map((t) => t.amountMinor)); const cogs = sum(cogsTx.map((t) => t.amountMinor));
        return {
          tradingDay: day, sources,
          figures: [
            mk('Taken net of GST', because === undefined ? net : undefined, 'minor_currency', because),
            mk('Cost of goods sold', because === undefined ? cogs : undefined, 'minor_currency', because),
            mk('Margin', because === undefined ? net - cogs : undefined, 'minor_currency', because),
            mk('Margin (basis points of net)', because === undefined && net !== 0 ? Math.round(((net - cogs) * 10_000) / net) : undefined, 'basis_points',
              because ?? (net === 0 ? 'nothing was taken net of GST, so there is no margin to express as a share' : undefined)),
            ...kit.withheldFigure(mk, withheld),
          ],
          rows,
          drill: because === undefined ? { 'Taken net of GST': netTx, 'Cost of goods sold': cogsTx, Margin: marginTx } : {},
        };
      }

      case 'customer_repeat': {
        // The month to the asked day: bills that named a customer (the pseudonymous member code — never a phone number),
        // how many distinct customers, and how many came back. Rows are by how often, never by who.
        const days: string[] = [];
        for (let d = period.from; d <= period.to; d = shiftDate(d, 1)) days.push(d);
        const held = await Promise.all(days.map((d) => kit.salesOf(tenantId, d, scope)));
        const sales = held.flatMap((h) => h.sales);
        const last = held[held.length - 1]!;
        const mk = kit.at(last.asAt, NEVER_SALES, last.nothingUnsentAt);
        const named = sales.filter((s) => typeof s.customerRef === 'string' && s.customerRef !== '');
        const visits = new Map<string, IncomingSale[]>();
        for (const s of named) visits.set(s.customerRef!, [...(visits.get(s.customerRef!) ?? []), s]);
        const buckets = new Map<number, number>();
        for (const list of visits.values()) buckets.set(list.length, (buckets.get(list.length) ?? 0) + 1);
        const back = [...visits.values()].filter((l) => l.length >= 2);
        return {
          tradingDay: day, period, sources: last.sources,
          figures: [
            mk('Customers named on a bill', visits.size, 'count'),
            mk('Customers who came back', back.length, 'count'),
            mk('Visits by named customers', named.length, 'count'),
            mk('Taken from named customers', sum(named.map((s) => s.totalMinor)), 'minor_currency'),
            mk('Bills with no customer named', sales.length - named.length, 'count'),
          ],
          rows: [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([n, customers]) => ({ visits: String(n), customers: String(customers) })),
          drill: { 'Taken from named customers': named.map((s) => kit.saleTxn(s, s.totalMinor, `bill ${s.receiptNumber} (a named customer)`)) },
        };
      }

      // ── stock ─────────────────────────────────────────────────────────────────────────────────────────────────
      case 'shrinkage': {
        // The month's shelf counts that CHANGED the books (applied at once, or approved by a second person): counted
        // short is stock lost, counted over is stock found, each at head office's own cost (SP-4). A count still waiting
        // for its approver is shown beside, not folded in; a count head office could not value makes the value not
        // available, naming the products — never valued at zero.
        const countsStream = streamName(STREAM.inventory, 'counts');
        const latest = new Map<string, { p: StoredReconciliation; at: string }>();
        const all = [...await recordsOf<StoredReconciliation>(kit.store, tenantId, countsStream, 'CountReconciled'), ...await recordsOf<StoredReconciliation>(kit.store, tenantId, countsStream, 'CountDecided')]
          .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
        for (const r of all) latest.set(r.p.countId, r);
        const asAt = newestOf(all.map((r) => r.at));
        const mk = kit.at(asAt, 'no shelf count has ever been recorded at head office');
        const mine = [...latest.values()].map((r) => r.p).filter((c) => inScope(scope, c.locationId) && inPeriod(c.at));
        const applied = mine.filter((c) => c.adjusted || c.decision === 'approved');
        const waiting = mine.filter((c) => c.pendingApproval === true && c.decision === undefined);
        const unvalued = applied.filter((c) => c.varianceMinor !== 0 && (c.governanceFlags ?? []).includes('value_unknown'));
        const because = unvalued.length === 0 ? undefined
          : `head office holds no cost for ${[...new Set(unvalued.map((c) => c.productId))].sort().join(', ')}, so what the difference is worth is not known (never valued at zero)`;
        const tx = (c: StoredReconciliation, sign: number): SourceTransaction => ({
          transactionId: c.countId, at: c.at, branchId: c.locationId, staffId: c.counterId, amountMinor: sign * c.valueMinor,
          description: `count ${c.countId}: ${c.productId} expected ${c.expectedMinor}, counted ${c.countedMinor}`,
        });
        const short = applied.filter((c) => c.varianceMinor < 0); const over = applied.filter((c) => c.varianceMinor > 0);
        const lost = sum(short.map((c) => c.valueMinor)); const found = sum(over.map((c) => c.valueMinor));
        return {
          period, sources: [fresh('shelf counts', 'stock', asAt)],
          figures: [
            mk('Counts that changed the books', applied.length, 'count'),
            mk('Lost (counted short)', because === undefined ? lost : undefined, 'minor_currency', because),
            mk('Found (counted over)', because === undefined ? found : undefined, 'minor_currency', because),
            mk('Net shrinkage (lost less found)', because === undefined ? lost - found : undefined, 'minor_currency', because),
            mk('Counts waiting for a second person', waiting.length, 'count'),
          ],
          rows: applied.map((c) => ({
            countId: c.countId, productId: c.productId, locationId: c.locationId, varianceMinor: String(c.varianceMinor),
            valueMinor: (c.governanceFlags ?? []).includes('value_unknown') && c.varianceMinor !== 0 ? 'not known' : String(c.varianceMinor < 0 ? -c.valueMinor : c.valueMinor),
          })),
          drill: because === undefined ? {
            'Lost (counted short)': short.map((c) => tx(c, 1)),
            'Found (counted over)': over.map((c) => tx(c, 1)),
            'Net shrinkage (lost less found)': [...short.map((c) => tx(c, 1)), ...over.map((c) => tx(c, -1))],
          } : {},
        };
      }

      case 'waste': {
        // The month's committed write-offs (M28): what was thrown away, by kind of loss, at the value head office's own
        // cost gave it (SF-05). A write-off head office could not value carries the raiser's stated value and was governed
        // as a big one — shown on its own line, never mixed into the costed total.
        const all = await recordsOf<StoredWriteOff>(kit.store, tenantId, streamName(STREAM.inventory, 'write-offs'), 'WriteOffCommitted');
        const asAt = newestOf(all.map((r) => r.at));
        const mk = kit.at(asAt, 'no write-off has ever been committed at head office');
        const mine = all.map((r) => r.p).filter((w) => inScope(scope, w.locationId) && inPeriod(w.at));
        const costed = mine.filter((w) => w.valueSource !== 'cost_unknown');
        const stated = mine.filter((w) => w.valueSource === 'cost_unknown');
        const byType = new Map<string, StoredWriteOff[]>();
        for (const w of costed) byType.set(w.lossType, [...(byType.get(w.lossType) ?? []), w]);
        const types = [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        const tx = (w: StoredWriteOff): SourceTransaction => ({
          transactionId: w.id, at: w.at, branchId: w.locationId, staffId: w.raisedBy, amountMinor: w.valueMinor,
          description: `write-off ${w.id}: ${w.qtyRemoved} ${w.uom} of ${w.productId} (${w.lossType}, ${w.reasonCode})`,
        });
        return {
          period, sources: [fresh('write-offs', 'stock', asAt)],
          figures: [
            mk('Thrown away, at cost', sum(costed.map((w) => w.valueMinor)), 'minor_currency'),
            ...types.map(([t, list]) => mk(`${t} — at cost`, sum(list.map((w) => w.valueMinor)), 'minor_currency')),
            mk('Write-offs', mine.length, 'count'),
            ...(stated.length === 0 ? [] : [mk('Thrown away at a value the raiser stated (no cost held)', sum(stated.map((w) => w.valueMinor)), 'minor_currency')]),
          ],
          rows: mine.map((w) => ({ writeOffId: w.id, productId: w.productId, locationId: w.locationId, lossType: w.lossType, quantity: String(w.qtyRemoved), valueMinor: String(w.valueMinor), valueSource: w.valueSource ?? 'stock_cost' })),
          drill: {
            'Thrown away, at cost': costed.map(tx),
            ...Object.fromEntries(types.map(([t, list]) => [`${t} — at cost`, list.map(tx)])),
            ...(stated.length === 0 ? {} : { 'Thrown away at a value the raiser stated (no cost held)': stated.map(tx) }),
          },
        };
      }

      case 'expiry': {
        // The batches on hand at the asked day that are past their expiry (dispose) or within 7 days of it (mark down) —
        // the SAME fold the near-expiry route and the A03 agent read (ADR-0015), limited to the reader's branches.
        const moves = await kit.store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' });
        const withExpiry = moves.filter((e) => typeof (e.event.payload as { expiry?: unknown }).expiry === 'string');
        const asAt = newestOf(moves.map((e) => e.event.occurredAt));
        const mk = kit.at(withExpiry.length === 0 ? null : asAt, 'no goods have been received with an expiry date at head office');
        const items = await nearExpiryAdapter({ store: kit.store, now: kit.now }).nearExpiry(tenantId, {
          asOf: day, nearExpiryDays: 7, ...(scope === 'all' ? {} : { covers: (loc: string) => inScope(scope, loc) }),
        });
        const past = items.filter((i) => i.action === 'dispose'); const near = items.filter((i) => i.action === 'markdown');
        return {
          tradingDay: day, sources: [fresh('stock ledger', 'stock', asAt)],
          figures: [
            mk('Batches past expiry', past.length, 'count'), mk('Units past expiry', sum(past.map((i) => i.qty)), 'count'),
            mk('Batches expiring within 7 days', near.length, 'count'), mk('Units expiring within 7 days', sum(near.map((i) => i.qty)), 'count'),
          ],
          rows: items.map((i) => ({ batchId: i.batchId, productId: i.productId, expiry: i.expiry, quantity: String(i.qty), action: i.action, daysToExpiry: String(i.daysToExpiry) })),
          drill: {},
        };
      }

      // ── operations ────────────────────────────────────────────────────────────────────────────────────────────
      case 'exceptions': {
        // The asked day's voids, no-sales, price overrides and refunds, and what the shop's OWN rules raised on them
        // (PF-07). A till action names its lane, not its branch, so a branch-limited reader is told, not shown a part.
        if (scope !== 'all') return companyOnly('Breaches of the shop\'s own limits', 'count', 'till actions are recorded by lane, not by branch;');
        const activityStream = streamName(STREAM.lossPrevention, 'activity');
        const raisedStream = streamName(STREAM.lossPrevention, 'raised');
        const acts = await recordsOf<TillActivity>(kit.store, tenantId, activityStream, 'TillActivityRecorded');
        const raisedAll = await recordsOf<RaisedException>(kit.store, tenantId, raisedStream, 'LpExceptionRaised');
        const window = tradingDayWindow(day, calendar);
        const returns = await kit.store.readStream(tenantId, STREAM.returns, { type: 'ReturnRecorded', from: window.from, to: new Date(Date.parse(window.to) - 1).toISOString() });
        const asAt = newestOf([...acts.map((a) => a.at), ...raisedAll.map((r) => r.at), ...returns.map((e) => e.event.occurredAt)]);
        const mk = kit.at(asAt, 'no till action, refund or rule breach has ever reached head office');
        const today = acts.map((a) => a.p).filter((a) => (a.tradingDay ?? tradingDayIn(a.at, calendar)) === day);
        const latestRaised = new Map<string, RaisedException>();
        for (const r of raisedAll) if (r.p.day === day) latestRaised.set(r.p.exceptionId, r.p);
        const raised = [...latestRaised.values()].sort((a, b) => a.exceptionId.localeCompare(b.exceptionId));
        const refunds = returns.map((e) => e.event.payload as { returnId: string; processedBy: string; processedAt: string; refundMinor: number });
        const actTx = (a: TillActivity): SourceTransaction => ({ transactionId: a.activityId, at: a.at, branchId: a.laneId, staffId: a.cashierId, amountMinor: a.valueMinor, description: `${a.kind} on lane ${a.laneId}${a.billRef === undefined ? '' : `, bill ${a.billRef}`}: ${a.reason}` });
        const of = (k: TillActivity['kind']) => today.filter((a) => a.kind === k);
        return {
          tradingDay: day, sources: [fresh('till actions and rule breaches', 'loss prevention', asAt)],
          figures: [
            mk('Breaches of the shop\'s own limits', raised.length, 'count'),
            mk('Voids', of('void').length, 'count'), mk('Voided value', sum(of('void').map((a) => a.valueMinor)), 'minor_currency'),
            mk('No-sales', of('no_sale').length, 'count'),
            mk('Price overrides', of('price_override').length, 'count'), mk('Taken off by overrides', sum(of('price_override').map((a) => a.valueMinor)), 'minor_currency'),
            mk('Refunds', refunds.length, 'count'), mk('Refunded', sum(refunds.map((r) => r.refundMinor)), 'minor_currency'),
          ],
          rows: raised.map((r) => ({ n: String(r.observed), what: `${r.kind}: ${r.breach} (cashier ${r.cashierId}, limit ${r.limit}, ${r.severity})` })),
          drill: {
            'Voided value': of('void').map(actTx),
            'Taken off by overrides': of('price_override').map(actTx),
            Refunded: refunds.map((r) => ({ transactionId: r.returnId, at: r.processedAt, branchId: 'company', staffId: r.processedBy, amountMinor: r.refundMinor, description: `refund ${r.returnId}` })),
          },
        };
      }

      case 'ai_outcomes': {
        // The month's AI proposals by agent, and the decisions people recorded on what the assistant raised: the dismissal
        // registers (data quality, operations, workforce) and the service desk's decisions on AI drafts. A proposal can
        // commit nothing (hard rule #5) — this shows what was suggested and what a person did about it.
        if (scope !== 'all') return companyOnly('Proposals', 'count', 'the assistant\'s register is company-wide;');
        const proposals = (await recordsOf<Proposal>(kit.store, tenantId, STREAM.ai, 'AiProposalRaised')).filter((r) => inPeriod(r.at));
        const decided: { agent: string; at: string; id: string; what: string; by: string }[] = [];
        for (const [type, agent] of [['AiDataQualityDismissed', 'A08'], ['AiOperationsDismissed', 'A06'], ['AiWorkforceDismissed', 'A10']] as const) {
          for (const r of await recordsOf<{ findingId: string; dismissed: boolean; by: string }>(kit.store, tenantId, STREAM.ai, type)) {
            if (inPeriod(r.at)) decided.push({ agent, at: r.at, id: r.p.findingId, what: r.p.dismissed ? 'dismissed' : 'kept open', by: r.p.by });
          }
        }
        for (const r of await recordsOf<{ draftId: string; decision: string; approvedBy: string }>(kit.store, tenantId, streamName(STREAM.service, 'drafts'), 'DraftDecided')) {
          if (inPeriod(r.at)) decided.push({ agent: 'A05', at: r.at, id: r.p.draftId, what: r.p.decision, by: r.p.approvedBy });
        }
        const drafts = (await recordsOf<{ draftId: string }>(kit.store, tenantId, streamName(STREAM.service, 'drafts'), 'AiDraftRecorded')).filter((r) => inPeriod(r.at));
        const asAt = newestOf([...proposals.map((p) => p.at), ...decided.map((d) => d.at), ...drafts.map((d) => d.at)]);
        const mk = kit.at(asAt, 'the assistant has never proposed anything at head office');
        const agents = [...new Set([...proposals.map((p) => p.p.agent), ...decided.map((d) => d.agent), ...(drafts.length === 0 ? [] : ['A05'])])].sort();
        const proposedBy = (a: string): number => proposals.filter((p) => p.p.agent === a).length + (a === 'A05' ? drafts.length : 0);
        return {
          period, sources: [fresh('assistant register', 'ai', asAt)],
          figures: [
            mk('Proposals and drafts', proposals.length + drafts.length, 'count'),
            mk('Decided by a person', decided.length, 'count'),
            ...agents.flatMap((a) => [mk(`${a} — proposed`, proposedBy(a), 'count'), mk(`${a} — decided by a person`, decided.filter((d) => d.agent === a).length, 'count')]),
          ],
          rows: agents.map((a) => ({ agent: a, proposed: String(proposedBy(a)), decided: String(decided.filter((d) => d.agent === a).length) })),
          drill: {},
        };
      }

      // ── purchasing ────────────────────────────────────────────────────────────────────────────────────────────
      case 'supplier_service': {
        // Per supplier, over every ISSUED order on the register: units ordered (less what was cancelled), units the goods
        // receipts posted against them, and the share delivered. A supplier with nothing still owed has no fill share.
        if (scope !== 'all') return companyOnly('Units ordered', 'count', 'purchase orders are company-wide records;');
        const orders = [...(await foldPurchaseOrders(kit.store, tenantId)).values()].filter((o) => o.status === 'issued');
        const asAt = newestOf((await kit.store.readStream(tenantId, streamName(STREAM.purchase, 'orders'))).map((e) => e.event.occurredAt));
        const mk = kit.at(asAt, 'no purchase order has ever been raised at head office');
        const by = new Map<string, { ordered: number; received: number; orders: number }>();
        for (const o of orders) {
          const held = by.get(o.supplierId) ?? { ordered: 0, received: 0, orders: 0 };
          const cancelled = sum(Object.values(o.cancelledByProduct));
          held.ordered += sum(o.lines.map((l) => l.orderedQty)) - cancelled;
          held.received += sum(Object.values(o.receivedByProduct));
          held.orders += 1;
          by.set(o.supplierId, held);
        }
        const ordered = [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        return {
          sources: [fresh('purchase orders and receipts', 'purchasing', asAt)],
          figures: ordered.flatMap(([s, t]) => [
            mk(`${s} — units ordered`, t.ordered, 'count'),
            mk(`${s} — units received`, t.received, 'count'),
            mk(`${s} — delivered (basis points of ordered)`, t.ordered > 0 ? Math.round((t.received * 10_000) / t.ordered) : undefined, 'basis_points',
              t.ordered > 0 ? undefined : 'nothing is on order from this supplier'),
          ]),
          rows: ordered.map(([s, t]) => ({ supplierId: s, orders: String(t.orders), orderedUnits: String(t.ordered), receivedUnits: String(t.received) })),
          drill: {},
        };
      }

      case 'invoice_differences': {
        // Every captured supplier bill's LATEST three-way-match verdict: what the supplier billed, what may be paid (the
        // lowest of order, receipt and bill), and the difference held back. A bill never matched is counted, not guessed.
        if (scope !== 'all') return companyOnly('Billed', 'minor_currency', 'supplier bills are company-wide records;');
        const invoices = await recordsOf<{ invoiceId: string; supplierId: string }>(kit.store, tenantId, streamName(STREAM.purchase, 'invoices'), 'SupplierInvoiceCaptured');
        const matches = await recordsOf<StoredMatch>(kit.store, tenantId, STREAM.purchase, 'InvoiceMatched');
        const latest = new Map<string, StoredMatch>();
        for (const m of matches) latest.set(m.p.invoiceId, m.p);
        const supplierOf = new Map(invoices.map((i) => [i.p.invoiceId, i.p.supplierId] as const));
        const asAt = newestOf([...invoices.map((i) => i.at), ...matches.map((m) => m.at)]);
        const mk = kit.at(asAt, 'no supplier bill has ever been captured at head office');
        const verdicts = [...latest.values()].filter((m) => supplierOf.has(m.invoiceId)).sort((a, b) => a.invoiceId.localeCompare(b.invoiceId));
        const differing = verdicts.filter((m) => m.invoicedMinor !== m.payableMinor);
        const tx = (m: StoredMatch, amountMinor: number, what: string): SourceTransaction => ({
          transactionId: m.invoiceId, at: m.matchedAt, branchId: 'company', vendorId: supplierOf.get(m.invoiceId) ?? 'unknown', staffId: m.matchedBy, amountMinor, description: `bill ${m.invoiceId}: ${what}`,
        });
        return {
          sources: [fresh('supplier bills and match verdicts', 'purchasing', asAt)],
          figures: [
            mk('Bills captured', invoices.length, 'count'),
            mk('Bills not yet matched', [...supplierOf.keys()].filter((id) => !latest.has(id)).length, 'count'),
            mk('Bills where billed and payable differ', differing.length, 'count'),
            mk('Billed', sum(verdicts.map((m) => m.invoicedMinor)), 'minor_currency'),
            mk('Payable', sum(verdicts.map((m) => m.payableMinor)), 'minor_currency'),
            mk('Held back (billed less payable)', sum(verdicts.map((m) => m.invoicedMinor - m.payableMinor)), 'minor_currency'),
          ],
          rows: differing.map((m) => ({ invoiceId: m.invoiceId, supplierId: supplierOf.get(m.invoiceId) ?? 'unknown', invoicedMinor: String(m.invoicedMinor), payableMinor: String(m.payableMinor), differenceMinor: String(m.invoicedMinor - m.payableMinor) })),
          drill: {
            Billed: verdicts.map((m) => tx(m, m.invoicedMinor, 'billed')),
            Payable: verdicts.map((m) => tx(m, m.payableMinor, 'payable')),
            'Held back (billed less payable)': differing.map((m) => tx(m, m.invoicedMinor - m.payableMinor, 'held back')),
          },
        };
      }

      // ── fulfilment ────────────────────────────────────────────────────────────────────────────────────────────
      case 'orders_and_substitutions': {
        // The month's online orders at the reader's stores, where each has got to, and the substitutions recorded on them
        // with the refunds they made due (a fact here — the refund is issued by the refund surface, never by a report).
        const orders = (await ordersForExport(kit.store, tenantId)).filter((o) => inScope(scope, o.locationId) && inPeriod(o.placedAt));
        const storeOf = new Map(orders.map((o) => [o.orderId, o.locationId] as const));
        const subsAll = await recordsOf<StoredSubstitution>(kit.store, tenantId, streamName(STREAM.orders, 'substitutions'), 'LineSubstituted');
        const subs = new Map<string, StoredSubstitution>();
        for (const s of subsAll) if (storeOf.has(s.p.orderId)) subs.set(`${s.p.orderId}#${s.p.lineId}`, s.p);
        const placedAll = await kit.store.readStream(tenantId, streamName(STREAM.orders, 'index'), { type: 'OrderPlaced' });
        const asAt = newestOf([...placedAll.map((e) => e.event.occurredAt), ...subsAll.map((s) => s.at)]);
        const mk = kit.at(asAt, 'no online order has ever been placed at head office');
        const byState = new Map<string, number>();
        for (const o of orders) byState.set(o.currentState, (byState.get(o.currentState) ?? 0) + 1);
        const byOutcome = new Map<string, number>();
        for (const s of subs.values()) byOutcome.set(s.outcome, (byOutcome.get(s.outcome) ?? 0) + 1);
        const subList = [...subs.values()];
        return {
          period, sources: [fresh('online orders', 'fulfilment', asAt)],
          figures: [
            mk('Orders placed', orders.length, 'count'),
            ...[...byState.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([st, n]) => mk(`Orders now ${st}`, n, 'count')),
            mk('Lines substituted', subList.length, 'count'),
            ...[...byOutcome.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([o, n]) => mk(`Substitutions — ${o}`, n, 'count')),
            mk('Refunds due from substitutions', sum(subList.map((s) => s.refundMinor)), 'minor_currency'),
          ],
          rows: orders.map((o) => ({ orderId: o.orderId, locationId: o.locationId, state: o.currentState, lines: String(o.lines.length), substituted: String(subList.filter((s) => s.orderId === o.orderId).length) })),
          drill: {
            'Refunds due from substitutions': subList.filter((s) => s.refundMinor !== 0).map((s) => ({
              transactionId: `${s.orderId}#${s.lineId}`, at: s.at, branchId: storeOf.get(s.orderId)!, amountMinor: s.refundMinor, description: `order ${s.orderId} line ${s.lineId}: ${s.outcome}`,
            })),
          },
        };
      }

      case 'delivery_sla': {
        // The month's delivery orders with a booked slot: delivered by the end of the slot (on time), delivered after it
        // (late), and not delivered yet. An order with no slot booked is counted on its own, never judged.
        const orders = (await ordersForExport(kit.store, tenantId)).filter((o) => o.fulfilment === 'delivery' && inScope(scope, o.locationId) && inPeriod(o.placedAt));
        const rows: Record<string, string>[] = [];
        const times: string[] = [];
        let onTime = 0; let late = 0; let open = 0; let noSlot = 0;
        for (const o of orders) {
          const booked = await kit.store.findByIdempotencyKey(tenantId, `slot-booking-${tenantId}-${o.orderId}`);
          const slot = booked?.event.payload as SlotBooking | undefined;
          const steps = await recordsOf<DeliveryStateRecord>(kit.store, tenantId, streamName(STREAM.delivery, 'order', o.orderId), 'DeliveryStateChanged');
          for (const s of steps) times.push(s.at);
          if (booked !== undefined) times.push(booked.event.occurredAt);
          const delivered = steps.map((s) => s.p).filter((s) => s.to === 'delivered').at(-1);
          let verdict: string;
          if (slot === undefined) { noSlot += 1; verdict = 'no slot booked'; }
          else if (delivered === undefined) { open += 1; verdict = 'not delivered yet'; }
          else if (Date.parse(delivered.at) <= Date.parse(slot.slotEndsAt)) { onTime += 1; verdict = 'on time'; }
          else { late += 1; verdict = 'late'; }
          rows.push({ orderId: o.orderId, slotEndsAt: slot?.slotEndsAt ?? 'none', deliveredAt: delivered?.at ?? 'not yet', verdict });
        }
        const asAt = newestOf(times);
        const mk = kit.at(asAt, 'no delivery slot has been booked and no delivery recorded at head office');
        const judged = onTime + late;
        return {
          period, sources: [fresh('delivery slots and steps', 'fulfilment', asAt)],
          figures: [
            mk('Delivered on time', onTime, 'count'), mk('Delivered late', late, 'count'), mk('Not delivered yet', open, 'count'),
            mk('Delivery orders with no slot booked', noSlot, 'count'),
            mk('On time (basis points of delivered)', judged > 0 ? Math.round((onTime * 10_000) / judged) : undefined, 'basis_points',
              judged > 0 ? undefined : 'no booked delivery has been delivered in this period'),
          ],
          rows, drill: {},
        };
      }

      case 'delivery_contribution': {
        // Per delivery stop dispatch handed a driver this month: the order value dispatch recorded (as the customer pays
        // it, GST included), less the goods at the average buying cost at that store (OB-39), less what dispatch recorded
        // the stop costs to drive. A stop missing any of the three is shown as not known and the total is not available.
        const nodes = await orgStructureAdapter({ store: kit.store, now: kit.now }).nodes(tenantId);
        const storeIds = [...new Set(nodes.filter((n) => n.kind === 'branch').map((n) => n.nodeId))].filter((s) => inScope(scope, s)).sort();
        const assignments: { p: RouteAssignment; at: string }[] = [];
        for (const s of storeIds) assignments.push(...await recordsOf<RouteAssignment>(kit.store, tenantId, streamName(STREAM.delivery, 'assignments', s), 'RouteAssigned'));
        const latestRoute = new Map<string, RouteAssignment>();
        for (const a of assignments.sort((x, y) => Date.parse(x.at) - Date.parse(y.at))) latestRoute.set(a.p.routeId, a.p);
        const routes = [...latestRoute.values()].filter((r) => inPeriod(r.at));
        const asAt = newestOf(assignments.map((a) => a.at));
        const mk = kit.at(asAt, 'no delivery route has ever been handed to a driver at head office');
        const costs = await averageBuyingCosts({ store: kit.store, now: kit.now }, tenantId);
        const orders = new Map((await ordersForExport(kit.store, tenantId)).map((o) => [o.orderId, o] as const));
        const rows: Record<string, string>[] = [];
        const tx: SourceTransaction[] = [];
        const missing: string[] = [];
        for (const r of routes) {
          for (const stop of r.stops) {
            const order: PlacedOrder | undefined = orders.get(stop.orderRef);
            let goods: number | undefined = order === undefined ? undefined : 0;
            for (const l of order?.lines ?? []) {
              const unit = costs.costOf(l.productId, r.storeId);
              goods = unit === undefined || goods === undefined ? undefined : goods + valueAtUnitCost(l.quantityMinor, 'ea', unit);
            }
            const known = stop.orderValueMinor !== undefined && stop.costMinor !== undefined && goods !== undefined;
            const value = known ? stop.orderValueMinor! - goods! - stop.costMinor! : undefined;
            if (!known) {
              missing.push(`${stop.stopId} (${[stop.orderValueMinor === undefined ? 'no order value' : '', stop.costMinor === undefined ? 'no delivery cost' : '', goods === undefined ? (order === undefined ? 'order not on record' : 'a product with no average buying cost') : ''].filter((x) => x !== '').join(', ')})`);
            } else {
              tx.push({ transactionId: `${r.routeId}/${stop.stopId}`, at: r.at, branchId: r.storeId, staffId: r.driverId, amountMinor: value!, description: `order ${stop.orderRef}: ${stop.orderValueMinor} less goods ${goods} less delivery ${stop.costMinor}` });
            }
            rows.push({ routeId: r.routeId, stopId: stop.stopId, orderRef: stop.orderRef, orderValueMinor: String(stop.orderValueMinor ?? 'not known'), goodsCostMinor: goods === undefined ? 'not known' : String(goods), deliveryCostMinor: String(stop.costMinor ?? 'not known'), contributionMinor: value === undefined ? 'not known' : String(value) });
          }
        }
        const because = missing.length === 0 ? undefined : `not known for stop ${missing.join('; ')}`;
        return {
          period, sources: [fresh('delivery routes', 'fulfilment', asAt)],
          figures: [
            mk('Deliveries handed to drivers', rows.length, 'count'),
            mk('Contribution after goods and delivery cost', because === undefined ? sum(tx.map((t) => t.amountMinor)) : undefined, 'minor_currency', because),
            mk('Deliveries that earned less than they cost', tx.filter((t) => t.amountMinor < 0).length, 'count'),
          ],
          rows,
          drill: because === undefined ? { 'Contribution after goods and delivery cost': tx } : {},
        };
      }

      // ── customer ──────────────────────────────────────────────────────────────────────────────────────────────
      case 'marketing': {
        // What the shop sent this month (the campaign send register — counts only; recipients are never stored) and what
        // the providers' SIGNED delivery reports say came of it, beside the complaints the service desk opened and closed.
        if (scope !== 'all') return companyOnly('Messages sent', 'count', 'campaigns and the service desk are company-wide;');
        const sends = (await recordsOf<CampaignSendRecord>(kit.store, tenantId, streamName(STREAM.service, 'campaign-sends'), 'CampaignSent')).filter((s) => inPeriod(s.p.at));
        const sentIds = new Set(sends.flatMap((s) => s.p.messageIds));
        const reports = await recordsOf<DeliveryCallback>(kit.store, tenantId, streamName(STREAM.service, 'campaign-delivery'), 'CampaignDeliveryReported');
        const latestReport = new Map<string, DeliveryCallback>();
        for (const r of reports) if (sentIds.has(r.p.messageId)) latestReport.set(r.p.messageId, r.p);
        const caseEvents = await recordsOf<ServiceCase>(kit.store, tenantId, streamName(STREAM.service, 'cases'), 'ServiceCaseRecorded');
        const cases = new Map<string, ServiceCase>();
        for (const c of caseEvents) cases.set(c.p.caseId, c.p);
        const complaints = [...cases.values()].filter((c) => c.kind === 'complaint' && inPeriod(c.openedAt));
        const asAt = newestOf([...sends.map((s) => s.at), ...reports.map((r) => r.at), ...caseEvents.map((c) => c.at)]);
        const mk = kit.at(asAt, 'no campaign has been sent and no complaint recorded at head office');
        const status = (st: DeliveryCallback['status']): number => [...latestReport.values()].filter((r) => r.status === st).length;
        return {
          period, sources: [fresh('campaign sends, delivery reports and service cases', 'customer', asAt)],
          figures: [
            mk('Campaign sends', sends.length, 'count'),
            mk('Messages sent', sentIds.size, 'count'),
            mk('Delivered (provider reported)', status('delivered') + status('read'), 'count'),
            mk('Failed (provider reported)', status('failed'), 'count'),
            mk('No provider report yet', sentIds.size - latestReport.size, 'count'),
            mk('Excluded at send (no consent, cap, …)', sum(sends.flatMap((s) => Object.values(s.p.excludedByReason))), 'count'),
            mk('Complaints opened', complaints.length, 'count'),
            mk('Complaints resolved', complaints.filter((c) => c.state === 'resolved' || c.state === 'closed').length, 'count'),
          ],
          rows: sends.map((s) => ({ campaignId: s.p.campaignId, channel: s.p.channel, sent: String(s.p.messageIds.length), at: s.p.at })),
          drill: {},
        };
      }

      default:
        throw new Error(`no head-office producer for report "${reportId}"`);
    }
  };
}
