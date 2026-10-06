// The till itself, as opposed to the sale — M13, M14, M15, §27.
//
// Everything the lane does that is not ringing up a basket: money moving in and out of the drawer,
// a refund, and closing the shift at the end of the day. The rules already exist and are tested in
// `packages/cash`, `packages/returns` and `packages/till`; this composes them for one lane and
// hands the screen a surface that cannot express a rule of its own.
//
// ── Where the cash lives (SP-4c · F10) ──────────────────────────────────────
//
// **Not here.** Until SP-4c this object kept a cash ledger in the browser's memory and an outbox nothing
// drained: a float or a pickup died with the page, and the Close button asked the session for four money
// figures the cashier does not have — so the till could not close (audit finding F10). The STORE BOX is the
// thing on the shop PC with a disk and a life longer than a browser tab, so the box holds the till's cash:
// every float, pickup and close is a record on its own append-only log, durable before the till is told
// "recorded", carried to head office by the same pipeline sales and refunds use. This object POSTS to the
// box over the same loopback socket a sale uses (`cashMovement`, `shiftClose`, `tillCash` ports) and shows
// the screen the box's answer, in words. Standing alone with no box, it refuses — it never pretends.
//
// ── The blind count, and why it is a type rather than a habit ───────────────
//
// **The cashier never sees the expected figure before they count.** Shown "expected: ₹12,400",
// people write ₹12,400 — not from dishonesty, but because a number on a screen is an answer and
// counting is work. The whole point of a cash-up is to find the difference, and a count anchored to
// the expectation finds nothing.
//
// So there is no `expectedMinor`, no `drawerBalance` — nothing to call, nothing to render early, and
// nothing for a later change to expose by accident: the box works the expected figure out from what it
// itself recorded (the float and pickups on its cash log, the cash taken on its sale log, the cash refunded
// on its return log), only when a count is given, and answers with the VARIANCE. The till's close therefore
// sends exactly what a cashier knows: which shift, when, what was counted — and, when the box says the
// difference is material, why. That is the same control the stock count uses, and it is worth being
// structural in both places.
//
// ── The other rule with teeth ───────────────────────────────────────────────
//
// **A refund to a card is never assumed successful.** Cash and store credit settle at the lane
// immediately; a card or UPI refund is a reversal the provider has to perform, so it is `pending`
// and the customer is told that rather than shown a completed refund for money that has not moved.

import type { Ledger } from '../../../packages/ledger/src/ledger';
import type { CashMovementKind } from '../../../packages/cash/src/cash';
import { assertReturnValid, commitReturn, type CommitReturnInput, type CommittedReturn } from '../../../packages/returns/src/returns';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import type { CommitOutcome } from '../../../edge/store-edge/src/durability';
import {
  TILL_CASH_WORDS,
  type CashMovementOutcome, type ShiftCloseOutcome, type TillCashStatus, type CountedDenomination,
} from '../../../edge/store-edge/src/till-cash';
import { NoOperatorError, NoLaneError } from './session';

export type { CashMovementOutcome, ShiftCloseOutcome, TillCashStatus, CountedDenomination, TillCashRefusal } from '../../../edge/store-edge/src/till-cash';
/** The box's words for each cash refusal, so the lane ports can say the same thing the box would. */
export const TILL_CASH_WORDS_FOR_THE_LANE = TILL_CASH_WORDS;

/**
 * The lane's durable write for a refund — post it to this till's own edge and wait for the answer,
 * exactly as a sale's `DurableWrite` does. Same-machine loopback, never a call off the till (ADR-0004).
 */
export type DurableReturnWrite = (returnId: string, record: string) => Promise<CommitOutcome>;

/** What the till asks the box to record about cash — the box adds the lane, the till, the day and the sign (SP-4c). */
export interface CashMovementRequest {
  readonly movementId: string;
  readonly movementKind: CashMovementKind;
  readonly amountMinor: number;
  readonly at: string;
  readonly custodianId: string;
  readonly performedBy: string;
}
/** The lane's durable write for a cash movement — to this till's own box, over loopback. Never throws: an unreachable box is an outcome. */
export type CashMovementWrite = (req: CashMovementRequest) => Promise<CashMovementOutcome>;

/** What the till asks the box when the cashier closes: which shift, when, who, what was counted — and why, once asked. */
export interface ShiftCloseRequest {
  readonly shiftId: string;
  readonly closedAt: string;
  readonly cashierId: string;
  readonly countedMinor: number;
  readonly denominations?: readonly CountedDenomination[];
  readonly reasonCode?: string;
}
/** The lane's durable write for a shift close — the box works out the figures and decides. Never throws. */
export type ShiftCloseWrite = (req: ShiftCloseRequest) => Promise<ShiftCloseOutcome>;

/** Where the till's cash stands on the box (custody only — never a figure), or null when the box did not answer. */
export type TillCashRead = () => Promise<TillCashStatus | null>;

/** The box-side ports the till is built with. Production supplies all of them (`apps/pos/src/browser-entry.ts`). */
export interface TillPorts {
  /**
   * The refund's durable write to this till's edge (M13-FR-01). Its own port, the mirror of the sale's `DurableWrite`:
   * a refund is durable on the box's disk before it is called done, then the edge syncs it to the cloud. Optional so a
   * standalone/demo shell can run; when it is absent the refund is recorded locally only (not durable, not synced),
   * which the shell must not do in a real lane.
   */
  readonly durableReturn?: DurableReturnWrite;
  readonly cashMovement?: CashMovementWrite;
  readonly shiftClose?: ShiftCloseWrite;
  readonly tillCash?: TillCashRead;
}

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
  /** The lane this till IS (the box's `EDGE_LANE_ID`); absent → cash, refunds and the close are refused (F09). */
  readonly laneId?: string;
  /** The cashier at the till when built; usually absent — the person signs in (`signIn`), §28 · hard rule #4. */
  readonly cashierId?: string;
  /** A FIXED trading day for the REFUND record (tests / replay). Cash and the close are dated by the box. */
  readonly tradingDay?: string;
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
  /**
   * Money in or out of the drawer: the float that opens the shift, a loan, a pickup or safe drop to the safe, the float
   * returned (M14-FR-01). Recorded on the STORE BOX, durably, before this resolves `committed` — the box judges one
   * custodian at a time and no overdraw with the same guard head office runs. Refused in words with nobody signed in or
   * no lane (F09). `movementId` is the till's own name for this act; the same id sent again after a lost reply is one
   * effect (`alreadyRecorded`). Never resolves a balance: the drawer is counted blind.
   */
  moveCash(input: {
    readonly kind: CashMovementKind;
    readonly amountMinor: number;
    readonly at: string;
    readonly movementId?: string;
    readonly performedBy?: string;
  }): Promise<CashMovementOutcome>;

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
  /** A cashier signs in with their staff code (SP-4b · F09); cash movements, refunds and the close name them. */
  signIn(cashierId: string): void;
  signOut(): void;
  /** Who is at the till now — the signed-in cashier, else the configured one, else nobody. */
  operator(): string | undefined;

  /**
   * Close the shift against a **counted** figure (M14-FR-02).
   *
   * The input is exactly what a cashier knows — which shift, when, what was counted, and (once the box has said the
   * difference is material) why. The expected total is worked out on the box from what it recorded and is available
   * nowhere before this call, deliberately. What comes back carries the variance, whether it is material, and what
   * the cashier must do about it. The same `shiftId` sent again is one close (`alreadyClosed`).
   */
  close(input: {
    readonly shiftId: string;
    readonly closedAt: string;
    readonly countedMinor: number;
    readonly denominations?: readonly CountedDenomination[];
    readonly reasonCode?: string;
  }): Promise<ShiftCloseOutcome>;

  /** Whether a float is out on this till and who holds it — read from the box, never a figure. `null` = no box answered. */
  tillCash(): Promise<TillCashStatus | null>;
}

export function createTillSession(
  config: TillConfig,
  /** Returned goods go back onto the shelf, or do not — so a refund touches stock (M13). */
  stockLedger: Ledger,
  outbox: SyncOutbox,
  ports: TillPorts = {},
): TillSession {
  // Who, where — real or refused (F09). The same rule the sale session applies. The DAY is the box's to date.
  let operatorId: string | undefined;
  const operator = (): string | undefined => operatorId ?? config.cashierId;
  const who = (action: string): string => {
    const id = operator();
    if (id === undefined) throw new NoOperatorError(action);
    return id;
  };
  const lane = (action: string): string => {
    if (config.laneId === undefined || config.laneId === '') throw new NoLaneError(action);
    return config.laneId;
  };

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
    // The approval the store computer issued for this refund (ADR-0021) — the box spends it, once, before the disk.
    ...(full.approval?.decidedBy !== undefined && full.approval.id.startsWith('apr-') ? { approvalId: full.approval.id } : {}),
    // The customer a store-credit refund belongs to (M13-FR-03 / §31) — carried onto the edge record so
    // `toCloudReturn` forwards it and the cloud issues the credit to them when the refund reconciles.
    ...(full.customerRef === undefined ? {} : { customerRef: full.customerRef }),
    reasonCode: full.reasonCode,
    refundMinor: full.refund.minor,
    currency: full.refund.currency,
    refundTender: full.refundTender,
    // The exchange's settlement (SP-9b-ii): which replacement sale the credit paid for and which way the balance went —
    // `toCloudReturn` relays it; the box's cash figures read only a cash balance refund as cash out of the drawer.
    ...(full.exchange === undefined ? {} : { exchange: full.exchange }),
    processedAt: full.processedAt,
    lines: full.lines.map((l) => ({
      productId: l.productId, uom: l.uom, quantityMinor: Math.abs(l.quantityMinor), disposition: l.disposition,
    })),
  });

  return {
    signIn: (cashierId) => {
      const id = cashierId.trim();
      if (id === '') throw new RangeError('A staff code is required to sign in.');
      operatorId = id;
    },
    signOut: () => { operatorId = undefined; },
    operator,

    moveCash: async (input) => {
      // Refused BEFORE the box is asked: with nobody signed in or no lane there is no honest record to make (F09).
      const laneId = lane('record a cash movement');
      const cashier = who('record a cash movement');
      if (ports.cashMovement === undefined) {
        return { committed: false, refusedBecause: 'no_store_box', laneMessage: TILL_CASH_WORDS.no_store_box };
      }
      return ports.cashMovement({
        // The till's own name for this act, kept across a retry so the box sees one movement. The screen mints one per
        // act; a caller that does not gets one from the lane, the kind and the moment.
        movementId: input.movementId ?? `cm-${laneId}-${input.kind}-${input.at}`,
        movementKind: input.kind,
        amountMinor: input.amountMinor,
        at: input.at,
        custodianId: cashier,
        performedBy: input.performedBy ?? cashier,
      });
    },

    refund: async (input) => {
      const full: CommitReturnInput = { ...input, laneId: lane('take a refund'), processedBy: who('take a refund') };

      // Decide first — an invalid refund is refused before anything is written anywhere (the sale
      // path's "decide, then record" order). `assertReturnValid` throws the specific M13 error and
      // touches nothing, so a rejected refund never reaches the edge disk.
      assertReturnValid(full);

      // Then record durably, and wait — the receipt of confirmation is what lets the cashier hand
      // back cash. Absent a durable port (a standalone/demo shell) the refund is recorded locally
      // only; a real lane always supplies one.
      if (ports.durableReturn !== undefined) {
        const outcome = await ports.durableReturn(full.id, toReturnRecord(full));
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

    close: async (input) => {
      // The same two refusals as a sale, before any figure is asked of the box (F09).
      lane('close the till');
      const cashier = who('close the till');
      if (ports.shiftClose === undefined) {
        return { closed: false, refusedBecause: 'no_store_box', laneMessage: TILL_CASH_WORDS.no_store_box };
      }
      return ports.shiftClose({
        shiftId: input.shiftId,
        closedAt: input.closedAt,
        cashierId: cashier,
        countedMinor: input.countedMinor,
        ...(input.denominations === undefined ? {} : { denominations: input.denominations }),
        ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
      });
    },

    tillCash: async () => (ports.tillCash === undefined ? null : ports.tillCash()),
  };
}
