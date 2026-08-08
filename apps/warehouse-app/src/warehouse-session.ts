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
// resolution queue); put-away and bin capacity are `packages/warehouse` (`applyMovement` /
// `suggestPutAway`: unknown-bin queued not invented, full-bin and over-draw refused, bad stock kept
// out of pickable bins); and expiry/recall are `packages/fefo` (`isExpired`). This file adds NO stock
// rule of its own — it wires the scans to the engines, keeps the local projection, queues the sync
// events, and turns each outcome into scan feedback (visual/sound/vibration hints, OA-9).
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
  type Bin, type BinContents, type MovementCommand, type MovementResult, type PutAwaySuggestion,
} from '../../../packages/warehouse/src/movements';
import { isExpired } from '../../../packages/fefo/src/fefo';
import type { StockState } from '../../../packages/stock/src/position';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';

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
  /** Goods already received and awaiting put-away when the assignment was served. */
  readonly goodsIn?: readonly GoodsInItem[];
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
  private readonly appliedCommandIds: string[] = [];
  private readonly receivedSoFar: Record<string, number> = {};

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
  }

  /** The put-away worklist: goods received and not yet binned. */
  goodsIn(): readonly GoodsInItem[] {
    return [...this.goods.values()];
  }

  /** The current local bin projection — the base contents plus every put-away accepted this session. */
  binContents(): BinContents {
    return { ...this.contents };
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

    this.outbox.enqueue(makeEvent({
      id: `recv-${input.grnId}-${result.commandId}`,
      type: 'GoodsReceived',
      occurredAt: command.at,
      idempotencyKey: `recv:${input.grnId}:${result.commandId}`,
      source: this.assignment.assignmentId,
      payload: {
        grnId: input.grnId, commandId: result.commandId, productId, batchId,
        quantityMinor: result.quantityMinor, source: input.source,
        poId: input.poId ?? null, state, expiry: input.expiry ?? null, receivedBy: this.assignment.workerId,
      },
    }));

    return { result, signal: signalFor('accept', 'received', result.detail) };
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
      type: 'WarehouseMovementApplied',
      occurredAt: input.at,
      // The command's own id — the cloud keys its movement ledger on the same id, so a re-sent scan
      // reconciles to one movement (idempotent sync, hard rule #1 / §31.1).
      idempotencyKey: `wh-move:${result.commandId}`,
      source: this.assignment.assignmentId,
      payload: { command, movements: result.movements, movedBy: this.assignment.workerId },
    }));

    return { result, signal: signalFor('accept', 'moved', result.detail) };
  }
}
