// API-04 store clusters and season plans (D02-FR-02 "seasonal assortment and store clustering" · OB-288 P2).
//
// OB-318 (owner, 23 Oct 2026, in writing): the cluster IS the price-zone register (`POST /v1/prices/zones/:zoneId/stores/
// :storeId`) — one register for a store's prices and its range. A cluster decision is written as the ordinary per-store
// range entry for every store in the cluster now, so the assortment every other check reads stays the one record.
//
//   GET  /v1/merchandising/clusters                               each cluster (zone) and its stores
//   POST /v1/merchandising/clusters/:zoneId/:productId/list       { effectiveFrom } — list in every store of the cluster
//   POST /v1/merchandising/clusters/:zoneId/:productId/drop       { reason, effectiveFrom, reasonNote?, replacedByProductId? }
//   POST /v1/merchandising/season-plans/:planId                   { zoneId | storeId, productIds[], listFrom, listTo, reason }
//   GET  /v1/merchandising/season-plans                           every plan and where it stands
//   POST /v1/merchandising/season-plans/sweep                     end every season whose last day has passed (also run by
//                                                                 the ops worker on every pass — automatic clearance)
//
// A drop reads the stock from head office's own position, never the request: stock still on the shelf goes to CLEARANCE
// (sellable until gone, never reordered), none is delisted (`dropFromRange`). A season ends once; its end is recorded with
// every decision it made. Append-only throughout (hard rule #2). `merchandising.range.manage` writes; `.read` reads.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  clusterStores, seasonEndDecisions, seasonEnded, dropFromRange, RangeDecisionError,
  type ClusterMembership, type SeasonPlan, type AssortmentEntry, type DropReason, type SeasonEndDecision,
} from '../../../packages/merchandising/src/index';

export interface SeasonEnd {
  readonly planId: string;
  readonly endedAt: string;
  readonly endedBy: string;
  readonly decisions: readonly { readonly storeId: string; readonly productId: string; readonly outcome: SeasonEndDecision['outcome'] }[];
}

export interface SeasonPlanDeps {
  readonly memberships: (tenantId: string) => Promise<readonly ClusterMembership[]>;
  readonly productKnown: (tenantId: string, productId: string) => Promise<boolean>;
  readonly storeOnHand: (tenantId: string, storeId: string, productId: string) => Promise<number>;
  readonly recordRangeEntry: (tenantId: string, storeId: string, entry: AssortmentEntry, key: string) => Promise<void>;
  readonly plans: (tenantId: string) => Promise<readonly SeasonPlan[]>;
  readonly recordPlan: (tenantId: string, plan: SeasonPlan) => Promise<void>;
  readonly ends: (tenantId: string) => Promise<readonly SeasonEnd[]>;
  readonly recordEnd: (tenantId: string, end: SeasonEnd) => Promise<void>;
  readonly now: () => string;
}

const DROP_REASONS: readonly DropReason[] = ['poor_sales', 'poor_margin', 'supplier_discontinued', 'quality_issue', 'range_rationalisation', 'seasonal_end', 'replaced_by_alternative'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDay = (v: unknown): v is string => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

const bad = (code: string, whatHappened: string, next = 'Correct it and send again. Nothing was saved.') =>
  apiError(400, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction: next });

async function storesOfCluster(deps: SeasonPlanDeps, tenantId: string, zoneId: string): Promise<readonly string[]> {
  const stores = clusterStores(await deps.memberships(tenantId), zoneId);
  if (stores.length === 0) {
    throw apiError(422, {
      code: 'cluster_has_no_stores',
      whatHappened: `No store is in cluster "${zoneId}" — a cluster is a price zone, and no store's zone is "${zoneId}" today.`,
      wasItSaved: 'not_saved',
      nextSafeAction: 'Put the stores in the zone first (POST /v1/prices/zones/:zoneId/stores/:storeId), then decide the range for it. Nothing was saved.',
    });
  }
  return stores;
}

/** End every season whose last day has passed and that has not ended yet. Returns how many ended. Idempotent. */
export async function endDueSeasons(deps: SeasonPlanDeps, tenantId: string, endedBy: string): Promise<readonly SeasonEnd[]> {
  const today = deps.now().slice(0, 10);
  const ended = new Set((await deps.ends(tenantId)).map((e) => e.planId));
  const out: SeasonEnd[] = [];
  for (const plan of await deps.plans(tenantId)) {
    if (ended.has(plan.planId) || !seasonEnded(plan, today)) continue;
    const onHand = new Map<string, number>();
    for (const s of plan.storeIds) for (const p of plan.productIds) onHand.set(`${s}\u001f${p}`, await deps.storeOnHand(tenantId, s, p));
    const decisions = seasonEndDecisions({ plan, onHand: (s, p) => onHand.get(`${s}\u001f${p}`) ?? 0, decidedBy: endedBy });
    for (const d of decisions) await deps.recordRangeEntry(tenantId, d.storeId, d.entry, `season-end-${plan.planId}-${d.storeId}-${d.productId}`);
    const end: SeasonEnd = { planId: plan.planId, endedAt: deps.now(), endedBy, decisions: decisions.map((d) => ({ storeId: d.storeId, productId: d.productId, outcome: d.outcome })) };
    await deps.recordEnd(tenantId, end);
    out.push(end);
  }
  return out;
}

export function seasonPlanRoutes(deps: SeasonPlanDeps): readonly Route[] {
  return [
    {
      api: 'API-04', method: 'GET', path: '/v1/merchandising/clusters',
      permission: 'merchandising.range.read',
      handler: async (ctx) => {
        const memberships = await deps.memberships(ctx.tenantId);
        const zones = [...new Set(memberships.map((m) => m.zoneId))].sort();
        const clusters = zones.map((zoneId) => ({ zoneId, stores: clusterStores(memberships, zoneId) })).filter((c) => c.stores.length > 0);
        return { status: 200, body: { clusters, count: clusters.length, register: 'price_zones', asAt: deps.now() } };
      },
    },
    {
      api: 'API-04', method: 'POST', path: '/v1/merchandising/clusters/:zoneId/:productId/list',
      permission: 'merchandising.range.manage', idempotent: true,
      handler: async (ctx) => {
        const zoneId = (ctx.params['zoneId'] ?? '').trim();
        const productId = (ctx.params['productId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (zoneId === '' || productId === '' || !isDay(b['effectiveFrom'])) throw bad('not_readable_as_a_listing', 'Listing for a cluster needs the zone and the product in the path and { effectiveFrom (YYYY-MM-DD) }.');
        if (!(await deps.productKnown(ctx.tenantId, productId))) throw apiError(404, { code: 'not_found', whatHappened: `No product ${productId} on the product master.`, wasItSaved: 'not_saved', nextSafeAction: 'Publish the product first. Nothing was saved.' });
        const stores = await storesOfCluster(deps, ctx.tenantId, zoneId);
        for (const storeId of stores) {
          const entry: AssortmentEntry = { storeId, productId, status: 'listed', effectiveFrom: b['effectiveFrom'], decidedBy: ctx.userId, reasonNote: `cluster ${zoneId}` };
          await deps.recordRangeEntry(ctx.tenantId, storeId, entry, `cluster-list-${zoneId}-${storeId}-${productId}-${entry.effectiveFrom}`);
        }
        return { status: 201, body: { zoneId, productId, status: 'listed', effectiveFrom: b['effectiveFrom'], stores } };
      },
    },
    {
      api: 'API-04', method: 'POST', path: '/v1/merchandising/clusters/:zoneId/:productId/drop',
      permission: 'merchandising.range.manage', idempotent: true,
      handler: async (ctx) => {
        const zoneId = (ctx.params['zoneId'] ?? '').trim();
        const productId = (ctx.params['productId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (b['onHandMinor'] !== undefined) throw bad('drop_carries_caller_stock', 'A drop never carries how much is on hand — head office reads it from the stock position, store by store.');
        if (zoneId === '' || productId === '' || !DROP_REASONS.includes(b['reason'] as DropReason) || !isDay(b['effectiveFrom'])
          || (b['reasonNote'] !== undefined && typeof b['reasonNote'] !== 'string') || (b['replacedByProductId'] !== undefined && !isStr(b['replacedByProductId']))) {
          throw bad('not_readable_as_a_drop', `A cluster drop needs { reason (${DROP_REASONS.join('/')}), effectiveFrom, reasonNote?, replacedByProductId? }.`);
        }
        const stores = await storesOfCluster(deps, ctx.tenantId, zoneId);
        const decisions: { storeId: string; outcome: string; onHandMinor: number }[] = [];
        const entries: AssortmentEntry[] = [];
        for (const storeId of stores) {
          const onHandMinor = await deps.storeOnHand(ctx.tenantId, storeId, productId);
          try {
            const d = dropFromRange({
              storeId, productId, onHandMinor: Math.max(0, onHandMinor), reason: b['reason'] as DropReason, decidedBy: ctx.userId, effectiveFrom: b['effectiveFrom'],
              reasonNote: `cluster ${zoneId}${isStr(b['reasonNote']) ? `: ${b['reasonNote']}` : ''}`,
              ...(isStr(b['replacedByProductId']) ? { replacedByProductId: b['replacedByProductId'] } : {}),
            });
            entries.push(d.entry);
            decisions.push({ storeId, outcome: d.outcome, onHandMinor });
          } catch (e) {
            if (e instanceof RangeDecisionError) throw apiError(422, { code: 'range_decision_refused', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the decision. Nothing was saved in any store.' });
            throw e;
          }
        }
        // Judged for every store first, then written — a refusal saves nothing anywhere.
        // The word "drop" below is a range decision inside an idempotency key; no SQL is built here (same finding as assortment.ts).
        // nosemgrep: javascript.express.security.injection.tainted-sql-string
        for (const entry of entries) await deps.recordRangeEntry(ctx.tenantId, entry.storeId, entry, `cluster-drop-${zoneId}-${entry.storeId}-${productId}-${entry.effectiveFrom}`);
        return { status: 201, body: { zoneId, productId, decisions } };
      },
    },
    {
      // STATIC path before `/:planId`, so "sweep" is never read as a plan id.
      api: 'API-04', method: 'POST', path: '/v1/merchandising/season-plans/sweep',
      permission: 'merchandising.range.manage', idempotent: true,
      handler: async (ctx) => {
        const ended = await endDueSeasons(deps, ctx.tenantId, ctx.userId);
        return { status: 200, body: { ended, count: ended.length, asAt: deps.now() } };
      },
    },
    {
      api: 'API-04', method: 'POST', path: '/v1/merchandising/season-plans/:planId',
      permission: 'merchandising.range.manage', idempotent: true,
      handler: async (ctx) => {
        const planId = (ctx.params['planId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const productIds = Array.isArray(b['productIds']) && b['productIds'].every(isStr) ? [...new Set((b['productIds'] as string[]).map((p) => p.trim()))] : undefined;
        const oneScope = isStr(b['zoneId']) !== isStr(b['storeId']);
        if (planId === '' || !oneScope || productIds === undefined || productIds.length === 0 || !isDay(b['listFrom']) || !isDay(b['listTo']) || !isStr(b['reason'])) {
          throw bad('not_readable_as_a_season_plan', 'A season plan needs { zoneId (a cluster) OR storeId (one store), productIds[], listFrom, listTo (YYYY-MM-DD, the first and last day of the season), reason }.');
        }
        if (b['listTo'] < b['listFrom']) throw bad('season_ends_before_it_starts', `The season ends (${b['listTo']}) before it starts (${b['listFrom']}).`);
        if ((await deps.plans(ctx.tenantId)).some((p) => p.planId === planId)) {
          throw apiError(409, { code: 'season_plan_already_made', whatHappened: `Season plan ${planId} already exists — a plan is made once; end it and make another for a change.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new plan id. Nothing was changed.' });
        }
        for (const p of productIds) if (!(await deps.productKnown(ctx.tenantId, p))) throw apiError(404, { code: 'not_found', whatHappened: `No product ${p} on the product master.`, wasItSaved: 'not_saved', nextSafeAction: 'Publish the product first. Nothing was saved.' });
        const storeIds = isStr(b['zoneId']) ? await storesOfCluster(deps, ctx.tenantId, b['zoneId'].trim()) : [(b['storeId'] as string).trim()];
        const plan: SeasonPlan = {
          planId, ...(isStr(b['zoneId']) ? { zoneId: b['zoneId'].trim() } : { storeId: (b['storeId'] as string).trim() }), storeIds, productIds,
          listFrom: b['listFrom'], listTo: b['listTo'], reason: (b['reason'] as string).trim(), setBy: ctx.userId, setAt: deps.now(),
        };
        // The listing is written ahead, dated from the season's first day; the plan's end writes the drops.
        for (const storeId of storeIds) for (const productId of productIds) {
          await deps.recordRangeEntry(ctx.tenantId, storeId, { storeId, productId, status: 'listed', effectiveFrom: plan.listFrom, decidedBy: ctx.userId, reasonNote: `season plan ${planId}` }, `season-list-${planId}-${storeId}-${productId}`);
        }
        await deps.recordPlan(ctx.tenantId, plan);
        return { status: 201, body: { plan } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/merchandising/season-plans',
      permission: 'merchandising.range.read',
      handler: async (ctx) => {
        const today = deps.now().slice(0, 10);
        const ends = new Map((await deps.ends(ctx.tenantId)).map((e) => [e.planId, e] as const));
        const plans = (await deps.plans(ctx.tenantId)).map((p) => {
          const end = ends.get(p.planId);
          const standing = end !== undefined ? 'ended' : seasonEnded(p, today) ? 'due_to_end' : today < p.listFrom ? 'upcoming' : 'in_season';
          return { ...p, standing, ...(end === undefined ? {} : { end }) };
        });
        return { status: 200, body: { plans, count: plans.length, dueToEnd: plans.filter((p) => p.standing === 'due_to_end').length, asAt: deps.now() } };
      },
    },
  ];
}
