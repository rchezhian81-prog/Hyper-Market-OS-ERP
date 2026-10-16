import { describe, it, expect } from 'vitest';
import { nextFoldClock, foldMoment, READINESS_CLOCK_TOLERANCE_MS } from '../../services/api/src/adapters';

/**
 * **Round 37 · M35-FR-03 · OB-104 / OB-106 · verifier r36 NEW-5 — the kept lease's fold moment follows the reads, also after
 * head office's clock steps back.** Round 36 moved the moment only forward: one read stamped an hour ahead (a clock that
 * jumped) kept the kept lease folding an hour ahead after NTP stepped the clock back, settling reports a fresh read leaves
 * unsettled (the next read then set the saved result aside: extra work). Now a read more than a minute BEHIND the moment moved
 * on starts it again; reads a moment apart (one started earlier, finished later) still never move it back.
 */

const T0 = Date.parse('2026-10-16T00:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

describe('round 37 · NEW-5: the kept lease fold moment', () => {
  it('M35-FR-03 OB-104 NEW-5: moves forward with the reads, and by this process\'s clock between them', () => {
    let c = nextFoldClock(undefined, iso(T0), 1_000);
    expect(foldMoment(c, 61_000)).toBe(iso(T0 + 60_000));
    c = nextFoldClock(c, iso(T0 + 120_000), 2_000);
    expect(c.at).toBe(iso(T0 + 120_000));
  });
  it('M35-FR-03 OB-104 NEW-5: a read a moment earlier (within the tolerance) never moves it back', () => {
    const c = nextFoldClock(undefined, iso(T0 + 10_000), 0);
    expect(nextFoldClock(c, iso(T0 + 9_000), 100)).toBe(c);
    expect(nextFoldClock(c, iso(T0 + 10_000 - READINESS_CLOCK_TOLERANCE_MS + 5_000), 100)).toBe(c);
  });
  it('M35-FR-03 OB-104 NEW-5: after a read an hour ahead, the clock steps back — the next read starts it again from its own moment', () => {
    const ahead = nextFoldClock(undefined, iso(T0 + 3_600_000), 0); // the jump
    const back = nextFoldClock(ahead, iso(T0 + 60_000), 60_000); // NTP stepped back; a real minute later
    expect(back.at).toBe(iso(T0 + 60_000));
    expect(foldMoment(back, 120_000)).toBe(iso(T0 + 120_000)); // round 36: 1:02 — an hour ahead of the reads
  });
});
