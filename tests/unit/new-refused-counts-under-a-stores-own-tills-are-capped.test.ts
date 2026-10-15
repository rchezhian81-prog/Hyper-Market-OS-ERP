import { describe, it, expect } from 'vitest';
import {
  readBoxHistory, billNumberFindingsFor, REFUSED_OWN_NEW_PER_DAY_MAX, REFUSED_NOT_KEPT_SHOWN_DAYS,
  type BoxHealthRecord, type IssuedReport, type BoxHistorySnapshot, type RefusedIssued, type RefusalAcknowledgement,
} from '../../services/platform/src/box-health';
import { TEST_BOX_HISTORY_KEY as K, rng } from '../support/box-history';

/**
 * **Round 32 · owner decision OB-117 "A" (14 Oct 2026, in writing, "Cap per till per day"; verifier r31 NEW-3, probe F1) —
 * new refused counts under a store's OWN till prefixes are capped: at most REFUSED_OWN_NEW_PER_DAY_MAX (20) a store day per
 * store computer per till prefix; the rest are counted in one line per (store computer, prefix), never stored.**
 *
 *   • F1: 10 own till prefixes, each with a NEW impossible count every 15 s for 200 minutes — the saved history stays small
 *     (round 31: 2.82 MB), 20 refused counts kept per prefix, one line per prefix counting the rest and naming the highest;
 *   • a second store computer naming a till's prefix uses up only ITS OWN 20, never the bound computer's;
 *   • a count already kept is kept again (its latest word moves); a new store day keeps 20 new ones again; the line goes after
 *     7 quiet days;
 *   • the saved result read in windows (with banking and acknowledgements on the way) says exactly what the plain reading says.
 */

const t0 = Date.parse('2026-03-01T00:00:00.000Z'); // 05:30 in India: one store day (Asia/Kolkata) runs to 18:30 UTC
const iso = (min: number): string => new Date(t0 + min * 60_000).toISOString();
const DISK = { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1, salesLogCapacityBytes: 1e7, reserveBytes: 1 };
const PREFIXES = Array.from({ length: 10 }, (_, k) => `S1L${k}-`);
const tooFar = (prefix: string, through: number): RefusedIssued => ({ prefix, through, because: 'beyond_plausible_advance', bankedThrough: 100, plausibleThrough: 10_100 });
const report = (min: number, refused: readonly RefusedIssued[], by = 'u-box', sec = 0): BoxHealthRecord => ({
  storeId: 'S1', observedAt: new Date(t0 + min * 60_000 + sec * 1000).toISOString(), receivedAt: new Date(t0 + min * 60_000 + sec * 1000).toISOString(),
  reportedBy: by, clockAheadCorrected: false, tills: [], disk: DISK, queue: { unsent: 0, deadLettered: 0 },
  // (a second store computer names no till it holds: only its refused words)
  receiptNumbersIssued: by === 'u-box' ? PREFIXES.map((prefix) => ({ prefix, through: 100, soldThrough: 100, unsent: { count: 0 } }) as IssuedReport) : [],
  ...(refused.length === 0 ? {} : { receiptNumbersRefused: [...refused] }),
} as BoxHealthRecord);
const banked = new Map(PREFIXES.map((p) => [p, 100]));
const entries = (records: readonly BoxHealthRecord[]) => records.map((raw, i) => ({ raw, judged: raw, seq: i + 1 }));
const refusals = (f: ReturnType<typeof billNumberFindingsFor>) => f.filter((x) => x.kind === 'report_refused' || x.kind === 'report_refused_not_kept');
const plain = (records: readonly BoxHealthRecord[], at: string, acknowledged: readonly RefusalAcknowledgement[] = [], b = banked) =>
  refusals(billNumberFindingsFor({ storeId: 'S1', records, at, unreceived: [], banked: b, acknowledged }));

describe('round 32 · OB-117: new refused counts under the store\'s own till prefixes are capped per store computer per till per store day', () => {
  it(`F1: 10 own prefixes, a NEW impossible count each every 15 s for 200 minutes — ${REFUSED_OWN_NEW_PER_DAY_MAX} kept per prefix, one line each, the saved result small`, () => {
    const records = Array.from({ length: 800 }, (_, i) => report(Math.floor(i / 4), PREFIXES.map((p) => tooFar(p, 1_000_000 + i)), 'u-box', (i % 4) * 15));
    const at = iso(230);
    const got = readBoxHistory({ sealKey: K, entries: entries(records), at, banked, settleBefore: iso(220), settledThrough: 800 });
    if ('setAside' in got) throw new Error(got.setAside);
    // Round 31 (verifier r31 probe F1): 2.82 MB after 200 minutes, about 20 MB a day. Now bounded by 20 counts a prefix a day.
    const size = got.snapshot!.sizeBytes;
    // The same 800 reports with no refusals at all, for comparison: the flood adds only its 200 kept counts and 10 lines.
    const honest = readBoxHistory({ sealKey: K, entries: entries(records.map((r) => ({ ...r, receiptNumbersRefused: undefined }) as BoxHealthRecord)), at, banked, settleBefore: iso(220), settledThrough: 800 });
    if ('setAside' in honest) throw new Error(honest.setAside);
    const added = size - honest.snapshot!.sizeBytes;
    console.log(`OB-117 F1: saved history ${(size / 1024).toFixed(1)} KB after 200 minutes of 10 prefixes flooding (the same reports with no refusals: ${(honest.snapshot!.sizeBytes / 1024).toFixed(1)} KB; the flood adds ${(added / 1024).toFixed(1)} KB)`);
    expect(size).toBeLessThan(96 * 1024);
    // At most 20 kept counts per prefix: about 300 bytes each, whatever more the store computer sends that day.
    expect(added).toBeLessThan(10 * REFUSED_OWN_NEW_PER_DAY_MAX * 400);
    const f = refusals(billNumberFindingsFor({ storeId: 'S1', records: [], at, unreceived: [], facts: got.facts('S1') }));
    const kept = f.filter((x) => x.kind === 'report_refused');
    // One finding per prefix (the highest open count), naming the others: 20 kept per prefix.
    expect(kept).toHaveLength(10);
    for (const x of kept) {
      expect(x.through).toBe(1_000_000 + REFUSED_OWN_NEW_PER_DAY_MAX - 1);
      expect(x.detail).toMatch(new RegExp(`other counts head office refused under ${x.prefix}, still to be looked at: .* and ${REFUSED_OWN_NEW_PER_DAY_MAX - 1 - 5} more`));
    }
    const lines = f.filter((x) => x.kind === 'report_refused_not_kept');
    expect(lines.map((x) => [x.prefix, x.count, x.since])).toEqual(PREFIXES.map((p) => [p, 800 - REFUSED_OWN_NEW_PER_DAY_MAX, records[REFUSED_OWN_NEW_PER_DAY_MAX]!.receivedAt]));
    expect(lines[0]!.detail).toMatch(/^780 more refused bill count\(s\) under S1L0- not kept: store S1's computer u-box reported more NEW bill counts under S1L0- .* at most 20 new ones a day per store computer per till .* the highest of them was S1L0-1000799\. /);
    // The plain reading says exactly the same.
    expect(plain(records, at)).toEqual(f);
  });

  it('a count already kept is kept again; a second store computer uses up only its OWN 20; a new store day keeps 20 again; the line goes after 7 quiet days', () => {
    const P = PREFIXES[0]!;
    const records: BoxHealthRecord[] = [];
    for (let i = 0; i < 30; i += 1) records.push(report(i, [tooFar(P, 2_000_000 + i)]));
    // The bound computer repeats a count it already has kept: kept again (its latest word), no new slot used.
    records.push(report(31, [tooFar(P, 2_000_005)]));
    // A second store computer naming the till's prefix with 30 new counts of its own.
    for (let i = 0; i < 30; i += 1) records.push(report(40 + i, [{ prefix: P, through: 3_000_000 + i, because: 'prefix_of_another_store_computer', bankedThrough: 100 }], 'u-box-2'));
    const at = iso(80);
    const f = plain(records, at);
    const lines = f.filter((x) => x.kind === 'report_refused_not_kept');
    expect(lines.map((x) => [x.prefix, x.count])).toEqual([[P, 10], [P, 10]]);
    expect(lines.map((x) => x.detail.match(/computer (u-box(-2)?) /)![1])).toEqual(['u-box', 'u-box-2']);
    // Next store day (India): 20 new ones kept again; the line stays 7 days after its last, then goes.
    const nextDay = 24 * 60;
    const more = [...records, ...Array.from({ length: 25 }, (_, i) => report(nextDay + i, [tooFar(P, 4_000_000 + i)]))];
    const g = plain(more, iso(nextDay + 30)).filter((x) => x.kind === 'report_refused_not_kept');
    expect(g.map((x) => x.count)).toEqual([10 + 5, 10]);
    expect(plain(more, iso(nextDay + 25 + REFUSED_NOT_KEPT_SHOWN_DAYS * 24 * 60)).filter((x) => x.kind === 'report_refused_not_kept')).toEqual([]);
    // The saved result agrees.
    const got = readBoxHistory({ sealKey: K, entries: entries(more), at: iso(nextDay + 30), banked, settleBefore: iso(nextDay + 29), settledThrough: more.length });
    if ('setAside' in got) throw new Error(got.setAside);
    expect(refusals(billNumberFindingsFor({ storeId: 'S1', records: [], at: iso(nextDay + 30), unreceived: [], facts: got.facts('S1') }))).toEqual(plain(more, iso(nextDay + 30)));
  });

  it('a count over the cap still moves the prefix\'s latest word: an acknowledgement ends when the store computer says a different count (both readings)', () => {
    const P = PREFIXES[0]!;
    const records: BoxHealthRecord[] = [];
    for (let i = 0; i < REFUSED_OWN_NEW_PER_DAY_MAX; i += 1) records.push(report(i, [tooFar(P, 5_000_000 + i)]));
    // The 20th count is acknowledged while the store computer repeats it, then the computer says a NEW count (over the cap,
    // not kept), then the acknowledged count again: that needs a new acknowledgement — the over-cap word ended the old one.
    const last = 5_000_000 + REFUSED_OWN_NEW_PER_DAY_MAX - 1;
    records.push(report(30, [tooFar(P, last)]));
    const ack: RefusalAcknowledgement = { storeId: 'S1', prefix: P, through: last, reason: 'support looked', by: 'u-owner', at: iso(30.5), authority: 'all_stores' };
    records.push(report(31, [tooFar(P, last)]));
    records.push(report(32, [tooFar(P, 6_000_000)]));
    records.push(report(33, [tooFar(P, last)]));
    const at = iso(40);
    const f = plain(records, at, [ack]);
    expect(f.find((x) => x.kind === 'report_refused')!.through).toBe(last);
    expect(f.find((x) => x.kind === 'report_refused_not_kept')).toMatchObject({ prefix: P, count: 1 });
    const got = readBoxHistory({ sealKey: K, entries: entries(records), at, banked, settleBefore: iso(39), settledThrough: records.length, refusalAcks: [ack] });
    if ('setAside' in got) throw new Error(got.setAside);
    expect(refusals(billNumberFindingsFor({ storeId: 'S1', records: [], at, unreceived: [], facts: got.facts('S1'), acknowledged: [ack] }))).toEqual(f);
  });

  it('the saved result read in windows over three days of own-prefix floods (two store computers, banking and acknowledgements on the way) says exactly what the plain reading says', () => {
    const rnd = rng(32);
    const records: BoxHealthRecord[] = [];
    const acks: RefusalAcknowledgement[] = [];
    for (let i = 0; i < 3 * 24 * 6; i += 1) {
      const min = i * 10;
      const by = rnd() < 0.7 ? 'u-box' : 'u-box-2';
      const words = Array.from({ length: 1 + Math.floor(rnd() * 4) }, (): RefusedIssued => {
        const prefix = PREFIXES[Math.floor(rnd() * 3)]!;
        const through = rnd() < 0.3 ? 200 + Math.floor(rnd() * 5) : 1_000_000 + Math.floor(rnd() * 400);
        return by === 'u-box' ? tooFar(prefix, through) : { prefix, through, because: 'prefix_of_another_store_computer', bankedThrough: 100 };
      });
      records.push(report(min, [...new Map(words.map((w) => [w.prefix, w])).values()], by));
      if (rnd() < 0.05) acks.push({ storeId: 'S1', prefix: words[0]!.prefix, through: words[0]!.through, reason: 'looked at it', by: 'u-owner', at: iso(min + 1), authority: 'all_stores' });
    }
    let snapshot: BoxHistorySnapshot | undefined;
    let lines = 0;
    for (let cut = 30; cut <= records.length; cut += 29) {
      const at = iso(cut * 10 + 1);
      // Head office banks more as the days go on (some refused counts become true).
      const b = new Map(PREFIXES.map((p) => [p, cut > 300 ? 203 : 100]));
      const ackNow = acks.filter((a) => Date.parse(a.at) <= Date.parse(at));
      const window = entries(records.slice(0, cut)).filter((e) => snapshot === undefined || e.seq > snapshot.seq);
      let got = readBoxHistory({ sealKey: K, entries: window, ...(snapshot === undefined ? {} : { snapshot }), at, banked: b, settleBefore: at, settledThrough: cut, refusalAcks: ackNow });
      if ('setAside' in got) {
        // (an acknowledgement or a banked change since the last save sets it aside, as designed — rebuilt from every report)
        got = readBoxHistory({ sealKey: K, entries: entries(records.slice(0, cut)), at, banked: b, settleBefore: at, settledThrough: cut, refusalAcks: ackNow });
        if ('setAside' in got) throw new Error(got.setAside);
      }
      if (got.snapshot !== undefined) snapshot = JSON.parse(JSON.stringify(got.snapshot)) as BoxHistorySnapshot;
      const windowed = refusals(billNumberFindingsFor({ storeId: 'S1', records: [], at, unreceived: [], facts: got.facts('S1'), banked: b, acknowledged: ackNow }));
      expect(windowed).toEqual(plain(records.slice(0, cut), at, ackNow, b));
      lines = Math.max(lines, windowed.filter((x) => x.kind === 'report_refused_not_kept').length);
    }
    expect(lines).toBeGreaterThan(0); // the cap was reached in this history, and both readings agreed on it
  });
});
