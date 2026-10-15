import { describe, it, expect } from 'vitest';
import {
  readBoxHistory, billNumberFindingsFor, judgeReportedIssued, registeredByStore, registeredForComputer, seenBeforeRegistration, doorRefusalComponents,
  lanePrefixOf, PLAUSIBLE_ISSUED_AHEAD, LANE_PREFIXES_PER_COMPUTER_MAX, boxHealthRoutes, BOX_HEALTH_PATH, MIGRATION_LOOKBACK_HOURS,
  type BoxHealthRecord, type BoxHealthDeps, type BoxHistoryJudge, type IssuedReport, type LanePrefixRegistration,
} from '../../services/platform/src/box-health';
import { TEST_BOX_HISTORY_KEY } from '../support/box-history';

/**
 * **Round 33 · owner decision OB-121 "A" (15 Oct 2026, in writing, "Only known tills, pre-pilot"; verifier r32 NEW-4, NEW-5,
 * probes zz-v32-flood F4/F5)** — head office believes a bill-number prefix in a store computer's report only when it ISSUED
 * it to that store's tills, or it is one of that store computer's own lane prefixes (`R-<lane>-`) REGISTERED at head office.
 * There is no longer a "looks like R-…-" shortcut.
 *
 *   • at the door (`judgeReportedIssued` with this computer's registered set): an invented `R-…-` is neither accepted nor
 *     refused-and-kept — it is `notFolded`, which the route refuses and never stores;
 *   • at read (a report kept BEFORE the rule — the verifier's flood already on the ledger): an invented `R-…-` is not owned, so
 *     it is never folded into the saved history. F4 (impossible counts) was 4.8 MB, F5 (plausible counts) 61 MB after 50 and
 *     246 MB after 200 minutes; both now stay as small as an honest store's history;
 *   • an honest store whose lanes are registered is unaffected: the same facts, findings and size as under the old shortcut;
 *   • the one-time migration registers only `R-<lane>-` prefixes the SAME computer reported in a kept report AND under which
 *     head office holds real bills banked — at most LANE_PREFIXES_PER_COMPUTER_MAX.
 */

const t0 = Date.parse('2026-03-01T08:00:00.000Z');
const iso = (ms: number): string => new Date(t0 + ms).toISOString();
const DISK = { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1, salesLogCapacityBytes: 1e7, reserveBytes: 1 };
const issuedPrefixes = new Map<string, ReadonlySet<string>>([['S1L0-', new Set(['S1'])]]);
const fresh = (i: number, k: number): string => `R-${(i * 10 + k).toString(36)}-`;
const issued = (xs: readonly { prefix: string; through: number }[]): IssuedReport[] => xs.map((x) => ({ ...x, soldThrough: x.through, unsent: { count: 0 } }));

/** Head office's judge at read, as `storeComputerHistory` builds it (issued, else registered for the store; never the shape). */
const judgeOf = (registered: ReadonlyMap<string, ReadonlySet<string>>, banked: ReadonlyMap<string, number>): BoxHistoryJudge => ({
  owns: (storeId, prefix) => { const s = issuedPrefixes.get(prefix); return s === undefined ? registered.get(storeId)?.has(prefix) ?? false : s.has(storeId); },
  plausible: (prefix, through) => through <= (banked.get(prefix) ?? 0) + PLAUSIBLE_ISSUED_AHEAD,
});
/** The judge round 32 used — kept here ONLY to show an honest, registered store reads the same as it did. */
const oldJudge = (banked: ReadonlyMap<string, number>): BoxHistoryJudge => ({
  owns: (storeId, prefix) => { const s = issuedPrefixes.get(prefix); return s === undefined ? prefix.startsWith('R-') && prefix.endsWith('-') && prefix.length > 3 : s.has(storeId); },
  plausible: (prefix, through) => through <= (banked.get(prefix) ?? 0) + PLAUSIBLE_ISSUED_AHEAD,
});

/**
 * One report as head office keeps it. `door` true: kept by round 33's route (unregistered prefixes refused, never stored);
 * false: kept before the rule, as round 32 stored it (the invented prefixes are on the ledger).
 */
function rec(i: number, xs: { prefix: string; through: number }[], banked: ReadonlyMap<string, number>, registered: ReadonlySet<string>, door: boolean, by = 'u-box') {
  const j = judgeReportedIssued({ storeId: 'S1', issued: issued(xs), issuedPrefixes, banked, registered });
  const raw = {
    storeId: 'S1', observedAt: iso(i * 15_000), receivedAt: iso(i * 15_000), reportedBy: by, clockAheadCorrected: false, tills: [], disk: DISK,
    queue: { unsent: 0, deadLettered: 0 },
    receiptNumbersIssued: door ? j.accepted : issued(xs),
    ...(j.refused.length === 0 ? {} : { receiptNumbersRefused: j.refused }),
  } as unknown as BoxHealthRecord;
  return { raw, judged: { ...raw, receiptNumbersIssued: j.accepted } as BoxHealthRecord, seq: i + 1 };
}
function read(entries: ReturnType<typeof rec>[], judge: BoxHistoryJudge, banked: ReadonlyMap<string, number>) {
  const n = entries.length;
  const at = iso(n * 15_000 + 30 * 60_000);
  const r = readBoxHistory({ entries, at, banked, judge, settleBefore: iso(n * 15_000 + 20 * 60_000), settledThrough: n, sealKey: TEST_BOX_HISTORY_KEY });
  if ('setAside' in r) throw new Error(r.setAside);
  return { size: r.snapshot!.sizeBytes, findings: billNumberFindingsFor({ storeId: 'S1', records: [], at, banked, unreceived: [], facts: r.facts('S1') } as never), facts: r.facts('S1') };
}

describe('round 33 · OB-121: only issued or registered bill-number prefixes are believed from a store computer', () => {
  it('at the door an invented R-…- is not folded (refused, never stored); a registered one is accepted; an issued one as before', () => {
    const banked = new Map<string, number>([['S1L0-', 100], ['R-L1-', 40]]);
    const registered = new Set(['R-L1-']);
    const j = judgeReportedIssued({ storeId: 'S1', banked, issuedPrefixes, registered, issued: issued([{ prefix: 'S1L0-', through: 101 }, { prefix: 'R-L1-', through: 45 }, { prefix: 'R-zz-', through: 5_000 }, { prefix: 'R-L1-x-', through: 999_999 }, { prefix: 'ZZABCDEF-', through: 3 }]) });
    expect(j.accepted.map((x) => x.prefix)).toEqual(['S1L0-', 'R-L1-']);
    expect(j.refused).toEqual([]);
    expect(j.notFolded.map((x) => x.prefix)).toEqual(['R-zz-', 'R-L1-x-', 'ZZABCDEF-']);
    // Without a registration nothing shaped like R-…- is ever accepted (the round-32 shortcut is gone).
    expect(judgeReportedIssued({ storeId: 'S1', banked, issuedPrefixes, issued: issued([{ prefix: 'R-L1-', through: 45 }]) }).notFolded).toHaveLength(1);
    // A registered lane with an impossible count is refused and kept (and capped, OB-117) as any own prefix is.
    expect(judgeReportedIssued({ storeId: 'S1', banked, issuedPrefixes, registered, issued: issued([{ prefix: 'R-L1-', through: 999_999 }]) }).refused).toMatchObject([{ prefix: 'R-L1-', because: 'beyond_plausible_advance' }]);
  });

  for (const [name, through] of [['F4 (impossible counts)', 999_999], ['F5 (plausible counts)', 5_000]] as const) {
    it(`${name}: 10 NEW invented R-…- prefixes every report for 200 minutes — the saved history stays small, kept before the rule or at the door`, { timeout: 120_000 }, () => {
      const banked = new Map<string, number>([['S1L0-', 100]]);
      const none = new Set<string>();
      const flood = (door: boolean) => Array.from({ length: 800 }, (_, i) => rec(i, [{ prefix: 'S1L0-', through: 100 }, ...Array.from({ length: 10 }, (_, k) => ({ prefix: fresh(i, k), through }))], banked, none, door));
      const honest = read(Array.from({ length: 800 }, (_, i) => rec(i, [{ prefix: 'S1L0-', through: 100 }], banked, none, true)), judgeOf(new Map(), banked), banked);
      const atDoor = read(flood(true), judgeOf(new Map(), banked), banked);
      const before = read(flood(false), judgeOf(new Map(), banked), banked);
      console.log(`OB-121 ${name}: saved history after 200 minutes — honest ${(honest.size / 1024).toFixed(1)} KB; flood refused at the door ${(atDoor.size / 1024).toFixed(1)} KB; flood kept before the rule ${(before.size / 1024).toFixed(1)} KB (round 32: F4 4.8 MB, F5 246 MB)`);
      // Exactly the honest store's history, whichever way the flood reached the ledger.
      expect(atDoor.size).toBe(honest.size);
      expect(before.size).toBe(honest.size);
      expect(before.findings).toEqual(honest.findings);
      expect(atDoor.size).toBeLessThan(64 * 1024);
    });
  }

  it('an honest store with its lanes registered reads exactly as it did under the round-32 shortcut', () => {
    const lanes = ['R-L1-', 'R-L2-', 'R-L3-'];
    const banked = new Map<string, number>([['S1L0-', 100], ...lanes.map((p) => [p, 200] as const)]);
    const registered = new Set(lanes);
    // A day of a busy store: counts creeping up, one lane once implausibly ahead (refused, kept), bills waiting now and then.
    const make = () => Array.from({ length: 600 }, (_, i) => rec(i, [{ prefix: 'S1L0-', through: 100 + Math.floor(i / 50) }, ...lanes.map((p, k) => ({ prefix: p, through: i === 300 && k === 1 ? 999_000 : 200 + Math.floor(i / 20) + k }))], banked, registered, true));
    const now = read(make(), judgeOf(new Map([['S1', registered]]), banked), banked);
    const then = read(make(), oldJudge(banked), banked);
    expect(now.findings).toEqual(then.findings);
    expect(now.size).toBe(then.size);
    expect(now.findings.some((f) => f.kind === 'report_refused' && f.prefix === 'R-L2-')).toBe(true);
  });

  it('a lane registered (or a registration changed) after a saved result was made sets it aside; the new reading believes the lane', () => {
    const banked = new Map<string, number>([['S1L0-', 100], ['R-L1-', 50]]);
    const legacy = Array.from({ length: 200 }, (_, i) => rec(i, [{ prefix: 'S1L0-', through: 100 }, { prefix: 'R-L1-', through: 50 + Math.floor(i / 10) }], banked, new Set(), false));
    const n = legacy.length;
    const at = iso(n * 15_000 + 30 * 60_000);
    const common = { entries: legacy, at, banked, settleBefore: iso(n * 15_000 + 20 * 60_000), settledThrough: n, sealKey: TEST_BOX_HISTORY_KEY };
    const before = readBoxHistory({ ...common, judge: judgeOf(new Map(), banked), lanes: [] });
    if ('setAside' in before) throw new Error(before.setAside);
    const lanes: LanePrefixRegistration[] = [{ computer: 'u-box', storeId: 'S1', prefixes: ['R-L1-'], by: 'u-it', at, via: 'install' }];
    const judge = judgeOf(registeredByStore(lanes), banked);
    expect(readBoxHistory({ ...common, snapshot: before.snapshot!, judge, lanes })).toEqual({ setAside: 'lanes' });
    // The same registrations again: the result stands.
    const after = readBoxHistory({ ...common, judge, lanes });
    if ('setAside' in after) throw new Error(after.setAside);
    expect('setAside' in readBoxHistory({ ...common, snapshot: after.snapshot!, judge, lanes })).toBe(false);
    // And the lane is now believed: its kept reports are folded (the saved history is larger than without it).
    expect(after.snapshot!.sizeBytes).toBeGreaterThan(before.snapshot!.sizeBytes);
  });

  it('the registrations: per computer at the door, per store at read; the one-time migration takes only lanes with real bills', () => {
    const regs: LanePrefixRegistration[] = [
      { computer: 'u-box', storeId: 'S1', prefixes: ['R-L1-'], by: 'u-it', at: iso(0), via: 'install' },
      { computer: 'u-box', storeId: 'S1', prefixes: ['R-L2-'], by: 'u-it', at: iso(1), via: 'install' },
      { computer: 'u-box-2', storeId: 'S1', prefixes: ['R-L9-'], by: 'u-it', at: iso(2), via: 'install' },
      { computer: 'u-box', storeId: 'S2', prefixes: ['R-L5-'], by: 'u-it', at: iso(3), via: 'install' },
    ];
    expect([...registeredForComputer(regs, 'u-box', 'S1')].sort()).toEqual(['R-L1-', 'R-L2-']);
    expect([...registeredByStore(regs).get('S1')!].sort()).toEqual(['R-L1-', 'R-L2-', 'R-L9-']);
    expect(lanePrefixOf('lane-1')).toBe('R-lane-1-');
    const banked = new Map<string, number>([['R-lane-1-', 12], ['R-lane-2-', 0]]);
    const kept = (by: string, prefixes: string[]): BoxHealthRecord => ({ storeId: 'S1', reportedBy: by, receiptNumbersIssued: prefixes.map((prefix) => ({ prefix, through: 3 })) } as unknown as BoxHealthRecord);
    // R-lane-1- has bills banked: registered. R-lane-2- (no bill), R-zz- (invented), another computer's, too long: not.
    expect(seenBeforeRegistration([kept('u-box', ['R-lane-1-', 'R-lane-2-', 'R-zz-']), kept('u-other', ['R-lane-1-']), kept('u-box', ['R-lane-1-long-'])], 'u-box', 'S1', banked)).toEqual(['R-lane-1-']);
    expect(seenBeforeRegistration([kept('u-other', ['R-lane-1-'])], 'u-box', 'S1', banked)).toEqual([]);
    // Never more than the cap, however many the computer reported.
    const many = new Map(Array.from({ length: 50 }, (_, k) => [`R-${k}-`, 1] as const));
    expect(seenBeforeRegistration([kept('u-box', [...many.keys()])], 'u-box', 'S1', many)).toHaveLength(LANE_PREFIXES_PER_COMPUTER_MAX);
  });

  it('the health page: one line per store computer per day, a few short examples, said and never silent', () => {
    const at = '2026-03-03T10:00:00.000Z';
    const c = doorRefusalComponents([
      { computer: 'u-bad', storeId: 'S1', day: '2026-03-03', count: 1_500, examples: ['R-a-', 'R-b-', 'ZZABCDEF-'], first: '2026-03-03T00:00:01.000Z', last: '2026-03-03T09:59:00.000Z' },
      { computer: 'u-bad', storeId: 'S1', day: '2026-02-20', count: 9, examples: ['R-q-'], first: '2026-02-20T00:00:01.000Z', last: '2026-02-20T09:59:00.000Z' },
    ], at);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ name: 'box_prefixes_refused:S1', status: 'degraded', evidence: { computers: 'u-bad', reports: 1_500 } });
    expect(c[0]!.detail).toMatch(/computer u-bad sent 1500 report\(s\) on 2026-03-03 naming bill-number prefixes head office never issued .* refused at the door and not kept \(owner decision OB-121\)/);
    expect(c[0]!.detail).toMatch(/ZZ… is a store computer's own fallback numbering/);
    expect(doorRefusalComponents([], at)).toEqual([]);
  });
});

describe('round 33 · OB-121: the one-time migration never reads the whole history (only the newest window with the computer\'s own reports)', () => {
  const NOW = '2026-10-15T10:00:00.000Z';
  const kept = (by: string, hoursAgo: number, prefixes: string[]): BoxHealthRecord => ({
    storeId: 'S1', reportedBy: by, receivedAt: new Date(Date.parse(NOW) - hoursAgo * 3_600_000).toISOString(),
    receiptNumbersIssued: prefixes.map((prefix) => ({ prefix, through: 3 })),
  } as unknown as BoxHealthRecord);
  async function firstReport(history: BoxHealthRecord[]) {
    const windows: [number, number][] = [];
    const regs: LanePrefixRegistration[] = [];
    const deps: BoxHealthDeps = {
      now: () => NOW,
      storeComputerScopeOf: async () => ['S1'],
      record: async (_t, r) => r,
      issuedAndBanked: async () => ({ issuedPrefixes: new Map(), banked: new Map([['R-L1-', 9], ['R-L2-', 4]]) }),
      records: async () => { throw new Error('the whole history was read'); },
      recordsBetween: async (_t, from, to) => {
        windows.push([(Date.parse(NOW) - Date.parse(from)) / 3_600_000, (Date.parse(NOW) - Date.parse(to)) / 3_600_000]);
        return history.filter((r) => r.receivedAt >= from && r.receivedAt < to);
      },
      lanePrefixRegistrations: async () => regs,
      registerLanePrefixes: async (_t, r) => { regs.push(r); return r; },
      countRefusedAtDoor: async () => undefined,
    };
    const route = boxHealthRoutes(deps).find((r) => r.method === 'POST' && r.path === BOX_HEALTH_PATH)!;
    const ctx = { tenantId: 'T', userId: 'u-box', branchId: 'S1', scope: ['S1'], params: {}, query: {}, traceId: 't', idempotencyKey: 'k',
      body: { storeId: 'S1', observedAt: NOW, disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1, salesLogCapacityBytes: 1e7, reserveBytes: 1 }, queue: { unsent: 0, deadLettered: 0 }, tills: [], receiptNumbersIssued: [{ prefix: 'R-L1-', through: 4 }] } };
    const res = await route.handler(ctx as never);
    return { windows, regs, res };
  }
  it('a computer that reported an hour ago: only the last hour is read; its lane with bills is registered once', async () => {
    const { windows, regs, res } = await firstReport([kept('u-box', 0.5, ['R-L1-']), kept('u-other', 0.2, ['R-L2-']), kept('u-box', 500, ['R-L2-'])]);
    expect(windows).toEqual([[1, 0]]);
    expect(regs).toMatchObject([{ computer: 'u-box', prefixes: ['R-L1-'], via: 'seen_before_registration', by: 'head-office' }]);
    expect((res.body as { recorded: { receiptNumbersIssued: { prefix: string }[] } }).recorded.receiptNumbersIssued.map((x) => x.prefix)).toEqual(['R-L1-']);
  });
  it('a computer silent for ten days: the windows step back until its newest reports; past 30 days nothing is registered', async () => {
    const ten = await firstReport([kept('u-box', 240, ['R-L1-', 'R-L2-'])]);
    expect(ten.windows).toEqual([[1, 0], [6, 1], [24, 6], [168, 24], [720, 168]]);
    expect(ten.regs[0]!.prefixes).toEqual(['R-L1-', 'R-L2-']);
    const old = await firstReport([kept('u-box', 1_000, ['R-L1-'])]);
    expect(old.regs[0]!.prefixes).toEqual([]);
    expect(MIGRATION_LOOKBACK_HOURS.at(-1)).toBe(720);
  });
});
