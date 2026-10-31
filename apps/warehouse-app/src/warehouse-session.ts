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
import { normaliseUom, toDecimalString } from '../../../packages/contracts/src/quantity';
import {
  receiveScan, DEFAULT_RECEIVING_POLICY, compareAgainstAsn,
  type AsnComparison,
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
  judgeDockChecklist, coldChainAmong, readReceivingChecklistSetup,
  type DockChecklistAnswer, type FoodSafetyCheck, type ReceivingChecklistSetup,
} from '../../../packages/facilities/src/food-safety';
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
  // B4 · OB-504: a packed product scanned with no month and year of manufacture
  'manufacture_date_required',
  // OB-521 (R8-A): new work refused on a withdrawn or too-old build (the work in hand is finished)
  'app_version_too_old',
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
  // OB-172: a chilled/frozen delivery is not declared complete without its receiving checklist, ticked in full
  'checklist_required', 'checklist_incomplete',
  // SP-8c: the back store ISSUES against a floor indent (tap the line → scan the bin you take from → scan the item → confirm)
  'issued', 'not_on_indent', 'indent_line_done', 'requester_cannot_issue', 'bin_has_none',
  // OB-288 lane 2 · WF-07 offline: a transfer SENT from this store, and one COUNTED IN at it, on the handheld
  'transfer_sent', 'transfer_counted_in', 'not_a_transfer_here', 'transfer_already_done', 'count_incomplete',
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
  /** OB-521: the detail in Tamil, where the session has its own Tamil words (the app-version refusal). */
  readonly detailTa?: string;
}

/** OB-521: the signal code for new work refused on a withdrawn or too-old build (words in web/app.js). */
export const APP_VERSION_TOO_OLD = 'app_version_too_old';

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
  /**
   * Wave 3 · SF-07 part 3 — the arrival temperature the worker probed, °C, for chilled or frozen goods. Absent when not taken:
   * head office then holds a cold-chain scan off the shelf for a second person's check (owner decision 9 Oct 2026).
   */
  readonly temperatureC?: number;
  /** B4 · OB-504: the batch's month and year of manufacture (YYYY-MM) as printed on the pack — required for a packed product. */
  readonly manufacturedOn?: string;
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

/**
 * SP-8c: one approved floor-indent line the back store still owes, as the box served it from head office's register
 * (`GET /v1/floor/indents?open=true`, pulled into the pack). The handheld issues against it: any bin here that holds the
 * product will do — the indent names no bin — so the row shows where the stock is and the worker scans the bin they take from.
 */
export interface AssignedIndentLine {
  readonly indentId: string;
  readonly productId: string;
  readonly uom: string;
  /** Still owed to the floor as head office last said: allocated − issued. */
  readonly outstandingMinor: number;
  /** Who asked — the person who may NOT issue it (§28). */
  readonly requestedBy: string;
  readonly toLocationId: string;
}

/** An indent line as the worklist shows it: the assignment plus what has been issued against it on this handheld and where the product is. */
export interface IndentIssueLine extends AssignedIndentLine {
  readonly issuedHereMinor: number;
  readonly remainingMinor: number;
  /** The bins on this handheld's projection that hold the product — where to walk. */
  readonly binIds: readonly string[];
}

export interface IssueToFloorInput {
  readonly commandId: string;
  readonly indentId: string;
  readonly productId: string;
  readonly scannedBinId: string;
  readonly scannedItem: string;
  /** Defaults to what is still owed, capped at what the scanned bin holds — the confirm step shows the number before it is committed. */
  readonly quantityMinor?: number;
  readonly at: string;
}

export interface IssueToFloorResult {
  readonly accepted: boolean;
  readonly commandId: string;
  readonly indentId: string;
  readonly productId?: string;
  readonly binId: string;
  readonly quantityMinor?: number;
  readonly signal: FeedbackSignal;
}

/** What the screen asks between scans of an issue: is this a bin holding the product, is this the item? Commits nothing. */
export type IssueCheck =
  | { readonly ok: true; readonly line: IndentIssueLine; readonly batchId: string | null; readonly inBinMinor: number }
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
/** SP-8c: the event a back-store ISSUE against a floor indent travels under — the cloud re-runs the indent + transfer engines on it. */
export const FLOOR_INDENT_ISSUED = 'FloorIndentIssued';
/** OB-288 lane 2 · WF-07 offline: a transfer sent from this store (the cloud re-runs the transfer engine on head office's own stock). */
export const TRANSFER_DISPATCH_RECORDED = 'TransferDispatchRecorded';
/** OB-288 lane 2 · WF-07 offline: a transfer counted in at this store — what arrived, as counted; head office books any shortfall. */
export const TRANSFER_RECEIPT_RECORDED = 'TransferReceiptRecorded';
export const transferDispatchKey = (transferId: string): string => `transfer-dispatch:${transferId}`;
export const transferReceiptKey = (transferId: string): string => `transfer-receipt:${transferId}`;

/** One transfer as the store computer last heard it from head office (`warehouseData.transfers`). */
export interface HeldTransfer {
  readonly transferId: string;
  readonly state: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly requestedBy: string | null;
  readonly lines: readonly { readonly productId: string; readonly batchId: string | null; readonly quantityMinor: number; readonly uom: string }[];
}
/** Head office's transfers for this store's two ends, as the box last pulled them. `null` on the assignment: never told. */
export interface HeldTransfers {
  readonly asAt: string;
  readonly ageMinutes: number;
  readonly storeId: string | null;
  readonly toSend: readonly HeldTransfer[];
  readonly toCountIn: readonly HeldTransfer[];
}
/** What the handheld shows of a transfer: head office's row plus whether THIS handheld already did its step. */
export interface TransferRow extends HeldTransfer {
  readonly doneHere: boolean;
}
export interface TransferWorkView {
  readonly known: boolean;
  readonly asAt?: string;
  readonly ageMinutes?: number;
  readonly toSend: readonly TransferRow[];
  readonly toCountIn: readonly TransferRow[];
}
export interface TransferStepResult {
  readonly accepted: boolean;
  readonly transferId: string;
  readonly signal: FeedbackSignal;
}

/** The kinds of work this handheld hands to the store computer — a value, so the shell must have words for each. */
export const SENT_WORK_KINDS = Object.freeze(['receipt', 'receipt_done', 'put_away', 'pick', 'count', 'adjustment', 'issue', 'transfer_out', 'transfer_in'] as const);
export type SentWorkKind = (typeof SENT_WORK_KINDS)[number];

/** "Delivery complete" (SP-6b): the GRN this handheld has been receiving, and the order it was delivered against when known. */
export interface CompleteReceivingInput {
  readonly grnId: string;
  /** Overrides the assignment's order; `null` says there is none (a DSD). */
  readonly poId?: string | null;
  readonly at?: string;
  /** OB-172: the receiving checklist the signed-in worker did at the door (needed for chilled, frozen or raw-meat goods). */
  readonly checklist?: DockChecklistAnswer;
}

/** OB-172: what "Delivery complete" asks for this delivery — the checklist to offer and the cold-chain products received. */
export interface DeliveryChecklistNeed {
  /** The store computer was told the receiving checklist (absent → it cannot be offered; head office will flag it missing). */
  readonly known: boolean;
  readonly check?: FoodSafetyCheck;
  /** The chilled / frozen / raw-meat products this handheld has received on the delivery. Non-empty → the checklist is needed. */
  readonly coldChain: readonly string[];
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

/**
 * WF-08 (round 8): one blind count of one product under a head-office COUNT PLAN — the plan sheet's id, the item scanned, what
 * the worker SAW, and (for a recount the sheet asks for) the count it recounts. Counted at the plan's place, not in one bin.
 */
export interface CountForPlanInput {
  readonly countId: string;
  readonly planId: string;
  /** The place the plan counts — the store (default) or its back store, as printed on the plan sheet. */
  readonly locationId?: string;
  readonly scannedItem: string;
  readonly countedMinor: number;
  readonly recountOf?: string | null;
  readonly at: string;
}
export interface CountForPlanResult {
  readonly accepted: boolean;
  readonly countId: string;
  readonly planId: string;
  readonly productId?: string;
  readonly signal: FeedbackSignal;
}
/** The reason a planned count carries on the device (head office re-derives count vs recount from `recountOf`). */
export const PLANNED_COUNT_REASON = 'planned_count';

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
  /** OB-37: every delivery this store is waiting for (the phone's chooser); the chosen one fills grnId/poId/ordered. */
  readonly openDeliveries?: readonly { readonly poId: string; readonly number: string; readonly supplierId: string; readonly grnId: string; readonly ordered: readonly OrderedProduct[]; readonly asn?: HandheldAsn }[];
  /** OB-288 P3 (M07-FR-01): the chosen delivery's advance ship notice, cached here — the receipt is compared with it offline. */
  readonly asn?: HandheldAsn;
  /** SP-6b: the purchase order the delivery is against, named on "delivery complete" so head office folds the GRN into it. */
  readonly poId?: string;
  /** Goods already received and awaiting put-away when the assignment was served. */
  readonly goodsIn?: readonly GoodsInItem[];
  /** Order lines to pick from the racking, each naming its bin (M09-FR-01 pick). Absent = no pick work. */
  readonly pickLines?: readonly AssignedPickLine[];
  /** SP-8c: floor indents the back store owes — approved lines with something still to issue (from head office's register via the box). Absent = none sent. */
  readonly indentLines?: readonly AssignedIndentLine[];
  /** Products / batches under recall — never put into a pickable bin, even offline (M10-FR-04). */
  readonly recalledProductIds?: readonly string[];
  readonly recalledBatchIds?: readonly string[];
  readonly receivingPolicy?: ReceivingPolicy;
  /**
   * OB-172 · D-6: the receiving checklists head office has in force for this store and its cold-chain products, as the
   * store computer was told them (read strictly here). Absent = not told: "Delivery complete" cannot ask for it, and head
   * office books such a delivery flagged `receiving_checklist_missing`.
   */
  readonly receivingChecklist?: unknown;
  /**
   * B4 · OB-504: the products head office's category list makes PACKED (the store pack's `packedProductIds`) — a scan of one
   * with no month and year of manufacture is refused here, offline. Absent = not told (head office still refuses it by name).
   */
  readonly packedProductIds?: readonly string[];
  /** OB-288 lane 2 · WF-07 offline: the transfers to send from / count in at this store (absent or null: never told). */
  readonly transfers?: HeldTransfers | null;
  /**
   * Round B (screen gap audit 31 Oct 2026): each product's name as head office's store pack names it, so a worker reads
   * "Demo Ponni Rice 1kg", not "prod-rice". Absent (or a product missing from it): the code is shown, never a guess.
   */
  readonly productNames?: Readonly<Record<string, string>>;
  /** The Tamil names, where head office recorded one; otherwise the English name is shown in Tamil too. */
  readonly productNamesTa?: Readonly<Record<string, string>>;
}

/**
 * A quantity as a worker reads it (OB-31 rule 1 — look only, nothing stored changes): a `kg` or `L` line holds grams or
 * millilitres, so 200000 of a kg product reads "200.000" + "kg" — never "200000 units". A count of pieces (`ea`, any
 * spelling) or a unit this system does not know returns `unit: null`: the screen shows the count with its own words.
 */
export function handheldQuantity(quantityMinor: number, uom: string): { readonly amount: string; readonly unit: string | null } {
  const unit = normaliseUom(uom);
  if (unit === undefined || unit === 'ea' || !Number.isSafeInteger(quantityMinor)) return { amount: String(quantityMinor), unit: null };
  return { amount: toDecimalString({ minor: quantityMinor, uom: unit }), unit };
}

/** The same, as one piece of text for a record line: "8 EA" stays "8 EA"; 2500 of a kg product is "2.500 kg". */
function quantityWords(quantityMinor: number, uom: string): string {
  const q = handheldQuantity(quantityMinor, uom);
  return q.unit === null ? `${quantityMinor} ${uom}` : `${q.amount} ${q.unit}`;
}

/** OB-288 P3 (M07-FR-01): the supplier's advance ship notice as the box served it with the open delivery. */
export interface HandheldAsn {
  readonly asnId: string;
  readonly expectedAt: string;
  readonly lines: readonly { readonly productId: string; readonly quantityMinor: number; readonly uom: string }[];
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
  /** SP-8c: the floor indents owed, by `indentId|productId`, with what has been issued against each on this handheld. */
  private readonly indents = new Map<string, { readonly line: AssignedIndentLine; issuedMinor: number }>();
  private readonly appliedCommandIds: string[] = [];
  private readonly receivedSoFar: Record<string, number> = {};
  /** The store computer's word on each item it took, keyed by queue key — filled by `noteBoxStatus` (SP-3a). */
  private readonly boxWord = new Map<string, BoxItemStatus>();

  private readonly currency: CurrencyCode;
  private readonly at: () => string;
  /** OB-172: the receiving checklist setup the store computer served, read strictly (undefined = not told). */
  private readonly receivingSetup: ReceivingChecklistSetup | undefined;
  /** OB-521: set while this build may not START new work (withdrawn or too old) — the words to refuse it with. */
  private newWorkBar: { readonly en: string; readonly ta: string } | null = null;

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
    this.receivingSetup = readReceivingChecklistSetup(assignment.receivingChecklist);
    for (const item of assignment.goodsIn ?? []) this.goods.set(gKey(item.productId, item.batchId), { ...item });
    for (const line of assignment.pickLines ?? []) this.picks.set(line.lineId, { line: { ...line, batchId: line.batchId ?? null }, pickedMinor: 0 });
    for (const line of assignment.indentLines ?? []) this.indents.set(`${line.indentId}|${line.productId}`, { line, issuedMinor: 0 });
  }

  /**
   * OB-521: bar (or, with `null`, lift the bar on) STARTING new work on this build. What is refused is the START of a
   * piece of work — receiving a delivery nothing of which was received here yet, a check-in at the door, a count (unless
   * this handheld already counted for that plan), an adjustment request, a transfer step, a floor issue on an indent not
   * yet issued from here, a pick for an order not yet picked from here. The work in hand is always finished: the rest of
   * a delivery already being received and its "delivery complete", putting away what was received (stock must not be left
   * at the door), and the rest of a plan, an indent or an order this handheld already started.
   */
  barNewWork(words: { readonly en: string; readonly ta: string } | null): void {
    this.newWorkBar = words;
  }

  /** OB-521: the refusal signal, or undefined when new work may start (or this piece is already in hand). */
  private newWorkRefusal(inHand: () => boolean): FeedbackSignal | undefined {
    if (this.newWorkBar === null || inHand()) return undefined;
    return { ...signalFor('reject', APP_VERSION_TOO_OLD, this.newWorkBar.en), detailTa: this.newWorkBar.ta };
  }

  /**
   * OB-288 lane 2 · WF-07 offline: the transfers this store sends and counts in, as head office last said — each marked
   * when THIS handheld has already done its step (from the durable device queue, so it holds after a restart).
   */
  transferWork(): TransferWorkView {
    const held = this.assignment.transfers;
    if (held === undefined || held === null) return { known: false, toSend: [], toCountIn: [] };
    const row = (t: HeldTransfer, key: string): TransferRow => ({ ...t, doneHere: this.outbox.find(key) !== undefined });
    return {
      known: true, asAt: held.asAt, ageMinutes: held.ageMinutes,
      toSend: held.toSend.map((t) => row(t, transferDispatchKey(t.transferId))),
      toCountIn: held.toCountIn.map((t) => row(t, transferReceiptKey(t.transferId))),
    };
  }

  /**
   * WF-07 offline: SEND a transfer from this store — one tap after the goods are loaded. Saved on this handheld in the
   * signed-in worker's name and timed when it was done; head office re-runs its own transfer engine on its own stock (the
   * proposer may not send their own, stock must be there, a count freeze or an e-way bill can still refuse it — and that
   * refusal comes back here, by name). Nothing about lines, stock or cost travels: they are head office's own.
   */
  sendTransfer(input: { readonly transferId: string; readonly at: string }): TransferStepResult {
    const held = this.assignment.transfers?.toSend.find((t) => t.transferId === input.transferId);
    const refused = (code: string, detail: string, feedback: ScanFeedback = 'reject'): TransferStepResult => ({ accepted: false, transferId: input.transferId, signal: signalFor(feedback, code, detail) });
    if (held === undefined) return refused('not_a_transfer_here', `transfer ${input.transferId} is not one this store sends, as the store computer last heard`);
    const key = transferDispatchKey(held.transferId);
    if (this.outbox.find(key) !== undefined) return refused('transfer_already_done', `transfer ${held.transferId} has already been sent from this handheld — sending again changes nothing`, 'warn');
    const barred = this.newWorkRefusal(() => false); // OB-521
    if (barred !== undefined) return { accepted: false, transferId: input.transferId, signal: barred };
    this.outbox.enqueue(makeEvent({
      id: key, type: TRANSFER_DISPATCH_RECORDED, occurredAt: input.at, idempotencyKey: key, source: this.assignment.assignmentId,
      payload: { transferId: held.transferId, storeId: this.assignment.transfers?.storeId ?? this.assignment.storeId, dispatchedBy: this.assignment.workerId, at: input.at, source: 'warehouse-handheld' },
    }));
    return { accepted: true, transferId: held.transferId, signal: signalFor('accept', 'transfer_sent', `transfer ${held.transferId} sent to ${held.toLocationId} — ${held.lines.length} line(s)`) };
  }

  /**
   * WF-07 offline: COUNT IN a transfer at this store — what actually arrived, one count per line the transfer carries
   * (0 is a real count). Saved in the signed-in worker's name; head office books what arrived and any shortfall as its
   * valued exception, and refuses the dispatcher counting in their own (§28).
   */
  countInTransfer(input: { readonly transferId: string; readonly counted: readonly { readonly productId: string; readonly batchId: string | null; readonly quantityMinor: number }[]; readonly at: string }): TransferStepResult {
    const held = this.assignment.transfers?.toCountIn.find((t) => t.transferId === input.transferId);
    const refused = (code: string, detail: string, feedback: ScanFeedback = 'reject'): TransferStepResult => ({ accepted: false, transferId: input.transferId, signal: signalFor(feedback, code, detail) });
    if (held === undefined) return refused('not_a_transfer_here', `transfer ${input.transferId} is not one on its way to this store, as the store computer last heard`);
    const key = transferReceiptKey(held.transferId);
    if (this.outbox.find(key) !== undefined) return refused('transfer_already_done', `transfer ${held.transferId} has already been counted in on this handheld — counting again changes nothing`, 'warn');
    const barred = this.newWorkRefusal(() => false); // OB-521
    if (barred !== undefined) return { accepted: false, transferId: input.transferId, signal: barred };
    const lineKey = (productId: string, batchId: string | null): string => `${productId}|${batchId ?? ''}`;
    const counts = new Map<string, number>();
    for (const c of input.counted) {
      if (!Number.isSafeInteger(c.quantityMinor) || c.quantityMinor < 0) return refused('not_a_quantity', `${String(c.quantityMinor)} is not a count of ${c.productId}`);
      counts.set(lineKey(c.productId, c.batchId), c.quantityMinor);
    }
    const missing = held.lines.filter((l) => !counts.has(lineKey(l.productId, l.batchId)));
    if (missing.length > 0 || counts.size !== held.lines.length) {
      return refused('count_incomplete', `every line of transfer ${held.transferId} needs its count — not counted: ${missing.map((l) => l.productId).join(', ') || 'a line it does not carry'}`);
    }
    const counted = held.lines.map((l) => ({ productId: l.productId, batchId: l.batchId, quantityMinor: counts.get(lineKey(l.productId, l.batchId))! }));
    this.outbox.enqueue(makeEvent({
      id: key, type: TRANSFER_RECEIPT_RECORDED, occurredAt: input.at, idempotencyKey: key, source: this.assignment.assignmentId,
      payload: { transferId: held.transferId, storeId: this.assignment.transfers?.storeId ?? this.assignment.storeId, receivedBy: this.assignment.workerId, at: input.at, counted, source: 'warehouse-handheld' },
    }));
    const short = held.lines.reduce((n, l) => n + Math.max(0, l.quantityMinor - counts.get(lineKey(l.productId, l.batchId))!), 0);
    return { accepted: true, transferId: held.transferId, signal: signalFor(short > 0 ? 'warn' : 'accept', 'transfer_counted_in', `transfer ${held.transferId} counted in${short > 0 ? ` — ${short} fewer than were sent; head office books the shortfall` : ''}`) };
  }

  /** A product's name as the store pack names it (Tamil where recorded, when asked for); its code when not known. */
  productName(productId: string, lang: 'en' | 'ta' = 'en'): string {
    const ta = lang === 'ta' ? this.assignment.productNamesTa?.[productId] : undefined;
    const en = this.assignment.productNames?.[productId];
    const name = typeof ta === 'string' && ta.trim() !== '' ? ta : en;
    return typeof name === 'string' && name.trim() !== '' ? name : productId;
  }

  /** A quantity in its display unit (see `handheldQuantity`) — the screen's words only. */
  quantityText(quantityMinor: number, uom: string): { readonly amount: string; readonly unit: string | null } {
    return handheldQuantity(quantityMinor, uom);
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

  /** SP-8c: the floor indents the back store still owes — every line with something left to issue, in the order the box sent
   *  them, with the bins on this handheld's projection that hold the product (where to walk). */
  indentLines(): readonly IndentIssueLine[] {
    return [...this.indents.values()]
      .map(({ line, issuedMinor }) => ({ ...line, issuedHereMinor: issuedMinor, remainingMinor: line.outstandingMinor - issuedMinor, binIds: this.binsHolding(line.productId) }))
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
          return [{ kind: 'receipt', id: p.commandId, what: `${this.productName(p.productId)}${p.batchId ? ` · ${p.batchId}` : ''}`, detail: `${quantityWords(p.quantityMinor, p.uom)} · ${p.grnId}`, ...common, ...withReason }];
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
          return [{ kind, id: c.commandId, what: `${this.productName(c.productId)}${c.batchId ? ` · ${c.batchId}` : ''} · ${bin}`, detail: `${quantityWords(c.quantityMinor, c.uom)}${p.orderRef ? ` · ${p.orderRef}` : ''}`, ...common, ...withReason }];
        }
        if (item.event.type === STOCK_COUNTED) {
          // Only what was counted — never an expected figure, which this handheld does not have (blind, W2).
          const p = item.event.payload as { countId: string; productId: string; binId: string | null; countedMinor: number; uom: string };
          return [{ kind: 'count', id: p.countId, what: `${this.productName(p.productId)} · ${p.binId ?? ''}`, detail: quantityWords(p.countedMinor, p.uom), ...common, ...withReason }];
        }
        if (item.event.type === ADJUSTMENT_REQUESTED) {
          const p = item.event.payload as { requestId: string; productId: string; binId: string | null; deltaMinor: number; uom: string; reasonCode: string };
          return [{ kind: 'adjustment', id: p.requestId, what: `${this.productName(p.productId)}${p.binId ? ` · ${p.binId}` : ''}`, detail: `${p.deltaMinor > 0 ? '+' : ''}${quantityWords(p.deltaMinor, p.uom)} · ${p.reasonCode}`, ...common, ...withReason }];
        }
        if (item.event.type === FLOOR_INDENT_ISSUED) {
          // SP-8c: an issue against a floor indent — which indent, what, how many, from which bin.
          const p = item.event.payload as { indentId: string; issueId: string; lines: readonly { productId: string; batchId: string | null; quantityMinor: number; binId: string; uom: string }[] };
          const l = p.lines[0];
          return [{ kind: 'issue', id: p.issueId, what: `${l === undefined ? '' : this.productName(l.productId)}${l?.batchId ? ` · ${l.batchId}` : ''} · ${l?.binId ?? ''}`, detail: `${l === undefined ? '0 ' : quantityWords(l.quantityMinor, l.uom)} · ${p.indentId}`, ...common, ...withReason }];
        }
        if (item.event.type === TRANSFER_DISPATCH_RECORDED) {
          const p = item.event.payload as { transferId: string };
          const t = this.assignment.transfers?.toSend.find((x) => x.transferId === p.transferId);
          return [{ kind: 'transfer_out', id: p.transferId, what: p.transferId, detail: t === undefined ? '' : `→ ${t.toLocationId} · ${t.lines.length}`, ...common, ...withReason }];
        }
        if (item.event.type === TRANSFER_RECEIPT_RECORDED) {
          const p = item.event.payload as { transferId: string; counted: readonly { productId: string; quantityMinor: number }[] };
          return [{ kind: 'transfer_in', id: p.transferId, what: p.transferId, detail: p.counted.map((c) => `${c.productId} ${c.quantityMinor}`).join(' · '), ...common, ...withReason }];
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
    // OB-521: the first scan of a delivery STARTS receiving it; the rest of a delivery already begun here is finished.
    const barred = this.newWorkRefusal(() => this.receiptScansOf(input.grnId.trim()).length > 0);
    if (barred !== undefined) return { result: { commandId: input.commandId, outcome: 'app_version_too_old', accepted: false, quantityMinor: 0, detail: barred.detail }, signal: barred };
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
      ...(input.manufacturedOn === undefined ? {} : { manufacturedOn: input.manufacturedOn }),
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
      // B4 · OB-504: a packed product's scan needs its month and year of manufacture — refused here, offline, without it.
      ...(Array.isArray(this.assignment.packedProductIds) ? { packagedProductIds: this.assignment.packedProductIds.filter((p): p is string => typeof p === 'string') } : {}),
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
        ...(input.temperatureC === undefined || !Number.isFinite(input.temperatureC) ? {} : { temperatureC: input.temperatureC }),
        ...(input.manufacturedOn === undefined || input.manufacturedOn.trim() === '' ? {} : { manufacturedOn: input.manufacturedOn.trim() }),
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
  /**
   * OB-172: what "Delivery complete" asks for this delivery — the receiving checklist to offer (head office's own, from the
   * store setup) and the chilled / frozen / raw-meat products this handheld received on it. Offline; decides nothing.
   */
  deliveryChecklist(grnId: string): DeliveryChecklistNeed {
    const scanned = this.receiptScansOf(grnId.trim()).map((i) => (i.event.payload as { productId: string }).productId);
    const check = this.receivingSetup?.checks[0];
    return { known: this.receivingSetup !== undefined, ...(check === undefined ? {} : { check }), coldChain: coldChainAmong(this.receivingSetup, scanned) };
  }

  /**
   * OB-288 P3 (M07-FR-01): what has been received on this phone against the supplier's advance ship notice — every product
   * that differs (short or over), worked out HERE with the tested `compareAgainstAsn`, so the receiver sees it with no
   * signal. `undefined` when the delivery came with no ASN. Head office compares again when the receipt reaches it.
   */
  asnDifferences(): readonly AsnComparison[] | undefined {
    const asn = this.assignment.asn;
    if (asn === undefined) return undefined;
    return compareAgainstAsn({ asnId: asn.asnId, supplierId: '', expectedAt: asn.expectedAt, lines: asn.lines.map((l, i) => ({ lineId: `A${i + 1}`, ...l })) }, this.receivedSoFar);
  }

  completeReceiving(input: CompleteReceivingInput): CompleteReceivingResult {
    const grnId = input.grnId.trim();
    const scans = this.receiptScansOf(grnId);
    const refused = (code: string, detail: string, feedback: ScanFeedback = 'reject'): CompleteReceivingResult =>
      ({ accepted: false, grnId, scanCount: scans.length, signal: signalFor(feedback, code, detail) });
    if (this.outbox.find(`recv-done:${grnId}`) !== undefined) return refused('duplicate_ignored', `delivery ${grnId} was already sent as one receipt — nothing changed`, 'warn');
    if (scans.length === 0) return refused('nothing_received', `nothing has been received on this handheld for delivery ${grnId} — scan the delivery in first`);
    const at = input.at ?? this.at();
    const poId = input.poId === undefined ? (this.assignment.poId ?? null) : input.poId;
    // OB-172 (OB-164 at the door, offline): a chilled/frozen delivery is not declared complete without its receiving
    // checklist, judged by head office's own rule; it is done by — and travels in the name of — the person signed in on
    // this phone (the box readdressed the assignment to them), INSIDE the one completion record the store computer seals.
    const scanned = scans.map((i) => i.event.payload as { productId: string; temperatureC?: number });
    const cold = coldChainAmong(this.receivingSetup, scanned.map((x) => x.productId));
    const probed = scanned.find((x) => cold.includes(x.productId) && typeof x.temperatureC === 'number');
    const answer = input.checklist === undefined ? undefined
      : input.checklist.readingTenthsC === undefined && probed?.temperatureC !== undefined ? { ...input.checklist, readingTenthsC: Math.round(probed.temperatureC * 10) } : input.checklist;
    const verdict = judgeDockChecklist({
      setup: this.receivingSetup, grnId, productIds: scanned.map((x) => x.productId), ...(answer === undefined ? {} : { answer }),
      performedBy: this.assignment.workerId, performedAt: at,
    });
    if (!verdict.ok) return refused(verdict.refusal === 'checklist_required' ? 'checklist_required' : 'checklist_incomplete', verdict.detail);
    this.outbox.enqueue(makeEvent({
      id: `recv-done-${grnId}`,
      type: RECEIVING_COMPLETED,
      occurredAt: at,
      idempotencyKey: `recv-done:${grnId}`,
      source: this.assignment.assignmentId,
      payload: {
        grnId, poId, completedBy: this.assignment.workerId, storeId: this.assignment.storeId, at,
        scanCount: scans.length, commandIds: scans.map((i) => (i.event.payload as { commandId: string }).commandId), source: 'warehouse-handheld',
        ...(verdict.carried === undefined ? {} : { receivingChecklist: verdict.carried }),
        // OB-288 P3: the ASN this delivery was received against (head office compares its own copy with what was booked).
        ...(this.assignment.asn === undefined ? {} : { asnId: this.assignment.asn.asnId }),
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
    const barred = this.newWorkRefusal(() => false); // OB-521: a bin count is new work
    if (barred !== undefined) return { accepted: false, countId: input.countId, binId, signal: barred };
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
   * Count one product under a COUNT PLAN, BLIND (WF-08 · M09-FR-04 · §28 · §31): the worker scans the item and enters what
   * they see. Nothing here compares it to anything and nothing on this handheld changes; head office records it under the
   * plan, works out what it expected AS OF this moment, and holds any variance for the plan's approval. Refusals: no plan
   * named, an item this handheld does not know, a quantity that is not a whole non-negative number, a count id already
   * used. Accepted → ONE `StockCounted` queued (carrying the plan), keyed on the count id, so a re-sent count is one record;
   * it reaches the store computer's queue before the phone hears accepted, and head office when the line is up.
   */
  countForPlan(input: CountForPlanInput): CountForPlanResult {
    const planId = input.planId.trim();
    const refused = (code: string, detail: string, feedback: ScanFeedback = 'reject', resolutionRequired = false): CountForPlanResult =>
      ({ accepted: false, countId: input.countId, planId, signal: signalFor(feedback, code, detail, resolutionRequired) });
    if (this.appliedCommandIds.includes(input.countId) || this.outbox.find(`count-${input.countId}`) !== undefined) {
      return refused('duplicate_ignored', 'this count has already been recorded — a recount is a new count', 'warn');
    }
    if (planId === '') return refused('no_plan', 'scan the count sheet first — a planned count belongs to its plan', 'reject', true);
    // OB-521: the first count for a plan STARTS it; the rest of a plan this handheld already counted for is finished.
    const barred = this.newWorkRefusal(() => this.outbox.all().some((i) => (i.event.payload as { planId?: unknown } | null)?.planId === planId));
    if (barred !== undefined) return { accepted: false, countId: input.countId, planId, signal: barred };
    const productId = this.productOfScan(input.scannedItem);
    if (productId === null) return refused('unknown_barcode', `"${input.scannedItem.trim()}" is not a barcode this handheld knows`, 'reject', true);
    if (!Number.isSafeInteger(input.countedMinor) || input.countedMinor < 0) return refused('not_a_quantity', `${String(input.countedMinor)} is not a whole quantity`);
    const uom = this.uomOf(productId);
    const locationId = input.locationId === undefined || input.locationId.trim() === '' ? this.assignment.storeId : input.locationId.trim();
    const recountOf = input.recountOf === undefined || input.recountOf === null || input.recountOf.trim() === '' ? null : input.recountOf.trim();
    this.appliedCommandIds.push(input.countId);
    this.outbox.enqueue(makeEvent({
      id: `count-${input.countId}`,
      type: STOCK_COUNTED,
      occurredAt: input.at,
      idempotencyKey: `count-${input.countId}`,
      source: this.assignment.assignmentId,
      payload: {
        countId: input.countId, productId, locationId, binId: null, uom,
        countedMinor: input.countedMinor, reasonCode: PLANNED_COUNT_REASON, counterId: this.assignment.workerId,
        at: input.at, storeId: this.assignment.storeId, source: 'warehouse-handheld', planId, recountOf,
      },
    }));
    const detail = `${input.countedMinor} ${uom} of ${productId} counted for plan ${planId} — head office will compare it`;
    return { accepted: true, countId: input.countId, planId, productId, signal: signalFor('accept', 'counted', detail) };
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
    const barred = this.newWorkRefusal(() => false); // OB-521: an adjustment request is new work
    if (barred !== undefined) return { accepted: false, requestId: input.requestId, signal: barred };
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

  /** The bins on this handheld's projection holding any of the product — where the worker walks for an issue. */
  private binsHolding(productId: string): readonly string[] {
    const out = new Set<string>();
    for (const [key, qty] of Object.entries(this.contents)) {
      const [binId, product] = key.split('|');
      if (binId !== undefined && product === productId && qty > 0) out.add(binId);
    }
    return [...out].sort();
  }

  /** The lot of the product in a bin (first batch by id; the null batch sorts first), or null when the bin holds none. */
  private lotInBin(binId: string, productId: string): { readonly batchId: string | null; readonly quantityMinor: number } | null {
    const lots = Object.entries(this.contents)
      .map(([key, qty]) => ({ parts: key.split('|'), qty }))
      .filter(({ parts, qty }) => parts[0] === binId && parts[1] === productId && qty > 0)
      .map(({ parts, qty }) => ({ batchId: parts[2] === undefined || parts[2] === '' ? null : parts[2], quantityMinor: qty }))
      .sort((a, b) => (a.batchId ?? '').localeCompare(b.batchId ?? ''));
    return lots[0] ?? null;
  }

  /**
   * SP-8c: is this a bin that holds the product the floor asked for — and, once scanned, the right item? The indent names no
   * bin (the floor does not know the racking), so ANY bin here holding the product will do; what is refused is a bin holding
   * none of it, an unknown bin, a wrong item, a line already fully issued, and — before anything is scanned — the requester
   * issuing to themselves (§28). The same codes `issueToFloor` returns, so the screen shows one vocabulary. Commits nothing.
   */
  checkIssue(input: { readonly indentId: string; readonly productId: string; readonly scannedBinId: string; readonly scannedItem?: string }): IssueCheck {
    const entry = this.indents.get(`${input.indentId}|${input.productId}`);
    if (entry === undefined) {
      return { ok: false, signal: signalFor('reject', 'not_on_indent', `${input.productId} is not owed on indent ${input.indentId} on this handheld`) };
    }
    const remaining = entry.line.outstandingMinor - entry.issuedMinor;
    const line: IndentIssueLine = { ...entry.line, issuedHereMinor: entry.issuedMinor, remainingMinor: remaining, binIds: this.binsHolding(entry.line.productId) };
    if (remaining <= 0) {
      return { ok: false, signal: signalFor('warn', 'indent_line_done', `${line.indentId} · ${line.productId} is fully issued — nothing left to send`) };
    }
    if (entry.line.requestedBy === this.assignment.workerId) {
      return { ok: false, signal: signalFor('reject', 'requester_cannot_issue', `you raised ${line.indentId} — a different person must issue it (§28)`) };
    }
    const binId = input.scannedBinId.trim();
    if (!this.knowsBin(binId)) return { ok: false, signal: signalFor('reject', 'unknown_bin', `${binId} is not a bin in this store — set it aside for someone to sort out`, true) };
    const lot = this.lotInBin(binId, line.productId);
    if (lot === null) return { ok: false, signal: signalFor('reject', 'bin_has_none', `${binId} holds none of ${line.productId} — scan the bin the stock is in`) };
    if (input.scannedItem !== undefined) {
      const productId = this.productOfScan(input.scannedItem);
      if (productId === null) return { ok: false, signal: signalFor('reject', 'unknown_barcode', `"${input.scannedItem.trim()}" is not a barcode this handheld knows`, true) };
      if (productId !== line.productId) return { ok: false, signal: signalFor('reject', 'wrong_item', `${productId} is not ${line.productId}, the item the floor asked for`) };
    }
    return { ok: true, line, batchId: lot.batchId, inBinMinor: lot.quantityMinor };
  }

  /**
   * SP-8c: ISSUE one indent line to the floor from the bin scanned (inventory-warehouse.md: tap the line → scan the bin → scan
   * the item → confirm, ≤3 after the tap). The bin movement is the authoritative `applyMovement` kind `pick` out of the scanned
   * bin — it refuses a draw the bin cannot cover and a repeated command — and the quantity can never exceed what the indent
   * still owes. An accepted issue lowers the local bin projection, advances the line and queues ONE `FloorIndentIssued`
   * keyed on the command id; head office re-runs the indent and transfer engines on it (the requester refused as issuer,
   * over-issue, over-draw against ITS stock) and lowers the SAME bin in the same write — never a second movement from here.
   * A refusal changes nothing and queues nothing (hard rules #1 #2, §31.1).
   */
  issueToFloor(input: IssueToFloorInput): IssueToFloorResult {
    const binId = input.scannedBinId.trim();
    const refused = (code: string, detail: string, feedback: ScanFeedback = 'reject', resolutionRequired = false): IssueToFloorResult =>
      ({ accepted: false, commandId: input.commandId, indentId: input.indentId, binId, signal: signalFor(feedback, code, detail, resolutionRequired) });
    if (this.appliedCommandIds.includes(input.commandId) || this.outbox.find(`indent-issue:${input.indentId}:${input.commandId}`) !== undefined) {
      return refused('duplicate_ignored', 'this issue has already been recorded — scanning again changes nothing', 'warn');
    }
    // OB-521: the first issue against an indent STARTS it; the rest of an indent already issued from here is finished.
    const barred = this.newWorkRefusal(() => [...this.indents.values()].some((e) => e.line.indentId === input.indentId && e.issuedMinor > 0));
    if (barred !== undefined) return { accepted: false, commandId: input.commandId, indentId: input.indentId, binId, signal: barred };
    const check = this.checkIssue({ indentId: input.indentId, productId: input.productId, scannedBinId: binId, scannedItem: input.scannedItem });
    if (!check.ok) return refused(check.signal.code, check.signal.detail, check.signal.feedback, check.signal.resolutionRequired ?? false);
    const { line, batchId, inBinMinor } = check;
    const quantity = input.quantityMinor ?? Math.min(line.remainingMinor, inBinMinor);
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > line.remainingMinor) {
      return refused('invalid_command', `${line.indentId} still owes ${line.remainingMinor} of ${line.productId}, not ${String(quantity)}`);
    }

    const command: MovementCommand = {
      commandId: input.commandId, kind: 'pick', storeId: this.assignment.storeId,
      productId: line.productId, batchId, quantityMinor: quantity, uom: line.uom,
      fromBinId: binId, toBinId: null, movedBy: this.assignment.workerId, at: input.at,
      reason: `indent ${line.indentId}`,
    };
    const result = applyMovement({ command, appliedCommandIds: this.appliedCommandIds, bins: this.bins, contents: this.contents });
    if (!result.accepted) {
      const feedback: ScanFeedback = result.outcome === 'duplicate_ignored' ? 'warn' : 'reject';
      return refused(result.outcome, result.detail, feedback, result.resolutionRequired ?? false);
    }

    // Accepted. Lower the bin projection, advance the line, queue the ONE fact head office needs.
    this.appliedCommandIds.push(result.commandId);
    const fromKey = binKey(binId, line.productId, batchId);
    this.contents[fromKey] = (this.contents[fromKey] ?? 0) - quantity;
    const entry = this.indents.get(`${line.indentId}|${line.productId}`)!;
    entry.issuedMinor += quantity;

    this.outbox.enqueue(makeEvent({
      id: `indent-issue:${line.indentId}:${input.commandId}`,
      type: FLOOR_INDENT_ISSUED,
      occurredAt: input.at,
      // The command's own id is the issue id — the cloud keys the issue and its bin movement on it, so a re-sent scan is one issue.
      idempotencyKey: `indent-issue:${line.indentId}:${input.commandId}`,
      source: this.assignment.assignmentId,
      payload: {
        indentId: line.indentId, issueId: input.commandId,
        lines: [{ productId: line.productId, batchId, quantityMinor: quantity, binId, uom: line.uom }],
        issuedBy: this.assignment.workerId, at: input.at, storeId: this.assignment.storeId, source: 'warehouse-handheld',
      },
    }));

    const left = line.remainingMinor - quantity;
    const detail = `${quantity} ${line.uom} of ${line.productId} issued to the floor for ${line.indentId} from ${binId}` + (left > 0 ? ` — ${left} still owed` : '');
    return { accepted: true, commandId: input.commandId, indentId: line.indentId, productId: line.productId, binId, quantityMinor: quantity, signal: signalFor('accept', 'issued', detail) };
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
    // OB-521: the first pick for an order STARTS it; the rest of an order already picked from here is finished.
    const orderRef = this.picks.get(input.lineId)?.line.orderRef;
    const barred = this.newWorkRefusal(() => [...this.picks.values()].some((e) => e.line.orderRef === orderRef && e.pickedMinor > 0));
    if (barred !== undefined) return { result: { commandId: input.commandId, outcome: 'invalid_command', accepted: false, detail: barred.detail, movements: [] }, signal: barred };
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
