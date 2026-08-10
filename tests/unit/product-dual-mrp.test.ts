import { describe, it, expect } from 'vitest';
import { checkDualMrp, InvalidMrpEntry, type MrpEntry } from '../../packages/product/src/dual-mrp';

// Roadmap v2.1 B2 — a pack may carry only one active MRP. A price change over time is fine; two
// different MRPs taking effect on the SAME date is rejected at master-data commit.

const HISTORY: MrpEntry[] = [
  { effectiveFrom: '2026-01-01', valueMinor: 100_00 },
  { effectiveFrom: '2026-06-01', valueMinor: 120_00 },
];

describe('checkDualMrp — B2', () => {
  it('allows a later-dated price change (one active MRP at any moment)', () => {
    expect(checkDualMrp(HISTORY, { effectiveFrom: '2026-09-01', valueMinor: 130_00 }).ok).toBe(true);
  });

  it('allows the very first MRP against an empty history', () => {
    expect(checkDualMrp([], { effectiveFrom: '2026-01-01', valueMinor: 100_00 }).ok).toBe(true);
  });

  it('allows an exact-duplicate re-entry (same date AND value — a harmless no-op)', () => {
    expect(checkDualMrp(HISTORY, { effectiveFrom: '2026-06-01', valueMinor: 120_00 }).ok).toBe(true);
  });

  it('REJECTS a different MRP taking effect on a date that already has one', () => {
    const r = checkDualMrp(HISTORY, { effectiveFrom: '2026-06-01', valueMinor: 125_00 });
    expect(r.ok).toBe(false);
    expect(r.conflict).toEqual({ effectiveFrom: '2026-06-01', existingMinor: 120_00, proposedMinor: 125_00 });
    expect(r.detail).toContain('only one active MRP');
  });

  it('rejects malformed entries (bad date or non-positive amount)', () => {
    expect(() => checkDualMrp(HISTORY, { effectiveFrom: '01-06-2026', valueMinor: 100_00 })).toThrow(InvalidMrpEntry);
    expect(() => checkDualMrp(HISTORY, { effectiveFrom: '2026-06-01', valueMinor: 0 })).toThrow(InvalidMrpEntry);
    expect(() => checkDualMrp([{ effectiveFrom: 'bad', valueMinor: 100 }], { effectiveFrom: '2026-06-01', valueMinor: 100 })).toThrow(InvalidMrpEntry);
  });
});
