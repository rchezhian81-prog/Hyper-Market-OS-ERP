// API-04 Goods receipt / GRN capture (M07-FR-01/02/03 · D03-FR-02) — the back door of the shop, where most
// of the money is actually lost, made a durable cloud record. Receiving is captured on the handheld offline
// (§31); on sync a GRN reaches here, and this is the central boundary that turns a delivery into trusted
// stock and a visible, valued, owned discrepancy for everything that did not arrive as ordered:
//
//   • it trusts no client verdict — it re-runs the tested `captureReceipt` (the FR-02/03 gate): a
//     batch-tracked item with no batch or no expiry is REFUSED (you cannot recall what you cannot identify,
//     M10); already-expired stock is rejected, never received as sellable; damaged / QC-failed / cold-chain-
//     broken stock goes to QUARANTINE (deliberately not available to sell, M07-FR-03); a short/excess/
//     MRP-mismatch/near-expiry line raises a valued discrepancy;
//   • it trusts no client RULE either (SP-4 (ii), audit finding F03): the product's batch-tracking rule comes
//     from head office's product master and the tolerance policy from the tenant's own receipt policy — a body
//     that names either is refused outright (`receipt_carries_caller_claims`). Where head office does not hold
//     a fact it says so as a FLAG on the record and falls back safely (untracked; the default policy), rather
//     than refusing a delivery that is physically in the building;
//   • an over-tolerance EXCESS is HELD (F03): the ordered quantity becomes stock, the excess is counted and on
//     the GRN but not sellable until a SECOND person — never the receiver (§28) — approves accepting it, when it
//     is released as its own inbound movement, once; a rejection leaves it for the supplier claim (SP-6);
//   • only the SELLABLE quantity of each line becomes availability — one inbound `received` movement per
//     sellable line (quarantine/rejected/held excluded, M08 status), the delivered unit cost carried so the
//     stock re-averages at what it cost (M08-FR-04). The GRN record and its movements are one ATOMIC append
//     (FND-01);
//   • it is idempotent on the GRN id — a re-scan or a re-sync collapses to one effect (§31.1), so a delivery
//     is never double-counted;
//   • SP-6 (audit finding F01): a receipt against an ISSUED purchase order FOLDS INTO THE ORDER in the same atomic
//     append as the GRN and its stock — the received quantity per product (what came into our custody: sellable and
//     quarantined; never the held excess until a second person accepts it, never what was refused at the dock) posts
//     to the PO's own stream, so the open commitment (ordered − received − cancelled, M06-FR-04) falls the moment the
//     goods do. Until this slice that fold was a separate call nobody made, and a partial delivery left the whole
//     order outstanding. The ORDERED quantity is the order's, never the body's (a disagreement is said, F07); a
//     receipt against a proposed or unknown order, or with no order, is recorded and flagged, and folds into nothing;
//   • SP-6 (M07-FR-03): quarantined and refused stock gets a DISPOSITION — accept (released to stock, once) / return
//     (back to the supplier) / claim (kept, value claimed) — by a second person who is not the receiver, one per line,
//     recorded with its value for the supplier account (SP-7). A receipt with undisposed stock waits on the review list.
//
// The rule is the tested `captureReceipt`/`availableFromReceipt`/`heldFromReceipt` in `@sre/receiving` (the
// `services-run-on-their-tested-engine` guardrail); this file is the persistence + HTTP skin. Receiving is
// gated `inventory.movement.append` (Receiver/QC; the route never touches the PO price); deciding a held excess
// is `inventory.adjustment.approve` (the supervisor's authority); the tolerance policy is the owner's
// (`inventory.receipt.policy.set/read`); reads are `inventory.availability.read`. The three-way PO-GRN-invoice
// match (FR-04) reads these GRNs.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  captureReceipt, availableFromReceipt, heldFromReceipt, IncompleteCaptureError,
  type CapturedLine, type CheckedLine, type ProductReceiptRules, type ReceiptPolicy, type CapturedReceipt,
} from '../../../packages/receiving/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { Movement } from './index';

/** The tolerance policy applied when the tenant has set none — and the record says so (`default_policy`). */
export const DEFAULT_RECEIPT_POLICY: ReceiptPolicy = Object.freeze({ excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 30 });

/** What head office could not verify about a receipt — said on the record, never silent (P-08). */
export const RECEIPT_FLAGS = Object.freeze([
  'receiver_unknown', 'receiver_lacks_authority', 'product_rules_unverified', 'cost_unknown',
  'no_purchase_order', 'order_unknown', 'order_not_issued', 'ordered_quantity_disagrees', 'product_not_on_order', 'default_policy',
  // SP-6b — a receipt ASSEMBLED from the handheld's scans, whose on-hand stock the scans already posted (goods-receipt-assembled.ts):
  // the held excess is already on the shelf position; a rejected excess waits for the supplier return (SP-7) to leave it; a
  // line whose checked outcome differs from what the scans posted; an expired scan whose date the handheld did not capture.
  'excess_already_on_hand', 'excess_on_hand_pending_return', 'scan_posting_disagrees', 'expiry_date_assumed',
  // SP-7b — a rejected excess has physically gone back to the supplier (`…/excess/returned`).
  'excess_returned_to_supplier',
] as const);
export type ReceiptFlag = (typeof RECEIPT_FLAGS)[number];

/** The tenant's receiving tolerances as SET — who chose them and when, beside the numbers (F03). */
export interface StoredReceiptPolicy extends ReceiptPolicy {
  readonly setBy: string;
  readonly setAt: string;
}

/** The decided state of a HELD over-tolerance excess (F03 · §28) — a second person's call, recorded once. */
export interface ExcessDecision {
  readonly decision: 'approved' | 'rejected';
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly reason: string;
  /** Released to stock on approval; 0 on a rejection (the goods go back to the supplier — the SP-6 claim). */
  readonly releasedMinor: number;
  readonly movementIds: readonly string[];
  /** How the decision arrived: on the decide route, or relayed from the manager's screen through the box. */
  readonly via: 'direct' | 'relayed';
}

/**
 * SP-7b — the physical RETURN of a rejected over-delivery to the supplier, recorded once per receipt. On a receipt assembled
 * from the handheld's scans the excess was on-hand, so the return takes it off (`returned_to_supplier` movements); on any
 * other receipt the held units never reached on-hand and the return moves nothing — it is recorded so the supplier's
 * account stops showing the return as pending.
 */
export interface ExcessReturn {
  readonly returnedBy: string;
  readonly returnedAt: string;
  readonly reason: string;
  readonly quantityMinor: number;
  /** The held units at the delivered cost — the figure the supplier is told went back. */
  readonly valueMinor: number;
  readonly currency: string;
  readonly movementIds: readonly string[];
  readonly via: 'direct';
}

/** A committed goods receipt — the durable GRN record, carrying the checked outcome. */
export interface GrnRecord {
  readonly grnId: string;
  readonly number: string;
  readonly poId: string | null;
  readonly warehouseId: string;
  readonly receivedBy: string;
  readonly receivedAt: string;
  readonly captured: CapturedReceipt;
  /** Total quantity that became available to sell (quarantine / rejected / held excess excluded). */
  readonly availableMinor: number;
  /** F03 — the over-tolerance excess HELD on this receipt: counted, in the building, not sellable until decided. */
  readonly heldMinor: number;
  /** F03 — set once a second person has decided the held excess; absent while it waits (or when nothing is held). */
  readonly excessDecision?: ExcessDecision;
  /** SP-7b — set once a REJECTED excess has physically gone back to the supplier; absent while the return is pending. */
  readonly excessReturn?: ExcessReturn;
  /**
   * SP-6 (F01) — what this receipt FOLDED into its purchase order, atomically with the GRN: the received quantity per
   * product under `receiptId` (the GRN id). `null` when it folded into nothing (no order, an unknown order, an order not
   * yet issued — the flags say which). Absent on records from before SP-6.
   */
  readonly poReceipt?: { readonly receiptId: string; readonly receivedByProduct: Readonly<Record<string, number>> } | null;
  /** SP-6 (M07-FR-03) — the disposition a second person gave each quarantined / refused line; absent while none has one. */
  readonly dispositions?: readonly LineDisposition[];
  /**
   * SP-6b — set when this GRN was ASSEMBLED from the warehouse handheld's receiving scans (the SP-3a register). Those scans
   * had already posted every on-hand unit (`recv:<grnId>:<commandId>`), so this receipt appended NO `received` movement of
   * its own (hard rule #2) — and a later excess approval / accept disposition releases only what the scans did not post.
   */
  readonly assembledFrom?: AssembledFromScans;
  /** What head office's own records could not confirm about this receipt (a `ReceiptFlag` each). */
  readonly governanceFlags?: readonly string[];
  /** SP-2b — the identity that relayed it (the store box), the surface, and the store, when relayed. */
  readonly relayedBy?: string;
  readonly source?: string;
  readonly storeId?: string | null;
}

/** The three things a second person may do with quarantined or refused stock (M07-FR-03). */
export const LINE_DISPOSITIONS = Object.freeze(['accept', 'return', 'claim'] as const);
export type LineDispositionKind = (typeof LINE_DISPOSITIONS)[number];

/** A second person's disposition of one line's quarantined / refused stock (SP-6 · M07-FR-03 · §28), recorded once. */
export interface LineDisposition {
  readonly lineId: string;
  readonly productId: string;
  /** The quarantined + refused quantity the disposition covers. */
  readonly quantityMinor: number;
  readonly disposition: LineDispositionKind;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly reason: string;
  /** What the disposed stock is worth at the delivered cost — the figure the supplier claim / return carries (SP-7). */
  readonly valueMinor: number;
  readonly currency: string;
  /** The inbound movement an `accept` released — empty for return / claim. */
  readonly movementIds: readonly string[];
  readonly via: 'direct' | 'relayed';
}

/** SP-6b — how a GRN assembled from handheld scans came to be, and what the scans had already posted (see `GrnRecord.assembledFrom`). */
export interface AssembledFromScans {
  readonly scanCount: number;
  /** The handheld's own command ids — the identity every hop deduped each scan on. */
  readonly commandIds: readonly string[];
  /** Everyone whose scans made up the delivery (the record's `receivedBy` is the person who declared it complete). */
  readonly scannedBy: readonly string[];
  readonly completedBy: string;
  readonly completedAt: string;
  /** The on-hand quantity the scans had ALREADY posted, per assembled line — the reason this GRN appends no `received` movement. */
  readonly onHandByLine: Readonly<Record<string, number>>;
  readonly onHandMovementIds: readonly string[];
  /** Lines whose checked outcome (sellable + held) differs from what the scans posted on-hand — a visible exception, never a silent fix. */
  readonly disagreements: readonly { readonly lineId: string; readonly scannedOnHandMinor: number; readonly sellableMinor: number; readonly heldMinor: number }[];
}

/** What a receipt posts against its purchase order (SP-6 · F01): the received quantity per product, keyed on the receipt. */
export interface PoReceiptPosting {
  readonly poId: string;
  readonly receiptId: string;
  readonly receivedByProduct: Readonly<Record<string, number>>;
  readonly by: string;
  readonly at: string;
}

/** The purchase order as head office holds it, for a receipt to be measured against and folded into (SP-6). */
export interface PurchaseOrderForReceipt {
  readonly status: 'proposed' | 'issued';
  readonly orderedByProduct: Readonly<Record<string, number>>;
}

export interface GoodsReceiptDeps {
  /** The GRN with this id, or undefined — for the idempotency (never-double-count) check. */
  readonly grn: (tenantId: string, grnId: string) => Promise<GrnRecord | undefined> | GrnRecord | undefined;
  /** Every GRN — the receiving / discrepancy review surface. */
  readonly all: (tenantId: string) => Promise<readonly GrnRecord[]> | readonly GrnRecord[];
  /**
   * Record the GRN and its inbound movements as ONE atomic append (FND-01) — and, when `poReceipt` is given (SP-6 · F01),
   * the receipt's posting against the purchase order in the SAME append, idempotent on the receipt id.
   */
  readonly commit: (tenantId: string, record: GrnRecord, movements: readonly Movement[], key: string, poReceipt?: PoReceiptPosting) => Promise<void> | void;
  /** SP-6 (F01): the purchase order head office holds — its status and ordered quantity per product — or `undefined`. */
  readonly purchaseOrder: (tenantId: string, poId: string) => Promise<PurchaseOrderForReceipt | undefined> | PurchaseOrderForReceipt | undefined;
  /** SP-6 (M07-FR-03): record a line disposition and, for an accept, the released movement as ONE atomic append. */
  readonly commitDisposition: (tenantId: string, record: GrnRecord, movements: readonly Movement[], key: string) => Promise<void> | void;
  readonly now: () => string;
  /** F03 — the product's receiving rules from the PRODUCT MASTER; `undefined` when the product is not on it. */
  readonly productRule: (tenantId: string, productId: string) => Promise<ProductReceiptRules | undefined> | ProductReceiptRules | undefined;
  /** F03 — the tenant's receiving tolerance policy, or `undefined` when none has been set (the default applies, flagged). */
  readonly receiptPolicy: (tenantId: string) => Promise<StoredReceiptPolicy | undefined> | StoredReceiptPolicy | undefined;
  readonly recordReceiptPolicy: (tenantId: string, policy: StoredReceiptPolicy) => Promise<void> | void;
  /**
   * F03 — record the excess decision and, on approval, the released movements as ONE atomic append (FND-01) — with the
   * accepted excess posted against the purchase order in the same append when the receipt folded into one (SP-6).
   */
  readonly commitExcessDecision: (tenantId: string, record: GrnRecord, movements: readonly Movement[], key: string, poReceipt?: PoReceiptPosting) => Promise<void> | void;
  /** SP-7b — record the physical return of a rejected excess and, where the scans had put it on-hand, the movements that take it off — ONE append. */
  readonly commitExcessReturn: (tenantId: string, record: GrnRecord, movements: readonly Movement[], key: string) => Promise<void> | void;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isMoney = (v: unknown): v is { minor: number; currency: string } => isObj(v) && isNum(v['minor']) && isStr(v['currency']);

const isCapturedLine = (v: unknown): v is CapturedLine =>
  isObj(v) && isStr(v['lineId']) && isStr(v['productId']) && isNum(v['orderedMinor']) && isNum(v['countedMinor'])
  && isStr(v['uom']) && isMoney(v['unitCost']) && isStr(v['condition']);

/**
 * The product master's rules for every product on a receipt — head office's, never the body's (F03). A product the
 * master does not know is SAID (`unverified`) and falls back to untracked rather than refusing goods in the building.
 */
export async function rulesFromMaster(
  deps: Pick<GoodsReceiptDeps, 'productRule'>, tenantId: string, productIds: Iterable<string>,
): Promise<{ readonly rules: readonly ProductReceiptRules[]; readonly unverified: boolean }> {
  const rules: ProductReceiptRules[] = [];
  let unverified = false;
  for (const productId of new Set(productIds)) {
    const rule = await deps.productRule(tenantId, productId);
    if (rule === undefined) { unverified = true; rules.push({ productId, batchTracked: false }); } else rules.push(rule);
  }
  return { rules, unverified };
}

/** The tenant's tolerance policy in force — theirs when set, otherwise the default and `defaulted` so the record says so. */
export async function policyInForce(
  deps: Pick<GoodsReceiptDeps, 'receiptPolicy'>, tenantId: string,
): Promise<{ readonly policy: ReceiptPolicy; readonly defaulted: boolean }> {
  const set = await deps.receiptPolicy(tenantId);
  return set === undefined ? { policy: DEFAULT_RECEIPT_POLICY, defaulted: true } : { policy: set, defaulted: false };
}

/** What the order says, and whether this receipt may fold into it (SP-6 · F01). */
export interface OrderForReceipt {
  readonly poId: string | null;
  /** Ordered quantity per product — `undefined` when there is no order to measure against. */
  readonly ordered: Readonly<Record<string, number>> | undefined;
  /** True only for an ISSUED order head office holds: the one kind of order a receipt folds into. */
  readonly folds: boolean;
}

/**
 * The purchase order behind a receipt, from head office's own register — never the body (F07). No order, an unknown
 * order and an order not yet issued are each SAID as a flag and fold into nothing; the delivery is still received.
 */
export async function orderForReceipt(
  deps: Pick<GoodsReceiptDeps, 'purchaseOrder'>, tenantId: string, poId: string | null, flags: ReceiptFlag[],
): Promise<OrderForReceipt> {
  if (poId === null) { flags.push('no_purchase_order'); return { poId, ordered: undefined, folds: false }; }
  const po = await deps.purchaseOrder(tenantId, poId);
  if (po === undefined) { flags.push('order_unknown'); return { poId, ordered: undefined, folds: false }; }
  if (po.status !== 'issued') { flags.push('order_not_issued'); return { poId, ordered: po.orderedByProduct, folds: false }; }
  return { poId, ordered: po.orderedByProduct, folds: true };
}

/**
 * The ORDERED quantity on each line is the order's, not the sender's (SP-6 · F07): a product on one line takes the order's
 * figure outright; a product split across lines (batches) keeps the sender's split and is flagged when the split does not
 * add up to the order; a product the order never named is received as-is (ordered = counted) and flagged. With no order
 * the lines are returned untouched.
 */
export function alignToOrder(lines: readonly CapturedLine[], ordered: Readonly<Record<string, number>> | undefined, flags: ReceiptFlag[]): readonly CapturedLine[] {
  if (ordered === undefined) return lines;
  const byProduct = new Map<string, CapturedLine[]>();
  for (const l of lines) byProduct.set(l.productId, [...(byProduct.get(l.productId) ?? []), l]);
  const say = (flag: ReceiptFlag): void => { if (!flags.includes(flag)) flags.push(flag); };
  const aligned = new Map<CapturedLine, CapturedLine>();
  for (const [productId, group] of byProduct) {
    const onOrder = ordered[productId];
    if (onOrder === undefined) {
      say('product_not_on_order');
      for (const l of group) aligned.set(l, { ...l, orderedMinor: l.countedMinor });
      continue;
    }
    const claimed = group.reduce((n, l) => n + l.orderedMinor, 0);
    if (group.length === 1) {
      if (claimed !== onOrder) say('ordered_quantity_disagrees');
      aligned.set(group[0]!, { ...group[0]!, orderedMinor: onOrder });
      continue;
    }
    // Several lines of ONE product — good and damaged, two batches. A split the sender gave that adds up to the order is
    // theirs. Otherwise there are two honest ways the sender says "against the 12 ordered": split it, or repeat the 12 on
    // every line — the second is no disagreement, just unsplit — and in both cases the ORDER's figure is apportioned across
    // the lines in line order exactly as the handheld's assembled receipt does (SP-6b): each line takes what it counted
    // while the order lasts, the last line takes the rest. One shortage or excess, said once. Until SP-9-ii (F16) the
    // sender's per-line claims were kept as they stood, so a 10-good + 2-damaged delivery of 12 captured as two lines
    // each "against 12" was judged 2 short AND 10 short — a false claim on a complete delivery.
    if (claimed === onOrder) {
      for (const l of group) aligned.set(l, l);
      continue;
    }
    if (!group.every((l) => l.orderedMinor === onOrder)) say('ordered_quantity_disagrees');
    let remaining = onOrder;
    group.forEach((l, i) => {
      const share = i === group.length - 1 ? remaining : Math.min(remaining, l.countedMinor);
      remaining -= share;
      aligned.set(l, { ...l, orderedMinor: share });
    });
  }
  return lines.map((l) => aligned.get(l) ?? l);
}

/**
 * What a receipt posts as RECEIVED against its order (SP-6 · F01): per product, what came into our custody — sellable
 * stock and quarantined stock (present, pending disposition). NOT the held excess (accepted only when a second person
 * releases it, posted then) and NOT what was refused at the dock (it never came in). Empty when nothing did.
 */
export function receivedAgainstOrder(captured: CapturedReceipt): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const l of captured.lines) {
    const qty = l.sellableMinor + l.quarantinedMinor;
    if (qty > 0) out[l.productId] = (out[l.productId] ?? 0) + qty;
  }
  return out;
}

/** The posting a receipt makes against its order, or `undefined` when it folds into nothing or received nothing. */
export function poPostingFor(order: OrderForReceipt, grnId: string, captured: CapturedReceipt, by: string, at: string): PoReceiptPosting | undefined {
  if (!order.folds || order.poId === null) return undefined;
  const receivedByProduct = receivedAgainstOrder(captured);
  if (Object.keys(receivedByProduct).length === 0) return undefined;
  return { poId: order.poId, receiptId: grnId, receivedByProduct, by, at };
}

/**
 * Inbound `received` movements for the lines of a receipt — the ONE shape the direct capture, the relayed capture and the
 * release of a held excess all append, so the availability projection folds them exactly alike (mv-<grnId>:<lineId>[:excess]).
 */
export function inboundMovements(input: {
  readonly grnId: string;
  readonly locationId: string;
  readonly lines: readonly CheckedLine[];
  readonly quantityOf: (line: CheckedLine) => number;
  readonly suffix?: string;
  readonly occurredAt: string;
  readonly enteredBy: string;
  readonly approvedBy?: string;
  /** The unit cost to carry — `undefined` leaves the movement unvalued rather than folding at ₹0. */
  readonly unitCostMinorOf: (line: CheckedLine) => number | undefined;
}): Movement[] {
  return input.lines
    .filter((l) => input.quantityOf(l) > 0)
    .map((l) => {
      const unitCostMinor = input.unitCostMinorOf(l);
      return {
        movementId: `${input.grnId}:${l.lineId}${input.suffix ?? ''}`,
        productId: l.productId,
        locationId: input.locationId,
        kind: 'received' as const,
        quantityMinor: input.quantityOf(l),
        uom: l.uom,
        occurredAt: input.occurredAt,
        enteredBy: input.enteredBy,
        ...(input.approvedBy === undefined ? {} : { approvedBy: input.approvedBy }),
        ...(l.batchId !== null ? { batchId: l.batchId } : {}),
        // Carry the captured batch expiry onto the ledger (ADR-0015) — cloud-only, feeds near-expiry reads.
        ...(l.expiry !== null ? { expiry: l.expiry } : {}),
        ...(unitCostMinor === undefined ? {} : { unitCostMinor }),
      };
    });
}

/** The quarantined + refused quantity on a line — what a disposition covers (SP-6 · M07-FR-03). */
export const undisposedOn = (l: CheckedLine): number => l.quarantinedMinor + l.rejectedMinor;
/** Lines holding quarantined / refused stock that no second person has yet disposed of. */
export const linesAwaitingDisposition = (g: GrnRecord): readonly CheckedLine[] =>
  g.captured.lines.filter((l) => undisposedOn(l) > 0 && !(g.dispositions ?? []).some((d) => d.lineId === l.lineId));
/** Which receipts still wait for a person: a held excess with no decision, or quarantined / refused stock with no disposition. */
export const awaitsDecision = (g: GrnRecord): boolean =>
  (g.heldMinor > 0 && g.excessDecision === undefined) || linesAwaitingDisposition(g).length > 0;

export type ExcessDecisionOutcome =
  | { readonly ok: true; readonly record: GrnRecord; readonly alreadyDecided: boolean }
  | { readonly ok: false; readonly refusedBecause: string; readonly detail: string };

/**
 * Decide a HELD over-tolerance excess (F03 · §28) — the ONE code path for the direct decide route and a decision relayed
 * from the manager's screen. Approval releases the held quantity as its own inbound movement per line, once; a rejection
 * records the refusal and leaves the goods for the supplier claim. The receiver can never decide their own receipt.
 */
export async function decideReceiptExcess(deps: GoodsReceiptDeps, input: {
  readonly tenantId: string; readonly grnId: string; readonly decidedBy: string;
  readonly decision: 'approved' | 'rejected'; readonly reason: string; readonly branchId: string | null;
  readonly via: 'direct' | 'relayed';
}): Promise<ExcessDecisionOutcome> {
  const rec = await deps.grn(input.tenantId, input.grnId);
  if (rec === undefined) return { ok: false, refusedBecause: 'receipt_unknown', detail: `No goods receipt ${input.grnId} is on file here.` };
  if (rec.heldMinor <= 0) return { ok: false, refusedBecause: 'receipt_holds_no_excess', detail: `Receipt ${input.grnId} holds no over-tolerance excess — there is nothing to decide.` };
  if (rec.receivedBy === input.decidedBy) return { ok: false, refusedBecause: 'self_approval', detail: `${input.decidedBy} received this delivery and cannot decide its excess (§28 separation of duties).` };
  if (rec.excessDecision !== undefined) {
    if (rec.excessDecision.decision === input.decision) return { ok: true, record: rec, alreadyDecided: true };
    return { ok: false, refusedBecause: 'excess_already_decided', detail: `The excess on ${input.grnId} was already ${rec.excessDecision.decision} by ${rec.excessDecision.decidedBy} at ${rec.excessDecision.decidedAt}; a different decision now would be a second truth.` };
  }
  const decidedAt = deps.now();
  // SP-6b: on a receipt ASSEMBLED from the handheld's scans the excess is already on the shelf position — the scans posted
  // every on-hand unit. Approval accepts it where it is (NO movement, or the delivery would count twice, hard rule #2); a
  // rejection records the refusal and flags the units for the supplier return (SP-7) — nothing is invented to move them.
  const postedByScans = rec.assembledFrom !== undefined;
  const movements: Movement[] = input.decision === 'approved' && !postedByScans
    ? inboundMovements({
      grnId: rec.grnId, locationId: rec.warehouseId, lines: rec.captured.lines, quantityOf: (l) => l.heldMinor, suffix: ':excess',
      occurredAt: decidedAt, enteredBy: rec.receivedBy, approvedBy: input.decidedBy,
      // A relayed receipt whose cost head office never held was captured at ₹0 — release it unvalued too, not at ₹0.
      unitCostMinorOf: (l) => (l.unitCost.minor > 0 ? l.unitCost.minor : undefined),
    })
    : [];
  const heldByProduct: Record<string, number> = {};
  for (const l of rec.captured.lines) if (l.heldMinor > 0) heldByProduct[l.productId] = (heldByProduct[l.productId] ?? 0) + l.heldMinor;
  const releasedMinor = input.decision === 'approved' ? rec.captured.lines.reduce((s, l) => s + l.heldMinor, 0) : 0;
  const decided: GrnRecord = {
    ...rec,
    availableMinor: rec.availableMinor + releasedMinor,
    excessDecision: {
      decision: input.decision, decidedBy: input.decidedBy, decidedAt, reason: input.reason,
      releasedMinor, movementIds: movements.map((m) => m.movementId), via: input.via,
    },
    ...(postedByScans && input.decision === 'rejected'
      ? { governanceFlags: [...(rec.governanceFlags ?? []).filter((f) => f !== 'excess_on_hand_pending_return'), 'excess_on_hand_pending_return'] }
      : {}),
  };
  // SP-6 (F01): an ACCEPTED excess is now received against the order too — the over-receipt shows as a negative open
  // quantity on the PO (a signal, never hidden) — in the same append, when the receipt folded into an order at all.
  let poReceipt: PoReceiptPosting | undefined;
  if (releasedMinor > 0 && rec.poId !== null && (rec.poReceipt ?? null) !== null) {
    poReceipt = { poId: rec.poId, receiptId: `${rec.grnId}:excess`, receivedByProduct: heldByProduct, by: input.decidedBy, at: decidedAt };
  }
  await deps.commitExcessDecision(input.tenantId, decided, movements, `${rec.grnId}:excess`, poReceipt);
  await deps.recordAudit?.(input.tenantId, {
    actorId: input.decidedBy, action: input.decision === 'approved' ? 'receipt.excess.approve' : 'receipt.excess.reject',
    objectType: 'goods_receipt', objectId: rec.grnId,
    at: decidedAt, origin: { tenantId: input.tenantId, branchId: input.branchId },
    before: { heldMinor: String(rec.heldMinor), availableMinor: String(rec.availableMinor) },
    after: {
      decision: input.decision, receivedBy: rec.receivedBy, releasedMinor: String(releasedMinor),
      availableMinor: String(decided.availableMinor), movementIds: movements.map((m) => m.movementId).join(','), via: input.via,
    },
    reason: input.reason, correlationId: rec.grnId,
  });
  return { ok: true, record: decided, alreadyDecided: false };
}

export type ExcessReturnOutcome =
  | { readonly ok: true; readonly record: GrnRecord; readonly alreadyReturned: boolean }
  | { readonly ok: false; readonly refusedBecause: 'receipt_unknown' | 'excess_not_rejected'; readonly detail: string };

/**
 * SP-7b — a REJECTED over-delivery goes back to the supplier. On a receipt assembled from the handheld's scans (SP-6b) the
 * excess is on the shelf position, so the return appends one `returned_to_supplier` movement per held line and on-hand
 * falls by exactly what the scans put there — once; on any other receipt the held units never reached on-hand and nothing
 * moves. Either way the return is recorded once, valued at the delivered cost, so the supplier's account (SP-7b) stops
 * showing it as pending. Refused unless a second person REJECTED the excess first: an undecided or approved excess is not
 * the supplier's to take back.
 */
export async function returnRejectedExcess(deps: GoodsReceiptDeps, input: {
  readonly tenantId: string; readonly grnId: string; readonly returnedBy: string; readonly reason: string; readonly branchId: string | null;
}): Promise<ExcessReturnOutcome> {
  const rec = await deps.grn(input.tenantId, input.grnId);
  if (rec === undefined) return { ok: false, refusedBecause: 'receipt_unknown', detail: `No goods receipt ${input.grnId} is on file here.` };
  if (rec.excessDecision?.decision !== 'rejected' || rec.heldMinor <= 0) {
    return {
      ok: false, refusedBecause: 'excess_not_rejected',
      detail: rec.excessDecision === undefined
        ? `The excess on ${input.grnId} has not been decided — a second person must reject it before it can go back to the supplier.`
        : `The excess on ${input.grnId} was ${rec.excessDecision.decision}; only a rejected excess goes back to the supplier.`,
    };
  }
  if (rec.excessReturn !== undefined) return { ok: true, record: rec, alreadyReturned: true };
  const returnedAt = deps.now();
  const held = rec.captured.lines.filter((l) => l.heldMinor > 0);
  const onHand = rec.assembledFrom !== undefined;
  const movements: Movement[] = onHand
    ? held.map((l) => ({
      movementId: `${rec.grnId}:${l.lineId}:returned`,
      productId: l.productId, locationId: rec.warehouseId, kind: 'returned_to_supplier' as const,
      quantityMinor: l.heldMinor, uom: l.uom, occurredAt: returnedAt, enteredBy: input.returnedBy, reason: input.reason,
      ...(l.batchId !== null ? { batchId: l.batchId } : {}),
    }))
    : [];
  const excessReturn: ExcessReturn = {
    returnedBy: input.returnedBy, returnedAt, reason: input.reason,
    quantityMinor: held.reduce((s, l) => s + l.heldMinor, 0),
    valueMinor: held.reduce((s, l) => s + l.heldMinor * l.unitCost.minor, 0),
    currency: held[0]?.unitCost.currency ?? 'INR',
    movementIds: movements.map((m) => m.movementId), via: 'direct',
  };
  const returned: GrnRecord = {
    ...rec, excessReturn,
    governanceFlags: [...(rec.governanceFlags ?? []).filter((f) => f !== 'excess_on_hand_pending_return' && f !== 'excess_returned_to_supplier'), 'excess_returned_to_supplier'],
  };
  await deps.commitExcessReturn(input.tenantId, returned, movements, `${rec.grnId}:excess-return`);
  await deps.recordAudit?.(input.tenantId, {
    actorId: input.returnedBy, action: 'receipt.excess.return', objectType: 'goods_receipt', objectId: rec.grnId,
    at: returnedAt, origin: { tenantId: input.tenantId, branchId: input.branchId },
    before: { heldMinor: String(rec.heldMinor), decision: rec.excessDecision.decision, onHand: String(onHand) },
    after: { quantityMinor: String(excessReturn.quantityMinor), valueMinor: String(excessReturn.valueMinor), movementIds: excessReturn.movementIds.join(',') },
    reason: input.reason, correlationId: rec.grnId,
  });
  return { ok: true, record: returned, alreadyReturned: false };
}

export type LineDispositionOutcome =
  | { readonly ok: true; readonly record: GrnRecord; readonly disposition: LineDisposition; readonly alreadyDecided: boolean }
  | { readonly ok: false; readonly refusedBecause: 'receipt_unknown' | 'line_unknown' | 'nothing_to_dispose' | 'self_approval' | 'line_already_disposed' | 'cannot_accept_refused_stock'; readonly detail: string };

/**
 * Dispose of one line's quarantined / refused stock (SP-6 · M07-FR-03 · §28): a second person — never the receiver —
 * ACCEPTS it (released to stock as its own inbound movement, once; refused stock can never be accepted: it was expired at
 * the dock), RETURNS it to the supplier, or keeps it and CLAIMS its value. One disposition per line, valued at the
 * delivered cost so the supplier account (SP-7) has a figure to work from; the same again is a no-op, a different one is
 * refused. The disposition and any released movement are one atomic append.
 */
export async function decideLineDisposition(deps: GoodsReceiptDeps, input: {
  readonly tenantId: string; readonly grnId: string; readonly lineId: string; readonly decidedBy: string;
  readonly disposition: LineDispositionKind; readonly reason: string; readonly branchId: string | null; readonly via: 'direct' | 'relayed';
}): Promise<LineDispositionOutcome> {
  const rec = await deps.grn(input.tenantId, input.grnId);
  if (rec === undefined) return { ok: false, refusedBecause: 'receipt_unknown', detail: `No goods receipt ${input.grnId} is on file here.` };
  const line = rec.captured.lines.find((l) => l.lineId === input.lineId);
  if (line === undefined) return { ok: false, refusedBecause: 'line_unknown', detail: `Receipt ${input.grnId} has no line ${input.lineId}.` };
  const quantity = undisposedOn(line);
  if (quantity <= 0) return { ok: false, refusedBecause: 'nothing_to_dispose', detail: `Line ${input.lineId} of ${input.grnId} holds no quarantined or refused stock — there is nothing to dispose of.` };
  if (rec.receivedBy === input.decidedBy) return { ok: false, refusedBecause: 'self_approval', detail: `${input.decidedBy} received this delivery and cannot dispose of its stock (§28 separation of duties).` };
  const prior = (rec.dispositions ?? []).find((d) => d.lineId === input.lineId);
  if (prior !== undefined) {
    if (prior.disposition === input.disposition) return { ok: true, record: rec, disposition: prior, alreadyDecided: true };
    return { ok: false, refusedBecause: 'line_already_disposed', detail: `Line ${input.lineId} of ${input.grnId} was already disposed as "${prior.disposition}" by ${prior.decidedBy} at ${prior.decidedAt}; a different disposition now would be a second truth.` };
  }
  if (input.disposition === 'accept' && line.rejectedMinor > 0) {
    return { ok: false, refusedBecause: 'cannot_accept_refused_stock', detail: `Line ${input.lineId} was refused at the dock (expired) — expired stock is never sellable, whoever asks (M07-FR-02 / M10). Return it or claim it.` };
  }
  const decidedAt = deps.now();
  // SP-6b: on a receipt assembled from the handheld's scans, units the scans already posted on-hand are never released again.
  const alreadyOnHand = rec.assembledFrom?.onHandByLine[line.lineId] ?? 0;
  const movements: Movement[] = input.disposition === 'accept'
    ? inboundMovements({
      grnId: rec.grnId, locationId: rec.warehouseId, lines: [line], quantityOf: (l) => Math.max(0, l.quarantinedMinor - alreadyOnHand), suffix: ':accepted',
      occurredAt: decidedAt, enteredBy: rec.receivedBy, approvedBy: input.decidedBy,
      unitCostMinorOf: (l) => (l.unitCost.minor > 0 ? l.unitCost.minor : undefined),
    })
    : [];
  const disposition: LineDisposition = {
    lineId: line.lineId, productId: line.productId, quantityMinor: quantity, disposition: input.disposition,
    decidedBy: input.decidedBy, decidedAt, reason: input.reason,
    valueMinor: line.unitCost.minor * quantity, currency: line.unitCost.currency,
    movementIds: movements.map((m) => m.movementId), via: input.via,
  };
  const released = movements.reduce((n, m) => n + m.quantityMinor, 0);
  const decided: GrnRecord = { ...rec, availableMinor: rec.availableMinor + released, dispositions: [...(rec.dispositions ?? []), disposition] };
  await deps.commitDisposition(input.tenantId, decided, movements, `${rec.grnId}:${line.lineId}:disposition`);
  await deps.recordAudit?.(input.tenantId, {
    actorId: input.decidedBy, action: `receipt.disposition.${input.disposition}`, objectType: 'goods_receipt', objectId: rec.grnId,
    at: decidedAt, origin: { tenantId: input.tenantId, branchId: input.branchId },
    before: { lineId: line.lineId, quarantinedMinor: String(line.quarantinedMinor), rejectedMinor: String(line.rejectedMinor) },
    after: {
      disposition: input.disposition, receivedBy: rec.receivedBy, quantityMinor: String(quantity), valueMinor: String(disposition.valueMinor),
      releasedMinor: String(released), movementIds: movements.map((m) => m.movementId).join(','), via: input.via,
    },
    reason: input.reason, correlationId: rec.grnId,
  });
  return { ok: true, record: decided, disposition, alreadyDecided: false };
}

export function goodsReceiptRoutes(deps: GoodsReceiptDeps): readonly Route[] {
  return [
    {
      // Capture a goods receipt. Body: { number?, poId, warehouseId, receivedOnDate, currency, lines[] }. The product
      // rules and the tolerance policy are head office's own — a body naming them is refused (F03). Idempotent on the
      // GRN id in the path.
      api: 'API-04', method: 'POST', path: '/v1/inventory/goods-receipt/:grnId',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const grnId = (ctx.params['grnId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        // SP-4 (ii) / F03: nothing in the body may decide what is tracked or what is tolerated.
        if (b['rules'] !== undefined || b['policy'] !== undefined) {
          throw apiError(400, {
            code: 'receipt_carries_caller_claims',
            whatHappened: 'This receipt names its own product rules and/or tolerance policy. Head office decides both — from the product master and the tenant\'s receipt policy — never the sender.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the counted lines only. Nothing was changed.',
          });
        }
        const lines = b['lines'];
        if (grnId === '' || !isStr(b['warehouseId']) || !isStr(b['receivedOnDate']) || !isStr(b['currency'])
          || !Array.isArray(lines) || lines.length === 0 || !lines.every(isCapturedLine)) {
          throw apiError(400, {
            code: 'not_readable_as_a_goods_receipt',
            whatHappened: 'A goods receipt needs a grnId in the path, and { warehouseId, receivedOnDate, currency, lines[] (each with lineId/productId/orderedMinor/countedMinor/uom/unitCost/condition) } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the counted lines. The product rules and tolerances are head office\'s own.',
          });
        }
        // Never double-count: a GRN already recorded is returned unchanged (a re-scan / re-sync, §31.1).
        const existing = await deps.grn(ctx.tenantId, grnId);
        if (existing !== undefined) {
          return { status: 200, body: { grn: existing, alreadyReceived: true, flags: existing.governanceFlags ?? [] } };
        }
        const flags: ReceiptFlag[] = [];
        // The ORDER — head office's own, never the body (SP-6 · F01/F07): the ordered quantity on each line is the order's,
        // and only an ISSUED order is folded into. No / unknown / unissued order is said and the delivery still comes in.
        const order = await orderForReceipt(deps, ctx.tenantId, isStr(b['poId']) ? b['poId'] : null, flags);
        const aligned = alignToOrder(lines as CapturedLine[], order.ordered, flags);
        // The product master's rules and the tenant's policy — never the body (F03). Unknown is SAID, then the safe fallback.
        const master = await rulesFromMaster(deps, ctx.tenantId, aligned.map((l) => l.productId));
        if (master.unverified) flags.push('product_rules_unverified');
        const inForce = await policyInForce(deps, ctx.tenantId);
        if (inForce.defaulted) flags.push('default_policy');
        // The FR-02/03 gate — the SAME tested rule the handheld ran, re-run here (a boundary trusts no client
        // verdict): batch/expiry mandatory, discrepancies valued, disposition sellable/quarantine/rejected, excess held.
        let captured: CapturedReceipt;
        try {
          captured = captureReceipt({
            receiptId: grnId,
            lines: aligned,
            rules: master.rules,
            policy: inForce.policy,
            receivedOnDate: b['receivedOnDate'] as string,
            // Validated as a non-empty string above; the engine treats an unknown code as its own currency.
            currency: b['currency'] as CapturedReceipt['discrepancyValue']['currency'],
          });
        } catch (err) {
          if (err instanceof IncompleteCaptureError) {
            throw apiError(422, {
              code: 'receipt_line_incomplete',
              whatHappened: `${err.message}. A line that cannot be identified cannot be received (M10 / M07-FR-02).`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Capture the missing detail (a batch-tracked item needs a batch AND an expiry; a cold-chain item needs a temperature) and receive again.',
            });
          }
          throw err;
        }
        const receivedAt = deps.now();
        // SP-6 (F01): what this receipt posts against its order — in the SAME append as the GRN and its stock.
        const poReceipt = poPostingFor(order, grnId, captured, ctx.userId, receivedAt);
        const record: GrnRecord = {
          grnId,
          number: isStr(b['number']) ? b['number'] : grnId,
          poId: order.poId,
          warehouseId: b['warehouseId'],
          receivedBy: ctx.userId, // server-attributed — the receiver the kernel authenticated
          receivedAt,
          captured,
          availableMinor: availableFromReceipt(captured),
          heldMinor: heldFromReceipt(captured),
          governanceFlags: flags,
          poReceipt: poReceipt === undefined ? null : { receiptId: poReceipt.receiptId, receivedByProduct: poReceipt.receivedByProduct },
        };
        // Only the SELLABLE quantity becomes availability; quarantine / rejected / held are on the GRN but not on-hand.
        const movements = inboundMovements({
          grnId, locationId: record.warehouseId, lines: captured.lines, quantityOf: (l) => l.sellableMinor,
          occurredAt: receivedAt, enteredBy: ctx.userId, unitCostMinorOf: (l) => l.unitCost.minor,
        });
        await deps.commit(ctx.tenantId, record, movements, ctx.idempotencyKey ?? grnId, poReceipt);
        return { status: 201, body: { grn: record, flags, poReceipt: record.poReceipt } };
      },
    },
    {
      // Decide a HELD over-tolerance excess (F03 · §28): a second person accepts it (released to stock, once) or
      // refuses it (left for the supplier claim). Body: { decision: approved|rejected, reason }.
      api: 'API-04', method: 'POST', path: '/v1/inventory/goods-receipt/:grnId/excess/decide',
      permission: 'inventory.adjustment.approve', idempotent: true,
      handler: async (ctx) => {
        const grnId = (ctx.params['grnId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const decision = b['decision'];
        if (grnId === '' || (decision !== 'approved' && decision !== 'rejected') || !isStr(b['reason'])) {
          throw apiError(400, {
            code: 'not_readable_as_an_excess_decision',
            whatHappened: 'Deciding a held excess needs the grnId in the path, a decision of approved or rejected, and a reason.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { decision, reason }. Nothing was changed.',
          });
        }
        const out = await decideReceiptExcess(deps, {
          tenantId: ctx.tenantId, grnId, decidedBy: ctx.userId, decision, reason: b['reason'].trim(), branchId: ctx.branchId ?? null, via: 'direct',
        });
        if (!out.ok) {
          const status = out.refusedBecause === 'receipt_unknown' ? 404
            : out.refusedBecause === 'excess_already_decided' || out.refusedBecause === 'receipt_holds_no_excess' ? 409 : 422;
          throw apiError(status, {
            code: out.refusedBecause, whatHappened: out.detail, wasItSaved: 'not_saved',
            nextSafeAction: out.refusedBecause === 'self_approval' ? 'A different person with approval authority must decide it. Nothing was changed.'
              : out.refusedBecause === 'receipt_unknown' ? 'Check the store has synchronised — the receipt may still be on the store computer.'
                : out.refusedBecause === 'excess_already_decided' ? 'The earlier decision stands. Raise an adjustment request if the position is wrong. Nothing was changed.'
                  : 'Nothing was changed.',
          });
        }
        const d = out.record.excessDecision;
        return {
          status: 200,
          body: {
            grnId, decision: d?.decision, releasedMinor: d?.releasedMinor ?? 0, movementIds: d?.movementIds ?? [],
            decidedBy: d?.decidedBy, decidedAt: d?.decidedAt, availableMinor: out.record.availableMinor, heldMinor: out.record.heldMinor,
            alreadyDecided: out.alreadyDecided,
          },
        };
      },
    },
    {
      // SP-7b: a REJECTED excess has physically gone back to the supplier. Body: { reason }. On an assembled receipt the
      // on-hand units come off, once; otherwise nothing moves and the return is recorded. Idempotent per receipt.
      api: 'API-04', method: 'POST', path: '/v1/inventory/goods-receipt/:grnId/excess/returned',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const grnId = (ctx.params['grnId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (grnId === '' || !isStr(b['reason'])) {
          throw apiError(400, {
            code: 'not_readable_as_an_excess_return',
            whatHappened: 'Recording a supplier return of a rejected excess needs the grnId in the path and a reason.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { reason }. Nothing was changed.',
          });
        }
        const out = await returnRejectedExcess(deps, { tenantId: ctx.tenantId, grnId, returnedBy: ctx.userId, reason: b['reason'].trim(), branchId: ctx.branchId ?? null });
        if (!out.ok) {
          throw apiError(out.refusedBecause === 'receipt_unknown' ? 404 : 409, {
            code: out.refusedBecause, whatHappened: out.detail, wasItSaved: 'not_saved',
            nextSafeAction: out.refusedBecause === 'receipt_unknown'
              ? 'Check the store has synchronised — the receipt may still be on the store computer.'
              : 'Have a second person decide the excess first (reject it), then record the return. Nothing was changed.',
          });
        }
        const r = out.record.excessReturn;
        return {
          status: 200,
          body: {
            grnId, quantityMinor: r?.quantityMinor ?? 0, valueMinor: r?.valueMinor ?? 0, movementIds: r?.movementIds ?? [],
            returnedBy: r?.returnedBy, returnedAt: r?.returnedAt, flags: out.record.governanceFlags ?? [], alreadyReturned: out.alreadyReturned,
          },
        };
      },
    },
    {
      // SP-6 (M07-FR-03 · §28): dispose of one line's quarantined / refused stock — accept (released to stock, once) /
      // return (to the supplier) / claim (kept, value claimed) — by a second person. Body: { disposition, reason }.
      api: 'API-04', method: 'POST', path: '/v1/inventory/goods-receipt/:grnId/lines/:lineId/disposition',
      permission: 'inventory.adjustment.approve', idempotent: true,
      handler: async (ctx) => {
        const grnId = (ctx.params['grnId'] ?? '').trim();
        const lineId = (ctx.params['lineId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const disposition = b['disposition'];
        if (grnId === '' || lineId === '' || !(LINE_DISPOSITIONS as readonly unknown[]).includes(disposition) || !isStr(b['reason'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_disposition',
            whatHappened: `Disposing of a line needs the grnId and lineId in the path, a disposition of ${LINE_DISPOSITIONS.join(' / ')}, and a reason.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { disposition, reason }. Nothing was changed.',
          });
        }
        const out = await decideLineDisposition(deps, {
          tenantId: ctx.tenantId, grnId, lineId, decidedBy: ctx.userId, disposition: disposition as LineDispositionKind,
          reason: b['reason'].trim(), branchId: ctx.branchId ?? null, via: 'direct',
        });
        if (!out.ok) {
          const status = out.refusedBecause === 'receipt_unknown' || out.refusedBecause === 'line_unknown' ? 404
            : out.refusedBecause === 'line_already_disposed' || out.refusedBecause === 'nothing_to_dispose' ? 409 : 422;
          throw apiError(status, {
            code: out.refusedBecause, whatHappened: out.detail, wasItSaved: 'not_saved',
            nextSafeAction: out.refusedBecause === 'self_approval' ? 'A different person with approval authority must dispose of it. Nothing was changed.'
              : out.refusedBecause === 'cannot_accept_refused_stock' ? 'Choose return or claim. Nothing was changed.'
                : out.refusedBecause === 'line_already_disposed' ? 'The earlier disposition stands. Nothing was changed.'
                  : 'Nothing was changed.',
          });
        }
        return {
          status: 200,
          body: {
            grnId, lineId, disposition: out.disposition.disposition, quantityMinor: out.disposition.quantityMinor, valueMinor: out.disposition.valueMinor,
            movementIds: out.disposition.movementIds, decidedBy: out.disposition.decidedBy, decidedAt: out.disposition.decidedAt,
            availableMinor: out.record.availableMinor, awaitsDecision: awaitsDecision(out.record), alreadyDecided: out.alreadyDecided,
          },
        };
      },
    },
    {
      // Read one GRN — the receipt and its checked outcome. 404 when the GRN id is unknown.
      api: 'API-04', method: 'GET', path: '/v1/inventory/goods-receipt/:grnId',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const grnId = (ctx.params['grnId'] ?? '').trim();
        const record = await deps.grn(ctx.tenantId, grnId);
        if (record === undefined) throw notFound(`goods receipt ${grnId}`);
        return { status: 200, body: { grn: record, awaitsDecision: awaitsDecision(record), awaitingDisposition: linesAwaitingDisposition(record).map((l) => l.lineId) } };
      },
    },
    {
      // Every GRN — the ones still waiting for a second person first (control by exception, P-03).
      api: 'API-04', method: 'GET', path: '/v1/inventory/goods-receipt',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const all = [...(await deps.all(ctx.tenantId))];
        const waiting = all.filter(awaitsDecision);
        const ordered = [...waiting, ...all.filter((g) => !awaitsDecision(g))];
        return {
          status: 200,
          body: {
            receipts: ordered, count: ordered.length, needingApprovalCount: waiting.length,
            heldExcessCount: all.filter((g) => g.heldMinor > 0 && g.excessDecision === undefined).length,
            awaitingDispositionCount: all.filter((g) => linesAwaitingDisposition(g).length > 0).length,
          },
        };
      },
    },
    {
      // The tenant's receiving tolerances (F03) — the owner's call, read by the capture routes, never the body's.
      // Body: { excessToleranceBp, shortageToleranceBp, nearExpiryDays, coldChainMaxC? }.
      api: 'API-04', method: 'POST', path: '/v1/inventory/receipt-policy',
      permission: 'inventory.receipt.policy.set', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const cold = b['coldChainMaxC'];
        if (!isNonNegInt(b['excessToleranceBp']) || !isNonNegInt(b['shortageToleranceBp']) || !isNonNegInt(b['nearExpiryDays'])
          || !(cold === undefined || isNum(cold))) {
          throw apiError(400, {
            code: 'not_readable_as_a_receipt_policy',
            whatHappened: 'A receipt policy needs whole, non-negative excessToleranceBp, shortageToleranceBp and nearExpiryDays (and an optional coldChainMaxC in °C).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { excessToleranceBp, shortageToleranceBp, nearExpiryDays }. Nothing was changed.',
          });
        }
        const policy: StoredReceiptPolicy = {
          excessToleranceBp: b['excessToleranceBp'], shortageToleranceBp: b['shortageToleranceBp'], nearExpiryDays: b['nearExpiryDays'],
          ...(isNum(cold) ? { coldChainMaxC: cold } : {}),
          setBy: ctx.userId, setAt: deps.now(),
        };
        await deps.recordReceiptPolicy(ctx.tenantId, policy);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'receipt.policy.set', objectType: 'receipt_policy', objectId: ctx.tenantId,
          at: policy.setAt, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: { excessToleranceBp: String(policy.excessToleranceBp), shortageToleranceBp: String(policy.shortageToleranceBp), nearExpiryDays: String(policy.nearExpiryDays) },
          correlationId: `receipt-policy-${ctx.tenantId}`,
        });
        return { status: 201, body: { policy } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/inventory/receipt-policy',
      permission: 'inventory.receipt.policy.read',
      handler: async (ctx) => {
        const policy = await deps.receiptPolicy(ctx.tenantId);
        return { status: 200, body: { policy: policy ?? null, defaultPolicy: DEFAULT_RECEIPT_POLICY, inForce: policy ?? DEFAULT_RECEIPT_POLICY } };
      },
    },
  ];
}
