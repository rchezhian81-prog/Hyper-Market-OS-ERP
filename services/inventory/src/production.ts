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
// Batch 2 · FUL-01 (audit HIGH): production MOVES ORDINARY STOCK. A committed run appends, in the SAME atomic write as
// the run record, one `consumed_in_production` M08 movement per ingredient it used up — so every other reader (availability,
// transfers, the till's stock, valuation) sees the flour leave — and the finished batch stays OUT of on-hand (quarantine)
// until quality releases it; the release appends one `produced` movement for the batch at the run's own output unit cost
// (when every ingredient was costed; otherwise it enters unvalued and says so). The ingredients' value moves into the output
// (never cost of goods sold twice). The run's own stream still keeps the evidence (cost, yield, exceptions). A run recorded
// before this change carried no M08 movements; only those runs are still subtracted privately (`priorConsumption`), so old
// evidence and new ledger never count the same flour twice. Append-only (#2); idempotent on the run id.

import type { Route } from '../../kernel/src/index';
import { apiError, featureNotEntitled, concurrentChange } from '../../kernel/src/index';
import { ConcurrencyConflictError } from '../../../packages/persistence/src/event-store';
import type { Movement } from './index';
import { createHash } from 'node:crypto';

/**
 * Batch 2 · FUL-08: a digest over the COMPLETE recipe — every input (product, quantity, unit), the output, shelf life and
 * yield rules — order-independent in its inputs. Two recipes differ exactly when their digests differ; nothing about the
 * recipe can change without the digest changing (the old key carried only the number of inputs, so 100 g → 150 g flour
 * "saved" and changed nothing).
 */
export function recipeDigest(recipe: Recipe): string {
  const canonical = {
    recipeId: recipe.recipeId, departmentId: recipe.departmentId, outputProductId: recipe.outputProductId,
    outputQuantityMinor: recipe.outputQuantityMinor, outputUom: recipe.outputUom, shelfLifeHours: recipe.shelfLifeHours,
    expectedYieldBp: recipe.expectedYieldBp ?? null, yieldToleranceBp: recipe.yieldToleranceBp ?? null,
    inputs: [...recipe.inputs].map((i) => [i.productId, i.quantityMinor, i.uom] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1])),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32);
}

/** Batch 2 · FUL-08: what registering a recipe did — the version now current and whether it changed anything. */
export interface RecipeRegistration {
  readonly version: number;
  readonly digest: string;
  readonly changed: boolean;
}
import {
  produceBatch, validateRecipe, InvalidRecipeError, InsufficientMaterialError,
  type Recipe, type RecipeInput, type ProductionException,
} from '../../../packages/production/src/recipe';
import { releaseForSale, buildPackLabel, renderLabel, IncompleteLabelError, type PackLabel } from '../../../packages/production/src/packing';
import {
  requireDepartment, operatedDepartments, DEPARTMENT_CATALOGUE,
  DepartmentNotOperatedError, UnknownDepartmentError,
  requiredFeatureFor, planAllowsDepartment,
} from '../../../packages/production/src/departments';
import type { StockMovement } from '../../../packages/stock/src/position';
import { isCurrencyCode, money, type CurrencyCode, type Money } from '../../../packages/contracts/src/money';

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
  /** True when every ingredient had a registered cost — the cost/margin is then authoritative. */
  readonly costKnown: boolean;
  /** Ingredients with no registered cost — their value is NOT faked as zero (P-08). */
  readonly uncostedProducts: readonly string[];
  readonly yieldBp: number;
  readonly yieldVerdict: string;
  readonly exceptions: readonly ProductionException[];
  /** What this run consumed — layered onto M08 so the next run sees depleted ingredients. */
  readonly consumed: readonly RecipeInput[];
  /** Batch 2 · FUL-08: the digest of the exact recipe version this run was made to (absent on older runs). */
  readonly recipeDigest?: string;
  readonly producedBy: string;
  readonly at: string;
  /** Batch 2 · FUL-01: the M08 movements this run posted for its ingredients — absent on a run recorded before production
   *  moved ordinary stock (its consumption is then only on this stream and is still subtracted privately). */
  readonly ledgerMovementIds?: readonly string[];
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
  /** Batch 2 · FUL-01: the `produced` M08 movement the release posted (absent on a release recorded before). */
  readonly ledgerMovementIds?: readonly string[];
}

export interface ProductionDeps {
  /** The registered recipe, or nothing when the box has never been told it. */
  readonly recipe: (tenantId: string, recipeId: string) => Promise<Recipe | undefined> | Recipe | undefined;
  /** Record a recipe VERSION (FUL-08): a recipe identical to the current one is no new version; any change is the next
   *  version, kept beside the earlier ones (append-only). Returns what it did; a bare stub may return nothing. */
  readonly recordRecipe: (tenantId: string, recipe: Recipe) => Promise<RecipeRegistration | void> | RecipeRegistration | void;
  /** The registered ingredient cost per smallest unit (M11-FR-02), or nothing when unknown. */
  readonly ingredientCost: (tenantId: string, productId: string) => Promise<Money | undefined> | Money | undefined;
  readonly recordCost: (tenantId: string, productId: string, cost: Money) => Promise<void> | void;
  /** Authoritative M08 on-hand for (product, location) — the base a run is checked against. */
  readonly onHand: (tenantId: string, productId: string, locationId: string) => Promise<number> | number;
  /** What prior production runs at a location have already consumed, per product. */
  /** What prior runs at a location consumed that is NOT on the M08 ledger (runs recorded before FUL-01), per product. */
  readonly priorConsumption: (tenantId: string, locationId: string) => Promise<Readonly<Record<string, number>>> | Readonly<Record<string, number>>;
  readonly runExists: (tenantId: string, runId: string) => Promise<boolean> | boolean;
  readonly runs: (tenantId: string) => Promise<readonly StoredRun[]> | readonly StoredRun[];
  /** One run with its release state merged, or nothing. */
  readonly run: (tenantId: string, runId: string) => Promise<StoredRun | undefined> | StoredRun | undefined;
  /** The run record and its ingredients' `consumed_in_production` movements — ONE atomic write (FUL-01). With the location's
   *  stock guard read before the stock the run was judged on, two runs cannot both use the same flour. */
  readonly recordRun: (tenantId: string, run: StoredRun, movements: readonly Movement[], expectedStockVersion?: number) => Promise<void> | void;
  /** The release record and the finished batch's `produced` movement — ONE atomic write (FUL-01). */
  readonly recordRelease: (tenantId: string, release: StoredRelease, movements: readonly Movement[]) => Promise<void> | void;
  /** The location's stock guard (SF-04's key) — optional; a bare stub runs unguarded. */
  readonly stockVersion?: (tenantId: string, locationId: string) => Promise<number> | number;
  /** The production departments this tenant has switched on (M11-FR-04). */
  readonly enabledDepartments: (tenantId: string) => Promise<readonly string[]> | readonly string[];
  readonly recordDepartmentEnabled: (tenantId: string, departmentId: string) => Promise<void> | void;
  /** The paid-plan features this tenant has enabled (M36-FR-01) — gates the specialised departments. */
  readonly entitledFeatures: (tenantId: string) => Promise<readonly string[]> | readonly string[];
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
        const registered = await deps.recordRecipe(ctx.tenantId, recipe);
        return {
          status: 201,
          body: {
            recipeId, outputProductId: recipe.outputProductId, digest: recipeDigest(recipe),
            ...(registered === undefined ? {} : { version: registered.version, changed: registered.changed }),
          },
        };
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
          locationId?: unknown; currency?: unknown;
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

        // The store's PLAN must include this department (M36-FR-01), and the store must actually operate it
        // (M11-FR-04 / §2.2) — you cannot produce for a meat counter you did not buy, nor for one you have
        // not switched on; the compliance obligations that come with it would apply to a department that
        // does not exist. Plan first, so a shop without the module hears "your plan", not "not operated".
        await requirePlanForDepartment(deps, ctx.tenantId, recipe.departmentId);
        const departmentRefusal = refuseDepartment(recipe.departmentId, await deps.enabledDepartments(ctx.tenantId));
        if (departmentRefusal !== null) throw departmentRefusal;

        const currency = (b.currency as CurrencyCode) ?? 'INR';
        const at = deps.now();
        // The location's stock guard first, then the stock it protects (FUL-01 · SF-04's pattern).
        const stockVersion = deps.stockVersion === undefined ? undefined : await deps.stockVersion(ctx.tenantId, b.locationId);
        // Available = the authoritative M08 on-hand for each ingredient (which now carries every FUL-01 run's consumption),
        // MINUS what runs recorded before FUL-01 consumed privately, so no flour is counted twice.
        const prior = await deps.priorConsumption(ctx.tenantId, b.locationId);
        const available: Record<string, number> = {};
        for (const input of recipe.inputs) {
          const base = await deps.onHand(ctx.tenantId, input.productId, b.locationId);
          available[input.productId] = base - (prior[input.productId] ?? 0);
        }
        // Ingredient costs come from the registered cost register (M11-FR-02), never the request —
        // a run cannot value its own margin. An ingredient with no registered cost is NOT costed at
        // zero (that reports a 100% margin, a lie that reads as good news); it is listed as uncosted
        // and the run's cost is marked not-authoritative, while the physical run still proceeds (a
        // missing cost must not stop the cafe making coffee).
        const unitCosts: Record<string, Money> = {};
        const uncostedProducts: string[] = [];
        for (const input of recipe.inputs) {
          const cost = await deps.ingredientCost(ctx.tenantId, input.productId);
          if (cost === undefined) uncostedProducts.push(input.productId);
          else unitCosts[input.productId] = cost;
        }
        const costKnown = uncostedProducts.length === 0;

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
          costKnown, uncostedProducts,
          yieldBp: result.yieldBp, yieldVerdict: result.yieldVerdict, exceptions: result.exceptions,
          consumed, recipeDigest: recipeDigest(recipe), producedBy: ctx.userId, at,
        };
        // FUL-01: the ingredients leave ordinary stock in the SAME write as the run record.
        const movements: Movement[] = consumed.map((c, i): Movement => ({
          movementId: `prod-run:${runId}:in-${i + 1}`, productId: c.productId, locationId: b.locationId as string, kind: 'consumed_in_production',
          quantityMinor: c.quantityMinor, uom: c.uom, occurredAt: at, enteredBy: ctx.userId,
          reason: `production run ${runId} (${recipe.recipeId}) → ${result.outputQuantityMinor} ${recipe.outputUom} of ${result.outputProductId} batch ${result.outputBatchId}`,
        }));
        try {
          await deps.recordRun(ctx.tenantId, { ...run, ledgerMovementIds: movements.map((m) => m.movementId) }, movements, stockVersion);
        } catch (e) {
          if (e instanceof ConcurrencyConflictError) throw concurrentChange(`the stock at ${b.locationId}`);
          throw e;
        }
        return {
          status: 201,
          body: {
            runId, outputProductId: run.outputProductId, outputBatchId: run.outputBatchId,
            outputQuantityMinor: run.outputQuantityMinor, expiresAt: run.expiresAt,
            inputCostMinor: run.inputCostMinor, outputUnitCostMinor: run.outputUnitCostMinor,
            costKnown: run.costKnown, uncostedProducts: run.uncostedProducts,
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
        // FUL-01: the released batch becomes ORDINARY on-hand stock — batch and expiry carried — at the run's own output unit
        // cost when every ingredient was costed; otherwise it enters unvalued (said on the valuation read, never priced at 0).
        const produced: Movement = {
          movementId: `prod-run:${runId}:out`, productId: run.outputProductId, locationId: run.locationId, kind: 'produced',
          quantityMinor: run.outputQuantityMinor, uom: run.outputUom, occurredAt: at, enteredBy: ctx.userId,
          batchId: run.outputBatchId, expiry: run.expiresAt.slice(0, 10),
          reason: `production run ${runId} batch ${run.outputBatchId} released by ${ctx.userId}`,
          ...(run.costKnown ? { unitCostMinor: run.outputUnitCostMinor } : {}),
        };
        await deps.recordRelease(ctx.tenantId, { runId, batchId: run.outputBatchId, releasedBy: ctx.userId, quantityMinor: run.outputQuantityMinor, releasedAt: at, ledgerMovementIds: [produced.movementId] }, [produced]);
        return { status: 200, body: { runId, batchId: run.outputBatchId, released: true, releasedBy: ctx.userId, releasedAt: at, movements: result.movements } };
      },
    },
    {
      // Register an ingredient's cost (M11-FR-02) — what production values a smallest unit of it at.
      // Production reads this, never a per-run figure, so a batch cannot value its own margin.
      api: 'API-04', method: 'POST', path: '/v1/production/costs/:productId',
      permission: 'production.recipe.manage', idempotent: true,
      handler: async (ctx) => {
        const productId = ctx.params['productId'] ?? '';
        const b = (ctx.body ?? {}) as { unitCostMinor?: unknown; currency?: unknown };
        if (!isStr(productId) || !isNonNegInt(b.unitCostMinor) || (b.currency !== undefined && !isCurrencyCode(b.currency as string))) {
          throw apiError(400, {
            code: 'not_readable_as_a_cost',
            whatHappened: 'A cost needs a whole unitCostMinor (per smallest unit).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { unitCostMinor, currency }. Nothing was changed.',
          });
        }
        await deps.recordCost(ctx.tenantId, productId, money(b.unitCostMinor, (b.currency as CurrencyCode) ?? 'INR'));
        return { status: 201, body: { productId, unitCostMinor: b.unitCostMinor } };
      },
    },
    {
      // Enable a production department for this store (M11-FR-04). Every department the product
      // supports is BUILT (OB-05); a tenant switches on only its own. SRE enables the cafe (OB-04).
      api: 'API-04', method: 'POST', path: '/v1/production/departments/:departmentId',
      permission: 'production.recipe.manage', idempotent: true,
      handler: async (ctx) => {
        const departmentId = ctx.params['departmentId'] ?? '';
        if (!isStr(departmentId) || DEPARTMENT_CATALOGUE[departmentId] === undefined) {
          throw apiError(400, {
            code: 'unknown_department',
            whatHappened: `"${departmentId}" is not a production department this product runs. It runs: ${Object.keys(DEPARTMENT_CATALOGUE).join(', ')}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Enable one of the departments the product supports. Nothing was changed.',
          });
        }
        // A specialised department is a paid feature (M36-FR-01) — a shop can only switch on one its plan
        // includes. Blocking here (rather than silently recording an event that never takes effect) keeps
        // the failure visible (P-08): the shop hears "your plan does not include this", not nothing.
        await requirePlanForDepartment(deps, ctx.tenantId, departmentId);
        await deps.recordDepartmentEnabled(ctx.tenantId, departmentId);
        return { status: 201, body: { departmentId, department: DEPARTMENT_CATALOGUE[departmentId] } };
      },
    },
    {
      // The departments this store operates, and (for reference) every department the product supports.
      api: 'API-04', method: 'GET', path: '/v1/production/departments',
      permission: 'production.read',
      handler: async (ctx) => {
        const enabled = await deps.enabledDepartments(ctx.tenantId);
        const features = await deps.entitledFeatures(ctx.tenantId);
        // Report only departments the plan still covers (M36-FR-01): a department switched on while its
        // module was in the plan but since dropped is no longer operable, so it is not listed as operated.
        const operated = operatedDepartments(enabled).filter((d) => planAllowsDepartment(d.departmentId, features));
        return { status: 200, body: { operated, available: Object.keys(DEPARTMENT_CATALOGUE) } };
      },
    },
    {
      // Issue a pack / scale label for a run's finished batch (M11-FR-03/04). Legal Metrology and
      // food-safety fields are mandatory PER THE DEPARTMENT — an incomplete label is refused before it
      // prints, because a wrong label is a legal problem, not a printing one (§9.3).
      api: 'API-04', method: 'POST', path: '/v1/production/runs/:runId/label',
      permission: 'production.recipe.manage', idempotent: true,
      handler: async (ctx) => {
        const runId = ctx.params['runId'] ?? '';
        const b = (ctx.body ?? {}) as {
          productName?: unknown; netQuantity?: unknown; packerDetails?: unknown; priceMinor?: unknown;
          currency?: unknown; weightMinor?: unknown; allergens?: unknown; barcode?: unknown;
        };
        if (!isStr(runId) || !isStr(b.productName) || !isNonNegInt(b.priceMinor)
          || (b.currency !== undefined && !isCurrencyCode(b.currency as string))
          || (b.netQuantity !== undefined && typeof b.netQuantity !== 'string')
          || (b.packerDetails !== undefined && typeof b.packerDetails !== 'string')
          || (b.weightMinor !== undefined && !isNonNegInt(b.weightMinor))
          || (b.allergens !== undefined && !(Array.isArray(b.allergens) && b.allergens.every((a) => typeof a === 'string')))
          || (b.barcode !== undefined && typeof b.barcode !== 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_a_label',
            whatHappened: 'A label needs at least a productName and a whole priceMinor.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the label fields. Nothing was printed.',
          });
        }
        const run = await deps.run(ctx.tenantId, runId);
        if (run === undefined) {
          throw apiError(404, { code: 'run_not_found', whatHappened: `No production run "${runId}".`, wasItSaved: 'not_saved', nextSafeAction: 'Commit the run first.' });
        }
        await requirePlanForDepartment(deps, ctx.tenantId, run.departmentId);
        const enabled = await deps.enabledDepartments(ctx.tenantId);
        const departmentRefusal = refuseDepartment(run.departmentId, enabled);
        if (departmentRefusal !== null) throw departmentRefusal;
        const department = requireDepartment(run.departmentId, enabled);

        const label: PackLabel = {
          productId: run.outputProductId, productName: b.productName, batchId: run.outputBatchId,
          netQuantity: isStr(b.netQuantity) ? b.netQuantity : '',
          packerDetails: isStr(b.packerDetails) ? b.packerDetails : '',
          useBy: run.expiresAt, price: { minor: b.priceMinor, currency: (b.currency as CurrencyCode) ?? 'INR' },
          ...(b.weightMinor === undefined ? {} : { weightMinor: b.weightMinor }),
          ...(b.barcode === undefined ? {} : { barcode: b.barcode as string }),
          ...(b.allergens === undefined ? {} : { allergens: b.allergens as readonly string[] }),
          producedAt: run.at,
        };
        try {
          buildPackLabel(label, department);
        } catch (e) {
          if (e instanceof IncompleteLabelError) {
            throw apiError(422, { code: 'incomplete_label', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Add the missing field and re-send. Nothing was printed.' });
          }
          throw e;
        }
        return { status: 200, body: { runId, batchId: run.outputBatchId, lines: renderLabel(label) } };
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

/** Refuse producing/labelling for a department the tenant does not operate, as an `apiError` or null. */
function refuseDepartment(departmentId: string, enabled: readonly string[]): ReturnType<typeof apiError> | null {
  try {
    requireDepartment(departmentId, enabled);
    return null;
  } catch (e) {
    if (e instanceof DepartmentNotOperatedError) {
      return apiError(422, { code: 'department_not_operated', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Enable the department first, or use a recipe for a department the store operates. Nothing was recorded.' });
    }
    if (e instanceof UnknownDepartmentError) {
      return apiError(400, { code: 'unknown_department', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Use a department the product supports. Nothing was recorded.' });
    }
    throw e;
  }
}

/**
 * Refuse a specialised department the tenant's PLAN does not include (M36-FR-01 · §35). A department
 * with no required feature (the cafe; the central kitchen for now) always passes. Default-deny: a gated
 * department is off for a plan that has not enabled its feature, so a shop that never bought the bakery
 * module cannot switch it on, produce for it, or label its output — even a full owner. Throws the shared
 * `feature_not_entitled` (403) the concession and B2B gates use, so every paywall refusal reads alike.
 */
async function requirePlanForDepartment(deps: ProductionDeps, tenantId: string, departmentId: string): Promise<void> {
  const feature = requiredFeatureFor(departmentId);
  if (feature === undefined) return;
  const features = await deps.entitledFeatures(tenantId);
  if (!features.includes(feature)) throw featureNotEntitled(feature);
}

/** The consumed ingredients of a run, from its ledger movements (the ones that left `on_hand`). */
function consumedInputs(movements: readonly StockMovement[]): readonly RecipeInput[] {
  return movements
    .filter((m) => m.from === 'on_hand' && m.to === null)
    .map((m) => ({ productId: m.productId, quantityMinor: m.quantityMinor, uom: m.uom }));
}

