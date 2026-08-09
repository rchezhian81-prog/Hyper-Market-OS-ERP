import { describe, it, expect } from 'vitest';
import { bootPos } from '../../apps/pos/src/browser-entry';

// Offline receipt numbering (M01-FR-02, audit STAB-02 / GAP-SYNC-02). The served till used to mint
// `R-${Date.now()}`, so two lanes ringing offline could collide on a receipt number — a customer
// document that must be gap-free and unique. Now each lane draws from a per-lane RESERVED RANGE via
// the existing `ReservedRangeAllocator`, wired into `bootPos`. This proves the mechanism: distinct
// ranges never collide, each lane is gap-free within its range, and an exhausted range STOPS the
// till (throws) rather than reusing a number — the shell then takes no money.

describe('offline receipt numbering draws from a per-lane reserved range (M01-FR-02, STAB-02)', () => {
  it('two lanes with distinct ranges never mint the same number, and each is gap-free', () => {
    const laneA = bootPos({ laneId: 'L1', receipt: { prefix: 'R-L1-', padTo: 4, rangeStart: 1, rangeEnd: 100 } });
    const laneB = bootPos({ laneId: 'L2', receipt: { prefix: 'R-L2-', padTo: 4, rangeStart: 101, rangeEnd: 200 } });

    const a = Array.from({ length: 50 }, () => laneA.nextReceipt());
    const b = Array.from({ length: 50 }, () => laneB.nextReceipt());

    // Gap-free and correctly formatted within each lane.
    expect(a.slice(0, 3)).toEqual(['R-L1-0001', 'R-L1-0002', 'R-L1-0003']);
    expect(b.slice(0, 3)).toEqual(['R-L2-0101', 'R-L2-0102', 'R-L2-0103']);
    // No collision across the two offline lanes — the whole point of reserved ranges.
    expect(new Set([...a, ...b]).size).toBe(100);
  });

  it('stops (throws) when the range is exhausted rather than reusing a number', () => {
    const lane = bootPos({ receipt: { prefix: 'R-', padTo: 2, rangeStart: 1, rangeEnd: 3 } });
    expect(lane.receiptsRemaining()).toBe(3);
    expect([lane.nextReceipt(), lane.nextReceipt(), lane.nextReceipt()]).toEqual(['R-01', 'R-02', 'R-03']);
    expect(lane.receiptsRemaining()).toBe(0);
    expect(() => lane.nextReceipt()).toThrow(/exhausted/i);
  });

  it('an unprovisioned standalone shell falls back to a timestamp — demo only, not collision-safe', () => {
    const lane = bootPos({});
    expect(lane.receiptsRemaining()).toBe(Number.POSITIVE_INFINITY);
    expect(lane.nextReceipt()).toMatch(/^R-/);
  });
});
