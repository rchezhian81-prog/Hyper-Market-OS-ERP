// Recipes, raw-material issue, batch output, yield and cost (M11-FR-01/02).
//
// In-store production is where stock quietly stops adding up. Ingredients leave the
// shelf and something else appears on the counter, and unless both halves are
// recorded as movements the system believes you still have twelve litres of milk
// that were drunk as coffee this morning. So a production run is exactly two things:
//
//     inputs consumed (stock out)  →  a finished batch created (stock in)
//
// Both are movements on the same ledger the till and the goods-in door use
// (`packages/stock`), which is what keeps one stock truth (P-02) instead of a
// production spreadsheet that disagrees with the shelf.
//
// Three rules that hold:
//   • YOU CANNOT ISSUE MORE THAN YOU HAVE. A run that would take an ingredient
//     negative is refused, naming the shortfall, before anything is consumed.
//   • THE OUTPUT LANDS IN QUARANTINE, NOT ON THE SHELF. Freshly produced food is
//     not sellable until someone releases it on quality (M11-FR-03) — and because
//     `packages/stock` treats quarantine as never-sellable, that is enforced by the
//     stock model itself rather than by remembering.
//   • COST FOLLOWS THE FOOD, INCLUDING WHAT IS LOST. Trim, spillage and evaporation
//     do not vanish from the accounts: the cost of the inputs is carried by the
//     output that survived, which is the only way a cafe's real margin is visible.
//
// Pure and deterministic: timestamps and batch ids are injected, there is no clock.

import type { Money } from '../../contracts/src/money';
import type { StockMovement } from '../../stock/src/position';

export interface RecipeInput {
  readonly productId: string;
  /** Quantity per batch, in the UOM's smallest unit. */
  readonly quantityMinor: number;
  readonly uom: string;
}

export interface Recipe {
  readonly recipeId: string;
  readonly departmentId: string;
  readonly outputProductId: string;
  /** What one batch of this recipe yields, in the output UOM's smallest unit. */
  readonly outputQuantityMinor: number;
  readonly outputUom: string;
  readonly inputs: readonly RecipeInput[];
  /** How long the finished item keeps, from production. */
  readonly shelfLifeHours: number;
  /**
   * The output expected from the inputs, in basis points, where a process loses
   * some of what goes in (trim, evaporation, spillage). 10000 = nothing lost.
   */
  readonly expectedYieldBp?: number;
  /** How far yield may drift before it is worth someone's attention. */
  readonly yieldToleranceBp?: number;
}

export class InvalidRecipeError extends Error {
  constructor(
    public readonly recipeId: string,
    reason: string,
  ) {
    super(`Recipe "${recipeId}" is invalid: ${reason}`);
    this.name = 'InvalidRecipeError';
  }
}

export class InsufficientMaterialError extends Error {
  constructor(
    public readonly productId: string,
    public readonly shortfallMinor: number,
    public readonly uom: string,
  ) {
    super(
      `Not enough ${productId}: ${shortfallMinor} ${uom} short — nothing has been issued, so the shelf still matches the system`,
    );
    this.name = 'InsufficientMaterialError';
  }
}

/** What a run needs, before anything is taken off the shelf. */
export interface ProductionPlan {
  readonly recipeId: string;
  readonly batches: number;
  readonly requiredInputs: readonly RecipeInput[];
  readonly expectedOutputMinor: number;
  readonly outputUom: string;
}

export function validateRecipe(recipe: Recipe): Recipe {
  if (recipe.inputs.length === 0) {
    throw new InvalidRecipeError(recipe.recipeId, 'it consumes nothing — that is not a recipe');
  }
  if (recipe.outputQuantityMinor <= 0) {
    throw new InvalidRecipeError(recipe.recipeId, 'it produces nothing');
  }
  if (recipe.shelfLifeHours <= 0) {
    throw new InvalidRecipeError(
      recipe.recipeId,
      'it has no shelf life — prepared food must carry one (M03-FR-03)',
    );
  }
  for (const input of recipe.inputs) {
    if (input.quantityMinor <= 0) {
      throw new InvalidRecipeError(recipe.recipeId, `"${input.productId}" is used in zero quantity`);
    }
  }
  return recipe;
}

/** Scale a recipe to the number of batches being made. */
export function planProduction(recipe: Recipe, batches: number): ProductionPlan {
  validateRecipe(recipe);
  if (!Number.isSafeInteger(batches) || batches < 1) {
    throw new InvalidRecipeError(recipe.recipeId, `cannot make ${batches} batches`);
  }
  return {
    recipeId: recipe.recipeId,
    batches,
    requiredInputs: recipe.inputs.map((input) => ({
      ...input,
      quantityMinor: input.quantityMinor * batches,
    })),
    expectedOutputMinor: recipe.outputQuantityMinor * batches,
    outputUom: recipe.outputUom,
  };
}

/** What is on hand for each ingredient, supplied by the stock projection. */
export type AvailableStock = Readonly<Record<string, number>>;

/** What each ingredient costs per smallest unit — feeds the output's cost. */
export type UnitCosts = Readonly<Record<string, Money>>;

export interface ProductionRun {
  readonly runId: string;
  readonly recipe: Recipe;
  readonly batches: number;
  readonly locationId: string;
  readonly producedBy: string;
  /** ISO-8601 UTC — injected. */
  readonly at: string;
  /** Batch id for the finished goods; carries the expiry (M10). */
  readonly outputBatchId: string;
  /** What actually came out, which is rarely exactly what was planned. */
  readonly actualOutputMinor: number;
}

export type YieldVerdict = 'as_expected' | 'low_yield' | 'high_yield' | 'not_measured';

export interface ProductionResult {
  readonly runId: string;
  /** Ledger movements: inputs out of stock, finished batch into quarantine. */
  readonly movements: readonly StockMovement[];
  readonly outputProductId: string;
  readonly outputBatchId: string;
  readonly outputQuantityMinor: number;
  /** ISO-8601 UTC when the finished batch expires (M03-FR-03 / M10). */
  readonly expiresAt: string;
  /** Total cost of everything consumed. */
  readonly inputCost: Money;
  /** Cost per smallest unit of what survived — process loss included. */
  readonly outputUnitCost: Money;
  /** Actual output as a fraction of the plan, in basis points. */
  readonly yieldBp: number;
  readonly yieldVerdict: YieldVerdict;
  /** Raised when yield drifted beyond tolerance — visible, valued, owned (P-08). */
  readonly exceptions: readonly ProductionException[];
}

export interface ProductionException {
  readonly runId: string;
  readonly kind: 'yield_variance' | 'no_output';
  readonly detail: string;
  /** What the difference is worth, so it can be prioritised. */
  readonly value: Money;
}

const BP = 10_000;

/**
 * Run a production batch: consume the inputs, create the finished batch, cost it,
 * and measure the yield.
 *
 * Nothing is consumed if anything is short — the check runs over every ingredient
 * first, so a half-finished run can never leave the shelf and the system disagreeing.
 */
export function produceBatch(input: {
  readonly run: ProductionRun;
  readonly available: AvailableStock;
  readonly unitCosts: UnitCosts;
  readonly currency: Money['currency'];
}): ProductionResult {
  const { run } = input;
  const plan = planProduction(run.recipe, run.batches);

  // Check everything before taking anything.
  for (const required of plan.requiredInputs) {
    const onHand = input.available[required.productId] ?? 0;
    if (onHand < required.quantityMinor) {
      throw new InsufficientMaterialError(
        required.productId,
        required.quantityMinor - onHand,
        required.uom,
      );
    }
  }

  const movements: StockMovement[] = plan.requiredInputs.map((required, i) => ({
    movementId: `${run.runId}-in-${i + 1}`,
    productId: required.productId,
    locationId: run.locationId,
    batchId: null,
    from: 'on_hand',
    to: null, // consumed by production — it has left the business as an ingredient
    quantityMinor: required.quantityMinor,
    uom: required.uom,
    at: run.at,
    reason: `consumed by production run ${run.runId}`,
  }));

  if (run.actualOutputMinor > 0) {
    movements.push({
      movementId: `${run.runId}-out`,
      productId: run.recipe.outputProductId,
      locationId: run.locationId,
      batchId: run.outputBatchId,
      from: null,
      // Straight into QUARANTINE: freshly produced food is not sellable until it is
      // released on quality (M11-FR-03). `packages/stock` never treats quarantine as
      // sellable, so this is enforced by the model, not by remembering.
      to: 'quarantine',
      quantityMinor: run.actualOutputMinor,
      uom: run.recipe.outputUom,
      at: run.at,
      reason: `produced by run ${run.runId}, awaiting quality release`,
    });
  }

  const inputCostMinor = plan.requiredInputs.reduce((sum, required) => {
    const unit = input.unitCosts[required.productId];
    return sum + (unit?.minor ?? 0) * required.quantityMinor;
  }, 0);

  // Cost follows the food that survived: trim and spillage are carried by the
  // output, not quietly written off, which is the only way real margin shows up.
  const outputUnitCostMinor =
    run.actualOutputMinor > 0 ? Math.round(inputCostMinor / run.actualOutputMinor) : 0;

  const yieldBp =
    plan.expectedOutputMinor === 0
      ? 0
      : Math.round((run.actualOutputMinor * BP) / plan.expectedOutputMinor);

  const tolerance = run.recipe.yieldToleranceBp;
  const exceptions: ProductionException[] = [];
  let verdict: YieldVerdict = 'not_measured';

  if (run.actualOutputMinor === 0) {
    exceptions.push({
      runId: run.runId,
      kind: 'no_output',
      detail: 'the inputs were consumed and nothing came out — this must be explained',
      value: { minor: inputCostMinor, currency: input.currency },
    });
  } else if (tolerance !== undefined) {
    const drift = yieldBp - BP;
    if (Math.abs(drift) <= tolerance) {
      verdict = 'as_expected';
    } else {
      verdict = drift < 0 ? 'low_yield' : 'high_yield';
      const missingUnits = Math.abs(plan.expectedOutputMinor - run.actualOutputMinor);
      exceptions.push({
        runId: run.runId,
        kind: 'yield_variance',
        detail:
          drift < 0
            ? `${missingUnits} ${run.recipe.outputUom} less than the recipe expects — check the process, the portioning or the measurement`
            : `${missingUnits} ${run.recipe.outputUom} more than the recipe expects — the recipe or the portioning may be wrong`,
        value: {
          minor: Math.abs(outputUnitCostMinor * missingUnits),
          currency: input.currency,
        },
      });
    }
  }

  return {
    runId: run.runId,
    movements,
    outputProductId: run.recipe.outputProductId,
    outputBatchId: run.outputBatchId,
    outputQuantityMinor: run.actualOutputMinor,
    expiresAt: new Date(Date.parse(run.at) + run.recipe.shelfLifeHours * 3_600_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z'),
    inputCost: { minor: inputCostMinor, currency: input.currency },
    outputUnitCost: { minor: outputUnitCostMinor, currency: input.currency },
    yieldBp,
    yieldVerdict: verdict,
    exceptions,
  };
}
