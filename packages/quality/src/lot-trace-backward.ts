// The trace run BACKWARDS — from a sale, or from a customer, to the batches they bought and the suppliers behind them
// (M10-FR-03: "traceability works backwards and forwards … the trace works from supplier→customer and customer→supplier";
// roadmap Stage 16 test "recall backwards-trace").
//
// Every other trace in this package starts from a batch. This one starts from what a person at the service desk has in
// their hand: a bill ("this is what I bought"), or a customer ("I bought it here last month"). For each line of each sale
// it names the batch the line drew from — the batch the till RECORDED, or head office's FIFO-by-receipt ESTIMATE for a
// line the till recorded no batch on (ADR-0006, labelled so it is never mistaken for a till record) — and for each batch,
// where it came from: the goods-receipt note and the supplier, or the production run that made it and, one step further
// back, the ingredient batches that run used (D-25) and THEIR suppliers.
//
// No silent failure (P-08): a hop the shop cannot name is a GAP on the trace, said in words — a line whose batch is not
// known, a batch with no receipt and no production on record, a receipt with no supplier, a production run recorded
// before runs kept their ingredient batches, an ingredient chain deeper than the walk goes. Never a blank that reads as
// "nothing there".
//
// Pure and deterministic: the facts go in, the trace comes out; no clock, no storage. The caller fetches the origins of
// the batches this walk asks for (`batchesStillToFetch`) until none are left, then builds the trace.

import type { TraceReceipt } from './lot-trace-chain';

/** How the shop knows which batch a sale line drew from. */
export type BatchKnownBy = 'till_recorded' | 'fifo_estimate';

export interface BackwardLine {
  readonly productId: string;
  readonly quantityMinor: number;
  /** The batch(es) the line drew from. Empty when nobody can say (the product is not batch-tracked, or never received). */
  readonly batches: readonly { readonly batchId: string; readonly knownBy: BatchKnownBy }[];
}

export interface BackwardSale {
  readonly saleId: string;
  readonly soldDate: string;
  readonly lines: readonly BackwardLine[];
}

/** A production run that MADE a batch, and the ingredient batches it recorded (D-25). */
export interface BatchMadeBy {
  readonly runId: string;
  /** False for a run recorded before runs kept their ingredient batches — its ingredients are then not known. */
  readonly inputsRecorded: boolean;
  readonly inputBatchIds: readonly string[];
  /** Ingredients the run recorded with no batch (a product that is not batch-tracked) — their suppliers are not known. */
  readonly inputsWithoutBatch?: number;
}

/** Where one batch came from, from head office's stored facts. */
export interface BatchOrigin {
  readonly receipts: readonly TraceReceipt[];
  readonly madeBy: readonly BatchMadeBy[];
}

/** How far back through ingredients the walk goes before it says it stopped (a recipe of a recipe of a recipe …). */
export const MAX_INGREDIENT_DEPTH = 5;

export interface BackwardBatch {
  readonly batchId: string;
  /** 0 = sold on a bill; 1 = an ingredient of a batch that was sold; 2 = an ingredient of that; … */
  readonly depth: number;
  /** What led the walk here: "sale S-1", or "ingredient of batch X (run R)". */
  readonly reachedFrom: readonly string[];
  readonly productIds: readonly string[];
  readonly receipts: readonly {
    readonly reference: string;
    readonly supplierId: string | null;
    readonly poId: string | null;
    readonly locationId: string;
    readonly receivedAt: string;
    readonly quantityMinor: number;
  }[];
  readonly madeBy: readonly BatchMadeBy[];
}

export interface BackwardSupplier {
  readonly supplierId: string;
  readonly batchIds: readonly string[];
  /** The goods-receipt notes (or movements) the batches arrived on from this supplier. */
  readonly references: readonly string[];
}

export interface BackwardTrace {
  readonly sales: readonly BackwardSale[];
  readonly batches: readonly BackwardBatch[];
  readonly suppliers: readonly BackwardSupplier[];
  /** Each thing the shop cannot say on this road, in words (P-08). Empty only when nothing is missing. */
  readonly gaps: readonly string[];
  /** True only when every line's batch is a till record and every batch's origin is fully named. */
  readonly complete: boolean;
}

interface Visit { readonly batchId: string; readonly depth: number; readonly from: string }

/** The batches the sales name directly (depth 0), in a stable order. */
function startingVisits(sales: readonly BackwardSale[]): Visit[] {
  const out: Visit[] = [];
  for (const s of sales) for (const l of s.lines) for (const b of l.batches) out.push({ batchId: b.batchId, depth: 0, from: `sale ${s.saleId}` });
  return out;
}

/** Walk the batches breadth-first from the sales through the ingredients, calling `visit` once per (batch, path). */
function walk(sales: readonly BackwardSale[], origins: ReadonlyMap<string, BatchOrigin>, visit: (v: Visit, origin: BatchOrigin | undefined) => void, tooDeep: (v: Visit) => void): void {
  const queue = startingVisits(sales);
  const seen = new Set<string>();
  while (queue.length > 0) {
    const v = queue.shift()!;
    const key = `${v.batchId}|${v.from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const origin = origins.get(v.batchId);
    visit(v, origin);
    if (origin === undefined) continue;
    for (const run of origin.madeBy) {
      for (const input of run.inputBatchIds) {
        if (input === v.batchId) continue; // a run that lists its own output as an input is not a road back
        const next: Visit = { batchId: input, depth: v.depth + 1, from: `ingredient of batch ${v.batchId} (run ${run.runId})` };
        if (next.depth > MAX_INGREDIENT_DEPTH) { tooDeep(next); continue; }
        queue.push(next);
      }
    }
  }
}

/**
 * The batches the walk needs the origin of and does not have yet. The caller fetches these and asks again until the
 * answer is empty (each round reaches one more step back through the ingredients, up to `MAX_INGREDIENT_DEPTH`).
 */
export function batchesStillToFetch(sales: readonly BackwardSale[], origins: ReadonlyMap<string, BatchOrigin>): readonly string[] {
  const missing = new Set<string>();
  walk(sales, origins, (v, origin) => { if (origin === undefined) missing.add(v.batchId); }, () => {});
  return [...missing].sort();
}

/** Fold the sales and their batches' origins into the backward trace. */
export function buildBackwardTrace(input: {
  readonly sales: readonly BackwardSale[];
  readonly origins: ReadonlyMap<string, BatchOrigin>;
}): BackwardTrace {
  const gaps: string[] = [];
  for (const s of input.sales) {
    for (const l of s.lines) {
      if (l.batches.length === 0) {
        gaps.push(`sale ${s.saleId}: which batch of ${l.productId} was sold is not known — the till recorded none and head office holds no received batch of it to estimate from`);
      } else if (l.batches.some((b) => b.knownBy === 'fifo_estimate')) {
        gaps.push(`sale ${s.saleId}: the batch of ${l.productId} is a FIFO estimate, not a till record`);
      }
    }
  }

  const byBatch = new Map<string, { depth: number; from: string[]; origin: BatchOrigin | undefined }>();
  const tooDeep = new Set<string>();
  walk(input.sales, input.origins, (v, origin) => {
    const held = byBatch.get(v.batchId);
    if (held === undefined) byBatch.set(v.batchId, { depth: v.depth, from: [v.from], origin });
    else {
      held.depth = Math.min(held.depth, v.depth);
      if (!held.from.includes(v.from)) held.from.push(v.from);
    }
  }, (v) => tooDeep.add(`${v.batchId} (${v.from})`));

  const batches: BackwardBatch[] = [];
  const suppliers = new Map<string, { batchIds: Set<string>; references: Set<string> }>();
  for (const [batchId, b] of [...byBatch.entries()].sort((x, y) => x[1].depth - y[1].depth || (x[0] < y[0] ? -1 : 1))) {
    const origin = b.origin;
    if (origin === undefined) {
      gaps.push(`batch ${batchId}: nothing about it is on record at head office — where it came from is not known`);
      batches.push({ batchId, depth: b.depth, reachedFrom: b.from, productIds: [], receipts: [], madeBy: [] });
      continue;
    }
    if (origin.receipts.length === 0 && origin.madeBy.length === 0) {
      gaps.push(`batch ${batchId}: no receipt and no production of it is on record — where it came from is not known`);
    }
    const receipts = origin.receipts.map((r) => {
      const reference = r.grnId === null ? `movement ${r.movementId ?? 'not known'}` : `GRN ${r.grnNumber ?? r.grnId}${r.poId === null ? '' : ` (PO ${r.poId})`}`;
      if (r.grnId === null) gaps.push(`batch ${batchId}: ${r.quantityMinor} received at ${r.locationId} on ${r.receivedAt.slice(0, 10)} with no goods-receipt note — the supplier is not known`);
      else if (r.supplierId === null) gaps.push(`batch ${batchId}: goods receipt ${r.grnNumber ?? r.grnId} names no purchase order, so its supplier is not known`);
      if (r.supplierId !== null) {
        const s = suppliers.get(r.supplierId) ?? { batchIds: new Set<string>(), references: new Set<string>() };
        s.batchIds.add(batchId);
        s.references.add(reference);
        suppliers.set(r.supplierId, s);
      }
      return { reference, supplierId: r.supplierId, poId: r.poId, locationId: r.locationId, receivedAt: r.receivedAt, quantityMinor: r.quantityMinor };
    });
    for (const run of origin.madeBy) {
      if (!run.inputsRecorded) gaps.push(`batch ${batchId}: production run ${run.runId} made it before runs kept their ingredient batches — its ingredients, and their suppliers, are not known`);
      else if ((run.inputsWithoutBatch ?? 0) > 0) gaps.push(`batch ${batchId}: production run ${run.runId} used ${run.inputsWithoutBatch} ingredient(s) with no batch recorded — where those came from is not known`);
    }
    batches.push({
      batchId, depth: b.depth, reachedFrom: b.from,
      productIds: [...new Set(origin.receipts.map((r) => r.productId))].sort(),
      receipts, madeBy: origin.madeBy,
    });
  }
  for (const t of [...tooDeep].sort()) {
    gaps.push(`the walk back stopped at ${MAX_INGREDIENT_DEPTH} steps of ingredients — ${t} was not followed further`);
  }

  return {
    sales: input.sales,
    batches,
    suppliers: [...suppliers.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([supplierId, s]) => ({ supplierId, batchIds: [...s.batchIds].sort(), references: [...s.references].sort() })),
    gaps,
    complete: gaps.length === 0 && input.sales.length > 0,
  };
}
