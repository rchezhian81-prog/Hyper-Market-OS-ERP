// Head-office batch attribution for sales that reached the cloud with no batch captured (roadmap
// M10-FR-03, batch-on-sale inc3b; ADR-0006). The owner's ratified choice: head office assigns the
// most-likely batch to a batch-tracked sale that arrived without one, as a labelled ESTIMATE — never
// mistaken for a batch a till actually scanned, and never written back onto the sale (hard rule #2).
//
// ADR-0006 finding: the cloud's stock ledger carries a batch's receipt date but NOT its expiry, so the
// estimate is First-In-First-Out **by receipt date** (earliest-received on-hand batch first) as the proxy
// for FEFO — the two coincide when oldest-expiry stock is received first, the normal case. Every estimate
// carries `basis: 'fifo_receipt_estimate'`.
//
// It replays one product's timeline — receipts and its batch-tracked sales, in date order — maintaining
// per-batch on-hand: a receipt adds stock; a sale that DID capture a batch consumes that named batch (so
// it does not distort the estimate for the others); a sale with NO captured batch consumes FIFO and is
// attributed those batch(es). A sale that cannot be covered by any recorded batch is left with an
// `unattributedQty` — honest about the units head office cannot place (P-08), never invented.
//
// Pure and deterministic — no clock, no I/O; the timeline goes in, the estimates come out.

export interface BatchReceipt {
  readonly batchId: string;
  readonly receivedDate: string; // YYYY-MM-DD
  readonly qty: number;          // whole units received
}

export interface HistoricalSaleLine {
  readonly saleId: string;
  readonly soldDate: string;     // YYYY-MM-DD
  readonly qty: number;          // whole units
  readonly batchTracked: boolean;
  /** The batch the till captured, if any. A captured line is NOT estimated; it just consumes its batch. */
  readonly capturedBatchId?: string;
}

export interface SaleBatchEstimate {
  readonly saleId: string;
  readonly soldDate: string;
  readonly batchId: string;
  readonly qty: number;
  readonly basis: 'fifo_receipt_estimate';
}

export interface AttributionResult {
  /** One entry per (un-captured batch-tracked sale line × batch it was estimated to draw). */
  readonly estimates: readonly SaleBatchEstimate[];
  /** Whole units across all un-captured batch-tracked sales that no recorded batch could cover. */
  readonly unattributedQty: number;
}

export class InvalidAttribution extends Error {
  constructor(detail: string) {
    super(`Cannot attribute sale batches: ${detail}`);
    this.name = 'InvalidAttribution';
  }
}

const isDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));
const isNonNegInt = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;
const isNonEmpty = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';

/**
 * Attribute a FIFO-by-receipt best-estimate batch to each un-captured batch-tracked sale of ONE product
 * (ADR-0006). Replays receipts + sales in date order; captured-batch sales consume their named batch,
 * un-captured batch-tracked sales consume FIFO and are estimated.
 *
 * @throws InvalidAttribution if a receipt/sale has a bad date or a non-whole/negative quantity, or a
 *   receipt has no batchId.
 */
export function attributeSalesFifo(input: {
  readonly receipts: readonly BatchReceipt[];
  readonly sales: readonly HistoricalSaleLine[];
}): AttributionResult {
  for (const r of input.receipts) {
    if (!isNonEmpty(r.batchId)) throw new InvalidAttribution('a receipt has no batchId');
    if (!isDate(r.receivedDate)) throw new InvalidAttribution(`a receipt has an invalid received date (${String(r.receivedDate)})`);
    if (!isNonNegInt(r.qty)) throw new InvalidAttribution('a receipt has a non-whole or negative quantity');
  }
  for (const s of input.sales) {
    if (!isNonEmpty(s.saleId)) throw new InvalidAttribution('a sale has no saleId');
    if (!isDate(s.soldDate)) throw new InvalidAttribution(`a sale has an invalid sold date (${String(s.soldDate)})`);
    if (!isNonNegInt(s.qty)) throw new InvalidAttribution('a sale has a non-whole or negative quantity');
  }

  // Per-batch remaining on hand, and each batch's receipt date (for FIFO order). Receipts of the same
  // batch on different dates accumulate; the batch's FIFO key is its EARLIEST receipt date.
  const remaining = new Map<string, number>();
  const receiptDate = new Map<string, string>();
  for (const r of input.receipts) {
    remaining.set(r.batchId, (remaining.get(r.batchId) ?? 0) + r.qty);
    const prior = receiptDate.get(r.batchId);
    if (prior === undefined || r.receivedDate < prior) receiptDate.set(r.batchId, r.receivedDate);
  }

  // Batches in FIFO order — earliest receipt date first, then batchId for a deterministic tie-break.
  const fifoOrder = (): string[] => [...remaining.keys()]
    .filter((b) => (remaining.get(b) ?? 0) > 0)
    .sort((a, b) => {
      const da = receiptDate.get(a)!;
      const db = receiptDate.get(b)!;
      return da.localeCompare(db) || a.localeCompare(b);
    });

  // Sales in date order (a stable sort keeps same-day sales in their given order).
  const sales = [...input.sales].sort((a, b) => a.soldDate.localeCompare(b.soldDate));

  const estimates: SaleBatchEstimate[] = [];
  let unattributedQty = 0;

  for (const sale of sales) {
    if (sale.qty === 0) continue;

    // A captured-batch line consumes its named batch (so it does not distort the estimate) and is NOT
    // estimated. Consume up to what that batch has; any excess simply is not drawn from the FIFO pool.
    if (isNonEmpty(sale.capturedBatchId)) {
      const have = remaining.get(sale.capturedBatchId) ?? 0;
      remaining.set(sale.capturedBatchId, Math.max(0, have - sale.qty));
      continue;
    }

    if (sale.batchTracked !== true) continue; // an ordinary line needs no batch

    // Un-captured batch-tracked line: draw FIFO and record the estimate.
    let need = sale.qty;
    for (const batchId of fifoOrder()) {
      if (need <= 0) break;
      const have = remaining.get(batchId) ?? 0;
      const take = Math.min(have, need);
      if (take <= 0) continue;
      estimates.push({ saleId: sale.saleId, soldDate: sale.soldDate, batchId, qty: take, basis: 'fifo_receipt_estimate' });
      remaining.set(batchId, have - take);
      need -= take;
    }
    if (need > 0) unattributedQty += need; // no recorded batch could cover it — said, not invented
  }

  return { estimates, unattributedQty };
}
