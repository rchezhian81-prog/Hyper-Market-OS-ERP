// Warehouse handheld session (M09 / OA-9) — the offline, scanner-first execution engine behind the
// Warehouse PWA. It runs on a low-spec Android handheld in the racking, so it is **synchronous and
// local by construction** (P-01, §31): the assignment is cached, every scan is decided locally
// against the facts the box served, nothing here awaits the network, and every accepted action is
// queued to the sync outbox to reconcile idempotently later (hard rule #1 — commit locally first).
//
// ── It ORCHESTRATES the authoritative engines; it never re-decides ───────────
//
// Both interfaces (this PWA and the Web ERP) must use the SAME warehouse rules (OA-9). So receiving
// is `packages/receiving` (`receiveScan`: barcode resolution, case conversion, DSD and over-delivery
// approval by a SEPARATE person §28, price-change refusal, duplicate-scan no-op, unknown-barcode to a
// resolution queue); put-away, bin capacity AND the pick from a bin are `packages/warehouse`
// (`applyMovement` / `suggestPutAway`: unknown-bin queued not invented, full-bin and over-draw refused,
// bad stock kept out of pickable bins, a pick never draws a bin negative); and expiry/recall are
// `packages/fefo` (`isExpired`). This file adds NO stock rule of its own — it wires the scans to the
// engines, keeps the local projection, queues the sync events, and turns each outcome into scan
// feedback (visual/sound/vibration hints, OA-9). The one check that is this file's own is the pick
// list's: the bin scanned must be the bin the line names, and the item scanned must be the line's
// item — those are facts about the ASSIGNMENT, not stock rules, and the engine cannot know them.
//
// ── The outbox is a required constructor argument ────────────────────────────
//
// Exactly as on the picker handheld: a receipt or a put-away that is not queued is work that existed
// only until the handheld was closed. The queue is not optional, because a forgotten queue is
// invisible. Every accepted action queues its event.

import { makeEvent } from '../../../packages/contracts/src/event';
import { money, type CurrencyCode } from '../../../packages/contracts/src/money';
import {
  receiveScan, DEFAULT_RECEIVING_POLICY,
  type ReceiveResult, type ReceiveSource, type ReceivingPolicy, type ReceiveApproval,
  type BarcodeResolution, type OrderedProduct,
} from '../../../packages/receiving/src/asn';
import type { PackHierarchy } from '../../../packages/product/src/pack';
import {
  applyMovement, suggestPutAway, binKey,
  type Bin, type BinContents, type MovementCommand, type MovementOutcome, type MovementResult, type PutAwaySuggestion,
} from '../../../packages/warehouse/src/movements';
import { isExpired } from '../../../packages/fefo/src/fefo';
import { isAdjustmentReason, type AdjustmentReasonCode } from '../../../packages/adjustment/src/adjustment';
import type { StockState } from '../../../packages/stock/src/position';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import {
  deviceItemReason, deviceItemState, type BoxItemStatus, type DeviceItemState,
} from '../../../packages/sync/src/device-relay';

/** How the shell should react to a scan (OA-9 scan confirmation: visual, sound, vibration). */
export type ScanFeedback = 'accept' | 'warn' | 'reject';

/**
 * Every feedback `code` this session can return — the authoritative list the shell must have a word
 * for, in English AND Tamil (OA-9 bilingual). A completeness tripwire binds the view's vocabulary to
 * this, so adding an outcome and forgetting its words fails the build rather than showing a warehouse
 * worker a blank reason at the moment a scan was refused.
 */
export const FEEDBACK_CODES = Object.freeze([
  // receiving (packages/receiving)
  'received', 'unknown_barcode', 'over_delivery_needs_approval', 'dsd_needs_approval',
  'price_change_refused', 'not_on_order',
  // put-away (packages/warehouse) + this session's own checks
  'moved', 'duplicate_ignored', 'wrong_sku', 'unknown_bin', 'bin_full',
  'insufficient_goods_in', 'insufficient_in_bin', 'not_pickable_state',
  'recalled_into_pickable', 'expired_into_pickable', 'invalid_command',
  // picking an order line (packages/warehouse `pick` + this session's pick-list checks)
  'picked', 'wrong_bin', 'wrong_item', 'not_on_pick_list', 'line_done',
  // a blind bin count (W2) and an adjustment request (W3) — SP-3b
  'counted', 'adjustment_requested', 'not_a_quantity', 'no_reason',
  // the delivery declared complete — sent as ONE receipt for head office to assemble against the order (SP-6b)
  'receiving_done', 'nothing_received',
] as const);
export type FeedbackCode = (typeof FEEDBACK_CODES)[number];

/**
 * A scan-feedback signal. The `code` is the stable machine reason (the shell maps it to the worker's
 * language, English **and** Tamil, exactly as the manager screen binds its vocabularies); `detail` is
 * a plain-English fallback. `sound`/`vibrateMs` are the device hints the shell realises where the
 * hardware supports them — a rejected scan must be felt, not just seen, by someone wearing ear
 * defenders in a cold store.
 */
export interface FeedbackSignal {
  readonly feedback: ScanFeedback;
  readonly code: string;
  readonly detail: string;
  readonly sound: 'ok' | 'warn' | 'error';
  readonly vibrateMs: number;
  /** True when the item could not be identified/placed and a person must resolve it. */
  readonly resolutionRequired?: boolean;
}

function signalFor(feedback: ScanFeedback, code: string, detail: string, resolutionRequired = false): FeedbackSignal {
  const shape = feedback === 'accept'
    ? { sound: 'ok' as const, vibrateMs: 40 }
    : feedback === 'warn'
      ? { sound: 'warn' as const, vibrateMs: 120 }
      : { sound: 'error' as const, vibrateMs: 300 };
  return { feedback, code, detail, ...shape, ...(resolutionRequired ? { resolutionRequired: true } : {}) };
}

/** One scan at the back door — the fields the receiving engine needs, from a single handheld scan. */
export interface ReceiveInput {
  readonly commandId: string;
  readonly grnId: string;
  readonly barcode: string;
  readonly scannedQuantity: number;
  readonly source: ReceiveSource;
  readonly poId?: string;
  readonly asnId?: string;
  readonly batchId?: string;
  readonly expiry?: string;
  /** Only for DSD, where there is no PO price to match against. */
  readonly declaredUnitCostMinor?: number;
  /** The condition the goods arrived in — a damaged carton is received but never put where it sells. */
  readonly stockState?: StockState;
}

export interface ReceiveActionResult {
  readonly result: ReceiveResult;
  readonly signal: FeedbackSignal;
}

/** Goods received and waiting to be put away — the put-away worklist, per product+batch. */
export interface GoodsInItem {
  readonly productId: string;
  readonly batchId: string | null;
  readonly quantityMinor: number;
  readonly uom: string;
  readonly state: StockState;
  readonly expiry: string | null;
  readonly recalled: boolean;
}

/** One put-away scan: the item scanned, and the bin scanned to place it in. */
export interface PutAwayInput {
  readonly commandId: string;
  readonly scannedProductId: string;
  readonly scannedBinId: string;
  readonly batchId?: string | null;
  readonly quantityMinor: number;
  readonly uom: string;
  readonly at: string;
}

export interface PutAwayActionResult {
  readonly result: MovementResult;
  readonly signal: FeedbackSignal;
}

/** One order line to pick, as the box assigned it: which bin the stock is in and how much is wanted. */
export interface AssignedPickLine {
  readonly lineId: string;
  /** The order or replenishment this line belongs to — named in the movement's reason for the audit trail. */
  readonly orderRef: string;
  readonly productId: string;
  readonly batchId: string | null;
  /** The bin the pick list says the stock is in. A different bin is different stock. */
  readonly binId: string;
  readonly quantityMinor: number;
  readonly uom: string;
}

/** A pick-list line as the worklist shows it: the assignment plus what has been picked against it here. */
export interface PickLine extends AssignedPickLine {
  readonly pickedMinor: number;
  readonly remainingMinor: number;
}

/**
 * The three scans of a pick: the line (chosen by scanning its bin from the list, or tapped), the bin,
 * the item. `quantityMinor` defaults to what remains on the line — a full pick is the normal case, and
 * the confirm step shows the number before it is committed.
 */
export interface PickInput {
  readonly commandId: string;
  readonly lineId: string;
  readonly scannedBinId: string;
  /** The item's barcode from the catalogue, or its own product code from an internal label. */
  readonly scannedItem: string;
  readonly quantityMinor?: number;
  readonly at: string;
}

export interface PickActionResult {
  readonly result: MovementResult;
  readonly signal: FeedbackSignal;
}

/**
 * What the screen asks between scans: is this the right bin — and, once the item is scanned, the right
 * item — for this line? The same checks `pick` makes, so the worker is told at the shelf, not after
 * confirming. Nothing is committed and nothing is queued by a check.
 */
export type PickCheck =
  | { readonly ok: true; readonly line: PickLine }
  | { readonly ok: false; readonly signal: FeedbackSignal };

/** The event a receiving SCAN travels under (SP-3a): one scan, not a whole receipt — the manager's `GoodsReceived` is that. */
export const RECEIVING_SCANNED = 'ReceivingScanned';
/** The event a put-away or a pick travels under — the command the handheld applied, for the cloud to re-apply. */
export const WAREHOUSE_MOVEMENT_APPLIED = 'WarehouseMovementApplied';
/** The event a BLIND bin count travels under (SP-3b · W2) — the same type and cloud route as the manager's count, plus the bin. */
export const STOCK_COUNTED = 'StockCounted';
/** The event an adjustment REQUEST travels under (SP-3b · W3) — recorded pending at head office, posted only when a supervisor approves. */
export const ADJUSTMENT_REQUESTED = 'AdjustmentRequested';
/** The reason a routine handheld bin count carries — a cycle count, not a correction (the correction is head office's). */
export const HANDHELD_COUNT_REASON = 'cycle_count';
/**
 * The event a delivery's COMPLETION travels under (SP-6b): one per GRN, behind its scans in the queue. Head office assembles
 * the goods receipt from the scans it already holds and folds it into the purchase order — nothing in it moves stock.
 */
export const RECEIVING_COMPLETED = 'ReceivingCompleted';

/** The kinds of work this handheld hands to the store computer — a value, so the shell must have words for each. */
export const SENT_WORK_KINDS = Object.freeze(['receipt', 'receipt_done', 'put_away', 'pick', 'count', 'adjustment'] as const);
export type SentWorkKind = (typeof SENT_WORK_KINDS)[number];

/** "Delivery complete" (SP-6b): the GRN this handheld has been receiving, and the order it was delivered against when known. */
export interface CompleteReceivingInput {
  readonly grnId: string;
  /** Overrides the assignment's order; `null` says there is none (a DSD). */
  readonly poId?: string | null;
  readonly at?: string;
}
export interface CompleteReceivingResult {
  readonly accepted: boolean;
  readonly grnId: string;
  /** How many of this handheld's receiving scans the completion covers. */
  readonly scanCount: number;
  readonly signal: FeedbackSignal;
}

/** One blind count of one product in one bin (W2): what the worker SAW, and nothing the system expects. */
export interface CountBinInput {
  readonly countId: string;
  readonly scannedBinId: string;
  readonly scannedItem: string;
  readonly countedMinor: number;
  readonly at: string;
}
export interface CountActionResult {
  readonly accepted: boolean;
  readonly countId: string;
  readonly productId?: string;
  readonly binId: string;
  readonly signal: FeedbackSignal;
}

/** An adjustment REQUEST (W3): a signed correction with a reason, raised here, decided by a supervisor at head office. */
export interface AdjustmentRequestInput {
  readonly requestId: string;
  readonly scannedItem: string;
  /** Signed: positive = found more, negative = missing / damaged. Never zero. */
  readonly deltaMinor: number;
  readonly reasonCode: string;
  readonly note?: string;
  readonly binId?: string | null;
  readonly at: string;
}
export interface AdjustmentActionResult {
  readonly accepted: boolean;
  readonly requestId: string;
  readonly productId?: string;
  readonly signal: FeedbackSignal;
}

/** One accepted scan on its way to head office, and where it has got to (the five shared state words, SP-2a). */
export interface SentWork {
  readonly kind: SentWorkKind;
  /** The handheld's own command id — the key every hop dedupes on. */
  readonly id: string;
  /** What a person reads: the product (and batch), and for a movement the bin. */
  readonly what: string;
  readonly detail: string;
  readonly at: string;
  readonly state: DeviceItemState;
  readonly attempts: number;
  readonly reason?: string;
}

/** What the box served the handheld — the assignment it caches and works offline. */
export interface WarehouseAssignment {
  readonly assignmentId: string;
  readonly workerId: string;
  readonly storeId: string;
  readonly bins: readonly Bin[];
  /** Current bin contents, per bin|product|batch — the base the local projection folds onto. */
  readonly contents?: BinContents;
  /** Catalogue for receiving: which barcode is which product, and the pack hierarchy for cases. */
  readonly barcodes?: readonly BarcodeResolution[];
  readonly packs?: readonly PackHierarchy[];
  /** The GRN context: what is on order, so an over-delivery or an off-order item is caught (§28). */
  readonly grnId?: string;
  readonly ordered?: readonly OrderedProduct[];
  /** SP-6b: the purchase order the delivery is against, named on "delivery complete" so head office folds the GRN into it. */
  readonly poId?: string;
  /** Goods already received and awaiting put-away when the assignment was served. */
  readonly goodsIn?: readonly GoodsInItem[];
  /** Order lines to pick from the racking, each naming its bin (M09-FR-01 pick). Absent = no pick work. */
  readonly pickLines?: readonly AssignedPickLine[];
  /** Products / batches under recall — never put into a pickable bin, even offline (M10-FR-04). */
  readonly recalledProductIds?: readonly string[];
  readonly recalledBatchIds?: readonly string[];
  readonly receivingPolicy?: ReceivingPolicy;
}

const gKey = (productId: string, batchId: string | null): string => `${productId}|${batchId ?? ''}`;

/**
 * A warehouse worker's cached assignment. Everything is local and synchronous; the handheld works
 * with no signal and the accepted actions queue for idempotent sync afterwards.
 */
export class WarehouseSession {
  private readonly bins: readonly Bin[];
  private readonly contents: Record<string, number>;
  private readonly barcodes: readonly BarcodeResolution[];
  private readonly packs: readonly PackHierarchy[];
  private readonly ordered?: readonly OrderedProduct[];
  private readonly recalledProducts: ReadonlySet<string>;
  private readonly recalledBatches: ReadonlySet<string>;
  private readonly policy: ReceivingPolicy;

  private readonly goods = new Map<string, GoodsInItem>();
  /** The pick list by line id, with what has been picked against each line this session. */
  private readonly picks = new Map<string, { readonly line: AssignedPickLine; pickedMinor: number }>();
  private readonly appliedCommandIds: string[] = [];
  private readonly receivedSoFar: Record<string, number> = {};
  /** The store computer's word on each item it took, keyed by queue key — filled by `noteBoxStatus` (SP-3a). */
  private readonly boxWord = new Map<string, BoxItemStatus>();

  private readonly currency: CurrencyCode;
  private readonly at: () => string;

  constructor(
    private readonly assignment: WarehouseAssignment,
    /** Where every accepted receipt and put-away is queued for sync. Required — see the file note. */
    private readonly outbox: SyncOutbox,
    options: { readonly currency?: CurrencyCode; readonly now?: () => string } = {},
  ) {
    this.bins = assignment.bins;
    this.contents = { ...(assignment.contents ?? {}) };
    this.barcodes = assignment.barcodes ?? [];
    this.packs = assignment.packs ?? [];
    if (assignment.ordered !== undefined) this.ordered = assignment.ordered;
    this.recalledProducts = new Set(assignment.recalledProductIds ?? []);
    this.recalledBatches = new Set(assignment.recalledBatchIds ?? []);
    this.policy = assignment.receivingPolicy ?? DEFAULT_RECEIVING_POLICY;
    this.currency = options.currency ?? 'INR';
    this.at = options.now ?? (() => new Date().toISOString());
    for (const item of assignment.goodsIn ?? []) this.goods.set(gKey(item.productId, item.batchId), { ...item });
    for (const line of assignment.pickLines ?? []) this.picks.set(line.lineId, { line: { ...line, batchId: line.batchId ?? null }, pickedMinor: 0 });
  }

  /** The put-away worklist: goods received and not yet binned. */
  goodsIn(): readonly GoodsInItem[] {
    return [...this.goods.values()];
  }

  /** The pick worklist: every assigned line with something left to pick, in the order the box sent them. */
  pickLines(): readonly PickLine[] {
    return [...this.picks.values()]
      .map(({ line, pickedMinor }) => ({ ...line, pickedMinor, remainingMinor: line.quantityMinor - pickedMinor }))
      .filter((line) => line.remainingMinor > 0);
  }

  /** The current local bin projection — the base contents plus every put-away accepted this session. */
  binContents(): BinContents {
    return { ...this.contents };
  }

  /** Fold in the store computer's word on items it took (`GET /lane/outbox/status`) — "posted" is only ever its say-so. */
  noteBoxStatus(statuses: readonly BoxItemStatus[]): void {
    for (const s of statuses) this.boxWord.set(s.key, s);
  }

  /** The queue keys of work the store computer has taken, to ask it where they have got to. */
  handedKeys(): readonly string[] {
    return this.outbox.all().filter((item) => item.state === 'acknowledged').map((item) => item.key);
  }

  /**
   * Every accepted scan this handheld has queued — receipts, put-aways, picks — newest first, each with where it has
   * got to (SP-3a · S1): saved here · retrying · with the store computer · posted · refused (with the reason). Read from
   * the durable device queue, so the list is the same after the app is closed and opened again.
   */
  sentWork(): readonly SentWork[] {
    return this.outbox.all()
      .flatMap((item): SentWork[] => {
        const box = this.boxWord.get(item.key);
        const common = { at: item.event.occurredAt, state: deviceItemState(item, box), attempts: item.attempts } as const;
        const reason = deviceItemReason(item, box);
        const withReason = reason === undefined ? {} : { reason };
        if (item.event.type === RECEIVING_SCANNED) {
          const p = item.event.payload as { commandId: string; productId: string; batchId: string | null; quantityMinor: number; uom: string; grnId: string };
          return [{ kind: 'receipt', id: p.commandId, what: `${p.productId}${p.batchId ? ` · ${p.batchId}` : ''}`, detail: `${p.quantityMinor} ${p.uom} · ${p.grnId}`, ...common, ...withReason }];
        }
        if (item.event.type === RECEIVING_COMPLETED) {
          const p = item.event.payload as { grnId: string; poId: string | null; scanCount: number };
          return [{ kind: 'receipt_done', id: p.grnId, what: p.grnId, detail: `${p.scanCount} ${p.scanCount === 1 ? 'scan' : 'scans'}${p.poId ? ` · ${p.poId}` : ''}`, ...common, ...withReason }];
        }
        if (item.event.type === WAREHOUSE_MOVEMENT_APPLIED) {
          const p = item.event.payload as { command: MovementCommand; orderRef?: string };
          const c = p.command;
          const kind: SentWorkKind = c.kind === 'pick' ? 'pick' : 'put_away';
          const bin = c.kind === 'pick' ? (c.fromBinId ?? '') : (c.toBinId ?? '');
          return [{ kind, id: c.commandId, what: `${c.productId}${c.batchId ? ` · ${c.batchId}` : ''} · ${bin}`, detail: `${c.quantityMinor} ${c.uom}${p.orderRef ? ` · ${p.orderRef}` : ''}`, ...common, ...withReason }];
        }
        if (item.event.type === STOCK_COUNTED) {
          // Only what was counted — never an expected figure, which this handheld does not have (blind, W2).
          const p = item.event.payload as { countId: string; productId: string; binId: string | null; countedMinor: number; uom: string };
          return [{ kind: 'count', id: p.countId, what: `${p.productId} · ${p.binId ?? ''}`, detail: `${p.countedMinor} ${p.uom}`, ...common, ...withReason }];
        }
        if (item.event.type === ADJUSTMENT_REQUESTED) {
          const p = item.event.payload as { requestId: string; productId: string; binId: string | null; deltaMinor: number; uom: string; reasonCode: string };
          return [{ kind: 'adjustment', id: p.requestId, what: `${p.productId}${p.binId ? ` · ${p.binId}` : ''}`, detail: `${p.deltaMinor > 0 ? '+' : ''}${p.deltaMinor} ${p.uom} · ${p.reasonCode}`, ...common, ...withReason }];
        }
        return [];
      })
      .reverse();
  }

  private isRecalled(productId: string, batchId: string | null): boolean {
    return this.recalledProducts.has(productId) || (batchId !== null && this.recalledBatches.has(batchId));
  }

  /**
   * Receive one scan at the back door (M07 / §31.1), through the authoritative receiving engine.
   * An accepted receipt adds to the put-away worklist and queues a `GoodsReceived` event; a refusal
   * (unknown barcode, off-order, over-delivery/DSD needing a separate approver §28, price change)
   * queues nothing and returns the reason as scan feedback. Duplicate-scan is a harmless no-op.
   */
  receive(input: ReceiveInput, approval?: ReceiveApproval): ReceiveActionResult {
    const declared = input.declaredUnitCostMinor === undefined ? undefined : money(input.declaredUnitCostMinor, this.currency);
    const command = {
      commandId: input.commandId,
      grnId: input.grnId,
      storeId: this.assignment.storeId,
      receivedBy: this.assignment.workerId,
      at: this.at(),
      source: input.source,
      ...(input.poId === undefined ? {} : { poId: input.poId }),
      ...(input.asnId === undefined ? {} : { asnId: input.asnId }),
      barcode: input.barcode,
      scannedQuantity: input.scannedQuantity,
      ...(input.batchId === undefined ? {} : { batchId: input.batchId }),
      ...(input.expiry === undefined ? {} : { expiry: input.expiry }),
      ...(declared === undefined ? {} : { declaredUnitCost: declared }),
    };

    const result = receiveScan({
      command,
      appliedCommandIds: this.appliedCommandIds,
      barcodes: this.barcodes,
      packs: this.packs,
      ...(this.ordered === undefined ? {} : { ordered: this.ordered }),
      receivedSoFar: this.receivedSoFar,
      policy: this.policy,
      ...(approval === undefined ? {} : { approval }),
    });

    if (!result.accepted) {
      const feedback: ScanFeedback = result.outcome === 'duplicate_ignored' ? 'warn' : 'reject';
      return { result, signal: signalFor(feedback, result.outcome, result.detail, result.resolutionRequired ?? false) };
    }

    // Accepted. Record it against the GRN, add to the put-away worklist, and queue it.
    this.appliedCommandIds.push(result.commandId);
    const productId = result.productId!;
    this.receivedSoFar[productId] = (this.receivedSoFar[productId] ?? 0) + result.quantityMinor;
    const batchId = input.batchId ?? null;
    const state: StockState = input.stockState ?? 'on_hand';
    const key = gKey(productId, batchId);
    const prior = this.goods.get(key);
    this.goods.set(key, {
      productId, batchId,
      quantityMinor: (prior?.quantityMinor ?? 0) + result.quantityMinor,
      uom: prior?.uom ?? 'EA',
      state,
      expiry: input.expiry ?? prior?.expiry ?? null,
      recalled: this.isRecalled(productId, batchId),
    });

    // One SCAN, keyed on its own command id (§31.1). Head office appends the `received` movement at the store and
    // keeps the scan on the GRN's register (SP-3a); the whole receipt is assembled there later (SP-6).
    this.outbox.enqueue(makeEvent({
      id: `recv-${input.grnId}-${result.commandId}`,
      type: RECEIVING_SCANNED,
      occurredAt: command.at,
      idempotencyKey: `recv:${input.grnId}:${result.commandId}`,
      source: this.assignment.assignmentId,
      payload: {
        grnId: input.grnId, commandId: result.commandId, productId, batchId,
        quantityMinor: result.quantityMinor, uom: prior?.uom ?? 'EA', source: input.source,
        poId: input.poId ?? null, state, expiry: input.expiry ?? null, receivedBy: this.assignment.workerId,
        storeId: this.assignment.storeId, at: command.at,
      },
    }));

    return { result, signal: signalFor('accept', 'received', result.detail) };
  }

  /** This handheld's receiving scans for a delivery — from the DURABLE queue, so they are the same after the app was closed. */
  private receiptScansOf(grnId: string) {
    return this.outbox.all().filter((i) => i.event.type === RECEIVING_SCANNED && (i.event.payload as { grnId?: string }).grnId === grnId);
  }

  /** True while this handheld has received something for the delivery and not yet sent it as ONE receipt (SP-6b). */
  receivingOpen(grnId: string): boolean {
    return this.receiptScansOf(grnId.trim()).length > 0 && this.outbox.find(`recv-done:${grnId.trim()}`) === undefined;
  }

  /**
   * Declare the delivery COMPLETE (SP-6b · M07-FR-01): one `ReceivingCompleted`, keyed on the GRN id, queued BEHIND the
   * scans it covers, so head office assembles ONE goods receipt from the scans it already holds — against the order named
   * here — and folds it into the purchase order. Nothing moves on this handheld and no quantity travels: the scans are the
   * truth, this only says they are all in. Refused when nothing was received here (a completion with no scans would be a
   * dead-letter at head office) and, harmlessly, when the delivery was already completed.
   */
  completeReceiving(input: CompleteReceivingInput): CompleteReceivingResult {
    const grnId = input.grnId.trim();
    const scans = this.receiptScansOf(grnId);
    const refused = (code: string, detail: string, feedback: ScanFeedback = 'reject'): CompleteReceivingResult =>
      ({ accepted: false, grnId, scanCount: scans.length, signal: signalFor(feedback, code, detail) });
    if (this.outbox.find(`recv-done:${grnId}`) !== undefined) return refused('duplicate_ignored', `delivery ${grnId} was already sent as one receipt — nothing changed`, 'warn');
    if (scans.length === 0) return refused('nothing_received', `nothing has been received on this handheld for delivery ${grnId} — scan the delivery in first`);
    const at = input.at ?? this.at();
    const poId = input.poId === undefined ? (this.assignment.poId ?? null) : input.poId;
    this.outbox.enqueue(makeEvent({
      id: `recv-done-${grnId}`,
      type: RECEIVING_COMPLETED,
      occurredAt: at,
      idempotencyKey: `recv-done:${grnId}`,
      source: this.assignment.assignmentId,
      payload: {
        grnId, poId, completedBy: this.assignment.workerId, storeId: this.assignment.storeId, at,
        scanCount: scans.length, commandIds: scans.map((i) => (i.event.payload as { commandId: string }).commandId), source: 'warehouse-handheld',
      },
    }));
    const detail = `delivery ${grnId} sent as one receipt of ${scans.length} ${scans.length === 1 ? 'scan' : 'scans'} — head office assembles it against ${poId ?? 'no order'}`;
    return { accepted: true, grnId, scanCount: scans.length, signal: signalFor('accept', 'receiving_done', detail) };
  }

  /**
   * Suggest where received stock should go — the authoritative `suggestPutAway`, which keeps a product
   * together and never sends bad stock to a pickable bin. Recalled/expired stock is forced to a
   * holding location by suggesting only for a non-pickable state.
   */
  suggestBin(input: { productId: string; batchId?: string | null; quantityMinor: number; state?: StockState }): PutAwaySuggestion | { readonly detail: string } {
    const batchId = input.batchId ?? null;
    const effectiveState: StockState = this.effectivePutAwayState(input.productId, batchId, input.state ?? 'on_hand', null);
    return suggestPutAway({
      productId: input.productId, batchId, quantityMinor: input.quantityMinor,
      state: effectiveState, bins: this.bins, contents: this.contents,
    });
  }

  /**
   * The state put-away must treat the stock as. Recall and expiry are decided HERE (from the served
   * recall set and the batch's expiry against the assignment clock) and folded into the StockState so
   * the authoritative `applyMovement` keeps it out of any pickable bin — no second rule, one gate.
   */
  private effectivePutAwayState(productId: string, batchId: string | null, declared: StockState, expiry: string | null): StockState {
    if (this.isRecalled(productId, batchId)) return 'quarantine';
    if (expiry !== null && isExpired({ batchId: batchId ?? productId, productId, qty: 1, expiry }, this.at())) return 'expired';
    return declared;
  }

  /**
   * Put one scanned item away into one scanned bin (M09-FR-01), through the authoritative
   * `applyMovement`. Scan-first: the item scanned must match the goods-in item, and the destination
   * bin must be a real bin — an unknown bin is queued for resolution, never invented. Recalled or
   * expired stock is refused into a pickable bin. An accepted move updates the local projection,
   * decrements the worklist and queues a movement for idempotent sync; a refusal queues nothing.
   */
  putAway(input: PutAwayInput): PutAwayActionResult {
    if (this.appliedCommandIds.includes(input.commandId)) {
      return { result: { commandId: input.commandId, outcome: 'duplicate_ignored', accepted: false, detail: 'this movement has already been recorded — scanning again changes nothing', movements: [] }, signal: signalFor('warn', 'duplicate_ignored', 'already recorded') };
    }
    const batchId = input.batchId ?? null;
    const goods = this.goods.get(gKey(input.scannedProductId, batchId));
    if (goods === undefined) {
      return { result: { commandId: input.commandId, outcome: 'invalid_command', accepted: false, detail: `${input.scannedProductId} is not in goods-in — receive it before putting it away`, movements: [] }, signal: signalFor('reject', 'wrong_sku', `${input.scannedProductId} is not waiting to be put away`, true) };
    }
    if (input.quantityMinor > goods.quantityMinor) {
      return { result: { commandId: input.commandId, outcome: 'invalid_command', accepted: false, detail: `only ${goods.quantityMinor} of ${input.scannedProductId} is in goods-in, not ${input.quantityMinor}`, movements: [] }, signal: signalFor('reject', 'insufficient_goods_in', `only ${goods.quantityMinor} waiting`) };
    }

    const state = this.effectivePutAwayState(input.scannedProductId, batchId, goods.state, goods.expiry);
    const command: MovementCommand = {
      commandId: input.commandId, kind: 'put_away', storeId: this.assignment.storeId,
      productId: input.scannedProductId, batchId, quantityMinor: input.quantityMinor, uom: input.uom,
      fromBinId: null, toBinId: input.scannedBinId, movedBy: this.assignment.workerId, at: input.at, stockState: state,
    };
    const result = applyMovement({ command, appliedCommandIds: this.appliedCommandIds, bins: this.bins, contents: this.contents });

    if (!result.accepted) {
      // Give recall/expiry a specific code rather than the generic not-pickable one, so the worker is
      // told which safety rule stopped them (the same underlying gate, a clearer message).
      let code: string = result.outcome;
      if (result.outcome === 'not_pickable_state') {
        code = this.isRecalled(input.scannedProductId, batchId) ? 'recalled_into_pickable'
          : state === 'expired' ? 'expired_into_pickable' : 'not_pickable_state';
      }
      const feedback: ScanFeedback = result.outcome === 'duplicate_ignored' ? 'warn' : 'reject';
      return { result, signal: signalFor(feedback, code, result.detail, result.resolutionRequired ?? false) };
    }

    // Accepted. Advance the local projection, decrement the worklist, queue the movement for sync.
    this.appliedCommandIds.push(result.commandId);
    const destKey = binKey(input.scannedBinId, input.scannedProductId, batchId);
    this.contents[destKey] = (this.contents[destKey] ?? 0) + input.quantityMinor;
    const remaining = goods.quantityMinor - input.quantityMinor;
    if (remaining <= 0) this.goods.delete(gKey(input.scannedProductId, batchId));
    else this.goods.set(gKey(input.scannedProductId, batchId), { ...goods, quantityMinor: remaining });

    this.outbox.enqueue(makeEvent({
      id: `wh-move-${result.commandId}`,
      type: WAREHOUSE_MOVEMENT_APPLIED,
      occurredAt: input.at,
      // The command's own id — the cloud keys its movement ledger on the same id, so a re-sent scan
      // reconciles to one movement (idempotent sync, hard rule #1 / §31.1). Top-level too, for the route.
      idempotencyKey: `wh-move:${result.commandId}`,
      source: this.assignment.assignmentId,
      payload: { commandId: result.commandId, command, movements: result.movements, movedBy: this.assignment.workerId },
    }));

    return { result, signal: signalFor('accept', 'moved', result.detail) };
  }

  /**
   * The product a scanned item code names: a catalogue barcode, or the product's own code on an internal label. A
   * product this handheld has never been told about (not on the catalogue, the order, the pick list, goods-in or a
   * bin) is unknown — a count or an adjustment of it would be a record against nothing.
   */
  private productOfScan(code: string): string | null {
    const scanned = code.trim();
    const byBarcode = this.barcodes.find((b) => b.barcode === scanned);
    if (byBarcode !== undefined) return byBarcode.productId;
    return this.knowsProduct(scanned) ? scanned : null;
  }

  private knowsProduct(productId: string): boolean {
    return [...this.picks.values()].some((p) => p.line.productId === productId)
      || this.barcodes.some((b) => b.productId === productId)
      || (this.ordered ?? []).some((o) => o.productId === productId)
      || [...this.goods.values()].some((g) => g.productId === productId)
      || Object.keys(this.contents).some((k) => k.split('|')[1] === productId);
  }

  /** The unit this handheld knows the product in — from its pick lines or goods-in, else each. */
  private uomOf(productId: string): string {
    const line = [...this.picks.values()].find((p) => p.line.productId === productId);
    if (line !== undefined) return line.line.uom;
    const goods = [...this.goods.values()].find((g) => g.productId === productId);
    return goods?.uom ?? 'EA';
  }

  /** Is this a bin the box told this handheld about? A count of a bin nobody registered is a record against nothing. */
  knowsBin(binId: string): boolean {
    return this.bins.some((b) => b.binId === binId.trim());
  }

  /**
   * Count one product in one bin, BLIND (W2 · M09-FR-04 · §28): the worker scans the bin, scans the item and enters
   * what they see. Nothing here compares it to anything — this handheld never shows an expected figure and never
   * changes its own bin projection on a count; head office reconciles it against ITS bin contents, values the variance
   * and holds a material one for a separate approver. Refusals: a bin or item this handheld does not know, a quantity
   * that is not a whole non-negative number, a count id already used (a re-count is a NEW id). Accepted → ONE
   * `StockCounted` queued, keyed on the count id, so a re-sent count is one record.
   */
  countBin(input: CountBinInput): CountActionResult {
    const binId = input.scannedBinId.trim();
    const refused = (code: string, detail: string, feedback: ScanFeedback = 'reject', resolutionRequired = false): CountActionResult =>
      ({ accepted: false, countId: input.countId, binId, signal: signalFor(feedback, code, detail, resolutionRequired) });
    if (this.appliedCommandIds.includes(input.countId) || this.outbox.find(`count-${input.countId}`) !== undefined) {
      return refused('duplicate_ignored', 'this count has already been recorded — a re-count is a new count', 'warn');
    }
    if (!this.knowsBin(binId)) return refused('unknown_bin', `${binId} is not a bin in this store — set it aside for someone to sort out`, 'reject', true);
    const productId = this.productOfScan(input.scannedItem);
    if (productId === null) return refused('unknown_barcode', `"${input.scannedItem.trim()}" is not a barcode this handheld knows`, 'reject', true);
    if (!Number.isSafeInteger(input.countedMinor) || input.countedMinor < 0) return refused('not_a_quantity', `${String(input.countedMinor)} is not a whole quantity`);

    const uom = this.uomOf(productId);
    this.appliedCommandIds.push(input.countId);
    this.outbox.enqueue(makeEvent({
      id: `count-${input.countId}`,
      type: STOCK_COUNTED,
      occurredAt: input.at,
      // One identity for one count at every hop — the same key the manager's count uses.
      idempotencyKey: `count-${input.countId}`,
      source: this.assignment.assignmentId,
      payload: {
        countId: input.countId, productId, locationId: this.assignment.storeId, binId, uom,
        countedMinor: input.countedMinor, reasonCode: HANDHELD_COUNT_REASON, counterId: this.assignment.workerId,
        at: input.at, storeId: this.assignment.storeId, source: 'warehouse-handheld',
      },
    }));
    const detail = `${input.countedMinor} ${uom} of ${productId} counted in ${binId} — head office will compare it`;
    return { accepted: true, countId: input.countId, productId, binId, signal: signalFor('accept', 'counted', detail) };
  }

  /**
   * Raise an adjustment REQUEST (W3 · M08-FR-03 · §28): a signed correction with a reason from the fixed list. Nothing
   * posts here and nothing changes on this handheld — the request is recorded pending at head office and a supervisor
   * who is not this worker approves or rejects it; only an approval appends the compensating movement. Refusals: an
   * item this handheld does not know, a zero or non-whole quantity, a reason not on the list, a request id already
   * used. Accepted → ONE `AdjustmentRequested` queued, keyed on the request id.
   */
  requestAdjustment(input: AdjustmentRequestInput): AdjustmentActionResult {
    const refused = (code: string, detail: string, feedback: ScanFeedback = 'reject', resolutionRequired = false): AdjustmentActionResult =>
      ({ accepted: false, requestId: input.requestId, signal: signalFor(feedback, code, detail, resolutionRequired) });
    if (this.appliedCommandIds.includes(input.requestId) || this.outbox.find(`adj-req:${input.requestId}`) !== undefined) {
      return refused('duplicate_ignored', 'this request has already been recorded — nothing changed', 'warn');
    }
    const productId = this.productOfScan(input.scannedItem);
    if (productId === null) return refused('unknown_barcode', `"${input.scannedItem.trim()}" is not a barcode this handheld knows`, 'reject', true);
    if (!Number.isSafeInteger(input.deltaMinor) || input.deltaMinor === 0) return refused('not_a_quantity', `${String(input.deltaMinor)} is not a whole non-zero quantity`);
    if (!isAdjustmentReason(input.reasonCode)) return refused('no_reason', 'an adjustment needs a reason from the list — without one it cannot be accounted for later');
    const reasonCode: AdjustmentReasonCode = input.reasonCode;
    const binId = input.binId === undefined || input.binId === null || input.binId.trim() === '' ? null : input.binId.trim();
    const note = input.note === undefined || input.note.trim() === '' ? null : input.note.trim();

    const uom = this.uomOf(productId);
    this.appliedCommandIds.push(input.requestId);
    this.outbox.enqueue(makeEvent({
      id: `adj-req-${input.requestId}`,
      type: ADJUSTMENT_REQUESTED,
      occurredAt: input.at,
      idempotencyKey: `adj-req:${input.requestId}`,
      source: this.assignment.assignmentId,
      payload: {
        requestId: input.requestId, productId, locationId: this.assignment.storeId, binId, deltaMinor: input.deltaMinor, uom,
        reasonCode, note, requestedBy: this.assignment.workerId, at: input.at, storeId: this.assignment.storeId, source: 'warehouse-handheld',
      },
    }));
    const detail = `${input.deltaMinor > 0 ? '+' : ''}${input.deltaMinor} ${uom} of ${productId} (${reasonCode}) — waits for a supervisor's approval before it posts`;
    return { accepted: true, requestId: input.requestId, productId, signal: signalFor('accept', 'adjustment_requested', detail) };
  }

  /**
   * Is this the right bin — and, when an item has been scanned, the right item — for this line? The
   * pick list is the authority on WHERE the stock is; a worker who found the item in another bin has
   * found different stock, and the count of the named bin would be wrong from then on. Refusals are
   * the same codes `pick` returns, so the screen shows one vocabulary. Commits nothing.
   */
  checkPick(input: { readonly lineId: string; readonly scannedBinId: string; readonly scannedItem?: string }): PickCheck {
    const entry = this.picks.get(input.lineId);
    if (entry === undefined) {
      return { ok: false, signal: signalFor('reject', 'not_on_pick_list', `line ${input.lineId} is not on this handheld's pick list`) };
    }
    const remaining = entry.line.quantityMinor - entry.pickedMinor;
    const line: PickLine = { ...entry.line, pickedMinor: entry.pickedMinor, remainingMinor: remaining };
    if (remaining <= 0) {
      return { ok: false, signal: signalFor('warn', 'line_done', `${line.orderRef} line ${line.lineId} is already picked — nothing left to take`) };
    }
    if (input.scannedBinId.trim() !== line.binId) {
      return { ok: false, signal: signalFor('reject', 'wrong_bin', `the pick list says bin ${line.binId}, not ${input.scannedBinId.trim()} — a different bin is different stock`) };
    }
    if (input.scannedItem !== undefined) {
      const productId = this.productOfScan(input.scannedItem);
      if (productId === null) {
        return { ok: false, signal: signalFor('reject', 'unknown_barcode', `"${input.scannedItem.trim()}" is not a barcode this handheld knows`, true) };
      }
      if (productId !== line.productId) {
        return { ok: false, signal: signalFor('reject', 'wrong_item', `${productId} is not ${line.productId}, the item on this line`) };
      }
    }
    return { ok: true, line };
  }

  /**
   * Pick one order line from its bin (M09-FR-01 pick · inventory-warehouse.md "pick a line ≤3"): the bin
   * scanned must be the line's bin, the item scanned must be the line's item, and the movement itself
   * is the authoritative `applyMovement` kind `pick` — out of the named bin, to nowhere (the goods leave
   * the racking for the order), which refuses an unknown bin, a draw the bin cannot cover (no negative
   * bins) and a repeated command. An accepted pick lowers the local bin projection, advances the line
   * and queues ONE `WarehouseMovementApplied` keyed on the command id, so a re-sent scan reconciles to
   * one movement (hard rule #1 / §31.1). A refusal changes nothing and queues nothing (hard rule #2).
   */
  pick(input: PickInput): PickActionResult {
    const refused = (outcome: MovementOutcome, code: string, detail: string, feedback: ScanFeedback = 'reject', resolutionRequired = false): PickActionResult => ({
      result: { commandId: input.commandId, outcome, accepted: false, detail, movements: [], ...(resolutionRequired ? { resolutionRequired } : {}) },
      signal: signalFor(feedback, code, detail, resolutionRequired),
    });
    if (this.appliedCommandIds.includes(input.commandId)) {
      return refused('duplicate_ignored', 'duplicate_ignored', 'this movement has already been recorded — scanning again changes nothing', 'warn');
    }
    const check = this.checkPick({ lineId: input.lineId, scannedBinId: input.scannedBinId, scannedItem: input.scannedItem });
    if (!check.ok) {
      // A pick-list refusal is not a stock-engine outcome; the movement shape says "invalid" and the signal says why.
      return refused('invalid_command', check.signal.code, check.signal.detail, check.signal.feedback, check.signal.resolutionRequired ?? false);
    }
    const line = check.line;
    const quantity = input.quantityMinor ?? line.remainingMinor;
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > line.remainingMinor) {
      return refused('invalid_command', 'invalid_command', `this line has ${line.remainingMinor} left to pick, not ${quantity}`);
    }

    const command: MovementCommand = {
      commandId: input.commandId, kind: 'pick', storeId: this.assignment.storeId,
      productId: line.productId, batchId: line.batchId, quantityMinor: quantity, uom: line.uom,
      fromBinId: line.binId, toBinId: null, movedBy: this.assignment.workerId, at: input.at,
      reason: `${line.orderRef}/${line.lineId}`,
    };
    const result = applyMovement({ command, appliedCommandIds: this.appliedCommandIds, bins: this.bins, contents: this.contents });
    if (!result.accepted) {
      const feedback: ScanFeedback = result.outcome === 'duplicate_ignored' ? 'warn' : 'reject';
      return { result, signal: signalFor(feedback, result.outcome, result.detail, result.resolutionRequired ?? false) };
    }

    // Accepted. Lower the bin projection, advance the line, queue the one movement for sync.
    this.appliedCommandIds.push(result.commandId);
    const fromKey = binKey(line.binId, line.productId, line.batchId);
    this.contents[fromKey] = (this.contents[fromKey] ?? 0) - quantity;
    const entry = this.picks.get(line.lineId)!;
    entry.pickedMinor += quantity;

    this.outbox.enqueue(makeEvent({
      id: `wh-move-${result.commandId}`,
      type: WAREHOUSE_MOVEMENT_APPLIED,
      occurredAt: input.at,
      // The command's own id — the cloud keys its movement ledger on it, so a re-sent pick is one movement.
      idempotencyKey: `wh-move:${result.commandId}`,
      source: this.assignment.assignmentId,
      payload: { commandId: result.commandId, command, movements: result.movements, movedBy: this.assignment.workerId, orderRef: line.orderRef, lineId: line.lineId },
    }));

    const left = line.remainingMinor - quantity;
    const detail = `${quantity} picked for ${line.orderRef} from ${line.binId}` + (left > 0 ? ` — ${left} still to pick on this line` : '');
    return { result: { ...result, detail }, signal: signalFor('accept', 'picked', detail) };
  }
}
