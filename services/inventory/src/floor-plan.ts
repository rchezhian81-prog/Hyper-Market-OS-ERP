// API-04 the store's floor plan and its heat map (M04-FR-04 "heat-map readiness and sales per square foot" · D02-FR-05 ·
// OB-308, owner, 23 Oct 2026, in writing: the full floor-plan heat-map screen — coordinates per area, coloured by sales or
// margin per square foot, in English and Tamil).
//
//   POST /v1/merchandising/stores/:storeId/floor-plan   { widthFt, depthFt, areas: [{ areaId, name, nameTa?, x, y, width, depth,
//                                                         squareFeet?, locationIds[] }] } — a new version (planogram.publish)
//   GET  /v1/merchandising/stores/:storeId/floor-plan   the version in force (merchandising.space.read)
//   GET  /v1/merchandising/stores/:storeId/heat-map?from=YYYY-MM-DD&to=YYYY-MM-DD&measure=sales|margin
//
// The plan's shelf locations must be on the store's PUBLISHED shelf map (the same register the planograms are validated
// against), each in exactly one area, the areas on the floor and not overlapping (`readFloorPlan`). The heat map folds head
// office's own records — the banked sales at the store in the window (what each product took, ex-tax for margin), each
// product's average buying cost at the store, and its primary shelf place on the planograms in force — through the tested
// `floorHeatMap`. Nothing typed by the reader is a figure. A product with no cost makes its area's margin "not known"; a
// product sold with no primary shelf place is listed as "not on the floor plan" — never a fabricated zero (P-08).

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { firstUnknownStore, unknownStoreWords } from '../../platform/src/store-computer-identity';
import { readFloorPlan, floorHeatMap, type FloorPlan, type ProductTakings, type HeatMeasure } from '../../../packages/merchandising/src/index';

export interface FloorPlanDeps {
  readonly registeredStores?: (tenantId: string) => Promise<ReadonlySet<string>>;
  /** The store's published shelf map's locations; undefined when none was published. */
  readonly shelfLocations: (tenantId: string, storeId: string) => Promise<ReadonlySet<string> | undefined>;
  readonly plans: (tenantId: string, storeId: string) => Promise<readonly FloorPlan[]>;
  readonly recordPlan: (tenantId: string, plan: FloorPlan) => Promise<void>;
  /** Product → its PRIMARY shelf location on the store's planograms in force. */
  readonly primaryPlacements: (tenantId: string, storeId: string) => Promise<ReadonlyMap<string, string>>;
  /** What each product took at the store in [fromIso, toIso): sales as charged, net of tax, and its cost (undefined: not known). */
  readonly takings: (tenantId: string, storeId: string, fromIso: string, toIso: string) => Promise<readonly ProductTakings[]>;
  readonly now: () => string;
}

const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const latestOf = (plans: readonly FloorPlan[]): FloorPlan | undefined => [...plans].sort((a, b) => a.version - b.version).at(-1);

export function floorPlanRoutes(deps: FloorPlanDeps): readonly Route[] {
  return [
    {
      api: 'API-04', method: 'POST', path: '/v1/merchandising/stores/:storeId/floor-plan',
      permission: 'planogram.publish', idempotent: true,
      handler: async (ctx) => {
        const storeId = (ctx.params['storeId'] ?? '').trim();
        if (deps.registeredStores !== undefined) {
          const ghost = firstUnknownStore([storeId], await deps.registeredStores(ctx.tenantId));
          if (ghost !== undefined) throw apiError(422, unknownStoreWords(ghost, 'The floor plan\'s store'));
        }
        const read = readFloorPlan(ctx.body, await deps.shelfLocations(ctx.tenantId, storeId));
        if (read.plan === undefined) {
          throw apiError(422, {
            code: 'floor_plan_not_valid',
            whatHappened: `The floor plan was not saved: ${read.problems.join('; ')}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Correct the areas named above and send the plan again. Nothing was changed.',
          });
        }
        const standing = latestOf(await deps.plans(ctx.tenantId, storeId));
        const plan: FloorPlan = { storeId, version: (standing?.version ?? 0) + 1, ...read.plan, publishedBy: ctx.userId, publishedAt: deps.now() };
        await deps.recordPlan(ctx.tenantId, plan);
        return { status: 201, body: { plan } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/merchandising/stores/:storeId/floor-plan',
      permission: 'merchandising.space.read',
      handler: async (ctx) => {
        const storeId = (ctx.params['storeId'] ?? '').trim();
        const plan = latestOf(await deps.plans(ctx.tenantId, storeId));
        if (plan === undefined) throw notFound(`floor plan for store ${storeId}`);
        return { status: 200, body: { plan } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/merchandising/stores/:storeId/heat-map',
      permission: 'merchandising.space.read',
      handler: async (ctx) => {
        const storeId = (ctx.params['storeId'] ?? '').trim();
        const { from, to } = ctx.query;
        const measure = (ctx.query['measure'] ?? 'sales') as HeatMeasure;
        if (!isDay(from) || !isDay(to) || to < from || (measure !== 'sales' && measure !== 'margin')) {
          throw apiError(400, {
            code: 'not_readable_as_a_heat_map',
            whatHappened: 'A heat map needs the days it covers — ?from=YYYY-MM-DD&to=YYYY-MM-DD (to on or after from) — and measure=sales or measure=margin.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the window and the measure. Nothing was changed; this only reads.',
          });
        }
        const plan = latestOf(await deps.plans(ctx.tenantId, storeId));
        if (plan === undefined) throw notFound(`floor plan for store ${storeId}`);
        const toIso = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString();
        const [placements, takings] = await Promise.all([
          deps.primaryPlacements(ctx.tenantId, storeId), deps.takings(ctx.tenantId, storeId, `${from}T00:00:00.000Z`, toIso),
        ]);
        const heat = floorHeatMap({ plan, primaryLocationOf: placements, takings, measure, currency: 'INR' });
        return {
          status: 200,
          body: {
            storeId, from, to, planVersion: plan.version, widthFt: plan.widthFt, depthFt: plan.depthFt, ...heat,
            factsFrom: 'head_office_banked_sales_average_buying_cost_and_planograms', asAt: deps.now(),
          },
        };
      },
    },
  ];
}
