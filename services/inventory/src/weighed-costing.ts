// API-04 Weighed-department costing (M11-FR-02, weighed departments) — on the live API, run on the
// tested `packages/production` catch-weight engine.
//
// A butcher, a fish counter and a deli do not make "40 cups from a recipe". They take in 12.4 kg of
// something, throw away bone/skin/trim, and put out 8.9 kg of something else — and every gram is money.
// The wired recipe-production surface (`/v1/production/runs/:id`) cannot express this: it needs a BOM of
// discrete-unit inputs and puts the output into quarantine. This is the OTHER production shape — recipe-
// LESS weigh-in → weigh-out, where the cost of what survived is the whole input cost spread over the
// sellable output, and the yield is measured against the department's OWN standard.
//
// Its value is entirely in being tracked: "cost per kilo of output = input cost ÷ output weight" is the
// one line that explains how a fish counter runs at a loss for a year without anyone noticing. So a costed
// run is PERSISTED (append-only) and the board reads worst-first — a low-yield cut is a valued exception
// with the money attached (P-03 control by exception), not a note. Nothing here moves stock or sets a
// price; it costs a cut and reports the variance. Gated production.plan.commit (costing) / production.read.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  costCatchWeight, priceByWeight, InvalidCatchWeightError,
  type CatchWeightRun, type CatchWeightResult, type CatchWeightInput, type CatchWeightOutput,
} from '../../../packages/production/src/catch-weight';
import { isCurrencyCode, type CurrencyCode, type Money } from '../../../packages/contracts/src/money';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** A costed weighed run, kept append-only so a department's yield can be watched over time. */
export interface StoredWeighedRun {
  readonly runId: string;
  readonly departmentId: string;
  readonly costedBy: string;
  readonly at: string;
  readonly result: CatchWeightResult;
}

export interface WeighedCostingDeps {
  /** Every costed weighed run for a tenant (latest per runId) — the board and idempotency fold over these. */
  readonly weighedRuns: (tenantId: string) => Promise<readonly StoredWeighedRun[]> | readonly StoredWeighedRun[];
  /** One costed run by id, or nothing — the idempotency check. */
  readonly weighedRun: (tenantId: string, runId: string) => Promise<StoredWeighedRun | undefined> | StoredWeighedRun | undefined;
  /** Persist a costed run, append-only. Idempotent on the run id. */
  readonly recordWeighedRun: (tenantId: string, run: StoredWeighedRun) => Promise<void> | void;
  readonly now: () => string;
}

/** Read the weighed inputs, or null if any is malformed. All costPerKg must share one currency. */
function readInputs(raw: unknown): { readonly inputs: readonly CatchWeightInput[]; readonly currency: CurrencyCode } | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const inputs: CatchWeightInput[] = [];
  let currency: CurrencyCode | undefined;
  for (const r of raw) {
    if (!isObj(r) || !isStr(r['productId']) || !isPosInt(r['weightGrams']) || !isObj(r['costPerKg'])) return null;
    const cpk = r['costPerKg'];
    if (!isNonNegInt(cpk['minor']) || !isCurrencyCode(cpk['currency'] as string)) return null;
    const cur = cpk['currency'] as CurrencyCode;
    if (currency === undefined) currency = cur;
    else if (currency !== cur) return null; // mixed currencies in one run are refused
    inputs.push({ productId: r['productId'], weightGrams: r['weightGrams'], costPerKg: { minor: cpk['minor'], currency: cur } });
  }
  return { inputs, currency: currency! };
}

/** Read the weighed outputs (may be empty — a total-loss run is still a fact), or null if malformed. */
function readOutputs(raw: unknown): readonly CatchWeightOutput[] | null {
  if (!Array.isArray(raw)) return null;
  const outputs: CatchWeightOutput[] = [];
  for (const r of raw) {
    if (!isObj(r) || !isStr(r['productId']) || !isNonNegInt(r['weightGrams'])) return null;
    if (r['costWeightBp'] !== undefined && !isNonNegInt(r['costWeightBp'])) return null;
    if (r['isByproduct'] !== undefined && typeof r['isByproduct'] !== 'boolean') return null;
    outputs.push({
      productId: r['productId'],
      weightGrams: r['weightGrams'],
      ...(r['costWeightBp'] !== undefined ? { costWeightBp: r['costWeightBp'] as number } : {}),
      ...(r['isByproduct'] !== undefined ? { isByproduct: r['isByproduct'] as boolean } : {}),
    });
  }
  return outputs;
}

export function weighedCostingRoutes(deps: WeighedCostingDeps): readonly Route[] {
  return [
    {
      // Cost a weighed cut/process and measure its yield against the department standard. Persisted
      // append-only; idempotent on the run id (a re-cost of the same run returns what was recorded).
      api: 'API-04', method: 'POST', path: '/v1/production/weighed-runs/:runId',
      permission: 'production.plan.commit', idempotent: true,
      handler: async (ctx) => {
        const runId = ctx.params['runId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['departmentId'])) {
          throw apiError(400, { code: 'weighed_run_needs_a_department', whatHappened: 'A weighed run needs the { departmentId } it belongs to (the counter it was cut at).', wasItSaved: 'not_saved', nextSafeAction: 'Send the department.' });
        }
        const read = readInputs(b['inputs']);
        if (read === null) {
          throw apiError(400, { code: 'weighed_run_needs_inputs', whatHappened: 'A weighed run needs { inputs }: at least one { productId, weightGrams (whole grams > 0), costPerKg { minor, currency } }, all sharing one currency.', wasItSaved: 'not_saved', nextSafeAction: 'Send what went in, its weight in grams and its cost per kg.' });
        }
        const outputs = readOutputs(b['outputs']);
        if (outputs === null) {
          throw apiError(400, { code: 'weighed_run_needs_outputs', whatHappened: 'A weighed run needs { outputs }: an array of { productId, weightGrams (whole grams), costWeightBp?, isByproduct? }.', wasItSaved: 'not_saved', nextSafeAction: 'Send what came out, by weight in grams.' });
        }
        if (b['standardYieldBp'] !== undefined && !isNonNegInt(b['standardYieldBp'])) {
          throw apiError(400, { code: 'standard_yield_not_bps', whatHappened: 'standardYieldBp, if given, is whole basis points of input weight (e.g. 8000 for an 80% standard).', wasItSaved: 'not_saved', nextSafeAction: 'Send the standard yield in basis points, or leave it out.' });
        }
        if (b['toleranceBp'] !== undefined && !isNonNegInt(b['toleranceBp'])) {
          throw apiError(400, { code: 'tolerance_not_bps', whatHappened: 'toleranceBp, if given, is whole basis points.', wasItSaved: 'not_saved', nextSafeAction: 'Send the tolerance in basis points, or leave it out.' });
        }

        const existing = await deps.weighedRun(ctx.tenantId, runId);
        if (existing !== undefined) {
          // A weighed run is costed once — a re-post returns what was recorded, never a second figure.
          return { status: 200, body: { ...existing, alreadyCosted: true } };
        }

        const run: CatchWeightRun = {
          runId,
          departmentId: b['departmentId'],
          inputs: read.inputs,
          outputs,
          ...(b['standardYieldBp'] !== undefined ? { standardYieldBp: b['standardYieldBp'] as number } : {}),
          ...(b['toleranceBp'] !== undefined ? { toleranceBp: b['toleranceBp'] as number } : {}),
          at: deps.now(),
        };
        let result: CatchWeightResult;
        try {
          result = costCatchWeight(run, read.currency);
        } catch (e) {
          if (e instanceof InvalidCatchWeightError) {
            throw apiError(400, { code: 'invalid_weighed_run', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the weights and re-send. Nothing was recorded.' });
          }
          throw e;
        }
        const stored: StoredWeighedRun = { runId, departmentId: run.departmentId, costedBy: ctx.userId, at: run.at, result };
        await deps.recordWeighedRun(ctx.tenantId, stored);
        return { status: 201, body: stored };
      },
    },
    {
      // The costed weighed runs, WORST FIRST — a run with a yield exception (or a gained-weight mis-weigh)
      // before the clean ones, and within those the lowest yield first, so a counter quietly losing money
      // is at the top of the list (P-03). ?department= filters; ?onlyExceptions=true shows only the flagged.
      api: 'API-04', method: 'GET', path: '/v1/production/weighed-runs',
      permission: 'production.read',
      handler: async (ctx) => {
        const dept = ctx.query['department'];
        const onlyExceptions = ctx.query['onlyExceptions'] === 'true';
        let runs = await deps.weighedRuns(ctx.tenantId);
        if (isStr(dept)) runs = runs.filter((r) => r.departmentId === dept);
        const withExceptions = runs.filter((r) => r.result.exceptions.length > 0).length;
        const view = (onlyExceptions ? runs.filter((r) => r.result.exceptions.length > 0) : [...runs]).sort((a, b) => {
          const ax = a.result.exceptions.length > 0 ? 0 : 1;
          const bx = b.result.exceptions.length > 0 ? 0 : 1;
          if (ax !== bx) return ax - bx;             // exceptions first
          return a.result.yieldBp - b.result.yieldBp; // then lowest yield first (worst money loss)
        });
        return { status: 200, body: { runs: view, count: view.length, withExceptions, asAt: deps.now() } };
      },
    },
    {
      // Price a weighed pack: price per kg × its weight, exact to the paisa. A pure ruling for a scale/POS
      // — it sets no price, it computes what a given price per kg comes to for a given weight.
      api: 'API-04', method: 'POST', path: '/v1/production/price-by-weight',
      permission: 'production.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const ppk = b['pricePerKg'];
        if (!isObj(ppk) || !isNonNegInt(ppk['minor']) || !isCurrencyCode(ppk['currency'] as string) || !isPosInt(b['weightGrams'])) {
          throw apiError(400, { code: 'price_by_weight_needs_rate_and_weight', whatHappened: 'This needs { pricePerKg { minor, currency } } and a whole { weightGrams } greater than 0.', wasItSaved: 'not_saved', nextSafeAction: 'Send the price per kg and the pack weight in grams.' });
        }
        const pricePerKg: Money = { minor: ppk['minor'] as number, currency: ppk['currency'] as CurrencyCode };
        const price = priceByWeight(pricePerKg, b['weightGrams'] as number);
        return { status: 200, body: { price, pricePerKg, weightGrams: b['weightGrams'] } };
      },
    },
  ];
}
