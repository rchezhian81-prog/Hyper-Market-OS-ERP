import { describe, it, expect } from 'vitest';
import * as markdownModule from '../../packages/demand/src/markdown';
import {
  proposeMarkdown,
  DEFAULT_MARKDOWN_LADDER,
  InvalidMarkdownInputError,
} from '../../packages/demand/src/markdown';

// D-4 expiry markdown ladder — from remaining shelf life (how deep) + sell-through (whether at all).
// Advisory only; a person commits (hard rule #5). Pure: no clock, no I/O.

const base = {
  productId: 'MILK', remainingShelfLifeDays: 2, onHandMinor: 100, avgDailyDemandMinor: 5, currentPriceMinor: 10_000,
};

describe('proposeMarkdown', () => {
  it('proposes no markdown when the whole holding will clear before the use-by', () => {
    // 10/day × 3 days = 30 ≥ 12 on hand → it all sells, so a markdown is margin given away.
    const p = proposeMarkdown({ ...base, remainingShelfLifeDays: 3, onHandMinor: 12, avgDailyDemandMinor: 10 });
    expect(p.reason).toBe('will_clear');
    expect(p.markdownBps).toBe(0);
    expect(p.newPriceMinor).toBe(10_000); // unchanged
    expect(p.surplusMinor).toBe(0);
  });

  it('marks down the surplus that will not clear, deepening as the use-by nears', () => {
    // 5/day × 2 days = 10 will sell; 90 of 100 will not → mark down. 2 days left → the 25% rung.
    const p = proposeMarkdown(base);
    expect(p.reason).toBe('marked_down');
    expect(p.surplusMinor).toBe(90);
    expect(p.markdownBps).toBe(2500);
    expect(p.newPriceMinor).toBe(7_500); // 10000 × (1 − 0.25)
    expect(p.advisoryOnly).toBe(true);
  });

  it('walks the default ladder: 10% within a week, 25% within three days, 50% on the last day', () => {
    const at = (days: number) => proposeMarkdown({ ...base, remainingShelfLifeDays: days, onHandMinor: 100, avgDailyDemandMinor: 0 }).markdownBps;
    expect(at(7)).toBe(1000);
    expect(at(3)).toBe(2500);
    expect(at(1)).toBe(5000);
    expect(at(5)).toBe(1000); // between rungs → the 7-day rung
  });

  it('holds off (too_early) when a surplus exists but the use-by is still outside the ladder', () => {
    // 8 days left is beyond the deepest 7-day rung; there is a surplus but it is not yet time.
    const p = proposeMarkdown({ ...base, remainingShelfLifeDays: 8, onHandMinor: 100, avgDailyDemandMinor: 0 });
    expect(p.reason).toBe('too_early');
    expect(p.markdownBps).toBe(0);
  });

  it('honours a supplied policy over the default ladder', () => {
    const policy = { ladder: [{ maxDaysLeft: 2, markdownBps: 4000 }] };
    const p = proposeMarkdown({ ...base, policy });
    expect(p.markdownBps).toBe(4000);
    expect(p.newPriceMinor).toBe(6_000);
  });

  it('rejects bad input and a malformed policy', () => {
    expect(() => proposeMarkdown({ ...base, currentPriceMinor: 0 })).toThrow(InvalidMarkdownInputError);
    expect(() => proposeMarkdown({ ...base, onHandMinor: -1 })).toThrow(InvalidMarkdownInputError);
    expect(() => proposeMarkdown({ ...base, policy: { ladder: [] } })).toThrow(InvalidMarkdownInputError);
    expect(() => proposeMarkdown({ ...base, policy: { ladder: [{ maxDaysLeft: 2, markdownBps: 20_000 }] } })).toThrow(InvalidMarkdownInputError);
  });

  it('has no function that commits a price change — a person approves (hard rule #5)', () => {
    const names = Object.keys(markdownModule);
    expect(names).toContain('proposeMarkdown');
    expect(names.some((n) => /apply|commit|setprice|reprice|repriced/i.test(n))).toBe(false);
    // The default ladder is exported data, so a rule change is a config edit, not a code change.
    expect(DEFAULT_MARKDOWN_LADDER.ladder.length).toBeGreaterThan(0);
  });
});
