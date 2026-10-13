import { describe, it, expect } from 'vitest';
import {
  unreceivedCandidates, believedRecord, stillOnTheBox, saysItMayHold, sparseHolding, DEFAULT_CLAIM_SLACK, DEFAULT_BOX_UNSENT_WARN_HOURS,
  UNRECEIVED_GRACE_MINUTES, UNRECEIVED_CHECK_CAP, type BoxHealthRecord, type ClaimSlack, type IssuedReport, type UnreceivedCandidate,
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
 */

function plainReading(input: { records: readonly BoxHealthRecord[]; at: string; banked: ReadonlyMap<string, number>; warnHours?: number; slack?: ClaimSlack }): UnreceivedCandidate[] {
  const slack = input.slack ?? DEFAULT_CLAIM_SLACK;
  const atMs = Date.parse(input.at);
  const cutoff = atMs - UNRECEIVED_GRACE_MINUTES * 60_000;
  const lineMs = (input.warnHours ?? DEFAULT_BOX_UNSENT_WARN_HOURS) * 3_600_000;
  const by = new Map<string, { storeId: string; prefix: string; numbers: Map<number, { noted: number; notedAt: string; gone: number }>; latest: { r: BoxHealthRecord; x: IssuedReport }; wqs: string | undefined }>();
  const ordered = [...input.records].filter((r) => Date.parse(r.receivedAt) <= atMs).sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt)).map(believedRecord);
  for (const r of ordered) {
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
      const each: number[] = [];
      for (let n = Math.max(banked + 1, sold - UNRECEIVED_CHECK_CAP + 1); n <= sold; n += 1) each.push(n);
      for (const [from, to] of x.atRisk ?? []) for (let n = Math.max(from, to - UNRECEIVED_CHECK_CAP + 1); n <= to; n += 1) each.push(n);
      for (const n of each) {
        if (!stillOnTheBox(r, x, n, false, slack)) {
          const e = cur.numbers.get(n);
          if (e === undefined) cur.numbers.set(n, { noted: notedMs, notedAt, gone: Infinity });
          else if (notedMs < e.noted) { e.noted = notedMs; e.notedAt = notedAt; }
        }
        const e = cur.numbers.get(n);
        if (e !== undefined && e.gone === Infinity && saysItMayHold(r, x, n) === undefined) e.gone = ms;
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
      } as IssuedReport);
    }
    const lie = rnd() < 0.1 ? -1 : 0; // now and then a report that contradicts its own queue
    const queue = { unsent: Math.max(0, unsentTotal + lie + (rnd() < 0.3 ? Math.floor(rnd() * 3) : 0)), deadLettered: Math.max(0, deadTotal + (rnd() < 0.1 ? 1 : 0)) };
    prev = {
      storeId, observedAt: at, receivedAt: at, reportedBy: 'u-box', clockAheadCorrected: false, tills: [],
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
