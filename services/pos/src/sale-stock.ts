// A sale is a stock movement (M08-FR-01): "a movement (receive/**sell**/transfer/adjust/return) appends an
// event with qty, sign, location, batch, reason, source id". Until this file existed a banked sale was a
// `SaleCommitted` on the sales stream and nothing else — on-hand, valuation and COGS never learned it had
// happened (hosted-demo finding H-13). These two pure functions turn a banked sale into the `sold` movements
// the inventory ledger folds, and are exercised by `tests/unit/sale-stock.test.ts` and
// `tests/integration/sale-reduces-stock.test.ts`.
//
// Nothing here can refuse a sale (hard rule #1): a line that cannot become a movement is skipped and the
// sale still banks; a location that cannot be derived is taken from the lane and SAID SO on the movement
// (P-08) — the shelf that has gone negative at a lane is then a visible exception, never a silent one.

import type { Movement } from '../../inventory/src/index';
import type { IncomingSale } from './sale-intake';

/** Where the sale's stock leaves from, and how that was decided — stated, never inferred later. */
export interface SaleStockLocation {
  readonly locationId: string;
  readonly basis: 'declared_by_lane' | 'store_of_pack' | 'assumed_from_lane';
}

/**
 * The location a sale draws stock from, in order of authority:
 *   1. the lane declared it (`sale.locationId`) — the lane knows where it stands;
 *   2. the store the sale's catalogue pack was published for — the sale was priced from that store;
 *   3. the lane itself — a stated assumption, so a single-site store with neither of the above still
 *      records the movement, and the negative on-hand it produces at the lane is a visible exception.
 */
export function resolveSaleStockLocation(sale: IncomingSale, packStoreId: string | undefined): SaleStockLocation {
  if (typeof sale.locationId === 'string' && sale.locationId.trim() !== '') {
    return { locationId: sale.locationId, basis: 'declared_by_lane' };
  }
  if (typeof packStoreId === 'string' && packStoreId.trim() !== '') {
    return { locationId: packStoreId, basis: 'store_of_pack' };
  }
  return { locationId: sale.laneId, basis: 'assumed_from_lane' };
}

/**
 * One `sold` movement per sale line, keyed on the sale and the line's position so a resent sale
 * collapses to the same movements (idempotent, M08-FR-01 acceptance: "replaying the same movement five
 * times yields one balance change"). The quantity is a magnitude; `kind` carries the direction. A line
 * whose quantity is not a positive whole number cannot be a movement and is skipped — the sale is still
 * a sale, and the intake's own findings say what was odd about it.
 */
export function saleStockMovements(sale: IncomingSale, location: SaleStockLocation): readonly Movement[] {
  const out: Movement[] = [];
  sale.lines.forEach((line, i) => {
    if (!Number.isInteger(line.quantityMinor) || line.quantityMinor <= 0) return;
    out.push({
      movementId: `sale-${sale.saleId}-${i}`,
      productId: line.productId,
      locationId: location.locationId,
      kind: 'sold',
      quantityMinor: line.quantityMinor,
      uom: line.uom,
      occurredAt: sale.committedAt,
      enteredBy: sale.cashierId,
      ...(typeof line.batchId === 'string' && line.batchId !== '' ? { batchId: line.batchId } : {}),
      ...(location.basis === 'assumed_from_lane'
        ? { reason: `stock location assumed from lane ${sale.laneId}: the sale declared none and its pack names no store` }
        : {}),
    });
  });
  return out;
}

/** The part of a recorded return these rules need — structural, so the returns service keeps its own type. */
export interface ReturnForStock {
  readonly returnId: string;
  readonly processedAt: string;
  readonly processedBy: string;
  readonly lines: readonly {
    readonly productId: string;
    readonly uom: string;
    readonly quantityMinor: number;
    readonly disposition: string;
    readonly batchId?: string | null;
    readonly batchExpiry?: string;
    readonly condition?: string;
  }[];
}

/**
 * PF-14 — returned goods that do NOT go back on the shelf, held where they came back: one record per quarantined,
 * damaged or scrap line, linked to its return and keeping its lot. Not on-hand (they cannot be sold), but never
 * invisible either: until a person disposes of them they are listed (P-08). Scrap is held too — destroyed goods still
 * have to be written off by somebody.
 */
export interface HeldReturnedStock {
  readonly heldId: string;
  readonly returnId: string;
  readonly lineIndex: number;
  readonly productId: string;
  readonly uom: string;
  readonly quantityMinor: number;
  readonly disposition: 'quarantine' | 'damaged' | 'scrap';
  readonly batchId: string | null;
  readonly batchExpiry: string | null;
  readonly condition: string | null;
  /** Where the goods came back — the shelf the original sale drew from; `null` when the return named no place. */
  readonly locationId: string | null;
  readonly heldAt: string;
  readonly heldBy: string;
}

export function heldReturnedStock(ret: ReturnForStock, location: SaleStockLocation | undefined): readonly HeldReturnedStock[] {
  const out: HeldReturnedStock[] = [];
  ret.lines.forEach((line, i) => {
    if (line.disposition !== 'quarantine' && line.disposition !== 'damaged' && line.disposition !== 'scrap') return;
    if (!Number.isInteger(line.quantityMinor) || line.quantityMinor <= 0) return;
    out.push({
      heldId: `held-${ret.returnId}-${i}`, returnId: ret.returnId, lineIndex: i,
      productId: line.productId, uom: line.uom, quantityMinor: line.quantityMinor, disposition: line.disposition,
      batchId: typeof line.batchId === 'string' && line.batchId !== '' ? line.batchId : null,
      batchExpiry: line.batchExpiry ?? null,
      condition: typeof line.condition === 'string' && line.condition !== '' ? line.condition : null,
      locationId: location?.locationId ?? null,
      heldAt: ret.processedAt, heldBy: ret.processedBy,
    });
  });
  return out;
}

/**
 * One inbound `returned` movement per RESOLD line of a return (M08-FR-01 names "return" among the
 * movements). Only `resell` puts goods back on the shelf: `quarantine`, `damaged` and `scrap` are held or
 * written off through their own governed paths (M08-FR-02 states, M10 quality hold, M28 write-off) and never
 * re-enter sellable on-hand here. Keyed on the return and the line, so a lane retrying an unconfirmed refund
 * appends the movements once. The location is the one the original sale drew from — the same rule, so what
 * left a shelf comes back to that shelf.
 */
export function returnStockMovements(ret: ReturnForStock, location: SaleStockLocation): readonly Movement[] {
  const out: Movement[] = [];
  ret.lines.forEach((line, i) => {
    if (line.disposition !== 'resell') return;
    if (!Number.isInteger(line.quantityMinor) || line.quantityMinor <= 0) return;
    out.push({
      movementId: `return-${ret.returnId}-${i}`,
      productId: line.productId,
      locationId: location.locationId,
      kind: 'returned',
      quantityMinor: line.quantityMinor,
      uom: line.uom,
      occurredAt: ret.processedAt,
      enteredBy: ret.processedBy,
      ...(typeof line.batchId === 'string' && line.batchId !== '' ? { batchId: line.batchId } : {}),
      ...(location.basis === 'assumed_from_lane'
        ? { reason: `stock location assumed from the original sale's lane (${location.locationId}): the sale declared none and its pack names no store` }
        : {}),
    });
  });
  return out;
}
