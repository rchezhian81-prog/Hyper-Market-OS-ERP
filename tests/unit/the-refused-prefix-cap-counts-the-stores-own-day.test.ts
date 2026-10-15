import { describe, it, expect } from 'vitest';
import {
  readBoxHistory, billNumberFindingsFor, sealBoxHistory, REFUSED_NEW_PER_DAY_MAX, DEFAULT_STORE_TIME_ZONE,
  type BoxHealthRecord, type BoxHistorySnapshot, type RefusedIssued,
} from '../../services/platform/src/box-health';
import { TEST_BOX_HISTORY_KEY as K, rng } from '../support/box-history';

/**
 * **Round 31 · owner decision OB-113 "A" (14 Oct 2026, in writing, "Store's own day") — the 20-a-day cap on new refused words
 * about prefixes that are not the store's counts the STORE's day: midnight to midnight in the shop's `locale.time_zone`
 * (Asia/Kolkata by default), not the UTC day (05:30 to 05:30 in India) of round 30.**
 *
 *   • around the store's midnight: 23:50 and 00:10 IST are two days (20 kept on each); 05:20 and 05:40 IST (either side of
 *     UTC midnight) are ONE day (20 kept in all) — the UTC day would say the opposite of both;
 *   • with no time zone given, the store's day is Asia/Kolkata's (the same default as the unused numbers' calendar days);
 *   • the plain reading and the saved result read in windows say exactly the same, in India and in another time zone;
 *   • changing the time zone sets the saved result aside ("settings") — the rebuild counts every day in the new zone.
 */

const IST_MIDNIGHT = Date.parse('2026-02-28T18:30:00.000Z'); // 1 March 2026, 00:00 in India
const isoMs = (ms: number): string => new Date(ms).toISOString();
const istAt = (hh: number, mm: number, dayOffset = 0): number => IST_MIDNIGHT + dayOffset * 86_400_000 + (hh * 60 + mm) * 60_000;
const refused = (prefix: string): RefusedIssued => ({ prefix, through: 5, because: 'prefix_of_another_store', bankedThrough: 0 });
const DISK = { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1, salesLogCapacityBytes: 1e7, reserveBytes: 1 };
const report = (ms: number, prefixes: readonly string[], by = 'u-box-a'): BoxHealthRecord => ({
  storeId: 'S1', observedAt: isoMs(ms), receivedAt: isoMs(ms), reportedBy: by, clockAheadCorrected: false, tills: [], disk: DISK,
  queue: { unsent: 0, deadLettered: 0 },
  receiptNumbersIssued: [{ prefix: 'A-', through: 100, soldThrough: 100, unsent: { count: 0 } }],
  receiptNumbersRefused: prefixes.map(refused),
} as BoxHealthRecord);
const names = (tag: string, n: number): string[] => Array.from({ length: n }, (_, k) => `Z${tag}x${k}-`);
const BANKED = new Map([['A-', 100]]);
const entries = (records: readonly BoxHealthRecord[]) => records.map((raw, i) => ({ raw, judged: raw, seq: i + 1 }));

/** The plain reading's refused lines (`refusedOpenFromRecords` through `storeBillFacts`). */
const plain = (records: readonly BoxHealthRecord[], at: string, timeZone?: string) =>
  billNumberFindingsFor({ storeId: 'S1', records, at, unreceived: [], banked: BANKED, ...(timeZone === undefined ? {} : { timeZone }) })
    .filter((f) => f.kind === 'report_refused' || f.kind === 'report_refused_not_kept');
/** The saved result's refused lines, read from nothing (or resumed from `snapshot`). */
function saved(records: readonly BoxHealthRecord[], at: string, timeZone?: string, snapshot?: BoxHistorySnapshot) {
  const got = readBoxHistory({
    sealKey: K, entries: entries(records).filter((e) => snapshot === undefined || e.seq > snapshot.seq), at, banked: BANKED, settleBefore: at, settledThrough: records.length,
    ...(timeZone === undefined ? {} : { timeZone }), ...(snapshot === undefined ? {} : { snapshot }),
  });
  if ('setAside' in got) return { setAside: got.setAside };
  return {
    lines: billNumberFindingsFor({ storeId: 'S1', records: [], at, unreceived: [], facts: got.facts('S1') }).filter((f) => f.kind === 'report_refused' || f.kind === 'report_refused_not_kept'),
    snapshot: got.snapshot === undefined ? undefined : JSON.parse(JSON.stringify(got.snapshot)) as BoxHistorySnapshot,
  };
}
const kept = (lines: ReturnType<typeof plain>): number => lines.filter((f) => f.kind === 'report_refused').length;
const notKept = (lines: ReturnType<typeof plain>): number => lines.find((f) => f.kind === 'report_refused_not_kept')?.count ?? 0;

describe('round 31 · OB-113: the refused-prefix cap counts the store\'s own day', () => {
  it('23:50 and 00:10 IST are two store days: 20 new words kept on each (the UTC day would keep 20 in all)', () => {
    const records = [report(istAt(23, 50, -1), names('a', 25)), report(istAt(0, 10), names('b', 25))];
    const at = isoMs(istAt(0, 20));
    for (const tz of [undefined, 'Asia/Kolkata']) {
      const lines = plain(records, at, tz);
      expect([kept(lines), notKept(lines)]).toEqual([2 * REFUSED_NEW_PER_DAY_MAX, 10]);
      expect(saved(records, at, tz).lines).toEqual(lines);
    }
    const utc = plain(records, at, 'UTC'); // 18:20 and 18:40 UTC — one UTC day
    expect([kept(utc), notKept(utc)]).toEqual([REFUSED_NEW_PER_DAY_MAX, 30]);
    expect(saved(records, at, 'UTC').lines).toEqual(utc);
  });

  it('05:20 and 05:40 IST (either side of UTC midnight) are ONE store day: 20 kept in all, the rest counted in one line', () => {
    const records = [report(istAt(5, 20), names('a', 25)), report(istAt(5, 40), names('b', 25))];
    const at = isoMs(istAt(6, 0));
    const lines = plain(records, at);
    expect([kept(lines), notKept(lines)]).toEqual([REFUSED_NEW_PER_DAY_MAX, 30]);
    expect(lines.find((f) => f.kind === 'report_refused_not_kept')!.detail).toMatch(/at most 20 new ones a day per store computer/);
    expect(saved(records, at).lines).toEqual(lines);
    const utc = plain(records, at, 'UTC');
    expect([kept(utc), notKept(utc)]).toEqual([2 * REFUSED_NEW_PER_DAY_MAX, 10]);
  });

  it('the store\'s midnight is the edge to the minute: 23:59 and 00:00 IST are two days; 00:00 and 23:59 the same day is one', () => {
    const two = [report(istAt(23, 59, -1), names('a', 20)), report(istAt(0, 0), names('b', 20))];
    expect(notKept(plain(two, isoMs(istAt(0, 5))))).toBe(0);
    const one = [report(istAt(0, 0), names('a', 20)), report(istAt(23, 59), names('b', 1))];
    expect(notKept(plain(one, isoMs(istAt(23, 59))))).toBe(1);
    expect(DEFAULT_STORE_TIME_ZONE).toBe('Asia/Kolkata');
  });

  for (const tz of ['Asia/Kolkata', 'America/New_York']) {
    it(`the saved result read in windows over four store days says exactly what the plain reading says, at every read (${tz})`, () => {
      const rnd = rng(113);
      const records: BoxHealthRecord[] = [];
      // A report every 10 minutes for 4 days, with bursts just before and after each store midnight.
      for (let i = 0; i < 4 * 24 * 6; i += 1) {
        const ms = IST_MIDNIGHT - 3 * 3_600_000 + i * 600_000;
        const n = Math.floor(rnd() * 9);
        const list = [...new Set(Array.from({ length: n }, () => `P${Math.floor(rnd() * 300)}-`))];
        records.push(report(ms, list, rnd() < 0.5 ? 'u-box-a' : 'u-box-b'));
      }
      let snapshot: BoxHistorySnapshot | undefined;
      let reads = 0; let capped = 0;
      for (let cut = 20; cut <= records.length; cut += 23) {
        const at = isoMs(Date.parse(records[cut - 1]!.receivedAt) + 60_000);
        const r = saved(records.slice(0, cut), at, tz, snapshot);
        if (r.setAside !== undefined) throw new Error(r.setAside);
        expect(r.lines).toEqual(plain(records.slice(0, cut), at, tz));
        if (r.snapshot !== undefined) snapshot = r.snapshot;
        reads += 1;
        if (notKept(r.lines!) > 0) capped += 1;
      }
      expect(reads).toBeGreaterThan(10);
      expect(capped).toBeGreaterThan(0); // the cap was reached, and both readings agreed on it
    });
  }

  it('changing the time zone sets the saved result aside ("settings"); read again from the reports, every day counts in the new zone', () => {
    const records = [report(istAt(23, 50, -1), names('a', 25)), report(istAt(0, 10), names('b', 25))];
    const at = isoMs(istAt(0, 20));
    const india = saved(records, at, 'Asia/Kolkata');
    expect(india.snapshot).toBeDefined();
    expect(saved(records, at, 'Asia/Kolkata', india.snapshot)).toMatchObject({ lines: india.lines });
    expect(saved(records, at, 'UTC', india.snapshot)).toEqual({ setAside: 'settings' });
    const rebuilt = saved(records, at, 'UTC');
    expect(rebuilt.lines).toEqual(plain(records, at, 'UTC'));
    expect(rebuilt.lines).not.toEqual(india.lines);
  });

  it('a saved result of round 30 (version 3, its days counted in UTC) is set aside even when sealed with the right key', () => {
    const records = [report(istAt(5, 20), names('a', 25)), report(istAt(5, 40), names('b', 25))];
    const at = isoMs(istAt(6, 0));
    const made = saved(records, at).snapshot!;
    expect(made.version).toBe(5); // round 32 (OB-116/117) moved it on from round 31's 4
    const round30 = sealBoxHistory({ ...made, version: 3 } as never, K);
    expect(saved(records, at, undefined, round30).setAside).toMatch(/version/);
  });
});
