import { describe, it, expect } from 'vitest';
import { InMemoryEventStore, type EventStore, type ReadOptions } from '../../packages/persistence/src/event-store';
import type { Snapshot, SnapshotStore } from '../../packages/persistence/src/snapshot';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName, storeComputerHistory } from '../../services/api/src/adapters';
import { judgeBoxes, type BoxHealthRecord } from '../../services/platform/src/box-health';
import { DEFAULT_THRESHOLDS } from '../../packages/ops/src/index';

/**
 * **Round 28 · OB-104 "A" (owner, 13 Oct 2026, in writing, "Before the pilot") — a health read no longer reads every
 * store-computer report ever kept.**
 *
 * The verifier's altered store computer (round 26/27's shape): 10 till prefixes, every report naming 50 at-risk ranges at
 * random offsets and 50 unused ranges that shift, its queue flag flipping, its sales log growing — every minute for a MONTH
 * (43,200 reports). Before this round each health read and each alert pass took every one of them from the store and worked
 * the findings, the waiting clock, the store's latest report and its disk out of all of them. Now the box history's saved
 * running result carries all of that, and a read takes only the reports after it.
 *
 * THE BOUND (firm): after the first read ever (which folds the month once and saves the result — reported, not the bound),
 * a whole health read — the store-computer reading AND the store's health judged from it (`judgeBoxes`) — takes under 1 s,
 * reading at most 2 × FOLD_SNAPSHOT_EVERY box-health rows from the store (counted at the store, not timed). The saved
 * result goes through JSON on every load and save here, as it does on PostgreSQL (`projection_snapshot`), so its size and
 * parse are in the timing. Each answer is checked against the first read's (the full fold of the month).
 */

const TILLS = 10;
const EVERY_MS = 60_000;
const MONTH = 30 * 24 * 60; // one report a minute for 30 days
const t0 = Date.parse('2026-01-05T00:00:00.000Z');
const T = 'tenant-perf-ob104';
const BOX_HEALTH_STREAM = streamName(STREAM.org, 'store-computer-health');
const pad = (n: number): string => String(n).padStart(6, '0');

/** The altered shape; the 400 possible range lists are made once and shared (memory), as a store computer would repeat them. */
function altered(i: number, rnd: () => number, lists: Map<number, { atRisk: [number, number][]; unused: [number, number][] }>): BoxHealthRecord {
  const at = new Date(t0 + i * EVERY_MS).toISOString();
  const off = Math.floor(rnd() * 400);
  let l = lists.get(off);
  if (l === undefined) {
    l = {
      atRisk: Array.from({ length: 50 }, (_, j) => [j * 1000 + 1 + off, j * 1000 + 500 + off]),
      unused: Array.from({ length: 50 }, (_, j) => [59_000 + j * 20 + 1 + (off % 9), 59_000 + j * 20 + 10 + (off % 9)]),
    };
    lists.set(off, l);
  }
  return {
    storeId: 'S1', observedAt: at, receivedAt: at, reportedBy: 'u-box', clockAheadCorrected: false, tills: [],
    disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1_000 + i * 50, salesLogCapacityBytes: 1e9, reserveBytes: 1e6 },
    queue: { unsent: i % 2, deadLettered: 0 },
    receiptNumbersIssued: Array.from({ length: TILLS }, (_, k) => ({ prefix: `S1L${k}-`, through: 60_000, soldThrough: 60_000, unsent: { count: 0 }, atRisk: l!.atRisk, unused: l!.unused })),
  } as BoxHealthRecord;
}

/** A snapshot store that keeps each saved result as JSON text, as PostgreSQL's jsonb does (parse and size included). */
class JsonSnapshotStore implements SnapshotStore {
  readonly texts = new Map<string, string>();
  load<S>(tenantId: string, stream: string, projection: string): Promise<Snapshot<S> | undefined> {
    const t = this.texts.get(`${tenantId}|${stream}|${projection}`);
    return Promise.resolve(t === undefined ? undefined : JSON.parse(t) as Snapshot<S>);
  }
  save<S>(s: Snapshot<S>): Promise<void> {
    this.texts.set(`${s.tenantId}|${s.stream}|${s.projection}`, JSON.stringify(s));
    return Promise.resolve();
  }
}

function counted(inner: EventStore): { store: EventStore; rows: () => number; reset: () => void } {
  let rows = 0;
  const store = new Proxy(inner, {
    get: (target, prop, receiver) => {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== 'function') return v;
      if (prop !== 'readStream') return (v as (...a: unknown[]) => unknown).bind(target);
      return async (tenantId: string, stream: string, opts?: ReadOptions) => {
        const out = await (v as EventStore['readStream']).call(target, tenantId, stream, opts);
        if (stream === BOX_HEALTH_STREAM) rows += out.length;
        return out;
      };
    },
  }) as EventStore;
  return { store, rows: () => rows, reset: () => { rows = 0; } };
}

async function append(store: EventStore, from: number, to: number, rnd: () => number, lists: Map<number, { atRisk: [number, number][]; unused: [number, number][] }>): Promise<void> {
  for (let i = from; i < to; i += 1_000) {
    await store.appendBatch(T, Array.from({ length: Math.min(1_000, to - i) }, (_, k) => {
      const r = altered(i + k, rnd, lists);
      return { stream: BOX_HEALTH_STREAM, event: makeEvent({ id: `bh-${i + k}`, type: 'StoreComputerHealthReported', occurredAt: r.receivedAt, idempotencyKey: `bh-${T}-${i + k}`, source: 'perf/ob104', payload: r }) };
    }));
  }
}

const timedAsync = async <X>(f: () => Promise<X>): Promise<{ value: X; ms: number }> => {
  const s = performance.now();
  const value = await f();
  return { value, ms: performance.now() - s };
};

describe('round 28 · OB-104: a health read takes only the store-computer reports after its saved result', () => {
  it('a MONTH of the verifier\'s altered reports (10 tills, 50 at-risk + 50 unused ranges, every minute): under 1 s per read after the first', async () => {
    let s = 7;
    const rnd = (): number => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const lists = new Map<number, { atRisk: [number, number][]; unused: [number, number][] }>();
    const base = new InMemoryEventStore();
    // Head office issued the ten prefixes to store S1's tills and banked their first 100 bills each, and bill 55,000 (so the
    // store computer's count of 60,000 is within the plausible advance and judged its own — as it would be at arrival).
    await base.appendBatch(T, Array.from({ length: TILLS }, (_, k) => ({ stream: streamName(STREAM.org, 'till-receipt-prefixes'), event: makeEvent({
      id: `pfx-${k}`, type: 'TillReceiptPrefixIssued', occurredAt: new Date(t0 - 86_400_000).toISOString(), idempotencyKey: `pfx-${T}-${k}`, source: 'perf/ob104',
      payload: { storeId: 'S1', tillId: `lane-${k}`, prefix: `S1L${k}-`, version: 1, setAt: new Date(t0 - 86_400_000).toISOString(), setBy: 'u-owner' },
    }) })));
    for (let k = 0; k < TILLS; k += 1) {
      await base.appendBatch(T, [...Array.from({ length: 100 }, (_, n) => n + 1), 55_000].map((n) => ({ stream: STREAM.sales, event: makeEvent({
        id: `receipt-S1L${k}-${pad(n)}`, type: 'ReceiptNumberIssued', occurredAt: new Date(t0 - 3_600_000).toISOString(), idempotencyKey: `receipt-${T}-S1L${k}-${pad(n)}`, source: 'perf/ob104',
        payload: { receiptNumber: `S1L${k}-${pad(n)}`, saleId: `S-${k}-${n}` },
      }) })));
    }
    await append(base, 0, MONTH, rnd, lists);
    const { store, rows, reset } = counted(base);
    const snaps = new JsonSnapshotStore();
    // Round 29 · OB-106: a month is far above BOX_HISTORY_INLINE_MAX, so its first build runs in the background (in steps);
    // the first read here waits for it (a health read would answer "being prepared" meanwhile).
    const opts = { snapshots: snaps, timeZone: 'UTC', waitMs: Infinity };
    const health = async (at: string) => {
      const reading = await storeComputerHistory(store, T, at, opts);
      const boxes = judgeBoxes({ records: [], view: reading.view, at, thresholds: DEFAULT_THRESHOLDS, billNumberFindings: reading.findings, bindings: reading.bindings, unusedNumbers: reading.unused });
      return { reading, boxes };
    };
    // The first read ever: folds the month once and saves the result (reported — the one-off build).
    let lastMs = t0 + (MONTH - 1) * EVERY_MS;
    const first = await timedAsync(() => health(new Date(lastMs + EVERY_MS).toISOString()));
    const firstRows = rows();
    expect(first.value.reading.preparing).toBeUndefined();
    expect(firstRows).toBeGreaterThanOrEqual(MONTH); // the build's one full read, then the read's own window
    expect(firstRows).toBeLessThanOrEqual(MONTH + 2 * 64);
    const savedBytes = [...snaps.texts.values()].reduce((n, t) => n + t.length, 0);
    // The next reads, a minute apart, each after the store computer's next report — the alert worker's steady state.
    const times: number[] = [];
    const read: number[] = [];
    let last = first.value;
    for (let k = 0; k < 5; k += 1) {
      await append(base, MONTH + k, MONTH + k + 1, rnd, lists);
      lastMs += EVERY_MS;
      reset();
      const next = await timedAsync(() => health(new Date(lastMs + EVERY_MS).toISOString()));
      times.push(next.ms);
      read.push(rows());
      expect(next.value.reading.resumed).toBe(true);
      last = next.value;
    }
    console.log(`[OB-104] a month (${MONTH} reports, every minute): first read ever ${first.ms.toFixed(0)} ms over ${firstRows} rows (one-off, builds the saved result of ${(savedBytes / 1024).toFixed(0)} KB as JSON); `
      + `the next reads ${times.map((t) => t.toFixed(0)).join(', ')} ms over ${read.join(', ')} rows`);
    // The answers stay the month's: the newest 500 per till named, the unused numbers shown, the disk estimated.
    const box = last.boxes.boxes[0]!;
    expect((box.billNumberFindings ?? []).filter((f) => f.kind === 'at_risk_not_checked')).toHaveLength(TILLS);
    expect(box.unusedNumbers?.length).toBeGreaterThan(0);
    expect(box.tradingHoursLeft).not.toBeNull();
    expect(last.reading.findings).toEqual((await storeComputerHistory(base, T, new Date(lastMs + EVERY_MS).toISOString(), { snapshots: new JsonSnapshotStore(), timeZone: 'UTC', waitMs: Infinity })).findings);
    for (const t of times.slice(1)) expect(t, `a read took ${t.toFixed(0)} ms`).toBeLessThan(1_000);
    for (const n of read) expect(n).toBeLessThanOrEqual(128);
  }, 900_000);
});
