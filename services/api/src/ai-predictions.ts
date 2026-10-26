// OB-288 lane 4 · P1: the forecast, quotation, overstock and expiry-prediction legs (A02 · A03 · AI-NFR-04).
//
// Each reads head office's governed records only and drafts for a person; none appends anything (hard rule #5). The
// forecast is the tested D-1 engine (`forecastDemand`, baseline × day of week) fitted on the same 56-day window the
// suggested-order route fits on; the look-ahead is the same seven days the stock-out legs already use; "overstock" is
// stock that would still be on the shelf past the start of the oldest ageing bucket (`DEFAULT_AGEING_BUCKETS`, 91 days —
// the money-asleep line M08-FR-04 already draws). NO quantity is ever drafted: how many to order, move or mark down is
// the buyer's or the manager's decision, and the evidence says what the records say.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import { FACT_CONFIDENCE, type Confidence, type Proposal } from '../../ai/src/index';
import type { IncomingSale } from '../../pos/src/sale-intake';
import { STREAM, inventoryAdapter, rfqAdapter } from './adapters';
import { forecastDemand } from '../../../packages/demand/src/forecast';
import { compareQuotes } from '../../../packages/purchasing/src/rfq';
import { DEFAULT_AGEING_BUCKETS } from '../../../packages/stock/src/metrics';
import type { NearExpiryDeps } from '../../inventory/src/near-expiry';
import { DEFAULT_SHOP_CALENDAR } from '../../../packages/calendar/src/shop-clock';
import { shiftDate, tradingDayIn, tradingDayWindow } from '../../../packages/calendar/src/trading-day';

type Draft = Omit<Proposal, 'committed'>;
const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The D-1 suggested-order route's fit window (services/inventory/src/sales-history.ts: today − 55 … today). */
export const FIT_DAYS = 56;
/** The seven days the stock-out legs (ai-insights.ts) already look at. */
export const LOOKAHEAD_DAYS = 7;
/** Stock that would outlast the start of the oldest ageing bucket is overstock (M08-FR-04's own line). */
export const OVERSTOCK_COVER_DAYS = DEFAULT_AGEING_BUCKETS[DEFAULT_AGEING_BUCKETS.length - 1]!.fromDays;

const forecastConfidence = (days: number): Confidence => ({
  band: 'medium', basis: 'forecast',
  uncertainty: `A forecast from ${days} day(s) of this shop's own sales, weekday by weekday. It cannot know about a festival, an offer or a supplier problem that has not happened yet.`,
});

interface DemandPoint { readonly productId: string; readonly locationId: string; readonly history: { day: string; qty: number }[] }

/** Daily units sold per product and selling place over the fit window, from the sales ledger. */
async function demandSeries(store: EventStore, tenantId: string, now: string): Promise<{ readonly from: string; readonly to: string; readonly series: ReadonlyMap<string, DemandPoint> }> {
  // R1b · R1c (M01-FR-02): the shop's trading days (the shop calendar), never the UTC date of a moment.
  const to = tradingDayIn(now, DEFAULT_SHOP_CALENDAR);
  const from = shiftDate(to, -(FIT_DAYS - 1));
  const sales = await store.readStream(tenantId, STREAM.sales, { type: 'SaleCommitted', from: tradingDayWindow(from, DEFAULT_SHOP_CALENDAR).from, to: now });
  const series = new Map<string, DemandPoint>();
  for (const e of sales) {
    const s = e.event.payload as IncomingSale;
    if (s.locationId === undefined) continue;
    const day = s.tradingDay ?? tradingDayIn(e.event.occurredAt, DEFAULT_SHOP_CALENDAR);
    for (const line of s.lines) {
      const key = `${line.productId}@${s.locationId}`;
      const point = series.get(key) ?? { productId: line.productId, locationId: s.locationId, history: [] };
      point.history.push({ day, qty: line.quantityMinor });
      series.set(key, point);
    }
  }
  return { from, to, series };
}

function forecastOf(point: DemandPoint, from: string, to: string): { readonly perDay: number; readonly next: number } {
  const f = forecastDemand({ history: point.history, from, to, horizonDays: LOOKAHEAD_DAYS });
  return { perDay: f.baselinePerDay, next: f.horizon.reduce((t, d) => t + d.forecastQty, 0) };
}

/** A02 — forecast stock-outs: on the shelf now, but the forecast for the next seven days is more than is on hand. */
export async function forecastReorders(store: EventStore, tenantId: string, now: string): Promise<Draft[]> {
  const { from, to, series } = await demandSeries(store, tenantId, now);
  const rows = await inventoryAdapter({ store, now: () => now }).availability(tenantId);
  const out: Draft[] = [];
  for (const r of [...rows].sort((a, b) => (`${a.productId}@${a.locationId}` < `${b.productId}@${b.locationId}` ? -1 : 1))) {
    const point = series.get(`${r.productId}@${r.locationId}`);
    if (point === undefined || r.onHandMinor <= 0) continue; // out already is the stock-out leg's
    const f = forecastOf(point, from, to);
    if (f.next <= r.onHandMinor) continue;
    out.push({
      proposalId: `a02-forecast-${r.productId}-${r.locationId}-${to}`, agent: 'A02', createdAt: now,
      summary: `${r.productId} at ${r.locationId} is forecast to sell about ${f.next} in the next ${LOOKAHEAD_DAYS} days against ${r.onHandMinor} on hand — it is likely to run out. How many to order is the buyer's decision`,
      wouldRequire: 'POST /v1/purchase/orders/:poId by a buyer, approved by a second person (§28)',
      evidence: [
        { source: 'inventory availability', reference: `/v1/inventory/availability?productId=${r.productId}`, summary: `${r.productId} at ${r.locationId}: on hand ${r.onHandMinor}` },
        { source: 'demand forecast (D-1)', reference: `sales ${from}..${to}`, summary: `about ${f.perDay.toFixed(1)} a day over ${FIT_DAYS} days; ${f.next} forecast for the next ${LOOKAHEAD_DAYS}` },
      ],
      confidence: forecastConfidence(FIT_DAYS),
    });
  }
  return out;
}

/** A02 — quotation comparison: every requisition with two or more quotes, compared like-for-like by the tested engine. */
export async function quotationComparisons(store: EventStore, tenantId: string, now: string): Promise<Draft[]> {
  const rfq = rfqAdapter({ store, now: () => now });
  const out: Draft[] = [];
  for (const requisition of [...(await rfq.requisitions(tenantId))].sort((a, b) => a.requisitionId.localeCompare(b.requisitionId))) {
    const quotes = await rfq.quotes(tenantId, requisition.requisitionId);
    if (quotes.length < 2 || requisition.lines.length === 0) continue;
    const c = compareQuotes({ requisition, quotes });
    const cheapest = c.cheapestOverall === undefined ? undefined : c.totals.find((t) => t.quoteId === c.cheapestOverall!.quoteId);
    if (cheapest === undefined) continue;
    const fastest = c.fastestOverall === undefined ? undefined : c.totals.find((t) => t.quoteId === c.fastestOverall!.quoteId);
    out.push({
      proposalId: `a02-quotes-${requisition.requisitionId}-${[...quotes].map((q) => q.quoteId).sort().join('+')}`, agent: 'A02', createdAt: now,
      summary: `Requisition ${requisition.requisitionId}: ${cheapest.supplierId} is cheapest overall at ${rupees(cheapest.totalCost.minor)} (${cheapest.maxLeadTimeDays} day(s))`
        + (fastest !== undefined && fastest.quoteId !== cheapest.quoteId ? `; ${fastest.supplierId} is fastest (${fastest.maxLeadTimeDays} day(s), ${rupees(fastest.totalCost.minor)})` : '')
        + (c.incompleteQuotes.length > 0 ? `; ${c.incompleteQuotes.length} quote(s) could not be compared like-for-like` : '') + '. The buyer chooses',
      wouldRequire: 'POST /v1/purchase/orders/:poId by a buyer, approved by a second person (§28)',
      evidence: [
        { source: 'quotation comparison', reference: `/v1/purchase/requisitions/${requisition.requisitionId}/comparison`, summary: c.summary },
        ...c.totals.map((t) => ({ source: 'supplier quote', reference: t.quoteId, summary: `${t.supplierId}: ${rupees(t.totalCost.minor)}, ${t.maxLeadTimeDays} day(s)` })),
      ],
      confidence: { ...FACT_CONFIDENCE, uncertainty: 'The prices and days are the quotes as recorded. Whether each supplier delivers on time is not in a quote — read the supplier scorecard too.' },
    });
  }
  return out;
}

/**
 * A03 — the prediction legs: a stock-out forecast where another place has more than its own next seven days (a transfer
 * suggestion), stock that would outlast the oldest ageing bucket (overstock), and a batch that will not sell before its
 * expiry at the rate the product sells (expiry prediction). Each a draft for the manager; nothing moved, marked down or
 * written off here.
 */
export async function inventoryPredictions(store: EventStore, tenantId: string, now: string, nearExpiry?: NearExpiryDeps['nearExpiry']): Promise<Draft[]> {
  const { from, to, series } = await demandSeries(store, tenantId, now);
  const rows = await inventoryAdapter({ store, now: () => now }).availability(tenantId);
  const onHand = new Map<string, number>();
  for (const r of rows) onHand.set(`${r.productId}@${r.locationId}`, (onHand.get(`${r.productId}@${r.locationId}`) ?? 0) + r.onHandMinor);
  const forecasts = new Map<string, { perDay: number; next: number }>();
  for (const [key, point] of series) forecasts.set(key, forecastOf(point, from, to));
  const out: Draft[] = [];
  const keys = [...onHand.keys()].sort();
  for (const key of keys) {
    const [productId, locationId] = key.split('@') as [string, string];
    const here = onHand.get(key) ?? 0;
    const f = forecasts.get(key);
    // Predicted stock-out with a place that holds more than its own next seven days.
    if (f !== undefined && here > 0 && f.next > here) {
      const spare = keys.filter((k) => k !== key && k.startsWith(`${productId}@`))
        .map((k) => ({ loc: k.split('@')[1]!, held: onHand.get(k) ?? 0, need: forecasts.get(k)?.next ?? 0 }))
        .filter((s) => s.held > s.need)
        .sort((a, b) => (b.held - b.need) - (a.held - a.need) || a.loc.localeCompare(b.loc))[0];
      if (spare !== undefined) {
        out.push({
          proposalId: `a03-predicted-out-${productId}-${spare.loc}-${locationId}-${to}`, agent: 'A03', createdAt: now,
          summary: `${productId} at ${locationId} is forecast to sell about ${f.next} in the next ${LOOKAHEAD_DAYS} days with ${here} on hand; ${spare.loc} holds ${spare.held} against its own forecast of ${spare.need}. Consider a transfer before it runs out — how many is the manager's decision`,
          wouldRequire: 'POST /v1/warehouse/transfers/:transferId by a person, dispatched and received by others (M09-FR-03 · §28)',
          evidence: [
            { source: 'inventory availability', reference: `/v1/inventory/availability?productId=${productId}`, summary: `${locationId}: ${here}; ${spare.loc}: ${spare.held}` },
            { source: 'demand forecast (D-1)', reference: `sales ${from}..${to}`, summary: `${locationId} about ${f.next} next ${LOOKAHEAD_DAYS} days; ${spare.loc} about ${spare.need}` },
          ],
          confidence: forecastConfidence(FIT_DAYS),
        });
      }
    }
    // Overstock: at the rate it sells here, what is on hand outlasts the oldest ageing bucket. A product with no sale in
    // the window is NOT judged: it may simply be new (its receipt date is not read here), and calling it overstock would
    // be a guess — the stock-ageing report (M08-FR-04) already shows money asleep by receipt date.
    const perDay = f?.perDay ?? 0;
    if (here > 0 && perDay > 0) {
      const coverDays = here / perDay;
      if (coverDays > OVERSTOCK_COVER_DAYS) {
        out.push({
          proposalId: `a03-overstock-${productId}-${locationId}-${to}`, agent: 'A03', createdAt: now,
          summary: `${productId} at ${locationId}: ${here} on hand covers about ${Math.round(coverDays)} days at ${perDay.toFixed(1)} a day — past the ${OVERSTOCK_COVER_DAYS}-day ageing line, so overstock. Consider a markdown or moving it; the manager decides`,
          wouldRequire: 'POST /v1/prices/changes (markdown) or POST /v1/warehouse/transfers/:transferId, by a manager',
          evidence: [
            { source: 'inventory availability', reference: `/v1/inventory/availability?productId=${productId}`, summary: `${locationId}: on hand ${here}` },
            { source: 'demand forecast (D-1)', reference: `sales ${from}..${to}`, summary: `about ${perDay.toFixed(1)} a day at ${locationId}` },
          ],
          confidence: forecastConfidence(FIT_DAYS),
        });
      }
    }
  }
  // Expiry prediction: a batch beyond the seven-day markdown window that will not sell before its date at the rate the
  // product sells across the company.
  if (nearExpiry !== undefined) {
    const companyRate = new Map<string, number>();
    for (const [key, f] of forecasts) {
      const productId = key.split('@')[0]!;
      companyRate.set(productId, (companyRate.get(productId) ?? 0) + f.perDay);
    }
    const batches = await nearExpiry(tenantId, { asOf: to, nearExpiryDays: OVERSTOCK_COVER_DAYS });
    for (const b of [...batches].sort((x, y) => x.daysToExpiry - y.daysToExpiry || x.batchId.localeCompare(y.batchId))) {
      if (b.daysToExpiry <= LOOKAHEAD_DAYS || b.qty <= 0) continue; // within seven days is the markdown leg's
      const rate = companyRate.get(b.productId) ?? 0;
      const sellable = Math.floor(rate * b.daysToExpiry);
      if (b.qty <= sellable) continue;
      out.push({
        proposalId: `a03-expiry-forecast-${b.batchId}-${to}`, agent: 'A03', createdAt: now,
        summary: `Batch ${b.batchId} of ${b.productId}: ${b.qty} on hand, expires ${b.expiry} (${b.daysToExpiry} days). At about ${rate.toFixed(1)} a day, about ${b.qty - sellable} would be left at expiry. Consider a markdown or a transfer early; the manager decides`,
        wouldRequire: 'POST /v1/prices/changes (markdown) or POST /v1/warehouse/transfers/:transferId, by a manager',
        evidence: [
          { source: 'near-expiry stock (cloud ledger)', reference: b.batchId, summary: `${b.productId} batch ${b.batchId}: ${b.qty} on hand, expiry ${b.expiry}` },
          { source: 'demand forecast (D-1)', reference: `sales ${from}..${to}`, summary: rate === 0 ? `no sale of ${b.productId} in ${FIT_DAYS} days` : `about ${rate.toFixed(1)} a day across the company` },
        ],
        confidence: forecastConfidence(FIT_DAYS),
      });
    }
  }
  return out;
}
