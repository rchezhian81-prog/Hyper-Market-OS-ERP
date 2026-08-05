// The store manager's surface (docs/design/screens/store-manager.md · M02 approvals · M07
// receiving · M09 counts · M14-FR-04 day close · M15 exceptions). Every rule already exists and is
// tested in `packages/`; this composes them for one store and hands the screen something that
// cannot express a rule of its own.
//
// ── The decision this file exists to hold: an empty answer is not an all-clear ──
//
// `closeDay` takes `unresolvedExceptions: number` and `unsentSyncItems: number`. Nothing stops a
// screen passing `0` for both — and a screen that cannot reach the exception register would pass
// `0` for exactly the same reason a store with nothing wrong does. The day would close, locked,
// on an assumption, and the lock is the whole point of closing it.
//
// So this session does not read counts. It reads **registers**, and a register can answer *I do not
// know*, which is a third answer distinct from *none*. Not knowing whether an exception is open is
// a reason the day must not close — it is the strongest reason there is. `blockersForClose` returns
// it as a blocker like any other, and `closeTheDay` refuses on it.
//
// ── The second decision: "cannot close" is useless ─────────────────────────────
//
// The day-close engine throws `UnresolvedExceptionsError` with a count. A manager standing at a
// screen at eleven at night needs the list: *3 sales unsent, 2 exceptions open — here they are*.
// So the blockers are computed and enumerated BEFORE the engine is called, and `closeTheDay`
// returns them rather than throwing. The engine stays the authority — it is still called, still
// with the real numbers, and if it refuses when this list was empty, that disagreement becomes a
// visible blocker of its own instead of a stack trace.
//
// ── The third: the blind count, again ──────────────────────────────────────────
//
// `reconcileCount` derives the expected on-hand from the ledger itself, so a counter never supplies
// it. This session keeps that structural on the manager's side too: **there is no method here that
// returns an expected quantity.** There is nothing to call and nothing for a later change to render
// early. The variance exists only in what comes back from a count that was already entered — the
// same control the till uses for the drawer, and worth being structural in both places.

import { money, type CurrencyCode, type Money } from '../../../packages/contracts/src/money';
import { tradingDate, type TradingDayRule } from '../../../packages/calendar/src/trading-day';
import type {
  ApprovalRequest,
  Approver,
  Decision,
  DecidedRequest,
  RefusalReason,
} from '../../../packages/approvals/src/approvals';
import {
  commitReceipt,
  type CommittedReceipt,
  type ReceiptLineInput,
} from '../../../packages/receiving/src/receiving';
import { reconcileCount, type CountReconciliation } from '../../../packages/counts/src/counts';
import { closeDay, type DayCloseResult } from '../../../packages/day-close/src/day-close';
import type { Ledger } from '../../../packages/ledger/src/ledger';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { buildQueue, submitDecision, type QueueRow } from './approvals-workbench';

// ── Registers ───────────────────────────────────────────────────────────────

/** One line a manager can act on: what it is, and enough of an identity to chase it. */
export interface RegisterItem {
  readonly id: string;
  /** Plain-English description of the single thing that is open. */
  readonly what: string;
}

/**
 * What a register answered.
 *
 * `known: false` is not an error and it is not zero. It is the state of a screen that could not
 * reach the thing it is reporting on, and saying so is the whole of P-08.
 */
export type Register =
  | { readonly known: true; readonly items: readonly RegisterItem[] }
  | { readonly known: false; readonly why: string };

/** The approval queue's register — the requests themselves, or why they could not be read. */
export type ApprovalRegister =
  | { readonly known: true; readonly requests: readonly ApprovalRequest[] }
  | { readonly known: false; readonly why: string };

/**
 * What one smallest unit of a product is worth, or why that is not known.
 *
 * This one is not politeness, it is a control with teeth. A count variance is valued to decide
 * whether it needs a second person's approval (§28). A screen that did not know the cost and
 * defaulted to zero would value every difference at ₹0, put every difference below the threshold,
 * and commit a shrinkage adjustment of any size with nobody's approval at all. Not knowing must
 * therefore refuse the count, not price it at nothing.
 */
export type ValueRegister =
  | { readonly known: true; readonly valuePerUnitMinor: number }
  | { readonly known: false; readonly why: string };

/** A figure for the home screen that is allowed to say it does not know. */
export type Tally =
  | { readonly known: true; readonly count: number }
  | { readonly known: false; readonly why: string };

/** Everything the manager's screen reads from the rest of the store. */
export interface ManagerPorts {
  /** Approval requests routed to this store (M02-FR-03). */
  approvals(): ApprovalRegister;
  /** Reconciliation and loss-prevention exceptions still open for the trading day (M15). */
  openExceptions(tradingDay: string): Register;
  /** Locally-committed items across the store that have not reached cloud (§31). */
  unsentItems(tradingDay: string): Register;
  /** Opening/closing checklists and staff tasks for the day (D11-FR-01 / M25). */
  tasks(tradingDay: string): Register;
  /** What one smallest unit of a product is worth — used to value a count variance exactly. */
  productValue(productId: string): ValueRegister;
}

/** A register that knows nothing, with the reason it knows nothing. */
export function notKnown(why: string): { readonly known: false; readonly why: string } {
  return { known: false, why };
}

/**
 * Ports for a screen that is not connected to the store yet.
 *
 * The default is deliberately this rather than empty registers. A manager app that opens before it
 * has been wired to the edge shows *"I cannot see the exception register"* and refuses to close the
 * day — which is the correct behaviour and the correct thing to see during a pilot.
 */
export function disconnectedPorts(why: string): ManagerPorts {
  return {
    approvals: () => notKnown(why),
    openExceptions: () => notKnown(why),
    unsentItems: () => notKnown(why),
    tasks: () => notKnown(why),
    productValue: () => notKnown(why),
  };
}

/**
 * A register built from an outbox that this process owns.
 *
 * **Only ever the truth for the outbox it is handed.** The store's unsent count is every lane's
 * queue plus the edge's, and a manager screen that reports its own browser's empty queue as the
 * store's answer is precisely the fault the rest of this file is built to make impossible. Wire it
 * to the edge's outbox, or do not wire it at all and let the register say it does not know.
 */
export function unsentFromOutbox(outbox: SyncOutbox): Register {
  return {
    known: true,
    items: outbox.pending().map((item) => ({ id: item.key, what: item.event.type })),
  };
}

// ── Blockers ────────────────────────────────────────────────────────────────

/**
 * Every reason a day can fail to close.
 *
 * A value rather than a bare union type, because the screen has to have words for each of these in
 * two languages and a type cannot be read at test time. A guardrail walks this list against the
 * view's word map, so adding a kind and forgetting the translation fails the build rather than
 * showing a manager a blank reason at the moment they most need one.
 *
 *   `day_not_ended`   — the trading day has not reached its cut-off; the shop may still be trading
 *   `exceptions_open` — reconciliation or loss-prevention exceptions are open (M14-FR-04)
 *   `items_unsent`    — locally-committed items have not reached the cloud (M14-FR-04)
 *   `cannot_see`      — a register could not be read; not knowing is a reason to stop
 *   `rules_refused`   — the day-close engine refused for a reason this screen did not predict
 */
export const BLOCKER_KINDS = Object.freeze([
  'day_not_ended',
  'exceptions_open',
  'items_unsent',
  'cannot_see',
  'rules_refused',
] as const);

export type BlockerKind = (typeof BLOCKER_KINDS)[number];

/** One reason the day cannot close, with the actual things behind it. */
export interface Blocker {
  readonly kind: BlockerKind;
  /** How many items are open. Zero for `day_not_ended`, and for a register that could not be read. */
  readonly count: number;
  /**
   * The items in full — never truncated here.
   *
   * The view shows the first few and says how many more. The count above is always exact, because
   * a shortened list that looks complete is how a manager clears three of eleven and goes home.
   */
  readonly items: readonly RegisterItem[];
  /** Which register or rule produced this: `exceptions`, `unsent`, `trading-day`, `day-close`. */
  readonly source: string;
  /** On `cannot_see` and `rules_refused`, the reason verbatim from whatever refused. */
  readonly why?: string;
}

/**
 * The English sentence for a blocker — used by the audit trail, the logs and the tests.
 *
 * The screen does **not** render this: it renders from `kind` and `count` in the manager's own
 * language, because half of this store's floor staff read Tamil first. Keeping the structure and
 * the words apart is what lets both be true at once.
 */
export function blockerSentence(blocker: Blocker): string {
  switch (blocker.kind) {
    case 'day_not_ended':
      return 'The trading day has not reached its cut-off yet.';
    case 'exceptions_open':
      return `${blocker.count} exception(s) are still open.`;
    case 'items_unsent':
      return `${blocker.count} item(s) are saved in the store and have not reached the cloud.`;
    case 'cannot_see':
      return `The ${blocker.source} register could not be read: ${blocker.why ?? 'no reason given'}.`;
    case 'rules_refused':
      return `The day-close rules refused: ${blocker.why ?? 'no reason given'}.`;
  }
}

// ── Deciding an approval ────────────────────────────────────────────────────

/**
 * Why a request may be approved. A reason is mandatory (audit) and it is **chosen, not typed** —
 * free text at a screen is a reason nobody can report on afterwards, which is the same rule the
 * till applies to a void.
 */
export const APPROVE_REASONS = Object.freeze([
  'within_policy',
  'checked_with_supplier',
  'checked_the_stock',
  'owner_instructed',
] as const);

/** Why a request may be rejected. A separate list, and the separation is a control — see below. */
export const REJECT_REASONS = Object.freeze([
  'price_looks_wrong',
  'not_enough_evidence',
  'against_policy',
  'ask_the_owner_first',
] as const);

export type ApproveReason = (typeof APPROVE_REASONS)[number];
export type RejectReason = (typeof REJECT_REASONS)[number];
export type DecisionReasonCode = ApproveReason | RejectReason;

/**
 * The reasons offered for a decision.
 *
 * The lists do not overlap, and that is the point: approving something "against policy" is not a
 * decision anybody should be able to record, and rejecting something as "within policy" is not a
 * sentence that means anything. Offering one list for both would let either be written into the
 * audit trail, where it would look like a considered decision forever.
 */
export function reasonsFor(decision: Decision): readonly DecisionReasonCode[] {
  return decision === 'approved' ? APPROVE_REASONS : REJECT_REASONS;
}

/**
 * Every refusal the approval engine itself can return, restated as a value.
 *
 * A `Record<RefusalReason, …>` rather than a list, and that is the point: the moment the engine
 * gains a refusal this screen has not thought about, this stops compiling. A screen that quietly
 * fell through to "something went wrong" on a new rule is how a manager ends up tapping the same
 * button harder.
 */
const ENGINE_REFUSALS: Readonly<Record<RefusalReason, RefusalReason>> = Object.freeze({
  self_approval_forbidden: 'self_approval_forbidden',
  reason_required: 'reason_required',
  out_of_scope: 'out_of_scope',
  exceeds_authority: 'exceeds_authority',
});

export type DecideRefusal =
  | RefusalReason
  /** No pending request with that id — a stale screen, not a rule breach. */
  | 'request_not_found'
  /** A reason outside the catalogue for this decision. Refused rather than recorded. */
  | 'unknown_reason_code';

/** The full refusal vocabulary the screen must have words for, in every language it offers. */
export const DECIDE_REFUSALS: readonly DecideRefusal[] = Object.freeze([
  ...(Object.keys(ENGINE_REFUSALS) as RefusalReason[]),
  'request_not_found',
  'unknown_reason_code',
]);

export type ManagerDecisionOutcome =
  | { readonly ok: true; readonly request: DecidedRequest }
  | { readonly ok: false; readonly refusal: DecideRefusal };

// ── The session ─────────────────────────────────────────────────────────────

export interface ManagerConfig {
  readonly storeId: string;
  /** The branch this manager is working in; null = company-wide. */
  readonly branchId: string | null;
  /** The trading day being run (YYYY-MM-DD). */
  readonly tradingDay: string;
  /** Where this store's trading day ends (M01-FR-02). Per-tenant. */
  readonly tradingDayRule: TradingDayRule;
  /** The manager: who they are, where they may approve, and up to what value. */
  readonly manager: Approver;
  readonly currency: CurrencyCode;
  /** Where received goods land. Per-tenant. */
  readonly warehouseId: string;
  /** Variance value at/above which a stock count needs a separate approver (§28). Per-tenant. */
  readonly countApprovalThresholdMinor: number;
}

export interface ReceiveInput {
  readonly grnId: string;
  readonly number: string;
  /** The purchase order this delivery is against, or null when there is none. */
  readonly poId: string | null;
  readonly receivedAt: string;
  readonly lines: readonly ReceiptLineInput[];
}

export interface ReceivedGoods {
  readonly receipt: CommittedReceipt;
  /**
   * True when the delivery arrived with no purchase order behind it.
   *
   * Stock still goes up — the goods are physically in the building and pretending otherwise is
   * how a shelf and a system disagree. But the receipt cannot be three-way matched, and a screen
   * that does not say so produces an invoice nobody can check (M06/M07).
   */
  readonly unmatched: boolean;
}

export interface CountInput {
  readonly countId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly uom: string;
  /** The blind physical count, in the UOM's smallest unit. */
  readonly countedMinor: number;
  readonly reasonCode: string;
  readonly at: string;
  /** A decision by someone OTHER than this manager, needed when the variance is material (§28). */
  readonly approval?: DecidedRequest;
}

/**
 * A count either reconciled, or was refused before anything was written.
 *
 * The refusal is the interesting half. `value_not_known` means the screen could not find out what
 * the item is worth — and rather than value the difference at nothing (which would put it below
 * every approval threshold there is), nothing is committed and the manager is told why.
 */
export type CountAttempt =
  | { readonly counted: true; readonly result: CountReconciliation }
  | { readonly counted: false; readonly refusal: 'value_not_known'; readonly why: string };

export interface CloseInput {
  readonly dayCloseId: string;
  /** Store-local wall-clock moment of the close ("YYYY-MM-DDTHH:MM"). */
  readonly closedAtLocal: string;
  /** ISO-8601 UTC timestamp for the event. */
  readonly closedAt: string;
}

export type CloseAttempt =
  | { readonly closed: true; readonly result: DayCloseResult }
  | { readonly closed: false; readonly blockers: readonly Blocker[] };

export type ApprovalQueue =
  | { readonly known: true; readonly rows: readonly QueueRow[] }
  | { readonly known: false; readonly why: string };

export interface FloorSummary {
  readonly tradingDay: string;
  /** Everything waiting, including what this manager may not decide themselves. */
  readonly approvalsWaiting: Tally;
  /** What this manager can actually clear right now (§28 removes their own requests). */
  readonly approvalsIcanClear: Tally;
  readonly exceptions: Tally;
  readonly unsent: Tally;
  readonly tasks: Tally;
}

export interface ManagerSession {
  /** The home screen: what is waiting, and what this screen cannot see. */
  floor(): FloorSummary;
  /** The approval inbox, ordered by value, with each row marked actionable or not and why. */
  approvalQueue(): ApprovalQueue;
  /** Decide one request. The reason is a code from the catalogue for that decision. */
  decideApproval(input: {
    readonly requestId: string;
    readonly decision: Decision;
    readonly reasonCode: string;
    readonly decidedAt: string;
  }): ManagerDecisionOutcome;
  /** Book a delivery in. Stock rises locally; a GoodsReceived event queues for sync (M07). */
  receive(input: ReceiveInput): ReceivedGoods;
  /** Reconcile a blind count against the ledger (M09-FR-04). Nothing here reveals the expected. */
  countStock(input: CountInput): CountAttempt;
  /** Everything standing between this store and a closed day — enumerated, never just counted. */
  blockersForClose(closedAtLocal: string): readonly Blocker[];
  /** Close the day, or come back with the list of what to clear first (M14-FR-04). */
  closeTheDay(input: CloseInput): CloseAttempt;
  /** Open exceptions for the day (M15), for the exceptions screen. */
  exceptions(): Register;
  /** Today's checklists and staff tasks (D11-FR-01 / M25). */
  tasks(): Register;
}

function tally(register: Register): Tally {
  return register.known ? { known: true, count: register.items.length } : register;
}

export function createManagerSession(
  config: ManagerConfig,
  ports: ManagerPorts,
  /** The store's stock ledger — received goods and count adjustments append to it. */
  stockLedger: Ledger,
  outbox: SyncOutbox,
): ManagerSession {
  const inr = (minor: number): Money => money(minor, config.currency);

  const approvalQueue = (): ApprovalQueue => {
    const register = ports.approvals();
    if (!register.known) return register;
    return { known: true, rows: buildQueue(register.requests, config.manager) };
  };

  const blockersForClose = (closedAtLocal: string): readonly Blocker[] => {
    const blockers: Blocker[] = [];

    // 1. Has the day this manager is closing actually ended? The engine checks this too; checking
    //    it here is what lets the screen say so alongside everything else rather than one at a time.
    try {
      const currentTradingDate = tradingDate(closedAtLocal, config.tradingDayRule);
      if (!(currentTradingDate > config.tradingDay)) {
        blockers.push({ kind: 'day_not_ended', count: 0, items: [], source: 'trading-day' });
      }
    } catch (error) {
      // A clock this screen cannot read is not a reason to close the day anyway.
      blockers.push({
        kind: 'cannot_see',
        count: 0,
        items: [],
        source: 'trading-day',
        why: error instanceof Error ? error.message : String(error),
      });
    }

    // 2 and 3. The two gates M14-FR-04 names. Each register gets the same treatment, and *not
    //    knowing* produces a blocker exactly as an open item does.
    const gates: readonly { readonly source: string; readonly kind: BlockerKind; readonly register: Register }[] = [
      { source: 'exceptions', kind: 'exceptions_open', register: ports.openExceptions(config.tradingDay) },
      { source: 'unsent', kind: 'items_unsent', register: ports.unsentItems(config.tradingDay) },
    ];
    for (const gate of gates) {
      if (!gate.register.known) {
        blockers.push({ kind: 'cannot_see', count: 0, items: [], source: gate.source, why: gate.register.why });
        continue;
      }
      if (gate.register.items.length > 0) {
        blockers.push({
          kind: gate.kind,
          count: gate.register.items.length,
          items: gate.register.items,
          source: gate.source,
        });
      }
    }

    // Tasks are deliberately NOT a gate. M14-FR-04 names exceptions and unsent items; an unfinished
    // shelf-replenishment task is not a reason a day's takings cannot be locked, and adding gates
    // the roadmap does not ask for is how a close nobody can pass gets worked around instead.
    return blockers;
  };

  return {
    floor: () => {
      const approvals = ports.approvals();
      const queue = approvalQueue();
      return {
        tradingDay: config.tradingDay,
        approvalsWaiting: approvals.known ? { known: true, count: approvals.requests.length } : approvals,
        approvalsIcanClear: queue.known
          ? { known: true, count: queue.rows.filter((row) => row.actionable).length }
          : queue,
        exceptions: tally(ports.openExceptions(config.tradingDay)),
        unsent: tally(ports.unsentItems(config.tradingDay)),
        tasks: tally(ports.tasks(config.tradingDay)),
      };
    },

    approvalQueue,

    decideApproval: (input) => {
      const register = ports.approvals();
      if (!register.known) return { ok: false, refusal: 'request_not_found' };
      const request = register.requests.find((r) => r.id === input.requestId);
      if (request === undefined) return { ok: false, refusal: 'request_not_found' };

      // The catalogue is checked before the engine, so an invented reason never reaches the audit
      // trail — and approving "against_policy" is refused rather than recorded.
      const allowed: readonly string[] = reasonsFor(input.decision);
      if (!allowed.includes(input.reasonCode)) return { ok: false, refusal: 'unknown_reason_code' };

      // The CODE is what gets recorded, not a sentence. A code can be reported on a year later;
      // "ok fine" cannot.
      return submitDecision(request, config.manager, input.decision, input.reasonCode, input.decidedAt);
    },

    receive: (input) => ({
      receipt: commitReceipt(
        {
          id: input.grnId,
          number: input.number,
          poId: input.poId,
          warehouseId: config.warehouseId,
          receivedBy: config.manager.userId,
          receivedAt: input.receivedAt,
          lines: input.lines,
        },
        stockLedger,
        outbox,
      ),
      unmatched: input.poId === null,
    }),

    // The manager is the counter here, so a material variance needs somebody else's approval — the
    // adjustment engine enforces that and this session does not get to soften it.
    countStock: (input) => {
      // Asked BEFORE anything is committed. An unknown cost is not zero: valued at nothing, a
      // shrinkage of any size sits below the approval threshold and posts with nobody's approval.
      const value = ports.productValue(input.productId);
      if (!value.known) return { counted: false, refusal: 'value_not_known', why: value.why };

      return {
        counted: true,
        result: reconcileCount(
          {
            id: input.countId,
            productId: input.productId,
            locationId: input.locationId,
            uom: input.uom,
            countedMinor: input.countedMinor,
            counterId: config.manager.userId,
            at: input.at,
            reasonCode: input.reasonCode,
            valuePerUnit: inr(value.valuePerUnitMinor),
            thresholdMinor: config.countApprovalThresholdMinor,
            ...(input.approval === undefined ? {} : { approval: input.approval }),
          },
          stockLedger,
          outbox,
        ),
      };
    },

    blockersForClose,

    closeTheDay: (input) => {
      const blockers = blockersForClose(input.closedAtLocal);
      if (blockers.length > 0) return { closed: false, blockers };

      // The engine is still the authority, and it is still given the real numbers rather than a
      // literal zero — a literal here would be the assumption this whole file exists to refuse.
      const exceptions = ports.openExceptions(config.tradingDay);
      const unsent = ports.unsentItems(config.tradingDay);
      try {
        return {
          closed: true,
          result: closeDay(
            {
              id: input.dayCloseId,
              storeId: config.storeId,
              tradingDay: config.tradingDay,
              closedBy: config.manager.userId,
              closedAtLocal: input.closedAtLocal,
              closedAt: input.closedAt,
              tradingDayRule: config.tradingDayRule,
              unresolvedExceptions: exceptions.known ? exceptions.items.length : 0,
              unsentSyncItems: unsent.known ? unsent.items.length : 0,
            },
            outbox,
          ),
        };
      } catch (error) {
        // The engine refused when this screen predicted nothing would. That disagreement is a real
        // finding — it means one of them is wrong — so it is shown as a blocker rather than thrown
        // at a manager as a stack trace. Either way the day is not closed and the screen says so.
        return {
          closed: false,
          blockers: [{
            kind: 'rules_refused',
            count: 0,
            items: [],
            source: 'day-close',
            why: error instanceof Error ? error.message : String(error),
          }],
        };
      }
    },

    exceptions: () => ports.openExceptions(config.tradingDay),
    tasks: () => ports.tasks(config.tradingDay),
  };
}
