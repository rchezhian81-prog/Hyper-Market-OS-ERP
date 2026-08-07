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
import { commitReturn, type CommitReturnInput, type CommittedReturn } from '../../../packages/returns/src/returns';
import { closeShift, type CloseShiftInput, type ShiftCloseResult } from '../../../packages/till/src/till';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';

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

  /** Refund a customer. `pending` for card and UPI, because a reversal has not happened yet. */
  refund(input: Omit<CommitReturnInput, 'laneId' | 'processedBy'>): CommittedReturn;

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
): TillSession {
  const inr = (minor: number): Money => money(minor, 'INR');

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

    refund: (input) => commitReturn({
      ...input,
      laneId: config.laneId,
      processedBy: config.cashierId,
    }, stockLedger, outbox),

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
