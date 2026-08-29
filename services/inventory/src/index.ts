// API-04 Inventory — movements, availability, batches, adjustments, counts.
//
// **Movements are appended; balances are projected** (hard rule #2, M08). Nothing here updates a
// quantity, and there is no endpoint that could: a correction is a compensating movement with its
// own reason and its own approver, so the ledger reads as what happened rather than as what
// somebody last decided it should look like.
//
// Two consequences that shape the surface:
//
//   • **Arrival order does not matter.** A handheld back from the chiller and a lane back from
//     three days offline both send movements out of order. Because the balance is a projection of
//     an append-only set, the same movements in any order give the same figure — asserted, not
//     assumed.
//
//   • **Negative available stock is reported, not blocked.** A shelf that has gone negative is a
//     shelf that was already wrong before this service heard about it, and refusing the movement
//     would leave the ledger disagreeing with the aisle while the aisle wins. It becomes a visible
//     exception (P-08, hard rule #10).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { ProductValuation } from '../../../packages/stock/src/valuation';
import type { AgeingSource } from '../../../packages/stock/src/ageing-source';
import { stockAgeing, inventoryTurns, gmroi, stockoutImpact, type Ratio, type StockoutInput } from '../../../packages/stock/src/metrics';
import { isCurrencyCode, type Money, type CurrencyCode } from '../../../packages/contracts/src/money';

// --- small readers for the one stateless "what-if" on this surface --------------
// Every other route here reads the append-only ledger; the stockout estimate is the
// exception — a sale that never happened leaves no movement to fold — so its figures
// arrive in the request body and must be validated before they reach the engine.
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonNegNum = (v: unknown): v is number => isFiniteNum(v) && v >= 0;
const isMoney = (v: unknown): v is Money =>
  isObj(v) && Number.isInteger(v['minor']) && isStr(v['currency']);
const isStockoutRow = (v: unknown, currency: string): v is StockoutInput =>
  isObj(v) &&
  isStr(v['productId']) &&
  isNonNegNum(v['daysOutOfStock']) &&
  isFiniteNum(v['periodDays']) &&
  (v['periodDays'] as number) > 0 &&
  (v['daysOutOfStock'] as number) <= (v['periodDays'] as number) &&
  isNonNegNum(v['averageDailyUnits']) &&
  isMoney(v['marginPerUnit']) &&
  // one reporting currency only — summing minor units across currencies would be a lie (P-08)
  (v['marginPerUnit'] as Money).currency === currency;

export type MovementKind =
  | 'received' | 'sold' | 'returned' | 'transferred_in' | 'transferred_out'
  | 'adjusted' | 'wasted' | 'counted';

/** What each kind does to on-hand. Declared, never inferred from a sign on the quantity. */
export const EFFECT_ON_HAND: Readonly<Record<MovementKind, 1 | -1>> = {
  received: 1, returned: 1, transferred_in: 1, counted: 1, adjusted: 1,
  sold: -1, transferred_out: -1, wasted: -1,
};

export interface Movement {
  readonly movementId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly kind: MovementKind;
  /** Always positive; `kind` carries the direction. */
  readonly quantityMinor: number;
  readonly uom: string;
  readonly occurredAt: string;
  readonly batchId?: string;
  /** Required for `adjusted` and `wasted` — a quantity change with no reason is untraceable. */
  readonly reason?: string;
  readonly approvedBy?: string;
  readonly enteredBy: string;
  /**
   * Unit cost in minor units, for a `received` movement — the price this receipt re-averages the
   * stock value at (M08-FR-04, weighted-average policy). Optional: a receipt with no cost is on-hand
   * but reported as unvalued rather than folded in at zero (P-08). Ignored for non-receipts.
   */
  readonly unitCostMinor?: number;
}

export interface Availability {
  readonly productId: string;
  readonly locationId: string;
  readonly onHandMinor: number;
  readonly movements: number;
  /** Projected from the ledger at this instant, and stamped so staleness is visible (P-08). */
  readonly asAt: string;
}

/**
 * Project on-hand from an append-only movement set. Order-independent by construction.
 *
 * `opening` is a balance already projected from the movements **before** this set — a snapshot.
 * Folding from the beginning of time is correct and unbounded: a hypermarket generates a few
 * thousand movements a day, so a year is well over a million, and every availability lookup was
 * replaying all of them. A snapshot is not a second source of truth, because it is derived from
 * the ledger and can be thrown away and rebuilt; what it is not allowed to be is *editable*, which
 * is why it is itself an event.
 */
export function project(
  movements: readonly Movement[], asAt: string, opening: readonly Availability[] = [],
): readonly Availability[] {
  const byKey = new Map<string, { productId: string; locationId: string; qty: number; n: number }>();
  for (const a of opening) {
    byKey.set(`${a.productId}\u001f${a.locationId}`, {
      productId: a.productId, locationId: a.locationId, qty: a.onHandMinor, n: a.movements,
    });
  }
  for (const m of movements) {
    const key = `${m.productId}\u001f${m.locationId}`;
    const acc = byKey.get(key) ?? { productId: m.productId, locationId: m.locationId, qty: 0, n: 0 };
    acc.qty += m.quantityMinor * EFFECT_ON_HAND[m.kind];
    acc.n += 1;
    byKey.set(key, acc);
  }
  return [...byKey.values()]
    .sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : a.locationId < b.locationId ? -1 : 1))
    .map((a) => ({
      productId: a.productId, locationId: a.locationId,
      onHandMinor: a.qty, movements: a.n, asAt,
    }));
}

export type MovementRefusal = 'adjustment_without_a_reason' | 'adjustment_not_approved' | 'quantity_not_positive';

export interface MovementCheck {
  readonly ok: boolean;
  readonly refusedBecause?: MovementRefusal;
  readonly detail: string;
}

/**
 * The only refusals: a quantity change nobody explained, and one nobody approved.
 *
 * Everything else that arrives is something that already happened in the building.
 */
export function checkMovement(m: Movement): MovementCheck {
  if (!Number.isInteger(m.quantityMinor) || m.quantityMinor <= 0) {
    return {
      ok: false, refusedBecause: 'quantity_not_positive',
      detail: 'a movement quantity is a magnitude and its kind carries the direction. A signed quantity here is how a receipt becomes an issue when somebody reads it back',
    };
  }
  if ((m.kind === 'adjusted' || m.kind === 'wasted')) {
    if (m.reason === undefined || m.reason.trim().length < 4) {
      return {
        ok: false, refusedBecause: 'adjustment_without_a_reason',
        detail: `a ${m.kind} movement with no reason is a quantity change nobody can account for later. Shrinkage, damage and a miscount need telling apart at the year end`,
      };
    }
    if (m.approvedBy === undefined || m.approvedBy === m.enteredBy) {
      return {
        ok: false, refusedBecause: 'adjustment_not_approved',
        detail: `${m.enteredBy} entered and approved this ${m.kind}. Writing stock off is the one movement that makes a difference disappear, so it takes two people (§28)`,
      };
    }
  }
  return { ok: true, detail: `${m.kind} ${m.quantityMinor} of ${m.productId} at ${m.locationId}` };
}

export interface NegativeStock {
  readonly productId: string;
  readonly locationId: string;
  readonly onHandMinor: number;
  readonly detail: string;
  readonly ownerAction: string;
}

/** Negative on-hand, reported rather than prevented. */
export const negativeStock = (rows: readonly Availability[]): readonly NegativeStock[] =>
  rows.filter((r) => r.onHandMinor < 0).map((r) => ({
    productId: r.productId, locationId: r.locationId, onHandMinor: r.onHandMinor,
    detail: `${r.productId} at ${r.locationId} projects to ${r.onHandMinor}`,
    ownerAction: 'The shelf cannot hold less than nothing, so something was sold that was never received or received against the wrong code. Count the line — do not adjust it to zero, which hides whichever of those it was.',
  }));

export interface InventoryDeps {
  readonly appendMovement: (tenantId: string, m: Movement) => Promise<void> | void;
  /**
   * Has this exact movement already been recorded?
   *
   * Was `known(tenantId) => Set<string>` — every movement id the shop has ever recorded, loaded so
   * that one `.has()` could be run against it. A handheld back from the chiller sending forty
   * movements paid that forty times.
   */
  readonly isKnown: (tenantId: string, movementId: string) => Promise<boolean> | boolean;
  /**
   * On-hand, already projected — snapshot plus whatever has happened since.
   *
   * This was `movements(tenantId, productId?) => Movement[]`, and the route folded them. That put
   * an **unbounded read** behind every availability lookup: a few thousand movements a day is well
   * over a million a year, all replayed to answer "how many bags of rice are there?". The domain
   * still owns *how* to project (`project` above); the adapter owns *from where*.
   */
  readonly availability: (tenantId: string, productId?: string) => Promise<readonly Availability[]> | readonly Availability[];
  /**
   * Stock valued at weighted-average cost (M08-FR-04) — projected from the same movement ledger as
   * on-hand, never a stored figure. Returns per product/location the value, the average unit cost,
   * cost of goods sold and any unvalued (uncosted) quantity.
   */
  readonly valuation: (tenantId: string, productId?: string) => Promise<readonly ProductValuation[]> | readonly ProductValuation[];
  /**
   * Current remaining stock as receipt-dated lots valued at weighted-average cost (M08-FR-04) —
   * the "from where" for the ageing report. Folded from the same movement ledger as on-hand and
   * valuation, so the three reconcile. The route buckets these by age; `unvaluedMinor` carries any
   * uncosted on-hand so it is stated, never priced at a guess (P-08).
   */
  readonly ageing: (tenantId: string, productId?: string) => Promise<AgeingSource> | AgeingSource;
  /**
   * The period inputs for stock productivity (M08-FR-04): cost of goods sold and average inventory
   * over `[from, to]`, both at weighted-average cost, plus net (ex-tax) sales and gross margin when
   * revenue can be stated. COGS and value come from the inventory ledger; net sales from the POS
   * ledger de-grossed by the catalogue's tax rate per product. `netSales`/`grossMargin` are ABSENT
   * (not zero) when a sold product has no known tax rate — the route then reports GMROI as not
   * meaningful rather than inventing a margin (P-08).
   */
  readonly performance: (tenantId: string, opts: { readonly from: string; readonly to: string }) => Promise<StockPerformanceInputs> | StockPerformanceInputs;
  readonly now: () => string;
}

/** One row of period inputs for turns/GMROI — for the whole store, or for one product. */
export interface StockPerformanceRow {
  /** Cost of goods sold during the period, at weighted-average cost. */
  readonly cogs: Money;
  /** Average stock value held over the period, at cost — the two-point (opening+closing)/2. */
  readonly averageInventory: Money;
  /** Net (ex-tax) sales in the period, AFTER deducting returns; absent when a tax rate is unknown. */
  readonly netSales?: Money;
  /** Net sales minus COGS (COGS itself net of resell returns); absent whenever `netSales` is. */
  readonly grossMargin?: Money;
  /** The ex-tax value of customer returns deducted from `netSales` in the period. */
  readonly returnsMinor?: Money;
}

/** Period inputs for turns/GMROI, computed cross-domain (inventory COGS + POS revenue). */
export interface StockPerformanceInputs {
  readonly from: string;
  readonly to: string;
  readonly periodDays: number;
  /** The whole store over the period. */
  readonly total: StockPerformanceRow;
  /** One row per product that held stock or sold in the period. Where the range decisions live. */
  readonly byProduct: readonly (StockPerformanceRow & { readonly productId: string })[];
}

export function inventoryRoutes(deps: InventoryDeps): readonly Route[] {
  return [
    {
      api: 'API-04', method: 'POST', path: '/v1/inventory/movements',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const m = ctx.body as Movement;
        if (m === null || typeof m !== 'object' || typeof m.movementId !== 'string') {
          throw apiError(400, {
            code: 'not_readable_as_a_movement',
            whatHappened: 'This payload could not be read as a stock movement.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Keep it queued on the device and raise it. A movement that cannot be sent still happened on the floor.',
          });
        }
        const check = checkMovement(m);
        if (!check.ok) {
          throw apiError(422, {
            code: check.refusedBecause!,
            whatHappened: check.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was appended. Add what is missing and send it again — the stock has not moved in the system either way.',
          });
        }
        if (!(await deps.isKnown(ctx.tenantId, m.movementId))) {
          await deps.appendMovement(ctx.tenantId, m);
        }
        return { status: 202, body: { movementId: m.movementId, appended: true } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/inventory/availability',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const productId = ctx.query['productId'];
        const rows = await deps.availability(ctx.tenantId, productId);
        return { status: 200, body: { rows, asAt: deps.now() } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/inventory/exceptions',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const rows = await deps.availability(ctx.tenantId);
        return { status: 200, body: { negative: negativeStock(rows), asAt: deps.now() } };
      },
    },
    {
      // Stock valued at weighted-average cost (M08-FR-04). Projected from the movement ledger, so it
      // is the same one truth as on-hand; `unvalued` surfaces any stock received without a cost.
      api: 'API-04', method: 'GET', path: '/v1/inventory/valuation',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const rows = await deps.valuation(ctx.tenantId, ctx.query['productId']);
        return {
          status: 200,
          body: {
            rows,
            totalValueMinor: rows.reduce((s, r) => s + r.value.minor, 0),
            method: 'weighted_average',
            asAt: deps.now(),
          },
        };
      },
    },
    {
      // Stock aged by how long the money has been asleep (M08-FR-04). The remaining stock is folded
      // from the movement ledger and valued at weighted-average cost, then bucketed by receipt age —
      // so the ageing total reconciles to the valuation's stock value. `unvalued` is uncosted on-hand,
      // stated separately rather than priced at a guess (P-08).
      api: 'API-04', method: 'GET', path: '/v1/inventory/ageing',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const { lots, unvaluedMinor } = await deps.ageing(ctx.tenantId, ctx.query['productId']);
        const asAt = deps.now();
        const report = stockAgeing(lots, asAt.slice(0, 10), 'INR');
        return {
          status: 200,
          body: { ...report, unvaluedMinor, method: 'weighted_average', asAt },
        };
      },
    },
    {
      // Stock productivity over a period (M08-FR-04): is the money tied up in stock working, or
      // sitting there dying? TURNS (COGS ÷ average inventory) and days-of-cover are pure inventory —
      // how many times the stock sold through. GMROI (gross margin ÷ average inventory) is the rupees
      // of margin earned per rupee of stock, and needs revenue, so it is stated NET of tax and is
      // reported as `not_meaningful` — never a guessed number — when a sold product's tax rate is
      // unknown or no stock was held. Period is `?from=&to=`; default is the trailing 365 days.
      api: 'API-04', method: 'GET', path: '/v1/inventory/performance',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const asAt = deps.now();
        const to = ctx.query['to'] ?? asAt;
        const from = ctx.query['from'] ?? new Date(Date.parse(to) - 365 * 86_400_000).toISOString();
        const inp = await deps.performance(ctx.tenantId, { from, to });
        // Turns/GMROI for one row (store or product), each ratio honest about when it is not meaningful.
        const figuresOf = (row: StockPerformanceRow): Record<string, unknown> => {
          const turns = inventoryTurns({ cogs: row.cogs, averageInventory: row.averageInventory, periodDays: inp.periodDays });
          const margin: Ratio = row.grossMargin !== undefined
            ? gmroi({ grossMargin: row.grossMargin, averageInventory: row.averageInventory })
            : { kind: 'not_meaningful', because: 'net sales could not be computed — a product sold in the period has no known tax rate in the catalogue, so revenue cannot be stated net of tax' };
          return {
            cogs: row.cogs,
            averageInventory: row.averageInventory,
            netSales: row.netSales ?? null,
            grossMargin: row.grossMargin ?? null,
            returns: row.returnsMinor ?? null,
            turns: turns.turns,
            annualisedTurns: turns.annualisedTurns,
            daysOfCover: turns.daysOfCover,
            gmroi: margin,
          };
        };
        return {
          status: 200,
          body: {
            period: { from: inp.from, to: inp.to, days: inp.periodDays },
            // Store-wide figures at the top level (unchanged), plus the per-product breakdown.
            ...figuresOf(inp.total),
            byProduct: inp.byProduct.map((p) => ({ productId: p.productId, ...figuresOf(p) })),
            method: 'weighted_average',
            revenueBasis: 'net_of_tax; net_of_returns (resell cost reversed)',
            asAt,
          },
        };
      },
    },
    {
      // What the empty shelf cost (M08-FR-04, STOCKOUTS). The fourth stock-health number, and the
      // only one that cannot be projected from the ledger: a sale that never happened leaves no
      // movement behind. So the caller supplies the figures it CAN know — how many days the shelf was
      // empty and the product's normal rate of sale — and this estimates the margin that never landed.
      // It is stated as an ESTIMATE and never mixed into actuals (P-08): the engine returns it in its
      // own field, labelled, so nobody mistakes a might-have-been for a receipt. A read-only "what-if"
      // (no ledger touched), so it takes the analysis in the body rather than reading a durable store.
      api: 'API-04', method: 'POST', path: '/v1/inventory/stockout-impact',
      permission: 'inventory.availability.read', idempotent: true,
      handler: async (ctx) => {
        const b = ctx.body;
        const rawCurrency = isObj(b) && b['currency'] !== undefined ? b['currency'] : 'INR';
        const currency: CurrencyCode | undefined =
          typeof rawCurrency === 'string' && isCurrencyCode(rawCurrency) ? rawCurrency : undefined;
        const products = isObj(b) ? b['products'] : undefined;
        if (currency === undefined || !Array.isArray(products) || products.length === 0 || !products.every((p) => isStockoutRow(p, currency))) {
          throw apiError(400, {
            code: 'not_readable_as_a_stockout_analysis',
            whatHappened:
              'This payload could not be read as a stockout analysis. Each product needs a productId, the days it was out of stock (no more than the period), the period length, its normal units per day, and a margin per unit in the reporting currency.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was computed and nothing was stored. Correct the figures and send it again — this only estimates, it changes no stock.',
          });
        }
        return { status: 200, body: { ...stockoutImpact(products, currency), asAt: deps.now() } };
      },
    },
  ];
}
