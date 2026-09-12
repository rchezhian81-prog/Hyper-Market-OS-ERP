// The till itself, as opposed to the sale — M13, M15, §27.
//
// Everything the lane does that is not ringing up a basket: money moving in and out of the drawer,
// a refund, and closing the shift at the end of the day. The rules already exist and are tested in
// `packages/cash`, `packages/returns` and `packages/till`; this composes them for one lane and
// hands the screen a surface that cannot express a rule of its own.
//
// ── The blind count, and why it is a type rather than a habit ───────────────
//
// **The cashier never sees the expected figure before they count.** Shown "expected: ₹12,400",
// people write ₹12,400 — not from dishonesty, but because a number on a screen is an answer and
// counting is work. The whole point of a cash-up is to find the difference, and a count anchored to
// the expectation finds nothing.
//
// So `expectedMinor` is not a method on this object. There is nothing to call, nothing to render
// early, and nothing for a later change to expose by accident: the variance only exists *after*
// `closeShift` has been given a counted figure, and it comes back as part of the result. That is
// the same control the stock count uses, and it is worth being structural in both places.
//
// ── The other rule with teeth ───────────────────────────────────────────────
//
// **A refund to a card is never assumed successful.** Cash and store credit settle at the lane
// immediately; a card or UPI refund is a reversal the provider has to perform, so it is `pending`
// and the customer is told that rather than shown a completed refund for money that has not moved.

import { money, type Money } from '../../../packages/contracts/src/money';
import { Ledger } from '../../../packages/ledger/src/ledger';
import { recordCashMovement, tillBalanceMinor, type CashMovementKind, type CommittedCashMovement } from '../../../packages/cash/src/cash';
import { assertReturnValid, commitReturn, type CommitReturnInput, type CommittedReturn } from '../../../packages/returns/src/returns';
import { closeShift, type CloseShiftInput, type ShiftCloseResult } from '../../../packages/till/src/till';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import type { CommitOutcome } from '../../../edge/store-edge/src/durability';

/**
 * The lane's durable write for a refund — post it to this till's own edge and wait for the answer,
 * exactly as a sale's `DurableWrite` does. Same-machine loopback, never a call off the till (ADR-0004).
 */
export type DurableReturnWrite = (returnId: string, record: string) => Promise<CommitOutcome>;

/** Thrown when the edge would not durably record a refund — so the cashier hands back no cash. */
export class LocalRefundRefusedError extends Error {
  constructor(returnId: string, readonly laneMessage: string) {
    super(`Return "${returnId}" could not be recorded durably at the lane: ${laneMessage}`);
    this.name = 'LocalRefundRefusedError';
  }
}

/**
 * Thrown when a refund id was already used for a DIFFERENT refund (RR-F03). This is not a lane
 * failure to retry — it is an explicit conflict: the same id cannot mean two different refunds, so
 * the cashier must not hand back cash and the id must be looked at. Distinct from
 * `LocalRefundRefusedError` so the screen and the caller can tell "try again" from "this is wrong".
 */
export class RefundConflictError extends Error {
  constructor(returnId: string, readonly laneMessage: string) {
    super(`Return "${returnId}" reuses an id that was already used for a different refund (M13, RR-F03).`);
    this.name = 'RefundConflictError';
  }
}

/**
 * Thrown when a refund would take back more of a line than the original sale sold, judged against
 * the edge's own trusted sale + return history rather than numbers the request supplied (RR-F04).
 * Explicit, so the screen can say "already refunded" rather than a generic failure — and so a caller
 * cannot mistake it for something to retry.
 */
export class RefundNotEntitledError extends Error {
  constructor(returnId: string, readonly laneMessage: string) {
    super(`Return "${returnId}" exceeds what the original sale entitles (M13-FR-01, RR-F04).`);
    this.name = 'RefundNotEntitledError';
  }
}

/**
 * Thrown when the lane could not CONFIRM whether a refund was recorded — a reply was lost, not a
 * refusal (RR-F02). It is deliberately distinct from `LocalRefundRefusedError`: a refusal means "it
 * did not happen, try elsewhere"; this means "it may or may not have happened — do not hand back cash
 * and do not run it again, resolve it first". Treating uncertainty as failure is what causes a second
 * refund for money that already went back.
 */
export class RefundUncertainError extends Error {
  constructor(returnId: string, readonly laneMessage: string) {
    super(`Return "${returnId}" could not be confirmed as recorded at the lane (RR-F02).`);
    this.name = 'RefundUncertainError';
  }
}

export interface TillConfig {
  readonly tillId: string;
  readonly laneId: string;
  readonly cashierId: string;
  readonly tradingDay: string;
  /** |over/short| at or above which the variance is material and needs a reason. Per-tenant. */
  readonly varianceToleranceMinor: number;
}

/** What a denomination count looks like on the screen: how many of each note or coin. */
export interface DenominationCount {
  readonly valueMinor: number;
  readonly count: number;
}

/**
 * Indian notes and coins in circulation, in paise, largest first — the order a drawer is counted in.
 *
 * ₹500, ₹200, ₹100, ₹50, ₹20, ₹10 as notes; ₹20, ₹10, ₹5, ₹2, ₹1 as coins. A denomination appears
 * once whether it exists as both, because the cashier counts value and not metal.
 */
export const DENOMINATIONS: readonly number[] = [
  50_000, 20_000, 10_000, 5_000, 2_000, 1_000, 500, 200, 100,
];

export function countTotalMinor(counts: readonly DenominationCount[]): number {
  return counts.reduce((total, row) => total + row.valueMinor * row.count, 0);
}

export interface TillSession {
  /** Money in or out of the drawer: a pickup to the safe, a float, a loan. */
  moveCash(input: {
    readonly kind: CashMovementKind;
    readonly amountMinor: number;
    readonly at: string;
    readonly performedBy?: string;
  }): CommittedCashMovement;

  /** What is in the drawer according to the movements recorded — never shown before a count. */
  drawerBalanceMinor(): number;

  /**
   * Refund a customer, durably. `pending` for card and UPI, because a reversal has not happened yet.
   *
   * Money leaves the drawer, so the order is the sale's order (§P-01, hard rule #1): **decide, then
   * record durably, then account for it locally.** The refund is validated first (an invalid one is
   * refused before anything is written), then written to this till's edge and awaited — and only if
   * the disk confirms is it committed to the local ledger and the cashier told to hand over cash. A
   * refused durable write throws `LocalRefundRefusedError`, so no cash is given for a refund the box
   * did not record. The edge queues it for the cloud; the cloud re-verifies the §28 approver on sync.
   */
  refund(input: Omit<CommitReturnInput, 'laneId' | 'processedBy'>): Promise<CommittedReturn>;

  /**
   * Close the shift against a **counted** figure.
   *
   * The expected total is not available anywhere before this call, deliberately. What comes back
   * carries the variance, whether it is material, and what the cashier must do about it.
   */
  close(input: {
    readonly shiftId: string;
    readonly closedAt: string;
    readonly openingFloatMinor: number;
    readonly cashSalesMinor: number;
    readonly pickupsMinor: number;
    readonly cashRefundsMinor: number;
    readonly countedMinor: number;
    readonly reasonCode?: string;
  }): ShiftCloseResult;
}

export function createTillSession(
  config: TillConfig,
  cashLedger: Ledger,
  /** Returned goods go back onto the shelf, or do not — so a refund touches stock (M13). */
  stockLedger: Ledger,
  outbox: SyncOutbox,
  /**
   * The refund's durable write to this till's edge (M13-FR-01). Its own port, the mirror of the
   * sale's `DurableWrite`: a refund is durable on the box's disk before it is called done, then the
   * edge syncs it to the cloud. Optional so a standalone/demo shell can run; when it is absent the
   * refund is recorded locally only (not durable, not synced), which the shell must not do in a real
   * lane — production always supplies it (see `apps/pos/src/browser-entry.ts`).
   */
  durableReturn?: DurableReturnWrite,
): TillSession {
  const inr = (minor: number): Money => money(minor, 'INR');

  /** The refund record posted to the edge — exactly the fields the synced-return route + `toCloudReturn`
   * read (the bill it is against, who processed it, the §28 approver, and the lines). */
  const toReturnRecord = (full: CommitReturnInput): string => JSON.stringify({
    returnId: full.id,
    number: full.number,
    originalSaleId: full.originalSaleId,
    noReceipt: full.noReceipt ?? false,
    laneId: full.laneId,
    processedBy: full.processedBy,
    ...(full.approval?.decidedBy === undefined ? {} : { approvedBy: full.approval.decidedBy }),
    reasonCode: full.reasonCode,
    refundMinor: full.refund.minor,
    currency: full.refund.currency,
    refundTender: full.refundTender,
    processedAt: full.processedAt,
    lines: full.lines.map((l) => ({
      productId: l.productId, uom: l.uom, quantityMinor: Math.abs(l.quantityMinor), disposition: l.disposition,
    })),
  });

  return {
    moveCash: (input) => recordCashMovement({
      id: `cm-${config.tillId}-${input.at}`,
      tillId: config.tillId,
      laneId: config.laneId,
      kind: input.kind,
      amount: inr(input.amountMinor),
      custodianId: config.cashierId,
      performedBy: input.performedBy ?? config.cashierId,
      at: input.at,
      tradingDay: config.tradingDay,
    }, cashLedger, outbox),

    drawerBalanceMinor: () => tillBalanceMinor(cashLedger, config.tillId),

    refund: async (input) => {
      const full: CommitReturnInput = { ...input, laneId: config.laneId, processedBy: config.cashierId };

      // Decide first — an invalid refund is refused before anything is written anywhere (the sale
      // path's "decide, then record" order). `assertReturnValid` throws the specific M13 error and
      // touches nothing, so a rejected refund never reaches the edge disk.
      assertReturnValid(full);

      // Then record durably, and wait — the receipt of confirmation is what lets the cashier hand
      // back cash. Absent a durable port (a standalone/demo shell) the refund is recorded locally
      // only; a real lane always supplies one.
      if (durableReturn !== undefined) {
        const outcome = await durableReturn(full.id, toReturnRecord(full));
        if (!outcome.committed) {
          // Explicit, distinct outcomes the cashier and caller must tell apart. Unconfirmed (a lost
          // reply — RR-F02) is "may have recorded, do not re-run"; a conflict (id reused for different
          // money — RR-F03) and an over-return (more than the receipt entitles — RR-F04) are "this is
          // wrong"; anything else is a plain durable-write refusal ("try elsewhere").
          if (outcome.unconfirmed === true) {
            throw new RefundUncertainError(full.id, outcome.laneMessage);
          }
          if (outcome.refusedBecause === 'idempotency_conflict') {
            throw new RefundConflictError(full.id, outcome.laneMessage);
          }
          if (outcome.refusedBecause === 'over_return') {
            throw new RefundNotEntitledError(full.id, outcome.laneMessage);
          }
          throw new LocalRefundRefusedError(full.id, outcome.laneMessage);
        }
      }

      // Then account for it locally: stock back in the right state, the refund result for the screen.
      // `commitReturn` re-runs the same validation (it passes) and enqueues to the local outbox for
      // the sync badge; the edge's own outbox is what actually carries the refund to the cloud.
      return commitReturn(full, stockLedger, outbox);
    },

    close: (input) => closeShift({
      id: input.shiftId,
      tillId: config.tillId,
      laneId: config.laneId,
      cashierId: config.cashierId,
      tradingDay: config.tradingDay,
      closedAt: input.closedAt,
      openingFloat: inr(input.openingFloatMinor),
      cashSales: inr(input.cashSalesMinor),
      pickups: inr(input.pickupsMinor),
      cashRefunds: inr(input.cashRefundsMinor),
      // The only figure the cashier supplied. Everything else is what the day recorded.
      countedCash: inr(input.countedMinor),
      toleranceMinor: config.varianceToleranceMinor,
      ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
    } satisfies CloseShiftInput, outbox),
  };
}
