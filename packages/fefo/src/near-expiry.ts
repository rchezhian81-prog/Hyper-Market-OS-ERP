// Near-expiry stock (M10-FR-01 · A03 "Inventory" · ADR-0015) — which batches now on hand are close enough
// to expiry to act on, and the recommended action (markdown / dispose).
//
// This composes two already-tested engines, so there is one definition of each rule:
//   • `attributeSalesFifo` (ADR-0006) — the FIFO-by-receipt proxy that estimates how much of each batch has
//     already SOLD, so we work with what is still ON HAND rather than what was ever received;
//   • `expiryActions` — the expired→dispose / near-expiry→markdown decision over batches with a real expiry.
//
// The expiry itself is the batch's real expiry, now that the cloud ledger persists it (ADR-0015). Net
// on-hand per batch is `received − FIFO-attributed-sold − wasted`, floored at zero and honest about the
// proxy: it is an estimate of which batch stock remains (ADR-0006 OD-BATCH-02), not a forensic per-batch
// count. A batch already fully sold, wasted, or with no expiry recorded simply does not appear.
//
// Pure and deterministic: no clock, no I/O — the receipts/sales/wastage go in, the action list comes out.

import { attributeSalesFifo, type HistoricalSaleLine } from './attribute-sales';
import { expiryActions, type Batch, type ExpiryActionItem } from './fefo';

/** A received batch as the stock ledger now records it (ADR-0015 adds the expiry). */
export interface ReceiptWithExpiry {
  readonly batchId: string;
  readonly productId: string;
  readonly receivedDate: string; // YYYY-MM-DD
  /** The batch's expiry, "YYYY-MM-DD". A receipt with no expiry is not expiry-trackable and is skipped. */
  readonly expiry?: string;
  readonly qty: number; // whole units received
}

/** A sale line for attribution — the historical line PLUS the product it was for (to group per product). */
export type SaleForNetOnHand = HistoricalSaleLine & { readonly productId: string };

/**
 * The near-expiry action list over the CURRENT (net-of-sales) on-hand stock.
 *
 * @param receipts every received batch with its expiry (ADR-0015). Receipts of one batch on several dates
 *   accumulate; the batch's expiry is taken as the EARLIEST recorded (the most conservative — act sooner).
 * @param sales the batch-tracked sale lines, per product, used only to estimate what has already sold
 *   (FIFO-by-receipt, ADR-0006). Non-batch-tracked lines are ignored by the attribution engine.
 * @param wastage batches (or parts) already written off — subtracted from on hand so a wasted batch is not
 *   re-flagged.
 * @param asOf the reference date ("YYYY-MM-DD").
 * @param nearExpiryDays a batch expiring within this many days is flagged for markdown (expired → dispose).
 */
export function nearExpiryStock(input: {
  readonly receipts: readonly ReceiptWithExpiry[];
  readonly sales: readonly SaleForNetOnHand[];
  readonly wastage?: readonly { readonly batchId: string; readonly qty: number }[];
  readonly asOf: string;
  readonly nearExpiryDays: number;
}): ExpiryActionItem[] {
  // Received total + conservative (earliest) expiry per batch, and its product (for per-product attribution).
  const received = new Map<string, number>();
  const expiryOf = new Map<string, string>();
  const productOf = new Map<string, string>();
  for (const r of input.receipts) {
    received.set(r.batchId, (received.get(r.batchId) ?? 0) + r.qty);
    productOf.set(r.batchId, r.productId);
    if (r.expiry !== undefined && r.expiry !== '') {
      const prior = expiryOf.get(r.batchId);
      if (prior === undefined || r.expiry < prior) expiryOf.set(r.batchId, r.expiry);
    }
  }

  // Net on-hand per batch after sales, with the tested FIFO-by-receipt proxy, one product at a time (that is
  // the unit `attributeSalesFifo` reasons over). We read `remainingByBatch` — net of BOTH captured-batch lines
  // (a sale that named its batch) and FIFO-estimated lines — not `estimates`, which omits captured consumption.
  // A product with no batch-tracked sales simply leaves its batches at their received quantity.
  const products = new Set<string>([...input.receipts.map((r) => r.productId), ...input.sales.map((s) => s.productId)]);
  const remainingOf = new Map<string, number>();
  for (const productId of products) {
    const productReceipts = input.receipts
      .filter((r) => r.productId === productId)
      .map((r) => ({ batchId: r.batchId, receivedDate: r.receivedDate, qty: r.qty }));
    if (productReceipts.length === 0) continue;
    const productSales = input.sales.filter((s) => s.productId === productId);
    const { remainingByBatch } = attributeSalesFifo({ receipts: productReceipts, sales: productSales });
    for (const [batchId, qty] of remainingByBatch) remainingOf.set(batchId, qty);
  }

  const wastedOf = new Map<string, number>();
  for (const w of input.wastage ?? []) wastedOf.set(w.batchId, (wastedOf.get(w.batchId) ?? 0) + w.qty);

  // Net on-hand per batch, then the expiry decision over the batches that still have an expiry and stock.
  const batches: Batch[] = [];
  for (const [batchId, receivedQty] of received) {
    const expiry = expiryOf.get(batchId);
    if (expiry === undefined) continue; // no expiry recorded → not expiry-trackable
    const afterSales = remainingOf.has(batchId) ? (remainingOf.get(batchId) ?? 0) : receivedQty;
    const net = afterSales - (wastedOf.get(batchId) ?? 0);
    if (net <= 0) continue; // sold through / wasted — nothing on hand to act on
    batches.push({ batchId, productId: productOf.get(batchId) ?? '', qty: net, expiry });
  }

  return expiryActions(batches, input.asOf, input.nearExpiryDays);
}
