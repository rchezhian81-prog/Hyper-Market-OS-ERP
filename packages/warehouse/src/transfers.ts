// Warehouse-to-store allocation and inter-store transfers (M09-FR-03 / WF-07).
//
// A transfer is the one stock movement that is in two places at once, and that is
// exactly where shops lose it. Stock leaves the warehouse on Monday and arrives at
// the branch on Wednesday. If the system deducts it at dispatch and adds it at
// receipt with nothing in between, then for two days it exists NOWHERE — invisible
// to counts, to availability, to the auditor. If instead it is deducted only on
// receipt, it exists TWICE.
//
// So a transfer moves through an explicit **in-transit** state held at the
// destination: visible, owned, and deliberately **not sellable** until it is
// received (M08-FR-02). The van is a place.
//
// Two refusals that matter more than they look:
//   • QUARANTINED, EXPIRED OR RECALLED STOCK IS NEVER TRANSFERRED. Moving a problem
//     to another branch does not solve it; it launders it, and the receiving branch
//     has no idea.
//   • A RECEIPT SHORTFALL IS A VALUED EXCEPTION, not a silent adjustment. Stock that
//     left one place and never arrived at another is either a miscount or a theft,
//     and both need a name against them.
//
// Allocation is advisory until approved (§28): the system proposes, a person decides.
//
// Pure and deterministic: timestamps injected, no clock.

import type { Money } from '../../contracts/src/money';
import type { StockMovement } from '../../stock/src/position';

export type TransferState =
  | 'proposed'
  | 'approved'
  | 'dispatched'
  | 'in_transit'
  | 'received'
  | 'cancelled';

export interface TransferLine {
  readonly productId: string;
  readonly batchId: string | null;
  readonly quantityMinor: number;
  readonly uom: string;
  /** Value, so a discrepancy on arrival can be priced (P-03). */
  readonly unitCost: Money;
}

export interface Transfer {
  readonly transferId: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly lines: readonly TransferLine[];
  readonly state: TransferState;
  readonly requestedBy: string;
  readonly approvedBy?: string;
  readonly dispatchedAt?: string;
  readonly receivedAt?: string;
}

export interface TransferApproval {
  readonly subjectRef: string;
  readonly status: 'approved' | 'rejected' | 'pending';
  readonly decidedBy: string;
}

export class TransferRefusedError extends Error {
  constructor(
    public readonly transferId: string,
    public readonly why: string,
  ) {
    super(`Transfer "${transferId}" refused: ${why}`);
    this.name = 'TransferRefusedError';
  }
}

/** Stock a line is drawn from, with the state it is in. */
export interface AvailableLot {
  readonly productId: string;
  readonly batchId: string | null;
  readonly quantityMinor: number;
  readonly state: 'on_hand' | 'quarantine' | 'expired' | 'damaged';
  readonly recalled?: boolean;
}

const NOT_TRANSFERABLE = ['quarantine', 'expired', 'damaged'] as const;

/**
 * Dispatch an approved transfer: stock leaves the source and becomes **in-transit at
 * the destination** — present, visible, and not sellable.
 */
export function dispatchTransfer(input: {
  readonly transfer: Transfer;
  readonly approval?: TransferApproval;
  readonly available: readonly AvailableLot[];
  readonly at: string;
}): { readonly transfer: Transfer; readonly movements: readonly StockMovement[] } {
  const { transfer } = input;

  if (transfer.state !== 'proposed' && transfer.state !== 'approved') {
    throw new TransferRefusedError(transfer.transferId, `it is already ${transfer.state}`);
  }
  if (transfer.fromLocationId === transfer.toLocationId) {
    throw new TransferRefusedError(transfer.transferId, 'a transfer to the same place is not a transfer');
  }
  if (transfer.lines.length === 0) {
    throw new TransferRefusedError(transfer.transferId, 'it moves nothing');
  }

  const approved =
    input.approval?.status === 'approved' &&
    input.approval.subjectRef === transfer.transferId &&
    input.approval.decidedBy !== transfer.requestedBy;
  if (!approved) {
    // Allocation recommends; a person decides (§28).
    throw new TransferRefusedError(
      transfer.transferId,
      'a transfer needs approval from someone other than the person who requested it',
    );
  }

  for (const line of transfer.lines) {
    const lots = input.available.filter(
      (l) => l.productId === line.productId && l.batchId === line.batchId,
    );
    const blocked = lots.find(
      (l) => l.recalled === true || NOT_TRANSFERABLE.includes(l.state as (typeof NOT_TRANSFERABLE)[number]),
    );
    if (blocked) {
      // Moving a problem to another branch does not solve it; it launders it.
      throw new TransferRefusedError(
        transfer.transferId,
        `${line.productId} is ${blocked.recalled === true ? 'recalled' : blocked.state} — sending it to another branch moves the problem, it does not solve it`,
      );
    }
    const sellable = lots
      .filter((l) => l.state === 'on_hand')
      .reduce((sum, l) => sum + l.quantityMinor, 0);
    if (sellable < line.quantityMinor) {
      throw new TransferRefusedError(
        transfer.transferId,
        `only ${sellable} of ${line.productId} available to send, not ${line.quantityMinor}`,
      );
    }
  }

  const movements: StockMovement[] = transfer.lines.flatMap((line, i) => [
    {
      movementId: `${transfer.transferId}-out-${i + 1}`,
      productId: line.productId,
      locationId: transfer.fromLocationId,
      batchId: line.batchId,
      from: 'on_hand' as const,
      to: null,
      quantityMinor: line.quantityMinor,
      uom: line.uom,
      at: input.at,
      reason: `transfer ${transfer.transferId} dispatched to ${transfer.toLocationId}`,
    },
    {
      movementId: `${transfer.transferId}-transit-${i + 1}`,
      productId: line.productId,
      // In transit AT THE DESTINATION: the van is a place, and the branch can see
      // what is coming without being able to sell it.
      locationId: transfer.toLocationId,
      batchId: line.batchId,
      from: null,
      to: 'in_transit' as const,
      quantityMinor: line.quantityMinor,
      uom: line.uom,
      at: input.at,
      reason: `transfer ${transfer.transferId} in transit from ${transfer.fromLocationId}`,
    },
  ]);

  return {
    transfer: { ...transfer, state: 'in_transit', approvedBy: input.approval?.decidedBy, dispatchedAt: input.at },
    movements,
  };
}

export interface TransferDiscrepancy {
  readonly productId: string;
  readonly batchId: string | null;
  readonly dispatchedMinor: number;
  readonly receivedMinor: number;
  readonly differenceMinor: number;
  readonly value: Money;
  readonly detail: string;
}

export interface ReceiveTransferResult {
  readonly transfer: Transfer;
  readonly movements: readonly StockMovement[];
  /** Valued, owned, and never a silent adjustment. */
  readonly discrepancies: readonly TransferDiscrepancy[];
}

/**
 * Receive a transfer at the destination: in-transit becomes on-hand for what
 * actually arrived, and anything missing becomes a valued exception rather than
 * quietly disappearing.
 */
export function receiveTransfer(input: {
  readonly transfer: Transfer;
  /** What the receiving branch actually counted, per product+batch. */
  readonly counted: readonly { readonly productId: string; readonly batchId: string | null; readonly quantityMinor: number }[];
  readonly receivedBy: string;
  readonly at: string;
  readonly currency: Money['currency'];
}): ReceiveTransferResult {
  const { transfer } = input;
  if (transfer.state !== 'in_transit') {
    throw new TransferRefusedError(transfer.transferId, `it is ${transfer.state}, not in transit`);
  }

  const movements: StockMovement[] = [];
  const discrepancies: TransferDiscrepancy[] = [];

  transfer.lines.forEach((line, i) => {
    const counted =
      input.counted.find((c) => c.productId === line.productId && c.batchId === line.batchId)
        ?.quantityMinor ?? 0;
    const arrived = Math.min(counted, line.quantityMinor);

    if (arrived > 0) {
      movements.push({
        movementId: `${transfer.transferId}-recv-${i + 1}`,
        productId: line.productId,
        locationId: transfer.toLocationId,
        batchId: line.batchId,
        from: 'in_transit',
        to: 'on_hand',
        quantityMinor: arrived,
        uom: line.uom,
        at: input.at,
        reason: `transfer ${transfer.transferId} received by ${input.receivedBy}`,
      });
    }

    const difference = counted - line.quantityMinor;
    if (difference !== 0) {
      // Stock that left one place and never arrived at another is a miscount or a
      // theft. Both need a name against them.
      const missing = Math.abs(difference);
      discrepancies.push({
        productId: line.productId,
        batchId: line.batchId,
        dispatchedMinor: line.quantityMinor,
        receivedMinor: counted,
        differenceMinor: difference,
        value: { minor: line.unitCost.minor * missing, currency: input.currency },
        detail:
          difference < 0
            ? `${missing} left ${transfer.fromLocationId} and did not arrive — a miscount or a loss, and it needs an owner`
            : `${missing} more arrived than were dispatched — the source count was wrong`,
      });

      // What never arrived cannot stay in transit for ever; it is written out of
      // transit and carried as the exception above, never silently forgotten.
      if (difference < 0) {
        movements.push({
          movementId: `${transfer.transferId}-shortfall-${i + 1}`,
          productId: line.productId,
          locationId: transfer.toLocationId,
          batchId: line.batchId,
          from: 'in_transit',
          to: null,
          quantityMinor: missing,
          uom: line.uom,
          at: input.at,
          reason: `transfer ${transfer.transferId} shortfall — raised as an exception, not absorbed`,
        });
      }
    }
  });

  return {
    transfer: { ...transfer, state: 'received', receivedAt: input.at },
    movements,
    discrepancies,
  };
}

export interface AllocationNeed {
  readonly locationId: string;
  readonly productId: string;
  /** How much the location is short of its target. */
  readonly shortfallMinor: number;
  /** Rate of sale, used to prioritise who needs it most. */
  readonly dailyDemandMinor?: number;
}

export interface AllocationProposal {
  readonly productId: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly quantityMinor: number;
  /** Days of cover this gives the destination — the reason it was chosen. */
  readonly daysOfCover: number | null;
  readonly detail: string;
}

/**
 * Propose how to spread scarce warehouse stock across stores. **Advisory only** —
 * nothing moves until a person approves it (§28, and hard rule #5's principle).
 *
 * When there is not enough for everyone, it allocates by DAYS OF COVER rather than
 * by raw shortfall: giving 100 units to a shop that sells 5 a day while a shop
 * selling 50 gets nothing is how one branch drowns while another runs dry.
 */
export function proposeAllocation(input: {
  readonly productId: string;
  readonly fromLocationId: string;
  readonly availableMinor: number;
  readonly needs: readonly AllocationNeed[];
}): readonly AllocationProposal[] {
  const needs = input.needs.filter((n) => n.productId === input.productId && n.shortfallMinor > 0);
  const totalShortfall = needs.reduce((s, n) => s + n.shortfallMinor, 0);

  if (totalShortfall <= input.availableMinor) {
    return needs.map((need) => ({
      productId: input.productId,
      fromLocationId: input.fromLocationId,
      toLocationId: need.locationId,
      quantityMinor: need.shortfallMinor,
      daysOfCover:
        need.dailyDemandMinor === undefined || need.dailyDemandMinor === 0
          ? null
          : Math.round((need.shortfallMinor / need.dailyDemandMinor) * 10) / 10,
      detail: 'enough for everyone — full shortfall allocated',
    }));
  }

  // Scarce: share by demand so every branch gets a similar number of days, rather
  // than a similar number of units.
  const demandTotal = needs.reduce((s, n) => s + (n.dailyDemandMinor ?? 1), 0);
  let remaining = input.availableMinor;
  const proposals: AllocationProposal[] = [];

  const ordered = [...needs].sort((a, b) => (b.dailyDemandMinor ?? 1) - (a.dailyDemandMinor ?? 1));
  ordered.forEach((need, index) => {
    const share =
      index === ordered.length - 1
        ? remaining // the last one absorbs the rounding, so nothing is stranded
        : Math.min(
            need.shortfallMinor,
            Math.floor((input.availableMinor * (need.dailyDemandMinor ?? 1)) / demandTotal),
          );
    const quantity = Math.max(0, Math.min(share, remaining, need.shortfallMinor));
    remaining -= quantity;
    if (quantity > 0) {
      proposals.push({
        productId: input.productId,
        fromLocationId: input.fromLocationId,
        toLocationId: need.locationId,
        quantityMinor: quantity,
        daysOfCover:
          need.dailyDemandMinor === undefined || need.dailyDemandMinor === 0
            ? null
            : Math.round((quantity / need.dailyDemandMinor) * 10) / 10,
        detail: 'not enough for everyone — shared by rate of sale, so each branch gets similar days of cover',
      });
    }
  });

  return proposals;
}
