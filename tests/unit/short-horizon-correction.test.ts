import { describe, it, expect } from 'vitest';
import { shortHorizonCorrection, correctedForecast, backtestEventEffect, InvalidForecastInputError, type DailyDemand } from '../../packages/demand/src/forecast';
import { eventsInForce, signalsFor, earlierOccurrences, validateDemandEvent, weatherSignals, WEATHER_FEED_SWITCHED_OFF, InvalidDemandEventError, type DemandEvent, type WeatherFeedPort } from '../../packages/calendar/src/demand-events';

/** D-24 (R4, signed OB-227 · OB-220): the short-horizon correction, its back-test, an event's effect back-tested, the calendar. */
const series = (from: string, days: number, qty: (i: number) => number): DailyDemand[] =>
  Array.from({ length: days }, (_, i) => ({ day: new Date(Date.parse(`${from}T00:00:00.000Z`) + i * 86_400_000).toISOString().slice(0, 10), qty: qty(i) }));

describe('short-horizon correction (D-24)', () => {
  it('scales the forecast by what the most recent days actually sold against what was forecast for them', () => {
    // 28 flat days at 10, then 7 days at 15: the recent week ran 50% above the forecast.
    const history = series('2030-01-01', 35, (i) => (i < 28 ? 10 : 15));
    const c = shortHorizonCorrection({ history, from: '2030-01-01', to: '2030-02-04', recentDays: 7 });
    expect([c.basis, c.recentActual, c.recentForecast, c.factor]).toEqual(['corrected', 105, 70, 1.5]);
    const f = correctedForecast({ history, from: '2030-01-01', to: '2030-02-04', horizonDays: 7 });
    expect(f.horizon).toHaveLength(7);
    for (const d of f.horizon) expect(d.correctedQty).toBe(Math.round(d.forecastQty * 1.5));
  });

  it('back-tests the correction one week back, and says "not back-tested" when the window is too short', () => {
    const history = series('2030-01-01', 35, (i) => (i < 21 ? 10 : 15));
    const f = correctedForecast({ history, from: '2030-01-01', to: '2030-02-04', horizonDays: 7 });
    expect(f.backtest?.testedDays).toBe(7);
    // The level moved up before the held-out week, so the corrected forecast misses less than the plain one.
    expect(f.backtest!.correctedWape).toBeLessThan(f.backtest!.plainWape);
    expect(correctedForecast({ history: series('2030-01-01', 10, () => 10), from: '2030-01-01', to: '2030-01-10', horizonDays: 7 }).backtest).toBeUndefined();
  });

  it('a recent forecast of zero corrects nothing and says so; a window no longer than the recent days is refused', () => {
    const c = shortHorizonCorrection({ history: series('2030-01-01', 14, (i) => (i < 7 ? 0 : 5)), from: '2030-01-01', to: '2030-01-14' });
    expect([c.basis, c.factor]).toEqual(['no_recent_forecast', 1]);
    expect(() => shortHorizonCorrection({ history: [], from: '2030-01-01', to: '2030-01-07' })).toThrow(InvalidForecastInputError);
  });

  it('an event\'s effect is back-tested on an earlier occurrence inside the history; otherwise there is no number', () => {
    const history = series('2030-01-01', 40, (i) => (i === 20 ? 25 : 10));
    expect(backtestEventEffect({ history, from: '2030-01-01', to: '2030-02-09', occFrom: '2030-01-21', occTo: '2030-01-21' })?.observedMultiplier).toBe(2.5);
    expect(backtestEventEffect({ history, from: '2030-01-01', to: '2030-02-09', occFrom: '2030-01-03', occTo: '2030-01-03' })).toBeUndefined(); // too little before it
    expect(backtestEventEffect({ history, from: '2030-01-10', to: '2030-02-09', occFrom: '2029-12-20', occTo: '2029-12-20' })).toBeUndefined(); // outside the history
  });
});

const ev = (over: Partial<DemandEvent>): DemandEvent => ({ eventId: 'e1', version: 1, storeId: 'S1', label: 'Pongal', kind: 'festival', from: '2030-01-14', to: '2030-01-15', multiplier: 1.5, recordedBy: 'u-mgr', recordedAt: '2030-01-01T00:00:00.000Z', ...over });

describe('the store event calendar (D-24)', () => {
  it('the latest version is in force; a withdrawn event is not; signals carry the event\'s name', () => {
    const all = [ev({}), ev({ version: 2, multiplier: 1.8 }), ev({ eventId: 'e2', label: 'Temple car festival' }), ev({ eventId: 'e2', version: 2, label: 'Temple car festival', withdrawn: { by: 'u-mgr', at: '2030-01-02T00:00:00.000Z', reason: 'cancelled' } })];
    expect(eventsInForce(all).map((e) => [e.eventId, e.multiplier])).toEqual([['e1', 1.8]]);
    expect(signalsFor(all, { productId: 'p-tea', fromDay: '2030-01-01', toDay: '2030-01-31' })).toEqual([{ from: '2030-01-14', to: '2030-01-15', multiplier: 1.8, label: 'Pongal', eventId: 'e1' }]);
  });

  it('an event for named products or categories reaches only those (a category reaches its children)', () => {
    const all = [ev({ productIds: ['p-sugar'] }), ev({ eventId: 'e2', label: 'Market day', categoryIds: ['grocery'] })];
    expect(signalsFor(all, { productId: 'p-tea', categoryChain: ['tea', 'grocery'], fromDay: '2030-01-01', toDay: '2030-01-31' }).map((s) => s.label)).toEqual(['Market day']);
    expect(signalsFor(all, { productId: 'p-sugar', fromDay: '2030-01-01', toDay: '2030-01-31' }).map((s) => s.label)).toEqual(['Pongal']);
    expect(signalsFor(all, { productId: 'p-soap', categoryChain: ['household'], fromDay: '2030-01-01', toDay: '2030-01-31' })).toEqual([]);
  });

  it('earlier occurrences are the same name at the same store, ended before', () => {
    const all = [ev({ eventId: 'last', from: '2029-01-14', to: '2029-01-15', label: '  pongal ' }), ev({}), ev({ eventId: 'other-store', storeId: 'S2', from: '2029-01-14', to: '2029-01-15' })];
    expect(earlierOccurrences(all, ev({}), '2030-01-14').map((e) => e.eventId)).toEqual(['last']);
  });

  it('refuses an event without a name, with days the wrong way round, or with an effect that is not a positive number', () => {
    expect(() => validateDemandEvent({ label: '', kind: 'festival', from: '2030-01-01', to: '2030-01-01', multiplier: 1.2 })).toThrow(InvalidDemandEventError);
    expect(() => validateDemandEvent({ label: 'X', kind: 'festival', from: '2030-01-02', to: '2030-01-01', multiplier: 1.2 })).toThrow(InvalidDemandEventError);
    expect(() => validateDemandEvent({ label: 'X', kind: 'festival', from: '2030-02-30', to: '2030-03-01', multiplier: 1.2 })).toThrow(InvalidDemandEventError);
    expect(() => validateDemandEvent({ label: 'X', kind: 'festival', from: '2030-01-01', to: '2030-01-01', multiplier: 0 })).toThrow(InvalidDemandEventError);
  });

  it('the weather link is switched off: nothing is fetched or sent; only a stand-in that is switched on is asked', async () => {
    const off = await weatherSignals(WEATHER_FEED_SWITCHED_OFF, 'S1', '2030-01-01', '2030-01-07');
    expect([off.state, off.signals]).toEqual(['switched_off', []]);
    let asked = 0;
    const offStandIn: WeatherFeedPort = { name: 'stand-in', switchedOn: false, fetch: async () => { asked += 1; return []; } };
    await weatherSignals(offStandIn, 'S1', '2030-01-01', '2030-01-07');
    expect(asked).toBe(0);
    const onStandIn: WeatherFeedPort = { name: 'stand-in', switchedOn: true, fetch: async () => { asked += 1; return [{ from: '2030-01-03', to: '2030-01-03', multiplier: 0.7, label: 'heavy rain' }]; } };
    const on = await weatherSignals(onStandIn, 'S1', '2030-01-01', '2030-01-07');
    expect([on.state, on.signals.length, asked]).toEqual(['on', 1, 1]);
  });
});
