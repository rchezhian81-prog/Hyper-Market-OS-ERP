import { describe, it, expect } from 'vitest';
import { readBoxHistory, readBoxHistoryInSteps, type BoxHealthRecord, type BoxHistoryEntry } from '../../services/platform/src/box-health';
import { TEST_BOX_HISTORY_KEY } from '../support/box-history';

/**
 * **Round 30 · owner decision OB-110 "A" (14 Oct 2026, in writing, "Fix before pilot"; verifier r29 NEW-2, probes P6 and P7) —
 * a bill stuck on the store computer for days, while the store keeps trading, keeps the saved store-computer history small
 * and its build quick.**
 *
 * THE SHAPES (the verifier's, exactly): a report every 15 s; a till sells a bill every third report; one bill (number 50) is
 * stuck, so an honest store computer lists [50, newest] whenever a new bill is waiting and [50, 50] otherwise.
 *   P6 — one till, for 7, 14 and 30 days (before round 30: 1.7 s / 10.7 s / 59 s to build; 0.94 / 1.28 / 2.07 MB);
 *   P7 — ten tills, each with one stuck bill, for 7 days, built in steps as head office builds it in the background (before
 *        round 30: 38 s, with 2.1 s without a pause; 3.83 MB).
 *   P4 — (OB-112) a store computer naming 200 new prefixes that are not its store's in every report, for 200 minutes
 *        (before round 30: 55.69 MB).
 *
 * THE BOUNDS (firm): every build under 3 s; the event loop never held for 200 ms or more while P7 builds; every saved result
 * under 1 MB (the waiting clock keeps at most WAIT_RANGES_MAX ranges per till; what remains is mostly the store computer's
 * disk points for its 7-day estimate, the same for an honest store); and the size does not grow from 7 to 30 days.
 */

const t0 = Date.parse('2026-03-01T08:00:00.000Z');
const iso = (ms: number): string => new Date(t0 + ms).toISOString();
const DISK = { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1, salesLogCapacityBytes: 1e7, reserveBytes: 1 };
const DAY = 5_760;

function stuckTills(n: number, tills: number): BoxHistoryEntry[] {
  const out: BoxHistoryEntry[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    let unsent = 0;
    const issued = Array.from({ length: tills }, (_, k) => {
      const through = 100 + Math.floor((i + k) / 3);
      const fresh = (i + k) % 3 === 0;
      unsent += fresh ? 2 : 1;
      return { prefix: tills === 1 ? 'A-' : `L${k}-`, through, soldThrough: through, unsent: fresh ? { count: 2, from: 50, to: through } : { count: 1, from: 50, to: 50 } };
    });
    const raw = {
      storeId: 'S1', observedAt: iso(i * 15_000), receivedAt: iso(i * 15_000), reportedBy: 'u-box', clockAheadCorrected: false, tills: [], disk: DISK,
      queue: { unsent, deadLettered: 0 }, receiptNumbersIssued: issued,
    } as unknown as BoxHealthRecord;
    out[i] = { raw, judged: raw, seq: i + 1 };
  }
  return out;
}

describe('round 30 · OB-110/112: a stuck bill (or a flood of refused prefixes) keeps the saved history small and quick', () => {
  it('P6: one till with a stuck bill for 7, 14 and 30 days — each build under 3 s, the saved result under 1 MB and not growing', () => {
    const sizes = new Map<number, number>();
    const times = new Map<number, number>();
    for (const days of [7, 14, 30]) {
      const n = DAY * days;
      const all = stuckTills(n, 1);
      const s = performance.now();
      const r = readBoxHistory({ sealKey: TEST_BOX_HISTORY_KEY, entries: all, at: iso(n * 15_000 + 30 * 60_000), banked: new Map([['A-', 100 + n]]), settleBefore: iso(n * 15_000 + 20 * 60_000), settledThrough: n });
      times.set(days, performance.now() - s);
      if ('setAside' in r) throw new Error(r.setAside);
      sizes.set(days, r.snapshot!.sizeBytes);
    }
    console.log(`[OB-110] P6 one till, stuck bill: ${[...sizes].map(([d, b]) => `${d} days ${(b / 1_048_576).toFixed(2)} MB in ${times.get(d)!.toFixed(0)} ms`).join('; ')} — before round 30: 0.94 / 1.28 / 2.07 MB, 1.7 / 10.7 / 59 s`);
    for (const d of [7, 14, 30]) {
      expect(times.get(d)!, `${d} days`).toBeLessThan(3_000);
      expect(sizes.get(d)!, `${d} days`).toBeLessThan(1_048_576);
    }
    expect(sizes.get(30)!).toBeLessThan(sizes.get(7)! * 1.01);
  }, 300_000);

  it('P7: ten tills, one stuck bill each, for 7 days, built in steps — under 3 s, never holding the event loop for 200 ms, under 1 MB', async () => {
    const n = DAY * 7;
    const all = stuckTills(n, 10);
    const banked = new Map(Array.from({ length: 10 }, (_, k) => [`L${k}-`, 100 + n] as [string, number]));
    let worst = 0;
    let prev = performance.now();
    const tick = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - prev); prev = now; }, 2);
    try {
      const s = performance.now();
      prev = s;
      const r = await readBoxHistoryInSteps({ sealKey: TEST_BOX_HISTORY_KEY, entries: all, at: iso(n * 15_000 + 30 * 60_000), banked, settleBefore: iso(n * 15_000 + 20 * 60_000), settledThrough: n });
      const ms = performance.now() - s;
      if ('setAside' in r) throw new Error(r.setAside);
      console.log(`[OB-110] P7 ten tills, a stuck bill each, 7 days (${n} reports): built in ${ms.toFixed(0)} ms, longest event-loop pause ${worst.toFixed(0)} ms, saved ${(r.snapshot!.sizeBytes / 1_048_576).toFixed(2)} MB — before round 30: 38 s, 2.1 s, 3.83 MB`);
      expect(ms).toBeLessThan(3_000);
      expect(worst).toBeLessThan(200);
      expect(r.snapshot!.sizeBytes).toBeLessThan(1_048_576);
    } finally {
      clearInterval(tick);
    }
  }, 300_000);

  it('P4: a store computer naming 200 new prefixes that are not its store\'s in every report for 200 minutes — under 100 KB, built in under 1 s', () => {
    const n = 800;
    const all: BoxHistoryEntry[] = Array.from({ length: n }, (_, i) => {
      const raw = {
        storeId: 'S1', observedAt: iso(i * 15_000), receivedAt: iso(i * 15_000), reportedBy: 'u-box', clockAheadCorrected: false, tills: [], disk: DISK,
        queue: { unsent: 0, deadLettered: 0 }, receiptNumbersIssued: [{ prefix: 'A-', through: 100, soldThrough: 100, unsent: { count: 0 } }],
        receiptNumbersRefused: Array.from({ length: 200 }, (_, k) => ({ prefix: `Z${i}x${k}-`, through: 5, because: 'prefix_of_another_store', bankedThrough: 0 })),
      } as unknown as BoxHealthRecord;
      return { raw, judged: raw, seq: i + 1 };
    });
    const s = performance.now();
    const r = readBoxHistory({ sealKey: TEST_BOX_HISTORY_KEY, entries: all, at: iso(n * 15_000 + 30 * 60_000), banked: new Map([['A-', 100]]), settleBefore: iso(n * 15_000 + 20 * 60_000), settledThrough: n });
    const ms = performance.now() - s;
    if ('setAside' in r) throw new Error(r.setAside);
    console.log(`[OB-112] P4 200 new refused prefixes per report for 200 min: saved ${(r.snapshot!.sizeBytes / 1024).toFixed(1)} KB in ${ms.toFixed(0)} ms — before round 30: 55.69 MB`);
    expect(r.snapshot!.sizeBytes).toBeLessThan(100 * 1024);
    expect(ms).toBeLessThan(1_000);
  }, 300_000);
});
