// OB-35 "A" (owner, 10 Oct 2026) — the lot at the till. The till does not scan a batch, so when a sale reaches head office
// each line of a batch-tracked product that arrived WITHOUT a batch is ASSIGNED to the earliest-expiry batch on hand at
// that store (FEFO), from Batch 2's one batch-aware read (`fefoBatchesAt` over `projectBatches` — called, never forked).
//
//   • The assignment is RECORDED ON THE SALE for recall tracing, and marked as an assignment (`batchAssigned: 'fefo'`),
//     never passed off as a scan.
//   • A line larger than the first batch is split across batches in FEFO order (each part priced at the line's own unit
//     price, the last part taking the remainder so the line total is unchanged to the paise); two lines of the same
//     product draw the batches down in turn, so no unit is assigned twice.
//   • Units no batch on hand can cover stay on a part WITHOUT a batch — the `batch_tracked_sold_without_batch` finding
//     still fires for them (P-08, hard rule #10). A line the till DID give a batch is never touched.
//
// Pure and deterministic: the caller supplies the batches and whether a product is batch-tracked.

import type { IncomingSale, IncomingSaleLine } from './sale-intake';

export interface LotOnHand {
  readonly batchId: string | null;
  readonly onHandMinor: number;
  readonly expiry?: string;
}

const hasBatch = (l: IncomingSaleLine): boolean => typeof l.batchId === 'string' && l.batchId.trim() !== '';

export function assignSaleLots(
  sale: IncomingSale,
  isBatchTracked: (productId: string) => boolean,
  lotsFor: (productId: string) => readonly LotOnHand[],
): { readonly sale: IncomingSale; readonly assigned: number } {
  const left = new Map<string, Map<string, number>>(); // productId → batchId → units still unassigned on hand
  const order = new Map<string, readonly LotOnHand[]>();
  const lots = (productId: string): readonly LotOnHand[] => {
    if (!order.has(productId)) {
      const named = lotsFor(productId).filter((b): b is LotOnHand & { batchId: string } => b.batchId !== null && b.onHandMinor > 0);
      order.set(productId, named);
      left.set(productId, new Map(named.map((b) => [b.batchId!, b.onHandMinor] as const)));
    }
    return order.get(productId)!;
  };

  let assigned = 0;
  const lines: IncomingSaleLine[] = [];
  for (const line of sale.lines) {
    if (hasBatch(line) || !isBatchTracked(line.productId) || !Number.isSafeInteger(line.quantityMinor) || line.quantityMinor <= 0) {
      lines.push(line);
      continue;
    }
    const available = lots(line.productId);
    const free = left.get(line.productId)!;
    const parts: { qty: number; lot?: LotOnHand }[] = [];
    let need = line.quantityMinor;
    for (const lot of available) {
      if (need <= 0) break;
      const take = Math.min(free.get(lot.batchId!) ?? 0, need);
      if (take <= 0) continue;
      free.set(lot.batchId!, (free.get(lot.batchId!) ?? 0) - take);
      parts.push({ qty: take, lot });
      need -= take;
    }
    if (parts.length === 0) {
      lines.push(line);
      continue;
    }
    if (need > 0) parts.push({ qty: need });
    let pricedSoFar = 0;
    parts.forEach((p, i) => {
      const last = i === parts.length - 1;
      const total = last ? line.lineTotalMinor - pricedSoFar : Math.round((line.lineTotalMinor * p.qty) / line.quantityMinor);
      pricedSoFar += total;
      const { batchId: _b, batchExpiry: _e, ...rest } = line;
      void _b; void _e;
      lines.push({
        ...rest, quantityMinor: p.qty, lineTotalMinor: total,
        ...(p.lot === undefined ? {} : {
          batchId: p.lot.batchId!, ...(p.lot.expiry === undefined ? {} : { batchExpiry: p.lot.expiry }), batchAssigned: 'fefo' as const,
        }),
      });
      if (p.lot !== undefined) assigned += 1;
    });
  }
  return { sale: assigned === 0 ? sale : { ...sale, lines }, assigned };
}
