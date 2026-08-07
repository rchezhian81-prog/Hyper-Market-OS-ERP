import { describe, it, expect } from 'vitest';
import { SyncOutbox } from '../../packages/sync/src/index';
import { makeEvent } from '../../packages/contracts/src/event';

// The outbox is how the store trades offline and syncs safely (P-01 / §31):
// idempotent enqueue, a visible unsent count, and a dead-letter queue that never
// drops a poison item (hard rule #6).

function saleEvent(id: string, key: string) {
  return makeEvent<'SaleCommitted', { saleId: string }>({
    id,
    type: 'SaleCommitted',
    occurredAt: '2026-08-02T10:00:00Z',
    idempotencyKey: key,
    source: 'lane-1',
    payload: { saleId: key },
  });
}

describe('sync outbox', () => {
  it('enqueues pending items and counts the unsent ones', () => {
    const outbox = new SyncOutbox<'SaleCommitted', { saleId: string }>();
    outbox.enqueue(saleEvent('e1', 'sale-1'));
    outbox.enqueue(saleEvent('e2', 'sale-2'));
    expect(outbox.unsentCount()).toBe(2);
    expect(outbox.pending().map((i) => i.key)).toEqual(['sale-1', 'sale-2']);
  });

  it('is idempotent on the idempotency key', () => {
    const outbox = new SyncOutbox<'SaleCommitted', { saleId: string }>();
    outbox.enqueue(saleEvent('e1', 'sale-1'));
    outbox.enqueue(saleEvent('e1-again', 'sale-1'));
    expect(outbox.unsentCount()).toBe(1);
  });

  it('acknowledges an item off the pending list (idempotently)', () => {
    const outbox = new SyncOutbox<'SaleCommitted', { saleId: string }>();
    outbox.enqueue(saleEvent('e1', 'sale-1'));
    outbox.acknowledge('sale-1');
    expect(outbox.unsentCount()).toBe(0);
    expect(outbox.find('sale-1')?.state).toBe('acknowledged');
    // acking again is a no-op
    outbox.acknowledge('sale-1');
    expect(outbox.find('sale-1')?.state).toBe('acknowledged');
  });

  it('records failed attempts', () => {
    const outbox = new SyncOutbox<'SaleCommitted', { saleId: string }>();
    outbox.enqueue(saleEvent('e1', 'sale-1'));
    expect(outbox.recordFailure('sale-1')).toBe(1);
    expect(outbox.recordFailure('sale-1')).toBe(2);
    expect(outbox.find('sale-1')?.attempts).toBe(2);
    expect(outbox.unsentCount()).toBe(1); // still pending until acked or dead-lettered
  });

  it('moves a poison item to the visible dead-letter queue and never drops it', () => {
    const outbox = new SyncOutbox<'SaleCommitted', { saleId: string }>();
    outbox.enqueue(saleEvent('e1', 'sale-1'));
    outbox.enqueue(saleEvent('e2', 'sale-2'));
    outbox.deadLetter('sale-1', 'schema mismatch after 5 attempts');
    expect(outbox.unsentCount()).toBe(1); // dead-lettered item is not "pending"
    const dead = outbox.deadLetters();
    expect(dead.map((i) => i.key)).toEqual(['sale-1']);
    expect(dead[0]?.reason).toBe('schema mismatch after 5 attempts');
    // it is still present — never dropped
    expect(outbox.find('sale-1')?.state).toBe('dead_letter');
  });
});
