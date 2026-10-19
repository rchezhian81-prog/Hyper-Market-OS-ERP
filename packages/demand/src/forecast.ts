// Demand forecast (D-1) — predict how much of a product will sell in the days ahead, from its own
// sales history. This is the decision behind good ordering: the reorder engine (D-3, M09) reacts to a
// past average; a forecast looks forward and, crucially, knows that a Sunday is not a Tuesday.
//
// **Decomposition, deliberately simple and explainable.** Demand = a baseline level × a day-of-week
// seasonality factor. A hypermarket's strongest and steadiest signal is the week: weekends and market
// days sell multiples of a quiet weekday, and that pattern repeats. So the forecast is `baseline ×
// factor[day-of-week]`, both learned from the history — a number a buyer can read and sanity-check,
// not a black box. Richer signals the roadmap names — promotions, festivals, weather, and a cold-start
// for a brand-new SKU — are exogenous inputs that layer ON this baseline; they are follow-on work, and
// are named here so they are deferred openly, never silently dropped (CLAUDE.md).
//
// **It is judged, not asserted.** The engine ships with a back-test: fit on the earlier part of the
// history, forecast the held-out tail, and measure the error against what actually happened (WAPE — the
// total absolute miss over the total sold). "The forecast is good" is then a bounded number on a
// fixture, not a claim. Pure and deterministic: no clock, no I/O — the day-of-week comes from the date.

/** A day's total demand (YYYY-MM-DD, quantity in the line's own minor unit — eaches or grams). */
export interface DailyDemand {
  readonly day: string;
  readonly qty: number;
}

/**
 * A known upcoming event that lifts (or dampens) demand beyond the weekly pattern — a festival, a
 * promotion, a heatwave. All three are the same shape: on a range of days, demand is × a multiplier. The
 * calendar is DATA the caller supplies (public festival dates, the shop's own promo diary, a weather feed),
 * never hard-coded here.
 */
export interface DemandSignal {
  /** YYYY-MM-DD, inclusive. */
  readonly from: string;
  readonly to: string;
  /** > 0. 1.8 = +80% on those days; 0.7 = −30%. */
  readonly multiplier: number;
  readonly label?: string;
}

/** One forecast day. */
export interface ForecastDay {
  readonly day: string;
  /** 0 = Sunday … 6 = Saturday. */
  readonly dow: number;
  /** baseline × the day's seasonality factor × any active signals, rounded, never negative. */
  readonly forecastQty: number;
  /** The combined multiplier of the signals active on this day (1 = none). */
  readonly signalMultiplier: number;
  /** The labels of the signals active on this day (a range with no label reads as `from..to`). */
  readonly appliedSignals: readonly string[];
}

/**
 * New-item cold-start (D-1): a product too new to have its own pattern borrows a **peer / category** rate,
 * which its own sales take over as they accumulate (credibility shrinkage). The peer rate is DATA the
 * caller supplies (a similar SKU's demand, a category average), never inferred here.
 */
export interface ColdStart {
  /** The peer / category baseline demand per day to lean on while the item's own history is thin. */
  readonly peerBaselinePerDay: number;
  /**
   * How many days of peer "evidence" the prior is worth — the item's own history outweighs it past this.
   * Default 14 (two weeks). Higher = trust the peer longer.
   */
  readonly priorDays?: number;
}

export interface DemandForecast {
  /** The fit window (YYYY-MM-DD, inclusive) the forecast learned from. */
  readonly from: string;
  readonly to: string;
  /** The average daily demand — the level the seasonality multiplies (a peer-blended level under cold-start). */
  readonly baselinePerDay: number;
  /** Whether the baseline came from the item's own history or a cold-start peer blend. */
  readonly baselineSource: 'history' | 'cold_start';
  /** Seven day-of-week multipliers, index 0 = Sunday … 6 = Saturday; ~1 is an average day (flat under cold-start). */
  readonly dowFactors: readonly number[];
  /** The projected days after `to`. */
  readonly horizon: readonly ForecastDay[];
  /** The exogenous signals applied to the horizon (echoed for transparency). */
  readonly signals: readonly DemandSignal[];
  readonly method: 'baseline_x_dow';
}

/** The quality of a forecast, measured by holding out the tail of the history and scoring it. */
export interface Backtest {
  /** Days that were held out and scored. */
  readonly testedDays: number;
  /** Σ|actual − forecast| ÷ Σ actual — the fraction of demand the forecast missed by. 0 is perfect. */
  readonly wape: number;
  /** Mean absolute error per day, in the demand's minor unit. */
  readonly mae: number;
  readonly actualTotal: number;
  readonly forecastTotal: number;
}

export class InvalidForecastInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidForecastInputError';
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function dayIndex(day: string): number {
  const t = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isNaN(t) ? NaN : Math.floor(t / 86_400_000);
}
const dayOf = (index: number): string => new Date(index * 86_400_000).toISOString().slice(0, 10);
/** 0 = Sunday … 6 = Saturday, from a day index, using UTC so it never depends on the machine's zone. */
const dowOfIndex = (index: number): number => new Date(index * 86_400_000).getUTCDay();

/** Validate the signals and return them with their day indices resolved, or throw. */
function resolveSignals(signals: readonly DemandSignal[]): ReadonlyArray<{ fromIdx: number; toIdx: number; multiplier: number; label: string }> {
  return signals.map((s) => {
    if (!DAY.test(s.from) || !DAY.test(s.to)) {
      throw new InvalidForecastInputError('a signal needs from and to as YYYY-MM-DD dates');
    }
    const fromIdx = dayIndex(s.from);
    const toIdx = dayIndex(s.to);
    if (Number.isNaN(fromIdx) || Number.isNaN(toIdx) || toIdx < fromIdx) {
      throw new InvalidForecastInputError('a signal needs real dates with from on or before to');
    }
    if (!Number.isFinite(s.multiplier) || s.multiplier <= 0) {
      throw new InvalidForecastInputError('a signal multiplier must be a finite number greater than 0');
    }
    return { fromIdx, toIdx, multiplier: s.multiplier, label: s.label ?? `${s.from}..${s.to}` };
  });
}

/**
 * Blend an item's own demand with a peer / category rate, weighted by how much of its own history exists
 * (credibility shrinkage). With no history the peer rate stands alone; as sales accumulate, the item's own
 * rate takes over. `blended = (totalQty + priorDays × peerBaselinePerDay) / (observedDays + priorDays)`.
 * Throws `InvalidForecastInputError` on bad input.
 */
export function coldStartBaseline(input: {
  readonly totalQty: number;
  readonly observedDays: number;
  readonly peerBaselinePerDay: number;
  readonly priorDays?: number;
}): number {
  if (!Number.isFinite(input.totalQty) || input.totalQty < 0) {
    throw new InvalidForecastInputError('totalQty must be a finite number of at least 0');
  }
  if (!Number.isInteger(input.observedDays) || input.observedDays < 0) {
    throw new InvalidForecastInputError('observedDays must be a whole number of at least 0');
  }
  if (!Number.isFinite(input.peerBaselinePerDay) || input.peerBaselinePerDay < 0) {
    throw new InvalidForecastInputError('peerBaselinePerDay must be a finite number of at least 0');
  }
  const priorDays = input.priorDays ?? 14;
  if (!Number.isInteger(priorDays) || priorDays < 1) {
    throw new InvalidForecastInputError('priorDays must be a whole number of at least 1');
  }
  return (input.totalQty + priorDays * input.peerBaselinePerDay) / (input.observedDays + priorDays);
}

/**
 * Fit a baseline + day-of-week forecast on `[from, to]` and project `horizonDays` days after `to`.
 *
 * The history is folded onto a dense daily series over the window (a day with no entry is zero demand —
 * that is real information, not missing data). Entries outside the window are ignored. Throws
 * `InvalidForecastInputError` on a malformed window, `from` after `to`, or a horizon below 1.
 */
export function forecastDemand(input: {
  readonly history: readonly DailyDemand[];
  readonly from: string;
  readonly to: string;
  readonly horizonDays: number;
  /** Known upcoming events (festival / promo / weather) that lift or dampen demand on their days. */
  readonly signals?: readonly DemandSignal[];
  /** New-item cold-start: seed a thin history from a peer / category rate. */
  readonly coldStart?: ColdStart;
}): DemandForecast {
  if (!DAY.test(input.from) || !DAY.test(input.to)) {
    throw new InvalidForecastInputError('from and to must be YYYY-MM-DD dates');
  }
  const fromIdx = dayIndex(input.from);
  const toIdx = dayIndex(input.to);
  if (Number.isNaN(fromIdx) || Number.isNaN(toIdx)) {
    throw new InvalidForecastInputError('from and to must be real calendar dates');
  }
  if (toIdx < fromIdx) throw new InvalidForecastInputError('from must be on or before to');
  if (!Number.isInteger(input.horizonDays) || input.horizonDays < 1) {
    throw new InvalidForecastInputError('horizonDays must be a whole number of days, 1 or more');
  }
  const signals = resolveSignals(input.signals ?? []);

  const windowDays = toIdx - fromIdx + 1;

  // Dense daily series: qty per day index over the window (missing day → 0).
  const perDay = new Map<number, number>();
  for (const point of input.history) {
    if (!DAY.test(point.day)) continue;
    const idx = dayIndex(point.day);
    if (Number.isNaN(idx) || idx < fromIdx || idx > toIdx) continue;
    if (!Number.isFinite(point.qty)) continue;
    perDay.set(idx, (perDay.get(idx) ?? 0) + point.qty);
  }

  let total = 0;
  const dowSum = [0, 0, 0, 0, 0, 0, 0];
  const dowCount = [0, 0, 0, 0, 0, 0, 0];
  for (let idx = fromIdx; idx <= toIdx; idx += 1) {
    const qty = perDay.get(idx) ?? 0;
    total += qty;
    const dow = dowOfIndex(idx);
    dowSum[dow] = (dowSum[dow] ?? 0) + qty;
    dowCount[dow] = (dowCount[dow] ?? 0) + 1;
  }

  const historyBaseline = total / windowDays;
  const observedDays = perDay.size; // distinct days in the window on which the item actually sold
  // Cold-start: a new item with a thin history leans on a peer / category rate. Otherwise the baseline is
  // the item's own average over the window.
  const baselinePerDay = input.coldStart === undefined
    ? historyBaseline
    : coldStartBaseline({
        totalQty: total, observedDays, peerBaselinePerDay: input.coldStart.peerBaselinePerDay,
        ...(input.coldStart.priorDays === undefined ? {} : { priorDays: input.coldStart.priorDays }),
      });
  const baselineSource: 'history' | 'cold_start' = input.coldStart === undefined ? 'history' : 'cold_start';
  // factor = this weekday's mean ÷ the overall mean. A cold-start item has too little history for a
  // reliable weekly shape, so it forecasts FLAT at the blended level until it has its own history. A
  // baseline of 0 (or a weekday never seen) carries no signal, so its factor is a neutral 1.
  const dowFactors = input.coldStart !== undefined
    ? [1, 1, 1, 1, 1, 1, 1]
    : dowSum.map((sum, d) => {
        const count = dowCount[d] ?? 0;
        return historyBaseline === 0 || count === 0 ? 1 : (sum / count) / historyBaseline;
      });

  const horizon: ForecastDay[] = [];
  for (let i = 1; i <= input.horizonDays; i += 1) {
    const idx = toIdx + i;
    const dow = dowOfIndex(idx);
    const factor = dowFactors[dow] ?? 1;
    const active = signals.filter((s) => idx >= s.fromIdx && idx <= s.toIdx);
    const signalMultiplier = active.reduce((m, s) => m * s.multiplier, 1);
    horizon.push({
      day: dayOf(idx),
      dow,
      forecastQty: Math.max(0, Math.round(baselinePerDay * factor * signalMultiplier)),
      signalMultiplier,
      appliedSignals: active.map((s) => s.label),
    });
  }

  return { from: input.from, to: input.to, baselinePerDay, baselineSource, dowFactors, horizon, signals: input.signals ?? [], method: 'baseline_x_dow' };
}

/**
 * Score a forecast by holding out the last `holdoutDays` of the window: fit on the earlier part, forecast
 * the held-out days, and compare to what actually sold. Returns WAPE and MAE so "the forecast is good" is
 * a bounded number, not a claim. Needs at least one training day before the holdout.
 */
export function backtestForecast(input: {
  readonly history: readonly DailyDemand[];
  readonly from: string;
  readonly to: string;
  readonly holdoutDays: number;
  /** The same signals the live forecast would carry — so a known event in the holdout is scored fairly. */
  readonly signals?: readonly DemandSignal[];
}): Backtest {
  if (!DAY.test(input.from) || !DAY.test(input.to)) {
    throw new InvalidForecastInputError('from and to must be YYYY-MM-DD dates');
  }
  const fromIdx = dayIndex(input.from);
  const toIdx = dayIndex(input.to);
  if (Number.isNaN(fromIdx) || Number.isNaN(toIdx) || toIdx < fromIdx) {
    throw new InvalidForecastInputError('from and to must be real dates with from on or before to');
  }
  const windowDays = toIdx - fromIdx + 1;
  if (!Number.isInteger(input.holdoutDays) || input.holdoutDays < 1 || input.holdoutDays >= windowDays) {
    throw new InvalidForecastInputError('holdoutDays must be between 1 and windowDays − 1 (training needs at least one day)');
  }

  const trainToIdx = toIdx - input.holdoutDays;
  const fit = forecastDemand({
    history: input.history, from: input.from, to: dayOf(trainToIdx), horizonDays: input.holdoutDays,
    ...(input.signals === undefined ? {} : { signals: input.signals }),
  });

  // Actual demand on each held-out day.
  const actualByDay = new Map<string, number>();
  for (const point of input.history) {
    if (!DAY.test(point.day)) continue;
    const idx = dayIndex(point.day);
    if (Number.isNaN(idx) || idx <= trainToIdx || idx > toIdx) continue;
    if (!Number.isFinite(point.qty)) continue;
    actualByDay.set(point.day, (actualByDay.get(point.day) ?? 0) + point.qty);
  }

  let absErr = 0;
  let actualTotal = 0;
  let forecastTotal = 0;
  for (const f of fit.horizon) {
    const actual = actualByDay.get(f.day) ?? 0;
    absErr += Math.abs(actual - f.forecastQty);
    actualTotal += actual;
    forecastTotal += f.forecastQty;
  }

  const wape = actualTotal === 0 ? (forecastTotal === 0 ? 0 : 1) : absErr / actualTotal;
  return { testedDays: input.holdoutDays, wape, mae: absErr / input.holdoutDays, actualTotal, forecastTotal };
}

// ── D-24 (R4, signed OB-227): the short-horizon correction and the back-test of an event's effect ─────────────────────
//
// "The 7-day forecast is corrected from the most recent days' actual sales, with the back-test error shown beside it. An
// effect never back-tested shows as 'manager's estimate'."
//
//   • CORRECTION: fit on the window less its most recent `recentDays`, forecast those recent days (with the same known
//     events), and compare with what actually sold. factor = actual ÷ forecast. The horizon is then scaled by it. A recent
//     forecast of zero has nothing to correct from: the factor stays 1 and says so — never a made-up number.
//   • BACK-TEST of the correction: the same done one step back — correct on the training part, forecast the held-out last
//     `recentDays`, and score both the plain and the corrected forecast against what sold (WAPE). Too short a window to
//     hold out and still correct says "not back-tested", never a zero error.
//   • An EVENT's effect is back-tested on an EARLIER occurrence of it inside the history: baseline fitted on the days
//     before it, forecast over its days with no event, and observed = actual ÷ that forecast. No earlier occurrence in the
//     history → "manager's estimate".

const idx = (d: string): number => Math.floor(Date.parse(`${d}T00:00:00.000Z`) / 86_400_000);
const dayAt = (i: number): string => new Date(i * 86_400_000).toISOString().slice(0, 10);
const actualOn = (history: readonly DailyDemand[], fromI: number, toI: number): Map<string, number> => {
  const m = new Map<string, number>();
  for (const p of history) {
    if (!DAY.test(p.day) || !Number.isFinite(p.qty)) continue;
    const i = idx(p.day);
    if (i >= fromI && i <= toI) m.set(p.day, (m.get(p.day) ?? 0) + p.qty);
  }
  return m;
};

export interface ShortHorizonCorrection {
  readonly recentDays: number;
  readonly recentActual: number;
  readonly recentForecast: number;
  /** actual ÷ forecast over the recent days, rounded to 4 places; 1 when there was no recent forecast to correct. */
  readonly factor: number;
  readonly basis: 'corrected' | 'no_recent_forecast';
}

/** The correction factor from the most recent `recentDays` of [from, to]. Needs at least one training day before them. */
export function shortHorizonCorrection(input: {
  readonly history: readonly DailyDemand[];
  readonly from: string;
  readonly to: string;
  readonly recentDays?: number;
  readonly signals?: readonly DemandSignal[];
}): ShortHorizonCorrection {
  const recentDays = input.recentDays ?? 7;
  if (!DAY.test(input.from) || !DAY.test(input.to)) throw new InvalidForecastInputError('from and to must be YYYY-MM-DD dates');
  const fromI = idx(input.from);
  const toI = idx(input.to);
  if (!Number.isInteger(recentDays) || recentDays < 1 || toI - fromI + 1 <= recentDays) {
    throw new InvalidForecastInputError('the window must be longer than the recent days it is corrected from');
  }
  const fit = forecastDemand({ history: input.history, from: input.from, to: dayAt(toI - recentDays), horizonDays: recentDays, ...(input.signals === undefined ? {} : { signals: input.signals }) });
  const actual = actualOn(input.history, toI - recentDays + 1, toI);
  const recentActual = [...actual.values()].reduce((s, q) => s + q, 0);
  const recentForecast = fit.horizon.reduce((s, d) => s + d.forecastQty, 0);
  if (recentForecast === 0) return { recentDays, recentActual, recentForecast, factor: 1, basis: 'no_recent_forecast' };
  return { recentDays, recentActual, recentForecast, factor: Math.round((recentActual / recentForecast) * 10_000) / 10_000, basis: 'corrected' };
}

export interface CorrectedForecastDay extends ForecastDay {
  /** The forecast after the short-horizon correction, rounded, never negative. */
  readonly correctedQty: number;
}

export interface CorrectionBacktest {
  readonly testedDays: number;
  /** WAPE of the plain forecast on the held-out days. */
  readonly plainWape: number;
  /** WAPE of the corrected forecast on the same days. */
  readonly correctedWape: number;
}

export interface CorrectedForecast {
  readonly forecast: DemandForecast;
  readonly correction: ShortHorizonCorrection;
  readonly horizon: readonly CorrectedForecastDay[];
  /** undefined: the window is too short to hold out the recent days and still correct — "not back-tested". */
  readonly backtest: CorrectionBacktest | undefined;
}

const wapeOf = (forecast: readonly number[], actual: readonly number[]): number => {
  const a = actual.reduce((s, q) => s + q, 0);
  const err = forecast.reduce((s, f, i) => s + Math.abs((actual[i] ?? 0) - f), 0);
  return a === 0 ? (forecast.every((f) => f === 0) ? 0 : 1) : Math.round((err / a) * 10_000) / 10_000;
};

/** The forecast for `horizonDays` after `to`, corrected from the last `recentDays`, with the correction back-tested. */
export function correctedForecast(input: {
  readonly history: readonly DailyDemand[];
  readonly from: string;
  readonly to: string;
  readonly horizonDays: number;
  readonly recentDays?: number;
  readonly signals?: readonly DemandSignal[];
}): CorrectedForecast {
  const recentDays = input.recentDays ?? 7;
  const signals = input.signals === undefined ? {} : { signals: input.signals };
  const forecast = forecastDemand({ history: input.history, from: input.from, to: input.to, horizonDays: input.horizonDays, ...signals });
  const correction = shortHorizonCorrection({ history: input.history, from: input.from, to: input.to, recentDays, ...signals });
  const horizon = forecast.horizon.map((d) => ({ ...d, correctedQty: Math.max(0, Math.round(d.forecastQty * correction.factor)) }));
  const fromI = idx(input.from);
  const toI = idx(input.to);
  let backtest: CorrectionBacktest | undefined;
  if (toI - fromI + 1 > 2 * recentDays) {
    const trainTo = dayAt(toI - recentDays);
    const plain = forecastDemand({ history: input.history, from: input.from, to: trainTo, horizonDays: recentDays, ...signals });
    const c = shortHorizonCorrection({ history: input.history, from: input.from, to: trainTo, recentDays, ...signals });
    const actual = actualOn(input.history, toI - recentDays + 1, toI);
    const actuals = plain.horizon.map((d) => actual.get(d.day) ?? 0);
    backtest = {
      testedDays: recentDays,
      plainWape: wapeOf(plain.horizon.map((d) => d.forecastQty), actuals),
      correctedWape: wapeOf(plain.horizon.map((d) => Math.max(0, Math.round(d.forecastQty * c.factor))), actuals),
    };
  }
  return { forecast, correction, horizon, backtest };
}

export interface EventEffectBacktest {
  /** The earlier occurrence it was measured on. */
  readonly from: string;
  readonly to: string;
  readonly actual: number;
  readonly expectedWithoutEvent: number;
  /** actual ÷ expected without the event, rounded to 4 places. */
  readonly observedMultiplier: number;
}

/**
 * Back-test an event's effect on an earlier occurrence [occFrom, occTo] that lies inside the history window [from, to]:
 * baseline fitted on the window's days BEFORE the occurrence (at least 7), forecast over it with no event. undefined when
 * the occurrence is outside the window, the training part is too short, or nothing was expected (no number is invented).
 */
export function backtestEventEffect(input: {
  readonly history: readonly DailyDemand[];
  readonly from: string;
  readonly to: string;
  readonly occFrom: string;
  readonly occTo: string;
}): EventEffectBacktest | undefined {
  if (![input.from, input.to, input.occFrom, input.occTo].every((d) => DAY.test(d))) return undefined;
  const fromI = idx(input.from);
  const occFromI = idx(input.occFrom);
  const occToI = idx(input.occTo);
  if (occFromI - fromI < 7 || occToI > idx(input.to) || occToI < occFromI) return undefined;
  const fit = forecastDemand({ history: input.history, from: input.from, to: dayAt(occFromI - 1), horizonDays: occToI - occFromI + 1 });
  const expected = fit.horizon.reduce((s, d) => s + d.forecastQty, 0);
  if (expected === 0) return undefined;
  const actual = [...actualOn(input.history, occFromI, occToI).values()].reduce((s, q) => s + q, 0);
  return { from: input.occFrom, to: input.occTo, actual, expectedWithoutEvent: expected, observedMultiplier: Math.round((actual / expected) * 10_000) / 10_000 };
}
