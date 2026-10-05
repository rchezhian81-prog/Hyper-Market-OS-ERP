import { describe, it, expect } from 'vitest';
import { InMemoryEventStore, ConcurrencyConflictError } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';

/**
 * **Write guards — an expected-version compare-and-append per business key (Wave 2a · audit PF-01, SF-04, FUL-02,
 * PA-11 · M13-FR-01 · M13-FR-03 · M17-FR-01 · M08-FR-02 · M18-FR-02 · hard rule #10 · P-08).**
 *
 * Idempotency stops the same command landing twice. It does not stop two DIFFERENT commands — two refunds of one
 * sale with two ids — each reading the same balance and each appending: the audit reproduced exactly that. The
 * guard is a version per key: read before deciding, required to still hold when writing, bumped by the write.
 * This pins the reference implementation's rules; the real-PostgreSQL twin is tests/integration/write-guards-on-postgresql.test.ts.
 */

const T = 'tenant-a';
const ev = (id: string) => makeEvent({ id, type: 'RefundRecorded', occurredAt: '2026-10-05T09:00:00.000Z', idempotencyKey: `k-${id}`, source: 'test', payload: { id } });

describe('a key nobody has written under', () => {
  it('reads as version 0, and a guarded append at 0 lands and makes it 1', async () => {
    const store = new InMemoryEventStore();
    expect(await store.guardVersion(T, 'refund:S1')).toBe(0);
    const out = await store.appendBatch(T, [{ stream: 'returns', event: ev('r1') }], { guard: { key: 'refund:S1', expectedVersion: 0 } });
    expect(out[0]!.deduped).toBe(false);
    expect(await store.guardVersion(T, 'refund:S1')).toBe(1);
  });

  it('is per tenant: the same key under another tenant is untouched', async () => {
    const store = new InMemoryEventStore();
    await store.appendBatch(T, [{ stream: 'returns', event: ev('r1') }], { guard: { key: 'refund:S1', expectedVersion: 0 } });
    expect(await store.guardVersion('tenant-b', 'refund:S1')).toBe(0);
  });
});

describe('two writers that read the same version', () => {
  it('one lands, the other is refused BY NAME and nothing of its batch is kept', async () => {
    const store = new InMemoryEventStore();
    const v = await store.guardVersion(T, 'refund:S1');
    const first = store.appendBatch(T, [{ stream: 'returns', event: ev('r1') }], { guard: { key: 'refund:S1', expectedVersion: v } });
    const second = store.appendBatch(T, [{ stream: 'returns', event: ev('r2') }, { stream: 'reporting', event: ev('r2-report') }], { guard: { key: 'refund:S1', expectedVersion: v } });
    await expect(first).resolves.toHaveLength(1);
    await expect(second).rejects.toBeInstanceOf(ConcurrencyConflictError);
    await expect(second).rejects.toMatchObject({ key: 'refund:S1', expectedVersion: 0, name: 'ConcurrencyConflictError' });
    expect((await store.readStream(T, 'returns')).map((r) => r.event.id)).toEqual(['r1']);
    expect(await store.readStream(T, 'reporting')).toEqual([]);
    expect(await store.findByIdempotencyKey(T, 'k-r2')).toBeUndefined();
    expect(await store.guardVersion(T, 'refund:S1')).toBe(1);
  });

  it('the loser re-reads the version and then lands — the guard refuses the stale decision, not the writer', async () => {
    const store = new InMemoryEventStore();
    await store.appendBatch(T, [{ stream: 'returns', event: ev('r1') }], { guard: { key: 'refund:S1', expectedVersion: 0 } });
    await expect(store.appendBatch(T, [{ stream: 'returns', event: ev('r2') }], { guard: { key: 'refund:S1', expectedVersion: 0 } })).rejects.toBeInstanceOf(ConcurrencyConflictError);
    const again = await store.guardVersion(T, 'refund:S1');
    await store.appendBatch(T, [{ stream: 'returns', event: ev('r2') }], { guard: { key: 'refund:S1', expectedVersion: again } });
    expect(await store.guardVersion(T, 'refund:S1')).toBe(2);
    expect((await store.readStream(T, 'returns')).map((r) => r.event.id)).toEqual(['r1', 'r2']);
  });

  it('different keys never contend', async () => {
    const store = new InMemoryEventStore();
    await Promise.all([
      store.appendBatch(T, [{ stream: 'returns', event: ev('a') }], { guard: { key: 'refund:S1', expectedVersion: 0 } }),
      store.appendBatch(T, [{ stream: 'returns', event: ev('b') }], { guard: { key: 'refund:S2', expectedVersion: 0 } }),
    ]);
    expect(await store.guardVersion(T, 'refund:S1')).toBe(1);
    expect(await store.guardVersion(T, 'refund:S2')).toBe(1);
  });
});

describe('replays and unguarded appends', () => {
  it('a batch that dedups ENTIRELY never touches the guard — a lane retrying a lost reply with the version it first read still gets its answer', async () => {
    const store = new InMemoryEventStore();
    const entries = [{ stream: 'returns', event: ev('r1') }];
    await store.appendBatch(T, entries, { guard: { key: 'refund:S1', expectedVersion: 0 } });
    const replay = await store.appendBatch(T, entries, { guard: { key: 'refund:S1', expectedVersion: 0 } }); // stale version, same command
    expect(replay[0]!.deduped).toBe(true);
    expect(await store.guardVersion(T, 'refund:S1')).toBe(1);
  });

  it('a partially-deduped batch IS a new write and must hold the version', async () => {
    const store = new InMemoryEventStore();
    await store.appendBatch(T, [{ stream: 'returns', event: ev('r1') }], { guard: { key: 'refund:S1', expectedVersion: 0 } });
    await expect(store.appendBatch(T, [{ stream: 'returns', event: ev('r1') }, { stream: 'returns', event: ev('r3') }], { guard: { key: 'refund:S1', expectedVersion: 0 } }))
      .rejects.toBeInstanceOf(ConcurrencyConflictError);
    expect(await store.findByIdempotencyKey(T, 'k-r3')).toBeUndefined();
  });

  it('an append without a guard behaves exactly as before and leaves every version alone', async () => {
    const store = new InMemoryEventStore();
    await store.append(T, 'returns', ev('r1'));
    await store.appendBatch(T, [{ stream: 'returns', event: ev('r2') }]);
    expect(await store.guardVersion(T, 'refund:S1')).toBe(0);
    expect(await store.readStream(T, 'returns')).toHaveLength(2);
  });
});
