// D-25 (R3) — forecast-driven fresh production planning and prep-batch traceability on head office's API.
//
//   GET /v1/production/plan?locationId=&forDay=YYYY-MM-DD       batches per recipe, from the forecast (advisory)
//   GET /v1/production/batches/:outputBatchId/inputs           the ingredient batches that went into one output batch
//   GET /v1/production/input-batches/:batchId/trace            an ingredient batch → the output batches made from it → their sales
//
// The plan is a READ: it proposes, and a person commits each run through the existing run route
// (`POST /v1/production/runs/:runId`, `production.plan.commit`), which records the run's input batch ids (D-25). Nothing
// here makes a run, moves stock or changes a price (hard rule #5).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { proposeProductionPlan, sellingWindowDays, InvalidPlanInputError, type PlanForecastDay } from '../../../packages/production/src/production-plan';
import { forecastDemand } from '../../../packages/demand/src/forecast';
import { salesHistory, type SoldLine } from '../../../packages/demand/src/sales-history';
import type { Recipe } from '../../../packages/production/src/recipe';
import type { OutboundLotRecord } from '../../../packages/quality/src/lot-trace';
import { assertLocationInScope } from './location-scope';
import type { RunInputBatch } from './production';
import { shopToday, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';

export interface ProductionTraceRun {
  readonly runId: string;
  readonly recipeId: string;
  readonly locationId: string;
  readonly outputProductId: string;
  readonly outputBatchId: string;
  readonly outputQuantityMinor: number;
  readonly at: string;
  readonly producedBy: string;
  /** Absent on a run recorded before D-25 — said as `inputs_not_recorded`. */
  readonly inputBatches?: readonly RunInputBatch[];
}

export interface ProductionPlanDeps {
  /** R1c (M01-FR-02): the shop's calendar — "today" is the shop's date, never the UTC one. */
  readonly calendar?: ShopCalendarOf;
  readonly now: () => string;
  readonly recipes: (tenantId: string) => Promise<readonly Recipe[]>;
  readonly enabledDepartments: (tenantId: string) => Promise<readonly string[]>;
  /** Sold lines of the store a location belongs to, for trading days [fromDay, toDay]. */
  readonly soldNear: (tenantId: string, locationId: string, fromDay: string, toDay: string) => Promise<readonly SoldLine[]>;
  /** Output already on hand at the store that is still good on the day (unexpired, or no expiry captured). */
  readonly usableOnHand: (tenantId: string, locationId: string, productId: string, onDay: string) => Promise<number>;
  readonly runs: (tenantId: string) => Promise<readonly ProductionTraceRun[]>;
  readonly soldOfBatch: (tenantId: string, batchId: string) => Promise<readonly OutboundLotRecord[]>;
  readonly locationBranches?: import('./location-scope').LocationBranches;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** The forecast learns from the trailing eight weeks, the demand-forecast read's own default. */
export const PLAN_HISTORY_DAYS = 56;

/** D-25 → D-26 hop: the ingredient batches that went into one output batch (empty when no run made it). */
export async function productionInputsOf(runs: readonly ProductionTraceRun[], outputBatchId: string): Promise<readonly { readonly runId: string; readonly outputProductId: string; readonly inputsRecorded: boolean; readonly inputBatches: readonly RunInputBatch[] }[]> {
  return runs.filter((r) => r.outputBatchId === outputBatchId).map((r) => ({ runId: r.runId, outputProductId: r.outputProductId, inputsRecorded: r.inputBatches !== undefined, inputBatches: r.inputBatches ?? [] }));
}

export function productionPlanRoutes(deps: ProductionPlanDeps): readonly Route[] {
  return [
    {
      api: 'API-04', method: 'GET', path: '/v1/production/plan',
      permission: 'production.read',
      handler: async (ctx) => {
        const locationId = (ctx.query['locationId'] ?? '').trim();
        const forDay = ctx.query['forDay'] ?? addDays(await shopToday(deps, ctx.tenantId), 1);
        if (locationId === '' || !DAY.test(forDay)) {
          throw apiError(400, { code: 'not_readable_as_a_plan_query', whatHappened: 'A production plan needs ?locationId= (the kitchen or bakery) and optionally ?forDay=YYYY-MM-DD (default tomorrow).', wasItSaved: 'not_saved', nextSafeAction: 'Correct the query. Nothing was changed; this only reads.' });
        }
        await assertLocationInScope(ctx, locationId, deps.locationBranches);
        const recipes = await deps.recipes(ctx.tenantId);
        const operated = await deps.enabledDepartments(ctx.tenantId);
        const to = addDays(forDay, -1);
        const from = addDays(to, -(PLAN_HISTORY_DAYS - 1));
        const lines = await deps.soldNear(ctx.tenantId, locationId, from, to);
        const forecasts = new Map<string, readonly PlanForecastDay[] | undefined>();
        for (const r of recipes) {
          if (forecasts.has(r.outputProductId)) continue;
          const mine = lines.filter((l) => l.productId === r.outputProductId);
          if (mine.length === 0) { forecasts.set(r.outputProductId, undefined); continue; }
          const history = (salesHistory({ lines: mine, from, to }).products[0]?.byDay ?? []).map((d) => ({ day: d.day, qty: d.qtyMinor }));
          const f = forecastDemand({ history, from, to, horizonDays: Math.max(1, sellingWindowDays(r.shelfLifeHours)) + 7 });
          forecasts.set(r.outputProductId, f.horizon.map((d) => ({ day: d.day, forecastQty: d.forecastQty })));
        }
        const onHand = new Map<string, number>();
        for (const r of recipes) if (!onHand.has(r.outputProductId)) onHand.set(r.outputProductId, await deps.usableOnHand(ctx.tenantId, locationId, r.outputProductId, forDay));
        try {
          const plan = proposeProductionPlan({ forDay, recipes, operatedDepartments: operated, forecastOf: (p) => forecasts.get(p), onHandUsableOf: (p) => onHand.get(p) ?? 0 });
          return {
            status: 200,
            body: {
              ...plan, locationId, historyFrom: from, historyTo: to, advisoryOnly: true,
              commitVia: 'POST /v1/production/runs/:runId — a person commits each run; the run records its input batch ids',
              asAt: deps.now(),
            },
          };
        } catch (e) {
          if (e instanceof InvalidPlanInputError) throw apiError(400, { code: 'not_readable_as_a_plan_query', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the query. Nothing was changed.' });
          throw e;
        }
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/production/batches/:outputBatchId/inputs',
      permission: 'production.read',
      handler: async (ctx) => {
        const outputBatchId = (ctx.params['outputBatchId'] ?? '').trim();
        const runs = await deps.runs(ctx.tenantId);
        const made = await productionInputsOf(runs, outputBatchId);
        if (made.length === 0) throw apiError(404, { code: 'output_batch_not_produced', whatHappened: `No production run made batch ${outputBatchId}.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the batch id on the label.' });
        for (const r of runs.filter((x) => x.outputBatchId === outputBatchId)) await assertLocationInScope(ctx, r.locationId, deps.locationBranches);
        return { status: 200, body: { outputBatchId, runs: made, asAt: deps.now() } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/production/input-batches/:batchId/trace',
      permission: 'quality.lottrace.read',
      handler: async (ctx) => {
        const batchId = (ctx.params['batchId'] ?? '').trim();
        const runs = (await deps.runs(ctx.tenantId)).filter((r) => (r.inputBatches ?? []).some((i) => i.batchId === batchId));
        const outputs = await Promise.all(runs.map(async (r) => {
          const used = (r.inputBatches ?? []).filter((i) => i.batchId === batchId);
          const sold = await deps.soldOfBatch(ctx.tenantId, r.outputBatchId);
          return {
            runId: r.runId, recipeId: r.recipeId, locationId: r.locationId, at: r.at,
            outputProductId: r.outputProductId, outputBatchId: r.outputBatchId, outputQuantityMinor: r.outputQuantityMinor,
            inputUsed: used.map((u) => ({ productId: u.productId, quantityMinor: u.quantityMinor, uom: u.uom, source: u.source })),
            sales: sold, soldCount: sold.length,
          };
        }));
        // Runs recorded before D-25 carry no input batches: their count is said, so a trace never reads "none" by omission.
        const notRecorded = (await deps.runs(ctx.tenantId)).filter((r) => r.inputBatches === undefined).length;
        return { status: 200, body: { batchId, outputs, runsWithoutRecordedInputs: notRecorded, asAt: deps.now() } };
      },
    },
  ];
}
