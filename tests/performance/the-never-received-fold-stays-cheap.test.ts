import { describe, it, expect } from 'vitest';
import { unreceivedCandidates, billsWaitingOnTheBox, type BoxHealthRecord } from '../../services/platform/src/box-health';

/**
 * **Verifier r23 NEW-2 — the never-received fold stays cheap exactly when bills are lost.**
 *
 * `unreceivedCandidates` runs synchronously on every operational-health read AND on every ops-alert pass (each minute),
 * over every box report head office keeps. Round 23 made it 50–65× slower than round 22 (probe zz-v23-perf: 10 tills,
 * one day of 15-second reports, 500 bills per till never received — 281 ms in r22, 14.6 s in r23: head office frozen for
 * 15 s every minute). This suite holds the line: 10 tills × 5,760 reports (a day at the store computer's 15-second
 * trading interval) in each of the shapes below, each fold under 1.5 s — with the answer checked, so a fold that got
 * fast by saying less fails too. (That the fast fold gives exactly the plain reading's answer is proved field for field
 * in tests/unit/the-never-received-fold-is-its-plain-reading.test.ts.)
 */

const S1 = 'S1';
const TILLS = 10;
const REPORTS = 5_760; // one day at 15 s
const EVERY_MS = 15_000;
const LIMIT_MS = 1_500;
const t0 = Date.parse('2026-01-01T00:00:00.000Z');
type Unsent = { count: number; from?: number; to?: number };
interface Shape { readonly sold: number; readonly unsent?: Unsent; readonly dead?: Unsent; readonly queue: number }

function day(shape: (i: number) => Shape): BoxHealthRecord[] {
  return Array.from({ length: REPORTS }, (_, i) => {
    const at = new Date(t0 + i * EVERY_MS).toISOString();
    const s = shape(i);
    return {
      storeId: S1, observedAt: at, receivedAt: at, reportedBy: 'u-box', clockAheadCorrected: false, tills: [],
      disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1, salesLogCapacityBytes: 1e7, reserveBytes: 1 },
      queue: { unsent: s.queue * TILLS, deadLettered: (s.dead?.count ?? 0) * TILLS },
      receiptNumbersIssued: Array.from({ length: TILLS }, (_, k) => ({
        prefix: `S1L${k}-`, through: s.sold, soldThrough: s.sold,
        ...(s.unsent === undefined ? {} : { unsent: s.unsent }), ...(s.dead === undefined ? {} : { deadLettered: s.dead }),
      })),
    } as BoxHealthRecord;
  });
}
const banked = new Map(Array.from({ length: TILLS }, (_, k) => [`S1L${k}-`, 100] as [string, number]));
const at = new Date(t0 + REPORTS * EVERY_MS).toISOString();
function timed<T>(f: () => T): { value: T; ms: number } {
  const s = performance.now();
  const value = f();
  return { value, ms: performance.now() - s };
}

describe('verifier r23 NEW-2: the never-received fold over 10 tills × a day of 15-second reports stays under 1.5 s', () => {
  it('a box restored from a backup: 500 bills per till never arrive, the same report every 15 s (probe zz-v23-perf)', () => {
    const records = day(() => ({ sold: 600, unsent: { count: 0 }, queue: 0 }));
    const { value, ms } = timed(() => unreceivedCandidates({ records, at, banked }));
    expect(value.map((c) => [c.numbers.length, c.numbers[0], c.numbers.at(-1)])).toEqual(Array.from({ length: TILLS }, () => [500, 101, 600]));
    expect(ms, `took ${ms.toFixed(0)} ms`).toBeLessThan(LIMIT_MS);
  });

  it('every report different: the tills keep selling (a new number each report) and none of it arrives', () => {
    const records = day((i) => ({ sold: 600 + i, unsent: { count: 0 }, queue: 0 }));
    const { value, ms } = timed(() => unreceivedCandidates({ records, at, banked }));
    // The newest 500 per till (the check cap), all named.
    expect(value.every((c) => c.numbers.length === 500 && c.capped)).toBe(true);
    expect(value).toHaveLength(TILLS);
    expect(ms, `took ${ms.toFixed(0)} ms`).toBeLessThan(LIMIT_MS);
  });

  it('every report different, with a sparse given-up list across the whole span (no number ever settles)', () => {
    const records = day((i) => ({ sold: 600 + i, unsent: { count: 0 }, dead: { count: 2, from: 101, to: 600 + i }, queue: 0 }));
    const { value, ms } = timed(() => unreceivedCandidates({ records, at, banked }));
    expect(value.every((c) => c.numbers.length === 500 && c.sparse?.count === 2)).toBe(true);
    expect(ms, `took ${ms.toFixed(0)} ms`).toBeLessThan(LIMIT_MS);
  });

  it('the hiding trick (verifier r23 NEW-1): "nothing waiting" then "500 waiting", alternating all day', () => {
    const records = day((i) => (i % 2 === 0 ? { sold: 600, unsent: { count: 0 }, queue: 0 } : { sold: 600, unsent: { count: 500, from: 101, to: 600 }, queue: 500 }));
    const { value, ms } = timed(() => unreceivedCandidates({ records, at, banked }));
    expect(value.map((c) => [c.numbers.length, c.reclaimed?.numbers.length, c.reclaimed?.byList])).toEqual(Array.from({ length: TILLS }, () => [500, 500, true]));
    expect(ms, `took ${ms.toFixed(0)} ms`).toBeLessThan(LIMIT_MS);
    // And the waiting clock over the same day: aged from the first sight, cheap as well.
    const waiting = timed(() => billsWaitingOnTheBox({ records, storeId: S1, at }));
    expect(waiting.value.map((f) => f.since)).toEqual(Array.from({ length: TILLS }, () => new Date(t0 + EVERY_MS).toISOString()));
    expect(waiting.ms, `took ${waiting.ms.toFixed(0)} ms`).toBeLessThan(LIMIT_MS);
  });
});
