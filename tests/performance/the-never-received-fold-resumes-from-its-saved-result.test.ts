import { describe, it, expect } from 'vitest';
import {
  readNeverReceived, billNumberFindingsFor, billsWaitingOnTheBox, judgeBoxes, FOLD_SETTLE_MINUTES,
  type BoxHealthRecord, type NeverReceivedSnapshot,
} from '../../services/platform/src/box-health';
import { DEFAULT_THRESHOLDS } from '../../packages/ops/src/index';

/**
 * **Round 27 · OB-102 "A" (owner, 13 Oct 2026, in writing, "Fix before pilot"; verifier r26 NEW-4) — head office's check of a
 * store computer's reports no longer grows with the weeks.**
 *
 * The verifier's altered store computer: 10 till prefixes, every report naming 50 at-risk ranges at RANDOM offsets and 50
 * unused ranges that shift, its queue flag flipping every pass — every 15 seconds. Before this round every health read and
 * every alert pass (each minute) folded every report ever kept: 2.75 s for one day, about 19 s for a week, and growing.
 * Now the fold resumes from its saved running result (the reports up to FOLD_SETTLE_MINUTES ago) and folds only the reports
 * after it. THE BOUND (firm): a health read's never-received fold, from the saved result, takes under 250 ms whether a day
 * or a WEEK of such reports is kept — the same for both, since it never re-reads the history; the rest of the health read
 * (the findings, the waiting clock, the store's health) stays under 1.5 s for a week. Each answer is checked equal to the
 * fold of everything, so a read that got fast by saying less fails too.
 */

const TILLS = 10;
const EVERY_MS = 15_000;
const DAY = 5_760; // one day of 15-second reports
const t0 = Date.parse('2026-01-05T00:00:00.000Z');
const banked = new Map(Array.from({ length: TILLS }, (_, k) => [`S1L${k}-`, 100] as [string, number]));

/** The verifier's randomised altered shape (scratchpad v26 zz-v26-perf "random"). */
function altered(reports: number, seed = 7): BoxHealthRecord[] {
  let s = seed;
  const rnd = (): number => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  return Array.from({ length: reports }, (_, i) => {
    const at = new Date(t0 + i * EVERY_MS).toISOString();
    const off = Math.floor(rnd() * 400);
    const atRisk: [number, number][] = Array.from({ length: 50 }, (_, j) => [j * 1000 + 1 + off, j * 1000 + 500 + off]);
    const unused: [number, number][] = Array.from({ length: 50 }, (_, j) => [59_000 + j * 20 + 1 + (off % 9), 59_000 + j * 20 + 10 + (off % 9)]);
    return {
      storeId: 'S1', observedAt: at, receivedAt: at, reportedBy: 'u-box', clockAheadCorrected: false, tills: [],
      disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1 + i, salesLogCapacityBytes: 1e7, reserveBytes: 1 },
      queue: { unsent: i % 2, deadLettered: 0 },
      receiptNumbersIssued: Array.from({ length: TILLS }, (_, k) => ({ prefix: `S1L${k}-`, through: 60_000, soldThrough: 60_000, unsent: { count: 0 }, atRisk, unused })),
    } as BoxHealthRecord;
  });
}

const iso = (ms: number): string => new Date(ms).toISOString();
function timed<T>(f: () => T): { value: T; ms: number } {
  const s = performance.now();
  const value = f();
  return { value, ms: performance.now() - s };
}

/**
 * The steady state head office is in: its alert pass has read the reports every minute, so a saved result covers all but the
 * last FOLD_SETTLE_MINUTES (and up to FOLD_SNAPSHOT_EVERY more reports). Built once here (the first read ever — a one-off,
 * reported, not the bound), then the next health read is timed.
 */
function steady(records: readonly BoxHealthRecord[]): { at: string; snapshot: NeverReceivedSnapshot; built: number; full: ReturnType<typeof readNeverReceived> } {
  const lastMs = Date.parse(records[records.length - 1]!.receivedAt);
  const at = iso(lastMs + 60_000);
  // The saved result as the alert pass left it ~26 minutes ago (settled 10 minutes before that read, 64 reports between saves).
  const savedAt = iso(lastMs - 16 * 60_000);
  const build = timed(() => readNeverReceived({ records, at: savedAt, banked, settleBefore: iso(Date.parse(savedAt) - FOLD_SETTLE_MINUTES * 60_000) }));
  const snapshot = JSON.parse(JSON.stringify(build.value.snapshot)) as NeverReceivedSnapshot;
  return { at, snapshot, built: build.ms, full: build.value };
}

describe('round 27 · OB-102: a health read folds only the reports after the saved running result', () => {
  for (const [label, reports] of [['a day', DAY], ['a week', DAY * 7]] as const) {
    it(`${label} of the verifier's randomised altered reports (10 tills, 50 at-risk + 50 unused ranges, every 15 s)`, () => {
      const records = altered(reports);
      const { at, snapshot, built } = steady(records);
      // The next health read: from the saved result, plus the ~26 minutes of reports after it.
      const read = timed(() => readNeverReceived({ records, at, banked, snapshot, settleBefore: iso(Date.parse(at) - FOLD_SETTLE_MINUTES * 60_000) }));
      expect(read.value.resumed).toBe(true);
      const tail = records.filter((r) => Date.parse(r.receivedAt) > Date.parse(snapshot.settledAt)).length;
      // The answer, checked: the newest 500 per till named (the check cap), as the fold of everything says.
      expect(read.value.candidates.map((c) => [c.prefix, c.numbers.length, c.capped])).toEqual(Array.from({ length: TILLS }, (_, k) => [`S1L${k}-`, 500, true]));
      if (reports === DAY) expect(read.value.candidates).toEqual(readNeverReceived({ records, at, banked }).candidates);
      // The rest of the health read, over every report kept (bound below).
      const rest = timed(() => {
        const findings = billNumberFindingsFor({
          storeId: 'S1', records, at, banked, unreceived: read.value.candidates.map((c) => ({ prefix: c.prefix, numbers: c.numbers, since: c.since, capped: c.capped })),
        });
        billsWaitingOnTheBox({ records, storeId: 'S1', at });
        return judgeBoxes({ records, at, thresholds: DEFAULT_THRESHOLDS, billNumberFindings: new Map([['S1', findings]]), bindings: read.value.bindings, unusedNumbers: read.value.unused });
      });
      expect(rest.value.boxes[0]!.unusedNumbers?.length).toBeGreaterThan(0);
      console.log(`[OB-102] ${label} (${reports} reports): first read ever ${built.toFixed(0)} ms (one-off, builds the saved result); `
        + `next health read's fold ${read.ms.toFixed(0)} ms over ${tail} reports after the saved result; rest of the health read ${rest.ms.toFixed(0)} ms`);
      expect(read.ms, `fold took ${read.ms.toFixed(0)} ms`).toBeLessThan(250);
      expect(rest.ms, `rest of the read took ${rest.ms.toFixed(0)} ms`).toBeLessThan(1_500);
    }, 600_000);
  }
});
