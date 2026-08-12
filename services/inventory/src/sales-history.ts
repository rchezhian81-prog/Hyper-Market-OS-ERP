// API-04 sales-history demand read (M09 — the demand foundation for replenishment D-3, and for the
// forecast D-1 / markdown ladder D-4 to come). Given a window it reports, per product, how much sold
// and how fast — the `avgDailyDemand` a reorder decision needs.
//
// This is a stateless READ, not a write path. The store already keeps every sale as an append-only
// `SaleCommitted` event (the events ARE the record, hard rule #2); the sale-commit path is untouched
// (hard rule #1). The rule is the pure `salesHistory` engine in `packages/demand`; this surface owns
// only "from where" — a windowed read of the sales stream — and "how" stays in the engine.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { salesHistory, InvalidDemandWindowError, type SoldLine } from '../../../packages/demand/src/sales-history';
import { forecastDemand, backtestForecast, InvalidForecastInputError, type DailyDemand, type DemandSignal } from '../../../packages/demand/src/forecast';
import { proposeMarkdown, InvalidMarkdownInputError, type MarkdownPolicy } from '../../../packages/demand/src/markdown';
import { proposeConstrainedOrder, InvalidConstrainedOrderError, type ForecastPoint } from '../../../packages/replenishment/src/constrained-order';

export interface SalesHistoryDeps {
  /** The sold lines whose `occurredAt` falls in [fromIso, toIso). The engine filters to the trading-day window. */
  readonly soldLines: (tenantId: string, fromIso: string, toIso: string) => Promise<readonly SoldLine[]> | readonly SoldLine[];
  readonly now: () => string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function salesHistoryRoutes(deps: SalesHistoryDeps): readonly Route[] {
  return [
    {
      // Per-product demand over a window: total sold, the day-by-day series, and the average daily demand.
      // `?from=&to=` (YYYY-MM-DD); default is the trailing 28 days. `?productId=` scopes to one product.
      api: 'API-04', method: 'GET', path: '/v1/inventory/sales-history',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const today = deps.now().slice(0, 10);
        const to = ctx.query['to'] ?? today;
        const from = ctx.query['from'] ?? addDays(to, -27); // trailing 28 days, inclusive
        if (!DAY.test(from) || !DAY.test(to)) {
          throw apiError(400, {
            code: 'not_a_date_window',
            whatHappened: 'Sales history needs from and to as YYYY-MM-DD dates.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send ?from=YYYY-MM-DD&to=YYYY-MM-DD (or neither for the trailing 28 days). Nothing was changed; this only reads.',
          });
        }
        // Read the event window covering the trading days. A sale booked to `to` can be committed just
        // after midnight, so the upper bound is padded; the engine filters by trading day, so an
        // over-read is only cost, never a double count.
        let lines = await deps.soldLines(ctx.tenantId, `${from}T00:00:00.000Z`, `${addDays(to, 2)}T00:00:00.000Z`);
        const productId = ctx.query['productId'];
        if (productId !== undefined && productId !== '') {
          lines = lines.filter((l) => l.productId === productId);
        }
        try {
          const history = salesHistory({ lines, from, to });
          return { status: 200, body: { ...history, asAt: deps.now() } };
        } catch (e) {
          if (e instanceof InvalidDemandWindowError) {
            throw apiError(400, {
              code: 'invalid_demand_window',
              whatHappened: e.message,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Correct the window and re-send. Nothing was changed.',
            });
          }
          throw e;
        }
      },
    },
    {
      // Demand forecast for ONE product (D-1): baseline × day-of-week seasonality, projected `horizonDays`
      // days ahead from the store's own sales, and — when there is enough history — scored by a back-test on
      // the recent tail so the quality is a number, not a claim. `?productId=` (required), `?from=&to=`
      // (default the trailing 8 weeks), `?horizonDays=` (default 7).
      api: 'API-04', method: 'GET', path: '/v1/inventory/demand-forecast',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const productId = ctx.query['productId'];
        if (productId === undefined || productId === '') {
          throw apiError(400, {
            code: 'forecast_needs_a_product',
            whatHappened: 'A demand forecast is per product — it needs ?productId=.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send ?productId=… (with ?from=&to=&horizonDays= optional). Nothing was changed; this only reads.',
          });
        }
        const today = deps.now().slice(0, 10);
        const to = ctx.query['to'] ?? today;
        const from = ctx.query['from'] ?? addDays(to, -55); // trailing 8 weeks — a weekly pattern plus a holdout
        if (!DAY.test(from) || !DAY.test(to)) {
          throw apiError(400, {
            code: 'not_a_date_window',
            whatHappened: 'A forecast needs from and to as YYYY-MM-DD dates.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send ?from=YYYY-MM-DD&to=YYYY-MM-DD (or neither for the trailing 8 weeks). Nothing was changed.',
          });
        }
        let horizonDays = 7;
        const rawH = ctx.query['horizonDays'];
        if (rawH !== undefined) {
          const n = Number(rawH);
          if (!Number.isInteger(n) || n < 1 || n > 92) {
            throw apiError(400, {
              code: 'bad_forecast_horizon',
              whatHappened: 'horizonDays must be a whole number between 1 and 92.',
              wasItSaved: 'not_saved',
              nextSafeAction: 'Fix horizonDays (or omit it for 7) and re-send. Nothing was changed.',
            });
          }
          horizonDays = n;
        }

        // Known upcoming events (festival / promo / weather), compact-encoded as
        // `?events=FROM~TO~MULT~LABEL,…` — the calendar is data the caller supplies. Parsed leniently here;
        // the engine validates the dates and multipliers (an invalid one is a 400 below).
        let signals: DemandSignal[] = [];
        const rawEvents = ctx.query['events'];
        if (rawEvents !== undefined && rawEvents !== '') {
          signals = rawEvents.split(',').map((entry) => {
            const parts = entry.split('~');
            return {
              from: parts[0] ?? '',
              to: parts[1] ?? '',
              multiplier: Number(parts[2]),
              ...(parts[3] !== undefined && parts[3] !== '' ? { label: parts[3] } : {}),
            };
          });
        }

        const lines = (await deps.soldLines(ctx.tenantId, `${from}T00:00:00.000Z`, `${addDays(to, 2)}T00:00:00.000Z`))
          .filter((l) => l.productId === productId);
        const byDay = salesHistory({ lines, from, to }).products.find((p) => p.productId === productId)?.byDay ?? [];
        const history: DailyDemand[] = byDay.map((d) => ({ day: d.day, qty: d.qtyMinor }));

        // New-item cold-start: a product too new to have its own pattern leans on a peer / category rate
        // (?peerBaselinePerDay=&priorDays=), which its own sales take over as they accumulate.
        let coldStart: { peerBaselinePerDay: number; priorDays?: number } | undefined;
        const rawPeer = ctx.query['peerBaselinePerDay'];
        if (rawPeer !== undefined && rawPeer !== '') {
          const peer = Number(rawPeer);
          if (!Number.isFinite(peer) || peer < 0) {
            throw apiError(400, {
              code: 'bad_cold_start',
              whatHappened: 'peerBaselinePerDay must be a number of at least 0.',
              wasItSaved: 'not_saved',
              nextSafeAction: 'Fix peerBaselinePerDay (or omit it) and re-send. Nothing was changed.',
            });
          }
          coldStart = { peerBaselinePerDay: peer };
          const rawPrior = ctx.query['priorDays'];
          if (rawPrior !== undefined && rawPrior !== '') {
            const prior = Number(rawPrior);
            if (!Number.isInteger(prior) || prior < 1) {
              throw apiError(400, {
                code: 'bad_cold_start',
                whatHappened: 'priorDays must be a whole number of at least 1.',
                wasItSaved: 'not_saved',
                nextSafeAction: 'Fix priorDays (or omit it for 14) and re-send. Nothing was changed.',
              });
            }
            coldStart = { peerBaselinePerDay: peer, priorDays: prior };
          }
        }

        try {
          const forecast = forecastDemand({ history, from, to, horizonDays, ...(signals.length === 0 ? {} : { signals }), ...(coldStart === undefined ? {} : { coldStart }) });
          // Score it only when there is enough history to hold out a week and still train on at least a week.
          const windowDays = Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000) + 1;
          const quality = windowDays >= 14
            ? backtestForecast({ history, from, to, holdoutDays: 7, ...(signals.length === 0 ? {} : { signals }) })
            : undefined;
          return { status: 200, body: { productId, ...forecast, ...(quality === undefined ? {} : { quality }), asAt: deps.now() } };
        } catch (e) {
          if (e instanceof InvalidForecastInputError) {
            throw apiError(400, {
              code: 'invalid_forecast_input',
              whatHappened: e.message,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Correct the window/horizon and re-send. Nothing was changed.',
            });
          }
          throw e;
        }
      },
    },
    {
      // D-4: propose expiry markdowns for near-expiry batches — from remaining shelf life (how deep) and
      // sell-through (whether at all). ADVISORY ONLY: a person commits the price change via the price-change
      // approval path (hard rule #5). `avgDailyDemand` is derived from the store's own sales when not given.
      api: 'API-04', method: 'POST', path: '/v1/pricing/markdown/propose',
      permission: 'price.change.propose', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as { items?: unknown; policy?: unknown };
        if (!Array.isArray(b.items)) {
          throw apiError(400, {
            code: 'not_readable_as_markdown_items',
            whatHappened: 'Markdown proposals need an items list, each with a productId and whole remainingShelfLifeDays, onHandMinor and currentPriceMinor (batchId and avgDailyDemand optional).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { "items": [ … ] }. Nothing was changed; this only reads.',
          });
        }
        const isInt = (v: unknown): v is number => Number.isInteger(v);
        const items: Array<{ productId: string; batchId?: string; remainingShelfLifeDays: number; onHandMinor: number; currentPriceMinor: number; avgDailyDemand?: number }> = [];
        for (const raw of b.items) {
          const r = raw as Record<string, unknown> | null;
          if (r === null || typeof r !== 'object' || Array.isArray(r)
            || typeof r['productId'] !== 'string' || r['productId'].trim() === ''
            || !isInt(r['remainingShelfLifeDays']) || !isInt(r['onHandMinor']) || !isInt(r['currentPriceMinor'])) {
            throw apiError(400, {
              code: 'not_readable_as_a_markdown_item',
              whatHappened: 'Each item needs a productId and whole numbers for remainingShelfLifeDays, onHandMinor and currentPriceMinor.',
              wasItSaved: 'not_saved',
              nextSafeAction: 'Fix the items and re-send. Nothing was changed.',
            });
          }
          items.push({
            productId: r['productId'] as string,
            remainingShelfLifeDays: r['remainingShelfLifeDays'] as number,
            onHandMinor: r['onHandMinor'] as number,
            currentPriceMinor: r['currentPriceMinor'] as number,
            ...(typeof r['batchId'] === 'string' && r['batchId'] !== '' ? { batchId: r['batchId'] as string } : {}),
            ...(isInt(r['avgDailyDemand']) ? { avgDailyDemand: r['avgDailyDemand'] as number } : {}),
          });
        }
        const policy = b.policy as MarkdownPolicy | undefined;

        // Fill a missing avgDailyDemand from the store's own sales (sell-through), the same trailing window
        // as replenishment; an item with no sales resolves to 0/day — its whole holding is surplus.
        let rate = new Map<string, number>();
        let demandWindow: { readonly from: string; readonly to: string; readonly days: number } | undefined;
        if (items.some((it) => it.avgDailyDemand === undefined)) {
          let windowDays = 28;
          const rawW = ctx.query['demandWindowDays'];
          if (rawW !== undefined) {
            const n = Number(rawW);
            if (!Number.isInteger(n) || n < 1) {
              throw apiError(400, {
                code: 'bad_demand_window',
                whatHappened: 'demandWindowDays must be a whole number of days, 1 or more.',
                wasItSaved: 'not_saved',
                nextSafeAction: 'Fix demandWindowDays (or omit it for the trailing 28 days) and re-send. Nothing was changed.',
              });
            }
            windowDays = n;
          }
          const to = deps.now().slice(0, 10);
          const from = addDays(to, -(windowDays - 1));
          const lines = await deps.soldLines(ctx.tenantId, `${from}T00:00:00.000Z`, `${addDays(to, 2)}T00:00:00.000Z`);
          rate = new Map(salesHistory({ lines, from, to }).products.map((p) => [p.productId, p.avgDailyDemandMinor]));
          demandWindow = { from, to, days: windowDays };
        }

        try {
          const proposals = items.map((it) => proposeMarkdown({
            productId: it.productId,
            ...(it.batchId === undefined ? {} : { batchId: it.batchId }),
            remainingShelfLifeDays: it.remainingShelfLifeDays,
            onHandMinor: it.onHandMinor,
            avgDailyDemandMinor: it.avgDailyDemand ?? rate.get(it.productId) ?? 0,
            currentPriceMinor: it.currentPriceMinor,
            ...(policy === undefined ? {} : { policy }),
          }));
          const markedDownCount = proposals.filter((p) => p.reason === 'marked_down').length;
          return {
            status: 200,
            body: { proposals, count: proposals.length, markedDownCount, ...(demandWindow === undefined ? {} : { demandWindow }), asAt: deps.now() },
          };
        } catch (e) {
          if (e instanceof InvalidMarkdownInputError) {
            throw apiError(400, {
              code: 'invalid_markdown_input',
              whatHappened: e.message,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Correct the item or policy and re-send. Nothing was changed.',
            });
          }
          throw e;
        }
      },
    },
    {
      // D-2: a forecast-driven, constraint-aware order proposal for one product. It forecasts demand (D-1)
      // from the store's own sales over the supplier's next delivery window and sizes an order to cover it —
      // rounded to whole cases / pallets, netting stock and open orders. Advisory only (hard rule #5).
      api: 'API-04', method: 'POST', path: '/v1/replenishment/order-proposal',
      permission: 'inventory.availability.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as {
          productId?: unknown; onHand?: unknown; onOrder?: unknown; upcomingDeliveries?: unknown;
          unitsPerCase?: unknown; casesPerPallet?: unknown; minOrderQty?: unknown; orderMultiple?: unknown;
        };
        const isInt = (v: unknown): v is number => Number.isInteger(v);
        if (typeof b.productId !== 'string' || b.productId.trim() === '' || !isInt(b.onHand)
          || !Array.isArray(b.upcomingDeliveries) || !b.upcomingDeliveries.every((d) => typeof d === 'string' && DAY.test(d))) {
          throw apiError(400, {
            code: 'not_readable_as_an_order_request',
            whatHappened: 'An order proposal needs a productId, a whole onHand, and upcomingDeliveries (a list of YYYY-MM-DD supplier delivery dates).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { "productId": …, "onHand": …, "upcomingDeliveries": [ … ] }. Nothing was changed; this only reads.',
          });
        }
        const productId = b.productId;
        const today = deps.now().slice(0, 10);
        const deliveries = ([...b.upcomingDeliveries] as string[]).filter((d) => d >= today).sort();

        // Forecast demand (D-1) from the store's own sales over the horizon up to the delivery-after-next.
        // With fewer than two future deliveries the engine returns no_supplier_calendar and no forecast is needed.
        let forecast: ForecastPoint[] = [];
        if (deliveries.length >= 2) {
          const coverUntil = deliveries[1]!;
          const horizonDays = Math.round((Date.parse(`${coverUntil}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / 86_400_000);
          if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 400) {
            throw apiError(400, {
              code: 'deliveries_out_of_range',
              whatHappened: 'The upcoming deliveries must be in the future and within about a year — the second date sets the forecast horizon.',
              wasItSaved: 'not_saved',
              nextSafeAction: 'Send upcoming delivery dates after today and re-send. Nothing was changed.',
            });
          }
          const from = addDays(today, -55);
          const lines = (await deps.soldLines(ctx.tenantId, `${from}T00:00:00.000Z`, `${addDays(today, 2)}T00:00:00.000Z`))
            .filter((l) => l.productId === productId);
          const byDay = salesHistory({ lines, from, to: today }).products.find((p) => p.productId === productId)?.byDay ?? [];
          const history = byDay.map((d) => ({ day: d.day, qty: d.qtyMinor }));
          forecast = forecastDemand({ history, from, to: today, horizonDays }).horizon.map((d) => ({ day: d.day, qty: d.forecastQty }));
        }

        try {
          const proposal = proposeConstrainedOrder({
            productId,
            onHand: b.onHand as number,
            ...(isInt(b.onOrder) ? { onOrder: b.onOrder as number } : {}),
            forecast,
            upcomingDeliveries: deliveries,
            asOf: today,
            ...(isInt(b.unitsPerCase) ? { unitsPerCase: b.unitsPerCase as number } : {}),
            ...(isInt(b.casesPerPallet) ? { casesPerPallet: b.casesPerPallet as number } : {}),
            ...(isInt(b.minOrderQty) ? { minOrderQty: b.minOrderQty as number } : {}),
            ...(isInt(b.orderMultiple) ? { orderMultiple: b.orderMultiple as number } : {}),
          });
          return { status: 200, body: { ...proposal, asAt: deps.now() } };
        } catch (e) {
          if (e instanceof InvalidConstrainedOrderError) {
            throw apiError(400, {
              code: 'invalid_order_request',
              whatHappened: e.message,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Correct the request and re-send. Nothing was changed.',
            });
          }
          throw e;
        }
      },
    },
  ];
}
