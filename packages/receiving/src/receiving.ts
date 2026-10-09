// Goods receiving (M07) — the inbound counterpart to the sale. Received stock is
// committed to the local append-only ledger (positive movements) and a
// GoodsReceived event is queued for sync. Queue-capable offline (§31); idempotent
// on the GRN id, so a retried receipt collapses to one effect (§31.1). Pure
// orchestration — the ledger and outbox are injected.

import { makeEvent } from '../../contracts/src/event';
import type { Ledger } from '../../ledger/src/ledger';
import type { SyncOutbox } from '../../sync/src/outbox';

export interface ReceiptLineInput {
  readonly productId: string;
  /** Quantity received, in the UOM's smallest unit (stock increases by this). */
  readonly quantityMinor: number;
  readonly uom: string;
  readonly batchId?: string | null;
  /**
   * Wave 3 · SF-07 part 2 — the arrival temperature the manager probed, °C, for chilled or frozen goods. Absent when not
   * taken: head office then holds a cold-chain line for a second person's check (owner decision 9 Oct 2026).
   */
  readonly temperatureC?: number;
}

export interface CommitReceiptInput {
  readonly id: string; // GRN id
  readonly number: string;
  readonly poId: string | null;
  readonly warehouseId: string;
  readonly receivedBy: string;
  readonly receivedAt: string; // ISO-8601 UTC
  readonly lines: readonly ReceiptLineInput[];
  /** Which store's screen booked it in (SP-2b) — carried to head office; absent means not stated. */
  readonly storeId?: string;
  /** Which surface booked it in, e.g. `manager-screen` (SP-2b). */
  readonly source?: string;
}

export interface CommittedReceipt {
  readonly id: string;
  readonly number: string;
  readonly poId: string | null;
  readonly warehouseId: string;
  readonly receivedBy: string;
  readonly receivedAt: string;
  readonly lineCount: number;
}

export class EmptyReceiptError extends Error {
  constructor(id: string) {
    super(`Receipt "${id}" has no lines.`);
    this.name = 'EmptyReceiptError';
  }
}

/**
 * Commit a goods receipt locally: append one inbound stock movement per line to
 * the stock ledger and queue a GoodsReceived event for sync — no network call.
 * Idempotent on the GRN id.
 */
export function commitReceipt(
  input: CommitReceiptInput,
  stockLedger: Ledger,
  outbox: SyncOutbox,
): CommittedReceipt {
  if (input.lines.length === 0) {
    throw new EmptyReceiptError(input.id);
  }

  for (const line of input.lines) {
    stockLedger.append(
      makeEvent({
        id: `${input.id}:move:${line.productId}`,
        type: 'InventoryMoved',
        occurredAt: input.receivedAt,
        idempotencyKey: `grn-move:${input.id}:${line.productId}`,
        source: input.warehouseId,
        payload: {
          productId: line.productId,
          deltaMinor: Math.abs(line.quantityMinor), // inbound: stock increases
          uom: line.uom,
          batchId: line.batchId ?? null,
        },
      }),
    );
  }

  outbox.enqueue(
    makeEvent({
      id: `${input.id}:received`,
      type: 'GoodsReceived',
      occurredAt: input.receivedAt,
      idempotencyKey: `grn:${input.id}`,
      source: input.warehouseId,
      // The WHOLE receipt travels (SP-2b): head office re-runs the receiving rules over these lines and re-verifies the
      // receiver — a thin `lineCount` gave it nothing to receive. Superset of the old shape, so nothing reading
      // `grnId` / `number` / `poId` / `lineCount` changes.
      payload: {
        grnId: input.id,
        number: input.number,
        poId: input.poId,
        lineCount: input.lines.length,
        warehouseId: input.warehouseId,
        receivedBy: input.receivedBy,
        receivedAt: input.receivedAt,
        lines: input.lines.map((l) => ({
          productId: l.productId, quantityMinor: l.quantityMinor, uom: l.uom, batchId: l.batchId ?? null,
          // Wave 3 · SF-07 part 2: the reading travels with the line; head office judges it against the product's limits.
          ...(l.temperatureC === undefined ? {} : { temperatureC: l.temperatureC }),
        })),
        storeId: input.storeId ?? null,
        source: input.source ?? 'receiving',
      },
    }),
  );

  return Object.freeze({
    id: input.id,
    number: input.number,
    poId: input.poId,
    warehouseId: input.warehouseId,
    receivedBy: input.receivedBy,
    receivedAt: input.receivedAt,
    lineCount: input.lines.length,
  });
}
