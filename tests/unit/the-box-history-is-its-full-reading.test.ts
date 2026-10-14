import { describe, it, expect } from 'vitest';
import {
  readBoxHistory, readNeverReceived, billNumberFindingsFor, judgeBoxes, prefixBindings, FOLD_SETTLE_MINUTES, UNRECEIVED_GRACE_MINUTES,
  type BoxHealthRecord, type BoxHistorySnapshot, type BoxHistoryEntry, type BoxHistoryJudge, type ClaimSlack,
  type RefusalAcknowledgement, type AtRiskAcknowledgement, type UnreceivedCandidate, type UnreceivedNumbers,
} from '../../services/platform/src/box-health';
import { DEFAULT_THRESHOLDS } from '../../packages/ops/src/index';
import { history, longHistory, honestStore, judged, rng, iso, type Seeded } from '../support/box-history';

/**
 * **Round 28 · OB-104 "A" (owner, 13 Oct 2026, in writing, "Before the pilot") — a health read that reads only the reports
 * after its saved running result says EXACTLY what a read of every report says.**
 *
 * The full reading is the code every health read ran before this round, unchanged: the never-received fold over every report
 * (`readNeverReceived`), the findings from every report (`billNumberFindingsFor` with `records`), the bindings
 * (`prefixBindings`), and the store's health from every report (`judgeBoxes` with `records`). The windowed reading is
 * `readBoxHistory` — resumed from the result an earlier read saved, folding only the reports at the store's positions above
 * it — and the same functions speaking from its facts (`facts`, `view`).
 *
 * 300 seeded random histories, each read again and again as head office would (every few reports, each read resuming from
 * the last one's saved result), with everything the result carries in play: two stores and three store computers, prefixes
 * bound to the first reporter and moved by owner-approved acts, refused reports (too far ahead, another store's prefix, a
 * second store computer's word), refused counts acknowledged (and not), at-risk lists longer than the 500 checked and their
 * acknowledgements, waiting spans and "no list" runs, dead letters, self-contradicting reports, a disk that grows, shrinks
 * and goes quiet for days, box times written two ways and repeated, and reports that ARRIVE out of order. The SET-ASIDE cases
 * are made on purpose and checked to happen: a report that arrived late below the saved moment, a backdated
 * acknowledgement, a changed setting, a verdict that changed, a banked count lower than the one used, a fence not settled.
 */

const unreceivedOf = (c: readonly UnreceivedCandidate[], storeId: string): UnreceivedNumbers[] => c.filter((x) => x.storeId === storeId).map((x) => ({
  prefix: x.prefix, numbers: x.numbers, since: x.since, capped: x.capped,
  ...(x.sparse === undefined ? {} : { sparse: x.sparse }), ...(x.wholeQueue === undefined ? {} : { wholeQueue: x.wholeQueue }),
  ...(x.reclaimed === undefined ? {} : { reclaimed: x.reclaimed }),
}));

interface Settings { readonly warnHours?: number; readonly slack?: ClaimSlack; readonly timeZone?: string }

/** Every answer of the FULL reading (the code before this round), over every report visible at `at`. */
function fullReading(h: Seeded, visible: readonly (BoxHealthRecord & { seq: number })[], at: string, banked: ReadonlyMap<string, number>, judge: BoxHistoryJudge, st: Settings, acks: { refusal: RefusalAcknowledgement[]; atRisk: AtRiskAcknowledgement[] }) {
  const raw = [...visible].sort((a, b) => a.seq - b.seq).map(({ seq: _s, ...r }) => { void _s; return r as BoxHealthRecord; });
  const judgedRecords = raw.map((r) => judged(r, judge));
  const nr = readNeverReceived({ records: judgedRecords, at, banked, replacements: h.acts, ...st });
  const stores = [...new Set(raw.map((r) => r.storeId))].sort();
  const findings = new Map(stores.map((s) => [s, billNumberFindingsFor({
    storeId: s, records: judgedRecords, at, unreceived: unreceivedOf(nr.candidates, s), banked, acknowledged: acks.refusal, replacements: h.acts, atRiskAcknowledged: acks.atRisk,
  })] as const));
  const boxes = judgeBoxes({
    records: raw, at, thresholds: DEFAULT_THRESHOLDS, billNumberFindings: findings, replacements: h.acts, bindings: nr.bindings, unusedNumbers: nr.unused,
    ...(st.warnHours === undefined ? {} : { unsentWarnHours: st.warnHours }),
  });
  return { candidates: nr.candidates, unused: nr.unused, bindings: nr.bindings, rawBindings: prefixBindings(raw, h.acts, at), findings, boxes };
}

interface Tally {
  asides: Map<string, number>; resumedReads: number; reads: number; windowed: number; everything: number; findingKinds: Set<string>;
  standing: number; hoursKnown: number; moved: number; others: number; fenceHeld: number; later: number; several: number; biggest: number;
}
const tally = (): Tally => ({ asides: new Map(), resumedReads: 0, reads: 0, windowed: 0, everything: 0, findingKinds: new Set(), standing: 0, hoursKnown: 0, moved: 0, others: 0, fenceHeld: 0, later: 0, several: 0, biggest: 0 });

/** One seeded history read again and again as head office would (each read resuming from the last one's saved result), every answer checked. */
function readAgainAndAgain(h: Seeded, seed: number, t: Tally, step = 8): void {
  const { asides, findingKinds } = t;
  let { resumedReads, reads, windowed, everything, standing, hoursKnown, moved, others, fenceHeld, later } = t;
  {
    {
      const rnd = rng(seed * 7919);
      let snapshot: BoxHistorySnapshot | undefined;
      let visibleSeq = 0;
      let banked = new Map<string, number>([['A-', 0], ['B-', 0]]);
      let settings: Settings = {};
      let ownsB2 = true; // whether B- counts as store S2's own prefix (a verdict that can change between reads)
      let ahead = 1_000_000; // how far ahead of banked a count is believed
      while (visibleSeq < h.records.length) {
        visibleSeq = Math.min(h.records.length, visibleSeq + 1 + Math.floor(rnd() * step));
        // A report whose write commits late is not visible yet while fewer than its delay of later ones are (PostgreSQL).
        const hidden = (seq: number): boolean => visibleSeq < h.records.length && seq + (h.commitsLate.get(seq) ?? 0) > visibleSeq;
        const visible = h.records.slice(0, visibleSeq).filter((r) => !hidden(r.seq));
        if (visible.length === 0) continue;
        const lastMs = Math.max(...visible.map((r) => Date.parse(r.receivedAt)));
        // Read a little after the newest report — or, now and then, BEFORE it arrived (a report stamped later than the read).
        const at = rnd() < 0.08 ? iso(lastMs - 1_000 - Math.floor(rnd() * 30 * 60_000))
          : iso(lastMs + Math.floor(rnd() * 3) * 20 * 60_000 + (rnd() < 0.2 ? UNRECEIVED_GRACE_MINUTES * 60_000 : 0));
        const atMs = Date.parse(at);
        // Now and then something the saved result was made from changes.
        if (rnd() < 0.05) settings = rnd() < 0.5 ? {} : { warnHours: 1, slack: { numbers: 0, percent: 0 }, timeZone: 'UTC' };
        if (rnd() < 0.15) banked = new Map([['A-', (banked.get('A-') ?? 0) + Math.floor(rnd() * 6)], ['B-', (banked.get('B-') ?? 0) + Math.floor(rnd() * 4)]]);
        if (rnd() < 0.03) banked = new Map([['A-', 0], ['B-', 0]]); // a banked count LOWER than the one used (set aside)
        if (rnd() < 0.04) ownsB2 = !ownsB2;
        if (rnd() < 0.03) ahead = ahead === 1_000_000 ? 10 : 1_000_000;
        const judge: BoxHistoryJudge = {
          owns: (storeId, prefix) => !(storeId === 'S2' && prefix === 'B-' && !ownsB2),
          plausible: (prefix, through) => through <= (banked.get(prefix) ?? 0) + ahead,
        };
        // The acknowledgements and acts head office holds by now; now and then one is BACKDATED (set aside).
        const refusal = h.refusalAcks.filter((a) => Date.parse(a.at) <= atMs);
        const atRisk = h.atRiskAcks.filter((a) => Date.parse(a.at) <= atMs);
        if (rnd() < 0.03 && visible.length > 0) refusal.push({ storeId: 'S1', prefix: 'C-', through: 20_000, reason: 'backdated', by: 'u-owner', at: visible[0]!.receivedAt, authority: 'all_stores' });
        const acks = { refusal, atRisk };
        const full = fullReading({ ...h, acts: h.acts }, visible, at, banked, judge, settings, acks);
        // The fence: settled at the newest position (memory), or — now and then — only at an older one (PostgreSQL, busy).
        // A settled fence never passes a write still open: below the lowest hidden position.
        const openBelow = h.records.slice(0, visibleSeq).filter((r) => hidden(r.seq)).map((r) => r.seq - 1);
        const settledThrough = Math.min(rnd() < 0.2 ? Math.max(0, visibleSeq - 1 - Math.floor(rnd() * 5)) : visibleSeq, ...openBelow);
        const entriesOf = (list: readonly (BoxHealthRecord & { seq: number })[]): BoxHistoryEntry[] => list.map(({ seq, ...r }) => ({ raw: r as BoxHealthRecord, judged: judged(r as BoxHealthRecord, judge), seq }));
        const common = {
          at, banked, replacements: h.acts, refusalAcks: refusal, atRiskAcks: atRisk, judge, ...settings,
          settleBefore: iso(atMs - FOLD_SETTLE_MINUTES * 60_000), settledThrough,
        };
        const window = snapshot === undefined ? visible : visible.filter((r) => r.seq > snapshot!.seq);
        let got = readBoxHistory({ entries: entriesOf(window), ...(snapshot === undefined ? {} : { snapshot }), ...common });
        if ('setAside' in got) {
          asides.set(got.setAside, (asides.get(got.setAside) ?? 0) + 1);
          got = readBoxHistory({ entries: entriesOf(visible), ...common });
          if ('setAside' in got) throw new Error('cannot set aside a read from nothing');
          everything += visible.length;
        } else {
          windowed += window.length;
          if (got.resumed) resumedReads += 1;
        }
        reads += 1;
        const ctx = `seed ${seed}, read ${reads} at ${at} (${visibleSeq} reports)`;
        expect(got.candidates, ctx).toEqual(full.candidates);
        expect(got.unused, ctx).toEqual(full.unused);
        expect(got.bindings, ctx).toEqual(full.bindings);
        expect(got.rawBindings, ctx).toEqual(full.rawBindings);
        expect(got.storeIds, ctx).toEqual([...full.findings.keys()]);
        const findings = new Map(got.storeIds.map((s) => [s, billNumberFindingsFor({ storeId: s, records: [], at, unreceived: unreceivedOf(got.candidates, s), banked, facts: got.facts(s) })] as const));
        expect(findings, ctx).toEqual(full.findings);
        for (const list of findings.values()) for (const f of list) findingKinds.add(f.kind);
        const boxes = judgeBoxes({
          records: [], view: got.view, at, thresholds: DEFAULT_THRESHOLDS, billNumberFindings: findings, replacements: h.acts, bindings: got.bindings, unusedNumbers: got.unused,
          ...(settings.warnHours === undefined ? {} : { unsentWarnHours: settings.warnHours }),
        });
        expect(boxes, ctx).toEqual(full.boxes);
        for (const box of boxes.boxes) for (const f of box.billNumberFindings ?? []) findingKinds.add(f.kind);
        standing += got.storeIds.filter((s) => ['A-', 'B-'].some((p) => got.facts(s).atRiskStands(p))).length;
        hoursKnown += boxes.boxes.filter((b) => b.tradingHoursLeft !== null).length;
        moved += got.bindings.filter((b) => b.via === 'replacement').length > 0 ? 1 : 0;
        others += boxes.boxes.filter((b) => (b.otherComputers ?? []).length > 0).length > 0 ? 1 : 0;
        if (got.snapshot !== undefined && got.snapshot.folded.length > 0) fenceHeld += 1;
        if (visible.some((r) => Date.parse(r.receivedAt) > atMs)) later += 1;
        t.several += boxes.boxes.filter((b) => (b.boundComputers ?? []).length > 1).length > 0 ? 1 : 0;
        // The saved result is plain data (it is kept as JSON on PostgreSQL): the next read resumes from its JSON copy.
        if (got.snapshot !== undefined) {
          const text = JSON.stringify(got.snapshot);
          t.biggest = Math.max(t.biggest, text.length);
          snapshot = JSON.parse(text) as BoxHistorySnapshot;
        }
      }
    }
  }
  Object.assign(t, { resumedReads, reads, windowed, everything, standing, hoursKnown, moved, others, fenceHeld, later });
}

describe('round 28 · OB-104: the windowed health read is the full reading', () => {
  it('300 seeded histories, read again and again from the saved result, every answer field for field (set-aside cases included)', () => {
    const t = tally();
    for (let seed = 1; seed <= 300; seed += 1) readAgainAndAgain(history(seed), seed, t);
    const { asides, resumedReads, reads, windowed, everything, findingKinds, standing, hoursKnown, moved, others, fenceHeld, later } = t;
    console.log(`[OB-104] not-checked acknowledgements standing ${standing}, hours left known ${hoursKnown}, reads with a moved prefix ${moved}, with a second store computer ${others}, saves held below a busy fence or a late report ${fenceHeld}, reads with a report stamped after them ${later}`);
    expect(Math.min(standing, hoursKnown, moved, others, fenceHeld, later)).toBeGreaterThan(0);
    console.log(`[OB-104] ${reads} reads: ${resumedReads} resumed from the saved result (${windowed} reports folded in their windows), set aside: ${JSON.stringify(Object.fromEntries(asides))} (${everything} reports re-folded); finding kinds seen: ${[...findingKinds].sort().join(', ')}`);
    // Not a vacuous comparison: most reads resumed, and every set-aside case and finding kind came up.
    expect(resumedReads).toBeGreaterThan(reads / 3);
    for (const why of ['late_report', 'settings', 'acknowledgements', 'verdicts', 'banked']) expect(asides.get(why) ?? 0, `set aside for ${why}`).toBeGreaterThan(0);
    for (const kind of ['issued_never_received', 'report_refused', 'bills_waiting_on_box', 'bills_dead_lettered_on_box', 'at_risk_not_checked', 'report_contradicts_its_queue']) {
      expect(findingKinds.has(kind), kind).toBe(true);
    }
    // Round 29 · OB-107: stores where more than one store computer holds tills came up (each judged, the worse deciding).
    expect(t.several).toBeGreaterThan(0);
  }, 600_000);

  it('round 29 · OB-105: 40 LONG histories (months of reports, gaps of up to 40 days — the waiting clock\'s day and the unused runs\' month both crossed), every answer field for field', () => {
    const t = tally();
    for (let seed = 1; seed <= 40; seed += 1) readAgainAndAgain(longHistory(seed, 8), 10_000 + seed, t, 24);
    console.log(`[OB-105 long] ${t.reads} reads: ${t.resumedReads} resumed, set aside ${JSON.stringify(Object.fromEntries(t.asides))}; biggest saved result ${(t.biggest / 1024).toFixed(1)} KB; several store computers holding tills on ${t.several} read(s)`);
    expect(t.resumedReads).toBeGreaterThan(t.reads / 3);
    for (const kind of ['issued_never_received', 'bills_waiting_on_box', 'report_refused']) expect(t.findingKinds.has(kind), kind).toBe(true);
  }, 900_000);

  it('round 29 · OB-105: the verifier\'s honest busy store (10 tills, a report every 15 s, 1,900 bills a till a day) read in windows for 2 days is the full reading at each check', () => {
    const records = honestStore(2);
    let snapshot: BoxHistorySnapshot | undefined;
    const settings: Settings = { timeZone: 'UTC' };
    const judge: BoxHistoryJudge = { owns: () => true, plausible: () => true };
    const checks = new Set([1_920, 5_760, 11_520]);
    let checked = 0;
    for (let seen = 640; seen <= records.length; seen += 640) {
      const last = Date.parse(records[seen - 1]!.receivedAt);
      const at = iso(last + 60_000);
      // Head office has banked everything sold up to 2 minutes before the read (the honest store keeps up).
      const banked = new Map<string, number>();
      for (const r of records.slice(0, seen)) if (Date.parse(r.receivedAt) <= last - 120_000) for (const x of r.receiptNumbersIssued ?? []) banked.set(x.prefix, x.through);
      const visible = records.slice(0, seen);
      const window = snapshot === undefined ? visible : visible.filter((r) => r.seq > snapshot!.seq);
      const got = readBoxHistory({
        entries: window.map(({ seq, ...r }) => ({ raw: r as BoxHealthRecord, judged: r as BoxHealthRecord, seq })), ...(snapshot === undefined ? {} : { snapshot }),
        at, banked, judge, ...settings, settleBefore: iso(Date.parse(at) - FOLD_SETTLE_MINUTES * 60_000), settledThrough: seen,
      });
      if ('setAside' in got) throw new Error(`set aside: ${got.setAside}`);
      if (got.snapshot !== undefined) snapshot = JSON.parse(JSON.stringify(got.snapshot)) as BoxHistorySnapshot;
      if (!checks.has(seen)) continue;
      const full = fullReading({ records: visible, refusalAcks: [], atRiskAcks: [], acts: [], commitsLate: new Map() }, visible, at, banked, judge, settings, { refusal: [], atRisk: [] });
      expect(got.candidates).toEqual(full.candidates);
      expect(got.bindings).toEqual(full.bindings);
      const findings = new Map(got.storeIds.map((s) => [s, billNumberFindingsFor({ storeId: s, records: [], at, unreceived: unreceivedOf(got.candidates, s), banked, facts: got.facts(s) })] as const));
      expect(findings).toEqual(full.findings);
      expect(judgeBoxes({ records: [], view: got.view, at, thresholds: DEFAULT_THRESHOLDS, billNumberFindings: findings, bindings: got.bindings, unusedNumbers: got.unused })).toEqual(full.boxes);
      checked += 1;
    }
    expect(checked).toBe(3);
    expect(snapshot!.sizeBytes).toBeLessThan(2 * 1_048_576);
  }, 900_000);
});
