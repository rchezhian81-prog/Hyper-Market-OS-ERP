// API-04 STORED replenishment parameters (M09-FR-02 "min/max, safety stock, reorder point and demand-based replenishment";
// M09.md "parameters per product/store … parameter changes logged … parameters drive the numbers" · WF-03 · P-05 · hard
// rules #2 #5 · Round 4b).
//
// Until now the planning parameters were typed into every proposal request; nothing kept them per product and store, and
// nothing logged a change. Here:
//
//   • SET (`POST /v1/replenishment/parameters/:storeId/:productId`) — { maxLevel, reorderPoint?, safetyStock?, leadTimeDays?,
//     minOrderQty?, orderMultiple?, avgDailyDemand?, reason }, every quantity in the product's smallest step (grams for a kg
//     product, items otherwise). A new figure is a new VERSION (append-only — the earlier one is kept and shown); an audit
//     line carries before and after and the reason. Set by the buyer (`purchase.order.propose`, the person who raises the
//     requisition from the proposal), inside their branches.
//   • READ (`GET /v1/replenishment/parameters?storeId=`) — the parameters in force per product, each with its version history.
//   • PROPOSE ON THEM (`POST /v1/replenishment/stored-proposal?storeId=`) — head office's own proposal (the SAME engine and
//     route as `/v1/replenishment/propose`, on head office's stock, orders, sales, range and lifecycle) worked out on the
//     STORED parameters, never typed ones; the parameters used come back beside it, so a requisition raised from it
//     (`…/from-replenishment`) is worked out again on exactly them. Advisory only: it never orders anything (hard rule #5).

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError, scopeOf } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { assertLocationInScope, type LocationBranches } from './location-scope';

export const PARAMETER_FIELDS = Object.freeze(['maxLevel', 'reorderPoint', 'safetyStock', 'leadTimeDays', 'minOrderQty', 'orderMultiple', 'avgDailyDemand'] as const);
export type ParameterField = (typeof PARAMETER_FIELDS)[number];

/** One version of a product's planning parameters at a store. */
export interface StoredParameters {
  readonly storeId: string;
  readonly productId: string;
  readonly version: number;
  readonly maxLevel: number;
  readonly reorderPoint?: number;
  readonly safetyStock?: number;
  readonly leadTimeDays?: number;
  readonly minOrderQty?: number;
  readonly orderMultiple?: number;
  readonly avgDailyDemand?: number;
  readonly reason: string;
  readonly setBy: string;
  readonly setAt: string;
}

export interface ReplenishmentParameterDeps {
  /** Every version recorded, in record order. */
  readonly versions: (tenantId: string) => Promise<readonly StoredParameters[]> | readonly StoredParameters[];
  /** Append one version (idempotent on store + product + version). */
  readonly recordVersion: (tenantId: string, v: StoredParameters) => Promise<void> | void;
  /** Head office's own proposal for the store on these parameters — the `/v1/replenishment/propose` route itself. */
  readonly propose: (ctx: RequestContext, storeId: string, items: readonly Record<string, unknown>[]) => Promise<{ readonly status: number; readonly body: unknown }>;
  readonly locationBranches?: LocationBranches;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isWhole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const ID = /^[A-Za-z0-9_.:-]{1,80}$/;

/** The parameters in force per product at a store (the latest version of each), with every version kept. */
export function parametersAt(all: readonly StoredParameters[], storeId: string): readonly { readonly current: StoredParameters; readonly history: readonly StoredParameters[] }[] {
  const by = new Map<string, StoredParameters[]>();
  for (const v of all) if (v.storeId === storeId) by.set(v.productId, [...(by.get(v.productId) ?? []), v]);
  return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([, vs]) => {
    const history = [...vs].sort((a, b) => a.version - b.version);
    return { current: history[history.length - 1]!, history };
  });
}

/** The planning parameters only (what the proposal engine reads) — never stock, never who set them. */
export const asItem = (p: StoredParameters): Record<string, unknown> => {
  const item: Record<string, unknown> = { productId: p.productId };
  for (const f of PARAMETER_FIELDS) if (p[f] !== undefined) item[f] = p[f];
  return item;
};

function storeOf(ctx: RequestContext): string {
  const asked = ctx.query['storeId'];
  const held = scopeOf(ctx);
  const storeId = isStr(asked) ? asked.trim() : (held !== 'all' && held.length === 1 ? held[0]! : undefined);
  if (storeId === undefined) {
    throw apiError(400, { code: 'store_required', whatHappened: 'Replenishment parameters are kept per store — say which: ?storeId=.', wasItSaved: 'not_saved', nextSafeAction: 'Send the store id (one your role covers). Nothing was changed.' });
  }
  return storeId;
}

export function replenishmentParameterRoutes(deps: ReplenishmentParameterDeps): readonly Route[] {
  return [
    {
      api: 'API-04', method: 'POST', path: '/v1/replenishment/parameters/:storeId/:productId',
      permission: 'purchase.order.propose', idempotent: true,
      handler: async (ctx) => {
        const storeId = (ctx.params['storeId'] ?? '').trim();
        const productId = (ctx.params['productId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const typedStock = ['onHand', 'onOrder', 'reserved'].filter((k) => b[k] !== undefined);
        if (typedStock.length > 0) {
          throw apiError(400, {
            code: 'parameters_carry_stock', whatHappened: `These parameters say their own ${typedStock.join(', ')}. Stock is head office's to say, from the stock ledger and the open orders — never a stored parameter.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Send only the planning parameters and a reason. Nothing was saved.',
          });
        }
        const bad = PARAMETER_FIELDS.filter((f) => b[f] !== undefined && !isWhole(b[f]));
        if (!ID.test(storeId) || !ID.test(productId) || !isWhole(b['maxLevel']) || bad.length > 0 || !isStr(b['reason'])) {
          throw apiError(400, {
            code: 'not_readable_as_replenishment_parameters',
            whatHappened: `Replenishment parameters need a store and a product in the path and { maxLevel, reorderPoint?, safetyStock?, leadTimeDays?, minOrderQty?, orderMultiple?, avgDailyDemand?, reason } — each a whole number, not negative, in the product's smallest step (grams for a kg product).${bad.length > 0 ? ` Not whole: ${bad.join(', ')}.` : ''}`,
            wasItSaved: 'not_saved', nextSafeAction: 'Send the parameters with a reason. Nothing was saved.',
          });
        }
        if (b['reorderPoint'] !== undefined && (b['reorderPoint'] as number) > (b['maxLevel'] as number)) {
          throw apiError(422, { code: 'reorder_point_above_max', whatHappened: `The reorder point (${String(b['reorderPoint'])}) is above the most to hold (${String(b['maxLevel'])}) — every order would be due at once and none could reach it.`, wasItSaved: 'not_saved', nextSafeAction: 'Set the reorder point at or below the most to hold. Nothing was saved.' });
        }
        if (b['orderMultiple'] === 0 || b['leadTimeDays'] !== undefined && (b['leadTimeDays'] as number) > 365) {
          throw apiError(422, { code: 'parameter_out_of_range', whatHappened: 'An order multiple is at least 1, and a lead time at most 365 days.', wasItSaved: 'not_saved', nextSafeAction: 'Correct it. Nothing was saved.' });
        }
        await assertLocationInScope(ctx, storeId, deps.locationBranches);
        const before = parametersAt(await deps.versions(ctx.tenantId), storeId).find((x) => x.current.productId === productId)?.current;
        const v: StoredParameters = {
          storeId, productId, version: (before?.version ?? 0) + 1, maxLevel: b['maxLevel'] as number,
          ...Object.fromEntries(PARAMETER_FIELDS.filter((f) => f !== 'maxLevel' && b[f] !== undefined).map((f) => [f, b[f] as number])),
          reason: (b['reason'] as string).trim().slice(0, 300), setBy: ctx.userId, setAt: deps.now(),
        };
        if (before !== undefined && PARAMETER_FIELDS.every((f) => before[f] === v[f])) {
          return { status: 200, body: { parameters: before, unchanged: true } };
        }
        await deps.recordVersion(ctx.tenantId, v);
        const words = (p: StoredParameters | undefined): Record<string, string> | null => (p === undefined ? null : Object.fromEntries(PARAMETER_FIELDS.filter((f) => p[f] !== undefined).map((f) => [f, String(p[f])])));
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'replenishment.parameters.set', objectType: 'replenishment_parameters', objectId: `${storeId}|${productId}`, at: v.setAt,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: words(before), after: { ...words(v)!, version: String(v.version) },
          reason: v.reason, correlationId: `${storeId}|${productId}`,
        });
        return { status: 201, body: { parameters: v, supersedes: before ?? null, unchanged: false } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/replenishment/parameters',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const storeId = storeOf(ctx);
        await assertLocationInScope(ctx, storeId, deps.locationBranches);
        const products = parametersAt(await deps.versions(ctx.tenantId), storeId);
        return { status: 200, body: { storeId, products, count: products.length, asAt: deps.now() } };
      },
    },
    {
      api: 'API-04', method: 'POST', path: '/v1/replenishment/stored-proposal',
      permission: 'inventory.availability.read', idempotent: true,
      handler: async (ctx) => {
        const storeId = storeOf(ctx);
        await assertLocationInScope(ctx, storeId, deps.locationBranches);
        const products = parametersAt(await deps.versions(ctx.tenantId), storeId);
        if (products.length === 0) {
          return { status: 200, body: { storeId, proposals: [], count: 0, items: [], parametersNotSet: true, detail: 'No replenishment parameters are stored for this store yet, so nothing can be proposed — set the most to hold and the reorder point per product first.', asAt: deps.now() } };
        }
        const items = products.map((p) => asItem(p.current));
        const res = await deps.propose(ctx, storeId, items);
        if (res.status >= 300) return res;
        return { status: 200, body: { ...(res.body as Record<string, unknown>), items, versions: products.map((p) => ({ productId: p.current.productId, version: p.current.version })), parametersNotSet: false } };
      },
    },
  ];
}
