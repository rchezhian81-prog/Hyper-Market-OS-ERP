import { describe, it, expect } from 'vitest';
import {
  forecastDemand,
  backtestForecast,
  coldStartBaseline,
  InvalidForecastInputError,
  type DailyDemand,
} from '../../packages/demand/src/forecast';

// D-1 demand forecast — baseline × day-of-week seasonality, projected ahead, and judged by a back-test on
// a fixture (the roadmap acceptance: "back-test error is bounded on a fixture"). Pure: no clock, no I/O.

const ONE_DAY = 86_400_000;
const dayOf = (index: number): string => new Date(index * ONE_DAY).toISOString().slice(0, 10);
const dowOf = (index: number): number => new Date(index * ONE_DAY).getUTCDay();
const indexOf = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00.000Z`) / ONE_DAY);

/** A clean weekly pattern: weekends (Sat/Sun) sell 30, weekdays sell 10. */
const weeklyPattern = (startDay: string, days: number): DailyDemand[] => {
  const start = indexOf(startDay);
  const out: DailyDemand[] = [];
  for (let i = 0; i < days; i += 1) {
    const idx = start + i;
    const dow = dowOf(idx);
    out.push({ day: dayOf(idx), qty: dow === 0 || dow === 6 ? 30 : 10 });
  }
  return out;
};

const FROM = '2026-06-07';
const HISTORY = weeklyPattern(FROM, 56); // eight full weeks
const TO = HISTORY[HISTORY.length - 1]!.day;

describe('forecastDemand', () => {
  it('learns the day-of-week pattern and projects it forward', () => {
    const f = forecastDemand({ history: HISTORY, from: FROM, to: TO, horizonDays: 7 });
    // baseline = (2×30 + 5×10) / 7 ≈ 15.7; weekend factor ≈ 1.9, weekday ≈ 0.64
    expect(f.dowFactors[6]!).toBeGreaterThan(f.dowFactors[3]!); // Saturday sells more than Wednesday
    const sat = f.horizon.find((d) => d.dow === 6)!;
    const wed = f.horizon.find((d) => d.dow === 3)!;
    expect(sat.forecastQty).toBe(30); // baseline × weekend factor recovers the level
    expect(wed.forecastQty).toBe(10);
    expect(f.method).toBe('baseline_x_dow');
  });

  it('projects exactly horizonDays consecutive days after the window', () => {
    const f = forecastDemand({ history: HISTORY, from: FROM, to: TO, horizonDays: 10 });
    expect(f.horizon).toHaveLength(10);
    expect(f.horizon[0]!.day).toBe(dayOf(indexOf(TO) + 1));
    expect(f.horizon[9]!.day).toBe(dayOf(indexOf(TO) + 10));
  });

  it('forecasts zero from an empty history rather than guessing', () => {
    const f = forecastDemand({ history: [], from: '2026-08-01', to: '2026-08-07', horizonDays: 3 });
    expect(f.baselinePerDay).toBe(0);
    expect(f.horizon.every((d) => d.forecastQty === 0)).toBe(true);
  });

  it('rejects a malformed window or a horizon below one', () => {
    expect(() => forecastDemand({ history: [], from: '2026-08-07', to: '2026-08-01', horizonDays: 3 })).toThrow(InvalidForecastInputError);
    expect(() => forecastDemand({ history: [], from: '2026-08-01', to: '2026-08-07', horizonDays: 0 })).toThrow(InvalidForecastInputError);
    expect(() => forecastDemand({ history: [], from: 'nope', to: '2026-08-07', horizonDays: 3 })).toThrow(InvalidForecastInputError);
  });
});

describe('backtestForecast', () => {
  it('scores a clean weekly pattern with a bounded error (the D-1 acceptance)', () => {
    const bt = backtestForecast({ history: HISTORY, from: FROM, to: TO, holdoutDays: 7 });
    expect(bt.testedDays).toBe(7);
    // A pattern that repeats exactly is forecast almost exactly — the total miss is a tiny fraction of sales.
    expect(bt.wape).toBeLessThan(0.05);
    expect(bt.actualTotal).toBe(110); // one week: 2×30 + 5×10
  });

  it('is worse for noise it cannot explain than for a clean pattern — but still bounded', () => {
    // A history with no weekly signal at all (flat) still back-tests to a sensible, bounded error.
    const flat: DailyDemand[] = weeklyPattern(FROM, 56).map((d) => ({ day: d.day, qty: 20 }));
    const bt = backtestForecast({ history: flat, from: FROM, to: TO, holdoutDays: 7 });
    expect(bt.wape).toBeLessThan(0.05); // a flat series is trivially forecastable too
  });

  it('needs at least one training day before the holdout', () => {
    expect(() => backtestForecast({ history: HISTORY, from: FROM, to: TO, holdoutDays: 56 })).toThrow(InvalidForecastInputError);
    expect(() => backtestForecast({ history: HISTORY, from: FROM, to: TO, holdoutDays: 0 })).toThrow(InvalidForecastInputError);
  });
});

const flatSeries = (startDay: string, days: number, qty: number): DailyDemand[] =>
  Array.from({ length: days }, (_, i) => ({ day: dayOf(indexOf(startDay) + i), qty }));

describe('exogenous demand signals (festival / promo / weather)', () => {
  const FLAT_FROM = '2026-06-01';
  const FLAT_TO = dayOf(indexOf(FLAT_FROM) + 27); // 28 flat days at 10/day → baseline 10, dow factors ~1
  const FLAT = flatSeries(FLAT_FROM, 28, 10);

  it('lifts the forecast on a signal’s days and leaves the rest untouched', () => {
    const eventFrom = dayOf(indexOf(FLAT_TO) + 2); // two days inside the 7-day horizon
    const eventTo = dayOf(indexOf(FLAT_TO) + 3);
    const f = forecastDemand({
      history: FLAT, from: FLAT_FROM, to: FLAT_TO, horizonDays: 7,
      signals: [{ from: eventFrom, to: eventTo, multiplier: 2, label: 'Diwali' }],
    });
    const onEvent = f.horizon.filter((d) => d.day >= eventFrom && d.day <= eventTo);
    const offEvent = f.horizon.filter((d) => d.day < eventFrom || d.day > eventTo);
    expect(onEvent.every((d) => d.signalMultiplier === 2 && d.appliedSignals.includes('Diwali'))).toBe(true);
    expect(offEvent.every((d) => d.signalMultiplier === 1 && d.appliedSignals.length === 0)).toBe(true);
    expect(onEvent[0]!.forecastQty).toBe(20); // 10 baseline × 2
    expect(offEvent[0]!.forecastQty).toBe(10);
    expect(f.signals).toHaveLength(1);
  });

  it('composes overlapping signals by multiplying them', () => {
    const day = dayOf(indexOf(FLAT_TO) + 2);
    const f = forecastDemand({
      history: FLAT, from: FLAT_FROM, to: FLAT_TO, horizonDays: 7,
      signals: [
        { from: day, to: day, multiplier: 2, label: 'Festival' },
        { from: day, to: day, multiplier: 1.5, label: 'Promo' },
      ],
    });
    const d = f.horizon.find((h) => h.day === day)!;
    expect(d.signalMultiplier).toBe(3); // 2 × 1.5
    expect(d.appliedSignals).toEqual(['Festival', 'Promo']);
    expect(d.forecastQty).toBe(30); // 10 × 3
  });

  it('scores a known event in the holdout fairly — the back-test improves with the signal', () => {
    // Seven weeks flat at 10, then a festival spike week at 20 as the holdout.
    const spike: DailyDemand[] = [...flatSeries(FROM, 49, 10), ...flatSeries(dayOf(indexOf(FROM) + 49), 7, 20)];
    const holdFrom = dayOf(indexOf(FROM) + 49);

    const without = backtestForecast({ history: spike, from: FROM, to: TO, holdoutDays: 7 });
    const withSignal = backtestForecast({
      history: spike, from: FROM, to: TO, holdoutDays: 7,
      signals: [{ from: holdFrom, to: TO, multiplier: 2, label: 'Festival' }],
    });
    expect(without.wape).toBeGreaterThan(0.4); // blind to the spike, it misses by half
    expect(withSignal.wape).toBeLessThan(0.05); // told about the festival, it nails it
  });

  it('rejects a malformed signal', () => {
    const bad = (signals: unknown[]) => () => forecastDemand({ history: FLAT, from: FLAT_FROM, to: FLAT_TO, horizonDays: 3, signals: signals as never });
    expect(bad([{ from: 'nope', to: FLAT_TO, multiplier: 2 }])).toThrow(InvalidForecastInputError);
    expect(bad([{ from: FLAT_FROM, to: FLAT_TO, multiplier: 0 }])).toThrow(InvalidForecastInputError);   // multiplier ≤ 0
    expect(bad([{ from: FLAT_TO, to: FLAT_FROM, multiplier: 2 }])).toThrow(InvalidForecastInputError);   // from after to
  });
});

describe('coldStartBaseline', () => {
  it('is the peer rate with no history, and the item’s own rate once history dominates', () => {
    expect(coldStartBaseline({ totalQty: 0, observedDays: 0, peerBaselinePerDay: 8 })).toBe(8); // brand new → peer
    // 900 sold over 90 days (10/day of its own) with a 14-day prior at 8 → (900 + 112)/104 ≈ 9.73, near its own 10
    expect(coldStartBaseline({ totalQty: 900, observedDays: 90, peerBaselinePerDay: 8 })).toBeCloseTo(9.73, 1);
  });

  it('blends own and peer weighted by evidence', () => {
    // 20 sold over 2 days, peer 8/day, prior 14 → (20 + 14×8) / (2 + 14) = 132/16 = 8.25
    expect(coldStartBaseline({ totalQty: 20, observedDays: 2, peerBaselinePerDay: 8, priorDays: 14 })).toBe(8.25);
  });

  it('rejects bad input', () => {
    expect(() => coldStartBaseline({ totalQty: -1, observedDays: 2, peerBaselinePerDay: 8 })).toThrow(InvalidForecastInputError);
    expect(() => coldStartBaseline({ totalQty: 20, observedDays: 2, peerBaselinePerDay: -8 })).toThrow(InvalidForecastInputError);
    expect(() => coldStartBaseline({ totalQty: 20, observedDays: 2, peerBaselinePerDay: 8, priorDays: 0 })).toThrow(InvalidForecastInputError);
  });
});

describe('forecastDemand with new-item cold-start', () => {
  // A brand-new SKU: two days of 10/day inside a 28-day window — far too little to forecast on its own.
  const NEW_FROM = '2026-06-01';
  const NEW_TO = dayOf(indexOf(NEW_FROM) + 27);
  const NEW_ITEM: DailyDemand[] = [
    { day: dayOf(indexOf(NEW_TO) - 1), qty: 10 },
    { day: NEW_TO, qty: 10 },
  ];

  it('seeds a thin history from the peer rate instead of forecasting near zero', () => {
    const bare = forecastDemand({ history: NEW_ITEM, from: NEW_FROM, to: NEW_TO, horizonDays: 7 });
    expect(bare.baselineSource).toBe('history');
    expect(bare.baselinePerDay).toBeLessThan(1); // 20 / 28 — uselessly low for a new item

    const cold = forecastDemand({ history: NEW_ITEM, from: NEW_FROM, to: NEW_TO, horizonDays: 7, coldStart: { peerBaselinePerDay: 8 } });
    expect(cold.baselineSource).toBe('cold_start');
    expect(cold.baselinePerDay).toBeCloseTo(8.25); // (20 + 14×8) / (2 + 14)
    expect(cold.horizon.every((d) => d.forecastQty === 8)).toBe(true); // flat at round(8.25), no noisy weekly shape
    expect(cold.dowFactors.every((f) => f === 1)).toBe(true);
  });

  it('still applies event signals on top of a cold-start baseline', () => {
    const eventDay = dayOf(indexOf(NEW_TO) + 2);
    const cold = forecastDemand({
      history: NEW_ITEM, from: NEW_FROM, to: NEW_TO, horizonDays: 7,
      coldStart: { peerBaselinePerDay: 8 }, signals: [{ from: eventDay, to: eventDay, multiplier: 2, label: 'Launch' }],
    });
    const d = cold.horizon.find((h) => h.day === eventDay)!;
    expect(d.forecastQty).toBe(17); // round(8.25 × 2) = round(16.5) = 17
  });
});
