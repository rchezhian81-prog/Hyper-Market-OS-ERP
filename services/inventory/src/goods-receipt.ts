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
//   • R3 · A23 · OB-194 "A" (owner, 18 Oct 2026, in writing, "Add a 'dispatch' step"): a supplier return worth MORE than
//     the e-way-bill threshold is DISPATCHED first (`…/excess/dispatch`, `…/lines/:lineId/dispatch`) — refused by name
//     (`ewb_required`) unless a GENERATED e-way bill exists for that movement (pending, rejected or cancelled do not count),
//     and on success it links the EWB number. The `…/returned` records of such a return follow the dispatch (refused,
//     `supplier_return_not_dispatched`, until it is recorded). At or below the threshold the return proceeds as before.
//     The gate is Lane 2's tested `checkDispatchEwb` (packages/e-way-bill/src/dispatch-check.ts).
//
// The rule is the tested `captureReceipt`/`availableFromReceipt`/`heldFromReceipt` in `@sre/receiving` (the
// `services-run-on-their-tested-engine` guardrail); this file is the persistence + HTTP skin. Receiving is
// gated `inventory.movement.append` (Receiver/QC; the route never touches the PO price); deciding a held excess
// is `inventory.adjustment.approve` (the supervisor's authority); the tolerance policy is the owner's
// (`inventory.receipt.policy.set/read`); reads are `inventory.availability.read`. The three-way PO-GRN-invoice
// match (FR-04) reads these GRNs.

import type { Route } from '../../kernel/src/index';
import { apiError, concurrentChange, notFound } from '../../kernel/src/index';
import { ConcurrencyConflictError } from '../../../packages/persistence/src/event-store';
import {
  captureReceipt, availableFromReceipt, heldFromReceipt, IncompleteCaptureError,
  type CapturedLine, type CheckedLine, type ProductReceiptRules, type ReceiptPolicy, type CapturedReceipt,
} from '../../../packages/receiving/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { Movement } from './index';
import { unitsPerLevel, type PackHierarchy } from '../../../packages/product/src/pack';
import { valueAtCost, normaliseUom, minorPerUnit, type CostBasis } from '../../../packages/contracts/src/quantity';
import { assertLocationInScope, stockReadScope, locationIsItsOwnBranch, type LocationBranches } from './location-scope';
import type { RequestContext } from '../../kernel/src/index';
import { deciderSealFlags } from '../../pos/src/store-seal';
import type { DecisionKind } from '../../../packages/identity/src/till-seal';
import {
  assessCheckRecord, carriedChecklistDraft, readCarriedReceivingChecklist, RECEIVING_CHECKLIST_FIELD,
  type FoodSafetyCheck, type FoodSafetyCheckRecord,
} from '../../../packages/facilities/src/food-safety';
import type { DispatchEwbVerdict } from '../../../packages/e-way-bill/src/index';
import { compareAgainstAsn, type Asn, type AsnComparison } from '../../../packages/receiving/src/asn';
import { segregationConflict } from '../../../packages/purchasing/src/segregation';
import { segregationRefusal, type SegregationPort } from '../../purchase/src/segregation-of-duties';

// ── R3 · A23 · OB-194 — a supplier return above the e-way-bill threshold is dispatched under a generated e-way bill ──

/** Which supplier return of a receipt: its rejected over-delivery, or one quarantined line disposed of as a return. */
export type SupplierReturnTarget = { readonly kind: 'excess' } | { readonly kind: 'line'; readonly lineId: string };

/** The e-way-bill register's movement a supplier return's e-way bill is generated under. */
export const supplierReturnEwbMovementId = (grnId: string, target: SupplierReturnTarget): string =>
  target.kind === 'excess' ? `supplier-return-${grnId}-excess` : `supplier-return-${grnId}-line-${target.lineId}`;

/** OB-194: the goods of a supplier return LEFT the shop — recorded once, before (above the threshold) the return is recorded. */
export interface SupplierReturnDispatch {
  readonly grnId: string;
  /** 'excess', or the line id. */
  readonly target: string;
  readonly movementId: string;
  /** The goods at the delivered cost — the consignment value the threshold is judged on. */
  readonly valueMinor: number;
  readonly outcome: 'not_required' | 'covered';
  /** The generated e-way bill the goods left under; null when none was needed. */
  readonly ewbNo: string | null;
  readonly thresholdMinor: number;
  readonly dispatchedBy: string;
  readonly dispatchedAt: string;
  readonly reason: string;
}

/** The link a supplier return record carries to the dispatch it followed (OB-194). */
export interface ReturnDispatchLink {
  readonly movementId: string;
  readonly ewbNo: string | null;
  readonly dispatchedBy: string;
  readonly dispatchedAt: string;
}

const targetKey = (t: SupplierReturnTarget): string => (t.kind === 'excess' ? 'excess' : t.lineId);
const dispatchLink = (d: SupplierReturnDispatch): ReturnDispatchLink => ({ movementId: d.movementId, ewbNo: d.ewbNo, dispatchedBy: d.dispatchedBy, dispatchedAt: d.dispatchedAt });

/** PA-01-r1: a receipt is its warehouse's — acting on one outside the caller's branches is refused by name. */
async function assertReceiptInScope(ctx: Pick<RequestContext, 'scope' | 'tenantId'>, deps: Pick<GoodsReceiptDeps, 'grn' | 'locationBranches'>, grnId: string): Promise<void> {
  if (ctx.scope === 'all') return;
  const record = await deps.grn(ctx.tenantId, grnId);
  if (record !== undefined) await assertLocationInScope(ctx, record.warehouseId, deps.locationBranches);
}

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
  // SF-02 — a product on the order had nothing left to receive (fully received or cancelled): all of it is excess.
  'nothing_left_on_order',
  // Wave 3 · SF-07 — the product master names no handling class for a product on the receipt (owner decision 9 Oct 2026,
  // "A": received normally, said on the record so someone fills it in); and, on a receipt assembled from the handheld's
  // scans, a cold-chain line held for its temperature whose units the scans had already put on-hand.
  'handling_unknown', 'cold_chain_held_but_on_hand',
  // OB-37: the order this receipt folds into was raised before orders named their store — the store could not be checked.
  'order_store_not_named',
  // OB-31 · SF-11: a line was counted in a pack level (case, inner …) and converted to the product's base unit.
  'counted_in_packs',
  // OB-164: a chilled/frozen (cold-chain) delivery relayed from the store, or assembled from the handheld's scans, reached
  // head office with no D-6 receiving checklist on file. The goods are in the building, so it is booked — and SAID.
  'receiving_checklist_missing',
  // OB-172: the delivery carried a receiving checklist from the dock that head office could not accept — not sealed by the
  // store computer for the person who booked it, changed after the seal, done by someone else, unreadable, a checklist head
  // office does not hold, or one that does not pass the D-6 rules. The reason is on the receipt; the checklist is not on file.
  'receiving_checklist_not_accepted',
  // OB-288 P3 (M06-FR-02 · §28): a receipt relayed from the store whose receiver already did another step of the same
  // purchase (raised the order, matched its bill or paid it). It already happened at the door, so it is booked — and SAID.
  'segregation_of_duties',
  // OB-288 P3 (M07-FR-01): what arrived differs from the supplier's advance ship notice for this order (`asnCheck`).
  'asn_differs',
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
 * Batch 2 — the physical RETURN of a quarantined line a second person disposed of as `return` (M07-FR-03 · M06 supplier
 * claim): who handed it over, when and why, recorded once per line. The quarantined units never reached on-hand, so the
 * hand-over moves no stock; it is what lets the supplier account stop showing the goods as waiting for collection beside
 * the debit note (`DN-<grn>-<line>`) the disposition raised.
 */
export interface LineReturn {
  readonly lineId: string;
  readonly productId: string;
  readonly quantityMinor: number;
  readonly valueMinor: number;
  readonly currency: string;
  readonly returnedBy: string;
  readonly returnedAt: string;
  readonly reason: string;
  readonly movementIds: readonly string[];
  /** OB-194: the dispatch (and its e-way bill) the return followed, when one was recorded. */
  readonly dispatch?: ReturnDispatchLink;
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
  /** OB-194: the dispatch (and its e-way bill) the return followed, when one was recorded. */
  readonly dispatch?: ReturnDispatchLink;
}

/** A committed goods receipt — the durable GRN record, carrying the checked outcome. */
export interface GrnRecord {
  readonly grnId: string;
  /** OB-164: the D-6 receiving checklist on file for this delivery when it was booked (a cold-chain receipt needs one). */
  readonly receivingChecklist?: ReceivingChecklistOnFile;
  /** OB-172: why a checklist carried in from the dock was not accepted (with the `receiving_checklist_not_accepted` flag). */
  readonly receivingChecklistNotAccepted?: string;
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
  /** Batch 2 — quarantined lines a second person disposed of as `return` that have PHYSICALLY gone back to the supplier. */
  readonly lineReturns?: readonly LineReturn[];
  /**
   * SP-6 (F01) — what this receipt FOLDED into its purchase order, atomically with the GRN: the received quantity per
   * product under `receiptId` (the GRN id). `null` when it folded into nothing (no order, an unknown order, an order not
   * yet issued — the flags say which). Absent on records from before SP-6.
   */
  readonly poReceipt?: { readonly receiptId: string; readonly receivedByProduct: Readonly<Record<string, number>> } | null;
  /**
   * SF-02 — where the order stood for each of its products when this receipt was judged: the ORIGINAL ordered quantity,
   * what earlier receipts had already received, what was cancelled, and what remained — the figure this receipt was
   * measured against. Absent when there was no issued order (and on records from before SF-02).
   */
  readonly orderPosition?: Readonly<Record<string, OrderPosition>>;
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
  /** OB-288 P3 (§28): why a relayed receipt carries `segregation_of_duties` — the other step its receiver already did. */
  readonly segregationConflict?: string;
  /**
   * OB-288 P3 (M07-FR-01): the receipt compared with the supplier's advance ship notice on head office's register for this
   * order — every product that differs, valued at the delivered cost. Absent when the order has no ASN on file.
   */
  readonly asnCheck?: AsnCheck;
  /** SP-2b — the identity that relayed it (the store box), the surface, and the store, when relayed. */
  readonly relayedBy?: string;
  readonly source?: string;
  readonly storeId?: string | null;
}

/** OB-288 P3 (M07-FR-01): a receipt against the advance ship notice — the ASN is a promise, the receipt is what came. */
export interface AsnCheck {
  readonly asnId: string;
  readonly expectedAt: string;
  /** Every product whose count differs from the notice (a match is not a row), with its value at the delivered cost. */
  readonly differences: readonly (AsnComparison & { readonly valueMinor: number })[];
  readonly matched: boolean;
}

/**
 * What PHYSICALLY arrived per product on a checked receipt — sellable, quarantined, refused at the dock and held alike: the
 * figure an advance ship notice promised. Pure.
 */
export function arrivedByProduct(captured: CapturedReceipt): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const l of captured.lines) out[l.productId] = (out[l.productId] ?? 0) + l.sellableMinor + l.quarantinedMinor + l.rejectedMinor + l.heldMinor;
  return out;
}

/** OB-288 P3: the tested `compareAgainstAsn` over what arrived, each difference valued at the line's delivered cost. Pure. */
export function checkAgainstAsn(asn: Asn, captured: CapturedReceipt): AsnCheck {
  const costOf = new Map(captured.lines.map((l) => [l.productId, l] as const));
  const differences = compareAgainstAsn(asn, arrivedByProduct(captured)).map((d) => {
    const line = costOf.get(d.productId);
    return { ...d, valueMinor: line === undefined ? 0 : valueAtCost(Math.abs(d.differenceMinor), line.uom, line.unitCost as CostBasis) };
  });
  return { asnId: asn.asnId, expectedAt: asn.expectedAt, differences, matched: differences.length === 0 };
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
  /** SF-02 — what earlier receipts already received against it, per product (absent = nothing yet). */
  readonly receivedByProduct?: Readonly<Record<string, number>>;
  /** SF-02 — what approved cancellations took off it, per product (absent = nothing). */
  readonly cancelledByProduct?: Readonly<Record<string, number>>;
  /** OB-37: the store the order is delivered to — absent on an order raised before every order had to name one. */
  readonly deliverToLocationId?: string;
}

/** SF-02 — one product's position on its order when a receipt was judged. */
export interface OrderPosition {
  readonly ordered: number;
  readonly receivedBefore: number;
  readonly cancelled: number;
  /** ordered − received − cancelled, never below zero: what this receipt may still bring in as ordered. */
  readonly remaining: number;
}

/** SF-02 — the receipt's write is conditional on its order not having moved since it was read. */
export interface OrderGuard {
  readonly poId: string;
  readonly expectedVersion: number;
}

/** OB-164: a D-6 receiving checklist recorded against a delivery (its goods receipt id). */
export interface ReceivingChecklistOnFile {
  readonly recordId: string;
  readonly checkId: string;
  readonly outcome: 'pass' | 'fail';
  readonly performedBy: string;
  readonly performedAt: string;
}

/**
 * OB-164 "A" (owner, 16 Oct 2026, in writing, "Chilled and frozen only") — the products on a receipt that need the D-6
 * receiving checklist before the receipt is booked: every cold-chain line, by the product master's own handling class
 * (chilled, frozen, raw meat — a class with approved cold limits) or its own cold-chain limits. Dry goods need none.
 */
export function coldChainProducts(rules: readonly ProductReceiptRules[], productIds: Iterable<string>): string[] {
  const on = new Set(productIds);
  return [...new Set(rules.filter((r) => r.coldChain === true && on.has(r.productId)).map((r) => r.productId))].sort();
}

/**
 * OB-164 — the receiving checklist this receipt needs, read from head office's D-6 record (never the body). Returns the
 * checklist on file (or undefined when none is needed or the lookup is not wired). `refuse`: the direct route refuses by
 * name; a relayed or assembled receipt (the goods already in the building, P-01) is booked and flagged instead.
 */
export async function receivingChecklistGate(
  deps: Pick<GoodsReceiptDeps, 'receivingChecklistFor'>, tenantId: string, grnId: string, rules: readonly ProductReceiptRules[],
  productIds: Iterable<string>, flags: ReceiptFlag[], mode: 'refuse' | 'flag',
): Promise<ReceivingChecklistOnFile | undefined> {
  const cold = coldChainProducts(rules, productIds);
  if (cold.length === 0 || deps.receivingChecklistFor === undefined) return undefined;
  const onFile = await deps.receivingChecklistFor(tenantId, grnId);
  if (onFile !== undefined) return onFile;
  if (mode === 'flag') { if (!flags.includes('receiving_checklist_missing')) flags.push('receiving_checklist_missing'); return undefined; }
  throw apiError(422, {
    code: 'receiving_checklist_required',
    whatHappened: `This delivery carries chilled or frozen goods (${cold.join(', ')}), and no receiving checklist is recorded for ${grnId}. A cold-chain delivery is checked at the door before it is booked into stock (OB-164).`,
    wasItSaved: 'not_saved',
    nextSafeAction: `Do the receiving checklist for this delivery (POST /v1/facilities/food-safety/checks/:checkId/records/:recordId with subjectRef "${grnId}"), then book it again. Nothing was recorded and no stock moved.`,
  });
}

/**
 * OB-172 "A" (owner, 17 Oct 2026, "Checklist on handheld") — a relayed or assembled receipt that CARRIES its receiving
 * checklist from the dock: head office accepts it as its own D-6 record (`rc-<grnId>`, subject the receipt) when, and only
 * when, the store computer sealed the whole receipt for the person it names (`named`: who booked it in / declared it
 * complete — their own sign-in) and the checklist names that same person, it is a checklist head office holds (an active
 * `receiving` check) and it passes the D-6 rules (every item ticked; a failure with its corrective action). Then the receipt
 * is booked with its checklist on file, as complete. Anything else is SAID: `receiving_checklist_not_accepted` with the
 * reason, and — for a cold-chain delivery — `receiving_checklist_missing` as before; the delivery is still booked (P-01).
 * A checklist already on file for the receipt is kept as it is (never overwritten, hard rule #2).
 */
export async function acceptCarriedChecklist(
  deps: Pick<GoodsReceiptDeps, 'receivingChecklistFor' | 'receivingCheckFor' | 'recordCarriedChecklist' | 'tillSealKey' | 'recordAudit' | 'now'>,
  input: { readonly tenantId: string; readonly grnId: string; readonly body: unknown; readonly named: string; readonly kind: DecisionKind; readonly branchId: string | null; readonly source: string },
  flags: ReceiptFlag[],
): Promise<{ readonly notAccepted?: string }> {
  const raw = input.body !== null && typeof input.body === 'object' ? (input.body as Record<string, unknown>)[RECEIVING_CHECKLIST_FIELD] : undefined;
  if (raw === undefined || deps.receivingCheckFor === undefined || deps.recordCarriedChecklist === undefined) return {};
  const refuse = (why: string): { notAccepted: string } => {
    if (!flags.includes('receiving_checklist_not_accepted')) flags.push('receiving_checklist_not_accepted');
    return { notAccepted: why };
  };
  if (deps.receivingChecklistFor !== undefined && await deps.receivingChecklistFor(input.tenantId, input.grnId) !== undefined) return {};
  const carried = readCarriedReceivingChecklist(raw);
  if (carried === undefined) return refuse('the receiving checklist on this receipt could not be read');
  if (carried.performedBy !== input.named.trim()) {
    return refuse(`the receiving checklist names ${carried.performedBy}, but ${input.named} booked the delivery in — a checklist is done in the doer's own sign-in`);
  }
  const seal = deciderSealFlags(deps.tillSealKey, { tenantId: input.tenantId, kind: input.kind, recordId: input.grnId, named: input.named, record: input.body });
  if (seal.length > 0) {
    return refuse(seal[0] === 'decider_not_verified_at_store'
      ? `the store computer did not seal this receipt for ${input.named}, so head office cannot tell the checklist was done in their sign-in`
      : 'the receipt was changed after the store computer sealed it (or the seal belongs to another record), so its checklist cannot be trusted');
  }
  const check = await deps.receivingCheckFor(input.tenantId, carried.checkId);
  if (check === undefined) return refuse(`head office holds no active receiving checklist "${carried.checkId}"`);
  const assessed = assessCheckRecord(check, carriedChecklistDraft(input.grnId, carried));
  if (!assessed.ok) return refuse(assessed.detail);
  const rec = assessed.record;
  await deps.recordCarriedChecklist(input.tenantId, rec);
  // The tamper-evident trail (D-6): sealed in the DOER's name, with what was found and what was done, as the route does.
  await deps.recordAudit?.(input.tenantId, {
    actorId: rec.performedBy, action: rec.outcome === 'fail' ? 'food_safety.check.failed' : 'food_safety.check.passed',
    objectType: 'food_safety_check', objectId: rec.checkId, at: deps.now(),
    origin: { tenantId: input.tenantId, branchId: input.branchId },
    before: null,
    after: {
      recordId: rec.recordId, slotDueAt: '', subjectRef: rec.subjectRef ?? '', outcome: rec.outcome, late: String(rec.late),
      reading: rec.readingTenthsC === undefined ? '' : String(rec.readingTenthsC), failures: rec.failures.join('; '),
      correctiveAction: rec.correctiveAction ?? '', carriedIn: input.source,
    },
    reason: rec.correctiveAction ?? `receiving checklist done at the dock (${input.source}), carried with receipt ${input.grnId}`,
    correlationId: rec.recordId,
  });
  return {};
}

export interface GoodsReceiptDeps {
  /**
   * OB-172: the receiving check a carried checklist names — an ACTIVE `receiving` check head office holds — and the way it
   * keeps that checklist as its own D-6 record. With the seal key, the three are how a checklist captured at the dock (on the
   * manager's screen or the handheld, maybe offline) becomes head office's record. Absent on a bare stub (none accepted).
   */
  readonly receivingCheckFor?: (tenantId: string, checkId: string) => Promise<FoodSafetyCheck | undefined> | FoodSafetyCheck | undefined;
  readonly recordCarriedChecklist?: (tenantId: string, record: FoodSafetyCheckRecord) => Promise<void> | void;
  /** The store computer's seal key (ADR-0023): a carried checklist counts only inside a receipt the box sealed for its person. */
  readonly tillSealKey?: Buffer;
  /**
   * OB-164: the D-6 receiving checklist recorded for this delivery (a `receiving` check's record whose subjectRef is the
   * goods receipt id), or undefined when none is. Absent on a bare stub (nothing is checked).
   */
  readonly receivingChecklistFor?: (tenantId: string, grnId: string) => Promise<ReceivingChecklistOnFile | undefined> | ReceivingChecklistOnFile | undefined;
  /** PA-01-r1: which branch a warehouse/location belongs to (the org hierarchy); absent → its own branch key. */
  readonly locationBranches?: LocationBranches;
  /** The GRN with this id, or undefined — for the idempotency (never-double-count) check. */
  readonly grn: (tenantId: string, grnId: string) => Promise<GrnRecord | undefined> | GrnRecord | undefined;
  /** Every GRN — the receiving / discrepancy review surface. */
  readonly all: (tenantId: string) => Promise<readonly GrnRecord[]> | readonly GrnRecord[];
  /**
   * Record the GRN and its inbound movements as ONE atomic append (FND-01) — and, when `poReceipt` is given (SP-6 · F01),
   * the receipt's posting against the purchase order in the SAME append, idempotent on the receipt id.
   */
  readonly commit: (tenantId: string, record: GrnRecord, movements: readonly Movement[], key: string, poReceipt?: PoReceiptPosting, orderGuard?: OrderGuard) => Promise<void> | void;
  /**
   * SF-02 — the order's write-guard version, read BEFORE the order itself. Every receipt, cancellation and posting against
   * the order moves it, so a receipt decided on a remaining quantity that has since changed is refused, never doubled.
   */
  readonly orderVersion?: (tenantId: string, poId: string) => Promise<number> | number;
  /** SP-6 (F01): the purchase order head office holds — its status and ordered quantity per product — or `undefined`. */
  readonly purchaseOrder: (tenantId: string, poId: string) => Promise<PurchaseOrderForReceipt | undefined> | PurchaseOrderForReceipt | undefined;
  /** SP-6 (M07-FR-03): record a line disposition and, for an accept, the released movement as ONE atomic append. */
  readonly commitDisposition: (tenantId: string, record: GrnRecord, movements: readonly Movement[], key: string) => Promise<void> | void;
  readonly now: () => string;
  /** F03 — the product's receiving rules from the PRODUCT MASTER; `undefined` when the product is not on it. */
  readonly productRule: (tenantId: string, productId: string) => Promise<ProductReceiptRules | undefined> | ProductReceiptRules | undefined;
  /** OB-31 · SF-11: the unit the product master counts the product in (its base unit), or undefined when it does not know it. */
  readonly productUom?: (tenantId: string, productId: string) => Promise<string | undefined> | string | undefined;
  /** OB-31 · SF-11: the product's pack levels (base → inner → case …) from the master, for a line counted in packs. */
  readonly packOf?: (tenantId: string, productId: string) => Promise<PackHierarchy | undefined> | PackHierarchy | undefined;
  /**
   * GT-05 (store volume): the same three facts — the master's unit, the pack levels and the receiving rule — for every product
   * on a receipt in ONE read, so an opening receipt of a thousand lines reads the master once, not once per line. The SAME
   * sources as `productUom` / `packOf` / `productRule`; optional — without it each line asks them one by one.
   */
  readonly productFacts?: (tenantId: string, productIds: readonly string[]) => Promise<ReadonlyMap<string, ProductReceiptFacts>>;
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
  /** Batch 2 — record the physical return of a quarantined line disposed of as `return`, once per line. */
  readonly commitLineReturn: (tenantId: string, record: GrnRecord, key: string) => Promise<void> | void;
  /**
   * R3 · A23 · OB-194: the e-way-bill gate for a supplier return (the receipt, the return's movement and its value at cost →
   * Lane 2's `checkDispatchEwb` verdict, the route from the warehouse's GST state to the supplier's), and the dispatch
   * register. Absent on a bare stub: no gate is applied (main.ts always wires it).
   */
  readonly supplierReturnEwb?: {
    readonly gate: (tenantId: string, rec: GrnRecord, movementId: string, valueMinor: number) => Promise<DispatchEwbVerdict> | DispatchEwbVerdict;
    readonly dispatches: (tenantId: string, grnId: string) => Promise<readonly SupplierReturnDispatch[]> | readonly SupplierReturnDispatch[];
    readonly recordDispatch: (tenantId: string, d: SupplierReturnDispatch) => Promise<void> | void;
  };
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  /** OB-288 P3 (M06-FR-02 · §28): who did each step of the order — a receiver who did another step is refused (or flagged). */
  readonly segregation?: Pick<SegregationPort, 'actorsOf'>;
  /** OB-288 P3 (M07-FR-01): the advance ship notice a buyer accepted for this order (the one named, else the latest). */
  readonly asnFor?: (tenantId: string, poId: string, asnId?: string) => Promise<Asn | undefined> | Asn | undefined;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
// OB-46: a cost may say it buys `per` whole units (a case cost carried exactly) — a whole number above 1 when given.
const isMoney = (v: unknown): v is { minor: number; currency: string } => isObj(v) && isNum(v['minor']) && isStr(v['currency'])
  && (v['per'] === undefined || (Number.isSafeInteger(v['per']) && (v['per'] as number) > 1));

const isCapturedLine = (v: unknown): v is CapturedLine =>
  isObj(v) && isStr(v['lineId']) && isStr(v['productId']) && isNum(v['orderedMinor']) && isNum(v['countedMinor'])
  && isStr(v['uom']) && isMoney(v['unitCost']) && isStr(v['condition'])
  // Wave 3 · SF-07: a recorded temperature is judged against the product's limits, so only a number can be one.
  && (v['temperatureC'] === undefined || isNum(v['temperatureC']));

/**
 * The product master's rules for every product on a receipt — head office's, never the body's (F03). A product the
 * master does not know is SAID (`unverified`) and falls back to untracked rather than refusing goods in the building.
 */
/** GT-05: one product's receiving facts, read in bulk (see `GoodsReceiptDeps.productFacts`). */
export interface ProductReceiptFacts {
  readonly uom?: string;
  readonly pack?: PackHierarchy;
  readonly rule?: ProductReceiptRules;
}

/** GT-05: the deps a receipt runs on, with the per-product lookups answered from ONE bulk read when the adapter offers it. */
async function withProductFacts<D extends Pick<GoodsReceiptDeps, 'productFacts' | 'productUom' | 'packOf' | 'productRule'>>(deps: D, tenantId: string, productIds: readonly string[]): Promise<D> {
  if (deps.productFacts === undefined) return deps;
  const facts = await deps.productFacts(tenantId, [...new Set(productIds)]);
  return {
    ...deps,
    productRule: (_t: string, productId: string) => facts.get(productId)?.rule,
    ...(deps.productUom === undefined ? {} : { productUom: (_t: string, productId: string) => facts.get(productId)?.uom }),
    ...(deps.packOf === undefined ? {} : { packOf: (_t: string, productId: string) => facts.get(productId)?.pack }),
  };
}

export async function rulesFromMaster(
  deps: Pick<GoodsReceiptDeps, 'productRule'>, tenantId: string, productIds: Iterable<string>,
): Promise<{ readonly rules: readonly ProductReceiptRules[]; readonly unverified: boolean; readonly handlingUnknown: boolean }> {
  const rules: ProductReceiptRules[] = [];
  let unverified = false;
  let handlingUnknown = false;
  for (const productId of new Set(productIds)) {
    const rule = await deps.productRule(tenantId, productId);
    if (rule === undefined) { unverified = true; handlingUnknown = true; rules.push({ productId, batchTracked: false }); } else {
      // Wave 3 · SF-07: a product the master holds but whose handling class nobody has given is SAID, never assumed ambient.
      if (rule.handling === undefined) handlingUnknown = true;
      rules.push(rule);
    }
  }
  return { rules, unverified, handlingUnknown };
}

/** The handling facts receiving reads from head office's product master (Wave 3 · SF-07): its class and its own limits. */
export interface MasterHandling {
  readonly handling?: string;
  readonly coldChain?: { readonly minTenthsC?: number; readonly maxTenthsC?: number };
}

/** An approved class default, in the pack engine's tenths of a degree (`COLD_CHAIN_CLASS_DEFAULTS`). */
export interface ColdClassDefault {
  readonly handling: string;
  readonly minTenthsC?: number;
  readonly maxTenthsC?: number;
}

/**
 * Wave 3 · SF-07 — the receiving rule for ONE product, from head office's own records, never the sender's: batch tracking from
 * the published catalogue (as before, F03); the handling class and cold-chain limits from the PRODUCT MASTER. A product is a
 * cold-chain item when its class is a cold class (one with an approved default) or the master gives it limits of its own; its
 * limits are its own when it has them, else its class's approved default — and the rule says whose. `undefined` when neither
 * the catalogue nor the master knows the product (the caller says so: `product_rules_unverified`).
 */
export function receiptRuleFor(
  productId: string,
  published: { readonly batchTracked?: boolean; readonly handling?: string } | undefined,
  master: MasterHandling | undefined,
  classDefaults: readonly ColdClassDefault[],
): ProductReceiptRules | undefined {
  if (published === undefined && master === undefined) return undefined;
  const handling = master?.handling ?? published?.handling;
  const own = master?.coldChain;
  const hasOwn = own !== undefined && (own.minTenthsC !== undefined || own.maxTenthsC !== undefined);
  const classDefault = handling === undefined ? undefined : classDefaults.find((d) => d.handling === handling);
  const limits = hasOwn ? own : classDefault;
  const coldChain = hasOwn || classDefault !== undefined;
  const c = (tenths: number | undefined): number | undefined => (tenths === undefined ? undefined : tenths / 10);
  const maxC = c(limits?.maxTenthsC);
  const minC = c(limits?.minTenthsC);
  return {
    productId,
    batchTracked: published?.batchTracked ?? false,
    ...(handling === undefined ? {} : { handling }),
    ...(coldChain ? {
      coldChain: true,
      ...(maxC === undefined ? {} : { coldChainMaxC: maxC }),
      ...(minC === undefined ? {} : { coldChainMinC: minC }),
      coldChainSource: hasOwn ? 'product' as const : 'class_default' as const,
    } : {}),
  };
}

/** Wave 3 · SF-07 — the flag for a receipt whose rules carried a product with no handling class (owner decision "A"). */
export function sayHandling(flags: ReceiptFlag[], master: { readonly handlingUnknown: boolean }): void {
  if (master.handlingUnknown && !flags.includes('handling_unknown')) flags.push('handling_unknown');
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
  /** SF-02 — per product on an issued order: original, already received, cancelled, remaining. */
  readonly position?: Readonly<Record<string, OrderPosition>>;
  /** SF-02 — the order's guard version read before the order (when the store keeps one). */
  readonly expectedVersion?: number;
}

/** SF-02 — each product's position on an order: the remaining quantity is what a receipt is judged against. */
export function orderPositions(po: PurchaseOrderForReceipt): Readonly<Record<string, OrderPosition>> {
  const out: Record<string, OrderPosition> = {};
  for (const [productId, ordered] of Object.entries(po.orderedByProduct)) {
    const receivedBefore = po.receivedByProduct?.[productId] ?? 0;
    const cancelled = po.cancelledByProduct?.[productId] ?? 0;
    out[productId] = { ordered, receivedBefore, cancelled, remaining: Math.max(0, ordered - receivedBefore - cancelled) };
  }
  return out;
}

/**
 * OB-31 "A" · SF-11 — the unit a receipt line is counted in, judged against the PRODUCT MASTER at the boundary:
 *   • the product's own unit in any accepted spelling (ea/each/EA, kg/KG …) → the line is stored in the master's code;
 *   • a pack level the master defines (case, inner …) → the count is CONVERTED to the base unit's smallest steps
 *     (2 cases of 24 = 48 items; 2 bags of 25 kg = 50000 g) and the record says `counted_in_packs`;
 *   • anything else → refused by name (`unit_not_the_products`): a "case" booked as one item is a 24× error on the shelf.
 * A product the master does not know keeps its line (its spelling normalised) — that is already flagged elsewhere.
 * The line's unit COST is always per whole BASE unit (per item, per kg), whatever the line was counted in.
 */
export async function lineInProductUnit(
  deps: Pick<GoodsReceiptDeps, 'productUom' | 'packOf'>, tenantId: string, line: CapturedLine, flags: ReceiptFlag[],
): Promise<CapturedLine> {
  const productUom = deps.productUom === undefined ? undefined : await deps.productUom(tenantId, line.productId);
  const said = normaliseUom(line.uom);
  if (productUom === undefined) return said === undefined ? line : { ...line, uom: said };
  const base = normaliseUom(productUom) ?? productUom;
  if (said !== undefined && said === base) return { ...line, uom: base };
  if (said === undefined && line.uom.trim() === productUom) return line;
  const pack = deps.packOf === undefined ? undefined : await deps.packOf(tenantId, line.productId);
  const level = pack?.levels.find((l) => l.level.toLowerCase() === line.uom.trim().toLowerCase());
  if (pack !== undefined && level !== undefined) {
    const baseUnits = unitsPerLevel(pack, level.level);
    const steps = baseUnits * (normaliseUom(base) === undefined ? 1 : minorPerUnit(normaliseUom(base)!));
    if (!flags.includes('counted_in_packs')) flags.push('counted_in_packs');
    return { ...line, uom: base, countedMinor: line.countedMinor * steps, orderedMinor: line.orderedMinor * steps };
  }
  throw apiError(422, {
    code: 'unit_not_the_products',
    whatHappened: `${line.productId} is counted in "${base}" on the product master, but line ${line.lineId} says "${line.uom}" — not that unit and not one of its pack levels, so the quantity would mean something else on the shelf (OB-31).`,
    wasItSaved: 'not_saved',
    nextSafeAction: `Count the line in "${base}" (or a pack level the product master defines), then send it again. Nothing was recorded.`,
  });
}

/**
 * OB-37: a receipt against an order is booked at a place that belongs to the order's store — the store itself or a place
 * the org hierarchy puts under it (its back store). Anywhere else is refused by name: the goods were sent to one store and
 * the stock would land at another. An order raised before orders named their store is received and SAID
 * (`order_store_not_named`), never guessed.
 */
export async function assertReceivedAtOrderStore(
  deps: Pick<GoodsReceiptDeps, 'locationBranches'>, tenantId: string, poId: string, po: PurchaseOrderForReceipt, receivedAt: string | undefined, flags: ReceiptFlag[],
): Promise<void> {
  if (receivedAt === undefined) return;
  if (po.deliverToLocationId === undefined) { if (!flags.includes('order_store_not_named')) flags.push('order_store_not_named'); return; }
  const branchOf = await (deps.locationBranches ?? locationIsItsOwnBranch)(tenantId);
  if (receivedAt === po.deliverToLocationId || branchOf(receivedAt) === branchOf(po.deliverToLocationId)) return;
  throw apiError(422, {
    code: 'receipt_not_at_order_store',
    whatHappened: `Purchase order ${poId} is delivered to ${po.deliverToLocationId}, but this delivery was booked in at ${receivedAt}, which is not that store (OB-37).`,
    wasItSaved: 'not_saved',
    nextSafeAction: `Book the delivery in at ${po.deliverToLocationId} (or its back store), or ask the buyer about the order. Nothing was recorded.`,
  });
}

/**
 * The purchase order behind a receipt, from head office's own register — never the body (F07). No order, an unknown
 * order and an order not yet issued are each SAID as a flag and fold into nothing; the delivery is still received.
 */
export async function orderForReceipt(
  deps: Pick<GoodsReceiptDeps, 'purchaseOrder' | 'orderVersion' | 'locationBranches'>, tenantId: string, poId: string | null, flags: ReceiptFlag[],
  /** OB-37: where the goods were received — checked against the store the order is delivered to. */
  receivedAt?: string,
): Promise<OrderForReceipt> {
  if (poId === null) { flags.push('no_purchase_order'); return { poId, ordered: undefined, folds: false }; }
  // SF-02: the guard first, then the order it protects — so anything that lands on the order in between is caught.
  const expectedVersion = deps.orderVersion === undefined ? undefined : await deps.orderVersion(tenantId, poId);
  const po = await deps.purchaseOrder(tenantId, poId);
  if (po === undefined) { flags.push('order_unknown'); return { poId, ordered: undefined, folds: false }; }
  await assertReceivedAtOrderStore(deps, tenantId, poId, po, receivedAt, flags);
  if (po.status !== 'issued') { flags.push('order_not_issued'); return { poId, ordered: po.orderedByProduct, folds: false }; }
  // SF-02: an issued order is measured by what REMAINS on it — never the original figure again. A second delivery of 60
  // against an order of 100 that already received 60 is judged against 40: 40 as ordered, 20 excess, held for a person.
  const position = orderPositions(po);
  const remaining: Record<string, number> = {};
  for (const [productId, p] of Object.entries(position)) remaining[productId] = p.remaining;
  return { poId, ordered: remaining, folds: true, position, ...(expectedVersion === undefined ? {} : { expectedVersion }) };
}

/**
 * SF-02 — record a receipt under its order's guard: the GRN, its stock and its posting against the order land only while
 * the order is as it was read. Another receipt or a cancellation that landed first refuses this one by name (409) —
 * nothing is saved and the receiver books it again against what is left now.
 */
export async function commitAgainstOrder(
  deps: Pick<GoodsReceiptDeps, 'commit' | 'segregation' | 'asnFor'>, tenantId: string, record: GrnRecord, movements: readonly Movement[], key: string,
  poReceipt: PoReceiptPosting | undefined, order: OrderForReceipt,
  /** OB-288 P3: the advance ship notice the receiver received against, when the delivery named one. */
  opts: { readonly asnId?: string } = {},
): Promise<GrnRecord> {
  const final = await withProcureChecks(deps, tenantId, record, opts.asnId);
  const guard = poReceipt !== undefined && order.poId !== null && order.expectedVersion !== undefined
    ? { poId: order.poId, expectedVersion: order.expectedVersion } : undefined;
  try {
    await deps.commit(tenantId, final, movements, key, poReceipt, guard);
  } catch (e) {
    if (e instanceof ConcurrencyConflictError) throw concurrentChange(`purchase order ${order.poId ?? ''}`);
    throw e;
  }
  return final;
}

/**
 * OB-288 P3 — the two procure-to-pay checks every receipt against an order takes before it is committed:
 *   • §28: a receiver who already raised, matched or paid the same order. Booked at head office it is REFUSED by name; a
 *     receipt that already happened at the store (relayed, or assembled from the handheld's scans) is booked and FLAGGED;
 *   • M07-FR-01: the delivery compared with the supplier's advance ship notice on file for the order, every difference on
 *     the record with its value, flagged `asn_differs` for the review list (the discrepancy path, M07-FR-03).
 */
export async function withProcureChecks(deps: Pick<GoodsReceiptDeps, 'segregation' | 'asnFor'>, tenantId: string, record: GrnRecord, asnId?: string): Promise<GrnRecord> {
  if (record.poId === null) return record;
  let out = record;
  const flags = [...(record.governanceFlags ?? [])];
  if (deps.segregation !== undefined) {
    const conflict = segregationConflict(await deps.segregation.actorsOf(tenantId, record.poId), 'receipt', record.receivedBy);
    if (conflict !== undefined) {
      if (record.relayedBy === undefined && record.assembledFrom === undefined) throw segregationRefusal(conflict);
      if (!flags.includes('segregation_of_duties')) flags.push('segregation_of_duties');
      out = { ...out, segregationConflict: conflict.detail };
    }
  }
  const asn = deps.asnFor === undefined ? undefined : await deps.asnFor(tenantId, record.poId, asnId);
  if (asn !== undefined) {
    const asnCheck = checkAgainstAsn(asn, record.captured);
    if (!asnCheck.matched && !flags.includes('asn_differs')) flags.push('asn_differs');
    out = { ...out, asnCheck };
  }
  return out === record && flags.length === (record.governanceFlags ?? []).length ? record : { ...out, governanceFlags: flags };
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
    // SF-02: nothing left on the order for this product (fully received or cancelled) — everything that came is excess.
    if (onOrder === 0) say('nothing_left_on_order');
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
        // OB-46: a case cost carried exactly travels with the stock it valued.
        ...(unitCostMinor === undefined || !((l.unitCost as CostBasis).per! > 1) ? {} : { unitCostPer: (l.unitCost as CostBasis).per! }),
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
  | { readonly ok: false; readonly refusedBecause: 'receipt_unknown' | 'excess_not_rejected' | 'supplier_return_not_dispatched'; readonly detail: string };

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
  const held = rec.captured.lines.filter((l) => l.heldMinor > 0);
  // OB-194: above the e-way-bill threshold the goods must have been dispatched under a generated e-way bill first.
  const followed = await dispatchFollowed(deps, input.tenantId, rec, { kind: 'excess' }, excessValue(rec));
  if (!followed.ok) return { ok: false, refusedBecause: 'supplier_return_not_dispatched', detail: followed.detail };
  const returnedAt = deps.now();
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
    valueMinor: held.reduce((s, l) => s + valueAtCost(l.heldMinor, l.uom, l.unitCost), 0), // OB-31
    currency: held[0]?.unitCost.currency ?? 'INR',
    movementIds: movements.map((m) => m.movementId), via: 'direct',
    ...(followed.dispatch === undefined ? {} : { dispatch: followed.dispatch }),
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
    after: { quantityMinor: String(excessReturn.quantityMinor), valueMinor: String(excessReturn.valueMinor), movementIds: excessReturn.movementIds.join(','), ewbNo: excessReturn.dispatch?.ewbNo ?? '' },
    reason: input.reason, correlationId: rec.grnId,
  });
  return { ok: true, record: returned, alreadyReturned: false };
}

export type LineReturnOutcome =
  | { readonly ok: true; readonly record: GrnRecord; readonly lineReturn: LineReturn; readonly alreadyReturned: boolean }
  | { readonly ok: false; readonly refusedBecause: 'receipt_unknown' | 'line_unknown' | 'line_not_disposed_for_return' | 'held_units_may_be_on_hand' | 'supplier_return_not_dispatched'; readonly detail: string };

/**
 * Batch 2 — record that a quarantined line a second person disposed of as `return` has physically gone back to the supplier
 * (the driver collected it, or it went back on the next delivery van). Once per line; the same again is a no-op. Refused
 * when the line was not disposed of as a return, and — by name — on a receipt assembled from handheld scans that may have
 * put the held units on-hand (`cold_chain_held_but_on_hand` / `scan_posting_disagrees`): those need a count first, never
 * a guess at what to take off.
 */
export async function returnDisposedLine(deps: GoodsReceiptDeps, input: {
  readonly tenantId: string; readonly grnId: string; readonly lineId: string; readonly returnedBy: string; readonly reason: string; readonly branchId: string | null;
}): Promise<LineReturnOutcome> {
  const rec = await deps.grn(input.tenantId, input.grnId);
  if (rec === undefined) return { ok: false, refusedBecause: 'receipt_unknown', detail: `No goods receipt ${input.grnId} is on file here.` };
  const line = rec.captured.lines.find((l) => l.lineId === input.lineId);
  if (line === undefined) return { ok: false, refusedBecause: 'line_unknown', detail: `Goods receipt ${input.grnId} has no line ${input.lineId}.` };
  const prior = (rec.lineReturns ?? []).find((r) => r.lineId === input.lineId);
  if (prior !== undefined) return { ok: true, record: rec, lineReturn: prior, alreadyReturned: true };
  const disposition = (rec.dispositions ?? []).find((d) => d.lineId === input.lineId);
  if (disposition?.disposition !== 'return' || line.quarantinedMinor <= 0) {
    return {
      ok: false, refusedBecause: 'line_not_disposed_for_return',
      detail: disposition === undefined
        ? `Line ${input.lineId} of ${input.grnId} has no disposition yet — a second person must decide to return it before it goes back to the supplier.`
        : `Line ${input.lineId} of ${input.grnId} was disposed of as "${disposition.disposition}"; only a line disposed of as a return goes back to the supplier.`,
    };
  }
  const flags = rec.governanceFlags ?? [];
  if (rec.assembledFrom !== undefined && (flags.includes('cold_chain_held_but_on_hand') || flags.includes('scan_posting_disagrees'))) {
    return {
      ok: false, refusedBecause: 'held_units_may_be_on_hand',
      detail: `Goods receipt ${input.grnId} was assembled from handheld scans that may have put held units on the shelf position (${flags.filter((f) => f === 'cold_chain_held_but_on_hand' || f === 'scan_posting_disagrees').join(', ')}). Count the line first, so the return takes off exactly what is there.`,
    };
  }
  // OB-194: above the e-way-bill threshold the goods must have been dispatched under a generated e-way bill first.
  const followed = await dispatchFollowed(deps, input.tenantId, rec, { kind: 'line', lineId: line.lineId }, valueAtCost(line.quarantinedMinor, line.uom, line.unitCost));
  if (!followed.ok) return { ok: false, refusedBecause: 'supplier_return_not_dispatched', detail: followed.detail };
  const returnedAt = deps.now();
  const lineReturn: LineReturn = {
    lineId: line.lineId, productId: line.productId, quantityMinor: line.quarantinedMinor, valueMinor: valueAtCost(line.quarantinedMinor, line.uom, line.unitCost),
    currency: line.unitCost.currency, returnedBy: input.returnedBy, returnedAt, reason: input.reason, movementIds: [],
    ...(followed.dispatch === undefined ? {} : { dispatch: followed.dispatch }),
  };
  const returned: GrnRecord = { ...rec, lineReturns: [...(rec.lineReturns ?? []), lineReturn] };
  await deps.commitLineReturn(input.tenantId, returned, `${rec.grnId}:${line.lineId}`);
  await deps.recordAudit?.(input.tenantId, {
    actorId: input.returnedBy, action: 'receipt.line.return', objectType: 'goods_receipt', objectId: rec.grnId,
    at: returnedAt, origin: { tenantId: input.tenantId, branchId: input.branchId },
    before: { lineId: line.lineId, disposition: disposition.disposition, decidedBy: disposition.decidedBy },
    after: { quantityMinor: String(lineReturn.quantityMinor), valueMinor: String(lineReturn.valueMinor), debitNoteRef: `DN-${rec.grnId}-${line.lineId}`, ewbNo: lineReturn.dispatch?.ewbNo ?? '' },
    reason: input.reason, correlationId: rec.grnId,
  });
  return { ok: true, record: returned, lineReturn, alreadyReturned: false };
}

/** OB-194: the rejected over-delivery's value at the delivered cost (the same figure the return records). */
const excessValue = (rec: GrnRecord): number => rec.captured.lines.filter((l) => l.heldMinor > 0).reduce((s, l) => s + valueAtCost(l.heldMinor, l.uom, l.unitCost), 0);

/**
 * OB-194: may the return of these goods be recorded? With a dispatch on file, yes — and it links to it. Without one, only
 * when the gate says no e-way bill is needed (at or below the threshold: today's flow, unchanged). Above it, the dispatch
 * step comes first. A bare stub with no gate wired keeps the old behaviour.
 */
async function dispatchFollowed(deps: GoodsReceiptDeps, tenantId: string, rec: GrnRecord, target: SupplierReturnTarget, valueMinor: number): Promise<{ readonly ok: true; readonly dispatch?: ReturnDispatchLink } | { readonly ok: false; readonly detail: string }> {
  const ewb = deps.supplierReturnEwb;
  if (ewb === undefined) return { ok: true };
  const prior = (await ewb.dispatches(tenantId, rec.grnId)).find((d) => d.target === targetKey(target));
  if (prior !== undefined) return { ok: true, dispatch: dispatchLink(prior) };
  const movementId = supplierReturnEwbMovementId(rec.grnId, target);
  const verdict = await ewb.gate(tenantId, rec, movementId, valueMinor);
  if (verdict.outcome === 'not_required') return { ok: true };
  return {
    ok: false,
    detail: `This supplier return (movement ${movementId}) is worth more than the ₹${(verdict.thresholdMinor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} e-way-bill threshold, so its dispatch under a generated e-way bill is recorded first (OB-194)${verdict.outcome === 'refused' ? `: ${verdict.detail}` : '.'}`,
  };
}

export type ReturnDispatchOutcome =
  | { readonly ok: true; readonly dispatch: SupplierReturnDispatch; readonly verdict: DispatchEwbVerdict | null; readonly alreadyDispatched: boolean }
  | { readonly ok: false; readonly refusedBecause: 'receipt_unknown' | 'line_unknown' | 'excess_not_rejected' | 'line_not_disposed_for_return' | 'supplier_return_already_recorded' | 'ewb_check_not_available'; readonly detail: string }
  | { readonly ok: false; readonly refusedBecause: 'ewb_required'; readonly detail: string; readonly verdict: DispatchEwbVerdict };

/**
 * R3 · A23 · OB-194 — the DISPATCH of a supplier return: the goods are leaving the shop. Only a return a second person
 * decided (a rejected excess; a line disposed of as `return`) can be dispatched, once, and not after its return was already
 * recorded. Above the e-way-bill threshold it is REFUSED by name (`ewb_required`) unless a GENERATED e-way bill exists for
 * the return's own movement (pending, rejected or cancelled do not count); with one, the dispatch links the EWB number.
 * At or below the threshold it proceeds. Moves no stock: the `…/returned` record that follows does what it always did.
 */
export async function dispatchSupplierReturn(deps: GoodsReceiptDeps, input: {
  readonly tenantId: string; readonly grnId: string; readonly target: SupplierReturnTarget; readonly dispatchedBy: string; readonly reason: string; readonly branchId: string | null;
}): Promise<ReturnDispatchOutcome> {
  const rec = await deps.grn(input.tenantId, input.grnId);
  if (rec === undefined) return { ok: false, refusedBecause: 'receipt_unknown', detail: `No goods receipt ${input.grnId} is on file here.` };
  let valueMinor: number;
  if (input.target.kind === 'excess') {
    if (rec.excessDecision?.decision !== 'rejected' || rec.heldMinor <= 0) {
      return { ok: false, refusedBecause: 'excess_not_rejected', detail: `The excess on ${input.grnId} has not been rejected by a second person, so it is not going back to the supplier.` };
    }
    valueMinor = excessValue(rec);
  } else {
    const lineId = input.target.lineId;
    const line = rec.captured.lines.find((l) => l.lineId === lineId);
    if (line === undefined) return { ok: false, refusedBecause: 'line_unknown', detail: `Goods receipt ${input.grnId} has no line ${lineId}.` };
    const disposition = (rec.dispositions ?? []).find((d) => d.lineId === lineId);
    if (disposition?.disposition !== 'return' || line.quarantinedMinor <= 0) {
      return { ok: false, refusedBecause: 'line_not_disposed_for_return', detail: `Line ${lineId} of ${input.grnId} has not been disposed of as a return by a second person.` };
    }
    valueMinor = valueAtCost(line.quarantinedMinor, line.uom, line.unitCost);
  }
  const ewb = deps.supplierReturnEwb;
  if (ewb === undefined) return { ok: false, refusedBecause: 'ewb_check_not_available', detail: 'The e-way-bill check is not available here, so a dispatch cannot be recorded.' };
  const key = targetKey(input.target);
  const prior = (await ewb.dispatches(input.tenantId, rec.grnId)).find((d) => d.target === key);
  if (prior !== undefined) return { ok: true, dispatch: prior, verdict: null, alreadyDispatched: true };
  // A return already recorded (at or below the threshold, with no dispatch) has gone: a dispatch now would be a second truth.
  const returnedAt = input.target.kind === 'excess' ? rec.excessReturn?.returnedAt : (rec.lineReturns ?? []).find((r) => input.target.kind === 'line' && r.lineId === input.target.lineId)?.returnedAt;
  if (returnedAt !== undefined) return { ok: false, refusedBecause: 'supplier_return_already_recorded', detail: `The return of ${input.target.kind === 'excess' ? 'the excess' : `line ${input.target.lineId}`} on ${input.grnId} was already recorded at ${returnedAt}.` };
  const movementId = supplierReturnEwbMovementId(rec.grnId, input.target);
  const verdict = await ewb.gate(input.tenantId, rec, movementId, valueMinor);
  if (verdict.outcome === 'refused') return { ok: false, refusedBecause: 'ewb_required', detail: verdict.detail, verdict };
  const dispatch: SupplierReturnDispatch = {
    grnId: rec.grnId, target: key, movementId, valueMinor, outcome: verdict.outcome, ewbNo: verdict.outcome === 'covered' ? verdict.ewbNo : null,
    thresholdMinor: verdict.thresholdMinor, dispatchedBy: input.dispatchedBy, dispatchedAt: deps.now(), reason: input.reason,
  };
  await ewb.recordDispatch(input.tenantId, dispatch);
  await deps.recordAudit?.(input.tenantId, {
    actorId: input.dispatchedBy, action: 'receipt.return.dispatch', objectType: 'goods_receipt', objectId: rec.grnId,
    at: dispatch.dispatchedAt, origin: { tenantId: input.tenantId, branchId: input.branchId }, before: null,
    after: { target: key, movementId, valueMinor: String(valueMinor), outcome: dispatch.outcome, ewbNo: dispatch.ewbNo ?? '' },
    reason: input.reason, correlationId: rec.grnId,
  });
  return { ok: true, dispatch, verdict, alreadyDispatched: false };
}

/**
 * OB-204: where each supplier return of a receipt stands on its dispatch, in head office's words — so the goods-receipt
 * screen can say it before anyone presses Dispatch. One entry per return still to go (a rejected excess, a line disposed
 * of as a return) and per return already dispatched; a return recorded with no dispatch (at or below the threshold) has
 * none. It reads what `dispatchSupplierReturn` would judge (the same gate, the same register) and changes nothing.
 *   • `not_required` — at or below the threshold: the return is recorded as before, no dispatch step;
 *   • `no_ewb` · `ewb_waiting` (pending / provider error) · `ewb_not_usable` (rejected / cancelled) — above it, and the
 *     dispatch would be refused (`ewb_required`) today;
 *   • `ewb_generated` — above it, covered by a generated e-way bill: the dispatch would proceed, linking `ewbNo`;
 *   • `dispatched` — recorded, with the e-way bill it left under (null when none was needed);
 *   • `not_known` — the check could not be read just now (said, never guessed — P-08).
 * Absent (`undefined`) when this head office has no e-way-bill check wired, which is when the dispatch step does not apply.
 */
export interface SupplierReturnDispatchStatus {
  /** 'excess', or the line id. */
  readonly target: string;
  readonly movementId: string;
  readonly valueMinor: number;
  readonly thresholdMinor: number | null;
  readonly state: 'not_required' | 'no_ewb' | 'ewb_waiting' | 'ewb_not_usable' | 'ewb_generated' | 'dispatched' | 'not_known';
  /** The e-way bill's own state when one is on the register for the movement ('none' when never submitted). */
  readonly ewbState: string | null;
  readonly ewbNo: string | null;
  readonly dispatch: SupplierReturnDispatch | null;
  /** The gate's plain-English reason, shown as-is. */
  readonly detail: string;
}

export async function supplierReturnDispatchStatuses(deps: Pick<GoodsReceiptDeps, 'supplierReturnEwb'>, tenantId: string, rec: GrnRecord): Promise<readonly SupplierReturnDispatchStatus[] | undefined> {
  const ewb = deps.supplierReturnEwb;
  if (ewb === undefined) return undefined;
  const targets: { readonly target: SupplierReturnTarget; readonly valueMinor: number; readonly returned: boolean }[] = [];
  if (rec.excessDecision?.decision === 'rejected' && rec.heldMinor > 0) targets.push({ target: { kind: 'excess' }, valueMinor: excessValue(rec), returned: rec.excessReturn !== undefined });
  for (const d of rec.dispositions ?? []) {
    if (d.disposition !== 'return') continue;
    const line = rec.captured.lines.find((l) => l.lineId === d.lineId);
    if (line === undefined || line.quarantinedMinor <= 0) continue;
    targets.push({ target: { kind: 'line', lineId: line.lineId }, valueMinor: valueAtCost(line.quarantinedMinor, line.uom, line.unitCost), returned: (rec.lineReturns ?? []).some((r) => r.lineId === line.lineId) });
  }
  if (targets.length === 0) return [];
  let dispatches: readonly SupplierReturnDispatch[];
  try { dispatches = await ewb.dispatches(tenantId, rec.grnId); } catch { dispatches = []; }
  const out: SupplierReturnDispatchStatus[] = [];
  for (const { target, valueMinor, returned } of targets) {
    const key = targetKey(target);
    const movementId = supplierReturnEwbMovementId(rec.grnId, target);
    const prior = dispatches.find((d) => d.target === key);
    if (prior !== undefined) {
      out.push({ target: key, movementId, valueMinor: prior.valueMinor, thresholdMinor: prior.thresholdMinor, state: 'dispatched', ewbState: prior.ewbNo === null ? null : 'generated', ewbNo: prior.ewbNo, dispatch: prior, detail: prior.ewbNo === null ? 'dispatched — no e-way bill was needed' : `dispatched under e-way bill ${prior.ewbNo}` });
      continue;
    }
    if (returned) continue; // recorded with no dispatch (at or below the threshold): nothing to dispatch
    let verdict: DispatchEwbVerdict;
    try {
      verdict = await ewb.gate(tenantId, rec, movementId, valueMinor);
    } catch {
      out.push({ target: key, movementId, valueMinor, thresholdMinor: null, state: 'not_known', ewbState: null, ewbNo: null, dispatch: null, detail: 'the e-way-bill check could not be read just now' });
      continue;
    }
    const base = { target: key, movementId, valueMinor, thresholdMinor: verdict.thresholdMinor, dispatch: null, detail: verdict.detail } as const;
    if (verdict.outcome === 'not_required') out.push({ ...base, state: 'not_required', ewbState: null, ewbNo: null });
    else if (verdict.outcome === 'covered') out.push({ ...base, state: 'ewb_generated', ewbState: 'generated', ewbNo: verdict.ewbNo });
    else {
      const s = verdict.ewbState;
      out.push({ ...base, state: s === 'none' ? 'no_ewb' : s === 'pending_unknown' || s === 'provider_error' ? 'ewb_waiting' : 'ewb_not_usable', ewbState: s, ewbNo: null });
    }
  }
  return out;
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
    valueMinor: valueAtCost(quantity, line.uom, line.unitCost), currency: line.unitCost.currency, // OB-31
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
        // PA-01-r1: received only into a warehouse inside the caller's branches (and never over another branch's receipt).
        await assertLocationInScope(ctx, b['warehouseId'] as string, deps.locationBranches);
        await assertReceiptInScope(ctx, deps, grnId);
        // Never double-count: a GRN already recorded is returned unchanged (a re-scan / re-sync, §31.1).
        const existing = await deps.grn(ctx.tenantId, grnId);
        if (existing !== undefined) {
          return { status: 200, body: { grn: existing, alreadyReceived: true, flags: existing.governanceFlags ?? [] } };
        }
        const flags: ReceiptFlag[] = [];
        // The ORDER — head office's own, never the body (SP-6 · F01/F07): the ordered quantity on each line is the order's,
        // and only an ISSUED order is folded into. No / unknown / unissued order is said and the delivery still comes in.
        // OB-31 · SF-11: every line in the product's own unit (spelling normalised, packs converted) — or refused by name.
        const inUnits: CapturedLine[] = [];
        const known = await withProductFacts(deps, ctx.tenantId, (lines as CapturedLine[]).map((l) => l.productId));
        for (const l of lines as CapturedLine[]) inUnits.push(await lineInProductUnit(known, ctx.tenantId, l, flags));
        const order = await orderForReceipt(deps, ctx.tenantId, isStr(b['poId']) ? b['poId'] : null, flags, b['warehouseId'] as string);
        const aligned = alignToOrder(inUnits, order.ordered, flags);
        // The product master's rules and the tenant's policy — never the body (F03). Unknown is SAID, then the safe fallback.
        const master = await rulesFromMaster(known, ctx.tenantId, aligned.map((l) => l.productId));
        if (master.unverified) flags.push('product_rules_unverified'); sayHandling(flags, master);
        // OB-164: a chilled/frozen delivery is not booked until its receiving checklist is on file — refused by name.
        const checklist = await receivingChecklistGate(deps, ctx.tenantId, grnId, master.rules, aligned.map((l) => l.productId), flags, 'refuse');
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
          ...(checklist === undefined ? {} : { receivingChecklist: checklist }),
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
          ...(order.position === undefined ? {} : { orderPosition: order.position }),
        };
        // Only the SELLABLE quantity becomes availability; quarantine / rejected / held are on the GRN but not on-hand.
        const movements = inboundMovements({
          grnId, locationId: record.warehouseId, lines: captured.lines, quantityOf: (l) => l.sellableMinor,
          occurredAt: receivedAt, enteredBy: ctx.userId, unitCostMinorOf: (l) => l.unitCost.minor,
        });
        const committed = await commitAgainstOrder(deps, ctx.tenantId, record, movements, ctx.idempotencyKey ?? grnId, poReceipt, order, isStr(b['asnId']) ? { asnId: b['asnId'] } : {});
        return { status: 201, body: { grn: committed, flags: committed.governanceFlags ?? flags, poReceipt: committed.poReceipt } };
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
        await assertReceiptInScope(ctx, deps, grnId); // PA-01-r1
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
    ...(['excess', 'line'] as const).map((kind): Route => ({
      // R3 · A23 · OB-194: a supplier return is DISPATCHED — the goods leave the shop. Above the e-way-bill threshold only
      // under a generated e-way bill for its own movement (refused by name, `ewb_required`, otherwise); it links the EWB
      // number. At or below the threshold it proceeds. Body: { reason }. Once per return; moves no stock.
      api: 'API-04', method: 'POST',
      path: kind === 'excess' ? '/v1/inventory/goods-receipt/:grnId/excess/dispatch' : '/v1/inventory/goods-receipt/:grnId/lines/:lineId/dispatch',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const grnId = (ctx.params['grnId'] ?? '').trim();
        const lineId = (ctx.params['lineId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (grnId === '' || (kind === 'line' && lineId === '') || !isStr(b['reason'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_return_dispatch',
            whatHappened: 'Recording the dispatch of a supplier return needs the receipt (and line) in the path and a reason (who is taking it, which vehicle).',
            wasItSaved: 'not_saved', nextSafeAction: 'Send { reason }. Nothing was changed.',
          });
        }
        await assertReceiptInScope(ctx, deps, grnId); // PA-01-r1
        const target: SupplierReturnTarget = kind === 'excess' ? { kind: 'excess' } : { kind: 'line', lineId };
        const out = await dispatchSupplierReturn(deps, { tenantId: ctx.tenantId, grnId, target, dispatchedBy: ctx.userId, reason: b['reason'].trim(), branchId: ctx.branchId ?? null });
        if (!out.ok) {
          const status = out.refusedBecause === 'receipt_unknown' || out.refusedBecause === 'line_unknown' ? 404 : out.refusedBecause === 'ewb_check_not_available' ? 503 : 409;
          const movementId = supplierReturnEwbMovementId(grnId, target);
          throw apiError(status, {
            code: out.refusedBecause,
            whatHappened: out.refusedBecause === 'ewb_required' ? `This supplier return cannot leave without an e-way bill: ${out.detail}.` : out.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: out.refusedBecause === 'ewb_required'
              ? `Generate the e-way bill for movement ${movementId} (POST /v1/finance/e-way-bill/movements/${movementId}/submit, then the portal's answer), then dispatch again. Nothing was moved.`
              : 'Nothing was changed.',
          });
        }
        return {
          status: out.alreadyDispatched ? 200 : 201,
          body: { grnId, target: out.dispatch.target, dispatch: out.dispatch, ...(out.verdict === null ? {} : { ewayBill: out.verdict }), alreadyDispatched: out.alreadyDispatched },
        };
      },
    })),
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
        await assertReceiptInScope(ctx, deps, grnId); // PA-01-r1
        const out = await returnRejectedExcess(deps, { tenantId: ctx.tenantId, grnId, returnedBy: ctx.userId, reason: b['reason'].trim(), branchId: ctx.branchId ?? null });
        if (!out.ok) {
          throw apiError(out.refusedBecause === 'receipt_unknown' ? 404 : 409, {
            code: out.refusedBecause, whatHappened: out.detail, wasItSaved: 'not_saved',
            nextSafeAction: out.refusedBecause === 'receipt_unknown'
              ? 'Check the store has synchronised — the receipt may still be on the store computer.'
              : out.refusedBecause === 'supplier_return_not_dispatched'
                ? `Record the dispatch first (POST /v1/inventory/goods-receipt/${grnId}/excess/dispatch) under a generated e-way bill for movement ${supplierReturnEwbMovementId(grnId, { kind: 'excess' })}. Nothing was changed.`
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
      // Batch 2: a quarantined line disposed of as a RETURN has physically gone back to the supplier. Body: { reason }.
      // Moves no stock (it was never on hand); idempotent per line. Refused when the line is not a disposed return.
      api: 'API-04', method: 'POST', path: '/v1/inventory/goods-receipt/:grnId/lines/:lineId/returned',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const grnId = (ctx.params['grnId'] ?? '').trim();
        const lineId = (ctx.params['lineId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (grnId === '' || lineId === '' || !isStr(b['reason'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_line_return',
            whatHappened: 'Recording a supplier return of a quarantined line needs the grnId and lineId in the path and a reason (who collected it, how).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { reason }. Nothing was changed.',
          });
        }
        await assertReceiptInScope(ctx, deps, grnId); // PA-01-r1
        const out = await returnDisposedLine(deps, { tenantId: ctx.tenantId, grnId, lineId, returnedBy: ctx.userId, reason: b['reason'].trim(), branchId: ctx.branchId ?? null });
        if (!out.ok) {
          throw apiError(out.refusedBecause === 'receipt_unknown' || out.refusedBecause === 'line_unknown' ? 404 : 409, {
            code: out.refusedBecause, whatHappened: out.detail, wasItSaved: 'not_saved',
            nextSafeAction: out.refusedBecause === 'line_not_disposed_for_return'
              ? 'Have a second person dispose of the line as a return first. Nothing was changed.'
              : out.refusedBecause === 'supplier_return_not_dispatched'
                ? `Record the dispatch first (POST /v1/inventory/goods-receipt/${grnId}/lines/${lineId}/dispatch) under a generated e-way bill for movement ${supplierReturnEwbMovementId(grnId, { kind: 'line', lineId })}. Nothing was changed.`
              : out.refusedBecause === 'held_units_may_be_on_hand' ? 'Count the line, then record the return. Nothing was changed.'
              : 'Check the store has synchronised — the receipt may still be on the store computer.',
          });
        }
        return {
          status: out.alreadyReturned ? 200 : 201,
          body: { grnId, ...out.lineReturn, debitNoteRef: `DN-${grnId}-${lineId}`, alreadyReturned: out.alreadyReturned },
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
        await assertReceiptInScope(ctx, deps, grnId); // PA-01-r1
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
        await assertLocationInScope(ctx, record.warehouseId, deps.locationBranches); // PA-01-r1: a direct id stays outside
        return { status: 200, body: { grn: record, awaitsDecision: awaitsDecision(record), awaitingDisposition: linesAwaitingDisposition(record).map((l) => l.lineId) } };
      },
    },
    {
      // Every GRN — the ones still waiting for a second person first (control by exception, P-03).
      api: 'API-04', method: 'GET', path: '/v1/inventory/goods-receipt',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const scope = await stockReadScope(ctx, deps.locationBranches); // PA-01-r1: only the caller's branches' receipts
        const all = (await deps.all(ctx.tenantId)).filter((g) => scope.covers(g.warehouseId));
        const waiting = all.filter(awaitsDecision);
        const ordered = [...waiting, ...all.filter((g) => !awaitsDecision(g))];
        // OB-204: each supplier return's dispatch state, so the screen can say it before anyone presses Dispatch.
        const receipts = await Promise.all(ordered.map(async (g) => {
          const returnDispatches = await supplierReturnDispatchStatuses(deps, ctx.tenantId, g);
          return returnDispatches === undefined ? g : { ...g, returnDispatches };
        }));
        return {
          status: 200,
          body: {
            receipts, count: ordered.length, needingApprovalCount: waiting.length,
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
