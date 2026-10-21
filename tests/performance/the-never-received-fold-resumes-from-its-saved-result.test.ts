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
 * after it. Each answer is checked equal to the fold of everything, so a read that got fast by saying less fails too.
 *
 * WHAT IS HELD, and how (round 4 — the week case failed only when the machine was busy):
 *   • THE FOLD NEVER RE-READS THE HISTORY — by a FIXED WORKLOAD, not a stopwatch: the reports whose contents the resumed
 *     fold reads are exactly the ones received after the saved result, and that is the same number for a day as for a
 *     week. A fold that went back to re-read every report fails this however fast or slow the machine is.
 *   • ITS TIME DOES NOT GROW WITH THE WEEKS — measured RELATIVELY, on the same machine, best of three interleaved runs:
 *     a week's resumed fold takes at most three times a day's (in practice about 1.1×; re-reading the week would be
 *     well over 100×), and each is under a fifth of the full fold of the same reports, timed just before it.
 *   • THE REST OF THE READ GROWS NO FASTER THAN THE HISTORY — relatively, best of five interleaved runs: a week costs at
 *     most three times seven days' share of one day (in practice about 7–11×; a read that grew with the square of the
 *     history would be about 49×).
 * The old wall-clock figures (fold under 250 ms, rest under 1.5 s for a week) were this test's own guard against a
 * regression — neither roadmap §32 nor OB-102 names a number — so they are still measured and printed, never asserted.
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
 * The same reports, each one telling which were OPENED: its contents (`receiptNumbersIssued`, what the fold reads) are
 * behind a getter that notes the report. Its time of receipt is read freely — that is how the fold finds where to resume.
 */
function counted(records: readonly BoxHealthRecord[]): { records: BoxHealthRecord[]; opened: Set<number> } {
  const opened = new Set<number>();
  return {
    opened,
    records: records.map((r, i) => {
      const { receiptNumbersIssued, ...rest } = r;
      const copy = { ...rest } as BoxHealthRecord;
      Object.defineProperty(copy, 'receiptNumbersIssued', { enumerable: true, get: () => { opened.add(i); return receiptNumbersIssued; } });
      return copy;
    }),
  };
}

/** What each case leaves for the relative checks: its reports, the moment of the read, the saved result, the answer. */
interface Kept { readonly records: BoxHealthRecord[]; readonly at: string; readonly snapshot: NeverReceivedSnapshot; readonly read: ReturnType<typeof readNeverReceived> }
const kept = new Map<string, Kept>();
const resumedRead = (k: Omit<Kept, 'read'>): ReturnType<typeof readNeverReceived> =>
  readNeverReceived({ records: k.records, at: k.at, banked, snapshot: k.snapshot, settleBefore: iso(Date.parse(k.at) - FOLD_SETTLE_MINUTES * 60_000) });
const restOfTheRead = (k: Kept): ReturnType<typeof judgeBoxes> => {
  const findings = billNumberFindingsFor({
    storeId: 'S1', records: k.records, at: k.at, banked, unreceived: k.read.candidates.map((c) => ({ prefix: c.prefix, numbers: c.numbers, since: c.since, capped: c.capped })),
  });
  billsWaitingOnTheBox({ records: k.records, storeId: 'S1', at: k.at });
  return judgeBoxes({ records: k.records, at: k.at, thresholds: DEFAULT_THRESHOLDS, billNumberFindings: new Map([['S1', findings]]), bindings: k.read.bindings, unusedNumbers: k.read.unused });
};
/** The tail a resumed read folds is the same for any length of history: the reports after the saved result. */
const tails: number[] = [];

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
      const read = timed(() => resumedRead({ records, at, snapshot }));
      expect(read.value.resumed).toBe(true);
      const tail = records.filter((r) => Date.parse(r.receivedAt) > Date.parse(snapshot.settledAt)).length;
      // The answer, checked: the newest 500 per till named (the check cap), as the fold of everything says.
      expect(read.value.candidates.map((c) => [c.prefix, c.numbers.length, c.capped])).toEqual(Array.from({ length: TILLS }, (_, k) => [`S1L${k}-`, 500, true]));
      if (reports === DAY) expect(read.value.candidates).toEqual(readNeverReceived({ records, at, banked }).candidates);
      // FIXED WORKLOAD: the resumed fold opened exactly the reports after the saved result — none of the history before it.
      const watched = counted(records);
      const again = resumedRead({ records: watched.records, at, snapshot });
      expect(again.resumed).toBe(true);
      expect(again.candidates).toEqual(read.value.candidates);
      const afterSaved = records.flatMap((r, i) => (Date.parse(r.receivedAt) > Date.parse(snapshot.settledAt) ? [i] : []));
      expect([...watched.opened].sort((a, b) => a - b)).toEqual(afterSaved);
      expect(afterSaved.length).toBe(tail);
      tails.push(tail);
      if (tails.length === 2) expect(tails[1], 'a week folds the same tail as a day').toBe(tails[0]);
      // RELATIVE: the resumed fold is a small part of the full fold of the same reports, timed on this machine just before.
      const best = Math.min(read.ms, timed(() => resumedRead({ records, at, snapshot })).ms, timed(() => resumedRead({ records, at, snapshot })).ms);
      expect(best, `resumed fold ${best.toFixed(0)} ms against the full fold's ${built.toFixed(0)} ms`).toBeLessThan(built / 5);
      // The rest of the health read, over every report kept (held relatively, below).
      const rest = timed(() => restOfTheRead({ records, at, snapshot, read: read.value }));
      expect(rest.value.boxes[0]!.unusedNumbers?.length).toBeGreaterThan(0);
      kept.set(label, { records, at, snapshot, read: read.value });
      console.log(`[OB-102] ${label} (${reports} reports): first read ever ${built.toFixed(0)} ms (one-off, builds the saved result); `
        + `next health read's fold ${read.ms.toFixed(0)} ms over ${tail} reports after the saved result (${((read.ms / built) * 100).toFixed(1)} % of the full fold); `
        + `rest of the health read ${rest.ms.toFixed(0)} ms (the old guard figures: 250 ms and 1,500 ms — printed, not asserted)`);
    }, 600_000);
  }

  it('a week against a day, on this machine: the resumed fold costs about the same, and the rest of the read grows no faster than the history', () => {
    const day = kept.get('a day');
    const week = kept.get('a week');
    expect(day, 'the day case ran first').toBeDefined();
    expect(week, 'the week case ran first').toBeDefined();
    const fold = { day: Number.POSITIVE_INFINITY, week: Number.POSITIVE_INFINITY };
    for (let round = 0; round < 3; round += 1) {
      fold.day = Math.min(fold.day, timed(() => resumedRead(day!)).ms);
      fold.week = Math.min(fold.week, timed(() => resumedRead(week!)).ms);
    }
    const rest = { day: Number.POSITIVE_INFINITY, week: Number.POSITIVE_INFINITY };
    for (let round = 0; round < 5; round += 1) {
      rest.day = Math.min(rest.day, timed(() => restOfTheRead(day!)).ms);
      rest.week = Math.min(rest.week, timed(() => restOfTheRead(week!)).ms);
    }
    console.log(`[OB-102] best runs on this machine — resumed fold: a day ${fold.day.toFixed(0)} ms, a week ${fold.week.toFixed(0)} ms (${(fold.week / fold.day).toFixed(1)}×); `
      + `rest of the read: a day ${rest.day.toFixed(0)} ms, a week ${rest.week.toFixed(0)} ms (${(rest.week / rest.day).toFixed(1)}×; linear is 7×)`);
    expect(fold.week, `a week's resumed fold ${fold.week.toFixed(0)} ms against a day's ${fold.day.toFixed(0)} ms`).toBeLessThan(3 * fold.day);
    expect(rest.week, `a week's rest of the read ${rest.week.toFixed(0)} ms against a day's ${rest.day.toFixed(0)} ms`).toBeLessThan(3 * 7 * rest.day);
  }, 600_000);
});
