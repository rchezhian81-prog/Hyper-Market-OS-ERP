import { describe, it, expect } from 'vitest';
import {
  allocateFefo,
  expiryActions,
  isExpired,
  isSellable,
  InvalidFefoRequestError,
  type Batch,
} from '../../packages/fefo/src/index';

// FEFO sells earliest-expiry first and never allocates expired or recall-blocked
// stock; the expiry list flags markdown/disposal (M10-FR-01).

const ASOF = '2026-08-02';

function batch(overrides: Partial<Batch> & Pick<Batch, 'batchId' | 'expiry'>): Batch {
  return { productId: 'p1', qty: 10, ...overrides };
}

describe('allocateFefo', () => {
  it('allocates the earliest-expiry batch first', () => {
    const batches = [
      batch({ batchId: 'later', expiry: '2026-08-20', qty: 10 }),
      batch({ batchId: 'sooner', expiry: '2026-08-10', qty: 10 }),
    ];
    const result = allocateFefo(batches, 'p1', 5, ASOF);
    expect(result.fullyAllocated).toBe(true);
    expect(result.allocated).toEqual([{ batchId: 'sooner', qty: 5, expiry: '2026-08-10' }]);
  });

  it('draws across batches in expiry order until satisfied', () => {
    const batches = [
      batch({ batchId: 'b1', expiry: '2026-08-10', qty: 3 }),
      batch({ batchId: 'b2', expiry: '2026-08-15', qty: 4 }),
      batch({ batchId: 'b3', expiry: '2026-08-20', qty: 10 }),
    ];
    const result = allocateFefo(batches, 'p1', 8, ASOF);
    expect(result.allocated).toEqual([
      { batchId: 'b1', qty: 3, expiry: '2026-08-10' },
      { batchId: 'b2', qty: 4, expiry: '2026-08-15' },
      { batchId: 'b3', qty: 1, expiry: '2026-08-20' },
    ]);
    expect(result.allocatedQty).toBe(8);
  });

  it('never allocates expired stock and reports the shortfall', () => {
    const batches = [
      batch({ batchId: 'expired', expiry: '2026-07-30', qty: 100 }), // before asOf
      batch({ batchId: 'good', expiry: '2026-08-10', qty: 3 }),
    ];
    const result = allocateFefo(batches, 'p1', 5, ASOF);
    expect(result.allocated).toEqual([{ batchId: 'good', qty: 3, expiry: '2026-08-10' }]);
    expect(result.allocatedQty).toBe(3);
    expect(result.shortfallQty).toBe(2);
    expect(result.fullyAllocated).toBe(false);
  });

  it('never allocates recall-blocked or quarantined stock', () => {
    const batches = [
      batch({ batchId: 'recalled', expiry: '2026-08-05', qty: 50, recallBlocked: true }),
      batch({ batchId: 'quarantine', expiry: '2026-08-06', qty: 50, state: 'quarantine' }),
      batch({ batchId: 'good', expiry: '2026-08-10', qty: 10 }),
    ];
    const result = allocateFefo(batches, 'p1', 4, ASOF);
    expect(result.allocated).toEqual([{ batchId: 'good', qty: 4, expiry: '2026-08-10' }]);
  });

  it('only allocates the requested product', () => {
    const batches = [
      batch({ batchId: 'other', productId: 'p2', expiry: '2026-08-01', qty: 10 }),
      batch({ batchId: 'mine', expiry: '2026-08-10', qty: 10 }),
    ];
    const result = allocateFefo(batches, 'p1', 5, ASOF);
    expect(result.allocated).toEqual([{ batchId: 'mine', qty: 5, expiry: '2026-08-10' }]);
  });

  it('rejects a negative required quantity', () => {
    expect(() => allocateFefo([], 'p1', -1, ASOF)).toThrow(InvalidFefoRequestError);
  });
});

describe('expiryActions', () => {
  it('flags expired stock for disposal and near-expiry for markdown, earliest first', () => {
    const batches = [
      batch({ batchId: 'ok', expiry: '2026-09-30', qty: 10 }), // far out
      batch({ batchId: 'soon', expiry: '2026-08-05', qty: 10 }), // 3 days
      batch({ batchId: 'gone', expiry: '2026-07-30', qty: 10 }), // expired
    ];
    const items = expiryActions(batches, ASOF, 7);
    expect(items.map((i) => i.batchId)).toEqual(['gone', 'soon']); // 'ok' excluded, earliest first
    expect(items[0]).toMatchObject({ status: 'expired', action: 'dispose', daysToExpiry: -3 });
    expect(items[1]).toMatchObject({ status: 'near_expiry', action: 'markdown', daysToExpiry: 3 });
  });

  it('does not list quarantined or recalled stock (drives sellable markdown/disposal)', () => {
    const batches = [
      batch({ batchId: 'q', expiry: '2026-08-03', qty: 5, state: 'quarantine' }),
      batch({ batchId: 'r', expiry: '2026-08-03', qty: 5, recallBlocked: true }),
      batch({ batchId: 'sellable', expiry: '2026-08-03', qty: 5 }),
    ];
    const items = expiryActions(batches, ASOF, 7);
    expect(items.map((i) => i.batchId)).toEqual(['sellable']);
  });

  it('treats the expiry date itself as the last sellable day', () => {
    const today = batch({ batchId: 'today', expiry: ASOF, qty: 5 });
    expect(isExpired(today, ASOF)).toBe(false);
    expect(isSellable(today, ASOF)).toBe(true);
    const items = expiryActions([today], ASOF, 7);
    expect(items[0]).toMatchObject({ status: 'near_expiry', daysToExpiry: 0 });
  });
});
