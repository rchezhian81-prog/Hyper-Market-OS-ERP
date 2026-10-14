import { describe, it, expect } from 'vitest';
import {
  readBoxHistory, readNeverReceived, judgeBoxes, billsWaitingOnTheBox, unusedButReceived, billNumberFindingsFor, sealBoxHistory, boxHistoryUnreadable,
  boxHistoryToStore, boxHistoryFromStore,
  boxHistoryComponents, WAIT_FORGET_HOURS, UNUSED_FORGET_DAYS, UNUSED_CONTRADICTION_MARGIN_MINUTES, BOX_HISTORY_SIZE_WARN_BYTES, BOX_HISTORY_SAVE_HELD_WARN_SECONDS,
  UNUSED_HELD_TIMED_MAX, UNRECEIVED_CHECK_CAP,
  type BoxHealthRecord, type IssuedReport, type BoxHistorySnapshot,
} from '../../services/platform/src/box-health';
import { DEFAULT_THRESHOLDS } from '../../packages/ops/src/index';

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
    const first = readBoxHistory({ entries: entries(records), at: iso(200), banked, settleBefore: iso(190), settledThrough: 80, timeZone: 'UTC' });
    if ('setAside' in first) throw new Error(first.setAside);
    const snap = JSON.parse(JSON.stringify(first.snapshot)) as BoxHistorySnapshot;
    expect(snap.rfBanked).toEqual([['C-', 30_000]]);
    const prefixes = (snap.stores as unknown[][])[0]![2] as unknown[][];
    expect(prefixes.find((p) => p[0] === 'C-')![5]).toEqual([]); // its refused group is gone (answered for good)
    expect(readBoxHistory({ entries: [], snapshot: snap, at: iso(201), banked, timeZone: 'UTC' })).not.toHaveProperty('setAside');
    expect(readBoxHistory({ entries: [], snapshot: snap, at: iso(201), banked: new Map([['A-', 100], ['C-', 0]]), timeZone: 'UTC' })).toEqual({ setAside: 'banked' });
  });
});

describe('round 29 · OB-106: a saved result is checked before it is used (the verifier\'s probe C1)', () => {
  const records = Array.from({ length: 100 }, (_, m) => rec(m, 'A-', { through: 100 }));
  const made = readBoxHistory({ entries: entries(records), at: iso(200), banked: new Map([['A-', 100]]), settleBefore: iso(190), settledThrough: 100 });
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
      expect(() => { got = readBoxHistory({ entries: [], snapshot: s as BoxHistorySnapshot, at: iso(201), banked: new Map([['A-', 100]]) }); }, name).not.toThrow();
      expect((got as { setAside?: string }).setAside, name).toMatch(/^unreadable: /);
    }
  });

  it('an ALTERED result (a binding moved to "u-evil") no longer matches its seal: set aside, its bindings never used', () => {
    const altered = JSON.parse(JSON.stringify(snap)) as { rawBound: { computer: string }[]; never: { bound: { computer: string }[] } };
    for (const b of altered.never.bound) b.computer = 'u-evil';
    for (const b of altered.rawBound) b.computer = 'u-evil';
    expect(boxHistoryUnreadable(altered)).toBe('its seal does not match its content (damaged or altered)');
    expect(readBoxHistory({ entries: [], snapshot: altered as unknown as BoxHistorySnapshot, at: iso(201), banked: new Map([['A-', 100]]) }))
      .toEqual({ setAside: 'unreadable: its seal does not match its content (damaged or altered)' });
  });

  it('it is KEPT as its JSON text, so PostgreSQL\'s jsonb (which reorders an object\'s keys) never changes what is sealed', () => {
    const reorder = (v: unknown): unknown => (Array.isArray(v) ? v.map(reorder) : v !== null && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort((a, b) => a[0].length - b[0].length || (a[0] < b[0] ? 1 : -1)).map(([k, x]) => [k, reorder(x)])) : v);
    // As a jsonb row would hand it back: the text inside is a string, kept exactly — readable, the same seal.
    const row = reorder(JSON.parse(JSON.stringify(boxHistoryToStore(snap))));
    const back = boxHistoryFromStore(row) as BoxHistorySnapshot;
    expect(boxHistoryUnreadable(back)).toBeUndefined();
    expect(back.check).toBe(snap.check);
    expect('setAside' in readBoxHistory({ entries: [], snapshot: back, at: iso(201), banked: new Map([['A-', 100]]) })).toBe(false);
    // A JSON TREE with its keys reordered is not what was sealed (that is why it is never kept as one), and not the saved form.
    expect(boxHistoryUnreadable(reorder(snap))).toBe('its seal does not match its content (damaged or altered)');
    expect(boxHistoryUnreadable(boxHistoryFromStore(snap))).toBe('it is not in the saved form (box-history-text@1)');
    expect(sealBoxHistory(snap).check).toBe(snap.check);
  });

  it('a damaged shape that was even RE-SEALED is still set aside, by the shape check (every field is checked, not only the seal)', () => {
    for (const bad of [{ stores: [['S1', null, 'x', 'y', 'z']] }, { never: { ...snap.never, keys: [{}] } }, { folded: ['x'] }, { verdicts: { own: [[1]], ahead: [] } }]) {
      const resealed = sealBoxHistory({ ...snap, ...bad } as never);
      expect(boxHistoryUnreadable(resealed), JSON.stringify(bad)).toMatch(/^its part ".+" is missing or not readable$/);
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
    const got = readBoxHistory({ entries: entries(records), at, banked, settleBefore: iso(50), settledThrough: records.length });
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
