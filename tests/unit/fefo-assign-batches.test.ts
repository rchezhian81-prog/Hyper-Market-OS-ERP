import { describe, it, expect } from 'vitest';
import { assignBatchesFefo, InvalidBatchAssignment, type BatchTrackedSaleLine } from '../../packages/fefo/src/index';
import type { Batch } from '../../packages/fefo/src/index';

// M10-FR-03 batch-on-sale (owner's FEFO choice): a lane auto-assigns each batch-tracked line its
// earliest-expiry batch(es), decrementing stock across lines, and flags any quantity it cannot trace.

const ASOF = '2026-08-11';
// Two batches of milk: B1 expires sooner (goes first under FEFO), B2 later.
const batches: Batch[] = [
  { batchId: 'B2', productId: 'milk', qty: 5, expiry: '2026-08-20' },
  { batchId: 'B1', productId: 'milk', qty: 3, expiry: '2026-08-14' },
  { batchId: 'X-expired', productId: 'milk', qty: 10, expiry: '2026-08-01' }, // expired — never assigned
];

const line = (o: Partial<BatchTrackedSaleLine> = {}): BatchTrackedSaleLine =>
  ({ lineId: 'l1', productId: 'milk', quantity: 2, batchTracked: true, ...o });

describe('assignBatchesFefo — FEFO batch assignment on a sale (M10-FR-03)', () => {
  it('assigns the earliest-expiry batch first', () => {
    const [a] = assignBatchesFefo({ lines: [line({ quantity: 2 })], batches, asOf: ASOF });
    expect(a!.allocations.map((x) => x.batchId)).toEqual(['B1']); // sooner expiry
    expect(a!.fullyTraced).toBe(true);
    expect(a!.untracedQty).toBe(0);
  });

  it('spans batches earliest-first when one is not enough, never using expired stock', () => {
    const [a] = assignBatchesFefo({ lines: [line({ quantity: 6 })], batches, asOf: ASOF });
    // 3 from B1 (expires 14th), then 3 from B2 (expires 20th); the expired batch is skipped.
    expect(a!.allocations).toEqual([
      { batchId: 'B1', qty: 3, expiry: '2026-08-14' },
      { batchId: 'B2', qty: 3, expiry: '2026-08-20' },
    ]);
    expect(a!.fullyTraced).toBe(true);
  });

  it('does not let a second line claim units the first already took (decrements across lines)', () => {
    const [first, second] = assignBatchesFefo({
      lines: [line({ lineId: 'a', quantity: 3 }), line({ lineId: 'b', quantity: 2 })],
      batches, asOf: ASOF,
    });
    expect(first!.allocations).toEqual([{ batchId: 'B1', qty: 3, expiry: '2026-08-14' }]); // takes all of B1
    expect(second!.allocations).toEqual([{ batchId: 'B2', qty: 2, expiry: '2026-08-20' }]); // B1 is gone → B2
  });

  it('flags the untraceable remainder when the batch records are behind the shelf (still sold)', () => {
    // Only 8 sellable units on hand (3 + 5); a line for 10 leaves 2 with no batch.
    const [a] = assignBatchesFefo({ lines: [line({ quantity: 10 })], batches, asOf: ASOF });
    expect(a!.allocations.reduce((s, x) => s + x.qty, 0)).toBe(8);
    expect(a!.untracedQty).toBe(2);
    expect(a!.fullyTraced).toBe(false);
  });

  it('passes a non-batch-tracked line through with no batch and no trace gap', () => {
    const [a] = assignBatchesFefo({ lines: [line({ productId: 'bread', batchTracked: false })], batches, asOf: ASOF });
    expect(a!.allocations).toEqual([]);
    expect(a!.untracedQty).toBe(0);
    expect(a!.fullyTraced).toBe(true);
  });

  it('reports a whole basket at once, preserving line order', () => {
    const out = assignBatchesFefo({
      lines: [line({ lineId: 'x', quantity: 1 }), line({ lineId: 'y', productId: 'bread', batchTracked: false }), line({ lineId: 'z', quantity: 1 })],
      batches, asOf: ASOF,
    });
    expect(out.map((r) => r.lineId)).toEqual(['x', 'y', 'z']);
    expect(out[1]!.allocations).toEqual([]); // the non-tracked line
  });

  it('refuses a line with no id/product, and a batch-tracked negative/non-whole quantity', () => {
    expect(() => assignBatchesFefo({ lines: [line({ lineId: '' })], batches, asOf: ASOF })).toThrow(InvalidBatchAssignment);
    expect(() => assignBatchesFefo({ lines: [line({ quantity: -1 })], batches, asOf: ASOF })).toThrow(InvalidBatchAssignment);
    expect(() => assignBatchesFefo({ lines: [line({ quantity: 1.5 })], batches, asOf: ASOF })).toThrow(InvalidBatchAssignment);
  });
});
