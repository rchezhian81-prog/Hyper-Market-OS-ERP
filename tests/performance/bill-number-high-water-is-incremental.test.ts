import { describe, it, expect } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import type { EventStore, PersistedEvent, ReadOptions } from '../../packages/persistence/src/event-store';
import { InMemorySnapshotStore } from '../../packages/persistence/src/snapshot';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, bankedReceiptCounts, bankedReceiptCountsByFullScan } from '../../services/api/src/adapters';

/**
 * **Verifier r18 OB85-2 — a store pack's bill-number high-water costs O(prefixes), not O(every bill ever made).**
 *
 * Every store computer pulls its pack every sync pass (15 s while busy), and each pack carries `bankedThrough` per prefix.
 * That used to re-read every `ReceiptNumberIssued` and every `ReturnRecorded` on every build: ~0.55 s at 60,000 sales on
 * PostgreSQL, growing linearly (verifier probe zz-v18-cost). Now the running maxima are a snapshot at a stream position and
 * only the tail behind it is read. Proved here by COUNTING the events each build reads (deterministic, machine-independent):
 *
 *   • equal to the full scan on a mixed dataset (several prefixes, returns, out-of-order counts, a lower number banked
 *     late), at every step as the shop keeps trading;
 *   • the events read by a warm build do not grow with history: 2,000 vs 20,000 bills → the same bound (ratio ≈ 1);
 *   • a lost snapshot store (a restart without the SQL store) rebuilds the same answer.
 */

const T = '22222222-2222-4222-8222-222222222222';
const AT = '2026-10-01T10:00:00.000Z';

/** Counts the events every `readStream` hands back. */
class CountingStore {
  read = 0;
  constructor(readonly inner: InMemoryEventStore) {}
  asStore(): EventStore {
    return new Proxy(this.inner, {
      get: (target, prop, receiver) => {
        if (prop === 'readStream') {
          return async (tenantId: string, stream: string, opts?: ReadOptions): Promise<readonly PersistedEvent[]> => {
            const out = await target.readStream(tenantId, stream, opts);
            this.read += out.length;
            return out;
          };
        }
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as unknown as EventStore;
  }
}

async function trade(store: InMemoryEventStore, from: number, to: number): Promise<void> {
  for (let i = from; i < to; i += 1) {
    const prefix = `S1L${i % 5}-`;
    // Counts climb per prefix, with an occasional LOWER number banked late (an offline till catching up).
    const count = i % 97 === 0 && i > 0 ? Math.max(1, Math.floor(i / 5) - 40) : Math.floor(i / 5) + 1;
    const rn = `${prefix}${String(count).padStart(6, '0')}`;
    await store.append(T, STREAM.sales, makeEvent({
      id: `rn-${i}`, type: 'ReceiptNumberIssued', occurredAt: AT, idempotencyKey: `receipt-${T}-${rn}-${i}`, source: 'perf', payload: { receiptNumber: rn, saleId: `S-${i}` },
    }));
    if (i % 11 === 0) {
      const ret = `R-lane-${i % 3}-${String(Math.floor(i / 11) + 1).padStart(6, '0')}`;
      await store.append(T, STREAM.returns, makeEvent({
        id: `ret-${i}`, type: 'ReturnRecorded', occurredAt: AT, idempotencyKey: `ret-${T}-${i}`, source: 'perf', payload: { returnId: `RT-${i}`, number: ret },
      }));
    }
  }
}

const same = async (store: EventStore, snapshots: InMemorySnapshotStore): Promise<void> => {
  const incremental = await bankedReceiptCounts(store, T, { snapshots });
  const full = await bankedReceiptCountsByFullScan(store, T);
  expect(new Map([...incremental].sort())).toEqual(new Map([...full].sort()));
};

describe('the bill-number high-water a pack carries is incremental (OB85-2)', () => {
  it('equals the full scan on a mixed dataset, at every step, and after its snapshots are lost', async () => {
    const inner = new InMemoryEventStore();
    const snapshots = new InMemorySnapshotStore();
    await trade(inner, 0, 50);
    await same(inner, snapshots);
    await trade(inner, 50, 2_000);
    await same(inner, snapshots);
    await same(inner, snapshots); // a second warm read
    await trade(inner, 2_000, 2_300);
    await same(inner, snapshots);
    await same(inner, new InMemorySnapshotStore()); // snapshots lost: rebuilt from the ledger, the same
  }, 120_000);

  it('a warm pack build reads a bounded tail — 2,000 bills or 20,000, the same (ratio ≈ 1)', async () => {
    const warmRead = async (n: number): Promise<number> => {
      const inner = new InMemoryEventStore();
      const counting = new CountingStore(inner);
      const store = counting.asStore();
      const snapshots = new InMemorySnapshotStore();
      await trade(inner, 0, n);
      await bankedReceiptCounts(store, T, { snapshots }); // cold: folds history once and takes a snapshot
      await trade(inner, n, n + 10); // ten more bills
      await bankedReceiptCounts(store, T, { snapshots }); // advances the snapshot past what is settled
      counting.read = 0;
      await bankedReceiptCounts(store, T, { snapshots });
      return counting.read;
    };
    const small = await warmRead(2_000);
    const large = await warmRead(20_000);
    // The tail is at most the lag window plus one snapshot step, on each of the two streams — whatever the history.
    expect(small).toBeLessThanOrEqual(2 * (256 + 64) + 20);
    expect(large).toBeLessThanOrEqual(2 * (256 + 64) + 20);
    expect(large / Math.max(1, small)).toBeLessThan(1.5);
    // The old full scan read every bill and return on every build — the ratio it would show is ~10.
    const inner = new InMemoryEventStore();
    const counting = new CountingStore(inner);
    await trade(inner, 0, 20_000);
    await bankedReceiptCountsByFullScan(counting.asStore(), T);
    expect(counting.read).toBeGreaterThan(20 * large);
  }, 300_000);
});
