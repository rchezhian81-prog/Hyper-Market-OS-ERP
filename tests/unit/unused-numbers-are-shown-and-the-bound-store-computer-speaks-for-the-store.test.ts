import { describe, it, expect } from 'vitest';
import {
  readNeverReceived, unreceivedCandidates, billNumberFindingsFor, judgeBoxes, unusedButReceived, unusedNumbersByDay, layUnused,
  UNUSED_CONTRADICTION_MARGIN_MINUTES, UNUSED_DAYS_SHOWN,
  type BoxHealthRecord, type IssuedReport, type StoreComputerReplacement, type BillNumberFinding,
} from '../../services/platform/src/box-health';
import { DEFAULT_THRESHOLDS } from '../../packages/ops/src/index';

/**
 * **Round 27 · owner decisions OB-100 "A" and OB-101 "A" (13 Oct 2026, in writing) — the pure rules, by hand.**
 *
 * OB-100 (verifier r26 NEW-1, probes U1/U2/U4): numbers a store computer says it took and never used are SHOWN — per till
 * prefix, per day it first said so (the store's own calendar) — neutrally, "taken but never used", never as a "find the paper
 * bill" alarm (OB-94's aim kept); and head office raises `unused_number_received` when it HOLDS a sale or return under a
 * number the store computer said, after that bill was made, it never used. An honest store computer that lists a held bill's
 * number as unused and completes the bill later (r26 P5-new) raises nothing.
 *
 * OB-101 (verifier r26 NEW-2, NEW-3, probes B1/B2): the refusal of a second store computer names both machines neutrally and
 * says which one head office uses and why; a store's disk, queue, tills and numbering come only from the store computer that
 * holds its tills' prefixes — a refused one's healthy report never hides the bound one's full disk; the refused one is shown
 * apart. And (NEW-5, the act-time mutant) an owner-approved act answers only the refusals from BEFORE it (probe R2).
 */

const t0 = Date.parse('2026-03-01T08:00:00.000Z');
const iso = (min: number): string => new Date(t0 + min * 60_000).toISOString();
const DISK = { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1, salesLogCapacityBytes: 1e7, reserveBytes: 1 };
const rec = (min: number, x: Partial<IssuedReport> & { through: number }, queue: number, by = 'u-box-a', disk: Partial<BoxHealthRecord['disk']> = {}): BoxHealthRecord => ({
  storeId: 'S1', observedAt: iso(min), receivedAt: iso(min), reportedBy: by, clockAheadCorrected: false, tills: [],
  disk: { ...DISK, ...disk }, queue: { unsent: queue, deadLettered: 0 },
  receiptNumbersIssued: [{ prefix: 'A-', soldThrough: x.through, ...x } as IssuedReport],
} as BoxHealthRecord);
const act = (min: number, from: string, to: string, id: string): StoreComputerReplacement => ({
  replacementId: id, storeId: 'S1', prefix: 'A-', from, to, reason: 'swap box', requestedBy: 'hq', approvedBy: 'owner', approvalId: id, at: iso(min),
});

function read(records: BoxHealthRecord[], min: number, banked: number, extra: { replacements?: StoreComputerReplacement[]; timeZone?: string } = {}) {
  const at = iso(min);
  const b = new Map([['A-', banked]]);
  const r = readNeverReceived({ records, at, banked: b, ...extra });
  const findings = billNumberFindingsFor({
    storeId: 'S1', records, at, banked: b, ...(extra.replacements === undefined ? {} : { replacements: extra.replacements }),
    unreceived: r.candidates.map((c) => ({ prefix: c.prefix, numbers: c.numbers, since: c.since, capped: c.capped, ...(c.reclaimed ? { reclaimed: c.reclaimed } : {}) })),
  });
  const judged = judgeBoxes({ records, at, thresholds: DEFAULT_THRESHOLDS, billNumberFindings: new Map([['S1', findings]]), ...extra });
  return { r, findings, kinds: findings.map((f) => f.kind), judged, box: judged.boxes.find((x) => x.storeId === 'S1')!, comp: (name: string) => judged.components.find((c) => c.name === `${name}:S1`) };
}

describe('OB-100: numbers taken and never used are shown, per till and day, neutrally', () => {
  it('U1: the last bill deleted and declared unused — head office never received it — is SHOWN (no paper-bill alarm)', () => {
    // 101–109 banked; 110 sold, then removed from the box's queue and reported as given and never used.
    const records = Array.from({ length: 41 }, (_, k) => rec(k, { through: 110, unsent: { count: 0 }, unused: [[110, 110]] }, 0));
    const h = read(records, 41, 109);
    expect(h.kinds).toEqual([]); // OB-94 kept: no "find the paper bill"
    expect(h.box.unusedNumbers).toEqual([{ prefix: 'A-', day: '2026-03-01', count: 1, ranges: [[110, 110]], moreRanges: 0, lastSaidAt: '2026-03-01T08:00:00.000Z' }]);
    const c = h.comp('box_unused_numbers')!;
    expect(c.status).toBe('ok');
    expect(c.detail).toMatch(/^taken but never used \(information — nothing to look for\): store S1's computer says these bill numbers were given and never put on a bill — till A- on 2026-03-01: 1 number\(s\), A-000110\./);
    expect(c.detail).not.toMatch(/paper/);
    expect(c.evidence).toMatchObject({ days: 1, numbers: 1, byTillAndDay: 'A-@2026-03-01:1' });
  });

  it('U2: 500 numbers declared unused in an outage are all shown, counted', () => {
    const records = Array.from({ length: 41 }, (_, k) => rec(k, { through: 600, unsent: { count: 0 }, unused: [[101, 600]] }, 0));
    const h = read(records, 41, 100);
    expect(h.box.unusedNumbers?.map((d) => [d.prefix, d.day, d.count, d.ranges])).toEqual([['A-', '2026-03-01', 500, [[101, 600]]]]);
    expect(h.comp('box_unused_numbers')!.detail).toMatch(/till A- on 2026-03-01: 500 number\(s\), A-000101 to A-000600/);
  });

  it('per day by the STORE\'s calendar: numbers first said either side of midnight in India are two days; the first day stays', () => {
    // 18:20 UTC = 23:50 IST on 1 March; 18:40 UTC = 00:10 IST on 2 March.
    const at = (h: number, m: number): string => new Date(Date.UTC(2026, 2, 1, h, m)).toISOString();
    const r = (when: string, unused: [number, number][]): BoxHealthRecord => ({ ...rec(0, { through: 120, unsent: { count: 0 }, unused }, 0), observedAt: when, receivedAt: when });
    const records = [r(at(18, 20), [[105, 105]]), r(at(18, 40), [[105, 105], [111, 112]]), r(at(19, 0), [[105, 105], [111, 112], [115, 115]])];
    const ist = readNeverReceived({ records, at: at(20, 0), banked: new Map([['A-', 100]]) }).unused.get('S1')!;
    expect(unusedNumbersByDay(ist).map((d) => [d.day, d.count, d.ranges])).toEqual([['2026-03-02', 3, [[111, 112], [115, 115]]], ['2026-03-01', 1, [[105, 105]]]]);
    const utc = readNeverReceived({ records, at: at(20, 0), banked: new Map([['A-', 100]]), timeZone: 'UTC' }).unused.get('S1')!;
    expect(unusedNumbersByDay(utc).map((d) => [d.day, d.count])).toEqual([['2026-03-01', 4]]);
  });

  it('only the newest days are shown; and laying a list keeps each number\'s first day and its latest hour', () => {
    const list = [{ prefix: 'A-', runs: Array.from({ length: UNUSED_DAYS_SHOWN + 3 }, (_, d) => ({ from: d * 10 + 1, to: d * 10 + 1, day: `2026-03-${String(d + 1).padStart(2, '0')}`, lastSaidAt: iso(d) })) }];
    const days = unusedNumbersByDay(list).map((d) => d.day);
    expect(days).toHaveLength(UNUSED_DAYS_SHOWN);
    expect(days[0]).toBe('2026-03-10');
    expect(layUnused([{ lo: 5, hi: 9, day: 'd1', lastMs: 1 }], [[3, 6], [9, 11]], 'd2', 5)).toEqual([
      { lo: 3, hi: 4, day: 'd2', lastMs: 5 }, { lo: 5, hi: 6, day: 'd1', lastMs: 5 }, { lo: 7, hi: 8, day: 'd1', lastMs: 1 },
      { lo: 9, hi: 9, day: 'd1', lastMs: 5 }, { lo: 10, hi: 11, day: 'd2', lastMs: 5 },
    ]);
  });

  it('a self-contradicting report\'s unused list is still shown (what it said), though not believed', () => {
    const records = [rec(0, { through: 110, unsent: { count: 3, from: 101, to: 103 }, unused: [[105, 105]] }, 1)]; // 3 listed, queue says 1
    const h = read(records, 1, 100);
    expect(h.box.unusedNumbers?.map((d) => d.ranges)).toEqual([[[105, 105]]]);
  });
});

describe('OB-100: head office holds a bill under a number the store computer said it never used', () => {
  const unused = { prefix: 'A-', runs: [{ from: 105, to: 105, day: '2026-03-01', lastSaidAt: iso(60) }] };
  it('U4: the bill was made before the store computer last said "never used" (beyond the margin) — a finding, without blame', () => {
    const found = unusedButReceived('A-', unused, new Map([[105, { as: 'sale' as const, at: iso(0) }]]));
    expect(found).toEqual([{ prefix: 'A-', number: 105, heldAs: 'sale', heldAt: iso(0), lastSaidUnusedAt: iso(60) }]);
    const f = billNumberFindingsFor({ storeId: 'S1', records: [], at: iso(61), unreceived: [], unusedReceived: found });
    expect(f.map((x: BillNumberFinding) => [x.kind, x.prefix, x.ranges, x.count])).toEqual([['unused_number_received', 'A-', [[105, 105]], 1]]);
    expect(f[0]!.detail).toMatch(/^does not fit: store S1's computer said \(last at 2026-03-01T09:00:00\.000Z\) that it gave A-000105 and never put it on a bill, but head office holds a sale under that number, made before that/);
    expect(f[0]!.detail).toMatch(/do NOT look for paper bills/);
    expect(f[0]!.detail).not.toMatch(/faulty or altered/);
  });
  it('P5-new: an honest store computer — the held bill completed AFTER its last "never used" — raises nothing', () => {
    expect(unusedButReceived('A-', unused, new Map([[105, { as: 'sale' as const, at: iso(61) }]]))).toEqual([]);
  });
  it('within the margin (clocks a little apart) nothing is raised; a return counts as well as a sale', () => {
    expect(unusedButReceived('A-', unused, new Map([[105, { as: 'sale' as const, at: iso(60 - UNUSED_CONTRADICTION_MARGIN_MINUTES) }]]))).toEqual([]);
    expect(unusedButReceived('A-', unused, new Map([[105, { as: 'return' as const, at: iso(10) }]])).map((u) => u.heldAs)).toEqual(['return']);
    expect(unusedButReceived('A-', unused, new Map([[106, { as: 'sale' as const, at: iso(0) }]]))).toEqual([]);
  });
  it('the fold keeps the latest hour each number was said — rounded down, never later than it was said', () => {
    const records = [rec(0, { through: 110, unsent: { count: 0 }, unused: [[105, 105]] }, 0), rec(95, { through: 110, unsent: { count: 0 }, unused: [[105, 105]] }, 0), rec(97, { through: 110, unsent: { count: 0 } }, 0)];
    const u = readNeverReceived({ records, at: iso(100), banked: new Map([['A-', 110]]) }).unused.get('S1')!;
    expect(u).toEqual([{ prefix: 'A-', runs: [{ from: 105, to: 105, day: '2026-03-01', lastSaidAt: '2026-03-01T09:00:00.000Z' }] }]);
  });
});

describe('OB-101: two store computers — neutral words, and the bound one speaks for the store', () => {
  it('B1: a second computer reported the prefix first — both named, which one head office uses and why; no blame', () => {
    const records = [rec(0, { through: 101, unsent: { count: 1, from: 101, to: 101 } }, 1, 'u-box-b')];
    for (let k = 1; k <= 30; k += 1) records.push(rec(k, { through: 100 + k * 2, unsent: { count: 0 } }, 0, 'u-box-a'));
    const refused = read(records, 31, 100).findings.filter((f) => f.kind === 'report_refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.detail).toMatch(/^two store computers report bill numbers under A- for store S1: u-box-b and u-box-a\. Head office uses u-box-b's reports for A- because it was the first to report A-, at 2026-03-01T08:00:00\.000Z; it keeps u-box-a's report \(through 160\) as evidence and does not use it\./);
    // The never-received risk is named on the bound computer's side; both machines are to be checked, neither blamed.
    expect(refused[0]!.detail).toMatch(/head office checks A-'s bills for loss only on u-box-b's word — bills sold on u-box-a, if that is the till's real store computer, are not checked\. Check both machines/);
    expect(refused[0]!.detail).not.toMatch(/Check which machine|must not run/);
  });

  it('B2: a refused computer\'s healthy disk never hides the bound computer\'s full disk; the refused one is shown apart', () => {
    const records = [rec(0, { through: 110, unsent: { count: 0 } }, 0, 'u-box-a', { freeBytes: 0, salesLogUsedBytes: 1e7 }), rec(1, { through: 5, unsent: { count: 0 } }, 0, 'u-box-b')];
    const h = read(records, 2, 110);
    expect(h.box.canRecordSales).toBe(false);
    expect(h.box.computer).toBe('u-box-a');
    expect(h.box.otherComputers).toEqual([{ computer: 'u-box-b', lastReportAt: iso(1), stale: false, canRecordSales: true, bindsNoTill: true }]);
    expect(h.comp('box_disk')!.status).toBe('down');
    expect(h.comp('box_disk')!.detail).toMatch(/another store computer, u-box-b, also reports for this store but holds none of its tills' bill numbers, so head office takes the store's health only from u-box-a/);
    expect(h.judged.localStoreWritable).toBe(false);
  });

  it('the hours of trading left come from the bound computer\'s own reports — a second one\'s smaller log never resets them', () => {
    const records: BoxHealthRecord[] = [];
    for (let k = 0; k <= 12; k += 1) {
      records.push(rec(k * 10, { through: 110 + k, unsent: { count: 0 } }, 0, 'u-box-a', { salesLogUsedBytes: 1_000_000 + k * 100_000, salesLogCapacityBytes: 1e9, freeBytes: 5e9 }));
      records.push(rec(k * 10 + 5, { through: 5, unsent: { count: 0 } }, 0, 'u-box-b', { salesLogUsedBytes: 10 }));
    }
    const h = read(records, 125, 200);
    expect(h.box.computer).toBe('u-box-a');
    expect(h.box.tradingHoursLeft).not.toBeNull();
    expect(h.box.tradingHoursLeftSays).toMatch(/^about [\d.]+ hours of trading left/);
  });

  it('before any prefix is bound, the latest report stands (as before)', () => {
    const plain = (min: number, by: string, free: number): BoxHealthRecord => ({ ...rec(min, { through: 1 }, 0, by, { freeBytes: free }), receiptNumbersIssued: undefined } as unknown as BoxHealthRecord);
    const h = read([plain(0, 'u-box-a', 0), plain(1, 'u-box-b', 5e9)], 2, 0);
    expect(h.box.computer).toBe('u-box-b');
    expect(h.box.canRecordSales).toBe(true);
  });

  it('bound by an owner-approved act to a computer that has not reported yet: not known — never read from the other one', () => {
    const records = [rec(0, { through: 110, unsent: { count: 0 } }, 0, 'u-box-a')];
    const h = read(records, 5, 110, { replacements: [act(2, 'u-box-a', 'u-box-new', 'scr-1')] });
    expect(h.box.state).toBe('never_reported');
    expect(h.box.otherComputers?.map((o) => o.computer)).toEqual(['u-box-a']);
    expect(h.comp('box_disk')).toMatchObject({ status: 'unknown' });
    expect(h.comp('box_disk')!.detail).toMatch(/^the store computer that holds store S1's tills' bill numbers \(u-box-new\) has not reported/);
  });

  it('R2 (NEW-5 · act time): act A→B, then B→A — B\'s report after the second act is a refusal, not answered by the first act', () => {
    const records = [rec(0, { through: 110, unsent: { count: 0 } }, 0, 'u-box-a'), rec(12, { through: 120, unsent: { count: 0 } }, 0, 'u-box-b'),
      rec(25, { through: 125, unsent: { count: 0 } }, 0, 'u-box-b'), rec(26, { through: 120, unsent: { count: 0 } }, 0, 'u-box-a')];
    const replacements = [act(10, 'u-box-a', 'u-box-b', 'scr-1'), act(20, 'u-box-b', 'u-box-a', 'scr-2')];
    const refused = read(records, 30, 125, { replacements }).findings.filter((f) => f.kind === 'report_refused');
    expect(refused.map((f) => f.through)).toEqual([125]);
    expect(refused[0]!.detail).toMatch(/Head office uses u-box-a's reports for A- because the owner approved moving A- to it at 2026-03-01T08:20:00\.000Z \(act scr-2\)/);
    // A refusal from BEFORE an act moving the prefix to that computer is answered by it (the owner looked at that machine).
    const early = [rec(0, { through: 110, unsent: { count: 0 } }, 0, 'u-box-a'), rec(5, { through: 115, unsent: { count: 0 } }, 0, 'u-box-b')];
    expect(read(early, 30, 115, { replacements: [act(10, 'u-box-a', 'u-box-b', 'scr-1')] }).findings.filter((f) => f.kind === 'report_refused')).toEqual([]);
  });

  it('the fold and its plain wrapper agree (unreceivedCandidates is the saved-result reader without a saved result)', () => {
    const records = Array.from({ length: 41 }, (_, k) => rec(k, { through: 110, unsent: { count: 0 } }, 0));
    expect(unreceivedCandidates({ records, at: iso(41), banked: new Map([['A-', 100]]) })).toEqual(readNeverReceived({ records, at: iso(41), banked: new Map([['A-', 100]]) }).candidates);
  });
});
