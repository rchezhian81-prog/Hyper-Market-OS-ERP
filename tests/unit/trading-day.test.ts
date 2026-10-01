import { describe, it, expect } from 'vitest';
import {
  tradingDate,
  makeTradingDayRule,
  wallClockIn,
  tradingDateOf,
  instantOf,
  tradingDayIn,
  tradingDayWindow,
  shiftDate,
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

describe('the shop\'s calendar at head office — instantOf / tradingDayIn / tradingDayWindow (SP-9-i-c · F14 · M01-FR-02)', () => {
  const IST_0200 = { timeZone: 'Asia/Kolkata', tradingDayCutoff: '02:00' };
  const IST_MIDNIGHT = { timeZone: 'Asia/Kolkata', tradingDayCutoff: '00:00' };
  const UTC = { timeZone: 'UTC', tradingDayCutoff: '00:00' };

  it('instantOf: the moment a zone\'s wall clock reads a local time', () => {
    expect(instantOf('2026-08-10T02:00', 'Asia/Kolkata')).toBe('2026-08-09T20:30:00.000Z');
    expect(instantOf('2026-08-10T00:00', 'UTC')).toBe('2026-08-10T00:00:00.000Z');
    expect(instantOf('2026-07-01T12:00', 'Europe/London')).toBe('2026-07-01T11:00:00.000Z'); // summer time
    expect(instantOf('2026-01-01T12:00', 'Europe/London')).toBe('2026-01-01T12:00:00.000Z'); // winter
    expect(() => instantOf('2026-08-10 02:00', 'UTC')).toThrow(RangeError);
  });

  it('tradingDayIn: 20:00 UTC on the 10th is 01:30 IST on the 11th — the 11th with a midnight cut-off, still the 10th with a 02:00 one, the 10th in UTC', () => {
    const late = '2026-08-10T20:00:00.000Z';
    expect(tradingDayIn(late, IST_MIDNIGHT)).toBe('2026-08-11');
    expect(tradingDayIn(late, IST_0200)).toBe('2026-08-10');
    expect(tradingDayIn(late, UTC)).toBe('2026-08-10');
  });

  it('tradingDayWindow: a trading day runs from the shop\'s cut-off to the next one, in the shop\'s zone — and agrees with tradingDayIn at both edges', () => {
    const window = tradingDayWindow('2026-08-10', IST_0200);
    expect(window).toEqual({ from: '2026-08-09T20:30:00.000Z', to: '2026-08-10T20:30:00.000Z' });
    expect(tradingDayIn(window.from, IST_0200)).toBe('2026-08-10');
    expect(tradingDayIn('2026-08-10T20:29:59.000Z', IST_0200)).toBe('2026-08-10');
    expect(tradingDayIn(window.to, IST_0200)).toBe('2026-08-11');
    expect(tradingDayWindow('2026-08-10', UTC)).toEqual({ from: '2026-08-10T00:00:00.000Z', to: '2026-08-11T00:00:00.000Z' });
    expect(() => tradingDayWindow('2026-08-10', { timeZone: 'UTC', tradingDayCutoff: '2:00' })).toThrow(RangeError);
  });

  it('shiftDate: calendar arithmetic across month and year ends, both ways', () => {
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(() => shiftDate('yesterday', 1)).toThrow(RangeError);
  });
});
