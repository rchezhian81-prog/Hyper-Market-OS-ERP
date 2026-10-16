import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InMemoryEventStore, type EventStore, type ReadOptions, type PersistedEvent } from '../../packages/persistence/src/event-store';
import { InMemorySnapshotStore, type Snapshot } from '../../packages/persistence/src/snapshot';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName, storeComputerHistory, boxHistoryHeldCount, foldedMore } from '../../services/api/src/adapters';
import type { BoxHealthRecord } from '../../services/platform/src/box-health';
import { honestStore, TEST_BOX_HISTORY_KEY, iso } from '../support/box-history';

/**
 * **Round 39 · M35-FR-03 · OB-106 · verifier r37 L4 — a NEWER result a parallel read held BEFORE an older save began is never
 * dropped (memory, gated read and gated save).**
 *
 * Round 37 kept a newer result held WHILE a save was under way, by comparing with what was held when the save began. When a
 * parallel read had already held the newer result before an older one's save began, that comparison matched it, and the end of
 * the older save dropped the newer result unsaved (the next read folded those reports again — extra work, never a wrong
 * answer). Now a held result is dropped only when the saved one folded at least as many reports (`foldedMore`), and an older
 * unsaved result never replaces a newer held one.
 *
 *   1. a small shop's first reports are folded while saving is held back (an open transaction): result X is held;
 *   2. 200 more reports; the fence settles; read A starts — it reads its window and is held at a gate there;
 *   3. saving is held back again; 200 more reports; read B folds all 400 onto X and holds the NEWER result Y;
 *   4. A goes on: it folds only its 200 (result S, older than Y) and saves it — its save held at a gate, then let go;
 *   5. Y is still held (round 37: dropped), and once the fence settles it is the result saved.
 */

const BOX = streamName(STREAM.org, 'store-computer-health');
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const plain = (r: BoxHealthRecord & { seq?: number }): BoxHealthRecord => { const { seq: _s, ...rest } = r; void _s; return rest as BoxHealthRecord; };
async function put(store: EventStore, T: string, records: readonly BoxHealthRecord[], from: number): Promise<void> {
  await store.appendBatch(T, records.map((r, j) => ({
    stream: BOX,
    event: makeEvent({ id: `bh-${from + j}`, type: 'StoreComputerHealthReported', occurredAt: r.receivedAt, idempotencyKey: `bh-${T}-${from + j}`, source: 'test/r39', payload: r }),
  })));
}

/** The visibility fence held back or settled at will; the next window read of the box reports held at a gate when armed. */
class GatedReadStore extends InMemoryEventStore {
  hold = true;
  gate: Promise<void> | undefined;
  waitingAtGate = false;
  override fenceSettled(): Promise<boolean> { return Promise.resolve(!this.hold); }
  override async readStream(tenantId: string, stream: string, opts?: ReadOptions): Promise<readonly PersistedEvent[]> {
    const read = await super.readStream(tenantId, stream, opts);
    const gate = this.gate;
    if (gate !== undefined && stream === BOX && opts?.sinceSeq !== undefined) {
      this.gate = undefined; // one read only
      this.waitingAtGate = true;
      await gate;
    }
    return read;
  }
}
/** Saves held at a gate when armed (a slow database), each saved result's count of folded reports kept. */
class GatedSnapshots extends InMemorySnapshotStore {
  gate: Promise<void> | undefined;
  waiting = false;
  savedCounts: number[] = [];
  override async save<S>(s: Snapshot<S>): Promise<void> {
    if (this.gate !== undefined) { this.waiting = true; await this.gate; }
    this.savedCounts.push((s.result as { eventCount: number }).eventCount);
    return super.save<S>(s);
  }
}
const until = async (ok: () => boolean): Promise<void> => { for (let i = 0; i < 500 && !ok(); i += 1) await sleep(10); };

describe('round 39 · M35-FR-03 · OB-106 · verifier r37 L4: a newer result held before an older save began is never dropped (memory)', () => {
  it('M35-FR-03 OB-106 L4: read B holds Y (400 more reports) before read A saves its older S (200) — Y stays held and is saved next', async () => {
    const store = new GatedReadStore();
    const snaps = new GatedSnapshots();
    const T = randomUUID();
    const all = honestStore(900 / 5_760).map(plain);
    const first = all.slice(0, 300);
    const later = all.slice(300, 500);
    const more = all.slice(500);
    // Each read a minute after its newest report (the reports after them are then never "late" for the result it makes; the
    // newest ten minutes of reports are not settled yet and are folded by a later read).
    const after = (r: readonly BoxHealthRecord[]): string => iso(Date.parse(r.at(-1)!.receivedAt) + 60_000);
    const read = (at: string) => storeComputerHistory(store, T, at, { sealKey: TEST_BOX_HISTORY_KEY, snapshots: snaps, timeZone: 'UTC', waitMs: 0 });

    // 1. Folded while saving is held back: X is held, nothing saved.
    await put(store, T, first, 0);
    await read(after(first));
    const x = boxHistoryHeldCount(snaps, T);
    expect(x).toBeGreaterThan(0);
    expect(snaps.savedCounts).toEqual([]);

    // 2. 200 more; the fence settles; read A reads its window and waits at the gate.
    await put(store, T, later, first.length);
    store.hold = false;
    let openRead: () => void = () => undefined;
    store.gate = new Promise<void>((r) => { openRead = r; });
    const a = read(after(later));
    await until(() => store.waitingAtGate);
    expect(store.waitingAtGate).toBe(true);

    // 3. Saving held back again; 200 more; read B folds all 400 onto X — the NEWER result Y is held.
    store.hold = true;
    await put(store, T, more, first.length + later.length);
    const b = await read(after(more));
    expect(b.setAside).toBeUndefined();
    expect(b.resumed).toBe(true);
    const y = boxHistoryHeldCount(snaps, T)!;
    expect(y).toBeGreaterThan(x! + later.length); // folded reports of `more` too

    // 4. A goes on with only its 200: it saves the OLDER result S — its save held at a gate (Y was held before it began).
    let openSave: () => void = () => undefined;
    snaps.gate = new Promise<void>((r) => { openSave = r; });
    openRead();
    await until(() => snaps.waiting);
    expect(snaps.waiting).toBe(true);
    expect(boxHistoryHeldCount(snaps, T)).toBe(y); // Y held all along
    snaps.gate = undefined;
    openSave();
    await a;
    expect(snaps.savedCounts).toHaveLength(1); // S …
    const s = snaps.savedCounts[0]!;
    expect(s).toBeGreaterThan(x!);
    expect(s).toBeLessThan(y); // … older than Y
    expect(foldedMore({ ord: y }, { ord: s })).toBe(true);

    // 5. Round 37: the end of S's save dropped Y (held: nothing). Now Y is still held …
    expect(boxHistoryHeldCount(snaps, T)).toBe(y);
    // … and once the fence settles, the next read saves Y itself (nothing folded again).
    store.hold = false;
    const next = await read(after(more));
    expect(next.resumed).toBe(true);
    expect(snaps.savedCounts).toEqual([s, y]);
    expect(boxHistoryHeldCount(snaps, T)).toBeUndefined();
  }, 120_000);

  it('M35-FR-03 OB-106 L4: an older unsaved result never replaces a newer held one; a saved one that folded as much drops it', () => {
    expect(foldedMore({ ord: 900 }, { ord: 500 })).toBe(true);
    expect(foldedMore({ ord: 500 }, { ord: 500 })).toBe(false);
    expect(foldedMore({ ord: 300 }, { ord: 500 })).toBe(false);
  });
});
