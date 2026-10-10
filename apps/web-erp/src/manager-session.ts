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
// A count entered here is CAPTURED blind and RECONCILED at head office (SP-2b · F11 · F07). This session
// keeps that structural on the manager's side: **there is no method here that returns an expected
// quantity, and nothing here computes a variance, a value or a threshold.** There is nothing to call
// and nothing for a later change to render early. What the counter saw travels the durable device
// queue to the store computer and on to head office, which owns the expected figure, the unit value
// and the approval threshold — the same control the till uses for the drawer, made structural.

import type { CurrencyCode } from '../../../packages/contracts/src/money';
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
import { isValidReasonFor } from '../../../packages/approvals/src/reasons';
import { closeDay, type DayCloseResult } from '../../../packages/day-close/src/day-close';
import type { Ledger } from '../../../packages/ledger/src/ledger';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { makeEvent } from '../../../packages/contracts/src/event';
import {
  deviceItemReason, deviceItemState, type BoxItemStatus, type DeviceItemState,
} from '../../../packages/sync/src/device-relay';
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
  /**
   * Ask the STORE COMPUTER to close and lock the trading day (M14-FR-04).
   *
   * Absent means this screen is not wired to a box — the local preview close is used instead, and it
   * only ever writes to this browser. Present means the box is the authority: it re-reads the real
   * outbox (the only honest source for "has everything reached the cloud?"), makes the gate decision,
   * writes the locked day durably, and queues `StoreDayClosed` for head office on its own sync agent.
   * The screen shows whatever the box decides; it never reports a close the box did not make.
   */
  /** Round 4: `closerPin` is the closer's own till PIN, keyed by them — the box verifies it (a typed name closes nothing). */
  requestDayClose?(input: { readonly dayCloseId: string; readonly closedBy: string; readonly closerPin?: string }): Promise<BoxCloseOutcome>;
}

/**
 * What the store computer said when asked to close the day (M14-FR-04).
 *
 * `closed: false` carries the box's own `reason` — a sentence from the authority, not a code from
 * this screen — because the box can refuse for a fact the browser's last-synced payload never saw (a
 * sale rung on a lane a second ago, still in the box's outbox). The screen surfaces it rather than
 * reporting a false all-clear (P-08), and never invents a translated blocker to stand in for it.
 */
export type BoxCloseOutcome =
  | { readonly closed: true; readonly tradingDay: string }
  | { readonly closed: false; readonly reason: string };

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
  /** Nobody is named on this screen, so nobody can lock the day (hard rule #4). */
  'nobody_named',
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
    case 'nobody_named':
      return 'Nobody is named on this screen, so nobody can close the day.';
  }
}

// ── Deciding an approval ────────────────────────────────────────────────────

/**
 * The decision vocabulary lives in `packages/approvals`, not here.
 *
 * A reason is mandatory (audit) and it is **chosen, not typed** — free text at a screen is a reason
 * nobody can report on afterwards, the same rule the till applies to a void. It is shared rather
 * than local because the owner's phone can decide the same request from the other side of the city,
 * and two vocabularies for one audit trail is one vocabulary too many.
 *
 * Re-exported so this surface's public shape is unchanged for anything already importing it.
 */
export {
  APPROVE_REASONS,
  REJECT_REASONS,
  reasonsFor,
  isValidReasonFor,
  type ApproveReason,
  type RejectReason,
  type DecisionReasonCode,
} from '../../../packages/approvals/src/reasons';

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
  | 'unknown_reason_code'
  /** The screen names nobody, so no decision can be attributed (hard rule #4). */
  | 'nobody_named'
  /**
   * This screen has ALREADY decided that request and the decision is in its queue (SP-2a). A second
   * decision is refused rather than queued beside the first — one request, one decision, however many
   * times a stale list is tapped.
   */
  | 'already_decided';

/** The full refusal vocabulary the screen must have words for, in every language it offers. */
export const DECIDE_REFUSALS: readonly DecideRefusal[] = Object.freeze([
  ...(Object.keys(ENGINE_REFUSALS) as RefusalReason[]),
  'request_not_found',
  'unknown_reason_code',
  'nobody_named',
  'already_decided',
]);

export type ManagerDecisionOutcome =
  | { readonly ok: true; readonly request: DecidedRequest }
  | { readonly ok: false; readonly refusal: DecideRefusal };

// ── The decision as it leaves this screen (SP-2a · F11) ─────────────────────

/** The event type a decided approval travels under: device queue → store computer → head office. */
export const APPROVAL_DECIDED = 'ApprovalDecided';

/**
 * One identity for one decision, everywhere it goes: the device outbox key, the box's dedupe key and
 * the cloud's idempotency key are all this. A request id is unique within the tenant, so a retry of
 * the same decision from any hop collapses to one record (§31.1); a DIFFERENT decision for the same
 * request is a conflict head office refuses (422) and a person sees, never a silent overwrite (#10).
 */
export function decisionKeyFor(requestId: string): string {
  return `approval-decision-${requestId}`;
}

/** What head office receives: the decided request, plus where it was decided. */
export interface ApprovalDecidedPayload extends DecidedRequest {
  readonly storeId: string;
  readonly source: 'manager-screen';
}

/**
 * A decision this screen has taken and where it has got to — the five states the owner asked for,
 * read from this device's queue and, once the store computer has been asked, from the box's own word.
 */
export interface QueuedDecision {
  readonly requestId: string;
  readonly subjectType: string;
  readonly subjectRef: string;
  readonly decision: Decision;
  readonly decidedAt: string;
  readonly state: DeviceItemState;
  /** How many times this device tried to hand it to the store computer and could not. */
  readonly attempts: number;
  /** The reason a person should read, when it was refused anywhere along the way. */
  readonly reason?: string;
}

/** The event type a blind count travels under (SP-2b): device queue → store computer → head office reconciles it. */
export const STOCK_COUNTED = 'StockCounted';
/** One identity for one count at every hop; a re-count is a NEW count id. */
export function countKeyFor(countId: string): string {
  return `count-${countId}`;
}
/** What head office receives for a count: only what the counter saw — never an expected quantity, value or threshold. */
export interface StockCountedPayload {
  readonly countId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly uom: string;
  readonly countedMinor: number;
  readonly reasonCode: string;
  readonly counterId: string;
  readonly at: string;
  readonly storeId: string;
  readonly source: 'manager-screen';
}

/** The kinds of work this screen saves on its device — a value, so the screen must have words for each. */
export const SAVED_WORK_KINDS = Object.freeze(['decision', 'receipt', 'count'] as const);
export type SavedWorkKind = (typeof SAVED_WORK_KINDS)[number];

/** One piece of work this screen saved, whatever its kind, and where it has got to. */
export interface SavedWork {
  readonly kind: SavedWorkKind;
  /** The request id, GRN id or count id. */
  readonly id: string;
  /** The line a person reads: subject · ref for a decision, the delivery note number for a receipt, product @ place for a count. */
  readonly what: string;
  /** The second line: approved/rejected, "N lines", or the counted quantity. */
  readonly detail: string;
  readonly at: string;
  readonly state: DeviceItemState;
  readonly attempts: number;
  readonly reason?: string;
}

// ── The session ─────────────────────────────────────────────────────────────

export interface ManagerConfig {
  readonly storeId: string;
  /** The branch this manager is working in; null = company-wide. */
  readonly branchId: string | null;
  /** The trading day being run (YYYY-MM-DD). */
  readonly tradingDay: string;
  /** Where this store's trading day ends (M01-FR-02). Per-tenant. */
  readonly tradingDayRule: TradingDayRule;
  /**
   * The manager: who they are, where they may approve, and up to what value. **Null when the screen was told
   * nobody** (Stage G slice 5c · hard rule #4): the registers still show, and every decision, receipt, count and
   * close refuses with `nobody_named` rather than run under a stand-in identity.
   */
  readonly manager: Approver | null;
  readonly currency: CurrencyCode;
  /** Where received goods land. Per-tenant. */
  readonly warehouseId: string;
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
}

/**
 * A blind count is CAPTURED here and RECONCILED at head office (SP-2b · F11 · M09-FR-04).
 *
 * Before SP-2b this screen reconciled the count itself, against an in-memory ledger that was empty after a reload —
 * so every count after a reload invented a variance. Now the screen records only what the counter saw and queues it;
 * head office computes the expected quantity, values the difference at its own cost and applies the tenant's
 * threshold (never a figure from this screen — F07). The variance therefore never appears here at all, which is the
 * blind-count control made structural: there is nothing on this path that could show it first.
 */
export type CountAttempt =
  | { readonly counted: true; readonly queued: true; readonly countId: string }
  | { readonly counted: false; readonly refusal: 'nobody_named' | 'already_counted'; readonly why: string };

export interface CloseInput {
  readonly dayCloseId: string;
  /** Store-local wall-clock moment of the close ("YYYY-MM-DDTHH:MM"). */
  readonly closedAtLocal: string;
  /** ISO-8601 UTC timestamp for the event. */
  readonly closedAt: string;
  /** Round 4: the manager's own till PIN, keyed by them at the close — passed to the store computer only, never kept. */
  readonly closerPin?: string;
}

export type CloseAttempt =
  | { readonly closed: true; readonly result: DayCloseResult }
  | { readonly closed: false; readonly blockers: readonly Blocker[] };

export type ApprovalQueue =
  | { readonly known: true; readonly rows: readonly QueueRow[] }
  | { readonly known: false; readonly why: string };

export interface FloorSummary {
  /** Who this screen is running as, or null when the store named nobody (the page then says so). */
  readonly manager: string | null;
  readonly tradingDay: string;
  /** Everything waiting, including what this manager may not decide themselves. */
  readonly approvalsWaiting: Tally;
  /** What this manager can actually clear right now (§28 removes their own requests). */
  readonly approvalsIcanClear: Tally;
  readonly exceptions: Tally;
  /**
   * Everything not yet at head office that this screen knows of: the store's register, PLUS the work
   * saved on this device that the store computer has not yet taken (`heldHere`). A decision that lives
   * only on this screen is exactly as unsent as a sale in the box's outbox, and the day must not close
   * over either (M14-FR-04, hard rule #10).
   */
  readonly unsent: Tally;
  /** Work saved on this device and not yet handed to the store computer — a subset of `unsent`. */
  readonly heldHere: number;
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
  /**
   * Every decision this screen has taken, newest first, with where it has got to (SP-2a). Read from the
   * durable device queue, so it is the same list after a reload — and it is what keeps a decided request
   * out of `approvalQueue()` until head office's register catches up.
   */
  decisions(): readonly QueuedDecision[];
  /** Everything this screen saved — decisions, receipts, counts — newest first, with where each has got to (SP-2b). */
  savedWork(): readonly SavedWork[];
  /** The queue keys of work the store computer has taken (any kind), to ask it where they have got to. */
  handedKeys(): readonly string[];
  /** Fold in the store computer's word on items it took (posted · still pending · refused), from a status query. */
  noteBoxStatus(statuses: readonly BoxItemStatus[]): void;
  /** Book a delivery in. Stock rises locally; the WHOLE receipt queues for head office on the durable device queue (M07). */
  receive(input: ReceiveInput): ReceivedGoods;
  /** Capture a blind count and queue it for head office to reconcile (M09-FR-04). Nothing here reveals — or computes — the expected. */
  countStock(input: CountInput): CountAttempt;
  /** Everything standing between this store and a closed day — enumerated, never just counted. */
  blockersForClose(closedAtLocal: string): readonly Blocker[];
  /** Close the day, or come back with the list of what to clear first (M14-FR-04). */
  closeTheDay(input: CloseInput): CloseAttempt;
  /**
   * True when this screen is wired to the store computer and the close goes THERE (M14-FR-04).
   *
   * The view reads this to choose the path: the box makes the authoritative decision and reaches the
   * cloud, where the local `closeTheDay` only ever locks this browser. False means no box is wired
   * (standalone or a demo), and the local preview close is the only close there is.
   */
  readonly canCloseViaBox: boolean;
  /**
   * Ask the store computer to close and lock the day (M14-FR-04) — the authoritative close.
   *
   * Sent in the manager's own name (`config.manager.userId`), so the box records who locked the day
   * and the cloud can enforce §28 on any later reopen (a reopen needs a different, authorised person).
   * When no box is wired this refuses with a reason rather than pretending; the view then keeps the
   * day open and says so.
   */
  closeViaBox(input: CloseInput): Promise<BoxCloseOutcome>;
  /** Open exceptions for the day (M15), for the exceptions screen. */
  exceptions(): Register;
  /** Today's checklists and staff tasks (D11-FR-01 / M25). */
  tasks(): Register;
}

function tally(register: Register): Tally {
  return register.known ? { known: true, count: register.items.length } : register;
}

/** Thrown by an action that has no refusal shape of its own when the screen names nobody (hard rule #4). */
export class NobodyNamedError extends Error {
  constructor(action: string) {
    super(`Nobody is named on this screen, so it cannot ${action}.`);
    this.name = 'NobodyNamedError';
  }
}

export function createManagerSession(
  config: ManagerConfig,
  ports: ManagerPorts,
  /** The store's stock ledger — received goods and count adjustments append to it. */
  stockLedger: Ledger,
  outbox: SyncOutbox,
): ManagerSession {
  // The store computer's word on each decision it has taken, keyed by the decision's queue key. Filled by
  // `noteBoxStatus` from a status query; empty until the box has been asked (then "handed to the store
  // computer" is all this screen claims — never "posted" on its own say-so, P-08).
  const boxWord = new Map<string, BoxItemStatus>();

  /** Has THIS screen already decided the request? Its decision is in the durable queue, whatever state it reached. */
  const decidedHere = (requestId: string): boolean => outbox.find(decisionKeyFor(requestId)) !== undefined;

  /**
   * The requests still open for this screen: the store's register MINUS anything this screen has already
   * decided. The register is the box's last-synced snapshot (the pack), which cannot yet know about a decision
   * made a moment ago on this device — so the durable queue is the authority for "decided", and it survives
   * a reload exactly as the queue does (F11: before this, the same request was offered again on every reload).
   */
  const openRequests = (): ApprovalRegister => {
    const register = ports.approvals();
    if (!register.known) return register;
    return { known: true, requests: register.requests.filter((r) => !decidedHere(r.id)) };
  };

  const approvalQueue = (): ApprovalQueue => {
    const register = openRequests();
    if (!register.known) return register;
    return { known: true, rows: buildQueue(register.requests, config.manager) };
  };

  /** Work saved on this device that the store computer has not yet taken. */
  const heldHere = (): number => outbox.pending().length;

  /**
   * The store's unsent register with this device's own held work added — one honest count of "not yet at
   * head office", for the home tile and for the day-close gate alike. Unknown stays unknown: this device's
   * queue cannot vouch for the box's.
   */
  const unsentIncludingHeldHere = (): Register => {
    const register = ports.unsentItems(config.tradingDay);
    if (!register.known) return register;
    const held: RegisterItem[] = outbox.pending().map((item) => ({ id: item.key, what: `${item.event.type} (saved on this screen)` }));
    return { known: true, items: [...register.items, ...held] };
  };

  const blockersForClose = (closedAtLocal: string): readonly Blocker[] => {
    const blockers: Blocker[] = [];

    // 0. Is anybody here? A day locked by nobody is a day nobody can be asked about (hard rule #4).
    if (config.manager === null) {
      blockers.push({ kind: 'nobody_named', count: 0, items: [], source: 'manager' });
    }

    // 1. Has the day this manager is closing actually ended? Judged HERE only when this screen is the closer
    //    (no store computer wired): the local preview close locks `config.tradingDay`, so it must have ended.
    //    With a store computer wired, the BOX is the authority (M14-FR-04): it closes the most recently ENDED
    //    trading day itself and refuses one that has not, while this screen's `tradingDay` is the RUNNING day
    //    for the floor's registers — judging that day here would block every close. (Before Stage G slice 5c
    //    the served screen ran on day 1970-01-01, which made this check vacuous by accident, not by design.)
    if (ports.requestDayClose === undefined) {
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
    }

    // 2 and 3. The two gates M14-FR-04 names. Each register gets the same treatment, and *not
    //    knowing* produces a blocker exactly as an open item does.
    const gates: readonly { readonly source: string; readonly kind: BlockerKind; readonly register: Register }[] = [
      { source: 'exceptions', kind: 'exceptions_open', register: ports.openExceptions(config.tradingDay) },
      { source: 'unsent', kind: 'items_unsent', register: unsentIncludingHeldHere() },
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
      const approvals = openRequests();
      const queue = approvalQueue();
      return {
        manager: config.manager === null ? null : config.manager.userId,
        tradingDay: config.tradingDay,
        approvalsWaiting: approvals.known ? { known: true, count: approvals.requests.length } : approvals,
        approvalsIcanClear: queue.known
          ? { known: true, count: queue.rows.filter((row) => row.actionable).length }
          : queue,
        exceptions: tally(ports.openExceptions(config.tradingDay)),
        unsent: tally(unsentIncludingHeldHere()),
        heldHere: heldHere(),
        tasks: tally(ports.tasks(config.tradingDay)),
      };
    },

    approvalQueue,

    decideApproval: (input) => {
      if (config.manager === null) return { ok: false, refusal: 'nobody_named' };
      const register = ports.approvals();
      if (!register.known) return { ok: false, refusal: 'request_not_found' };
      const request = register.requests.find((r) => r.id === input.requestId);
      if (request === undefined) return { ok: false, refusal: 'request_not_found' };
      // Already in this screen's durable queue: one request, one decision (SP-2a). Refused BEFORE the engine,
      // so a stale list tapped twice never queues a second decision for head office to find conflicting.
      if (decidedHere(request.id)) return { ok: false, refusal: 'already_decided' };

      // The catalogue is checked before the engine, so an invented reason never reaches the audit
      // trail — and approving "against_policy" is refused rather than recorded.
      if (!isValidReasonFor(input.decision, input.reasonCode)) {
        return { ok: false, refusal: 'unknown_reason_code' };
      }

      // The CODE is what gets recorded, not a sentence. A code can be reported on a year later;
      // "ok fine" cannot.
      const outcome = submitDecision(request, config.manager, input.decision, input.reasonCode, input.decidedAt);
      if (!outcome.ok) return outcome;

      // The decision is QUEUED before it is called decided (F11 — before this, `ok: true` was returned and the
      // decision existed nowhere). The outbox is the durable device queue `bootManager` opens; enqueue writes
      // it to the device before returning, and the shared device → box → cloud path carries it from there.
      // The key is the decision's one identity at every hop (`decisionKeyFor`).
      const payload: ApprovalDecidedPayload = { ...outcome.request, storeId: config.storeId, source: 'manager-screen' };
      outbox.enqueue(makeEvent({
        id: decisionKeyFor(request.id),
        type: APPROVAL_DECIDED,
        occurredAt: input.decidedAt,
        idempotencyKey: decisionKeyFor(request.id),
        source: 'web-erp/manager',
        payload,
      }));
      return outcome;
    },

    decisions: () => outbox.all()
      .filter((item) => item.event.type === APPROVAL_DECIDED)
      .map((item) => {
        const p = item.event.payload as ApprovalDecidedPayload;
        const box = boxWord.get(item.key);
        const reason = deviceItemReason(item, box);
        return {
          requestId: p.id, subjectType: p.subjectType, subjectRef: p.subjectRef, decision: p.status,
          decidedAt: p.decidedAt, state: deviceItemState(item, box), attempts: item.attempts,
          ...(reason === undefined ? {} : { reason }),
        };
      })
      .reverse(),

    savedWork: () => outbox.all()
      .flatMap((item): SavedWork[] => {
        const box = boxWord.get(item.key);
        const common = { state: deviceItemState(item, box), attempts: item.attempts, at: item.event.occurredAt } as const;
        const reason = deviceItemReason(item, box);
        const withReason = reason === undefined ? {} : { reason };
        if (item.event.type === APPROVAL_DECIDED) {
          const p = item.event.payload as ApprovalDecidedPayload;
          return [{ kind: 'decision', id: p.id, what: `${p.subjectType} · ${p.subjectRef}`, detail: p.status, ...common, ...withReason }];
        }
        if (item.event.type === 'GoodsReceived') {
          const p = item.event.payload as { grnId: string; number: string; lineCount: number; poId: string | null };
          return [{ kind: 'receipt', id: p.grnId, what: p.number, detail: `${p.lineCount} ${p.poId === null ? '· no purchase order' : `· ${p.poId}`}`, ...common, ...withReason }];
        }
        if (item.event.type === STOCK_COUNTED) {
          const p = item.event.payload as StockCountedPayload;
          return [{ kind: 'count', id: p.countId, what: `${p.productId} @ ${p.locationId}`, detail: `${p.countedMinor} ${p.uom}`, ...common, ...withReason }];
        }
        return [];
      })
      .reverse(),

    handedKeys: () => outbox.all()
      .filter((item) => item.state === 'acknowledged')
      .map((item) => item.key),

    noteBoxStatus: (statuses) => {
      for (const s of statuses) boxWord.set(s.key, s);
    },

    receive: (input) => {
      if (config.manager === null) throw new NobodyNamedError('book a delivery in');
      return {
      receipt: commitReceipt(
        {
          id: input.grnId,
          number: input.number,
          poId: input.poId,
          warehouseId: config.warehouseId,
          receivedBy: config.manager.userId,
          receivedAt: input.receivedAt,
          lines: input.lines,
          // Where and on what it was booked in (SP-2b) — head office re-verifies the receiver and re-runs the rules.
          storeId: config.storeId,
          source: 'manager-screen',
        },
        stockLedger,
        outbox,
      ),
      unmatched: input.poId === null,
      };
    },

    // The manager is the counter here. What is captured is ONLY what they saw; head office computes the expected
    // quantity, values the difference at its own cost, applies the tenant's threshold and holds a material variance
    // for a separate approver (§28) — none of which this screen can do honestly after a reload (F11), and none of
    // which it should be able to see first (the blind-count control, structural). Queued BEFORE it is called counted.
    countStock: (input) => {
      if (config.manager === null) {
        return { counted: false, refusal: 'nobody_named', why: 'nobody is named on this screen, so no count can be attributed' };
      }
      if (outbox.find(countKeyFor(input.countId)) !== undefined) {
        return { counted: false, refusal: 'already_counted', why: `count ${input.countId} is already saved on this screen — a re-count is a new count` };
      }
      const payload: StockCountedPayload = {
        countId: input.countId, productId: input.productId, locationId: input.locationId, uom: input.uom,
        countedMinor: input.countedMinor, reasonCode: input.reasonCode, counterId: config.manager.userId, at: input.at,
        storeId: config.storeId, source: 'manager-screen',
      };
      outbox.enqueue(makeEvent({
        id: countKeyFor(input.countId),
        type: STOCK_COUNTED,
        occurredAt: input.at,
        idempotencyKey: countKeyFor(input.countId),
        source: 'web-erp/manager',
        payload,
      }));
      return { counted: true, queued: true, countId: input.countId };
    },

    blockersForClose,

    closeTheDay: (input) => {
      const blockers = blockersForClose(input.closedAtLocal);
      if (blockers.length > 0) return { closed: false, blockers };

      // The engine is still the authority, and it is still given the real numbers rather than a
      // literal zero — a literal here would be the assumption this whole file exists to refuse.
      const exceptions = ports.openExceptions(config.tradingDay);
      const unsent = unsentIncludingHeldHere();
      try {
        return {
          closed: true,
          result: closeDay(
            {
              id: input.dayCloseId,
              storeId: config.storeId,
              tradingDay: config.tradingDay,
              // Unreachable with a null manager: `nobody_named` is a blocker above. Named here for the compiler.
              closedBy: config.manager?.userId ?? 'nobody',
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

    canCloseViaBox: ports.requestDayClose !== undefined,

    closeViaBox: async (input) => {
      const post = ports.requestDayClose;
      // No box wired: this screen cannot lock a store's day on its own, and it must not say it did.
      // The view falls back to the local preview close (which is honest about only touching this
      // browser) when it sees `canCloseViaBox` is false; this guards the case it asked anyway.
      if (post === undefined) {
        return { closed: false, reason: 'this screen is not connected to the store computer, so it cannot close the day' };
      }
      // The box is the authority. It is sent the day-close id and WHO is closing (the manager's own
      // id), and it decides — reading the real outbox, not this browser's last-synced snapshot. The
      // screen renders whatever comes back and invents nothing.
      if (config.manager === null) {
        return { closed: false, reason: 'nobody is named on this screen, so it cannot close the day' };
      }
      // Round 4: with the manager's OWN till PIN — the box verifies the person and their authority before it locks anything.
      return post({ dayCloseId: input.dayCloseId, closedBy: config.manager.userId, ...(input.closerPin === undefined || input.closerPin === '' ? {} : { closerPin: input.closerPin }) });
    },

    exceptions: () => ports.openExceptions(config.tradingDay),
    tasks: () => ports.tasks(config.tradingDay),
  };
}
