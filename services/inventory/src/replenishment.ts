// API-04 replenishment suggestions (M09-FR-02). Work out WHAT to reorder and HOW MUCH from per-product
// parameters (reorder point / safety / max, or demand × lead time). The output is a PROPOSAL a buyer
// approves — ADVISORY ONLY, it can never become a purchase order by itself (hard rule #5 / AI-NFR-12:
// automation may recommend a reorder, only an authorised human commits the PO). Parameters drive every
// number, a blocked/discontinued item is suppressed, and the maths is pure — the same on the edge or in
// the cloud. The rule is the pure `proposeReplenishmentBatch` engine in `packages/replenishment`; this
// surface is a stateless what-if over the supplied stock/parameter inputs (it reads, it never commits).
//
// M09 loop: when an item does not carry an `avgDailyDemand`, the route DERIVES one from the store's own
// banked sales over a trailing window (`?demandWindowDays=`, default 28) via the `salesHistory` read — so
// REAL demand drives the reorder point and the D-3 shelf-life cap. A supplied demand still wins, and with
// no sales source wired the route behaves exactly as the pure what-if it was.
//
// D-3 (perishables): when an item carries a `remainingShelfLifeDays` (with a demand rate), the order-up-to is
// bounded by what can sell before the batch expires — an over-order is prevented, and an item whose whole
// due order would over-stock comes back as a visible `held_shelf_life` exception (suggestedQty 0).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  proposeReplenishmentBatch, InvalidReplenishmentParameterError, type ReplenishmentInput,
} from '../../../packages/replenishment/src/replenishment';
import { salesHistory, type SoldLine } from '../../../packages/demand/src/sales-history';

export interface ReplenishmentRoutesDeps {
  readonly now: () => string;
  /**
   * Optional (M09 loop): the sold lines over [fromIso, toIso) used to DERIVE `avgDailyDemand` for any item
   * that did not supply one — the real demand from the store's own banked sales feeds both the reorder point
   * and the D-3 shelf-life cap. Absent (or an item that already carries `avgDailyDemand`) → the item is used
   * exactly as given, so a pure what-if and every existing caller are unchanged.
   */
  readonly soldLines?: (tenantId: string, fromIso: string, toIso: string) => Promise<readonly SoldLine[]> | readonly SoldLine[];
}

/** A whole-day shift on a YYYY-MM-DD date. */
const addDays = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => Number.isInteger(v);
const OPTIONAL_INTS = ['onOrder', 'reserved', 'maxLevel', 'safetyStock', 'reorderPoint', 'avgDailyDemand', 'leadTimeDays', 'minOrderQty', 'orderMultiple', 'remainingShelfLifeDays'] as const;

/** Read one item as a ReplenishmentInput, or null if malformed (a 400, not an engine refusal). */
function readItem(v: unknown): ReplenishmentInput | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (!isStr(r['productId']) || !isInt(r['onHand']) || !isInt(r['maxLevel'])) return null;
  for (const k of OPTIONAL_INTS) if (r[k] !== undefined && !isInt(r[k])) return null;
  if (r['blocked'] !== undefined && typeof r['blocked'] !== 'boolean') return null;
  return {
    productId: r['productId'] as string, onHand: r['onHand'] as number, maxLevel: r['maxLevel'] as number,
    ...(isInt(r['onOrder']) ? { onOrder: r['onOrder'] as number } : {}),
    ...(isInt(r['reserved']) ? { reserved: r['reserved'] as number } : {}),
    ...(isInt(r['safetyStock']) ? { safetyStock: r['safetyStock'] as number } : {}),
    ...(isInt(r['reorderPoint']) ? { reorderPoint: r['reorderPoint'] as number } : {}),
    ...(isInt(r['avgDailyDemand']) ? { avgDailyDemand: r['avgDailyDemand'] as number } : {}),
    ...(isInt(r['leadTimeDays']) ? { leadTimeDays: r['leadTimeDays'] as number } : {}),
    ...(isInt(r['minOrderQty']) ? { minOrderQty: r['minOrderQty'] as number } : {}),
    ...(isInt(r['orderMultiple']) ? { orderMultiple: r['orderMultiple'] as number } : {}),
    ...(isInt(r['remainingShelfLifeDays']) ? { remainingShelfLifeDays: r['remainingShelfLifeDays'] as number } : {}),
    ...(r['blocked'] === true ? { blocked: true } : {}),
  };
}

export function replenishmentRoutes(deps: ReplenishmentRoutesDeps): readonly Route[] {
  return [
    {
      // Propose reorders for the supplied items — advisory only; only those below their reorder point come
      // back, each brought up to its max level (rounded to the pack, raised to the supplier minimum).
      api: 'API-04', method: 'POST', path: '/v1/replenishment/propose',
      permission: 'inventory.availability.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as { items?: unknown };
        if (!Array.isArray(b.items)) {
          throw apiError(400, {
            code: 'not_readable_as_replenishment',
            whatHappened: 'Replenishment needs an items list, each with a productId, whole onHand and whole maxLevel (reorder/safety/demand/lead/moq/multiple optional).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { "items": [ … ] }. Nothing was changed; replenishment only reads.',
          });
        }
        const items: ReplenishmentInput[] = [];
        for (const raw of b.items) {
          const item = readItem(raw);
          if (item === null) {
            throw apiError(400, {
              code: 'not_readable_as_an_item',
              whatHappened: 'Each item needs a productId and whole numbers for the stock parameters.',
              wasItSaved: 'not_saved',
              nextSafeAction: 'Fix the items and re-send. Nothing was changed.',
            });
          }
          items.push(item);
        }

        // M09 loop: fill a missing avgDailyDemand from the store's own banked sales, so REAL demand drives
        // both the reorder point and the D-3 shelf-life cap. Opt-in by data — an item that already carries a
        // demand keeps it, and with no sales source wired nothing changes (every existing caller unchanged).
        let priced = items;
        let demandWindow: { readonly from: string; readonly to: string; readonly days: number } | undefined;
        if (deps.soldLines !== undefined && items.some((it) => it.avgDailyDemand === undefined)) {
          let windowDays = 28; // the trailing four weeks, matching the sales-history default
          const raw = ctx.query['demandWindowDays'];
          if (raw !== undefined) {
            const n = Number(raw);
            if (!Number.isInteger(n) || n < 1) {
              throw apiError(400, {
                code: 'bad_demand_window',
                whatHappened: 'demandWindowDays must be a whole number of days, 1 or more.',
                wasItSaved: 'not_saved',
                nextSafeAction: 'Fix demandWindowDays (or omit it for the trailing 28 days) and re-send. Nothing was changed; replenishment only reads.',
              });
            }
            windowDays = n;
          }
          const to = deps.now().slice(0, 10);
          const from = addDays(to, -(windowDays - 1));
          const lines = await deps.soldLines(ctx.tenantId, `${from}T00:00:00.000Z`, `${addDays(to, 2)}T00:00:00.000Z`);
          const rate = new Map(salesHistory({ lines, from, to }).products.map((p) => [p.productId, p.avgDailyDemandMinor]));
          priced = items.map((it) => (it.avgDailyDemand === undefined && rate.has(it.productId)
            ? { ...it, avgDailyDemand: rate.get(it.productId)! }
            : it));
          demandWindow = { from, to, days: windowDays };
        }

        try {
          const proposals = proposeReplenishmentBatch(priced);
          return { status: 200, body: { proposals, count: proposals.length, asAt: deps.now(), ...(demandWindow === undefined ? {} : { demandWindow }) } };
        } catch (e) {
          if (e instanceof InvalidReplenishmentParameterError) {
            throw apiError(400, { code: 'invalid_replenishment_parameter', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the parameter and re-send. Nothing was changed.' });
          }
          throw e;
        }
      },
    },
  ];
}
