import { describe, it, expect } from 'vitest';
import {
  bindPrefixesToComputers, prefixBindings, billNumberFindingsFor, unreceivedCandidates, atRiskNotChecked, atRiskAcknowledgementStands,
  UNRECEIVED_CHECK_CAP, UNRECEIVED_GRACE_MINUTES, type BoxHealthRecord, type IssuedReport, type StoreComputerReplacement, type AtRiskAcknowledgement,
} from '../../services/platform/src/box-health';

/**
 * **Round 26 · owner decisions OB-97 "B" and OB-98 "B" (13 Oct 2026, in writing) — head office's pure rules.**
 *
 *   OB-97: an owner-approved "store computer replaced" act moves a (store, prefix) binding from the old store computer's
 *   sign-in to the new one. From the act's moment the new computer's reports are used and the old one's are refused by name;
 *   reports before it keep their verdict; the latest act decides; a read "as at" an earlier moment never applies a later act;
 *   the new computer's refusals from before the act are answered by it (the old computer's after it never are); lost-bill
 *   checks resume on the new computer.
 *   OB-98: the "at-risk numbers not checked" line names exactly which numbers were not checked; an all-stores acknowledgement
 *   silences it while the store computer keeps reporting that same set; a different set (even the old one coming back) needs
 *   a new acknowledgement; an acknowledgement without all-stores authority is never honoured.
 */

const S = 'S1';
const P = 'S1L1-';
const T0 = Date.parse('2026-10-13T08:00:00.000Z');
const iso = (min: number): string => new Date(T0 + min * 60_000).toISOString();
const DISK = { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 };
const rep = (min: number, by: string, x: Partial<IssuedReport> & { through: number }, unsent = 0): BoxHealthRecord => ({
  storeId: S, observedAt: iso(min), receivedAt: iso(min), reportedBy: by, disk: DISK, queue: { unsent, deadLettered: 0 }, tills: [], clockAheadCorrected: false,
  receiptNumbersIssued: [{ prefix: P, soldThrough: x.through, unsent: { count: 0 }, ...x }],
});
const act = (min: number, from: string, to: string, id = `a${min}`): StoreComputerReplacement => ({
  replacementId: `scr-${id}`, storeId: S, prefix: P, from, to, reason: 'old box died', requestedBy: 'u-ho', approvedBy: 'u-owner', approvalId: id, at: iso(min),
});
const used = (rs: readonly BoxHealthRecord[]): string[] => rs.filter((r) => (r.receiptNumbersIssued ?? []).some((x) => x.prefix === P)).map((r) => r.reportedBy);
const refused = (rs: readonly BoxHealthRecord[]): [string, string | undefined][] =>
  rs.flatMap((r) => (r.receiptNumbersRefused ?? []).map((x) => [r.reportedBy, x.boundTo] as [string, string | undefined]));

describe('OB-97 · the binding follows an owner-approved "store computer replaced" act', () => {
  const records = [rep(0, 'u-old', { through: 10 }), rep(1, 'u-new', { through: 10 }), rep(3, 'u-new', { through: 12 }), rep(4, 'u-old', { through: 12 })];

  it('without the act: the first reporter keeps the prefix; the other is refused by name (round 25, unchanged)', () => {
    const out = bindPrefixesToComputers(records);
    expect(used(out)).toEqual(['u-old', 'u-old']);
    expect(refused(out)).toEqual([['u-new', 'u-old'], ['u-new', 'u-old']]);
  });

  it('after the act the new computer\'s reports are used and the old one\'s are refused, naming the new one; earlier reports keep their verdict', () => {
    const out = bindPrefixesToComputers(records, [act(2, 'u-old', 'u-new')]);
    expect(used(out)).toEqual(['u-old', 'u-new']);
    expect(refused(out)).toEqual([['u-new', 'u-old'], ['u-old', 'u-new']]);
    expect(prefixBindings(records, [act(2, 'u-old', 'u-new')])).toEqual([{ storeId: S, prefix: P, computer: 'u-new', since: iso(2), via: 'replacement', replacementId: 'scr-a2' }]);
  });

  it('the latest act decides (A → B, then B → C); a read as at an earlier moment never applies a later act', () => {
    const acts = [act(2, 'u-old', 'u-new'), act(3.5, 'u-new', 'u-third')];
    const out = bindPrefixesToComputers([...records, rep(5, 'u-third', { through: 13 })], acts);
    expect(used(out)).toEqual(['u-old', 'u-new', 'u-third']);
    expect(prefixBindings(records, acts).map((b) => b.computer)).toEqual(['u-third']);
    expect(prefixBindings(records, acts, iso(2.5)).map((b) => [b.computer, b.via])).toEqual([['u-new', 'replacement']]);
    expect(prefixBindings(records, acts, iso(1.5)).map((b) => [b.computer, b.via])).toEqual([['u-old', 'first_report']]);
  });

  it('acts come in any order: they are applied in time order', () => {
    const a = bindPrefixesToComputers(records, [act(3.5, 'u-new', 'u-old', 'b'), act(2, 'u-old', 'u-new')]);
    expect(used(a)).toEqual(['u-old', 'u-new', 'u-old']);
  });

  it('the new computer\'s refusals from before the act are answered by it; the old one\'s after it are a finding naming both', () => {
    const at = iso(10);
    const before = billNumberFindingsFor({ storeId: S, records, at, unreceived: [] }).filter((f) => f.kind === 'report_refused');
    expect(before).toHaveLength(1);
    expect(before[0]!.detail).toMatch(/^refused — a second store computer: u-new reported bill numbers under S1L1- \(through 12\) for store S1, but S1L1- belongs to the store computer u-old/);
    const after = billNumberFindingsFor({ storeId: S, records, at, unreceived: [], replacements: [act(2, 'u-old', 'u-new')] }).filter((f) => f.kind === 'report_refused');
    expect(after).toHaveLength(1);
    expect(after[0]!.detail).toMatch(/^refused — a second store computer: u-old reported bill numbers under S1L1- \(through 12\) for store S1, but S1L1- belongs to the store computer u-new/);
    // Read as at a moment before the act, nothing of it applies.
    const asAtBefore = billNumberFindingsFor({ storeId: S, records, at: iso(1.5), unreceived: [], replacements: [act(2, 'u-old', 'u-new')] }).filter((f) => f.kind === 'report_refused');
    expect(asAtBefore.map((f) => /^refused — a second store computer: u-new reported/.test(f.detail))).toEqual([true]);
  });

  it('lost-bill checks resume on the new computer: its "nothing waiting" is used only after the act', () => {
    // Head office banked through 10. The new box says it sold through 15 and holds nothing to send.
    const rs = [rep(0, 'u-old', { through: 10 }), rep(1, 'u-new', { through: 15 })];
    const banked = new Map([[P, 10]]);
    const at = iso(1 + UNRECEIVED_GRACE_MINUTES + 1);
    expect(unreceivedCandidates({ records: rs, at, banked })).toEqual([]);
    const rs2 = [...rs, rep(3, 'u-new', { through: 15 })];
    const got = unreceivedCandidates({ records: rs2, at: iso(3 + UNRECEIVED_GRACE_MINUTES + 1), banked, replacements: [act(2, 'u-old', 'u-new')] });
    expect(got.map((c) => [c.prefix, c.numbers])).toEqual([[P, [11, 12, 13, 14, 15]]]);
  });
});

describe('OB-98 · the not-checked line, and its acknowledgement', () => {
  it('names exactly which at-risk numbers were not checked (all but the newest 500 across every range)', () => {
    expect(atRiskNotChecked(undefined)).toEqual([]);
    expect(atRiskNotChecked([[1, UNRECEIVED_CHECK_CAP]])).toEqual([]);
    expect(atRiskNotChecked([[101, 700], [1_001, 1_300]])).toEqual([[101, 500]]);
    expect(atRiskNotChecked([[1, 100], [201, 300], [1_001, 1_500]])).toEqual([[1, 100], [201, 300]]);
    expect(atRiskNotChecked([[1_001, 1_300], [101, 700]])).toEqual([[101, 500]]); // out of order: same set
  });

  const big = (min: number, atRisk: [number, number][]): BoxHealthRecord => rep(min, 'u-box', { through: 1_300, atRisk });
  const SET_A: [number, number][] = [[101, 700], [1_001, 1_300]]; // not checked: 101–500 (400)
  const SET_B: [number, number][] = [[51, 700], [1_001, 1_300]]; // not checked: 51–500 (450)
  const ack = (min: number, notChecked: [number, number][]): AtRiskAcknowledgement => ({
    storeId: S, prefix: P, notChecked, count: notChecked.reduce((n, [a, z]) => n + z - a + 1, 0), reason: 'support compared the restore record', by: 'u-ho', at: iso(min),
    authority: 'all_stores',
  });
  const line = (records: readonly BoxHealthRecord[], acks: readonly AtRiskAcknowledgement[], at = iso(100)) =>
    billNumberFindingsFor({ storeId: S, records, at, unreceived: [], atRiskAcknowledged: acks }).filter((f) => f.kind === 'at_risk_not_checked');

  it('the line carries the not-checked ranges and says how it stops', () => {
    const f = line([big(0, SET_A)], []);
    expect(f.map((x) => [x.count, x.ranges])).toEqual([[400, [[101, 500]]]]);
    expect(f[0]!.detail).toMatch(/The acknowledgement holds while the store computer keeps reporting this same set of not-checked numbers; a different set needs a new acknowledgement$/);
  });

  it('an all-stores acknowledgement silences it while the same set is reported; repeats keep it silent', () => {
    const rs = [big(0, SET_A), big(2, SET_A), big(3, SET_A)];
    expect(line(rs, [ack(1, [[101, 500]])])).toEqual([]);
    expect(atRiskAcknowledgementStands(S, P, rs, [ack(1, [[101, 500]])])).toBe(true);
    // Given after the latest report too.
    expect(line(rs, [ack(5, [[101, 500]])])).toEqual([]);
  });

  it('a different set brings it back, and the old set coming back later needs a NEW acknowledgement', () => {
    const rs = [big(0, SET_A), big(2, SET_B)];
    expect(line(rs, [ack(1, [[101, 500]])]).map((x) => x.count)).toEqual([450]);
    const back = [...rs, big(3, SET_A)];
    expect(line(back, [ack(1, [[101, 500]])]).map((x) => x.count)).toEqual([400]);
    expect(line(back, [ack(1, [[101, 500]]), ack(4, [[101, 500]])])).toEqual([]);
    // An empty set in between ends it too.
    const gap = [big(0, SET_A), big(2, [[1_001, 1_300]]), big(3, SET_A)];
    expect(line(gap, [ack(1, [[101, 500]])]).map((x) => x.count)).toEqual([400]);
  });

  it('an acknowledgement of a different set, of another store or prefix, or without all-stores authority is never honoured', () => {
    const rs = [big(0, SET_A)];
    expect(line(rs, [ack(1, [[51, 500]])]).map((x) => x.count)).toEqual([400]);
    expect(line(rs, [{ ...ack(1, [[101, 500]]), storeId: 'S2' }]).map((x) => x.count)).toEqual([400]);
    expect(line(rs, [{ ...ack(1, [[101, 500]]), prefix: 'S1L2-' }]).map((x) => x.count)).toEqual([400]);
    const { authority: _kept, ...noAuthority } = ack(1, [[101, 500]]);
    void _kept;
    expect(line(rs, [noAuthority]).map((x) => x.count)).toEqual([400]);
    // Given before the store computer ever reported that set: it saw nothing, so it holds nothing.
    expect(line([big(2, SET_A)], [ack(1, [[101, 500]])]).map((x) => x.count)).toEqual([400]);
  });
});
