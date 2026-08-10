import { describe, it, expect } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import type { EventStore, ReadOptions } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import {
  InMemorySnapshotStore, projectFromSnapshot, runProjection,
  type Projection,
} from '../../packages/persistence/src/index';

// CORE-03 inc1: a snapshot is the folded state at a watermark, so a read folds only the events SINCE
// it. The load-bearing property is that this is EQUIVALENT to a full fold — a snapshot that
// disagrees with the events turns a performance feature into a correctness bug — and that snapshots
// are DERIVED and DISPOSABLE: delete them and the next read rebuilds the same model from the ledger.

const TENANT = '11111111-1111-4111-8111-111111111111';
const STREAM = 'meter';

/** A trivial projection: the running sum of a numeric payload. */
const SUM: Projection<number> = { initial: 0, apply: (s, e) => s + (e.payload as { n: number }).n };

const at = (i: number): string => new Date(Date.UTC(2026, 7, 10, 0, 0, 0, 0) + i * 1000).toISOString();

async function meterWith(ns: readonly number[]): Promise<InMemoryEventStore> {
  const store = new InMemoryEventStore();
  for (const [i, n] of ns.entries()) {
    await store.append(TENANT, STREAM, makeEvent({
      id: `t-${i}`, type: 'Ticked', occurredAt: at(i),
      idempotencyKey: `tick-${TENANT}-${i}`, source: 'test', payload: { n },
    }));
  }
  return store;
}

/** Wraps a store to record how each read was narrowed — proving the tail is read, not the history. */
class SpyReader implements Pick<EventStore, 'readStream'> {
  lastSinceSeq: number | undefined = undefined;
  rowsReturned = 0;
  constructor(private readonly inner: EventStore) {}
  async readStream(tenantId: string, stream: string, opts?: ReadOptions) {
    this.lastSinceSeq = opts?.sinceSeq;
    const rows = await this.inner.readStream(tenantId, stream, opts);
    this.rowsReturned = rows.length;
    return rows;
  }
}

describe('projectFromSnapshot resumes a projection from its snapshot', () => {
  it('equals a full fold when there is no prior snapshot', async () => {
    const store = await meterWith([1, 2, 3, 4, 5]);
    const snaps = new InMemorySnapshotStore();

    const viaSnapshot = await projectFromSnapshot(store, snaps, TENANT, STREAM, 'sum@1', SUM);
    const full = runProjection(await store.readStream(TENANT, STREAM), SUM);

    expect(viaSnapshot.state).toBe(15);
    expect(viaSnapshot.state).toBe(full.state);
    expect(viaSnapshot.watermarkSeq).toBe(full.watermarkSeq);
    expect(viaSnapshot.eventCount).toBe(full.eventCount);
    expect(viaSnapshot.lastEventAt).toBe(full.lastEventAt);
  });

  it('reads only the tail after a snapshot — and still equals a full fold', async () => {
    const store = await meterWith([1, 2, 3, 4, 5]);
    const snaps = new InMemorySnapshotStore();

    // First read writes a snapshot at the current watermark (5 events ≥ the every=3 threshold).
    const first = await projectFromSnapshot(store, snaps, TENANT, STREAM, 'sum@1', SUM, { snapshotEvery: 3 });
    const snap = await snaps.load<number>(TENANT, STREAM, 'sum@1');
    expect(snap?.result.watermarkSeq).toBe(first.watermarkSeq);

    // Two more events arrive; the next read must fold ONLY those two, not all seven.
    await store.append(TENANT, STREAM, makeEvent({
      id: 't-5', type: 'Ticked', occurredAt: at(5), idempotencyKey: `tick-${TENANT}-5`, source: 'test', payload: { n: 6 },
    }));
    await store.append(TENANT, STREAM, makeEvent({
      id: 't-6', type: 'Ticked', occurredAt: at(6), idempotencyKey: `tick-${TENANT}-6`, source: 'test', payload: { n: 7 },
    }));

    const spy = new SpyReader(store);
    const second = await projectFromSnapshot(spy, snaps, TENANT, STREAM, 'sum@1', SUM, { snapshotEvery: 3 });

    expect(spy.lastSinceSeq).toBe(first.watermarkSeq); // read narrowed to the tail, at the store
    expect(spy.rowsReturned).toBe(2);                  // only the two new events crossed the wire
    expect(second.state).toBe(28);                     // 15 + 6 + 7 — the whole truth, from the tail
    expect(second.eventCount).toBe(7);
    // Equivalent to a from-scratch fold of everything.
    expect(second.state).toBe(runProjection(await store.readStream(TENANT, STREAM), SUM).state);
  });

  it('writes a snapshot only once enough events accrue; every=0 never writes', async () => {
    const store = await meterWith([1, 1]); // 2 events, below the every=3 threshold
    const snaps = new InMemorySnapshotStore();
    await projectFromSnapshot(store, snaps, TENANT, STREAM, 'sum@1', SUM, { snapshotEvery: 3 });
    expect(await snaps.load(TENANT, STREAM, 'sum@1')).toBeUndefined(); // not yet worth a snapshot

    const store2 = await meterWith([1, 1, 1, 1]); // 4 events, above it
    const snaps2 = new InMemorySnapshotStore();
    await projectFromSnapshot(store2, snaps2, TENANT, STREAM, 'sum@1', SUM, { snapshotEvery: 3 });
    expect((await snaps2.load(TENANT, STREAM, 'sum@1'))?.result.state).toBe(4);

    // every=0 is read-through only: correct result, no snapshot persisted.
    const snaps3 = new InMemorySnapshotStore();
    const r = await projectFromSnapshot(store2, snaps3, TENANT, STREAM, 'sum@1', SUM, { snapshotEvery: 0 });
    expect(r.state).toBe(4);
    expect(await snaps3.load(TENANT, STREAM, 'sum@1')).toBeUndefined();
  });

  it('is disposable — a lost snapshot store rebuilds the same model from the events', async () => {
    const store = await meterWith([2, 4, 6, 8]);
    const withSnap = await projectFromSnapshot(store, new InMemorySnapshotStore(), TENANT, STREAM, 'sum@1', SUM, { snapshotEvery: 2 });

    // A fresh, empty snapshot store — as if every snapshot were deleted. The read rebuilds from seq 0.
    const rebuilt = await projectFromSnapshot(store, new InMemorySnapshotStore(), TENANT, STREAM, 'sum@1', SUM);
    expect(rebuilt.state).toBe(20);
    expect(rebuilt.state).toBe(withSnap.state);
    expect(rebuilt.watermarkSeq).toBe(withSnap.watermarkSeq);
  });

  it('keeps the tail bounded across many events (the point of the feature)', async () => {
    const store = await meterWith(Array.from({ length: 1200 }, () => 1));
    const snaps = new InMemorySnapshotStore();

    // First read folds all 1200 and snapshots (default every=500).
    const first = await projectFromSnapshot(store, snaps, TENANT, STREAM, 'sum@1', SUM);
    expect(first.state).toBe(1200);
    const snap = await snaps.load<number>(TENANT, STREAM, 'sum@1');
    expect(snap?.result.watermarkSeq).toBe(1200);

    // One more event; the next read folds ONE, not 1201.
    await store.append(TENANT, STREAM, makeEvent({
      id: 't-1200', type: 'Ticked', occurredAt: at(1200), idempotencyKey: `tick-${TENANT}-1200`, source: 'test', payload: { n: 1 },
    }));
    const spy = new SpyReader(store);
    const second = await projectFromSnapshot(spy, snaps, TENANT, STREAM, 'sum@1', SUM);
    expect(spy.rowsReturned).toBe(1);
    expect(second.state).toBe(1201);
  });
});
