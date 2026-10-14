import { describe, it, expect } from 'vitest';
import {
  WaitClock, readBoxHistory, boxHistoryUnreadable, sealBoxHistory, billsWaitingOnTheBox, WAIT_RANGES_MAX, WAIT_FORGET_HOURS,
  type BoxHealthRecord, type IssuedReport, type BoxHistorySnapshot,
} from '../../services/platform/src/box-health';
import { TEST_BOX_HISTORY_KEY as K } from '../support/box-history';

/**
 * **Round 32 — the three test gaps the verifier's mutations found in round 31 (verifier r31 mutants 5 and 7; and the cosmetic merge
 * wording), as rules.**
 *
 *   • mutant 5: when two neighbouring waiting ranges are JOINED (OB-110), the joined range keeps the LOWER quiet count — a number
 *     listed in the last report-hour is never forgotten early because its neighbour had been quiet for hours (with the higher
 *     count the joined range would be forgotten early, and that number, listed again, would look YOUNGER than it is);
 *   • mutant 7: a saved result whose waiting clock holds more than WAIT_RANGES_MAX ranges is SET ASIDE by the shape check, even
 *     correctly sealed (exactly WAIT_RANGES_MAX is read);
 *   • a joined range is never named as "first seen" numbers (it can cover numbers no list ever named): the words say the clock
 *     runs from the earliest sight of the numbers kept together.
 */

const H = 3_600_000;
const t0 = Date.parse('2026-03-01T00:00:00.000Z');
const at = (ms: number): string => new Date(t0 + ms).toISOString();


describe('round 32 · verifier r31 mutant 5: a joined waiting range keeps the LOWER quiet count', () => {
  it(`a number listed in the last hour, joined with a neighbour quiet for 10 report-hours, is still remembered ${WAIT_FORGET_HOURS - 10 + 2} report-hours later`, () => {
    const c = new WaitClock();
    // Hour 0: A (number 1) and B (number 3) first listed at the SAME moment (so they are the closest pair to join), and
    // WAIT_RANGES_MAX − 2 other numbers listed one by one at distinct moments.
    c.tick(t0, true);
    c.told(at(0), t0, 1, 1);
    c.told(at(0), t0, 3, 3);
    for (let k = 0; k < WAIT_RANGES_MAX - 2; k += 1) c.told(at(1000 * (k + 1)), t0 + 1000 * (k + 1), 100 + k, 100 + k);
    expect(c.ranges).toHaveLength(WAIT_RANGES_MAX);
    // Hours 1–10: every report lists B and the others — never A. A grows quiet; B stays at 0.
    const others = (h: number): void => { c.told(at(h * H), t0 + h * H, 3, 3); c.told(at(h * H), t0 + h * H, 100, 100 + WAIT_RANGES_MAX - 3); };
    for (let h = 1; h <= 10; h += 1) { c.tick(t0 + h * H, true); others(h); }
    // Hour 11: a new number past the cap — the closest pair (A and B, the same first sight) is joined.
    c.tick(t0 + 11 * H, true);
    others(11);
    c.told(at(11 * H), t0 + 11 * H, 500, 500);
    expect(c.ranges).toHaveLength(WAIT_RANGES_MAX);
    const joined = c.ranges.find((r) => r.from === 1)!;
    expect(joined).toMatchObject({ from: 1, to: 3, atMs: t0, joined: true });
    expect(joined.quiet).toBe(0); // the LOWER of A's 10 and B's 0
    // From hour 12 on, nothing lists 1–3. With the lower count it is forgotten only after WAIT_FORGET_HOURS report-hours;
    // with the higher one (10) it would be gone after WAIT_FORGET_HOURS − 10, and B listed again would restart its clock.
    for (let h = 12; h <= 12 + WAIT_FORGET_HOURS - 10 + 1; h += 1) { c.tick(t0 + h * H, true); c.told(at(h * H), t0 + h * H, 100, 100 + WAIT_RANGES_MAX - 3); }
    expect(c.first(3, 3)).toEqual({ at: at(0), from: 1, to: 3, joined: true });
    // And it IS forgotten after WAIT_FORGET_HOURS report-hours with no list naming it (the rule still holds).
    for (let h = 12 + WAIT_FORGET_HOURS - 10 + 2; h <= 12 + WAIT_FORGET_HOURS + 1; h += 1) { c.tick(t0 + h * H, true); c.told(at(h * H), t0 + h * H, 100, 100 + WAIT_RANGES_MAX - 3); }
    expect(c.first(3, 3)).toBeUndefined();
  });
});

const DISK = { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1, salesLogCapacityBytes: 1e7, reserveBytes: 1 };
const rec = (min: number, x: Partial<IssuedReport> & { through: number }): BoxHealthRecord => ({
  storeId: 'S1', observedAt: at(min * 60_000), receivedAt: at(min * 60_000), reportedBy: 'u-box', clockAheadCorrected: false, tills: [], disk: DISK,
  queue: { unsent: x.unsent?.count ?? 0, deadLettered: 0 },
  receiptNumbersIssued: [{ prefix: 'A-', soldThrough: x.through, unsent: { count: 0 }, ...x } as IssuedReport],
} as BoxHealthRecord);
const entries = (records: readonly BoxHealthRecord[]) => records.map((raw, i) => ({ raw, judged: raw, seq: i + 1 }));

describe('round 32 · verifier r31 mutant 7: the saved waiting clock holds at most WAIT_RANGES_MAX ranges, or it is set aside', () => {
  const records = Array.from({ length: 50 }, (_, m) => rec(m, { through: 200, unsent: { count: 1, from: 150 + m, to: 150 + m } }));
  const made = readBoxHistory({ sealKey: K, entries: entries(records), at: at(60 * 60_000), banked: new Map([['A-', 100]]), settleBefore: at(55 * 60_000), settledThrough: 50, timeZone: 'UTC' });
  if ('setAside' in made) throw new Error(made.setAside);
  const snap = JSON.parse(JSON.stringify(made.snapshot)) as BoxHistorySnapshot;
  const withRanges = (n: number): BoxHistorySnapshot => {
    const s = JSON.parse(JSON.stringify(snap)) as BoxHistorySnapshot & { stores: unknown[][] };
    const waits = s.stores[0]![3] as unknown[][];
    const clock: unknown[] = [Math.floor(t0 / H), 1];
    for (let k = 0; k < n; k += 1) clock.push(k === 0 ? 1 : 2, 0, t0, 0, 0, 0, 0); // numbers 1, 3, 5, … each its own range
    waits[0]![2] = clock;
    const { check: _c, sizeBytes: _z, ...rest } = s; void _c; void _z;
    return sealBoxHistory(rest as never, K); // correctly sealed: only the shape check can refuse it
  };

  it(`exactly ${WAIT_RANGES_MAX} ranges: read; ${WAIT_RANGES_MAX + 1}: set aside as unreadable, even correctly sealed`, () => {
    expect(boxHistoryUnreadable(withRanges(WAIT_RANGES_MAX), K)).toBeUndefined();
    expect(boxHistoryUnreadable(withRanges(WAIT_RANGES_MAX + 1), K)).toBe('its part "stores" is missing or not readable');
    expect(readBoxHistory({ sealKey: K, entries: [], snapshot: withRanges(WAIT_RANGES_MAX + 1), at: at(61 * 60_000), banked: new Map([['A-', 100]]), timeZone: 'UTC' }))
      .toEqual({ setAside: 'unreadable: its part "stores" is missing or not readable' });
  });
});

describe('round 32 · verifier r31 (cosmetic): a joined range is not named as numbers "first seen"', () => {
  it('more distinct lists than the cap: the words say the clock runs from the earliest sight kept together — never "first saw" numbers no list named', () => {
    // Every minute a list names one NEW single number (2, 4, 6, …: gaps between them never listed) and the stuck bill 1.
    const records: BoxHealthRecord[] = [];
    for (let m = 0; m < 3 * WAIT_RANGES_MAX; m += 1) records.push(rec(m, { through: 1000, unsent: { count: 1, from: 2 + 2 * m, to: 2 + 2 * m } }));
    // The latest list spans numbers whose ranges were joined: "first saw <numbers>" would name odd numbers never listed.
    const last = 3 * WAIT_RANGES_MAX;
    records.push(rec(last, { through: 1000, unsent: { count: 2, from: 2, to: 2 + 2 * (last - 1) } }));
    const f = billsWaitingOnTheBox({ records, storeId: 'S1', at: at((last + 180) * 60_000), warnHours: 2 });
    expect(f).toHaveLength(1);
    expect(f[0]!.since).toBe(at(0));
    expect(f[0]!.detail).toMatch(/head office's clock for them runs from .*, the first time a waiting list reached these numbers or the ones it keeps together with them .* never late\), and they are still said to be waiting/);
    expect(f[0]!.detail).not.toMatch(/head office first saw/);
    // The saved result keeps the "joined" mark: read back from it (resumed), the words are the same.
    const when = at((last + 180) * 60_000);
    const made = readBoxHistory({ sealKey: K, entries: entries(records), at: when, banked: new Map([['A-', 1000]]), settleBefore: when, settledThrough: records.length, timeZone: 'UTC' });
    if ('setAside' in made) throw new Error(made.setAside);
    const resumed = readBoxHistory({ sealKey: K, entries: [], snapshot: JSON.parse(JSON.stringify(made.snapshot)) as BoxHistorySnapshot, at: when, banked: new Map([['A-', 1000]]), timeZone: 'UTC' });
    if ('setAside' in resumed) throw new Error(resumed.setAside);
    expect(resumed.resumed).toBe(true);
    expect(billsWaitingOnTheBox({ records: [], storeId: 'S1', at: when, warnHours: 2, facts: resumed.view.waiting('S1') })).toEqual(f);
    // A clock that never joined still names the numbers it first saw, as before.
    const g = billsWaitingOnTheBox({ records: records.slice(0, 5), storeId: 'S1', at: at(200 * 60_000), warnHours: 2 });
    expect(g[0]!.detail).toMatch(/head office first saw A-000010 said to be waiting at /);
  });
});
