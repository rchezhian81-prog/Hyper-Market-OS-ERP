import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { InMemorySnapshotStore } from '../../packages/persistence/src/snapshot';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName, storeComputerHistory, boxHistoryBuilding } from '../../services/api/src/adapters';
import { readBoxHistory, FOLD_SETTLE_MINUTES, type BoxHealthRecord, type BoxHistorySnapshot, type BoxHistoryJudge } from '../../services/platform/src/box-health';
import { honestStore, TEST_BOX_HISTORY_KEY } from '../support/box-history';

/**
 * **Round 29 · owner decisions OB-105 and OB-106 "A" (14 Oct 2026, in writing) — the saved store-computer history stays small for
 * an honest busy store over months, and building it never freezes head office.**
 *
 * THE SHOP (the verifier's size probe, r28): 10 tills, a report every 15 s, each till selling about 1,900 bills a day, each
 * new bill seen "waiting to send" in one report before it goes; head office banks every bill within two minutes.
 *
 * THE BOUNDS (firm):
 *   1. the saved result stays under 2 MB after 30 days AND after 90 days (before round 29: 0.80 MB after a day, 5.68 MB after
 *      a week, 22.95 MB after a month — growing for ever), and reading it back (JSON.parse, every health read) takes under
 *      50 ms; a resumed read of a quarter hour's reports takes under 250 ms;
 *   2. while a big store's history is built in the background (two weeks, 80,640 reports), the process keeps answering: the
 *      longest pause of the event loop stays under 200 ms, and a readiness request made during the build is answered in
 *      under 250 ms (the synchronous build it replaced held the process for the whole fold).
 */

const T = 'tenant-perf-r29';
const BOX = streamName(STREAM.org, 'store-computer-health');
const judge: BoxHistoryJudge = { owns: () => true, plausible: () => true };
const iso = (ms: number): string => new Date(ms).toISOString();
const plain = (r: BoxHealthRecord & { seq?: number }): BoxHealthRecord => { const { seq: _s, ...rest } = r; void _s; return rest as BoxHealthRecord; };

describe('round 29 · OB-105/106: the saved store-computer history stays small, and builds without freezing', () => {
  it('an honest busy store for 30 and 90 days: the saved result stays under 2 MB, read back in under 50 ms', () => {
    const DAY = 5_760;
    const days = 90;
    const all = honestStore(1); // one day's shape; each later day is the same shape, its numbers and times moved on
    let snapshot: BoxHistorySnapshot | undefined;
    const banked = new Map<string, number>();
    const sizes = new Map<number, { bytes: number; parseMs: number; readMs: number }>();
    let seq = 0;
    for (let d = 0; d < days; d += 1) {
      const shiftMs = d * 86_400_000;
      const shiftN = d * 1_920;
      const entries = all.map((r) => {
        seq += 1;
        const at = iso(Date.parse(r.receivedAt) + shiftMs);
        const raw = {
          ...plain(r), observedAt: at, receivedAt: at, disk: { ...r.disk, salesLogUsedBytes: r.disk.salesLogUsedBytes + d * DAY },
          receiptNumbersIssued: (r.receiptNumbersIssued ?? []).map((x) => ({ ...x, through: x.through + shiftN, soldThrough: (x.soldThrough ?? x.through) + shiftN, ...(x.unsent?.from === undefined ? {} : { unsent: { count: 1, from: x.unsent.from + shiftN, to: x.unsent.to! + shiftN } }) })),
        } as BoxHealthRecord;
        return { raw, judged: raw, seq };
      });
      // One read for most of the day (catching up), then a read every quarter hour for the last two hours of the measured
      // days (the last read's window is what a health read folds in steady state).
      const measured = [1, 7, 30, 90].includes(d + 1);
      const stops = measured ? [DAY - 480, ...Array.from({ length: 8 }, (_, j) => DAY - 420 + j * 60)] : [DAY];
      for (const k of stops) {
        const last = Date.parse(entries[k - 1]!.raw.receivedAt);
        const at = iso(last + 30_000);
        const window = entries.slice(0, k).filter((e) => snapshot === undefined || e.seq > snapshot.seq);
        for (const e of entries.slice(0, k)) if (Date.parse(e.raw.receivedAt) <= last - 120_000) for (const x of e.raw.receiptNumbersIssued ?? []) banked.set(x.prefix, x.through);
        const s = performance.now();
        const got = readBoxHistory({ sealKey: TEST_BOX_HISTORY_KEY, entries: window, ...(snapshot === undefined ? {} : { snapshot }), at, banked, judge, timeZone: 'UTC', settleBefore: iso(Date.parse(at) - FOLD_SETTLE_MINUTES * 60_000), settledThrough: seq - DAY + k });
        const readMs = performance.now() - s;
        if ('setAside' in got) throw new Error(`set aside on day ${d}: ${got.setAside}`);
        // The saved result goes through JSON, as it does on PostgreSQL (kept as its text).
        if (got.snapshot !== undefined) snapshot = JSON.parse(JSON.stringify(got.snapshot)) as BoxHistorySnapshot;
        if (k === DAY && measured) {
          const text = JSON.stringify(snapshot);
          const p = performance.now();
          JSON.parse(text);
          sizes.set(d + 1, { bytes: text.length, parseMs: performance.now() - p, readMs });
        }
      }
    }
    console.log(`[OB-105] honest busy store, saved result: ${[...sizes].map(([d, x]) => `${d} day(s) ${(x.bytes / 1_048_576).toFixed(2)} MB (parse ${x.parseMs.toFixed(1)} ms, resumed read ${x.readMs.toFixed(0)} ms)`).join('; ')} — before round 29: 0.80 MB / 5.68 MB / 22.95 MB at 1 / 7 / 30 days`);
    for (const d of [30, 90]) {
      const x = sizes.get(d)!;
      expect(x.bytes, `${d} days`).toBeLessThan(2 * 1_048_576);
      expect(x.parseMs, `${d} days`).toBeLessThan(50);
      expect(x.readMs, `${d} days`).toBeLessThan(250);
    }
    // Bounded, not merely slow-growing: 90 days is no bigger than 30 days (give or take a percent).
    expect(sizes.get(90)!.bytes).toBeLessThan(sizes.get(30)!.bytes * 1.01);
  }, 900_000);

  it('a background build of two weeks of reports never holds the process: the event loop keeps turning, readiness answers', async () => {
    const store = new InMemoryEventStore();
    const records = honestStore(14).map(plain);
    for (let i = 0; i < records.length; i += 2_000) {
      await store.appendBatch(T, records.slice(i, i + 2_000).map((r, j) => ({ stream: BOX, event: makeEvent({ id: `bh-${i + j}`, type: 'StoreComputerHealthReported', occurredAt: r.receivedAt, idempotencyKey: `bh-${T}-${i + j}`, source: 'perf/r29', payload: r }) })));
    }
    const snapshots = new InMemorySnapshotStore();
    // The readiness check, served while the build runs.
    const server = createServer((_req, res) => { res.writeHead(200).end('ready'); });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as AddressInfo).port;
    let worst = 0;
    let prev = performance.now();
    const tick = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - prev); prev = now; }, 2);
    try {
      const at = iso(Date.parse(records[records.length - 1]!.receivedAt) + 60_000);
      const started = performance.now();
      const first = await storeComputerHistory(store, T, at, { sealKey: TEST_BOX_HISTORY_KEY, snapshots, timeZone: 'UTC', waitMs: 0 });
      expect(first.preparing).toBeDefined();
      const building = boxHistoryBuilding(snapshots, T)!;
      const ready: number[] = [];
      let done = false;
      void building.then(() => { done = true; });
      while (!done) {
        const s = performance.now();
        const r = await fetch(`http://127.0.0.1:${port}/ready`);
        expect(r.status).toBe(200);
        ready.push(performance.now() - s);
        await new Promise((resolve) => { setTimeout(resolve, 50); });
      }
      const buildMs = performance.now() - started;
      const after = await storeComputerHistory(store, T, at, { sealKey: TEST_BOX_HISTORY_KEY, snapshots, timeZone: 'UTC', waitMs: 0 });
      expect(after.preparing).toBeUndefined();
      console.log(`[OB-106] background build of ${records.length} reports: ${buildMs.toFixed(0)} ms; longest event-loop pause ${worst.toFixed(0)} ms; ${ready.length} readiness answers during it, slowest ${Math.max(...ready).toFixed(0)} ms; saved ${(after.history.sizeBytes! / 1024).toFixed(0)} KB`);
      expect(ready.length).toBeGreaterThan(2);
      expect(Math.max(...ready)).toBeLessThan(250);
      expect(worst).toBeLessThan(200);
    } finally {
      clearInterval(tick);
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  }, 900_000);
});
