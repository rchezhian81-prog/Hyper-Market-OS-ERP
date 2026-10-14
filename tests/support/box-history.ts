import type {
  BoxHealthRecord, IssuedReport, RefusedIssued, RefusalAcknowledgement, AtRiskAcknowledgement, StoreComputerReplacement, BoxHistoryJudge,
} from '../../services/platform/src/box-health';
import { randomBytes } from 'node:crypto';
import { boxHistorySealKey } from '../../services/platform/src/box-health';

/**
 * Round 30 · OB-111: the key the tests seal the store computers' saved history with — made at run time from random bytes, so
 * no key sits in the repository (a real head office derives its own from PACK_SIGNING_KEY). `OTHER_BOX_HISTORY_KEY` is a
 * second one: a result sealed with it must be set aside.
 */
export const TEST_BOX_HISTORY_KEY = boxHistorySealKey(randomBytes(32).toString('hex'));
export const OTHER_BOX_HISTORY_KEY = boxHistorySealKey(randomBytes(32).toString('hex'));

// Round 28 · OB-104: seeded random store-computer histories, shared by the windowed-read proofs (unit, memory and PostgreSQL).
// Each report carries its store position (`seq`); `commitsLate` marks one whose write is slow to become visible (PostgreSQL
// hands out positions before commit), so a read can see reports above it before it.

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export interface Seeded {
  readonly records: (BoxHealthRecord & { readonly seq: number })[];
  readonly refusalAcks: RefusalAcknowledgement[];
  readonly atRiskAcks: AtRiskAcknowledgement[];
  readonly acts: StoreComputerReplacement[];
  /** The positions whose write commits late: visible only once this many later reports are (PostgreSQL, a slow transaction). */
  readonly commitsLate: ReadonlyMap<number, number>;
}

export const T0 = Date.parse('2026-03-01T00:00:00.000Z');
export const iso = (ms: number): string => new Date(ms).toISOString();
/** A box time written without milliseconds now and then (a different store computer build) — the same moment, other words. */
const noMillis = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

export function history(seed: number): Seeded {
  const rnd = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const records: (BoxHealthRecord & { seq: number })[] = [];
  const refusalAcks: RefusalAcknowledgement[] = [];
  const atRiskAcks: AtRiskAcknowledgement[] = [];
  const acts: StoreComputerReplacement[] = [];
  const commitsLate = new Map<number, number>();
  let t = T0;
  const sold = new Map<string, number>([['A-', 12], ['B-', 8]]);
  const used = new Map<string, number>();
  const risky = new Map<string, boolean>(); // a restored store computer keeps naming the same at-risk numbers for a while
  let prev: (BoxHealthRecord & { seq: number }) | undefined;
  const n = 20 + Math.floor(rnd() * 60);
  for (let i = 0; i < n; i += 1) {
    t += pick([15_000, 15_000, 60_000, 5 * 60_000, 40 * 60_000, 95 * 60_000, 26 * 3_600_000, 3 * 86_400_000]);
    const seq = i + 1;
    // Arrival out of order now and then: a report stamped a little BEFORE the one ahead of it in the store's order.
    const recvMs = rnd() < 0.12 ? t - Math.floor(rnd() * 20 * 60_000) : t;
    const obsMs = rnd() < 0.1 && prev !== undefined ? Date.parse(prev.observedAt) : recvMs - Math.floor(rnd() * 3) * 1000;
    const observedAt = rnd() < 0.15 ? noMillis(Math.floor(obsMs / 1000) * 1000) : iso(obsMs);
    if (rnd() < 0.08) commitsLate.set(seq, 1 + Math.floor(rnd() * 6));
    if (prev !== undefined && rnd() < 0.2) { records.push({ ...prev, observedAt, receivedAt: iso(recvMs), seq }); continue; } // a repeat
    if (prev !== undefined && rnd() < 0.05) {
      // A DIFFERENT report stamped with the same moment as the one before it (kept as its own record — round 13).
      records.push({ ...prev, disk: { ...prev.disk, salesLogUsedBytes: prev.disk.salesLogUsedBytes + 1 }, seq });
      continue;
    }
    const storeId = rnd() < 0.85 ? 'S1' : 'S2';
    const reportedBy = pick(['u-box', 'u-box', 'u-box', 'u-box-2', 'u-box-3']);
    const issued: IssuedReport[] = [];
    let unsentTotal = 0;
    let deadTotal = 0;
    for (const prefix of ['A-', 'B-']) {
      if (rnd() < 0.15) continue;
      if (rnd() < 0.5) sold.set(prefix, sold.get(prefix)! + Math.floor(rnd() * 6));
      const s = sold.get(prefix)!;
      const span = (): { count: number; from: number; to: number } => {
        const from = 1 + Math.floor(rnd() * s);
        const to = Math.min(s, from + Math.floor(rnd() * 6));
        const whole = to - from + 1;
        return { count: rnd() < 0.7 ? whole : Math.max(1, Math.floor(whole / 3)), from, to };
      };
      const shape = pick(['zero', 'list', 'list', 'nolist']);
      const unsent = shape === 'zero' ? { count: 0 } : shape === 'list' ? span() : undefined;
      const dead = rnd() < 0.15 ? span() : rnd() < 0.5 ? { count: 0 } : undefined;
      unsentTotal += unsent?.count ?? 0;
      deadTotal += dead?.count ?? 0;
      issued.push({
        prefix, through: s, soldThrough: s, ...(unsent === undefined ? {} : { unsent }), ...(dead === undefined ? {} : { deadLettered: dead }),
        // More at-risk numbers than the 500 checked per report: the older ones are "not checked" (acknowledgeable).
        ...((() => { if (rnd() < 0.12) risky.set(prefix, !(risky.get(prefix) ?? false)); return risky.get(prefix) === true; })()
          ? { atRisk: [[1, rnd() < 0.15 ? 520 : 700]] as [number, number][] } : {}),
        ...(rnd() < 0.2 ? { unused: [[Math.max(1, s - 3), Math.max(1, s - 2)]] as [number, number][] } : {}),
      } as IssuedReport);
    }
    const refused: RefusedIssued[] = rnd() < 0.25
      ? [pick<RefusedIssued>([
        { prefix: 'C-', through: pick([20_000, 30_000]), because: 'beyond_plausible_advance', bankedThrough: 0, plausibleThrough: 10_000 },
        { prefix: 'D-', through: pick([5, 9]), because: 'prefix_of_another_store', bankedThrough: 0 },
      ])] : [];
    const lie = rnd() < 0.08 ? -1 : 0;
    const queue = { unsent: Math.max(0, unsentTotal + lie + (rnd() < 0.3 ? Math.floor(rnd() * 3) : 0)), deadLettered: Math.max(0, deadTotal + (rnd() < 0.1 ? 1 : 0)) };
    const key = `${storeId}|${reportedBy}`;
    const grown = rnd() < 0.08 ? 10 : (used.get(key) ?? 1000) + Math.floor(rnd() * 5_000);
    used.set(key, grown);
    prev = {
      storeId, observedAt, receivedAt: iso(recvMs), reportedBy, clockAheadCorrected: false,
      tills: rnd() < 0.3 ? [{ laneId: 'L1', reportedAt: observedAt, devices: [{ kind: 'scanner', state: pick(['ok', 'degraded']) }] }] : [],
      disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: grown, salesLogCapacityBytes: 1e9, reserveBytes: 1e6 }, queue,
      receiptNumbersIssued: issued, ...(refused.length === 0 ? {} : { receiptNumbersRefused: refused }),
      ...(rnd() < 0.05 ? { receiptNumbersNotFolded: [{ prefix: 'Z-', through: 3 }] } : {}),
      seq,
    } as BoxHealthRecord & { seq: number };
    records.push(prev);
    // A person acts now and then, some time after the report (acknowledging, or the owner approving a replacement).
    if (rnd() < 0.06 && refused.length > 0) {
      refusalAcks.push({ storeId, prefix: refused[0]!.prefix, through: refused[0]!.through, reason: 'looked', by: 'u-owner', at: iso(recvMs + pick([1, 60_000, 600_000])), ...(rnd() < 0.85 ? { authority: 'all_stores' as const } : {}) });
    }
    if (rnd() < 0.04) {
      // A second store computer's refused word about a bound prefix: acknowledge the count it said.
      refusalAcks.push({ storeId, prefix: 'A-', through: sold.get('A-')!, reason: 'stand-by box', by: 'u-owner', at: iso(recvMs + 30_000), authority: 'all_stores' });
    }
    if (rnd() < 0.06) atRiskAcks.push({ storeId, prefix: pick(['A-', 'B-']), notChecked: [[1, pick([20, 200])]], count: 200, reason: 'support compared', by: 'u-owner', at: iso(recvMs + 45_000), ...(rnd() < 0.9 ? { authority: 'all_stores' as const } : {}) });
    if (rnd() < 0.03) {
      acts.push({ replacementId: `scr-${seed}-${i}`, storeId, prefix: pick(['A-', 'B-']), from: 'u-box', to: pick(['u-box-2', 'u-box-3']), reason: 'replaced', requestedBy: 'u-ho', approvedBy: 'u-owner', approvalId: `ap-${i}`, at: iso(recvMs + 90_000) });
    }
  }
  return { records, refusalAcks, atRiskAcks, acts, commitsLate };
}

/**
 * Round 29 · OB-105: a LONG history — several seeded histories laid end to end in one shop, each starting up to 40 days after
 * the last one ended (months of reports), so the waiting clock's 24-hour memory and the unused runs' 30-day memory are both
 * crossed again and again. Times move by whole seconds, so a box time written without milliseconds stays so.
 */
export function longHistory(seed: number, chunks = 8): Seeded {
  const records: (BoxHealthRecord & { seq: number })[] = [];
  const refusalAcks: RefusalAcknowledgement[] = [];
  const atRiskAcks: AtRiskAcknowledgement[] = [];
  const acts: StoreComputerReplacement[] = [];
  const commitsLate = new Map<number, number>();
  const rnd = rng(seed * 104_729);
  let end = T0;
  for (let c = 0; c < chunks; c += 1) {
    const h = history(seed * 1_000 + c + 1);
    const shift = Math.ceil((end - T0) / 1_000) * 1_000 + (c === 0 ? 0 : 1_000 * Math.floor(1 + rnd() * 40 * 86_400));
    const move = (t: string): string => { const ms = Date.parse(t) + shift; return t.includes('.') ? iso(ms) : iso(ms).replace('.000Z', 'Z'); };
    const base = records.length;
    for (const r of h.records) {
      records.push({
        ...r, seq: r.seq + base, observedAt: move(r.observedAt), receivedAt: move(r.receivedAt),
        tills: r.tills.map((t) => ({ ...t, reportedAt: move(t.reportedAt) })),
      });
    }
    for (const [seq, late] of h.commitsLate) commitsLate.set(seq + base, late);
    for (const a of h.refusalAcks) refusalAcks.push({ ...a, at: move(a.at) });
    for (const a of h.atRiskAcks) atRiskAcks.push({ ...a, at: move(a.at) });
    for (const m of h.acts) acts.push({ ...m, replacementId: `${m.replacementId}-c${c}`, approvalId: `${m.approvalId}-c${c}`, at: move(m.at) });
    end = Math.max(...records.map((r) => Date.parse(r.receivedAt)), ...acts.map((m) => Date.parse(m.at)), ...refusalAcks.map((a) => Date.parse(a.at)), ...atRiskAcks.map((a) => Date.parse(a.at)));
  }
  return { records, refusalAcks, atRiskAcks, acts, commitsLate };
}

/**
 * Round 29 · OB-105 (the verifier's size probe, r28 zz-v28-size): an HONEST busy store — 10 tills, a report every 15 s, each
 * till selling about 1,900 bills a day, each new bill seen "waiting to send" in one report before it goes — for `days` days.
 */
export const HONEST_T0 = Date.parse('2026-03-01T00:00:00.000Z');
export function honestStore(days: number): (BoxHealthRecord & { seq: number })[] {
  const out: (BoxHealthRecord & { seq: number })[] = [];
  const n = Math.round(days * 5_760);
  const sold = Array.from({ length: 10 }, () => 100);
  for (let i = 0; i < n; i += 1) {
    const at = iso(HONEST_T0 + i * 15_000);
    let unsentTotal = 0;
    const issued = sold.map((s, k) => {
      const grow = (i * 7 + k) % 3 === 0 ? 1 : 0;
      sold[k] = s + grow;
      unsentTotal += grow;
      return { prefix: `S1L${k}-`, through: sold[k]!, soldThrough: sold[k]!, unsent: grow === 1 ? { count: 1, from: sold[k]!, to: sold[k]! } : { count: 0 } } as IssuedReport;
    });
    out.push({
      storeId: 'S1', observedAt: at, receivedAt: at, reportedBy: 'u-box', clockAheadCorrected: false, tills: [],
      disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000 + i, salesLogCapacityBytes: 1e9, reserveBytes: 1e6 },
      queue: { unsent: unsentTotal, deadLettered: 0 }, receiptNumbersIssued: issued, seq: i + 1,
    } as BoxHealthRecord & { seq: number });
  }
  return out;
}

/** Judged at read, as head office does (`judgeReportedIssued`'s two questions) — the verdicts can change between reads. */
export function judged(r: BoxHealthRecord, judge: BoxHistoryJudge): BoxHealthRecord {
  const issued = r.receiptNumbersIssued;
  if (issued === undefined) return r;
  const accepted = issued.filter((x) => judge.owns(r.storeId, x.prefix) && judge.plausible(x.prefix, x.through));
  return accepted.length === issued.length ? r : { ...r, receiptNumbersIssued: accepted };
}
