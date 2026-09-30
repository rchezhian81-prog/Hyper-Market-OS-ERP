import { describe, it, expect } from 'vitest';
import {
  tradingDate,
  makeTradingDayRule,
  wallClockIn,
  tradingDateOf,
} from '../../packages/calendar/src/index';

// The trading day is an explicit rule (M01-FR-02): a moment before the cut-off
// belongs to the previous calendar day's trading day. Roadmap acceptance: a sale
// at 00:30 falls in the correct trading day per the configured rule.

describe('makeTradingDayRule', () => {
  it('parses an HH:MM cut-off to minutes', () => {
    expect(makeTradingDayRule('00:00').cutoffMinutes).toBe(0);
    expect(makeTradingDayRule('02:00').cutoffMinutes).toBe(120);
    expect(makeTradingDayRule('23:59').cutoffMinutes).toBe(1439);
  });

  it('rejects an invalid cut-off', () => {
    expect(() => makeTradingDayRule('2:00')).toThrow(RangeError);
    expect(() => makeTradingDayRule('24:00')).toThrow(RangeError);
    expect(() => makeTradingDayRule('02:60')).toThrow(RangeError);
  });
});

describe('tradingDate', () => {
  const midnight = makeTradingDayRule('00:00');
  const twoAm = makeTradingDayRule('02:00');

  it('with a midnight cut-off, the trading date is the calendar date', () => {
    expect(tradingDate('2026-08-02T00:30', midnight)).toBe('2026-08-02');
    expect(tradingDate('2026-08-02T23:59', midnight)).toBe('2026-08-02');
  });

  it('with a 2 am cut-off, a moment before 2 am belongs to the previous day', () => {
    expect(tradingDate('2026-08-02T00:30', twoAm)).toBe('2026-08-01');
    expect(tradingDate('2026-08-02T01:59', twoAm)).toBe('2026-08-01');
    // exactly at the cut-off belongs to the new day
    expect(tradingDate('2026-08-02T02:00', twoAm)).toBe('2026-08-02');
    expect(tradingDate('2026-08-02T09:00', twoAm)).toBe('2026-08-02');
  });

  it('rolls back across a month and a year boundary', () => {
    expect(tradingDate('2026-03-01T00:30', twoAm)).toBe('2026-02-28');
    expect(tradingDate('2026-01-01T00:30', twoAm)).toBe('2025-12-31');
  });

  it('accepts seconds and rejects malformed input', () => {
    expect(tradingDate('2026-08-02T02:00:30', twoAm)).toBe('2026-08-02');
    expect(() => tradingDate('2026-08-02 02:00', twoAm)).toThrow(RangeError);
    expect(() => tradingDate('not-a-date', twoAm)).toThrow(RangeError);
  });
});

describe('wallClockIn / tradingDateOf — the day is dated in the SHOP\'s wall clock, never in UTC (SP-4b · F09)', () => {
  it('turns an instant into the local wall-clock moment of a named zone', () => {
    // 19:30 UTC on 30 Sep is 01:00 on 1 Oct in Tamil Nadu.
    expect(wallClockIn('2026-09-30T19:30:00.000Z', 'Asia/Kolkata')).toBe('2026-10-01T01:00');
    expect(wallClockIn('2026-09-30T19:30:00.000Z', 'UTC')).toBe('2026-09-30T19:30');
    // Midnight is 00, never 24.
    expect(wallClockIn('2026-09-30T18:30:00.000Z', 'Asia/Kolkata')).toBe('2026-10-01T00:00');
  });

  it('dates a sale to the trading day of the SHOP: 01:00 IST with a 02:00 cut-off is still the previous day; 02:30 is the new one', () => {
    const rule = makeTradingDayRule('02:00');
    expect(tradingDateOf('2026-09-30T19:30:00.000Z', rule, 'Asia/Kolkata')).toBe('2026-09-30'); // 01:00 IST on 1 Oct → 30 Sep
    expect(tradingDateOf('2026-09-30T21:00:00.000Z', rule, 'Asia/Kolkata')).toBe('2026-10-01'); // 02:30 IST on 1 Oct → 1 Oct
    // Dated in UTC the same instants land a day out — the defect this closes.
    expect(tradingDate('2026-09-30T19:30:00.000Z'.slice(0, 16), rule)).toBe('2026-09-30');
    expect(tradingDate('2026-09-30T21:00:00.000Z'.slice(0, 16), rule)).toBe('2026-09-30');
  });

  it('refuses a moment that is not an instant', () => {
    expect(() => wallClockIn('yesterday')).toThrow(RangeError);
  });
});
