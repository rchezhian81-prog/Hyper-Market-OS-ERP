// FEFO batch assignment for a sale (M10-FR-03, batch-on-sale). The owner's choice: a lane assigns the
// batch to each batch-tracked line AUTOMATICALLY, First-Expiry-First-Out, so the cashier does nothing and
// the lane is not slowed. This is the deterministic brain of that — the till runs it OFFLINE against the
// batches its cached ledger already holds (the same data FEFO allocation and the expiry list use, M10-FR-01),
// so it works with the internet down (hard rule #1).
//
// For each batch-tracked line it draws the required units earliest-expiry-first, and — because a basket can
// hold two lines of the same product — it DECREMENTS the batches as it goes, so the second line never claims
// units the first already took. If there is not enough traceable stock to cover a line (the batch records
// are behind the shelf), the remainder is reported as `untracedQty`: the sale still stands (hard rule #1),
// but the untraceable units are surfaced (P-08) exactly as the cloud's `batch_tracked_sold_without_batch`
// finding surfaces a line with no batch at all. A non-batch-tracked line is passed through with no batch.
//
// Pure and deterministic — no clock (the caller passes `asOf`), no I/O; reuses the tested `allocateFefo`.

import { allocateFefo, type Batch, type FefoAllocation } from './fefo';

export interface BatchTrackedSaleLine {
  readonly lineId: string;
  readonly productId: string;
  /** Whole units sold on this line (batch-tracked goods are packs/strips, counted whole). */
  readonly quantity: number;
  /** From the catalogue: whether this product is lot/batch-tracked at all. */
  readonly batchTracked: boolean;
}

export interface AssignedSaleLine {
  readonly lineId: string;
  readonly productId: string;
  readonly quantity: number;
  /** The batches this line draws from, earliest-expiry first. Empty for a non-batch-tracked line. */
  readonly allocations: readonly FefoAllocation[];
  /** Units with no on-hand batch to assign — still sold, but untraceable (a batch-records-behind-shelf gap). */
  readonly untracedQty: number;
  /** True when a batch-tracked line's whole quantity got a batch (or the line is not batch-tracked). */
  readonly fullyTraced: boolean;
}

export class InvalidBatchAssignment extends Error {
  constructor(detail: string) {
    super(`Cannot assign sale batches: ${detail}`);
    this.name = 'InvalidBatchAssignment';
  }
}

const isNonEmpty = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';

/**
 * Assign each batch-tracked sale line its FEFO batch(es) from the on-hand batches, decrementing stock across
 * lines so no unit is assigned twice. A non-batch-tracked line passes through untouched. Deterministic.
 *
 * @throws InvalidBatchAssignment if a line has no id/product, or a batch-tracked line's quantity is not a
 *   whole non-negative number (a non-tracked line's quantity is not used and not validated).
 */
export function assignBatchesFefo(input: {
  readonly lines: readonly BatchTrackedSaleLine[];
  readonly batches: readonly Batch[];
  readonly asOf: string;
}): readonly AssignedSaleLine[] {
  // Working stock: units still available per batch, drawn down as lines are assigned.
  const remaining = new Map<string, number>();
  for (const b of input.batches) remaining.set(b.batchId, (remaining.get(b.batchId) ?? 0) + b.qty);
  const currentView = (): Batch[] => input.batches.map((b) => ({ ...b, qty: remaining.get(b.batchId) ?? 0 }));

  const assigned: AssignedSaleLine[] = [];
  for (const line of input.lines) {
    if (!isNonEmpty(line.lineId) || !isNonEmpty(line.productId)) {
      throw new InvalidBatchAssignment('every line needs a lineId and a productId');
    }

    if (line.batchTracked !== true) {
      assigned.push({ lineId: line.lineId, productId: line.productId, quantity: line.quantity, allocations: [], untracedQty: 0, fullyTraced: true });
      continue;
    }

    if (!Number.isInteger(line.quantity) || line.quantity < 0) {
      throw new InvalidBatchAssignment(`line ${line.lineId}: a batch-tracked quantity must be a whole non-negative number`);
    }

    const result = allocateFefo(currentView(), line.productId, line.quantity, input.asOf);
    for (const a of result.allocated) remaining.set(a.batchId, (remaining.get(a.batchId) ?? 0) - a.qty);

    assigned.push({
      lineId: line.lineId,
      productId: line.productId,
      quantity: line.quantity,
      allocations: result.allocated,
      untracedQty: result.shortfallQty,
      fullyTraced: result.fullyAllocated,
    });
  }

  return assigned;
}
