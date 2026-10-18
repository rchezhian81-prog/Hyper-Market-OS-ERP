// D-25 (R3) — forecast-driven fresh production planning (bakery / deli / kitchen). Pure and deterministic.
//
// Signed test sentence: "for an operated department, the plan proposes batches per recipe from the forecast, bounded by
// shelf life and expected yield. A run records its input batch IDs. A trace of an input batch reaches the output batch
// and its sales."
//
// The rule, in full, per recipe of a department the shop OPERATES (a recipe of any other department is not planned):
//   • the SELLING WINDOW is the whole days the finished item keeps: floor(shelf life hours ÷ 24), at least 1 — what is made
//     on the day must sell inside it, or it is waste;
//   • DEMAND is the forecast of the output product summed over that window (the D-1 forecast: baseline × day of week ×
//     any events);
//   • NEED is demand less the output already on hand that is still good on the day;
//   • ONE BATCH yields the recipe's output × its expected yield (10000 bp when the recipe names none);
//   • the PROPOSAL is the whole batches that fit inside the need — floor(need ÷ one batch) — so the plan never proposes
//     more than the forecast says will sell before it expires (bounded by shelf life and yield). What is left over is
//     shown, never hidden: `unmetMinor` (demand the proposal does not cover) and `oneMoreBatchUnsoldMinor` (what one more
//     batch would leave unsold at expiry), so the person who commits can decide;
//   • a product with no sales history to forecast from is proposed 0 batches, SAID as `no_sales_history` (P-08).
//
// It proposes; a person commits each run (hard rule #5, P-05). There is no write here.

import type { Recipe } from './recipe';

export interface PlanForecastDay { readonly day: string; readonly forecastQty: number }

export type PlanLineState = 'proposed' | 'nothing_needed' | 'no_sales_history' | 'batch_bigger_than_need';

export interface ProductionPlanLine {
  readonly recipeId: string;
  readonly departmentId: string;
  readonly outputProductId: string;
  readonly outputUom: string;
  readonly sellingWindowDays: number;
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly demandMinor: number;
  readonly onHandUsableMinor: number;
  readonly needMinor: number;
  readonly expectedYieldBp: number;
  readonly perBatchMinor: number;
  readonly proposedBatches: number;
  readonly proposedOutputMinor: number;
  readonly unmetMinor: number;
  readonly oneMoreBatchUnsoldMinor: number;
  readonly state: PlanLineState;
  /** Always true: a person commits each run. */
  readonly advisoryOnly: true;
}

export interface ProductionPlanProposal {
  readonly forDay: string;
  readonly lines: readonly ProductionPlanLine[];
  /** Recipes left out because their department is not operated here — named, not silently dropped. */
  readonly notOperated: readonly { readonly recipeId: string; readonly departmentId: string }[];
}

export class InvalidPlanInputError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidPlanInputError'; }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

export const sellingWindowDays = (shelfLifeHours: number): number => Math.max(1, Math.floor(shelfLifeHours / 24));

export function proposeProductionPlan(input: {
  readonly forDay: string;
  readonly recipes: readonly Recipe[];
  readonly operatedDepartments: readonly string[];
  /** The forecast of a product for days from `forDay`; undefined when it has no sales history to forecast from. */
  readonly forecastOf: (productId: string) => readonly PlanForecastDay[] | undefined;
  /** The output already on hand that is still good on `forDay`. */
  readonly onHandUsableOf: (productId: string) => number;
}): ProductionPlanProposal {
  if (!DAY.test(input.forDay) || Number.isNaN(Date.parse(input.forDay))) throw new InvalidPlanInputError(`forDay must be a YYYY-MM-DD day, not "${input.forDay}".`);
  const operated = new Set(input.operatedDepartments);
  const lines: ProductionPlanLine[] = [];
  const notOperated: { recipeId: string; departmentId: string }[] = [];
  for (const r of [...input.recipes].sort((a, b) => (a.recipeId < b.recipeId ? -1 : 1))) {
    if (!operated.has(r.departmentId)) { notOperated.push({ recipeId: r.recipeId, departmentId: r.departmentId }); continue; }
    const window = sellingWindowDays(r.shelfLifeHours);
    const windowTo = addDays(input.forDay, window - 1);
    const forecast = input.forecastOf(r.outputProductId);
    const yieldBp = r.expectedYieldBp ?? 10_000;
    const perBatch = Math.floor((r.outputQuantityMinor * yieldBp) / 10_000);
    const onHand = Math.max(0, input.onHandUsableOf(r.outputProductId));
    const base = {
      recipeId: r.recipeId, departmentId: r.departmentId, outputProductId: r.outputProductId, outputUom: r.outputUom,
      sellingWindowDays: window, windowFrom: input.forDay, windowTo, onHandUsableMinor: onHand, expectedYieldBp: yieldBp, perBatchMinor: perBatch,
      advisoryOnly: true as const,
    };
    if (forecast === undefined) {
      lines.push({ ...base, demandMinor: 0, needMinor: 0, proposedBatches: 0, proposedOutputMinor: 0, unmetMinor: 0, oneMoreBatchUnsoldMinor: perBatch, state: 'no_sales_history' });
      continue;
    }
    const demand = forecast.filter((d) => d.day >= input.forDay && d.day <= windowTo).reduce((n, d) => n + Math.max(0, d.forecastQty), 0);
    const need = Math.max(0, demand - onHand);
    const batches = perBatch <= 0 ? 0 : Math.floor(need / perBatch);
    const output = batches * perBatch;
    lines.push({
      ...base, demandMinor: demand, needMinor: need, proposedBatches: batches, proposedOutputMinor: output,
      unmetMinor: need - output, oneMoreBatchUnsoldMinor: Math.max(0, output + perBatch - need),
      state: need === 0 ? 'nothing_needed' : batches === 0 ? 'batch_bigger_than_need' : 'proposed',
    });
  }
  return { forDay: input.forDay, lines, notOperated };
}
