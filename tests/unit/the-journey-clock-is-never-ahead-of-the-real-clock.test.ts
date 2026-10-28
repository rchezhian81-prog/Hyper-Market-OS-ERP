import { describe, it, expect, afterEach, vi } from 'vitest';
import { startTheJourneyMidMorning, JOURNEY_STARTS_AT } from '../support/trading-day-clock';

// The scripted store-day journeys pin `Date` to 10:00 UTC. TLS checks the handheld door's certificate against the REAL
// clock, and the store computer dates that certificate from `Date` (valid from an hour before). Pinned ahead of the real
// clock — a run between 00:00 and 09:00 UTC — the phone's connection was refused "certificate is not yet valid" (main,
// 28 Oct 2026, 01:10 UTC). The pinned moment must never be ahead of the real one.

const pinnedAt = (realIso: string): { pinned: number; real: number; day: string } => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(realIso));
  const real = Date.now();
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(real));
  const day = startTheJourneyMidMorning();
  return { pinned: Date.now(), real, day };
};

describe('the journey clock is pinned to mid-morning and never ahead of the real clock', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('at 01:10 UTC (the failed run) it is yesterday at 10:00, before the real clock', () => {
    const { pinned, real, day } = pinnedAt('2026-10-28T01:10:00.000Z');
    expect(new Date(pinned).toISOString().slice(11, 16)).toBe(JOURNEY_STARTS_AT);
    expect(day).toBe('2026-10-27');
    expect(pinned).toBeLessThanOrEqual(real);
    // The handheld door's certificate is valid from an hour before the pinned moment: already valid by the real clock.
    expect(pinned - 3_600_000).toBeLessThan(real);
  });

  it('at 15:00 UTC it is today at 10:00', () => {
    const { pinned, real, day } = pinnedAt('2026-10-28T15:00:00.000Z');
    expect(day).toBe('2026-10-28');
    expect(new Date(pinned).toISOString()).toBe('2026-10-28T10:00:00.000Z');
    expect(pinned).toBeLessThanOrEqual(real);
  });

  it('exactly at 10:00 UTC it is that moment, and one millisecond before it is yesterday', () => {
    expect(new Date(pinnedAt('2026-10-28T10:00:00.000Z').pinned).toISOString()).toBe('2026-10-28T10:00:00.000Z');
    expect(pinnedAt('2026-10-28T09:59:59.999Z').day).toBe('2026-10-27');
  });

  it('across a month and a year boundary it steps back to the right day', () => {
    expect(pinnedAt('2026-11-01T03:00:00.000Z').day).toBe('2026-10-31');
    expect(pinnedAt('2027-01-01T00:30:00.000Z').day).toBe('2026-12-31');
  });
});
