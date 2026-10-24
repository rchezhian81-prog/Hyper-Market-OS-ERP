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
import { lineBundleOf, type BundleDefinition } from '../../../packages/product/src/bundles';
import type { CashMovementKind } from '../../../packages/cash/src/cash';
import {
  assertReturnValid, commitReturn, expiredOfProduct, recallOfProduct, returnLineHoldReason, type CommitReturnInput, type CommittedReturn, type ReturnRecallCheck,
} from '../../../packages/returns/src/returns';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import type { CommitOutcome } from '../../../edge/store-edge/src/durability';
import {
  TILL_CASH_WORDS,
  type CashMovementOutcome, type ShiftCloseOutcome, type TillCashStatus, type CountedDenomination,
} from '../../../edge/store-edge/src/till-cash';
import { NoOperatorError, NoLaneError } from './session';
import { refundTenderRefusal } from '../../../packages/tender/src/paid-on-old-erp';

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
  /**
   * OB-252: guest sales only — a refund names no customer, so no store credit (it is money on a named customer's
   * account). Refused in words before anything is written.
   */
  readonly guestSalesOnly?: boolean;
  /**
   * OB-258 (owner, 20 Oct 2026, "Ring on both"): the MIRROR PILOT — a refund done on the old ERP is keyed here against the
   * same `paid_on_old_erp` tender (no money out of this drawer), and an exchange is not keyed as one. Off → that tender is
   * refused. Before anything is written, in words.
   */
  readonly mirrorPilot?: boolean;
  /**
   * M13-FR-02 · M10-FR-04: the lane's cached recall set — each product's `recallBlock` and named `blockedBatches` from the
   * signed catalogue pack the till already holds (no network). A returned unit the cashier chose to RESELL whose product is
   * recalled is held instead (quarantine) on the record the box keeps and on the till's own stock movement; the refund
   * itself goes ahead. Absent → nothing is known to be recalled here (the store computer checks its own pack again).
   * The same pack's `expiredBatches` (M13-FR-02 · M10-FR-01): a returned unit of a batch head office moved to EXPIRED is held
   * the same way, marked `expiredHeld` — only when the unit's batch is known, as at the scan.
   */
  /**
   * OB-306 (M03-FR-02): a product's own-barcode bundle definition, and each product's base unit, from the lane's signed pack.
   * A returned bundle line carries its components (`explodeBundleLine`) so the stock goes back component by component;
   * head office prefers the explosion frozen on the original bill. Absent → no product is a bundle here.
   */
  readonly bundleOf?: (productId: string) => BundleDefinition | undefined;
  readonly baseUomOf?: (productId: string) => string | undefined;
  readonly recallOf?: (productId: string) => {
    readonly recallBlock?: boolean; readonly blockedBatches?: readonly string[]; readonly expiredBatches?: readonly { readonly batchId: string }[];
  } | undefined;
}

/** What the till says when a refund would name a customer while guest sales only is on (OB-252). */
export const GUEST_ONLY_REFUND_WORDS = 'Guest sales only on this till during the pilot: a refund cannot go to a customer\'s account as store credit, and no customer number is taken. Choose cash, card or UPI. Nothing was recorded.';

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
  /**
   * The refund whose answer was lost (RR-F02 · A8), still waiting for the store computer — its id and document number —
   * or undefined. While one waits, no other refund is taken.
   */
  pendingRefund(): { readonly returnId: string; readonly number: string } | undefined;
  /**
   * Ask the store computer again about the refund whose answer was lost, by re-sending the SAME record under the SAME id
   * (the box is idempotent on it, RR-F03). Resolves the refund once the box says it is saved; throws the box's refusal
   * (`LocalRefundRefusedError` and kin) once it says it is not; throws `RefundUncertainError` again while it does not answer.
   */
  confirmPendingRefund(): Promise<CommittedReturn>;
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
  // M13-FR-02: the recall check from the lane's own pack (offline), applied BEFORE the record is made, so the box, head
  // office and the till's own stock all see the held disposition — never a recalled unit back on the shelf.
  const isRecalled: ReturnRecallCheck = config.recallOf === undefined ? () => false : recallOfProduct(config.recallOf);
  const isExpired: ReturnRecallCheck = config.recallOf === undefined ? () => false : expiredOfProduct(config.recallOf);

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
    lines: full.lines.map((l) => {
      const hold = returnLineHoldReason(l, isRecalled, isExpired);
      return {
        productId: l.productId, uom: l.uom, quantityMinor: Math.abs(l.quantityMinor),
        disposition: hold === null ? l.disposition : 'quarantine',
        ...(typeof l.batchId === 'string' && l.batchId !== '' ? { batchId: l.batchId } : {}),
        // OB-306: a returned bundle comes back as its components (from the lane's signed pack).
        ...((def) => {
          const b = def === undefined ? undefined : lineBundleOf(def, Math.abs(l.quantityMinor), (id) => config.baseUomOf?.(id));
          return b === undefined ? {} : { bundle: b };
        })(config.bundleOf?.(l.productId)),
        // What the cashier chose, kept beside what the recall (or the expired batch) made of it (evidence, M15 · P-08).
        ...(hold === 'recall' ? { recallHeld: true, chosenDisposition: l.disposition } : {}),
        ...(hold === 'expired' ? { expiredHeld: true, chosenDisposition: l.disposition } : {}),
      };
    }),
  });

  // The refund sent to the box whose answer was lost (RR-F02 · A8): the exact record sent, so a re-send hashes the same.
  let awaiting: { readonly full: CommitReturnInput; readonly record: string } | undefined;

  /**
   * The box's definite refusal, as the distinct error the cashier and the caller must tell apart: a conflict (id reused for
   * different money — RR-F03) and an over-return (more than the receipt entitles — RR-F04) are "this is wrong"; anything
   * else is a plain durable-write refusal ("try elsewhere").
   */
  const throwRefusal = (returnId: string, outcome: CommitOutcome): never => {
    if (outcome.refusedBecause === 'idempotency_conflict') throw new RefundConflictError(returnId, outcome.laneMessage);
    if (outcome.refusedBecause === 'over_return') throw new RefundNotEntitledError(returnId, outcome.laneMessage);
    throw new LocalRefundRefusedError(returnId, outcome.laneMessage);
  };

  const confirmPendingRefund = async (): Promise<CommittedReturn> => {
    const pending = awaiting;
    if (pending === undefined || ports.durableReturn === undefined) {
      throw new LocalRefundRefusedError('(none)', 'No refund is waiting for the store computer.');
    }
    const outcome = await ports.durableReturn(pending.full.id, pending.record);
    if (!outcome.committed && outcome.unconfirmed === true) throw new RefundUncertainError(pending.full.id, outcome.laneMessage);
    awaiting = undefined;
    if (!outcome.committed) throwRefusal(pending.full.id, outcome);
    return commitReturn(pending.full, stockLedger, outbox, isRecalled, isExpired);
  };

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

    pendingRefund: () => (awaiting === undefined ? undefined : { returnId: awaiting.full.id, number: awaiting.full.number }),

    confirmPendingRefund,

    refund: async (input) => {
      // A refund whose answer was lost is resolved first, under its own id — never taken again as a new one (A8).
      if (awaiting !== undefined) {
        if (awaiting.full.id === input.id) return confirmPendingRefund();
        throw new RefundUncertainError(awaiting.full.id, `Wait. The till is still checking with the store computer whether refund ${awaiting.full.number} was saved. Do not hand back cash and do not take another refund yet.`);
      }
      const full: CommitReturnInput = { ...input, laneId: lane('take a refund'), processedBy: who('take a refund') };
      // OB-252: no customer is named on a guest-only till — so no store credit and no customer reference. Before anything.
      if (config.guestSalesOnly === true && (full.refundTender === 'store_credit' || full.customerRef !== undefined
        || (full.exchange?.balanceTender === 'store_credit'))) {
        throw new LocalRefundRefusedError(full.id, GUEST_ONLY_REFUND_WORDS);
      }
      // OB-258: in the mirror pilot the refund goes back to "Paid on old system", never cash from this drawer; outside it,
      // that tender is refused. The same rule the store computer runs before its disk.
      const mirror = refundTenderRefusal({ mirrorOn: config.mirrorPilot === true, refundTender: full.refundTender, exchange: full.exchange });
      if (mirror !== undefined) throw new LocalRefundRefusedError(full.id, mirror.laneMessage);

      // Decide first — an invalid refund is refused before anything is written anywhere (the sale
      // path's "decide, then record" order). `assertReturnValid` throws the specific M13 error and
      // touches nothing, so a rejected refund never reaches the edge disk.
      assertReturnValid(full);

      // Then record durably, and wait — the receipt of confirmation is what lets the cashier hand
      // back cash. Absent a durable port (a standalone/demo shell) the refund is recorded locally
      // only; a real lane always supplies one.
      if (ports.durableReturn !== undefined) {
        const record = toReturnRecord(full);
        const outcome = await ports.durableReturn(full.id, record);
        if (!outcome.committed) {
          // Unconfirmed (a lost reply — RR-F02 · A8) is "may have recorded, do not re-run": the till keeps the EXACT record
          // and re-sends it under the same id (`confirmPendingRefund`) until the box answers; nothing else is taken meanwhile.
          if (outcome.unconfirmed === true) {
            awaiting = { full, record };
            throw new RefundUncertainError(full.id, outcome.laneMessage);
          }
          throwRefusal(full.id, outcome);
        }
      }

      // Then account for it locally: stock back in the right state, the refund result for the screen.
      // `commitReturn` re-runs the same validation (it passes) and enqueues to the local outbox for
      // the sync badge; the edge's own outbox is what actually carries the refund to the cloud.
      return commitReturn(full, stockLedger, outbox, isRecalled, isExpired);
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
