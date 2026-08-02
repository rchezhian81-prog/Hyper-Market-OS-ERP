// Local sale commit (hard rule #1) — the heart of the POS transaction: a core
// sale never depends on a network call, so it commits LOCALLY first, then syncs
// idempotently. This composes the foundation: tender settlement (must be fully
// paid), the append-only stock ledger (stock moves committed locally), and the
// sync outbox (the sale queued for the cloud). Idempotent on the sale id, so a
// retried commit collapses to one effect (§31.1). Pure orchestration — the ledger
// and outbox are injected; no I/O of its own.

import { makeEvent } from '../../contracts/src/event';
import type { Money } from '../../contracts/src/money';
import { settle, type Tender } from '../../tender/src/tender';
import type { Ledger } from '../../ledger/src/ledger';
import type { SyncOutbox } from '../../sync/src/outbox';

export interface SaleLineInput {
  readonly productId: string;
  /** Quantity sold, in the UOM's smallest unit (magnitude; stock decreases by this). */
  readonly quantityMinor: number;
  readonly uom: string;
}

export interface CommitSaleInput {
  readonly id: string;
  readonly number: string;
  readonly laneId: string;
  readonly cashierId: string;
  readonly tradingDay: string;
  /** ISO-8601 UTC commit time (injected). */
  readonly committedAt: string;
  readonly total: Money;
  readonly lines: readonly SaleLineInput[];
  readonly tenders: readonly Tender[];
}

export interface CommittedSale {
  readonly id: string;
  readonly number: string;
  readonly laneId: string;
  readonly cashierId: string;
  readonly tradingDay: string;
  readonly committedAt: string;
  readonly total: Money;
  readonly changeDue: Money;
}

export class UnpaidSaleError extends Error {
  constructor(id: string) {
    super(`Sale "${id}" is not fully paid and cannot be committed.`);
    this.name = 'UnpaidSaleError';
  }
}

/**
 * Commit a POS sale locally and durably, then queue it for sync. The sale must be
 * fully paid (settled tenders cover the total — no fake approval). Stock movements
 * are appended to the local stock ledger and the sale is enqueued to the outbox,
 * all without a network call (hard rule #1). Idempotent on the sale id.
 */
export function commitSale(
  input: CommitSaleInput,
  stockLedger: Ledger,
  outbox: SyncOutbox,
): CommittedSale {
  const settlement = settle(input.total, input.tenders);
  if (!settlement.fullyPaid) {
    throw new UnpaidSaleError(input.id);
  }

  for (const line of input.lines) {
    stockLedger.append(
      makeEvent({
        id: `${input.id}:move:${line.productId}`,
        type: 'InventoryMoved',
        occurredAt: input.committedAt,
        idempotencyKey: `sale-move:${input.id}:${line.productId}`,
        source: input.laneId,
        payload: {
          productId: line.productId,
          deltaMinor: -Math.abs(line.quantityMinor),
          uom: line.uom,
        },
      }),
    );
  }

  outbox.enqueue(
    makeEvent({
      id: `${input.id}:committed`,
      type: 'SaleCommitted',
      occurredAt: input.committedAt,
      idempotencyKey: `sale:${input.id}`,
      source: input.laneId,
      payload: {
        saleId: input.id,
        number: input.number,
        laneId: input.laneId,
        cashierId: input.cashierId,
        tradingDay: input.tradingDay,
        totalMinor: input.total.minor,
        currency: input.total.currency,
      },
    }),
  );

  return Object.freeze({
    id: input.id,
    number: input.number,
    laneId: input.laneId,
    cashierId: input.cashierId,
    tradingDay: input.tradingDay,
    committedAt: input.committedAt,
    total: input.total,
    changeDue: settlement.changeDue,
  });
}
