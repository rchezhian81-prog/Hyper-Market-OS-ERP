import { describe, it, expect } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { qualityHoldAdapter } from '../../services/api/src/adapters';
import type { QualityHold } from '../../packages/quality/src/index';

// The quality-hold ADAPTER fold (M10-FR-02): each event's payload is the resulting record, latest per
// batch wins, tenants are isolated, and the state folds from the append-only stream after a restart —
// nothing lives in memory. The route/engine behaviour is proven in tests/integration/quality-hold.test.ts.

const NOW = '2026-08-07T10:00:00.000Z';
const held = (batchId: string, reason = 'sampling'): QualityHold => ({
  batchId, productId: `p-${batchId}`, status: 'held', reason, heldAt: NOW, heldBy: 'u-owner',
});

describe('qualityHoldAdapter fold', () => {
  it('returns the current hold for a batch, and undefined for an unknown one', async () => {
    const a = qualityHoldAdapter({ store: new InMemoryEventStore(), now: () => NOW });
    await a.recordHeld('t-1', held('b-1'), 'k1');
    expect(await a.hold('t-1', 'b-1')).toMatchObject({ batchId: 'b-1', status: 'held' });
    expect(await a.hold('t-1', 'b-nope')).toBeUndefined();
  });

  it('lets the latest event win — a release supersedes the hold without overwriting it', async () => {
    const store = new InMemoryEventStore();
    const a = qualityHoldAdapter({ store, now: () => NOW });
    await a.recordHeld('t-1', held('b-1'), 'k1');
    await a.recordReleased('t-1', { ...held('b-1'), status: 'released', releasedAt: NOW, releasedBy: 'u-qc' }, 'k2');
    expect(await a.hold('t-1', 'b-1')).toMatchObject({ status: 'released', releasedBy: 'u-qc' });
    // Both events are on the append-only stream — the hold was not erased (parts joined by the unit separator).
    expect((await store.readStream('t-1', 'inventory\u001fquality-holds')).length).toBe(2);
  });

  it('lists every batch with its current record', async () => {
    const a = qualityHoldAdapter({ store: new InMemoryEventStore(), now: () => NOW });
    await a.recordHeld('t-1', held('b-1'), 'k1');
    await a.recordHeld('t-1', held('b-2'), 'k2');
    const all = await a.holds('t-1');
    expect(all.map((h) => h.batchId).sort()).toEqual(['b-1', 'b-2']);
  });

  it('isolates tenants', async () => {
    const store = new InMemoryEventStore();
    const a = qualityHoldAdapter({ store, now: () => NOW });
    await a.recordHeld('t-1', held('b-1'), 'k1');
    expect(await a.hold('t-2', 'b-1')).toBeUndefined();
    expect(await a.holds('t-2')).toEqual([]);
  });

  it('folds from the store after a restart — a fresh adapter sees the same state', async () => {
    const store = new InMemoryEventStore();
    const a1 = qualityHoldAdapter({ store, now: () => NOW });
    await a1.recordHeld('t-1', held('b-1'), 'k1');
    await a1.recordReleased('t-1', { ...held('b-1'), status: 'released', releasedAt: NOW, releasedBy: 'u-qc' }, 'k2');

    const a2 = qualityHoldAdapter({ store, now: () => NOW }); // new process, same durable store
    expect(await a2.hold('t-1', 'b-1')).toMatchObject({ status: 'released', releasedBy: 'u-qc' });
  });
});
