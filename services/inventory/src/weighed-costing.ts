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
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { FoodHandlingTask, FoodHandlingVerdict } from '../../../packages/workforce/src/food-handling';
import { handlesFood } from '../../../packages/production/src/departments';
import { foodHandlingRefusal } from './production';

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
  /** OB-502 · M25-FR-03: may counter-food work be recorded in this person's name at this moment (see production.ts). */
  readonly foodHandling?: (tenantId: string, personId: string, task: FoodHandlingTask, at: string) => Promise<FoodHandlingVerdict> | FoodHandlingVerdict;
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

        // OB-502: counter-food work is refused in the name of a person whose food-handling certificate expired or is missing.
        if (deps.foodHandling !== undefined && handlesFood(b['departmentId'] as string)) {
          const verdict = await deps.foodHandling(ctx.tenantId, ctx.userId, 'weighed_run', deps.now());
          if (!verdict.allowed) foodHandlingRefusal(verdict);
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

// ── OB-288 lane 2 · P2: a weigh-in / weigh-out captured at the counter with the line down (M11-FR-02, §31) ───────────
//
// "Offline: weight capture offline; costing reconciles online." The production screen the store computer serves keeps the
// WEIGHTS on its durable device queue — what went in and what came out, in whole grams, who weighed it and when; the box
// relays them here. The COST is head office's, at sync time: each input at head office's own average buying cost per kilo
// at the store (OB-39) — never a figure typed at the counter. An input head office holds no cost for is NOT costed at zero
// as if it were free: the run is recorded with its weights and yield, `costKnown: false` and the input named (P-08), the
// same rule a recipe run follows. The person who weighed is re-verified from their grants and a breach is flagged. The same
// run again is 200 (one run); different weights under the same id are a conflict, refused by name (hard rule #10).

export interface SyncedWeighedRunDeps extends WeighedCostingDeps {
  /** Head office's own cost per KILOGRAM of a product at the store (its average buying cost), or undefined when it holds none. */
  readonly costPerKgAt: (tenantId: string, storeId: string, productId: string) => Promise<Money | undefined> | Money | undefined;
  readonly permissionsOfUser?: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

/** What head office found about a relayed weighed run — said on the record. */
export type WeighedSyncFlag = 'weigher_unknown' | 'weigher_lacks_authority' | 'weigher_food_certificate_not_valid'; // OB-502: recorded (it happened) and said

/** A relayed weighed run: the engine's result plus who carried it and what head office could not cost. */
export interface RelayedWeighedRun extends StoredWeighedRun {
  readonly weighedBy?: string;
  readonly costKnown?: boolean;
  readonly uncostedProducts?: readonly string[];
  readonly syncFlags?: readonly WeighedSyncFlag[];
  readonly relayed?: { readonly relayedBy: string; readonly source: string; readonly storeId: string };
  /** The weights exactly as captured, so a re-sent run is judged the same run. */
  readonly captured?: { readonly inputs: readonly { readonly productId: string; readonly weightGrams: number }[]; readonly outputs: readonly CatchWeightOutput[] };
}

const weightsKey = (inputs: readonly { productId: string; weightGrams: number }[], outputs: readonly CatchWeightOutput[]): string =>
  JSON.stringify([inputs.map((i) => [i.productId, i.weightGrams]), outputs.map((o) => [o.productId, o.weightGrams, o.costWeightBp ?? null, o.isByproduct ?? false])]);

export function syncedWeighedCostingRoutes(deps: SyncedWeighedRunDeps): readonly Route[] {
  return [
    {
      // Body: { runId (= path), storeId, departmentId, inputs: [{ productId, weightGrams }], outputs: [{ productId, weightGrams,
      // costWeightBp?, isByproduct? }], standardYieldBp?, toleranceBp?, weighedBy, at, source? }.
      api: 'API-04', method: 'POST', path: '/v1/production/weighed-runs/:runId/synced',
      permission: 'production.sync', idempotent: true,
      handler: async (ctx) => {
        const runId = (ctx.params['runId'] ?? '').trim();
        const b = isObj(ctx.body) ? ctx.body : {};
        const rawInputs = Array.isArray(b['inputs']) && (b['inputs'] as unknown[]).length > 0
          && (b['inputs'] as unknown[]).every((r) => isObj(r) && isStr(r['productId']) && isPosInt(r['weightGrams']) && r['costPerKg'] === undefined)
          ? (b['inputs'] as { productId: string; weightGrams: number }[]).map((r) => ({ productId: r.productId, weightGrams: r.weightGrams })) : null;
        const outputs = readOutputs(b['outputs']);
        if (runId === '' || b['runId'] !== runId || !isStr(b['storeId']) || !isStr(b['departmentId']) || rawInputs === null || outputs === null
          || !isStr(b['weighedBy']) || !isStr(b['at']) || Number.isNaN(Date.parse(b['at'] as string))
          || (b['standardYieldBp'] !== undefined && !isNonNegInt(b['standardYieldBp'])) || (b['toleranceBp'] !== undefined && !isNonNegInt(b['toleranceBp']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_relayed_weighed_run',
            whatHappened: 'This could not be read as a weighed run from the store — it needs the runId matching the path, storeId, departmentId, the inputs and outputs in whole grams (no cost: head office costs it), who weighed it (weighedBy) and when (at).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it.',
          });
        }
        const storeId = b['storeId'] as string;
        const weighedBy = (b['weighedBy'] as string).trim();
        const prior = await deps.weighedRun(ctx.tenantId, runId) as RelayedWeighedRun | undefined;
        if (prior !== undefined) {
          const same = prior.captured !== undefined && prior.weighedBy === weighedBy && weightsKey(prior.captured.inputs, prior.captured.outputs) === weightsKey(rawInputs, outputs);
          if (same) return { status: 200, body: { ...prior, alreadyCosted: true } };
          throw apiError(422, {
            code: 'weighed_run_conflicts_with_record',
            whatHappened: `Head office already holds weighed run ${runId}${prior.weighedBy === undefined ? '' : ` weighed by ${prior.weighedBy}`}; this store's run under the same id has different weights or a different person. The two cannot both be right.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Kept at the store for a person to compare. Nothing was costed twice.',
          });
        }
        // Head office's own cost per kilo for each input, now — never the counter's. Unknown → named, not costed at zero.
        const uncosted: string[] = [];
        const inputs: CatchWeightInput[] = [];
        for (const i of rawInputs) {
          const cost = await deps.costPerKgAt(ctx.tenantId, storeId, i.productId);
          if (cost === undefined) uncosted.push(i.productId);
          inputs.push({ productId: i.productId, weightGrams: i.weightGrams, costPerKg: cost ?? { minor: 0, currency: 'INR' } });
        }
        const currencies = new Set(inputs.filter((i) => !uncosted.includes(i.productId)).map((i) => i.costPerKg.currency));
        const currency: CurrencyCode = currencies.size === 1 ? [...currencies][0] as CurrencyCode : 'INR';
        const at = new Date(Date.parse(b['at'] as string)).toISOString();
        const run: CatchWeightRun = {
          runId, departmentId: b['departmentId'] as string, inputs, outputs, at,
          ...(b['standardYieldBp'] !== undefined ? { standardYieldBp: b['standardYieldBp'] as number } : {}),
          ...(b['toleranceBp'] !== undefined ? { toleranceBp: b['toleranceBp'] as number } : {}),
        };
        let result: CatchWeightResult;
        try {
          result = costCatchWeight(run, currency);
        } catch (e) {
          if (e instanceof InvalidCatchWeightError) {
            throw apiError(422, { code: 'invalid_weighed_run', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Kept at the store for a person: the weights cannot be right. Nothing was recorded.' });
          }
          throw e;
        }
        const held = await deps.permissionsOfUser?.(ctx.tenantId, weighedBy);
        const flags: WeighedSyncFlag[] = held === undefined ? ['weigher_unknown'] : held.includes('production.plan.commit') ? [] : ['weigher_lacks_authority'];
        // OB-502: judged as at the moment it was weighed, on head office's certificate register.
        if (deps.foodHandling !== undefined && handlesFood(run.departmentId) && !(await deps.foodHandling(ctx.tenantId, weighedBy, 'weighed_run', at)).allowed) flags.push('weigher_food_certificate_not_valid');
        const stored: RelayedWeighedRun = {
          runId, departmentId: run.departmentId, costedBy: ctx.userId, at, result,
          weighedBy, costKnown: uncosted.length === 0, uncostedProducts: uncosted, syncFlags: flags,
          relayed: { relayedBy: ctx.userId, source: isStr(b['source']) ? b['source'] : 'unknown', storeId },
          captured: { inputs: rawInputs, outputs },
        };
        await deps.recordWeighedRun(ctx.tenantId, stored);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: weighedBy, action: 'production.weighed_run.record', objectType: 'weighed_run', objectId: runId, at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null, capturedOffline: true },
          before: null,
          after: { departmentId: run.departmentId, inputGrams: String(result.inputWeightGrams), outputGrams: String(result.outputWeightGrams), yieldBp: String(result.yieldBp), costKnown: String(uncosted.length === 0), relayedBy: ctx.userId, flags: flags.join(',') },
          correlationId: runId,
        });
        return { status: 202, body: { ...stored, alreadyCosted: false } };
      },
    },
  ];
}
