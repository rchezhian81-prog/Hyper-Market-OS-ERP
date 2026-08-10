import { describe, it, expect } from 'vitest';
import { resolveGstRate, InvalidRateSchedule } from '../../packages/finance/src/rate';

// Roadmap v2.1 A6 — the GST rate in force on the TIME OF SUPPLY, from a per-HSN effective-dated schedule.
// The boundary is the whole point: a supply on the day a new rate takes effect gets the new rate; the
// day before gets the old one.

// An HSN that moved from 18% to a 40% demerit rate on 1 Sep 2026 (an illustrative GST-2.0-style change).
const SCHEDULE = [
  { effectiveFrom: '2017-07-01', rateBps: 1800 },
  { effectiveFrom: '2026-09-01', rateBps: 4000 },
];

describe('resolveGstRate — A6: rate in force on the supply date', () => {
  it('applies the OLD rate the day before a change and the NEW rate on the day it takes effect', () => {
    expect(resolveGstRate({ schedule: SCHEDULE, supplyDate: '2026-08-31' }).rateBps).toBe(1800);
    expect(resolveGstRate({ schedule: SCHEDULE, supplyDate: '2026-09-01' }).rateBps).toBe(4000); // inclusive
    expect(resolveGstRate({ schedule: SCHEDULE, supplyDate: '2026-09-02' }).rateBps).toBe(4000);
  });

  it('reports which period applied', () => {
    const r = resolveGstRate({ schedule: SCHEDULE, supplyDate: '2020-01-01' });
    expect(r.rateBps).toBe(1800);
    expect(r.effectiveFrom).toBe('2017-07-01');
    expect(r.supplyDate).toBe('2020-01-01');
  });

  it('resolves regardless of the order the periods are given in', () => {
    const shuffled = [{ effectiveFrom: '2026-09-01', rateBps: 4000 }, { effectiveFrom: '2017-07-01', rateBps: 1800 }];
    expect(resolveGstRate({ schedule: shuffled, supplyDate: '2026-08-31' }).rateBps).toBe(1800);
  });

  it('refuses a supply date before the earliest rate rather than guess one', () => {
    expect(() => resolveGstRate({ schedule: SCHEDULE, supplyDate: '2017-06-30' })).toThrow(InvalidRateSchedule);
  });

  it('refuses an empty schedule, a bad date, a negative rate, and an ambiguous duplicate effective date', () => {
    expect(() => resolveGstRate({ schedule: [], supplyDate: '2026-09-01' })).toThrow(InvalidRateSchedule);
    expect(() => resolveGstRate({ schedule: SCHEDULE, supplyDate: 'Sept' })).toThrow(InvalidRateSchedule);
    expect(() => resolveGstRate({ schedule: [{ effectiveFrom: '2020-01-01', rateBps: -5 }], supplyDate: '2026-01-01' })).toThrow(InvalidRateSchedule);
    expect(() => resolveGstRate({
      schedule: [{ effectiveFrom: '2026-09-01', rateBps: 1800 }, { effectiveFrom: '2026-09-01', rateBps: 4000 }],
      supplyDate: '2026-09-02',
    })).toThrow(InvalidRateSchedule);
  });
});
