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
  ];
}
