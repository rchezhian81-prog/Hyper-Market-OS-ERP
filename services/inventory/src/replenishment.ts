// API-04 replenishment suggestions (M09-FR-02). Work out WHAT to reorder and HOW MUCH from per-product
// parameters (reorder point / safety / max, or demand × lead time). The output is a PROPOSAL a buyer
// approves — ADVISORY ONLY, it can never become a purchase order by itself (hard rule #5 / AI-NFR-12:
// automation may recommend a reorder, only an authorised human commits the PO). Parameters drive every
// number, a blocked/discontinued item is suppressed, and the maths is pure — the same on the edge or in
// the cloud. The rule is the pure `proposeReplenishmentBatch` engine in `packages/replenishment`; this
// surface reads head office's stock facts for the store and the supplied planning parameters (it reads, it never commits).
//
// M09 loop: when an item does not carry an `avgDailyDemand`, the route DERIVES one from the store's own
// banked sales over a trailing window (`?demandWindowDays=`, default 28) via the `salesHistory` read — so
// REAL demand drives the reorder point and the D-3 shelf-life cap. A supplied demand still wins, and with
// no sales source wired the route behaves exactly as the pure what-if it was.
//
// D-3 (perishables): when an item carries a `remainingShelfLifeDays` (with a demand rate), the order-up-to is
// bounded by what can sell before the batch expires — an over-order is prevented, and an item whose whole
// due order would over-stock comes back as a visible `held_shelf_life` exception (suggestedQty 0).
//
// FUL-11 (round 6): a proposal is FOR A STORE, and runs on HEAD OFFICE'S facts for that store — never on figures typed
// into the request. The store is `?storeId=` (inside the caller's branches, PA-01) or, for a caller whose authority covers
// exactly one branch, that branch; otherwise the call is refused (`store_required`). On-hand is the stock ledger's figure
// at the store and every place under it; on-order is what issued purchase orders to the store still owe plus what is on
// the van to it; sold is the ledger's `sold` movements at those places over the demand window. An item that carries its
// own `onHand`, `onOrder` or `reserved` is refused by name (`replenishment_carries_caller_stock`, as a range drop's
// typed stock is), and the store's effective range ALWAYS decides what may be proposed. Round 7: what the store has PROMISED
// away — the online-order and B2B holds still standing at its places (FUL-02 / FUL-09) — is read from head office's records
// and taken off the position, as `reserved`; a caller's `reserved` stays refused.

import type { Route } from '../../kernel/src/index';
import { apiError, scopeOf } from '../../kernel/src/index';
import {
  proposeReplenishmentBatch, InvalidReplenishmentParameterError, type ReplenishmentInput,
} from '../../../packages/replenishment/src/replenishment';
import { salesHistory, type SoldLine } from '../../../packages/demand/src/sales-history';
import type { AssortmentEntry } from '../../../packages/merchandising/src/index';
import { rangeStatusOf } from './assortment';
import { assertLocationInScope, type LocationBranches } from './location-scope';

/** Head office's own stock facts for one store (the store and every place the org hierarchy puts under it). */
export interface StoreReplenishmentFacts {
  /** On-hand per product, from the stock ledger. */
  readonly onHand: Readonly<Record<string, number>>;
  /** Still owed per product by ISSUED purchase orders delivered to the store (ordered − received − cancelled). */
  readonly onOrder: Readonly<Record<string, number>>;
  /** On the van to the store per product (transfers dispatched, not yet received). */
  readonly inTransit: Readonly<Record<string, number>>;
  /**
   * FUL-11 round 7: promised away per product — the online-order and B2B holds (FUL-02 / FUL-09) still standing at the store's
   * places. Stock promised to a customer is not stock on the shelf for the next shopper, so it reduces the position.
   */
  readonly reserved?: Readonly<Record<string, number>>;
}

export interface ReplenishmentRoutesDeps {
  readonly now: () => string;
  /**
   * Optional (M09 loop): the lines the stock ledger recorded SOLD at the store's places over [fromIso, toIso), used to
   * DERIVE `avgDailyDemand` for any item that did not supply one — the store's own real demand feeds both the reorder
   * point and the D-3 shelf-life cap. An item that already carries `avgDailyDemand` (a planning parameter) keeps it.
   */
  readonly soldLines?: (tenantId: string, storeId: string, fromIso: string, toIso: string) => Promise<readonly SoldLine[]> | readonly SoldLine[];
  /** FUL-11: head office's on-hand / on-order / in-transit for the store. Absent → the route refuses (503), never guesses. */
  readonly storeFacts?: (tenantId: string, storeId: string) => Promise<StoreReplenishmentFacts> | StoreReplenishmentFacts;
  /** PA-01: which branch a location belongs to, so a store outside the caller's branches is refused by name. */
  readonly locationBranches?: LocationBranches;
  /**
   * FUL-11 (M04-FR-01): a store's recorded range. Always applied: an item the store may not REORDER on today's date (never
   * listed, delisted, or on clearance) is taken out of the proposal and listed under `outOfRange` — visible, never silent.
   */
  readonly rangeOf?: (tenantId: string, storeId: string) => Promise<readonly AssortmentEntry[]> | readonly AssortmentEntry[];
}

/** A whole-day shift on a YYYY-MM-DD date. */
const addDays = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => Number.isInteger(v);
const CALLER_STOCK = ['onHand', 'onOrder', 'reserved'] as const;
const OPTIONAL_INTS = ['maxLevel', 'safetyStock', 'reorderPoint', 'avgDailyDemand', 'leadTimeDays', 'minOrderQty', 'orderMultiple', 'remainingShelfLifeDays'] as const;

/** The planning parameters of one item (its stock is head office's to say), or null if malformed (a 400). */
type ItemParameters = Omit<ReplenishmentInput, 'onHand' | 'onOrder' | 'reserved'>;
function readItem(v: unknown): ItemParameters | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (!isStr(r['productId']) || !isInt(r['maxLevel'])) return null;
  for (const k of OPTIONAL_INTS) if (r[k] !== undefined && !isInt(r[k])) return null;
  if (r['blocked'] !== undefined && typeof r['blocked'] !== 'boolean') return null;
  return {
    productId: r['productId'] as string, maxLevel: r['maxLevel'] as number,
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
        // FUL-11 · PA-01: the proposal is for ONE store, inside the caller's branches — asked for, or the only one held.
        const asked = ctx.query['storeId'];
        const held = scopeOf(ctx);
        const storeId = isStr(asked) ? asked.trim() : (held !== 'all' && held.length === 1 ? held[0]! : undefined);
        if (storeId === undefined) {
          throw apiError(400, {
            code: 'store_required',
            whatHappened: 'A replenishment proposal is for one store, worked out on that store\'s own stock, orders and sales — say which: ?storeId=.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the store id (one your role covers). Nothing was changed; replenishment only reads.',
          });
        }
        await assertLocationInScope(ctx, storeId, deps.locationBranches);
        const b = (ctx.body ?? {}) as { items?: unknown };
        if (!Array.isArray(b.items)) {
          throw apiError(400, {
            code: 'not_readable_as_replenishment',
            whatHappened: 'Replenishment needs an items list, each with a productId and a whole maxLevel (reorder/safety/demand/lead/moq/multiple optional). The stock is read here.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { "items": [ … ] }. Nothing was changed; replenishment only reads.',
          });
        }
        const params: ItemParameters[] = [];
        for (const raw of b.items) {
          const typed = raw !== null && typeof raw === 'object' ? CALLER_STOCK.filter((k) => (raw as Record<string, unknown>)[k] !== undefined) : [];
          if (typed.length > 0) {
            throw apiError(400, {
              code: 'replenishment_carries_caller_stock',
              whatHappened: `An item says its own ${typed.join(', ')}. That is head office's to say, from the stock ledger, the open purchase orders and the transfers on the van — a typed figure could order stock the store already holds, or none when the shelf is empty.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Send only the planning parameters (maxLevel, reorderPoint, safetyStock, leadTimeDays, minOrderQty, orderMultiple, avgDailyDemand, remainingShelfLifeDays, blocked). Nothing was changed.',
            });
          }
          const item = readItem(raw);
          if (item === null) {
            throw apiError(400, {
              code: 'not_readable_as_an_item',
              whatHappened: 'Each item needs a productId and whole numbers for the planning parameters.',
              wasItSaved: 'not_saved',
              nextSafeAction: 'Fix the items and re-send. Nothing was changed.',
            });
          }
          params.push(item);
        }
        if (deps.storeFacts === undefined) {
          throw apiError(503, { code: 'stock_position_unavailable', whatHappened: 'The stock position is not wired here, so a proposal cannot be worked out on what the store holds.', wasItSaved: 'not_saved', nextSafeAction: 'Try again later. Nothing was changed.' });
        }
        const facts = await deps.storeFacts(ctx.tenantId, storeId);
        const items: ReplenishmentInput[] = params.map((p) => ({
          ...p,
          onHand: facts.onHand[p.productId] ?? 0,
          onOrder: (facts.onOrder[p.productId] ?? 0) + (facts.inTransit[p.productId] ?? 0),
          reserved: facts.reserved?.[p.productId] ?? 0,
        }));

        // M09 loop: fill a missing avgDailyDemand from what the store's own ledger recorded SELLING, so REAL demand drives
        // both the reorder point and the D-3 shelf-life cap. An item that already carries a demand parameter keeps it.
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
          const lines = await deps.soldLines(ctx.tenantId, storeId, `${from}T00:00:00.000Z`, `${addDays(to, 2)}T00:00:00.000Z`);
          const rate = new Map(salesHistory({ lines, from, to }).products.map((p) => [p.productId, p.avgDailyDemandMinor]));
          priced = items.map((it) => (it.avgDailyDemand === undefined && rate.has(it.productId)
            ? { ...it, avgDailyDemand: rate.get(it.productId)! }
            : it));
          demandWindow = { from, to, days: windowDays };
        }

        // FUL-11: the store's effective range ALWAYS decides what may be proposed for it at all.
        const outOfRange: { productId: string; status: string }[] = [];
        const entries = deps.rangeOf === undefined ? [] : await deps.rangeOf(ctx.tenantId, storeId);
        const today = deps.now().slice(0, 10);
        // The one range rule (`rangeStatusOf`, as the purchase order asks it): only a listed item is reordered; a store with
        // no range recorded yet is not judged (as at the order).
        priced = priced.filter((it) => {
          const status = rangeStatusOf(entries, storeId, it.productId, today);
          if (status === 'listed' || status === 'no_range') return true;
          outOfRange.push({ productId: it.productId, status });
          return false;
        });
        const stockFacts = items.map((it) => ({
          productId: it.productId, onHand: facts.onHand[it.productId] ?? 0, onOrder: facts.onOrder[it.productId] ?? 0, inTransit: facts.inTransit[it.productId] ?? 0,
          reserved: facts.reserved?.[it.productId] ?? 0,
        }));
        try {
          const proposals = proposeReplenishmentBatch(priced);
          return {
            status: 200,
            body: {
              proposals, count: proposals.length, asAt: deps.now(), ...(demandWindow === undefined ? {} : { demandWindow }),
              storeId, outOfRange, stockFacts, factsFrom: 'head_office_stock_ledger',
            },
          };
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
