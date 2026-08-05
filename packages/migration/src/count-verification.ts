// Proving the extracted stock against the shelves — MG-06, OB-06, §28.
//
// `packages/counts` already does blind counting for the **running** system: it projects the
// expected on-hand from the ledger, values the variance and produces a compensating adjustment.
// This is a different question, asked once, before any of that exists.
//
// At migration there is no ledger. The expected figure comes from a report we extracted
// ourselves, and the question is not *"adjust the stock"* — it is **"does this figure deserve to
// become opening truth?"** The only thing on earth that can answer it is the shelves.
//
// The practical problem is that counting a 14,000 sq ft hypermarket in full is one closed evening
// and most of the staff. That is affordable **once**, and the temptation is therefore to count a
// sample instead — which is entirely legitimate and almost always done wrong:
//
//   • **A SAMPLE CHOSEN BY THE PERSON BEING CHECKED IS NOT A SAMPLE.** If the operator who ran
//     the extraction picks the lines, the lines they are confident about get picked. Not
//     dishonestly — that is simply what confidence does. Refused by name (§28).
//   • **VALUE IS NOT SPREAD EVENLY, SO A RANDOM SAMPLE IS THE WRONG SAMPLE.** In a hypermarket a
//     small number of lines hold most of the money. Counting those **in full** and sampling the
//     tail buys far more assurance per hour than counting the same number of lines at random —
//     and a random sample that happens to miss the ghee and the whisky has verified almost
//     nothing while looking thorough.
//   • **"WE CHECKED FIFTY AND THEY WERE FINE" IS NOT A RESULT.** A sample says something about
//     the population only with its basis stated. What it supports is an **estimate** of the error
//     in what was not counted, and the estimate has to be labelled as one — this codebase does
//     not fabricate a ratio and call it a measurement.
//
// Pure and deterministic: the sample is drawn by a seeded, reproducible rule so the same plan can
// be regenerated and audited, never by an unrepeatable random draw.

export interface StockLine {
  readonly lineId: string;
  readonly productId: string;
  readonly description: string;
  /** As extracted. The counter never sees this — blind counting is structural here too. */
  readonly extractedQty: number;
  readonly extractedValueMinor: number;
}

export type Stratum = 'census' | 'sampled' | 'not_counted';

export interface CountLine {
  readonly lineId: string;
  readonly productId: string;
  readonly description: string;
  readonly stratum: Stratum;
  /**
   * Deliberately absent from the count sheet. A counter shown "expected: 40" writes 40, and the
   * whole exercise measures the counter's willingness to disagree rather than the stock.
   */
  readonly expectedQtyShownToCounter: false;
}

export interface CountPlan {
  readonly planId: string;
  readonly lines: readonly CountLine[];
  readonly censusLines: number;
  readonly sampledLines: number;
  readonly notCountedLines: number;
  /** Share of total extracted value the census stratum covers, in basis points. */
  readonly censusValueCoverageBps: number;
  readonly totalValueMinor: number;
  readonly detail: string;
}

export type PlanRefusal = 'chosen_by_the_extractor' | 'no_lines' | 'sample_too_small';

export interface PlanResult {
  readonly ok: boolean;
  readonly plan?: CountPlan;
  readonly refusedBecause?: PlanRefusal;
  readonly detail: string;
}

/** A seeded, reproducible draw. An audit must be able to ask why THIS line was chosen. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Plan which lines get counted.
 *
 * **Value-stratified**, not random. Lines are sorted by extracted value and the top ones are
 * counted in full — a *census*, not a sample — until the target share of total value is covered.
 * Everything else is sampled at the given rate.
 *
 * The result is that the money is verified almost completely while the hours go into a thin slice
 * of the long tail, which is where they belong: a ₹4 line being wrong costs ₹4, and a ₹40,000
 * line being wrong costs a day of somebody's month.
 */
export function planCountSample(input: {
  readonly planId: string;
  readonly lines: readonly StockLine[];
  /** Who is choosing. Must not be whoever ran the extraction (§28). */
  readonly plannedBy: string;
  readonly extractionOperator: string;
  /** Share of total value to count in FULL, in basis points. Default 8000 = 80%. */
  readonly censusValueTargetBps?: number;
  /** Share of the remaining lines to sample, in basis points. Default 500 = 5%. */
  readonly tailSampleRateBps?: number;
  /** Seeded so the same plan regenerates identically and an auditor can re-derive it. */
  readonly seed: number;
}): PlanResult {
  if (input.plannedBy === input.extractionOperator) {
    return {
      ok: false, refusedBecause: 'chosen_by_the_extractor',
      detail: `${input.plannedBy} ran the extraction and cannot also choose which lines are checked against it (§28). Not because they would cheat — because the lines somebody is confident about are the lines they pick, and that is what confidence does`,
    };
  }
  if (input.lines.length === 0) {
    return { ok: false, refusedBecause: 'no_lines', detail: 'nothing to count' };
  }

  const censusTargetBps = input.censusValueTargetBps ?? 8_000;
  const tailRateBps = input.tailSampleRateBps ?? 500;
  const totalValueMinor = input.lines.reduce((t, l) => t + Math.abs(l.extractedValueMinor), 0);

  // Descending by value, then by id so the order is total and reproducible.
  const ordered = [...input.lines].sort((a, b) =>
    Math.abs(b.extractedValueMinor) - Math.abs(a.extractedValueMinor)
    || (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0));

  const census = new Set<string>();
  let covered = 0;
  for (const line of ordered) {
    if (totalValueMinor > 0 && (covered * 10_000) / totalValueMinor >= censusTargetBps) break;
    census.add(line.lineId);
    covered += Math.abs(line.extractedValueMinor);
  }

  const rand = mulberry32(input.seed);
  const lines: CountLine[] = ordered.map((line) => {
    const stratum: Stratum = census.has(line.lineId)
      ? 'census'
      : rand() * 10_000 < tailRateBps ? 'sampled' : 'not_counted';
    return {
      lineId: line.lineId, productId: line.productId, description: line.description,
      stratum, expectedQtyShownToCounter: false,
    };
  });

  const censusLines = lines.filter((l) => l.stratum === 'census').length;
  const sampledLines = lines.filter((l) => l.stratum === 'sampled').length;
  const notCountedLines = lines.filter((l) => l.stratum === 'not_counted').length;

  if (sampledLines + censusLines < 2 && input.lines.length > 2) {
    return {
      ok: false, refusedBecause: 'sample_too_small',
      detail: 'the plan counts fewer than two lines — nothing can be estimated from that, and a result presented from it would be a number with no basis',
    };
  }

  const censusValueCoverageBps = totalValueMinor === 0 ? 0
    : Math.round((covered * 10_000) / totalValueMinor);

  return {
    ok: true,
    plan: {
      planId: input.planId, lines, censusLines, sampledLines, notCountedLines,
      censusValueCoverageBps, totalValueMinor,
      detail: `${censusLines} lines counted in full covering ${(censusValueCoverageBps / 100).toFixed(1)}% of the value, plus ${sampledLines} sampled from the tail and ${notCountedLines} not counted. The money is verified almost completely; the hours go into a thin slice of the tail, which is where they belong`,
    },
    detail: `count plan ${input.planId}: ${censusLines} census, ${sampledLines} sampled`,
  };
}

// ── The result ────────────────────────────────────────────────────────────────

export interface CountedLine {
  readonly lineId: string;
  /** What was actually on the shelf. Entered blind. */
  readonly countedQty: number;
  readonly counterId: string;
}

export interface LineVariance {
  readonly lineId: string;
  readonly productId: string;
  readonly description: string;
  readonly stratum: Stratum;
  readonly extractedQty: number;
  readonly countedQty: number;
  readonly differenceQty: number;
  readonly differenceValueMinor: number;
}

export interface CountVerification {
  readonly planId: string;
  readonly linesCounted: number;
  readonly variances: readonly LineVariance[];
  /** Measured, on lines actually counted. A fact. */
  readonly censusDifferenceMinor: number;
  readonly sampledDifferenceMinor: number;
  /**
   * ESTIMATED error in what was not counted. An estimate, and labelled as one — `undefined`
   * when the sample cannot support it rather than a fabricated figure (§29.1 discipline).
   */
  readonly estimatedUncountedErrorMinor?: number;
  readonly estimateBasis: string;
  /** True only when nothing counted differed at all. */
  readonly cleanCount: boolean;
  /** Whether this count is strong enough to sign a control total against (MG-06). */
  readonly sufficientToVerify: boolean;
  readonly detail: string;
  readonly ownerAction: string;
}

/**
 * Compare the shelves to the extract, and be honest about the part nobody counted.
 *
 * The census stratum is a **measurement** and is reported as one. The sampled tail supports an
 * **estimate** of the error in the uncounted lines, and it is presented as an estimate with its
 * basis in words — never blended into the measured figure to produce one confident-looking
 * total, which is the presentation that gets signed.
 */
export function assessCountVerification(input: {
  readonly plan: CountPlan;
  readonly extracted: readonly StockLine[];
  readonly counted: readonly CountedLine[];
  /** Difference in value at or above which the count cannot support a signature. */
  readonly toleranceMinor?: number;
}): CountVerification {
  const tolerance = input.toleranceMinor ?? 0;
  const byId = new Map(input.extracted.map((l) => [l.lineId, l]));
  const stratumOf = new Map(input.plan.lines.map((l) => [l.lineId, l.stratum]));

  const variances: LineVariance[] = [];
  for (const c of input.counted) {
    const line = byId.get(c.lineId);
    if (line === undefined) continue;
    const differenceQty = c.countedQty - line.extractedQty;
    if (differenceQty === 0) continue;
    // Value the difference at the line's own unit value, exactly — integer arithmetic only.
    const perUnit = line.extractedQty === 0
      ? 0
      : Math.round(line.extractedValueMinor / line.extractedQty);
    variances.push({
      lineId: c.lineId, productId: line.productId, description: line.description,
      stratum: stratumOf.get(c.lineId) ?? 'not_counted',
      extractedQty: line.extractedQty, countedQty: c.countedQty,
      differenceQty, differenceValueMinor: differenceQty * perUnit,
    });
  }

  const censusDifferenceMinor = variances
    .filter((v) => v.stratum === 'census')
    .reduce((t, v) => t + v.differenceValueMinor, 0);
  const sampledDifferenceMinor = variances
    .filter((v) => v.stratum === 'sampled')
    .reduce((t, v) => t + v.differenceValueMinor, 0);

  // The estimate, and the refusal to produce one when it would be meaningless.
  const sampledPlanned = input.plan.lines.filter((l) => l.stratum === 'sampled');
  const sampledCounted = input.counted.filter((c) => stratumOf.get(c.lineId) === 'sampled').length;
  const notCounted = input.plan.notCountedLines;

  const sampledValueMinor = sampledPlanned
    .map((l) => byId.get(l.lineId))
    .reduce((t, l) => t + Math.abs(l?.extractedValueMinor ?? 0), 0);
  const notCountedValueMinor = input.plan.lines
    .filter((l) => l.stratum === 'not_counted')
    .map((l) => byId.get(l.lineId))
    .reduce((t, l) => t + Math.abs(l?.extractedValueMinor ?? 0), 0);

  let estimatedUncountedErrorMinor: number | undefined;
  let estimateBasis: string;

  if (notCounted === 0) {
    estimateBasis = 'every line was counted — there is nothing to estimate, and the figure above is a measurement';
  } else if (sampledCounted < 5 || sampledValueMinor === 0) {
    // Deliberately no number. A rate from three lines is arithmetic, not evidence.
    estimateBasis = `${sampledCounted} tail lines were counted, which is too few to estimate anything from. The ${notCounted} uncounted lines (${notCountedValueMinor} in minor units) are UNVERIFIED — not verified-as-correct, and the difference matters`;
  } else {
    // Rate on the sampled stratum, applied to the uncounted stratum by value.
    const rateBps = Math.round((Math.abs(sampledDifferenceMinor) * 10_000) / sampledValueMinor);
    estimatedUncountedErrorMinor = Math.round((notCountedValueMinor * rateBps) / 10_000);
    estimateBasis = `${sampledCounted} tail lines counted showed ${(rateBps / 100).toFixed(2)}% error by value; applied to the ${notCounted} uncounted lines that suggests roughly ${estimatedUncountedErrorMinor} in minor units. That is an ESTIMATE from a sample, not a measurement, and it must not be added to the counted figure to make one confident-looking total`;
  }

  const cleanCount = variances.length === 0;
  const measuredDifference = Math.abs(censusDifferenceMinor) + Math.abs(sampledDifferenceMinor);
  // A count supports a signature when the money is covered and what it found is within tolerance.
  const sufficientToVerify = input.plan.censusValueCoverageBps >= 7_000
    && measuredDifference <= tolerance
    && input.counted.length >= input.plan.censusLines;

  return {
    planId: input.plan.planId,
    linesCounted: input.counted.length,
    variances: [...variances].sort((a, b) => Math.abs(b.differenceValueMinor) - Math.abs(a.differenceValueMinor)),
    censusDifferenceMinor,
    sampledDifferenceMinor,
    ...(estimatedUncountedErrorMinor === undefined ? {} : { estimatedUncountedErrorMinor }),
    estimateBasis,
    cleanCount,
    sufficientToVerify,
    detail: cleanCount
      ? `every one of the ${input.counted.length} lines counted matched the extract exactly. ${estimateBasis}`
      : `${variances.length} lines differ from the extract: ${censusDifferenceMinor} in minor units across the high-value census and ${sampledDifferenceMinor} across the sampled tail. ${estimateBasis}`,
    ownerAction: sufficientToVerify
      ? 'the count supports signing the stock control total — the biggest number in the business now rests on your own shelves rather than on the old system\'s word'
      : input.plan.censusValueCoverageBps < 7_000
        ? 'the plan counted too little of the value to sign against. Raise the census target and count again — the high-value lines are the ones worth the hours'
        : `the count found ${measuredDifference} in differences, above the tolerance set. Each line is listed; they are settled one at a time against the shelf, not averaged away`,
  };
}
