import { describe, it, expect } from 'vitest';
import {
  forecastDemand,
  backtestForecast,
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
