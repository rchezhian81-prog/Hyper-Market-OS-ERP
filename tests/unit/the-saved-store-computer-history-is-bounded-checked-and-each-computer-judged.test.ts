import { describe, it, expect } from 'vitest';
import {
  readBoxHistory, readNeverReceived, judgeBoxes, billsWaitingOnTheBox, unusedButReceived, billNumberFindingsFor, sealBoxHistory, boxHistoryUnreadable,
  boxHistoryToStore, boxHistoryFromStore,
  boxHistoryComponents, WAIT_FORGET_HOURS, UNUSED_FORGET_DAYS, UNUSED_CONTRADICTION_MARGIN_MINUTES, BOX_HISTORY_SIZE_WARN_BYTES, BOX_HISTORY_SAVE_HELD_WARN_SECONDS,
  UNUSED_HELD_TIMED_MAX, UNRECEIVED_CHECK_CAP,
  waitingFacts, boxHistorySealKey, WAIT_RANGES_MAX, REFUSED_NEW_PER_DAY_MAX, REFUSED_NOT_KEPT_SHOWN_DAYS, BOX_HISTORY_STORED_FORMAT, BOX_HISTORY_SEAL_LABEL,
  type BoxHealthRecord, type IssuedReport, type BoxHistorySnapshot, type RefusedIssued,
} from '../../services/platform/src/box-health';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { tillSealKey } from '../../packages/identity/src/till-seal';
import { tillPinKey } from '../../packages/identity/src/till-pin';
import { loyaltyMemberKey } from '../../packages/loyalty/src/earn-rule';
import { personalDataKek } from '../../packages/persistence/src/personal-data';
import { DEFAULT_THRESHOLDS } from '../../packages/ops/src/index';
import { TEST_BOX_HISTORY_KEY as K, OTHER_BOX_HISTORY_KEY, rng } from '../support/box-history';

/**
 * **Round 29 — owner decisions OB-105, OB-106, OB-107, OB-108 "A" (14 Oct 2026, in writing) and verifier r28 NEW-6, as rules.**
 *
 *   OB-105: the waiting clock forgets a span nobody has listed for WAIT_FORGET_HOURS; a stuck bill (listed in every report)
 *     keeps its clock for days. Unused runs not said again for UNUSED_FORGET_DAYS are forgotten. A refused count head office
 *     has banked is dropped from the saved result, and a LOWER banked count then sets it aside.
 *   OB-106: a damaged or altered saved result is set aside ("unreadable: …") — never thrown, never trusted (the verifier's
 *     probe C1, every shape); a copy whose keys PostgreSQL reordered still reads. The health read's words for "being
 *     prepared", the size and its alarm, saving held back, a failed build.
 *   OB-107: the verifier's probe B3 — a second store computer that holds ONE new till's prefix no longer hides the other's
 *     full disk: each is judged, the worse decides, both are named, the store cannot record sales.
 *   OB-108: the "said unused, but held" check on the store computer's own clock — the verifier's probe U5 (a till 20 minutes
 *     slow) raises nothing; the line says whose clock it used.
 *   NEW-6: the said time kept to the minute (the verifier's probe U6 now raises the line); the 50/500 limits said on the line.
 */

const t0 = Date.parse('2026-03-01T08:00:00.000Z');
const iso = (min: number): string => new Date(t0 + min * 60_000).toISOString();
const DISK = { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1, salesLogCapacityBytes: 1e7, reserveBytes: 1 };
const FULL = { freeBytes: 0, totalBytes: 1e10, salesLogUsedBytes: 1e7, salesLogCapacityBytes: 1e7, reserveBytes: 1 };
const rec = (min: number, prefix: string, x: Partial<IssuedReport> & { through: number }, by = 'u-box-a', disk = DISK, sec = 0): BoxHealthRecord => ({
  storeId: 'S1', observedAt: new Date(t0 + min * 60_000 + sec * 1000).toISOString(), receivedAt: new Date(t0 + min * 60_000 + sec * 1000).toISOString(),
  reportedBy: by, clockAheadCorrected: false, tills: [], disk, queue: { unsent: x.unsent?.count ?? 0, deadLettered: 0 },
  receiptNumbersIssued: [{ prefix, soldThrough: x.through, unsent: { count: 0 }, ...x } as IssuedReport],
} as BoxHealthRecord);
const entries = (records: readonly BoxHealthRecord[]) => records.map((raw, i) => ({ raw, judged: raw, seq: i + 1 }));

describe('round 29 · OB-105: what the saved result remembers, and for how long', () => {
  const waitingOf = (records: BoxHealthRecord[], atMin: number) => billsWaitingOnTheBox({ records, storeId: 'S1', at: iso(atMin) });

  it(`a STUCK bill (listed in every report for 3 days) keeps its clock from its first sighting — never restarted by the ${WAIT_FORGET_HOURS}-hour memory`, () => {
    const records: BoxHealthRecord[] = [];
    for (let m = 0; m <= 3 * 24 * 60; m += 60) records.push(rec(m, 'A-', { through: 105, unsent: { count: 1, from: 105, to: 105 } }));
    const f = waitingOf(records, 3 * 24 * 60 + 1);
    expect(f.map((x) => [x.kind, x.since])).toEqual([['bills_waiting_on_box', iso(0)]]);
  });

  it(`a bill nobody listed for more than ${WAIT_FORGET_HOURS} hours starts its clock again when listed again; within the day it does not`, () => {
    const listed = (m: number): BoxHealthRecord => rec(m, 'A-', { through: 105, unsent: { count: 1, from: 105, to: 105 } });
    const quiet = (m: number): BoxHealthRecord => rec(m, 'A-', { through: 105, unsent: { count: 0 } });
    // Listed at 0, then left out for 23 hours, then listed again: still the clock of 0 (hiding it for a day hides nothing).
    const within = [listed(0), ...Array.from({ length: 23 }, (_, h) => quiet(60 * (h + 1) - 30)), listed(23 * 60)];
    expect(waitingOf(within, 23 * 60 + 1).map((x) => x.since)).toEqual([iso(0)]);
    // Left out for 26 hours: forgotten; listed again at 26 h, its clock starts again then (and the owner's 2-hour line follows).
    const after = [listed(0), ...Array.from({ length: 26 }, (_, h) => quiet(60 * (h + 1) - 30)), listed(26 * 60)];
    expect(waitingOf(after, 26 * 60 + 1)).toEqual([]);
    expect(waitingOf([...after, listed(29 * 60)], 29 * 60 + 1).map((x) => x.since)).toEqual([iso(26 * 60)]);
  });

  it(`unused numbers not said again for ${UNUSED_FORGET_DAYS} days are forgotten (shown no longer); within the month they stay`, () => {
    const day = 24 * 60;
    const said = rec(0, 'A-', { through: 110, unused: [[105, 105]] });
    const later = (d: number): BoxHealthRecord => rec(d * day, 'A-', { through: 110 });
    const at = (d: number) => readNeverReceived({ records: [said, later(d)], at: iso(d * day + 1), banked: new Map([['A-', 110]]), timeZone: 'UTC' }).unused.get('S1');
    expect(at(UNUSED_FORGET_DAYS - 1)?.[0]?.runs.map((r) => [r.from, r.to])).toEqual([[105, 105]]);
    expect(at(UNUSED_FORGET_DAYS + 1)).toBeUndefined();
  });

  it('a refused count head office has banked is dropped from the saved result; a LOWER banked count later sets the result aside', () => {
    const records = Array.from({ length: 80 }, (_, m) => ({
      ...rec(m, 'A-', { through: 100 }),
      receiptNumbersRefused: [{ prefix: 'C-', through: 20_000, because: 'beyond_plausible_advance', bankedThrough: 0, plausibleThrough: 10_000 }],
    } as BoxHealthRecord));
    const banked = new Map([['A-', 100], ['C-', 30_000]]);
    const first = readBoxHistory({ sealKey: K, entries: entries(records), at: iso(200), banked, settleBefore: iso(190), settledThrough: 80, timeZone: 'UTC' });
    if ('setAside' in first) throw new Error(first.setAside);
    const snap = JSON.parse(JSON.stringify(first.snapshot)) as BoxHistorySnapshot;
    expect(snap.rfBanked).toEqual([['C-', 30_000]]);
    const prefixes = (snap.stores as unknown[][])[0]![2] as unknown[][];
    expect(prefixes.find((p) => p[0] === 'C-')![5]).toEqual([]); // its refused group is gone (answered for good)
    expect(readBoxHistory({ sealKey: K, entries: [], snapshot: snap, at: iso(201), banked, timeZone: 'UTC' })).not.toHaveProperty('setAside');
    expect(readBoxHistory({ sealKey: K, entries: [], snapshot: snap, at: iso(201), banked: new Map([['A-', 100], ['C-', 0]]), timeZone: 'UTC' })).toEqual({ setAside: 'banked' });
  });
});

describe('round 29 · OB-106: a saved result is checked before it is used (the verifier\'s probe C1)', () => {
  const records = Array.from({ length: 100 }, (_, m) => rec(m, 'A-', { through: 100 }));
  const made = readBoxHistory({ sealKey: K, entries: entries(records), at: iso(200), banked: new Map([['A-', 100]]), settleBefore: iso(190), settledThrough: 100 });
  if ('setAside' in made) throw new Error(made.setAside);
  const snap = JSON.parse(JSON.stringify(made.snapshot)) as BoxHistorySnapshot;

  it('every damaged shape is SET ASIDE as unreadable — never thrown, never trusted', () => {
    const cases: [string, unknown][] = [
      ['never missing', { ...snap, never: undefined }],
      ['stores garbage', { ...snap, stores: [['S1', null, 'x', 'y', 'z']] }],
      ['keys garbage', { ...snap, never: { ...snap.never, keys: [{}] } }],
      ['empty object', {}],
      ['not an object', 'garbage'],
      ['a waiting clock cut short', { ...snap, stores: (snap.stores as unknown[][]).map((st) => [st[0], st[1], st[2], (st[3] as unknown[][]).map((w) => [w[0], w[1], [null, 1, 0], w[3]]), st[4]]) }],
      ['an old version', { ...snap, version: 1 }],
    ];
    for (const [name, s] of cases) {
      let got: unknown;
      expect(() => { got = readBoxHistory({ sealKey: K, entries: [], snapshot: s as BoxHistorySnapshot, at: iso(201), banked: new Map([['A-', 100]]) }); }, name).not.toThrow();
      expect((got as { setAside?: string }).setAside, name).toMatch(/^unreadable: /);
    }
  });

  it('an ALTERED result (a binding moved to "u-evil") no longer matches its seal: set aside, its bindings never used', () => {
    const altered = JSON.parse(JSON.stringify(snap)) as { rawBound: { computer: string }[]; never: { bound: { computer: string }[] } };
    for (const b of altered.never.bound) b.computer = 'u-evil';
    for (const b of altered.rawBound) b.computer = 'u-evil';
    expect(boxHistoryUnreadable(altered, K)).toBe('its seal does not match its content (damaged, altered, or sealed with another key)');
    expect(readBoxHistory({ sealKey: K, entries: [], snapshot: altered as unknown as BoxHistorySnapshot, at: iso(201), banked: new Map([['A-', 100]]) }))
      .toEqual({ setAside: 'unreadable: its seal does not match its content (damaged, altered, or sealed with another key)' });
  });

  it('it is KEPT as its JSON text, so PostgreSQL\'s jsonb (which reorders an object\'s keys) never changes what is sealed', () => {
    const reorder = (v: unknown): unknown => (Array.isArray(v) ? v.map(reorder) : v !== null && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort((a, b) => a[0].length - b[0].length || (a[0] < b[0] ? 1 : -1)).map(([k, x]) => [k, reorder(x)])) : v);
    // As a jsonb row would hand it back: the text inside is a string, kept exactly — readable, the same seal.
    const row = reorder(JSON.parse(JSON.stringify(boxHistoryToStore(snap))));
    const back = boxHistoryFromStore(row) as BoxHistorySnapshot;
    expect(boxHistoryUnreadable(back, K)).toBeUndefined();
    expect(back.check).toBe(snap.check);
    expect('setAside' in readBoxHistory({ sealKey: K, entries: [], snapshot: back, at: iso(201), banked: new Map([['A-', 100]]) })).toBe(false);
    // A JSON TREE with its keys reordered is not what was sealed (that is why it is never kept as one), and not the saved form.
    expect(boxHistoryUnreadable(reorder(snap), K)).toBe('its seal does not match its content (damaged, altered, or sealed with another key)');
    expect(boxHistoryUnreadable(boxHistoryFromStore(snap), K)).toBe('it is not in the saved form (box-history-text@3)');
    expect(sealBoxHistory(snap, K).check).toBe(snap.check);
  });

  it('a damaged shape that was even RE-SEALED is still set aside, by the shape check (every field is checked, not only the seal)', () => {
    for (const bad of [{ stores: [['S1', null, 'x', 'y', 'z']] }, { never: { ...snap.never, keys: [{}] } }, { folded: ['x'] }, { verdicts: { own: [[1]], ahead: [] } }]) {
      const resealed = sealBoxHistory({ ...snap, ...bad } as never, K);
      expect(boxHistoryUnreadable(resealed, K), JSON.stringify(bad)).toMatch(/^its part ".+" is missing or not readable$/);
    }
  });

  it('the health read\'s words: "being prepared", the size and its alarm, saving held back, a failed build', () => {
    const [prep] = boxHistoryComponents({ preparing: { since: '2026-10-14T08:00:00.000Z', why: 'nothing is saved yet' } });
    expect(prep).toMatchObject({ name: 'box_history', status: 'unknown' });
    expect(prep!.detail).toMatch(/^being prepared — store computer checks not yet available/);
    const ok = boxHistoryComponents({ history: { sizeBytes: 900 * 1024, saveHeld: null, lastBuildFailed: null } });
    expect(ok.map((c) => [c.name, c.status])).toEqual([['box_history', 'ok']]);
    expect(ok[0]!.detail).toContain('900 KB');
    const big = boxHistoryComponents({ history: { sizeBytes: BOX_HISTORY_SIZE_WARN_BYTES + 1, saveHeld: { since: 'x', waitingSeconds: BOX_HISTORY_SAVE_HELD_WARN_SECONDS }, lastBuildFailed: { at: 'y', error: 'boom' } } });
    expect(big.map((c) => [c.name, c.status])).toEqual([['box_history', 'degraded'], ['box_history_saving', 'degraded'], ['box_history_build', 'degraded']]);
    expect(big[1]!.detail).toMatch(/open database transaction holds it back/);
    expect(boxHistoryComponents({ history: { sizeBytes: 10, saveHeld: { since: 'x', waitingSeconds: BOX_HISTORY_SAVE_HELD_WARN_SECONDS - 1 }, lastBuildFailed: null } }).map((c) => c.name)).toEqual(['box_history']);
  });
});

describe('round 29 · OB-107: each store computer holding the store\'s tills is judged; the worse decides (the verifier\'s probe B3)', () => {
  // The real box A holds A- and its disk is FULL from 08:30; a new till's prefix B- (issued 08:40) is reported FIRST by box B,
  // which reports 30 s after A each minute.
  const records: BoxHealthRecord[] = [];
  for (let m = 0; m < 60; m += 1) records.push(rec(m, 'A-', { through: 100 }, 'u-box-a', m >= 30 ? FULL : DISK));
  for (let m = 40; m < 60; m += 1) records.push(rec(m, 'B-', { through: 5 }, 'u-box-b', DISK, 30));
  records.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  const at = iso(60);

  it('box_disk is DOWN naming both; the store cannot record sales; localStoreWritable is false', () => {
    const r = readNeverReceived({ records, at, banked: new Map([['A-', 100], ['B-', 5]]) });
    expect(r.bindings.map((b) => [b.prefix, b.computer])).toEqual([['A-', 'u-box-a'], ['B-', 'u-box-b']]);
    const j = judgeBoxes({ records, at, thresholds: DEFAULT_THRESHOLDS, bindings: r.bindings, unusedNumbers: r.unused });
    const disk = j.components.find((c) => c.name === 'box_disk:S1')!;
    expect(disk.status).toBe('down');
    expect(disk.detail).toMatch(/^store S1 has 2 store computers holding its tills' bill numbers — u-box-a \(A-\) and u-box-b \(B-\); head office judges each on its own and the worse decides: u-box-a: store S1's computer CANNOT record another sale/);
    expect(disk.evidence).toMatchObject({ computer: 'u-box-a', computers: 'u-box-a,u-box-b' });
    expect(j.localStoreWritable).toBe(false);
    const box = j.boxes[0]!;
    expect(box.canRecordSales).toBe(false);
    expect(box.boundComputers?.map((c) => [c.computer, c.prefixes, c.canRecordSales])).toEqual([['u-box-a', ['A-'], false], ['u-box-b', ['B-'], true]]);
    expect(j.components.find((c) => c.name === 'box_queue:S1')!.detail).toMatch(/u-box-a: store S1's computer has sent everything \| u-box-b: store S1's computer has sent everything/);
  });

  it('the saved running result says exactly the same (judgeBoxes from its view)', () => {
    const banked = new Map([['A-', 100], ['B-', 5]]);
    const got = readBoxHistory({ sealKey: K, entries: entries(records), at, banked, settleBefore: iso(50), settledThrough: records.length });
    if ('setAside' in got) throw new Error(got.setAside);
    const full = judgeBoxes({ records, at, thresholds: DEFAULT_THRESHOLDS, bindings: got.bindings, unusedNumbers: got.unused });
    expect(judgeBoxes({ records: [], view: got.view, at, thresholds: DEFAULT_THRESHOLDS, bindings: got.bindings, unusedNumbers: got.unused })).toEqual(full);
  });

  it('one store computer: the words are as before (no "2 store computers")', () => {
    const one = records.filter((r) => r.reportedBy === 'u-box-a');
    const r = readNeverReceived({ records: one, at, banked: new Map([['A-', 100]]) });
    const j = judgeBoxes({ records: one, at, thresholds: DEFAULT_THRESHOLDS, bindings: r.bindings, unusedNumbers: r.unused });
    expect(j.components.find((c) => c.name === 'box_disk:S1')!.detail).toMatch(/^store S1's computer CANNOT record another sale/);
    expect(j.boxes[0]!.boundComputers).toBeUndefined();
  });
});

describe('round 29 · OB-108: the "said unused, but held" check on the store computer\'s own clock', () => {
  it('U5: a till 20 minutes slow no longer raises the line — the store computer took the bill 30 s after it last said "unused"', () => {
    // The store computer said 105 unused at 11:00:30 (its clock; kept to the minute, 11:00); it took the bill at 11:00:31.
    const runs = [{ from: 105, to: 105, day: '2026-03-01', lastSaidAt: '2026-03-01T11:00:00.000Z' }];
    expect(unusedButReceived('A-', { prefix: 'A-', runs }, new Map([[105, { as: 'sale' as const, at: '2026-03-01T11:00:31.000Z', clock: 'store_computer' as const }]]))).toEqual([]);
    // The same bill judged on the till's slow clock (10:40:35) — the false line the verifier found (an older store computer).
    expect(unusedButReceived('A-', { prefix: 'A-', runs }, new Map([[105, { as: 'sale' as const, at: '2026-03-01T10:40:35.000Z', clock: 'till' as const }]]))).toHaveLength(1);
  });

  it('an altered store computer calling a bill unused well after it took it raises the line, saying both times are its own clock', () => {
    const runs = [{ from: 105, to: 105, day: '2026-03-01', lastSaidAt: iso(60 + UNUSED_CONTRADICTION_MARGIN_MINUTES + 1) }];
    const found = unusedButReceived('A-', { prefix: 'A-', runs }, new Map([[105, { as: 'sale' as const, at: iso(60), clock: 'store_computer' as const }]]));
    expect(found).toEqual([{ prefix: 'A-', number: 105, heldAs: 'sale', heldAt: iso(60), lastSaidUnusedAt: runs[0]!.lastSaidAt, clock: 'store_computer' }]);
    const [f] = billNumberFindingsFor({ storeId: 'S1', records: [], at: iso(200), unreceived: [], unusedReceived: found });
    expect(f!.detail).toContain('(both times by the store computer\'s own clock: when it said so, and when it took the bill from the till)');
    const [g] = billNumberFindingsFor({ storeId: 'S1', records: [], at: iso(200), unreceived: [], unusedReceived: [{ ...found[0]!, clock: 'till' }] });
    expect(g!.detail).toMatch(/the bill's time is the TILL's own clock — this store computer did not stamp when it took the bill/);
  });
});

describe('round 29 · verifier r28 NEW-6: the said time to the minute; the limits said on the line', () => {
  it('U6: a store computer that calls a banked bill unused for 10:10–10:59 only (the bill taken 10:05) now raises the line', () => {
    const records: BoxHealthRecord[] = [];
    for (let m = 0; m < 60; m += 1) records.push(rec(m, 'A-', { through: 105, ...(m >= 10 ? { unused: [[105, 105]] as [number, number][] } : {}) }));
    for (let m = 60; m < 180; m += 1) records.push(rec(m, 'A-', { through: 105 }));
    const u = readNeverReceived({ records, at: iso(180), banked: new Map([['A-', 105]]) }).unused.get('S1')!.find((x) => x.prefix === 'A-');
    expect(u?.runs.map((r) => r.lastSaidAt)).toEqual([iso(59)]);
    expect(unusedButReceived('A-', u, new Map([[105, { as: 'sale' as const, at: iso(5), clock: 'store_computer' as const }]])).map((x) => x.number)).toEqual([105]);
  });

  it(`when the newest ${UNRECEIVED_CHECK_CAP} checked or ${UNUSED_HELD_TIMED_MAX} timed leave numbers out, the line and the information say so`, () => {
    const found = [{ prefix: 'A-', number: 105, heldAs: 'sale' as const, heldAt: iso(0), lastSaidUnusedAt: iso(60) }];
    const [f] = billNumberFindingsFor({ storeId: 'S1', records: [], at: iso(61), unreceived: [], unusedReceived: found, unusedCapped: [{ prefix: 'A-', notChecked: 120, notTimed: 7 }] });
    expect(f!.detail).toContain(`Not every number was looked at: 120 older number(s) said unused, beyond the newest ${UNRECEIVED_CHECK_CAP}, were not checked against head office's bills; 7 more number(s) head office holds a bill for, beyond the newest ${UNUSED_HELD_TIMED_MAX}, did not have their bill's time read — so there may be more than this line names.`);
    const records = [rec(0, 'A-', { through: 110, unused: [[101, 110]] })];
    const r = readNeverReceived({ records, at: iso(1), banked: new Map([['A-', 110]]) });
    const j = judgeBoxes({ records, at: iso(1), thresholds: DEFAULT_THRESHOLDS, bindings: r.bindings, unusedNumbers: r.unused, unusedCapped: new Map([['S1', [{ prefix: 'A-', notChecked: 3, notTimed: 0 }]]]) });
    expect(j.components.find((c) => c.name === 'box_unused_numbers:S1')!.detail).toMatch(/Under A-: Not every number was looked at: 3 older number\(s\) said unused/);
  });
});

/**
 * **Round 30 — owner decisions OB-109, OB-110, OB-111, OB-112 "A" (14 Oct 2026, in writing; verifier r29 NEW-1…NEW-4), as rules.**
 *
 *   OB-109: the waiting clock forgets a number only after WAIT_FORGET_HOURS REPORT-hours that leave it out — never across
 *     silence. The verifier's probe P1 (a bill stuck from 08:00, no reports at all from 10 h to 35 h) keeps 08:00.
 *   OB-110: the clock keeps the numbers ever listed as ranges with their first sight, at most WAIT_RANGES_MAX per prefix; a
 *     joined range keeps the EARLIER sight, so a bill can only ever look older, never younger (checked against a brute-force
 *     first sight per number); an honest stuck bill with trade going on stays small and close to the truth.
 *   OB-111: the saved result's seal is keyed: the verifier's probe P2 (unused runs cleared and re-sealed with plain SHA-256)
 *     is set aside, so is one sealed with another key; without a key nothing saved is trusted and nothing is saved.
 *   OB-112: at most REFUSED_NEW_PER_DAY_MAX new words a day per store computer about prefixes that are not the store's; the
 *     rest are counted in one line. The verifier's probe P4 (200 bogus prefixes per report) keeps the saved result small,
 *     and the saved result says exactly what the plain reading says.
 */

const rec30 = (min: number, x: Partial<IssuedReport> & { through: number }, extra: Partial<BoxHealthRecord> = {}): BoxHealthRecord => ({
  storeId: 'S1', observedAt: iso(min), receivedAt: iso(min), reportedBy: 'u-box-a', clockAheadCorrected: false, tills: [], disk: DISK,
  queue: { unsent: x.unsent?.count ?? 0, deadLettered: 0 },
  receiptNumbersIssued: [{ prefix: 'A-', soldThrough: x.through, unsent: { count: 0 }, ...x } as IssuedReport],
  ...extra,
} as BoxHealthRecord);
const sinceOf = (records: BoxHealthRecord[], atMin: number) => billsWaitingOnTheBox({ records, storeId: 'S1', at: iso(atMin) }).map((f) => [f.kind, f.since]);

describe('round 30 · OB-109: silence never counts as "not listed" (the verifier\'s probe P1)', () => {
  const stuck = (m: number) => rec30(m, { through: 105, unsent: { count: 1, from: 105, to: 105 } });
  const quiet = (m: number) => rec30(m, { through: 105, unsent: { count: 0 } });

  it('P1: a bill stuck from 08:00, no reports at all from 10 h to 35 h — still "since 08:00" after the outage, never cleared', () => {
    const records: BoxHealthRecord[] = [];
    for (let m = 0; m <= 10 * 60; m += 15) records.push(stuck(m));
    expect(sinceOf(records, 10 * 60 + 1)).toEqual([['bills_waiting_on_box', iso(0)]]);
    for (let m = 35 * 60; m <= 36 * 60; m += 15) records.push(stuck(m));
    // First reports after reconnecting: the finding is still there, with its true age (before round 30: none, then "since 19:00").
    expect(sinceOf(records.slice(0, records.length - 4), 35 * 60 + 1)).toEqual([['bills_waiting_on_box', iso(0)]]);
    expect(sinceOf(records, 36 * 60 + 1)).toEqual([['bills_waiting_on_box', iso(0)]]);
    expect(sinceOf([...records, stuck(38 * 60)], 38 * 60 + 1)).toEqual([['bills_waiting_on_box', iso(0)]]);
    // The saved running result says the same, read in windows across the outage.
    let snapshot: BoxHistorySnapshot | undefined;
    const all = [...records, stuck(38 * 60)];
    for (const cut of [20, 41, all.length]) {
      const at = iso(Math.round((Date.parse(all[cut - 1]!.receivedAt) - t0) / 60_000) + 1);
      const window = entries(all.slice(0, cut)).filter((e) => snapshot === undefined || e.seq > snapshot.seq);
      const got = readBoxHistory({ sealKey: K, entries: window, ...(snapshot === undefined ? {} : { snapshot }), at, banked: new Map([['A-', 104]]), settleBefore: at, settledThrough: cut });
      if ('setAside' in got) throw new Error(got.setAside);
      if (got.snapshot !== undefined) snapshot = JSON.parse(JSON.stringify(got.snapshot)) as BoxHistorySnapshot;
      expect(billsWaitingOnTheBox({ records: [], storeId: 'S1', at, facts: got.view.waiting('S1') }).map((f) => f.since)).toEqual([iso(0)]);
    }
  });

  it(`only REPORT-hours that leave a number out count: ${WAIT_FORGET_HOURS} of them forget it, however long the silence between`, () => {
    // Listed at 0; left out by reports in hours 1–12; NO reports for 28 hours; left out again in hours 41–50 (22 report-hours).
    const base = [stuck(0), ...Array.from({ length: 12 }, (_, h) => quiet(60 * (h + 1))), ...Array.from({ length: 10 }, (_, h) => quiet(60 * (41 + h)))];
    expect(sinceOf([...base, stuck(51 * 60)], 51 * 60 + 1)).toEqual([['bills_waiting_on_box', iso(0)]]);
    // Two more report-hours leaving it out (24): forgotten — listed again, its clock starts then.
    const more = [...base, quiet(51 * 60), quiet(52 * 60), stuck(53 * 60)];
    expect(sinceOf(more, 53 * 60 + 1)).toEqual([]);
    expect(sinceOf([...more, stuck(56 * 60)], 56 * 60 + 1)).toEqual([['bills_waiting_on_box', iso(53 * 60)]]);
  });

  it(`the ${WAIT_FORGET_HOURS} report-hours must be IN A ROW: a list naming the number again starts the count again`, () => {
    // Listed at 0, left out in hours 1–20, listed at 21, left out in hours 22–40: never 24 in a row — still since 0.
    const records = [stuck(0), ...Array.from({ length: 20 }, (_, h) => quiet(60 * (h + 1))), stuck(21 * 60), ...Array.from({ length: 19 }, (_, h) => quiet(60 * (22 + h))), stuck(41 * 60)];
    expect(sinceOf(records, 41 * 60 + 1)).toEqual([['bills_waiting_on_box', iso(0)]]);
  });

  it('a report that does not say WHICH bills are waiting (an older store computer) is not a report-hour that leaves a number out', () => {
    const noList = (m: number): BoxHealthRecord => rec30(m, { through: 105, unsent: undefined } as never);
    const records = [stuck(0), ...Array.from({ length: 30 }, (_, h) => noList(60 * (h + 1))), stuck(31 * 60)];
    expect(sinceOf(records, 31 * 60 + 1)).toEqual([['bills_waiting_on_box', iso(0)]]);
  });
});

describe('round 30 · OB-110: the waiting clock is ranges with their first sight, bounded, and only ever errs OLDER', () => {
  it('against a brute-force first sight per number (random lists): never younger; exact while the ranges fit', () => {
    let exactSeeds = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const rnd = rng(seed);
      const records: BoxHealthRecord[] = [];
      const firstSeen = new Map<number, number>();
      let top = 20;
      // Under 24 report-hours, so nothing is forgotten and the brute force needs no memory rule. Odd seeds: a busy till (far
      // more numbers than WAIT_RANGES_MAX, so ranges are joined); even seeds: a quiet one (they all fit, so it is exact).
      const busy = seed % 2 === 1;
      for (let m = 0; m < 20 * 60; m += busy ? 3 : 15) {
        top += busy || rnd() < 0.15 ? Math.floor(rnd() * 3) : 0;
        const from = Math.max(1, top - Math.floor(rnd() * (busy && rnd() < 0.1 ? 400 : 6)));
        const to = Math.min(top, from + Math.floor(rnd() * 5));
        records.push(rec30(m, { through: top, unsent: { count: 1, from, to } }));
        for (let n = from; n <= to; n += 1) if (!firstSeen.has(n)) firstSeen.set(n, m);
      }
      const facts = waitingFacts({ records, storeId: 'S1', at: iso(20 * 60) })[0]!;
      let exact = true;
      for (let q = 0; q < 200; q += 1) {
        const from = 1 + Math.floor(rnd() * top);
        const to = Math.min(top, from + Math.floor(rnd() * 30));
        let brute = Infinity;
        for (let n = from; n <= to; n += 1) brute = Math.min(brute, firstSeen.get(n) ?? Infinity);
        const got = facts.firstWaiting(from, to);
        if (brute === Infinity) { expect(got === undefined || Date.parse(got.at) <= Date.parse(iso(20 * 60))).toBe(true); continue; }
        expect(got, `seed ${seed} [${from}, ${to}]`).toBeDefined();
        expect(Date.parse(got!.at), `seed ${seed} [${from}, ${to}]: never younger than the truth`).toBeLessThanOrEqual(t0 + brute * 60_000);
        if (Date.parse(got!.at) !== t0 + brute * 60_000) exact = false;
      }
      // Few distinct first sights → no join needed → exact.
      if (firstSeen.size <= WAIT_RANGES_MAX) { exactSeeds += 1; expect(exact, `seed ${seed}`).toBe(true); }
    }
    expect(exactSeeds).toBeGreaterThanOrEqual(25);
  });

  it('an honest stuck bill for 7 days while trade goes on (lists [S, newest]): the clock stays within its cap, and the next oldest bill is aged close to the truth', () => {
    const records: BoxHealthRecord[] = [];
    const firstSeen = new Map<number, number>();
    const S = 50;
    let S2: number | undefined;
    let through = 100;
    const EVERY = 2; // a report every 2 minutes, a bill every report
    for (let m = 0; m <= 7 * 24 * 60; m += EVERY) {
      through += 1;
      if (S2 === undefined && m >= 3 * 24 * 60) S2 = through; // a second bill gets stuck on day 3
      const from = m < 7 * 24 * 60 ? S : (S2 ?? through);
      records.push(rec30(m, { through, unsent: { count: S2 === undefined ? 2 : 3, from, to: through } }));
      for (let n = from; n <= through; n += 1) if (!firstSeen.has(n)) firstSeen.set(n, m);
    }
    const at = 7 * 24 * 60 + 1;
    const f = billsWaitingOnTheBox({ records, storeId: 'S1', at: iso(at) });
    // S released at the end: the oldest is now S2 — aged from no LATER than its true first sight, and within 10% of its age.
    const truth = firstSeen.get(S2!)!;
    const since = (Date.parse(f[0]!.since) - t0) / 60_000;
    expect(since).toBeLessThanOrEqual(truth);
    expect(truth - since).toBeLessThanOrEqual(0.1 * (at - truth));
    // Then S2 is sent too: the newest bills (sold minutes ago) are aged within a few minutes of the truth, never younger.
    const next = [...records, rec30(at + 1, { through: through + 1, unsent: { count: 2, from: through, to: through + 1 } })];
    const g = billsWaitingOnTheBox({ records: next, storeId: 'S1', at: iso(at + 2 + 120) });
    const newest = firstSeen.get(through)!;
    expect(g).toHaveLength(1);
    expect((Date.parse(g[0]!.since) - t0) / 60_000).toBeLessThanOrEqual(newest);
    expect(newest - (Date.parse(g[0]!.since) - t0) / 60_000).toBeLessThanOrEqual(5);
    // The saved result keeps at most WAIT_RANGES_MAX ranges for the prefix (7 numbers each since round 32, after 2 header numbers).
    const got = readBoxHistory({ sealKey: K, entries: entries(records), at: iso(at), banked: new Map([['A-', through]]), settleBefore: iso(at - 1), settledThrough: records.length });
    if ('setAside' in got) throw new Error(got.setAside);
    const clock = ((got.snapshot!.stores as unknown[][])[0]![3] as unknown[][])[0]![2] as unknown[];
    expect((clock.length - 2) / 7).toBeLessThanOrEqual(WAIT_RANGES_MAX);
    expect(billsWaitingOnTheBox({ records: [], storeId: 'S1', at: iso(at), facts: got.view.waiting('S1') })).toEqual(f);
  });
});

describe('round 30 · OB-111: the saved result\'s seal is keyed (the verifier\'s probe P2)', () => {
  const records: BoxHealthRecord[] = [];
  for (let m = 0; m < 100; m += 1) records.push(rec30(m, { through: 110, unused: [[105, 106]] } as never));
  const made = readBoxHistory({ sealKey: K, entries: entries(records), at: iso(200), banked: new Map([['A-', 110]]), settleBefore: iso(190), settledThrough: 100, timeZone: 'UTC' });
  if ('setAside' in made) throw new Error(made.setAside);
  const snap = JSON.parse(JSON.stringify(made.snapshot)) as BoxHistorySnapshot;
  const altered = (): Record<string, unknown> => {
    const s = JSON.parse(JSON.stringify(snap)) as Record<string, unknown> & { never: { keys: { unused: unknown[]; unusedList: unknown }[] } };
    for (const k of s.never.keys) { k.unused = []; k.unusedList = null; }
    delete s['check']; delete s['sizeBytes'];
    return s;
  };

  it('P2: unused runs cleared and re-sealed with plain SHA-256 (the round-29 seal) — set aside, the unused run still shown on a rebuild', () => {
    const honest = readBoxHistory({ sealKey: K, entries: [], snapshot: snap, at: iso(201), banked: new Map([['A-', 110]]), timeZone: 'UTC' });
    if ('setAside' in honest) throw new Error(honest.setAside);
    expect([...honest.unused.get('S1') ?? []].flatMap((u) => u.runs.map((r) => [r.from, r.to]))).toEqual([[105, 106]]);
    const a = altered();
    const text = JSON.stringify(a);
    const plain = { ...a, check: createHash('sha256').update(text).digest('hex'), sizeBytes: Buffer.byteLength(text) };
    expect(boxHistoryUnreadable(JSON.parse(JSON.stringify(plain)), K)).toBe('its seal does not match its content (damaged, altered, or sealed with another key)');
    expect(readBoxHistory({ sealKey: K, entries: [], snapshot: plain as unknown as BoxHistorySnapshot, at: iso(201), banked: new Map([['A-', 110]]), timeZone: 'UTC' }))
      .toEqual({ setAside: 'unreadable: its seal does not match its content (damaged, altered, or sealed with another key)' });
  });

  it('sealed with ANOTHER key: set aside; with the same key: used; with no key: nothing saved is trusted and nothing is saved', () => {
    const other = sealBoxHistory(altered() as never, OTHER_BOX_HISTORY_KEY);
    expect(boxHistoryUnreadable(other, K)).toMatch(/sealed with another key/);
    expect(boxHistoryUnreadable(other, OTHER_BOX_HISTORY_KEY)).toBeUndefined();
    expect(boxHistoryUnreadable(snap, undefined)).toBe('head office was given no seal key, so no saved result is trusted');
    expect(readBoxHistory({ entries: [], snapshot: snap, at: iso(201), banked: new Map([['A-', 110]]), timeZone: 'UTC' }))
      .toEqual({ setAside: 'unreadable: head office was given no seal key, so no saved result is trusted' });
    const unkeyed = readBoxHistory({ entries: entries(records), at: iso(200), banked: new Map([['A-', 110]]), settleBefore: iso(190), settledThrough: 100, timeZone: 'UTC' });
    expect('snapshot' in unkeyed && unkeyed.snapshot !== undefined).toBe(false);
    // The seal is an HMAC under the key, not a digest anyone can work out.
    const { check, sizeBytes: _z, ...rest } = snap; void _z;
    expect(check).not.toBe(createHash('sha256').update(JSON.stringify(rest)).digest('hex'));
    expect(BOX_HISTORY_STORED_FORMAT).toBe('box-history-text@3');
  });

  it('round 32 · OB-116: the key is derived from head office\'s own BOX_HISTORY_SEAL_KEY only (a short one is refused), and differs per secret', () => {
    expect(() => boxHistorySealKey('too-short')).toThrow(/needs the full BOX_HISTORY_SEAL_KEY \(at least 32 characters\)/);
    const s = randomBytes(32).toString('hex');
    const a = boxHistorySealKey(s);
    expect(a.equals(boxHistorySealKey(s))).toBe(true);
    expect(a.equals(boxHistorySealKey(randomBytes(32).toString('hex')))).toBe(false);
  });

  it('round 32 · OB-116 (verifier r31 mutant 14): the seal key has its OWN label — never equal to the till seal, till PIN, member code or personal-data key of the same secret', () => {
    // Even if one secret were (wrongly) given to both, the keys made from it never coincide.
    const s = randomBytes(32).toString('hex');
    const mine = boxHistorySealKey(s);
    for (const [name, other] of [['till seal', tillSealKey(s)], ['till PIN', tillPinKey(s)], ['member code', loyaltyMemberKey(s)], ['personal data', personalDataKek({ packSigningKey: s })]] as const) {
      expect(mine.equals(other), name).toBe(false);
    }
    expect(BOX_HISTORY_SEAL_LABEL).toBe('sre/box-history-seal@2');
    expect(mine.equals(createHmac('sha256', s).update(BOX_HISTORY_SEAL_LABEL, 'utf8').digest())).toBe(true);
  });

  it('round 32 · OB-116: a result sealed with a key a STORE COMPUTER can work out (from PACK_SIGNING_KEY, as round 30 did) is set aside', () => {
    // The store computer holds PACK_SIGNING_KEY; an attacker with its settings file makes every key it can from it and re-seals
    // an altered result (unused runs cleared). Head office's key is made from BOX_HISTORY_SEAL_KEY, which no store computer holds.
    const pack = randomBytes(32).toString('hex');
    const fromPack = [
      createHmac('sha256', pack).update('sre/box-history-seal@1', 'utf8').digest(), // round 30's derivation
      boxHistorySealKey(pack), tillSealKey(pack), tillPinKey(pack), loyaltyMemberKey(pack), personalDataKek({ packSigningKey: pack }), Buffer.from(pack, 'utf8'),
    ];
    for (const k of fromPack) {
      const forged = sealBoxHistory(altered() as never, k);
      expect(boxHistoryUnreadable(forged, K)).toBe('its seal does not match its content (damaged, altered, or sealed with another key)');
      expect(readBoxHistory({ sealKey: K, entries: [], snapshot: forged, at: iso(201), banked: new Map([['A-', 110]]), timeZone: 'UTC' }))
        .toEqual({ setAside: 'unreadable: its seal does not match its content (damaged, altered, or sealed with another key)' });
    }
  });

  it('round 32 · OB-116: a round-30 saved row (form @2, sealed under the old key) is set aside once, by its form, and rebuilt', () => {
    const old = { format: 'box-history-text@2', text: JSON.stringify(snap) };
    expect(boxHistoryUnreadable(boxHistoryFromStore(old), K)).toBe('it is not in the saved form (box-history-text@3)');
    const rebuilt = readBoxHistory({ sealKey: K, entries: entries(records), at: iso(200), banked: new Map([['A-', 110]]), settleBefore: iso(190), settledThrough: 100, timeZone: 'UTC' });
    if ('setAside' in rebuilt) throw new Error(rebuilt.setAside);
    expect(boxHistoryUnreadable(boxHistoryFromStore(boxHistoryToStore(rebuilt.snapshot!)), K)).toBeUndefined();
  });

  it('a head office started without the key says so on the health read (degraded), never silently', () => {
    const c = boxHistoryComponents({ history: { sizeBytes: null, saveHeld: null, lastBuildFailed: null, noSealKey: true } });
    expect(c).toEqual([expect.objectContaining({ name: 'box_history_seal', status: 'degraded' })]);
    expect(boxHistoryComponents({ history: { sizeBytes: null, saveHeld: null, lastBuildFailed: null } })).toEqual([]);
  });
});

describe('round 30 · OB-112: refused words about prefixes not the store\'s are capped per store computer per day (the verifier\'s probe P4)', () => {
  const refused = (prefix: string, through: number): RefusedIssued => ({ prefix, through, because: 'prefix_of_another_store', bankedThrough: 0 });
  const flood = (i: number, min: number, n = 200): BoxHealthRecord => rec30(min, { through: 100 }, {
    receiptNumbersRefused: Array.from({ length: n }, (_, k) => refused(`Z${i}x${k}-`, 5)),
  } as Partial<BoxHealthRecord>);
  const findingsAt = (records: BoxHealthRecord[], at: string) => billNumberFindingsFor({ storeId: 'S1', records, at, unreceived: [], banked: new Map([['A-', 100]]) })
    .filter((f) => f.kind === 'report_refused' || f.kind === 'report_refused_not_kept');

  it('P4: 200 new bogus prefixes per report for 200 minutes — the saved result stays small; one line counts the rest', () => {
    const records = Array.from({ length: 800 }, (_, i) => flood(i, i / 4));
    const at = iso(230);
    const got = readBoxHistory({ sealKey: K, entries: entries(records), at, banked: new Map([['A-', 100]]), settleBefore: iso(220), settledThrough: 800 });
    if ('setAside' in got) throw new Error(got.setAside);
    // Before round 30: 55.69 MB (and PostgreSQL's jsonb limit in about 15 hours).
    expect(got.snapshot!.sizeBytes).toBeLessThan(100 * 1024);
    const f = billNumberFindingsFor({ storeId: 'S1', records: [], at, unreceived: [], facts: got.facts('S1') });
    expect(f.filter((x) => x.kind === 'report_refused')).toHaveLength(REFUSED_NEW_PER_DAY_MAX);
    const line = f.filter((x) => x.kind === 'report_refused_not_kept');
    expect(line).toEqual([expect.objectContaining({ count: 800 * 200 - REFUSED_NEW_PER_DAY_MAX, since: iso(0) })]);
    expect(line[0]!.detail).toMatch(/159980 more refused bill-number prefix\(es\) not kept: store S1's computer u-box-a/);
    // The plain reading says exactly the same.
    expect(findingsAt(records, at)).toEqual(f.filter((x) => x.kind === 'report_refused' || x.kind === 'report_refused_not_kept'));
  });

  it('words about prefixes already kept are never capped, and the store\'s OWN prefixes not by this rule (OB-117 caps them per till); a new day keeps 20 new ones again; the line goes after 7 quiet days', () => {
    const own = (min: number): BoxHealthRecord => rec30(min, { through: 100 }, {
      receiptNumbersRefused: [{ prefix: 'A-', through: 900_000 + min, because: 'beyond_plausible_advance', bankedThrough: 100, plausibleThrough: 10_100 }, refused('Z0x0-', 5)],
    } as Partial<BoxHealthRecord>);
    const day = 24 * 60;
    const records = [flood(0, 0, 30), own(1), own(2), flood(1, day + 1, 30)];
    const f = findingsAt(records, iso(day + 2));
    // A- (own, never capped) + 20 kept on day 1 + 20 kept on day 2.
    expect(f.filter((x) => x.kind === 'report_refused').map((x) => x.prefix)).toContain('A-');
    expect(f.filter((x) => x.kind === 'report_refused')).toHaveLength(1 + 2 * REFUSED_NEW_PER_DAY_MAX);
    expect(f.find((x) => x.kind === 'report_refused_not_kept')).toMatchObject({ count: 20 });
    expect(findingsAt(records, iso(day + 1 + REFUSED_NOT_KEPT_SHOWN_DAYS * day + 1)).some((x) => x.kind === 'report_refused_not_kept')).toBe(false);
  });

  it('the saved result read in windows over three days of flooding says exactly what the plain reading says, at every read', () => {
    const rnd = rng(30);
    const records: BoxHealthRecord[] = [];
    for (let i = 0; i < 3 * 24 * 6; i += 1) {
      const min = i * 10;
      const names = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => refused(`P${Math.floor(rnd() * 90)}-`, 1 + Math.floor(rnd() * 4)));
      const unique = [...new Map(names.map((r) => [r.prefix, r])).values()];
      records.push({
        ...rec30(min, { through: 100 }), reportedBy: rnd() < 0.5 ? 'u-box-a' : 'u-box-b',
        receiptNumbersRefused: unique,
        receiptNumbersNotFolded: rnd() < 0.3 ? [{ prefix: `N${Math.floor(rnd() * 40)}-`, through: 3 }] : [],
      } as BoxHealthRecord);
    }
    let snapshot: BoxHistorySnapshot | undefined;
    let notKept = 0;
    for (let cut = 30; cut <= records.length; cut += 37) {
      const at = new Date(Date.parse(records[cut - 1]!.receivedAt) + 60_000).toISOString();
      const window = entries(records.slice(0, cut)).filter((e) => snapshot === undefined || e.seq > snapshot.seq);
      const got = readBoxHistory({ sealKey: K, entries: window, ...(snapshot === undefined ? {} : { snapshot }), at, banked: new Map([['A-', 100]]), settleBefore: at, settledThrough: cut });
      if ('setAside' in got) throw new Error(got.setAside);
      if (got.snapshot !== undefined) snapshot = JSON.parse(JSON.stringify(got.snapshot)) as BoxHistorySnapshot;
      const windowed = billNumberFindingsFor({ storeId: 'S1', records: [], at, unreceived: [], facts: got.facts('S1') }).filter((f) => f.kind === 'report_refused' || f.kind === 'report_refused_not_kept');
      expect(windowed).toEqual(findingsAt(records.slice(0, cut), at));
      notKept = Math.max(notKept, windowed.filter((f) => f.kind === 'report_refused_not_kept').length);
    }
    expect(notKept).toBeGreaterThan(0); // the cap was reached in this history, and both readings agreed on it
  });
});
