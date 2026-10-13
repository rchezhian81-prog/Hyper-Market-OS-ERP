import { describe, it, expect } from 'vitest';
import {
  unreceivedCandidates, believedRecord, stillOnTheBox, saysItMayHold, sparseHolding, DEFAULT_CLAIM_SLACK, DEFAULT_BOX_UNSENT_WARN_HOURS,
  UNRECEIVED_GRACE_MINUTES, UNRECEIVED_CHECK_CAP, bindPrefixesToComputers, atRiskExamined,
  type BoxHealthRecord, type ClaimSlack, type IssuedReport, type UnreceivedCandidate,
} from '../../services/platform/src/box-health';

/**
 * **Verifier r23 NEW-2 · the never-received fold is fast AND says exactly what its rule says.**
 *
 * Round 23 made `unreceivedCandidates` 50–65× slower (every uncovered number of every report re-checked, with two date
 * parses each). Round 24 parses each time once, skips numbers that can learn nothing, skips a report that repeats the
 * previous one word for word, and skips a run of numbers already settled. Those are shortcuts — so this file holds the
 * rule read PLAINLY (every number of every report, no shortcut: `plainReading` below) and proves the fast fold gives the
 * same answer, field for field, on 300 seeded random store-computer histories: repeated reports, rising counts, empty
 * queues between waiting ones, lists without a per-prefix `unsent` (the whole queue standing in up to the owner's line),
 * sparse and whole lists, given-up bills, numbers a restored box cannot vouch for, self-contradicting reports, more
 * numbers than the check cap, two stores and two prefixes.
 *
 * Round 25 (OB-93/94/96) extends the plain reading with the round's rules, read just as plainly: a report that contradicts
 * its own queue never says a bill is gone (OB-93); a number the box says it gave and never used is held, never noted
 * (OB-94 `unused`); a second store computer's word about a prefix another one reported first is not read (OB-94 binding);
 * and the at-risk numbers checked per report are the newest 500 across ALL its ranges (OB-96). The fast fold keeps a SET of
 * settled runs per prefix; the histories now carry many at-risk ranges, unused ranges and a second store computer.
 */

function plainReading(input: { records: readonly BoxHealthRecord[]; at: string; banked: ReadonlyMap<string, number>; warnHours?: number; slack?: ClaimSlack }): UnreceivedCandidate[] {
  const slack = input.slack ?? DEFAULT_CLAIM_SLACK;
  const atMs = Date.parse(input.at);
  const cutoff = atMs - UNRECEIVED_GRACE_MINUTES * 60_000;
  const lineMs = (input.warnHours ?? DEFAULT_BOX_UNSENT_WARN_HOURS) * 3_600_000;
  const by = new Map<string, { storeId: string; prefix: string; numbers: Map<number, { noted: number; notedAt: string; gone: number }>; latest: { r: BoxHealthRecord; x: IssuedReport }; wqs: string | undefined }>();
  const ordered = bindPrefixesToComputers([...input.records].filter((r) => Date.parse(r.receivedAt) <= atMs))
    .map((raw, i) => ({ raw, i })).sort((a, b) => Date.parse(a.raw.receivedAt) - Date.parse(b.raw.receivedAt) || a.i - b.i)
    .map(({ raw }) => ({ r: believedRecord(raw), contradicted: believedRecord(raw) !== raw }));
  for (const { r, contradicted } of ordered) {
    const ms = Date.parse(r.receivedAt);
    for (const x of r.receiptNumbersIssued ?? []) {
      const key = `${r.storeId}|${x.prefix}`;
      const cur = by.get(key) ?? { storeId: r.storeId, prefix: x.prefix, numbers: new Map(), latest: { r, x }, wqs: undefined };
      by.set(key, cur);
      cur.latest = { r, x };
      cur.wqs = x.unsent === undefined && r.queue.unsent > 0 ? (cur.wqs ?? r.receivedAt) : undefined;
      const lineAt = cur.wqs === undefined ? undefined : Date.parse(cur.wqs) + lineMs;
      const notedMs = lineAt === undefined || ms >= lineAt ? ms : lineAt;
      const notedAt = notedMs === ms ? r.receivedAt : new Date(notedMs).toISOString();
      const banked = input.banked.get(x.prefix) ?? 0;
      const sold = x.soldThrough ?? x.through;
      const each = new Set<number>();
      for (let n = Math.max(banked + 1, sold - UNRECEIVED_CHECK_CAP + 1); n <= sold; n += 1) each.add(n);
      // OB-96: the newest 500 at-risk numbers across all its ranges (atRiskExamined is checked by hand below).
      for (const [from, to] of atRiskExamined(x.atRisk).ranges) for (let n = from; n <= to; n += 1) each.add(n);
      for (const n of each) {
        if (!stillOnTheBox(r, x, n, false, slack)) {
          const e = cur.numbers.get(n);
          if (e === undefined) cur.numbers.set(n, { noted: notedMs, notedAt, gone: Infinity });
          else if (notedMs < e.noted) { e.noted = notedMs; e.notedAt = notedAt; }
        }
        const e = cur.numbers.get(n);
        if (e !== undefined && e.gone === Infinity && !contradicted && saysItMayHold(r, x, n) === undefined) e.gone = ms;
      }
    }
  }
  const out: UnreceivedCandidate[] = [];
  for (const v of by.values()) {
    const { r, x } = v.latest;
    const standsIn = v.wqs !== undefined && atMs < Date.parse(v.wqs) + lineMs;
    const all: number[] = [];
    const claims = new Map<number, 'list' | 'queue'>();
    for (const [n, e] of v.numbers) {
      if (e.noted > cutoff) continue;
      const claim = e.gone <= cutoff ? saysItMayHold(r, x, n) : undefined;
      if (claim !== undefined) claims.set(n, claim);
      else if (stillOnTheBox(r, x, n, standsIn, slack)) continue;
      all.push(n);
    }
    if (all.length === 0) continue;
    all.sort((a, b) => a - b);
    const numbers = all.slice(-UNRECEIVED_CHECK_CAP);
    const back = numbers.filter((n) => claims.has(n));
    const sparse = sparseHolding(x, slack);
    out.push({
      storeId: v.storeId, prefix: v.prefix, numbers, since: numbers.map((n) => v.numbers.get(n)!.notedAt).sort()[0]!, capped: all.length > numbers.length,
      ...(sparse === undefined ? {} : { sparse }),
      ...(v.wqs === undefined ? {} : { wholeQueue: { items: r.queue.unsent, since: v.wqs } }),
      ...(back.length === 0 ? {} : { reclaimed: { numbers: back, saidGoneAt: new Date(Math.min(...back.map((n) => v.numbers.get(n)!.gone))).toISOString(), byList: back.some((n) => claims.get(n) === 'list') } }),
    });
  }
  return out;
}

/** A small seeded generator (mulberry32), so a failure names its seed and replays. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function history(seed: number): { records: BoxHealthRecord[]; banked: Map<string, number>; at: string; slack: ClaimSlack } {
  const rnd = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const big = rnd() < 0.15; // sometimes more numbers than the check cap
  const banked = new Map<string, number>([['A-', pick([0, 3, 10])], ['B-', pick([0, 5])]]);
  const records: BoxHealthRecord[] = [];
  let t = Date.parse('2026-03-01T00:00:00.000Z');
  const sold = new Map<string, number>([['A-', 12], ['B-', 8]]);
  let prev: BoxHealthRecord | undefined;
  const n = 5 + Math.floor(rnd() * 45);
  for (let i = 0; i < n; i += 1) {
    t += pick([15_000, 15_000, 60_000, 10 * 60_000, 40 * 60_000, 95 * 60_000]);
    const at = new Date(t).toISOString();
    if (prev !== undefined && rnd() < 0.3) { records.push({ ...prev, observedAt: at, receivedAt: at }); continue; } // a repeat
    const storeId = rnd() < 0.85 ? 'S1' : 'S2';
    const issued: IssuedReport[] = [];
    let unsentTotal = 0;
    let deadTotal = 0;
    for (const prefix of ['A-', 'B-']) {
      if (rnd() < 0.15) continue; // the prefix left out of this report
      if (rnd() < 0.5) sold.set(prefix, sold.get(prefix)! + Math.floor(rnd() * (big ? 200 : 4)));
      const s = sold.get(prefix)!;
      const span = (): { count: number; from: number; to: number } => {
        const from = 1 + Math.floor(rnd() * s);
        const to = Math.min(s, from + Math.floor(rnd() * 12));
        const whole = to - from + 1;
        return { count: rnd() < 0.7 ? whole : Math.max(1, Math.floor(whole / 4)), from, to };
      };
      const shape = pick(['none', 'zero', 'list', 'list', 'nolist']);
      const unsent = shape === 'zero' ? { count: 0 } : shape === 'list' ? span() : shape === 'none' ? { count: 0 } : undefined;
      const dead = rnd() < 0.2 ? span() : rnd() < 0.5 ? { count: 0 } : undefined;
      unsentTotal += unsent?.count ?? 0;
      deadTotal += dead?.count ?? 0;
      issued.push({
        prefix, through: s, ...(rnd() < 0.9 ? { soldThrough: s } : {}),
        ...(unsent === undefined ? {} : { unsent }), ...(dead === undefined ? {} : { deadLettered: dead }),
        ...(rnd() < 0.1 ? { atRisk: [[1, 3], [Math.max(1, s - 2), s]] as [number, number][] } : {}),
        // Round 25 · OB-96: many at-risk ranges (more than the 500 checked per report when the history is big).
        ...(rnd() < 0.08 ? { atRisk: Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, j) => [1 + j * 40, Math.min(s, 1 + j * 40 + Math.floor(rnd() * 120))] as [number, number]).filter(([a, z]) => a <= z) } : {}),
        // Round 25 · OB-94: numbers given and never used (rising, apart, within what it sold).
        ...(rnd() < 0.25 ? { unused: (() => { const out: [number, number][] = []; let at = 1 + Math.floor(rnd() * Math.max(1, s)); for (let j = 0; j < 3 && at <= s; j += 1) { const z = Math.min(s, at + Math.floor(rnd() * 3)); out.push([at, z]); at = z + 2 + Math.floor(rnd() * 5); } return out; })() } : {}),
      } as IssuedReport);
    }
    const lie = rnd() < 0.1 ? -1 : 0; // now and then a report that contradicts its own queue
    const queue = { unsent: Math.max(0, unsentTotal + lie + (rnd() < 0.3 ? Math.floor(rnd() * 3) : 0)), deadLettered: Math.max(0, deadTotal + (rnd() < 0.1 ? 1 : 0)) };
    prev = {
      // Round 25 · OB-94: now and then a SECOND store computer reports too (its word about a bound prefix is not read).
      storeId, observedAt: at, receivedAt: at, reportedBy: rnd() < 0.1 ? 'u-box-2' : 'u-box', clockAheadCorrected: false, tills: [],
      disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1, salesLogCapacityBytes: 1e7, reserveBytes: 1 }, queue, receiptNumbersIssued: issued,
    } as BoxHealthRecord;
    records.push(prev);
  }
  // Shuffle the arrival list (head office sorts it), and read at a random moment after the last report.
  for (let i = records.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [records[i], records[j]] = [records[j]!, records[i]!]; }
  return { records, banked, at: new Date(t + pick([0, 60_000, 31 * 60_000, 3 * 3_600_000])).toISOString(), slack: pick([DEFAULT_CLAIM_SLACK, { numbers: 0, percent: 0 }, { numbers: 100, percent: 50 }]) };
}

describe('verifier r23 NEW-2: the fast never-received fold says exactly what its plain reading says', () => {
  it('300 seeded random store-computer histories, read after every report, field for field', () => {
    let named = 0;
    let reclaimed = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const h = history(seed);
      // Read at the history's own moment, and at the grace after EVERY report (so each number's noted time is checked —
      // a number noted too early or too late changes who is named at one of these moments, not only the earliest `since`).
      const moments = [h.at, ...h.records.map((r) => new Date(Date.parse(r.receivedAt) + UNRECEIVED_GRACE_MINUTES * 60_000).toISOString())];
      for (const [i, at] of moments.entries()) for (const warnHours of i === 0 ? [undefined, 1] : [undefined]) {
        const input = { records: h.records, at, banked: h.banked, slack: h.slack, ...(warnHours === undefined ? {} : { warnHours }) };
        const fast = unreceivedCandidates(input);
        expect(fast, `seed ${seed}, at ${at}, warnHours ${warnHours ?? 'default'}`).toEqual(plainReading(input));
        named += fast.length;
        reclaimed += fast.filter((c) => c.reclaimed !== undefined).length;
      }
    }
    // The histories exercise both outcomes (not a vacuous comparison of empty answers).
    expect(named).toBeGreaterThan(100);
    expect(reclaimed).toBeGreaterThan(20);
  }, 60_000);
});

describe('verifier r23 NEW-1: what a report says, by its own word, the box may still hold', () => {
  const q = (unsent: number, deadLettered = 0) => ({ queue: { unsent, deadLettered } });
  it('a list\'s span (sparse or whole), the whole queue when there is no list, the given-up queue when there is no list of those', () => {
    expect(saysItMayHold(q(3), { unsent: { count: 3, from: 10, to: 12 } }, 11)).toBe('list');
    expect(saysItMayHold(q(2), { unsent: { count: 2, from: 10, to: 900 } }, 500)).toBe('list'); // sparse: may be any of them
    expect(saysItMayHold(q(0, 1), { unsent: { count: 0 }, deadLettered: { count: 1, from: 7, to: 7 } }, 7)).toBe('list');
    expect(saysItMayHold(q(1), {}, 7)).toBe('queue'); // an older box: its whole queue
    expect(saysItMayHold(q(0, 2), { unsent: { count: 0 } }, 7)).toBe('queue'); // given up on some, without a list of them
    // Said NOT held: an empty queue, a list that does not reach it, a given-up list that does not reach it.
    expect(saysItMayHold(q(0), {}, 7)).toBeUndefined();
    expect(saysItMayHold(q(0), { unsent: { count: 0 } }, 7)).toBeUndefined();
    expect(saysItMayHold(q(3), { unsent: { count: 3, from: 10, to: 12 } }, 9)).toBeUndefined();
    expect(saysItMayHold(q(3, 1), { unsent: { count: 3, from: 10, to: 12 }, deadLettered: { count: 1, from: 1, to: 1 } }, 9)).toBeUndefined();
  });
});

describe('verifier r23 NEW-1: a bill the box let go is named only after the grace from when it said so', () => {
  it('noted inside a sparse claim, said gone an hour later, claimed again a minute after: named only 30 minutes after "gone"', () => {
    const t0 = Date.parse('2026-03-01T00:00:00.000Z');
    const rec = (min: number, unsent: { count: number; from?: number; to?: number }, queue: number): BoxHealthRecord => {
      const at = new Date(t0 + min * 60_000).toISOString();
      return {
        storeId: 'S1', observedAt: at, receivedAt: at, reportedBy: 'u-box', clockAheadCorrected: false, tills: [],
        disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1, salesLogCapacityBytes: 1e7, reserveBytes: 1 },
        queue: { unsent: queue, deadLettered: 0 }, receiptNumbersIssued: [{ prefix: 'A-', through: 20, soldThrough: 20, unsent }],
      } as BoxHealthRecord;
    };
    const records = [
      rec(0, { count: 2, from: 11, to: 20 }, 2), // sparse: 11–20 noted (the box vouches for none of them in particular)
      rec(60, { count: 0 }, 0), // "none waiting": 11–20 said gone
      rec(61, { count: 10, from: 11, to: 20 }, 10), // claimed again, whole
    ];
    const read = (min: number) => unreceivedCandidates({ records, at: new Date(t0 + min * 60_000).toISOString(), banked: new Map([['A-', 10]]) });
    expect(read(62)).toEqual([]); // inside the grace from "gone" — the latest claim still holds them back
    expect(read(60 + UNRECEIVED_GRACE_MINUTES - 1)).toEqual([]);
    const named = read(60 + UNRECEIVED_GRACE_MINUTES);
    expect(named.map((c) => [c.numbers, c.reclaimed])).toEqual([[
      [11, 12, 13, 14, 15, 16, 17, 18, 19, 20], { numbers: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20], saidGoneAt: new Date(t0 + 60 * 60_000).toISOString(), byList: true },
    ]]);
    expect(named[0]!.since).toBe(new Date(t0).toISOString()); // noted from the first report that did not vouch for them
  });
});

describe('round 25 · OB-96: the at-risk numbers checked per report are the newest 500 across ALL its ranges', () => {
  it('by hand: one range, several ranges, overlapping ranges, and none', () => {
    expect(atRiskExamined(undefined)).toEqual({ ranges: [], unchecked: 0 });
    expect(atRiskExamined([[101, 600]])).toEqual({ ranges: [[101, 600]], unchecked: 0 });
    expect(atRiskExamined([[1, 1500]])).toEqual({ ranges: [[1001, 1500]], unchecked: 1000 });
    expect(atRiskExamined([[1, 300], [1001, 1300]])).toEqual({ ranges: [[101, 300], [1001, 1300]], unchecked: 100 });
    expect(atRiskExamined([[1, 10], [5, 20], [21, 30]])).toEqual({ ranges: [[1, 30]], unchecked: 0 });
    const many = Array.from({ length: 50 }, (_, j) => [j * 1000 + 1, j * 1000 + 500] as [number, number]);
    expect(atRiskExamined(many)).toEqual({ ranges: [[49_001, 49_500]], unchecked: 24_500 });
    expect(UNRECEIVED_CHECK_CAP).toBe(500);
  });
});

describe('round 25 · OB-93 / OB-94 by hand', () => {
  const t0 = Date.parse('2026-03-01T00:00:00.000Z');
  const rec = (min: number, x: Partial<IssuedReport>, queue: number): BoxHealthRecord => {
    const at = new Date(t0 + min * 60_000).toISOString();
    return {
      storeId: 'S1', observedAt: at, receivedAt: at, reportedBy: 'u-box', clockAheadCorrected: false, tills: [],
      disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1, salesLogCapacityBytes: 1e7, reserveBytes: 1 },
      queue: { unsent: queue, deadLettered: 0 }, receiptNumbersIssued: [{ prefix: 'A-', through: 110, soldThrough: 110, ...x }],
    } as BoxHealthRecord;
  };
  const read = (records: BoxHealthRecord[], min: number) => unreceivedCandidates({ records, at: new Date(t0 + min * 60_000).toISOString(), banked: new Map([['A-', 100]]) });

  it('OB-94: a number noted earlier is held back once the box lists it as given and never used', () => {
    // 105 sits in a sparse claim (noted, never said gone); later reports say it was never used.
    const records = [rec(0, { unsent: { count: 2, from: 101, to: 110 } }, 2)];
    for (let k = 1; k <= 40; k += 1) records.push(rec(k, { unsent: { count: 9, from: 101, to: 110 }, unused: [[105, 105]] }, 9));
    expect(read(records, 41)).toEqual([]);
    // Without the box's word (an older box) the sparse claim alone does not vouch for 105 by number.
    expect(read(records.slice(0, 1), 41).map((c) => c.numbers.includes(105))).toEqual([true]);
  });

  it('OB-93: a self-contradicting report right after an honest one with the same lists starts the clock (it is not a repeat)', () => {
    const records = [
      rec(0, { unsent: { count: 10, from: 101, to: 110 } }, 10), // honest: holds 101–110
      rec(1, { unsent: { count: 10, from: 101, to: 110 } }, 9), // the same lists, but its queue says 9: not believed — noted, never "gone"
      rec(2, { unsent: { count: 0 } }, 0), // "nothing waiting": now gone
    ];
    const named = read(records, 31.5);
    expect(named.map((c) => [c.numbers.length, c.since])).toEqual([[10, new Date(t0 + 60_000).toISOString()]]);
  });

  it('OB-93: an honest report that reads like the self-contradicting one before it is NOT a repeat — it can say "gone"', () => {
    const records = [
      rec(0, { unsent: { count: 10, from: 101, to: 110 } }, 9), // contradicts itself: believed as "none listed", says nothing gone
      rec(1, { unsent: { count: 0 } }, 5), // honest: none of these bills waiting (its queue holds other things): gone
      rec(2, { unsent: { count: 10, from: 101, to: 110 } }, 10), // claims them all again
    ];
    const named = read(records, 32);
    expect(named.map((c) => [c.numbers.length, c.reclaimed?.saidGoneAt])).toEqual([[10, new Date(t0 + 60_000).toISOString()]]);
  });
});
