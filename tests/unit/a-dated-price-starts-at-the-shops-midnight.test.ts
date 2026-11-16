import { describe, it, expect } from 'vitest';
import { shopDayStartsAt } from '../../services/api/src/lp-workforce-adapters';

/**
 * **A dated price starts at the shop's midnight, never midnight UTC (R1c · OB-806 · D-026).** Tamil Nadu is UTC+05:30: a
 * price "from 17 Nov" is in force from 16 Nov 18:30 UTC. Read as UTC midnight it was "not yet in force" for the shop's
 * first five and a half hours, so its shelf-label task did not fall due and an older task was not shown as replaced.
 */
describe('a dated price-list entry starts at the start of the shop\'s day', () => {
  it('today on the shop\'s clock, though still yesterday in UTC: in force now', () => {
    expect(shopDayStartsAt('2026-11-17', '2026-11-16T19:15:00.000Z')).toBe('2026-11-16T19:15:00.000Z');
  });
  it('a later shop day: due at that day\'s first instant in the shop (18:30 UTC the evening before)', () => {
    expect(shopDayStartsAt('2026-11-18', '2026-11-16T10:00:00.000Z')).toBe('2026-11-17T18:30:00.000Z');
  });
  it('a past day, or a full instant, keeps the old rule: never before now', () => {
    expect(shopDayStartsAt('2026-11-01', '2026-11-16T10:00:00.000Z')).toBe('2026-11-16T10:00:00.000Z');
    expect(shopDayStartsAt('2026-11-20T06:00:00.000Z', '2026-11-16T10:00:00.000Z')).toBe('2026-11-20T06:00:00.000Z');
    expect(shopDayStartsAt('not a date', '2026-11-16T10:00:00.000Z')).toBe('2026-11-16T10:00:00.000Z');
  });
});
