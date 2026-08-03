// Catch weight, trim loss and weighed costing (M11-FR-02, weighed departments).
//
// A butcher, a fish counter and a deli do not make "40 cups". They take in 12.4 kg
// of something, throw away bone, skin, fat and trim, and put out 8.9 kg of something
// else. Nothing about that is a whole number, and every part of it is money:
//
//   • the 3.5 kg that went in the bin was PAID FOR at the input price;
//   • so the 8.9 kg that survived must carry the whole cost, or the counter looks
//     more profitable than it is, and the shelf price is set too low;
//   • and if today's yield is 72% when the standard is 80%, that is either a bad
//     delivery, a heavy hand on the knife, or theft — and it is invisible unless
//     the two weights are recorded against each other.
//
// So this module works in exact integer grams (never floats — §29.1) and reports
// yield against the department's own standard. A cut that yields badly is a valued
// exception with the money attached, not a note.
//
// Cost per kilo of output = total input cost ÷ output weight. That single line is
// why a fish counter can run at a loss for a year without anyone noticing.
//
// Pure and deterministic: no clock, no I/O.

import type { Money } from '../../contracts/src/money';

/** What went into a cut or process, and what it cost. */
export interface CatchWeightInput {
  readonly productId: string;
  /** Weight in grams — an exact integer, never a float. */
  readonly weightGrams: number;
  /** Cost per kilogram of the input. */
  readonly costPerKg: Money;
}

/** What came out, by product — a cut usually produces more than one thing. */
export interface CatchWeightOutput {
  readonly productId: string;
  readonly weightGrams: number;
  /**
   * How this output shares the input cost relative to the others, in basis points
   * of value. Prime cuts carry more cost than trimmings from the same carcass;
   * leave every output at the same weight to split cost by weight alone.
   */
  readonly costWeightBp?: number;
  /** True for waste streams (bone, skin) — recorded, but never priced for sale. */
  readonly isByproduct?: boolean;
}

export interface CatchWeightRun {
  readonly runId: string;
  readonly departmentId: string;
  readonly inputs: readonly CatchWeightInput[];
  readonly outputs: readonly CatchWeightOutput[];
  /** The yield this process is expected to give, in basis points of input weight. */
  readonly standardYieldBp?: number;
  readonly toleranceBp?: number;
  readonly at: string;
}

export interface CostedOutput {
  readonly productId: string;
  readonly weightGrams: number;
  /** This output's share of the total input cost. */
  readonly allocatedCost: Money;
  /** What a kilogram of it actually cost to produce — process loss included. */
  readonly costPerKg: Money;
  readonly isByproduct: boolean;
}

export interface CatchWeightResult {
  readonly runId: string;
  readonly inputWeightGrams: number;
  readonly outputWeightGrams: number;
  /** Everything that did not come out the other side: bone, trim, evaporation. */
  readonly lossGrams: number;
  /** Output weight as a fraction of input weight, in basis points. */
  readonly yieldBp: number;
  readonly inputCost: Money;
  readonly outputs: readonly CostedOutput[];
  readonly verdict: 'as_expected' | 'low_yield' | 'high_yield' | 'not_measured';
  readonly exceptions: readonly CatchWeightException[];
}

export interface CatchWeightException {
  readonly runId: string;
  readonly kind: 'yield_variance' | 'gained_weight';
  readonly detail: string;
  readonly value: Money;
}

export class InvalidCatchWeightError extends Error {
  constructor(
    public readonly runId: string,
    reason: string,
  ) {
    super(`Catch-weight run "${runId}" is invalid: ${reason}`);
    this.name = 'InvalidCatchWeightError';
  }
}

const BP = 10_000;
const GRAMS_PER_KG = 1_000;

/**
 * Cost a variable-weight process and measure its yield.
 *
 * All arithmetic is integer: cost is minor units, weight is grams, and the cost
 * split uses exact remainder distribution so the allocated costs always sum to the
 * input cost — not "about" the input cost (§29.1).
 */
export function costCatchWeight(run: CatchWeightRun, currency: Money['currency']): CatchWeightResult {
  if (run.inputs.length === 0) {
    throw new InvalidCatchWeightError(run.runId, 'nothing went in');
  }
  for (const input of run.inputs) {
    if (!Number.isSafeInteger(input.weightGrams) || input.weightGrams <= 0) {
      throw new InvalidCatchWeightError(
        run.runId,
        `"${input.productId}" has a weight of ${input.weightGrams} g — weights are whole grams`,
      );
    }
  }
  for (const output of run.outputs) {
    if (!Number.isSafeInteger(output.weightGrams) || output.weightGrams < 0) {
      throw new InvalidCatchWeightError(
        run.runId,
        `"${output.productId}" has a weight of ${output.weightGrams} g`,
      );
    }
  }

  const inputWeight = run.inputs.reduce((sum, i) => sum + i.weightGrams, 0);
  const outputWeight = run.outputs.reduce((sum, o) => sum + o.weightGrams, 0);
  const inputCostMinor = run.inputs.reduce(
    (sum, i) => sum + Math.round((i.costPerKg.minor * i.weightGrams) / GRAMS_PER_KG),
    0,
  );

  // Cost is carried only by what can be sold. A by-product stream is recorded so the
  // weights reconcile, but loading cost onto bone would understate the cost of meat.
  const sellable = run.outputs.filter((o) => o.isByproduct !== true);
  const weights = sellable.map((o) => o.costWeightBp ?? o.weightGrams);
  const weightTotal = weights.reduce((sum, w) => sum + w, 0);

  // Exact split with the remainder distributed, largest share first, so the parts
  // always sum to the whole.
  const shares: number[] = weights.map((w) =>
    weightTotal === 0 ? 0 : Math.floor((inputCostMinor * w) / weightTotal),
  );
  let remainder = inputCostMinor - shares.reduce((sum, s) => sum + s, 0);
  const order = shares.map((_, i) => i).sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0));
  for (const i of order) {
    if (remainder <= 0) break;
    shares[i] = (shares[i] ?? 0) + 1;
    remainder -= 1;
  }

  let sellableIndex = 0;
  const outputs = run.outputs.map((output): CostedOutput => {
    const byproduct = output.isByproduct === true;
    const allocated = byproduct ? 0 : (shares[sellableIndex++] ?? 0);
    return {
      productId: output.productId,
      weightGrams: output.weightGrams,
      allocatedCost: { minor: allocated, currency },
      costPerKg: {
        minor:
          output.weightGrams === 0
            ? 0
            : Math.round((allocated * GRAMS_PER_KG) / output.weightGrams),
        currency,
      },
      isByproduct: byproduct,
    };
  });

  const yieldBp = inputWeight === 0 ? 0 : Math.round((outputWeight * BP) / inputWeight);
  const exceptions: CatchWeightException[] = [];
  let verdict: CatchWeightResult['verdict'] = 'not_measured';

  if (outputWeight > inputWeight) {
    // More came out than went in. Not physics — a mis-weigh, a mixed-up run, or
    // stock arriving from somewhere it was not recorded.
    exceptions.push({
      runId: run.runId,
      kind: 'gained_weight',
      detail: `${outputWeight - inputWeight} g more came out than went in — someone has mis-weighed, or stock was added that was not recorded`,
      value: { minor: inputCostMinor, currency },
    });
  }

  if (run.standardYieldBp !== undefined) {
    const tolerance = run.toleranceBp ?? 0;
    const drift = yieldBp - run.standardYieldBp;
    if (Math.abs(drift) <= tolerance) {
      verdict = 'as_expected';
    } else {
      verdict = drift < 0 ? 'low_yield' : 'high_yield';
      const expectedGrams = Math.round((inputWeight * run.standardYieldBp) / BP);
      const missingGrams = Math.abs(expectedGrams - outputWeight);
      const costPerGram = inputWeight === 0 ? 0 : inputCostMinor / inputWeight;
      exceptions.push({
        runId: run.runId,
        kind: 'yield_variance',
        detail:
          drift < 0
            ? `yield ${(yieldBp / 100).toFixed(1)}% against a standard of ${(run.standardYieldBp / 100).toFixed(1)}% — ${missingGrams} g short. A poor delivery, a heavy hand, or stock leaving another way`
            : `yield ${(yieldBp / 100).toFixed(1)}% against a standard of ${(run.standardYieldBp / 100).toFixed(1)}% — ${missingGrams} g over. The standard or the weighing is wrong`,
        value: { minor: Math.round(costPerGram * missingGrams), currency },
      });
    }
  }

  return {
    runId: run.runId,
    inputWeightGrams: inputWeight,
    outputWeightGrams: outputWeight,
    lossGrams: inputWeight - outputWeight,
    yieldBp,
    inputCost: { minor: inputCostMinor, currency },
    outputs,
    verdict,
    exceptions,
  };
}

/** The price of a weighed pack: price per kg × its weight, exact to the paisa. */
export function priceByWeight(pricePerKg: Money, weightGrams: number): Money {
  return {
    minor: Math.round((pricePerKg.minor * weightGrams) / GRAMS_PER_KG),
    currency: pricePerKg.currency,
  };
}
