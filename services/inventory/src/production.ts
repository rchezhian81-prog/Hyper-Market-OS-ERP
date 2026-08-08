// API-04 in-store production — recipes, raw-material issue, finished batches (M11-FR-01/02).
//
// In-store production (the cafe, bakery, deli, kitchen) is where stock quietly stops adding up:
// ingredients leave the shelf and something else appears on the counter. A run is exactly two things —
// inputs consumed (stock out) and a finished batch created (stock in, into QUARANTINE until quality
// releases it) — and the authoritative rules are the pure `produceBatch` engine in
// `packages/production`: you cannot issue more than you have (a short run is refused, naming the
// shortfall, before anything is consumed); the output lands in quarantine (never sellable until
// released); and cost follows the food that survived (trim/spillage carried by the output, not written
// off). This surface only wires those rules to the API and persists the evidence.
//
// Why production keeps its OWN append-only stream, LAYERED on M08 (as counts and the warehouse do):
// `produceBatch` works in the state-aware stock model (on_hand → consumed, → quarantine), which M08's
// simple on-hand ledger (a kind + a positive quantity, no states) cannot express. So the raw-material
// on-hand a run is checked against is the M08 position MINUS what prior production runs at that
// location have already consumed — repeated runs deplete correctly even though M08 is not mutated here.
// Append-only (#2); idempotent on the run id.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  produceBatch, validateRecipe, InvalidRecipeError, InsufficientMaterialError,
  type Recipe, type RecipeInput, type ProductionException,
} from '../../../packages/production/src/recipe';
import { releaseForSale } from '../../../packages/production/src/packing';
import type { StockMovement } from '../../../packages/stock/src/position';
import { isCurrencyCode, type CurrencyCode } from '../../../packages/contracts/src/money';

/** A committed production run, recorded as the evidence a later report reads. */
export interface StoredRun {
  readonly runId: string;
  readonly recipeId: string;
  readonly departmentId: string;
  readonly locationId: string;
  readonly outputProductId: string;
  readonly outputBatchId: string;
  readonly outputQuantityMinor: number;
  readonly outputUom: string;
  readonly expiresAt: string;
  readonly inputCostMinor: number;
  readonly outputUnitCostMinor: number;
  readonly currency: CurrencyCode;
  readonly yieldBp: number;
  readonly yieldVerdict: string;
  readonly exceptions: readonly ProductionException[];
  /** What this run consumed — layered onto M08 so the next run sees depleted ingredients. */
  readonly consumed: readonly RecipeInput[];
  readonly producedBy: string;
  readonly at: string;
  /** Quality-release state, set by the adapter's fold of release events (M11-FR-03). */
  readonly released?: boolean;
  readonly releasedBy?: string | null;
  readonly releasedAt?: string | null;
}

/** A quality release recorded against a run — moves the finished batch out of quarantine. */
export interface StoredRelease {
  readonly runId: string;
  readonly batchId: string;
  readonly releasedBy: string;
  readonly quantityMinor: number;
  readonly releasedAt: string;
}

export interface ProductionDeps {
  /** The registered recipe, or nothing when the box has never been told it. */
  readonly recipe: (tenantId: string, recipeId: string) => Promise<Recipe | undefined> | Recipe | undefined;
  readonly recordRecipe: (tenantId: string, recipe: Recipe) => Promise<void> | void;
  /** Authoritative M08 on-hand for (product, location) — the base a run is checked against. */
  readonly onHand: (tenantId: string, productId: string, locationId: string) => Promise<number> | number;
  /** What prior production runs at a location have already consumed, per product. */
  readonly priorConsumption: (tenantId: string, locationId: string) => Promise<Readonly<Record<string, number>>> | Readonly<Record<string, number>>;
  readonly runExists: (tenantId: string, runId: string) => Promise<boolean> | boolean;
  readonly runs: (tenantId: string) => Promise<readonly StoredRun[]> | readonly StoredRun[];
  /** One run with its release state merged, or nothing. */
  readonly run: (tenantId: string, runId: string) => Promise<StoredRun | undefined> | StoredRun | undefined;
  readonly recordRun: (tenantId: string, run: StoredRun) => Promise<void> | void;
  readonly recordRelease: (tenantId: string, release: StoredRelease) => Promise<void> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

function readInputs(raw: unknown): readonly RecipeInput[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: RecipeInput[] = [];
  for (const r of raw) {
    const o = r as { productId?: unknown; quantityMinor?: unknown; uom?: unknown };
    if (!isStr(o.productId) || !isPosInt(o.quantityMinor) || !isStr(o.uom)) return null;
    out.push({ productId: o.productId, quantityMinor: o.quantityMinor, uom: o.uom });
  }
  return out;
}

export function productionRoutes(deps: ProductionDeps): readonly Route[] {
  return [
    {
      // Register a recipe / bill of materials (M11-FR-01). Validated by the authoritative engine —
      // a recipe that consumes nothing, produces nothing, or carries no shelf life is refused.
      api: 'API-04', method: 'POST', path: '/v1/production/recipes/:recipeId',
      permission: 'production.recipe.manage', idempotent: true,
      handler: async (ctx) => {
        const recipeId = ctx.params['recipeId'] ?? '';
        const b = (ctx.body ?? {}) as {
          departmentId?: unknown; outputProductId?: unknown; outputQuantityMinor?: unknown; outputUom?: unknown;
          inputs?: unknown; shelfLifeHours?: unknown; expectedYieldBp?: unknown; yieldToleranceBp?: unknown;
        };
        const inputs = readInputs(b.inputs);
        if (!isStr(recipeId) || !isStr(b.departmentId) || !isStr(b.outputProductId) || !isPosInt(b.outputQuantityMinor)
          || !isStr(b.outputUom) || inputs === null || !isPosInt(b.shelfLifeHours)
          || (b.expectedYieldBp !== undefined && !isNonNegInt(b.expectedYieldBp))
          || (b.yieldToleranceBp !== undefined && !isNonNegInt(b.yieldToleranceBp))) {
          throw apiError(400, {
            code: 'not_readable_as_a_recipe',
            whatHappened: 'A recipe needs a departmentId, an outputProductId, a whole outputQuantityMinor, an outputUom, at least one input, and a whole shelfLifeHours.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the recipe with its inputs. Nothing was recorded.',
          });
        }
        const recipe: Recipe = {
          recipeId, departmentId: b.departmentId, outputProductId: b.outputProductId,
          outputQuantityMinor: b.outputQuantityMinor, outputUom: b.outputUom, inputs,
          shelfLifeHours: b.shelfLifeHours,
          ...(b.expectedYieldBp === undefined ? {} : { expectedYieldBp: b.expectedYieldBp }),
          ...(b.yieldToleranceBp === undefined ? {} : { yieldToleranceBp: b.yieldToleranceBp }),
        };
        try {
          validateRecipe(recipe);
        } catch (e) {
          if (e instanceof InvalidRecipeError) {
            throw apiError(400, { code: 'invalid_recipe', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the recipe and re-send. Nothing was recorded.' });
          }
          throw e;
        }
        await deps.recordRecipe(ctx.tenantId, recipe);
        return { status: 201, body: { recipeId, outputProductId: recipe.outputProductId } };
      },
    },
    {
      // Commit a production run (M11-FR-01/02): consume the inputs and create the finished batch. A run
      // that would take an ingredient negative is refused (nothing is consumed). The finished batch
      // lands in quarantine with its own batch id and expiry; cost and yield are measured.
      api: 'API-04', method: 'POST', path: '/v1/production/runs/:runId',
      permission: 'production.plan.commit', idempotent: true,
      handler: async (ctx) => {
        const runId = ctx.params['runId'] ?? '';
        const b = (ctx.body ?? {}) as {
          recipeId?: unknown; batches?: unknown; actualOutputMinor?: unknown; outputBatchId?: unknown;
          locationId?: unknown; unitCosts?: unknown; currency?: unknown;
        };
        if (!isStr(runId) || !isStr(b.recipeId) || !isPosInt(b.batches) || !isNonNegInt(b.actualOutputMinor)
          || !isStr(b.outputBatchId) || !isStr(b.locationId)
          || (b.currency !== undefined && !isCurrencyCode(b.currency as string))) {
          throw apiError(400, {
            code: 'not_readable_as_a_run',
            whatHappened: 'A run needs a recipeId, a whole batches count, a whole actualOutputMinor, an outputBatchId and a locationId.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the run. Nothing was recorded.',
          });
        }
        if (await deps.runExists(ctx.tenantId, runId)) {
          throw apiError(409, {
            code: 'run_already_committed',
            whatHappened: `Run ${runId} has already been committed — a run id is used once.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Use a new run id. Nothing was changed.',
          });
        }
        const recipe = await deps.recipe(ctx.tenantId, b.recipeId);
        if (recipe === undefined) {
          throw apiError(404, {
            code: 'recipe_not_found',
            whatHappened: `No recipe "${b.recipeId}" is registered — a run must reference one.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Register the recipe first, then commit the run.',
          });
        }

        const currency = (b.currency as CurrencyCode) ?? 'INR';
        const at = deps.now();
        // Available = the authoritative M08 on-hand for each ingredient, MINUS what prior runs at this
        // location already consumed, so repeated runs deplete rather than re-issuing the same stock.
        const prior = await deps.priorConsumption(ctx.tenantId, b.locationId);
        const available: Record<string, number> = {};
        for (const input of recipe.inputs) {
          const base = await deps.onHand(ctx.tenantId, input.productId, b.locationId);
          available[input.productId] = base - (prior[input.productId] ?? 0);
        }
        const unitCosts = readUnitCosts(b.unitCosts, currency);

        let result;
        try {
          result = produceBatch({
            run: {
              runId, recipe, batches: b.batches, locationId: b.locationId, producedBy: ctx.userId,
              at, outputBatchId: b.outputBatchId, actualOutputMinor: b.actualOutputMinor,
            },
            available, unitCosts, currency,
          });
        } catch (e) {
          if (e instanceof InsufficientMaterialError) {
            throw apiError(422, { code: 'production_short', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Receive or transfer in the short ingredient, then re-send. Nothing was consumed.' });
          }
          if (e instanceof InvalidRecipeError) {
            throw apiError(400, { code: 'invalid_recipe', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the recipe and re-send. Nothing was recorded.' });
          }
          throw e;
        }

        const consumed = consumedInputs(result.movements);
        const run: StoredRun = {
          runId, recipeId: recipe.recipeId, departmentId: recipe.departmentId, locationId: b.locationId,
          outputProductId: result.outputProductId, outputBatchId: result.outputBatchId,
          outputQuantityMinor: result.outputQuantityMinor, outputUom: recipe.outputUom, expiresAt: result.expiresAt,
          inputCostMinor: result.inputCost.minor, outputUnitCostMinor: result.outputUnitCost.minor, currency,
          yieldBp: result.yieldBp, yieldVerdict: result.yieldVerdict, exceptions: result.exceptions,
          consumed, producedBy: ctx.userId, at,
        };
        await deps.recordRun(ctx.tenantId, run);
        return {
          status: 201,
          body: {
            runId, outputProductId: run.outputProductId, outputBatchId: run.outputBatchId,
            outputQuantityMinor: run.outputQuantityMinor, expiresAt: run.expiresAt,
            inputCostMinor: run.inputCostMinor, outputUnitCostMinor: run.outputUnitCostMinor,
            yieldBp: run.yieldBp, yieldVerdict: run.yieldVerdict, exceptions: run.exceptions,
          },
        };
      },
    },
    {
      // Quality release (M11-FR-03): move a run's finished batch out of quarantine and make it
      // sellable. Refused for a failed check, an unnamed releaser, or a batch that has already
      // expired — you cannot release your way past a use-by date. Freshly produced food is not
      // sellable because it exists; it is sellable when someone has looked at it and said so.
      api: 'API-04', method: 'POST', path: '/v1/production/runs/:runId/release',
      permission: 'production.release', idempotent: true,
      handler: async (ctx) => {
        const runId = ctx.params['runId'] ?? '';
        const b = (ctx.body ?? {}) as { qcPassed?: unknown; notes?: unknown };
        if (!isStr(runId) || typeof b.qcPassed !== 'boolean' || (b.notes !== undefined && typeof b.notes !== 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_a_release',
            whatHappened: 'A release needs a boolean qcPassed (did the quality check pass?).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { qcPassed: true|false }. Nothing was changed.',
          });
        }
        const run = await deps.run(ctx.tenantId, runId);
        if (run === undefined) {
          throw apiError(404, { code: 'run_not_found', whatHappened: `No production run "${runId}".`, wasItSaved: 'not_saved', nextSafeAction: 'Commit the run first, then release it.' });
        }
        if (run.released === true) {
          throw apiError(409, { code: 'batch_already_released', whatHappened: `Run ${runId}'s batch has already been released.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed — the batch is already sellable.' });
        }
        const at = deps.now();
        const result = releaseForSale({
          release: { batchId: run.outputBatchId, releasedBy: ctx.userId, qcPassed: b.qcPassed, at, ...(isStr(b.notes) ? { notes: b.notes } : {}) },
          productId: run.outputProductId, locationId: run.locationId, quantityMinor: run.outputQuantityMinor, uom: run.outputUom, expiresAt: run.expiresAt,
        });
        if (!result.released) {
          // qc_failed / already_expired / no_releaser / nothing_to_release — all keep the batch in
          // quarantine. Reported with the engine's own reason so the audit trail can act on it.
          throw apiError(422, { code: result.outcome, whatHappened: result.detail, wasItSaved: 'not_saved', nextSafeAction: 'The batch stays in quarantine. Fix the cause and, where the batch is still good, release it again.' });
        }
        await deps.recordRelease(ctx.tenantId, { runId, batchId: run.outputBatchId, releasedBy: ctx.userId, quantityMinor: run.outputQuantityMinor, releasedAt: at });
        return { status: 200, body: { runId, batchId: run.outputBatchId, released: true, releasedBy: ctx.userId, releasedAt: at, movements: result.movements } };
      },
    },
    {
      // The production runs recorded so far — their finished batches, costs, yields and exceptions.
      api: 'API-04', method: 'GET', path: '/v1/production/runs',
      permission: 'production.read',
      handler: async (ctx) => {
        const locationId = ctx.query['locationId'];
        const all = await deps.runs(ctx.tenantId);
        const runs = isStr(locationId) ? all.filter((r) => r.locationId === locationId) : all;
        return { status: 200, body: { runs, asAt: deps.now() } };
      },
    },
  ];
}

/** The consumed ingredients of a run, from its ledger movements (the ones that left `on_hand`). */
function consumedInputs(movements: readonly StockMovement[]): readonly RecipeInput[] {
  return movements
    .filter((m) => m.from === 'on_hand' && m.to === null)
    .map((m) => ({ productId: m.productId, quantityMinor: m.quantityMinor, uom: m.uom }));
}

/** Read caller-supplied ingredient unit costs. Absent costs are zero here; sourcing them from the
 *  catalogue is M11-FR-02 (yield/costing) — recorded honestly rather than guessed. */
function readUnitCosts(raw: unknown, currency: CurrencyCode): Readonly<Record<string, { minor: number; currency: CurrencyCode }>> {
  if (raw === null || typeof raw !== 'object') return {};
  const out: Record<string, { minor: number; currency: CurrencyCode }> = {};
  for (const [productId, minor] of Object.entries(raw as Record<string, unknown>)) {
    if (Number.isInteger(minor) && (minor as number) >= 0) out[productId] = { minor: minor as number, currency };
  }
  return out;
}
