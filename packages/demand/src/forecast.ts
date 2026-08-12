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

/** One forecast day. */
export interface ForecastDay {
  readonly day: string;
  /** 0 = Sunday … 6 = Saturday. */
  readonly dow: number;
  /** baseline × the day's seasonality factor, rounded, never negative. */
  readonly forecastQty: number;
}

export interface DemandForecast {
  /** The fit window (YYYY-MM-DD, inclusive) the forecast learned from. */
  readonly from: string;
  readonly to: string;
  /** The average daily demand over the fit window — the level the seasonality multiplies. */
  readonly baselinePerDay: number;
  /** Seven day-of-week multipliers, index 0 = Sunday … 6 = Saturday; ~1 is an average day. */
  readonly dowFactors: readonly number[];
  /** The projected days after `to`. */
  readonly horizon: readonly ForecastDay[];
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

  const baselinePerDay = total / windowDays;
  // factor = this weekday's mean ÷ the overall mean. Baseline 0 (or a weekday never seen in the window)
  // carries no signal, so its factor is a neutral 1.
  const dowFactors = dowSum.map((sum, d) => {
    const count = dowCount[d] ?? 0;
    return baselinePerDay === 0 || count === 0 ? 1 : (sum / count) / baselinePerDay;
  });

  const horizon: ForecastDay[] = [];
  for (let i = 1; i <= input.horizonDays; i += 1) {
    const idx = toIdx + i;
    const dow = dowOfIndex(idx);
    const factor = dowFactors[dow] ?? 1;
    horizon.push({ day: dayOf(idx), dow, forecastQty: Math.max(0, Math.round(baselinePerDay * factor)) });
  }

  return { from: input.from, to: input.to, baselinePerDay, dowFactors, horizon, method: 'baseline_x_dow' };
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
  const fit = forecastDemand({ history: input.history, from: input.from, to: dayOf(trainToIdx), horizonDays: input.holdoutDays });

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
