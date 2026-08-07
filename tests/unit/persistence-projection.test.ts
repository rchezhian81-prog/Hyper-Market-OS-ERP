import { describe, it, expect } from 'vitest';
import {
  runProjection,
  projectStream,
  emptyProjectionResult,
  InMemoryEventStore,
  type Projection,
  type PersistedEvent,
} from '../../packages/persistence/src/index';
import { makeEvent } from '../../packages/contracts/src/event';

// A read model is derived by folding the append-only event ledger, with a watermark
// so it resumes incrementally and a last-event time for freshness (§29 / P-08).

// A simple stock-on-hand projection: sum deltaMinor of InventoryMoved events.
const stockLevel: Projection<number> = {
  initial: 0,
  apply: (qty, event) => qty + Number((event.payload as { deltaMinor?: number }).deltaMinor ?? 0),
};

function persisted(seq: number, deltaMinor: number, at: string): PersistedEvent {
  return {
    seq,
    tenantId: 't1',
    stream: 'stock',
    event: makeEvent({
      id: `e${seq}`,
      type: 'InventoryMoved',
      occurredAt: at,
      idempotencyKey: `k${seq}`,
      source: 'wh-1',
      payload: { deltaMinor },
    }),
  };
}

describe('runProjection', () => {
  it('folds events into a read model with a watermark and freshness time', () => {
    const events = [
      persisted(1, 10, '2026-08-02T09:00:00Z'),
      persisted(2, -3, '2026-08-02T10:00:00Z'),
    ];
    const result = runProjection(events, stockLevel);
    expect(result.state).toBe(7); // 10 − 3
    expect(result.watermarkSeq).toBe(2);
    expect(result.lastEventAt).toBe('2026-08-02T10:00:00Z');
    expect(result.eventCount).toBe(2);
  });

  it('resumes incrementally from a prior watermark (only new events)', () => {
    const first = runProjection([persisted(1, 10, '2026-08-02T09:00:00Z')], stockLevel);
    // re-run over the same event 1 plus a new event 2 — event 1 is not double-counted
    const second = runProjection(
      [persisted(1, 10, '2026-08-02T09:00:00Z'), persisted(2, 5, '2026-08-02T11:00:00Z')],
      stockLevel,
      first,
    );
    expect(second.state).toBe(15); // 10 + 5, not 10 + 10 + 5
    expect(second.watermarkSeq).toBe(2);
  });

  it('folds out of order deterministically by seq', () => {
    const result = runProjection(
      [persisted(2, -3, '2026-08-02T10:00:00Z'), persisted(1, 10, '2026-08-02T09:00:00Z')],
      stockLevel,
    );
    expect(result.state).toBe(7);
    expect(result.lastEventAt).toBe('2026-08-02T10:00:00Z'); // seq 2 is the last
  });

  it('an empty projection is the initial state at watermark 0', () => {
    const empty = emptyProjectionResult(0);
    expect(empty).toEqual({ state: 0, watermarkSeq: 0, lastEventAt: null, eventCount: 0 });
    expect(runProjection([], stockLevel).state).toBe(0);
  });
});

describe('projectStream', () => {
  it('projects a tenant stream read from an event store', async () => {
    const store = new InMemoryEventStore();
    await store.append('t1', 'stock', persisted(1, 10, '2026-08-02T09:00:00Z').event);
    await store.append('t1', 'stock', persisted(2, -4, '2026-08-02T10:00:00Z').event);
    const result = await projectStream(store, 't1', 'stock', stockLevel);
    expect(result.state).toBe(6);
    expect(result.watermarkSeq).toBe(2);
  });

  it('projects each tenant independently', async () => {
    const store = new InMemoryEventStore();
    await store.append('t1', 'stock', persisted(1, 10, '2026-08-02T09:00:00Z').event);
    await store.append('t2', 'stock', persisted(1, 99, '2026-08-02T09:00:00Z').event);
    expect((await projectStream(store, 't1', 'stock', stockLevel)).state).toBe(10);
    expect((await projectStream(store, 't2', 'stock', stockLevel)).state).toBe(99);
  });
});
