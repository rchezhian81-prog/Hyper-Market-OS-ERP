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
  produceBatch, validateRecipe, planProduction, InvalidRecipeError, InsufficientMaterialError,
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
import { valueAtUnitCost, minorPerUnitOf } from '../../../packages/contracts/src/quantity';
import { assertLocationInScope, locationInScope, type LocationBranches } from './location-scope';
import type { AuditEntry } from '../../../packages/audit/src/index';

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
  /**
   * OB-68 "A" (owner, 11 Oct 2026, "Production run's cost"): what the run's output is worth — the ingredients it consumed,
   * each at head office's OB-39 average buying cost at the store at the time of the run (the registered production cost
   * only where head office holds no average), per whole unit of output. `valued: false` names the ingredients with no
   * cost: the output then enters stock "not valued" by name — never at zero. Absent on runs recorded before OB-68.
   */
  readonly runCost?: RunCost;
  /**
   * D-25 (R3): which ingredient BATCHES went into this run — the prep-batch traceability a recall of an ingredient walks
   * (input batch → this output batch → its sales). `captured` when the person named the batch; `fefo_assigned` when head
   * office assigned the earliest-expiry batch on hand (OB-35's rule); `not_known` (batchId null) when no batch was on
   * hand to name — said, never guessed. Absent on runs recorded before D-25.
   */
  readonly inputBatches?: readonly RunInputBatch[];
  /** D-25: the production plan line this run was committed from, when a person committed it from a plan. */
  readonly planRef?: string | null;
  /** Quality-release state, set by the adapter's fold of release events (M11-FR-03). */
  readonly released?: boolean;
  readonly releasedBy?: string | null;
  readonly releasedAt?: string | null;
  /** OB-288 lane 2 · P2: a run captured at the store with the line down and RELAYED by the store computer — who carried it. */
  readonly relayed?: RunRelay;
  /** What head office found about a relayed run's producer and stock — said on the record, never hidden. */
  readonly syncFlags?: readonly RunSyncFlag[];
  /** A relayed run's own figures, so a re-sent run is judged the same run (and a different one a conflict). */
  readonly batches?: number;
  readonly actualOutputMinor?: number;
  /** A relayed run made with more of an ingredient than head office's books held — by ingredient, never hidden. */
  readonly shortAtHeadOffice?: readonly { readonly productId: string; readonly shortMinor: number; readonly uom: string }[];
}

/** D-25: one ingredient batch consumed by a run. */
export interface RunInputBatch {
  readonly productId: string;
  readonly batchId: string | null;
  readonly quantityMinor: number;
  readonly uom: string;
  readonly source: 'captured' | 'fefo_assigned' | 'not_known';
}

/** D-25: an ingredient batch on hand at a place (earliest expiry first), for assigning a run's consumption to batches. */
export interface IngredientBatchOnHand { readonly batchId: string | null; readonly onHandMinor: number; readonly expiry?: string }

/**
 * D-25 (pure): split each consumed ingredient across batches — the batches the person named (each must be on hand in that
 * quantity, and they must add up to what the run uses), else earliest expiry first; whatever no batch covers is `not_known`.
 */
export function assignInputBatches(
  consumed: readonly RecipeInput[],
  named: readonly { readonly productId: string; readonly batchId: string; readonly quantityMinor: number }[],
  onHand: (productId: string) => readonly IngredientBatchOnHand[] | undefined,
): { readonly ok: true; readonly batches: readonly RunInputBatch[] } | { readonly ok: false; readonly code: string; readonly detail: string } {
  const out: RunInputBatch[] = [];
  for (const c of consumed) {
    const mine = named.filter((n) => n.productId === c.productId);
    const held = onHand(c.productId);
    if (mine.length > 0) {
      const total = mine.reduce((n, m) => n + m.quantityMinor, 0);
      if (total !== c.quantityMinor) return { ok: false, code: 'input_batches_do_not_add_up', detail: `The batches named for ${c.productId} add up to ${total} ${c.uom}, but the run uses ${c.quantityMinor}.` };
      for (const m of mine) {
        const b = held?.find((h) => h.batchId === m.batchId);
        if (held !== undefined && (b === undefined || b.onHandMinor < m.quantityMinor)) {
          return { ok: false, code: 'input_batch_not_on_hand', detail: `Batch ${m.batchId} of ${c.productId} does not have ${m.quantityMinor} ${c.uom} on hand here (${b?.onHandMinor ?? 0}).` };
        }
        out.push({ productId: c.productId, batchId: m.batchId, quantityMinor: m.quantityMinor, uom: c.uom, source: 'captured' });
      }
      continue;
    }
    let left = c.quantityMinor;
    for (const b of held ?? []) {
      if (left === 0) break;
      if (b.onHandMinor <= 0 || b.batchId === null) continue;
      const take = Math.min(left, b.onHandMinor);
      out.push({ productId: c.productId, batchId: b.batchId, quantityMinor: take, uom: c.uom, source: 'fefo_assigned' });
      left -= take;
    }
    if (left > 0) out.push({ productId: c.productId, batchId: null, quantityMinor: left, uom: c.uom, source: 'not_known' });
  }
  return { ok: true, batches: out };
}

/** OB-68: one consumed ingredient's cost on the run. */
export interface RunCostLine {
  readonly productId: string;
  readonly quantityMinor: number;
  readonly uom: string;
  /** Per WHOLE unit for `average_buying_cost`; per smallest unit for `registered_cost`; null when there is none. */
  readonly unitCostMinor: number | null;
  readonly source: 'average_buying_cost' | 'registered_cost' | 'none';
  readonly valueMinor: number | null;
}

/** OB-68: the run's own unit cost — the ingredients consumed, valued once. */
export interface RunCost {
  readonly valued: boolean;
  readonly inputCostMinor: number | null;
  /** The output's cost per WHOLE unit of its unit of measure (what the `produced` movement is valued at), or null. */
  readonly unitCostPerWholeMinor: number | null;
  readonly lines: readonly RunCostLine[];
  /** The ingredients with no cost at all — named, never valued at zero. */
  readonly notValuedBecause: readonly string[];
}

/**
 * OB-68 (pure): value a run's consumed ingredients — each at the OB-39 average (per whole unit, rounded once per line, OB-31),
 * else the registered production cost (per smallest unit), else not valued (named).
 */
export function runCostOf(consumed: readonly RecipeInput[], averageOf: (productId: string) => number | undefined, registeredOf: (productId: string) => Money | undefined, outputQuantityMinor: number, outputUom: string): RunCost {
  const lines: RunCostLine[] = consumed.map((c): RunCostLine => {
    const avg = averageOf(c.productId);
    if (avg !== undefined) return { productId: c.productId, quantityMinor: c.quantityMinor, uom: c.uom, unitCostMinor: avg, source: 'average_buying_cost', valueMinor: valueAtUnitCost(c.quantityMinor, c.uom, avg) };
    const reg = registeredOf(c.productId);
    if (reg !== undefined) return { productId: c.productId, quantityMinor: c.quantityMinor, uom: c.uom, unitCostMinor: reg.minor, source: 'registered_cost', valueMinor: reg.minor * c.quantityMinor };
    return { productId: c.productId, quantityMinor: c.quantityMinor, uom: c.uom, unitCostMinor: null, source: 'none', valueMinor: null };
  });
  const notValuedBecause = lines.filter((l) => l.valueMinor === null).map((l) => l.productId);
  const valued = notValuedBecause.length === 0 && outputQuantityMinor > 0;
  const inputCostMinor = notValuedBecause.length === 0 ? lines.reduce((n, l) => n + (l.valueMinor ?? 0), 0) : null;
  const unitCostPerWholeMinor = valued && inputCostMinor !== null ? Math.round((inputCostMinor * minorPerUnitOf(outputUom)) / outputQuantityMinor) : null;
  return { valued, inputCostMinor, unitCostPerWholeMinor, lines, notValuedBecause };
}

/**
 * OB-68: the cost the `produced` movement carries. Counted output (each): the run's whole input cost for the whole batch
 * (`unitCostPer` = the units made, OB-46) — the value that left the ingredients is exactly the value the output brings in,
 * nothing lost to rounding. Weighed output: per whole unit (kg / l), rounded once.
 */
export function producedCostOf(cost: RunCost, outputQuantityMinor: number, outputUom: string): { unitCostMinor: number; unitCostPer?: number } | undefined {
  if (!cost.valued || cost.inputCostMinor === null || cost.unitCostPerWholeMinor === null) return undefined;
  if (minorPerUnitOf(outputUom) === 1 && outputQuantityMinor > 1) return { unitCostMinor: cost.inputCostMinor, unitCostPer: outputQuantityMinor };
  return { unitCostMinor: cost.unitCostPerWholeMinor };
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
  /** PA-01-r1: which branch a stock location belongs to — a run moves stock there, so it is the caller's branch business. */
  readonly locationBranches?: LocationBranches;
  /** OB-288 lane 2: every registered recipe (latest version each) — the read the production screen and the store computer use. */
  readonly recipes?: (tenantId: string) => Promise<readonly Recipe[]> | readonly Recipe[];
  /** The registered recipe, or nothing when the box has never been told it. */
  readonly recipe: (tenantId: string, recipeId: string) => Promise<Recipe | undefined> | Recipe | undefined;
  /** Record a recipe VERSION (FUL-08): a recipe identical to the current one is no new version; any change is the next
   *  version, kept beside the earlier ones (append-only). Returns what it did; a bare stub may return nothing. */
  readonly recordRecipe: (tenantId: string, recipe: Recipe) => Promise<RecipeRegistration | void> | RecipeRegistration | void;
  /**
   * OB-68 / OB-39: head office's average buying cost per WHOLE unit of a product at the store a location belongs to, as it
   * stands now (the time of the run), or undefined. Optional: a bare stub values runs from the registered cost alone.
   */
  readonly averageCostAt?: (tenantId: string, locationId: string, productId: string) => Promise<number | undefined> | number | undefined;
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
  /** D-25: the ingredient batches on hand at a place for a product, earliest expiry first. Optional on a bare stub (then each
   *  run's input batches are recorded as `not_known`). */
  readonly ingredientBatchesAt?: (tenantId: string, locationId: string, productId: string) => Promise<readonly IngredientBatchOnHand[]> | readonly IngredientBatchOnHand[];
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
          locationId?: unknown; currency?: unknown; inputBatches?: unknown; planRef?: unknown;
        };
        // D-25: the ingredient batches the person named (optional; otherwise head office assigns earliest expiry first).
        const namedBatches = b.inputBatches === undefined ? [] : Array.isArray(b.inputBatches) && b.inputBatches.every((x) => x !== null && typeof x === 'object' && isStr((x as Record<string, unknown>)['productId']) && isStr((x as Record<string, unknown>)['batchId']) && isPosInt((x as Record<string, unknown>)['quantityMinor']))
          ? (b.inputBatches as { productId: string; batchId: string; quantityMinor: number }[]) : null;
        if (namedBatches === null) {
          throw apiError(400, { code: 'not_readable_as_input_batches', whatHappened: 'inputBatches must be a list of { productId, batchId, quantityMinor }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the batches as named on the ingredients, or leave them out for earliest expiry first. Nothing was recorded.' });
        }
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
        await assertLocationInScope(ctx, b.locationId, deps.locationBranches); // PA-01-r1
        if (await deps.runExists(ctx.tenantId, runId)) {
          throw apiError(409, {
            code: 'run_already_committed',
            whatHappened: `Run ${runId} has already been committed — a run id is used once.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Use a new run id. Nothing was changed.',
          });
        }
        const { body } = await commitRunCore(deps, ctx.tenantId, {
          runId, recipeId: b.recipeId, batches: b.batches, actualOutputMinor: b.actualOutputMinor, outputBatchId: b.outputBatchId,
          locationId: b.locationId, currency: (b.currency as CurrencyCode) ?? 'INR', namedBatches, planRef: isStr(b.planRef) ? b.planRef : null,
        }, ctx.userId, deps.now(), { onShortfall: 'refuse' });
        return { status: 201, body };
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
        await assertLocationInScope(ctx, run.locationId, deps.locationBranches); // PA-01-r1
        if (run.released === true) {
          throw apiError(409, { code: 'batch_already_released', whatHappened: `Run ${runId}'s batch has already been released.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed — the batch is already sellable.' });
        }
        return { status: 200, body: await releaseRunCore(deps, ctx.tenantId, run, ctx.userId, b.qcPassed, isStr(b.notes) ? b.notes : undefined, deps.now()) };
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
        if (isStr(locationId)) await assertLocationInScope(ctx, locationId, deps.locationBranches); // PA-01-r1
        const visible: (typeof all)[number][] = [];
        for (const r of all) if (await locationInScope(ctx, r.locationId, deps.locationBranches)) visible.push(r);
        const runs = isStr(locationId) ? visible.filter((r) => r.locationId === locationId) : visible;
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


// ── OB-288 lane 2 · P2: one commit for a run, whoever carries it ─────────────────────────────────────────────────────

/** What a person captured about a run (the direct route's body, or the store computer's relayed record). */
export interface RunCapture {
  readonly runId: string;
  readonly recipeId: string;
  readonly batches: number;
  readonly actualOutputMinor: number;
  readonly outputBatchId: string;
  readonly locationId: string;
  readonly currency: CurrencyCode;
  readonly namedBatches: readonly { readonly productId: string; readonly batchId: string; readonly quantityMinor: number }[];
  readonly planRef: string | null;
}

/** What head office found about a RELAYED run — flagged on the record, never a silent trust (hard rule #10). */
export const RUN_SYNC_FLAGS = Object.freeze([
  'producer_unknown', 'producer_lacks_authority',
  // The kitchen used more of an ingredient than head office's books say it had: the food exists, so the run is recorded and
  // its ingredients leave the books (they may go below zero, where the stock exceptions read shows them) — and it is said.
  'ingredient_short_at_head_office',
] as const);
export type RunSyncFlag = (typeof RUN_SYNC_FLAGS)[number];

/** Who relayed a run, and from which surface — recorded BESIDE the producer, never as them. */
export interface RunRelay { readonly relayedBy: string; readonly source: string; readonly storeId: string | null }

export interface RunCommitOptions {
  /** The direct route refuses a short run before anything is consumed; a relayed run happened, so it is recorded and flagged. */
  readonly onShortfall: 'refuse' | 'record_and_flag';
  readonly syncFlags?: readonly RunSyncFlag[];
  readonly relayed?: RunRelay;
}

/**
 * Commit one production run (M11-FR-01/02): the recipe and its department, head office's own stock and costs, the tested
 * `produceBatch` engine, the input batches, the run's own cost, and the run record with its ingredients'
 * `consumed_in_production` movements in ONE write under the location's stock guard. Shared by the direct route (the signed-in
 * producer, head office's clock) and the synced route (the producer the store computer verified, the time it was made).
 */
export async function commitRunCore(
  deps: ProductionDeps, tenantId: string, c: RunCapture, producedBy: string, at: string, opts: RunCommitOptions,
): Promise<{ readonly run: StoredRun; readonly body: Record<string, unknown> }> {
  const { runId } = c;
  const recipe = await deps.recipe(tenantId, c.recipeId);
  if (recipe === undefined) {
    throw apiError(404, {
      code: 'recipe_not_found',
      whatHappened: `No recipe "${c.recipeId}" is registered — a run must reference one.`,
      wasItSaved: 'not_saved',
      nextSafeAction: 'Register the recipe first, then commit the run.',
    });
  }

  // The store's PLAN must include this department (M36-FR-01), and the store must actually operate it
  // (M11-FR-04 / §2.2) — you cannot produce for a meat counter you did not buy, nor for one you have
  // not switched on; the compliance obligations that come with it would apply to a department that
  // does not exist. Plan first, so a shop without the module hears "your plan", not "not operated".
  await requirePlanForDepartment(deps, tenantId, recipe.departmentId);
  const departmentRefusal = refuseDepartment(recipe.departmentId, await deps.enabledDepartments(tenantId));
  if (departmentRefusal !== null) throw departmentRefusal;

  const currency = c.currency;
  // The location's stock guard first, then the stock it protects (FUL-01 · SF-04's pattern).
  const stockVersion = deps.stockVersion === undefined ? undefined : await deps.stockVersion(tenantId, c.locationId);
  // Available = the authoritative M08 on-hand for each ingredient (which now carries every FUL-01 run's consumption),
  // MINUS what runs recorded before FUL-01 consumed privately, so no flour is counted twice.
  const prior = await deps.priorConsumption(tenantId, c.locationId);
  const available: Record<string, number> = {};
  for (const input of recipe.inputs) {
    const base = await deps.onHand(tenantId, input.productId, c.locationId);
    available[input.productId] = base - (prior[input.productId] ?? 0);
  }
  // Ingredient costs come from the registered cost register (M11-FR-02), never the request —
  // a run cannot value its own margin. An ingredient with no registered cost is NOT costed at
  // zero (that reports a 100% margin, a lie that reads as good news); it is listed as uncosted
  // and the run's cost is marked not-authoritative, while the physical run still proceeds (a
  // missing cost must not stop the cafe making coffee).
  const unitCosts: Record<string, Money> = {};
  for (const input of recipe.inputs) {
    const cost = await deps.ingredientCost(tenantId, input.productId);
    if (cost !== undefined) unitCosts[input.productId] = cost;
  }

  const flags: RunSyncFlag[] = [...(opts.syncFlags ?? [])];
  const shortAtHeadOffice: { productId: string; shortMinor: number; uom: string }[] = [];
  const produce = (stock: Readonly<Record<string, number>>) => produceBatch({
    run: { runId, recipe, batches: c.batches, locationId: c.locationId, producedBy, at, outputBatchId: c.outputBatchId, actualOutputMinor: c.actualOutputMinor },
    available: stock, unitCosts, currency,
  });
  let result;
  try {
    result = produce(available);
  } catch (e) {
    if (e instanceof InsufficientMaterialError && opts.onShortfall === 'record_and_flag') {
      // The run happened at the store: what head office's books lack is said, by ingredient, and the run is recorded.
      const enough: Record<string, number> = { ...available };
      for (const need of planProduction(recipe, c.batches).requiredInputs) {
        const have = available[need.productId] ?? 0;
        if (have < need.quantityMinor) {
          shortAtHeadOffice.push({ productId: need.productId, shortMinor: need.quantityMinor - Math.max(0, have), uom: need.uom });
          enough[need.productId] = need.quantityMinor;
        }
      }
      flags.push('ingredient_short_at_head_office');
      result = produce(enough);
    } else if (e instanceof InsufficientMaterialError) {
      throw apiError(422, { code: 'production_short', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Receive or transfer in the short ingredient, then re-send. Nothing was consumed.' });
    } else if (e instanceof InvalidRecipeError) {
      throw apiError(400, { code: 'invalid_recipe', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the recipe and re-send. Nothing was recorded.' });
    } else {
      throw e;
    }
  }

  const consumed = consumedInputs(result.movements);
  // D-25: which ingredient batches the run used — named, else earliest expiry first; uncovered → not known.
  const held: Record<string, readonly IngredientBatchOnHand[]> = {};
  if (deps.ingredientBatchesAt !== undefined) for (const x of consumed) held[x.productId] = await deps.ingredientBatchesAt(tenantId, c.locationId, x.productId);
  const assigned = assignInputBatches(consumed, c.namedBatches, (p) => (deps.ingredientBatchesAt === undefined ? undefined : held[p] ?? []));
  if (!assigned.ok) throw apiError(422, { code: assigned.code, whatHappened: assigned.detail, wasItSaved: 'not_saved', nextSafeAction: 'Name the batches actually used, or leave them out. Nothing was consumed.' });
  // OB-68: the run's own cost — the ingredients it consumed at the OB-39 average at this moment (the registered cost
  // only where head office holds no average); an ingredient with neither is named and the output is not valued.
  const averages: Record<string, number | undefined> = {};
  for (const x of consumed) averages[x.productId] = deps.averageCostAt === undefined ? undefined : await deps.averageCostAt(tenantId, c.locationId, x.productId);
  const runCost = runCostOf(consumed, (p) => averages[p], (p) => unitCosts[p], result.outputQuantityMinor, recipe.outputUom);
  const run: StoredRun = {
    runId, recipeId: recipe.recipeId, departmentId: recipe.departmentId, locationId: c.locationId,
    outputProductId: result.outputProductId, outputBatchId: result.outputBatchId,
    outputQuantityMinor: result.outputQuantityMinor, outputUom: recipe.outputUom, expiresAt: result.expiresAt,
    inputCostMinor: runCost.inputCostMinor ?? result.inputCost.minor,
    outputUnitCostMinor: runCost.inputCostMinor !== null && result.outputQuantityMinor > 0 ? Math.round(runCost.inputCostMinor / result.outputQuantityMinor) : result.outputUnitCost.minor,
    currency, costKnown: runCost.notValuedBecause.length === 0, uncostedProducts: [...runCost.notValuedBecause], runCost,
    yieldBp: result.yieldBp, yieldVerdict: result.yieldVerdict, exceptions: result.exceptions,
    consumed, recipeDigest: recipeDigest(recipe), producedBy, at,
    inputBatches: assigned.batches, planRef: c.planRef,
    ...(opts.relayed === undefined ? {} : { relayed: opts.relayed, syncFlags: flags, batches: c.batches, actualOutputMinor: c.actualOutputMinor }),
    ...(shortAtHeadOffice.length === 0 ? {} : { shortAtHeadOffice }),
  };
  // FUL-01: the ingredients leave ordinary stock in the SAME write as the run record.
  // D-25: one movement per ingredient batch, so the batch's own on-hand falls with it (one truth, SF-03).
  const movements: Movement[] = consumed.flatMap((x, i): Movement[] => assigned.batches.filter((y) => y.productId === x.productId).map((y, j): Movement => ({
    movementId: j === 0 ? `prod-run:${runId}:in-${i + 1}` : `prod-run:${runId}:in-${i + 1}-${j + 1}`, productId: x.productId, locationId: c.locationId, kind: 'consumed_in_production',
    quantityMinor: y.quantityMinor, uom: x.uom, occurredAt: at, enteredBy: producedBy, ...(y.batchId === null ? {} : { batchId: y.batchId }),
    reason: `production run ${runId} (${recipe.recipeId}) → ${result.outputQuantityMinor} ${recipe.outputUom} of ${result.outputProductId} batch ${result.outputBatchId}`,
  })));
  try {
    await deps.recordRun(tenantId, { ...run, ledgerMovementIds: movements.map((m) => m.movementId) }, movements, stockVersion);
  } catch (e) {
    if (e instanceof ConcurrencyConflictError) throw concurrentChange(`the stock at ${c.locationId}`);
    throw e;
  }
  return {
    run,
    body: {
      runId, outputProductId: run.outputProductId, outputBatchId: run.outputBatchId,
      outputQuantityMinor: run.outputQuantityMinor, expiresAt: run.expiresAt,
      inputCostMinor: run.inputCostMinor, outputUnitCostMinor: run.outputUnitCostMinor,
      costKnown: run.costKnown, uncostedProducts: run.uncostedProducts, runCost,
      yieldBp: run.yieldBp, yieldVerdict: run.yieldVerdict, exceptions: run.exceptions,
      inputBatches: run.inputBatches, planRef: run.planRef,
      ...(opts.relayed === undefined ? {} : { flags, relayed: opts.relayed }),
      ...(shortAtHeadOffice.length === 0 ? {} : { shortAtHeadOffice }),
    },
  };
}

/**
 * The quality release itself (M11-FR-03): the engine refuses a failed check, an expired batch or an unnamed releaser; a
 * release appends the batch's `produced` movement in the same write. Shared by the direct and the synced route.
 */
export async function releaseRunCore(deps: ProductionDeps, tenantId: string, run: StoredRun, releasedBy: string, qcPassed: boolean, notes: string | undefined, at: string): Promise<Record<string, unknown>> {
  const runId = run.runId;
  const result = releaseForSale({
    release: { batchId: run.outputBatchId, releasedBy, qcPassed, at, ...(notes === undefined ? {} : { notes }) },
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
    quantityMinor: run.outputQuantityMinor, uom: run.outputUom, occurredAt: at, enteredBy: releasedBy,
    batchId: run.outputBatchId, expiry: run.expiresAt.slice(0, 10),
    reason: `production run ${runId} batch ${run.outputBatchId} released by ${releasedBy}`,
    // OB-68: a run with its own cost carries it (the store's average cost and the month-end valuation read it); a run
    // whose ingredients had no cost carries none — "not valued" by name, never zero. (Pre-OB-68 runs: as recorded.)
    ...(run.runCost !== undefined ? (producedCostOf(run.runCost, run.outputQuantityMinor, run.outputUom) ?? {})
      : run.costKnown ? { unitCostMinor: run.outputUnitCostMinor } : {}),
  };
  await deps.recordRelease(tenantId, { runId, batchId: run.outputBatchId, releasedBy, quantityMinor: run.outputQuantityMinor, releasedAt: at, ledgerMovementIds: [produced.movementId] }, [produced]);
  return { runId, batchId: run.outputBatchId, released: true, releasedBy, releasedAt: at, movements: result.movements };
}

// ── OB-288 lane 2 · P2: production captured at the counter with the line down, relayed by the store computer ─────────
//
// M11-FR-01 "Offline (§31): production capture queue-capable; reconciled on sync" and M11-FR-03 quality release. The
// production screen the store computer serves keeps a run (or a release decision) on its DURABLE device queue before it
// says "saved"; the box holds it on its fsync'd log and relays it here under the store's credential. Head office trusts
// the FACT (who made it, when, how much came out — the run id is the device's own, so a re-sent item is ONE run, §31.1)
// and re-runs every JUDGEMENT on its own records through `commitRunCore` / `releaseRunCore`: the recipe, the department,
// the stock, the costs, the expiry. The PRODUCER is re-verified from their own grants and a breach is FLAGGED on the run,
// never silently trusted; a shortfall on head office's books is recorded and FLAGGED (the food exists). A RELEASE is a
// governance decision, so a releaser without `production.release` is REFUSED by name (the batch stays in quarantine and
// the box shows the refusal), as is a release that conflicts with the one head office already holds. A "hold — check
// failed" decision is recorded in the trail and changes nothing (the batch stays in quarantine).

export interface SyncedProductionDeps extends ProductionDeps {
  readonly permissionsOfUser?: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const isIsoTime = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const asObj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

export function syncedProductionRoutes(deps: SyncedProductionDeps): readonly Route[] {
  const relayOf = (ctx: { readonly userId: string }, b: Record<string, unknown>): RunRelay => ({
    relayedBy: ctx.userId, source: isStr(b['source']) ? b['source'] : 'unknown', storeId: isStr(b['storeId']) ? b['storeId'] : null,
  });
  return [
    {
      // Body: { runId (= path), storeId, recipeId, batches, actualOutputMinor, outputBatchId, locationId, producedBy, at,
      // inputBatches?, planRef?, currency?, source? }. Idempotent per runId: the same run again is 200, one run.
      api: 'API-04', method: 'POST', path: '/v1/production/runs/:runId/synced',
      permission: 'production.sync', idempotent: true,
      handler: async (ctx) => {
        const runId = (ctx.params['runId'] ?? '').trim();
        const b = asObj(ctx.body);
        const named = b['inputBatches'] === undefined ? [] : Array.isArray(b['inputBatches']) && (b['inputBatches'] as unknown[]).every((x) => isStr(asObj(x)['productId']) && isStr(asObj(x)['batchId']) && isPosInt(asObj(x)['quantityMinor']))
          ? (b['inputBatches'] as { productId: string; batchId: string; quantityMinor: number }[]) : null;
        if (runId === '' || b['runId'] !== runId || !isStr(b['recipeId']) || !isPosInt(b['batches']) || !isNonNegInt(b['actualOutputMinor'])
          || !isStr(b['outputBatchId']) || !isStr(b['locationId']) || !isStr(b['producedBy']) || !isIsoTime(b['at']) || named === null
          || (b['currency'] !== undefined && !isCurrencyCode(b['currency'] as string)) || (b['planRef'] !== undefined && b['planRef'] !== null && !isStr(b['planRef']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_relayed_run',
            whatHappened: 'This could not be read as a production run from the store — it needs the runId matching the path, recipeId, whole batches and actualOutputMinor, outputBatchId, locationId, who made it (producedBy) and when (at).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it.',
          });
        }
        const locationId = b['locationId'] as string;
        await assertLocationInScope(ctx, locationId, deps.locationBranches); // only the store's own kitchen
        const producedBy = (b['producedBy'] as string).trim();
        const capture: RunCapture = {
          runId, recipeId: b['recipeId'] as string, batches: b['batches'] as number, actualOutputMinor: b['actualOutputMinor'] as number,
          outputBatchId: b['outputBatchId'] as string, locationId, currency: (b['currency'] as CurrencyCode | undefined) ?? 'INR',
          namedBatches: named, planRef: isStr(b['planRef']) ? b['planRef'] : null,
        };
        const prior = await deps.run(ctx.tenantId, runId);
        if (prior !== undefined) {
          // The same run again — a re-sent queue item — is the same run; a DIFFERENT run under the same id is a conflict.
          const same = prior.recipeId === capture.recipeId && prior.outputBatchId === capture.outputBatchId && prior.locationId === capture.locationId
            && prior.producedBy === producedBy && (prior.batches === undefined || prior.batches === capture.batches)
            && (prior.actualOutputMinor === undefined || prior.actualOutputMinor === capture.actualOutputMinor);
          if (same) return { status: 200, body: { runId, recorded: true, alreadyRecorded: true, flags: prior.syncFlags ?? [], outputBatchId: prior.outputBatchId, expiresAt: prior.expiresAt } };
          throw apiError(422, {
            code: 'run_conflicts_with_record',
            whatHappened: `Head office already holds run ${runId} (${prior.recipeId}, batch ${prior.outputBatchId}, by ${prior.producedBy}); this store's run under the same id says something different. The two cannot both be right.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Kept at the store for a person to compare. Nothing was consumed twice.',
          });
        }
        // The PRODUCER is re-verified from THEIR grants (§28) — flagged, never a silent trust of the relay's word.
        const held = await deps.permissionsOfUser?.(ctx.tenantId, producedBy);
        const flags: RunSyncFlag[] = held === undefined ? ['producer_unknown'] : held.includes('production.plan.commit') ? [] : ['producer_lacks_authority'];
        const relayed = relayOf(ctx, b);
        const at = new Date(Date.parse(b['at'] as string)).toISOString();
        const { run, body } = await commitRunCore(deps, ctx.tenantId, capture, producedBy, at, { onShortfall: 'record_and_flag', syncFlags: flags, relayed });
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: producedBy, action: 'production.run.record', objectType: 'production_run', objectId: runId, at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null, capturedOffline: true },
          before: null,
          after: { recipeId: run.recipeId, outputBatchId: run.outputBatchId, outputQuantityMinor: String(run.outputQuantityMinor), expiresAt: run.expiresAt, relayedBy: ctx.userId, source: relayed.source, flags: (run.syncFlags ?? []).join(',') },
          correlationId: runId,
        });
        return { status: 202, body: { ...body, recorded: true, alreadyRecorded: false } };
      },
    },
    {
      // Body: { runId (= path), storeId, qcPassed, releasedBy, at, notes?, source? }.
      api: 'API-04', method: 'POST', path: '/v1/production/runs/:runId/release/synced',
      permission: 'production.sync', idempotent: true,
      handler: async (ctx) => {
        const runId = (ctx.params['runId'] ?? '').trim();
        const b = asObj(ctx.body);
        if (runId === '' || b['runId'] !== runId || typeof b['qcPassed'] !== 'boolean' || !isStr(b['releasedBy']) || !isIsoTime(b['at'])
          || (b['notes'] !== undefined && typeof b['notes'] !== 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_a_relayed_release',
            whatHappened: 'This could not be read as a release decision from the store — it needs the runId matching the path, qcPassed (true or false), who decided (releasedBy) and when (at).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it.',
          });
        }
        const releasedBy = (b['releasedBy'] as string).trim();
        const qcPassed = b['qcPassed'] as boolean;
        const at = new Date(Date.parse(b['at'] as string)).toISOString();
        const run = await deps.run(ctx.tenantId, runId);
        if (run === undefined) {
          // The run captured on the same screen travels first on the same queue; until it is here, keep the decision and try again.
          throw apiError(425, { code: 'run_not_known_yet', whatHappened: `Head office does not hold run ${runId} yet, so a release of it cannot be booked.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing to do: the store computer keeps the decision and sends it again once the run has arrived.' });
        }
        await assertLocationInScope(ctx, run.locationId, deps.locationBranches);
        if (run.released === true) {
          if (qcPassed && run.releasedBy === releasedBy) return { status: 200, body: { runId, batchId: run.outputBatchId, released: true, releasedBy, alreadyReleased: true } };
          throw apiError(422, {
            code: 'batch_released_by_another',
            whatHappened: `Run ${runId}'s batch was already released for sale by ${run.releasedBy ?? 'someone'}${run.releasedAt === undefined || run.releasedAt === null ? '' : ` at ${run.releasedAt}`}; this store says ${releasedBy} ${qcPassed ? 'released it' : 'held it — check failed'}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Kept at the store for a person to look at: if the check failed, take the batch off sale and record it. Nothing was changed.',
          });
        }
        // A release is a governance decision (§28): a person without the release right is refused — never booked.
        const held = await deps.permissionsOfUser?.(ctx.tenantId, releasedBy);
        if (held === undefined || !held.includes('production.release')) {
          throw apiError(422, {
            code: held === undefined ? 'releaser_unknown_at_head_office' : 'releaser_lacks_authority',
            whatHappened: `${releasedBy} ${held === undefined ? 'is not anyone head office knows' : 'does not hold the quality-release right (production.release)'}, so the batch is not released in their name.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'The batch stays in quarantine. Someone who may release for sale must look at it.',
          });
        }
        const relayed = relayOf(ctx, b);
        const notes = typeof b['notes'] === 'string' && b['notes'].trim() !== '' ? b['notes'] : undefined;
        if (!qcPassed) {
          // A failed check keeps the batch in quarantine — nothing moves; the decision is kept in the sealed trail.
          await deps.recordAudit?.(ctx.tenantId, {
            actorId: releasedBy, action: 'production.release.held', objectType: 'production_run', objectId: runId, at,
            origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null, capturedOffline: true },
            before: null, after: { batchId: run.outputBatchId, qcPassed: 'false', relayedBy: ctx.userId, source: relayed.source },
            ...(notes === undefined ? {} : { reason: notes }), correlationId: runId,
          });
          return { status: 200, body: { runId, batchId: run.outputBatchId, released: false, held: true, decidedBy: releasedBy } };
        }
        const body = await releaseRunCore(deps, ctx.tenantId, run, releasedBy, true, notes, at);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: releasedBy, action: 'production.release', objectType: 'production_run', objectId: runId, at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null, capturedOffline: true },
          before: null, after: { batchId: run.outputBatchId, qcPassed: 'true', relayedBy: ctx.userId, source: relayed.source },
          correlationId: runId,
        });
        return { status: 202, body: { ...body, alreadyReleased: false, relayed } };
      },
    },
    {
      // The registered recipes (M11-FR-01) — what the production screen and the store computer read so a run captured with
      // the line down names a real recipe, and a counter label can carry its use-by. A read; it changes nothing.
      api: 'API-04', method: 'GET', path: '/v1/production/recipes',
      permission: 'production.read',
      handler: async (ctx) => {
        const recipes = deps.recipes === undefined ? [] : await deps.recipes(ctx.tenantId);
        return { status: 200, body: { recipes, enabledDepartments: await deps.enabledDepartments(ctx.tenantId), asAt: deps.now() } };
      },
    },
  ];
}
