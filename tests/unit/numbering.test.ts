import { describe, it, expect } from 'vitest';
import {
  NumberSeries,
  ReservedRangeAllocator,
  formatNumber,
} from '../../packages/numbering/src/index';

// Document numbers must be gap-free and unique per type (M01-FR-02), and two lanes
// offline must never produce a duplicate — the reserved-range guarantee.

const INV = { prefix: 'INV', padTo: 6 };

describe('formatNumber', () => {
  it('applies prefix and zero-padding', () => {
    expect(formatNumber(INV, 42)).toBe('INV000042');
    expect(formatNumber({ prefix: '', padTo: 0 }, 7)).toBe('7');
  });
});

describe('NumberSeries', () => {
  it('allocates gap-free, sequential numbers', () => {
    const s = new NumberSeries(INV);
    expect(s.allocate()).toEqual({ seq: 1, formatted: 'INV000001' });
    expect(s.allocate().seq).toBe(2);
    expect(s.allocate().seq).toBe(3);
    expect(s.peekNext()).toBe(4);
  });

  it('honours a start value and validates it', () => {
    expect(new NumberSeries(INV, 1000).allocate().seq).toBe(1000);
    expect(() => new NumberSeries(INV, 0)).toThrow(RangeError);
  });

  it('reserves disjoint contiguous ranges that advance the series', () => {
    const s = new NumberSeries(INV);
    const r1 = s.reserve(100);
    const r2 = s.reserve(100);
    expect(r1).toEqual({ start: 1, end: 100 });
    expect(r2).toEqual({ start: 101, end: 200 });
    // the series continues after the reservations
    expect(s.allocate().seq).toBe(201);
    expect(() => s.reserve(0)).toThrow(RangeError);
  });
});

describe('ReservedRangeAllocator (offline lane)', () => {
  it('allocates within its range and reports remaining', () => {
    const lane = new ReservedRangeAllocator(INV, { start: 1, end: 3 });
    expect(lane.allocate().seq).toBe(1);
    expect(lane.remaining()).toBe(2);
    expect(lane.allocate().seq).toBe(2);
    expect(lane.allocate().seq).toBe(3);
    expect(lane.remaining()).toBe(0);
    expect(() => lane.allocate()).toThrow(RangeError); // exhausted
  });

  it('two lanes offline never produce a duplicate number (M01-FR-02)', () => {
    const series = new NumberSeries(INV);
    const laneA = new ReservedRangeAllocator(INV, series.reserve(5));
    const laneB = new ReservedRangeAllocator(INV, series.reserve(5));
    const issued = new Set<number>();
    for (let i = 0; i < 5; i += 1) {
      issued.add(laneA.allocate().seq);
      issued.add(laneB.allocate().seq);
    }
    expect(issued.size).toBe(10); // all distinct — no collision
  });
});
