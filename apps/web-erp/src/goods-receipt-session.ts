// The goods-receipt REVIEW screen — a manager's read-only view of what came in the back door (M07-FR-02/03 ·
// D03 · API-04 · P-03 control-by-exception · P-08 no silent failure). Receiving itself is captured on the
// handheld, offline (§31); on sync each delivery becomes a durable GRN with a checked outcome. This screen
// changes nothing — it reads those GRNs and lays them out so a manager can see, at a glance, the deliveries
// that did NOT arrive as ordered and the ones that cannot be accepted without a second person:
//
//   • **Exceptions first** (P-03): a delivery needing a second person's approval (§28 — an over-tolerance
//     excess, expired/damaged/QC-failed/cold-chain-broken stock) is surfaced first; then the ones carrying a
//     valued discrepancy, worst money first; then the clean ones. The back door is where most stock is lost.
//   • **Every discrepancy is valued and named** (P-08): short, excess, damaged, expired, MRP-mismatch and the
//     rest each carry what they are worth and a plain-English detail — an exception with no value cannot be
//     prioritised, and one hidden cannot be chased.
//   • **Freshness is a fact on the page**: the list carries the moment it was read, and a page served from the
//     offline cache says so.
//
// Like every ERP screen the rules live here in a tested, DOM-free session model on the shared packages/ui
// primitives (colour is never the only signal — an icon and a word ride with every tone); the shell renders only
// what this hands over. It captures nothing and approves nothing (capture is the handheld's, and the §28 approval is a
// downstream action). Its ONE write (Batch 2) records that a quarantined line a second person already disposed of as a
// RETURN has physically gone back to the supplier — an online write under the reader's own session
// (`POST /v1/inventory/goods-receipt/:grnId/lines/:lineId/returned`, `inventory.movement.append`); it moves no stock (the
// held units were never on hand) and head office refuses a line not disposed of as a return. Hard rule #5 does not arise.
//
// OB-204 (owner, 18 Oct 2026, in writing): a return worth more than the e-way-bill threshold is DISPATCHED first, under a
// generated e-way bill (OB-194, `POST …/lines/:lineId/dispatch`, the same `inventory.movement.append`). The screen says
// where each such return stands — no e-way bill yet, waiting, generated with its number, dispatched — in head office's
// words (the list carries `returnDispatches`), offers Dispatch next to it, and offers "gone back" only once it has gone.
// A refusal (`ewb_required`) is said in plain words and the return stays undispatched; with no connection the screen says
// it needs one (P-08) — the dispatch is head office's record, so nothing is queued or pretended.
//
// R9-A · OB-534 (owner, 28 Oct 2026): a "Match the bill" button on each delivery with a line no supplier bill is matched to yet
// — the existing `POST /v1/inventory/goods-receipt/:grnId/bill-match` (`purchase.invoice.match`), body `{ invoiceId }` of a bill
// on head office's register (never a typed cost). It is refused for the person who RECEIVED the goods (§28 — said on the
// screen, and head office refuses it too), and the matched bill is shown afterwards: which bill, at what cost, by whom. An
// online write under the reader's session — with no connection the screen says it needs one; nothing is queued.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';
import type { DiscrepancyKind } from '../../../packages/receiving/src/index';
import { minorPerUnitOf, normaliseUom } from '../../../packages/contracts/src/quantity';

// ── what the screen was last told (the GRN list, one snapshot) ──────────────────────────────────────────────

/**
 * OB-508 (owner, 28 Oct 2026): whose a discrepancy is, as head office named it — the buyer who raised the order (short, excess,
 * cost difference) or the receiving store's managers (damaged, QC failed, expired, temperature). Nobody is ever filled in here:
 * an empty list comes with head office's reason (no order, no store manager named, a kind the decision names no owner for).
 */
export interface GrnDiscrepancyOwnerView {
  readonly role: 'buyer' | 'store_manager' | null;
  readonly owners: readonly string[];
  readonly missing?: 'no_purchase_order' | 'order_not_held' | 'no_store_manager_named' | 'owner_not_decided';
}

/** The kinds a receipt's difference can be: the capture engine's, (Round 6) a cost that differed from the order's, and
 *  (OB-528) a difference from the supplier's advance ship notice — per product, owned by the buyer. */
export type GrnDifferenceKind = DiscrepancyKind | 'cost_difference' | 'asn_difference';

/** One valued discrepancy on a delivery line — data, shown as-is. */
export interface GrnDiscrepancyView {
  readonly kind: GrnDifferenceKind;
  /** The receipt line it is on (head office's line id) — what its owner is matched by. */
  readonly lineId?: string;
  /** OB-509: the line's cost is not known yet, so this difference has no value yet — said, never ₹0. */
  readonly valueNotKnown?: boolean;
  /** OB-508: its named owner, when head office said (absent → head office did not say). */
  readonly owner?: GrnDiscrepancyOwnerView;
  readonly productId: string;
  /** Quantity affected, in the UOM's smallest unit (×100). */
  readonly quantityMinor: number;
  readonly valueMinor: number;
  readonly currency: string;
  /** True when this one cannot be accepted without a second person (§28). */
  readonly requiresApproval: boolean;
  /** The server's plain-English specifics, shown as-is. */
  readonly detail: string;
}

/** A committed goods receipt, with its checked outcome — one row on the review list. */
export interface GrnRecordView {
  readonly grnId: string;
  readonly number: string;
  /** The purchase order it was received against, or `null` for an unmatched (no-PO) delivery. */
  readonly poId: string | null;
  readonly warehouseId: string;
  readonly receivedBy: string;
  readonly receivedAt: string;
  /** True when at least one discrepancy needs a second person's approval (§28). */
  readonly requiresApproval: boolean;
  /** Total value of everything that did not arrive as ordered. */
  readonly discrepancyValueMinor: number;
  readonly currency: string;
  /** Quantity that became sellable stock (quarantine/rejected excluded). */
  readonly sellableMinor: number;
  readonly quarantinedMinor: number;
  readonly rejectedMinor: number;
  readonly discrepancies: readonly GrnDiscrepancyView[];
  /** Batch 2: the held lines a second person disposed of as a RETURN to the supplier, and whether each has gone back. */
  readonly returnLines?: readonly GrnReturnLineView[];
  /** OB-509: the lines booked with their cost NOT KNOWN that still wait for the supplier's bill. */
  readonly costNotKnown?: readonly { readonly lineId: string; readonly productId: string; readonly because: 'no_issued_order' | 'not_on_order' }[];
  /** OB-509: some difference has no value yet, so the total is incomplete. */
  readonly discrepancyValueIncomplete?: boolean;
  /** OB-534: the supplier bills matched to THIS receipt's lines (head office's `billCosts`), as head office holds them. */
  readonly billCosts?: readonly GrnBillCostView[];
  /** OB-534: how many of the receipt's lines no supplier bill is matched to yet (head office's lines less `billCosts`). */
  readonly unbilledLineCount?: number;
}

/** OB-534 — one receipt line costed from a matched supplier bill (OB-509 · OB-530), shown as-is. */
export interface GrnBillCostView {
  readonly lineId: string;
  readonly productId: string;
  readonly invoiceId: string;
  readonly unitCostMinor: number;
  readonly currency: string;
  readonly matchedBy: string;
  readonly matchedAt: string;
  /** OB-530: the line's cost was already known from the order — the bill is matched for the price comparison only. */
  readonly costWasKnown?: boolean;
}

/** OB-534 — what head office answered "Match the bill". */
export type BillMatchPostResult =
  | { readonly result: 'matched' | 'already_matched'; readonly matched: readonly GrnBillCostView[] }
  | { readonly result: 'self_match' | 'bill_unknown' | 'not_permitted' | 'refused'; readonly reason: string }
  | { readonly result: 'lost_link' };

/** OB-534 — the authenticated POST that matches a supplier bill to one receipt (body exactly `{ invoiceId }`). */
export interface GrnBillMatchPort {
  post(input: { readonly grnId: string; readonly invoiceId: string }): Promise<BillMatchPostResult>;
}

/** Batch 2 — one quarantined line disposed of as a return: waiting to go back to the supplier, or gone. */
export interface GrnReturnLineView {
  readonly lineId: string;
  readonly productId: string;
  /** In the line's smallest steps (OB-31: grams for kg). */
  readonly quantityMinor: number;
  readonly uom: string;
  readonly valueMinor: number;
  readonly currency: string;
  readonly decidedBy: string;
  readonly state: 'awaiting_return' | 'returned';
  readonly returnedBy: string | null;
  /** The receipt was assembled from handheld scans that may have put the held units on the shelf — count first (head office refuses). */
  readonly needsCount: boolean;
  /** OB-204: where the return stands on its dispatch, as head office said; absent when no dispatch step applies here. */
  readonly dispatch?: GrnReturnDispatchView;
  /** OB-509: the line's cost is not known, so its value is not known yet. */
  readonly valueNotKnown?: boolean;
}

/** OB-204 — head office's word on a return's dispatch (`returnDispatches` on the GRN list), shown as-is. */
export interface GrnReturnDispatchView {
  readonly state: 'not_required' | 'no_ewb' | 'ewb_waiting' | 'ewb_not_usable' | 'ewb_generated' | 'dispatched' | 'not_known';
  readonly movementId: string;
  readonly ewbNo: string | null;
  /** The e-way bill's own state on the register ('none' when never submitted), when head office named one. */
  readonly ewbState: string | null;
  /** Head office's plain-English reason. */
  readonly detail: string;
}

/** OB-204 — what head office answered a dispatch. */
export type LineDispatchPostResult =
  | { readonly result: 'dispatched' | 'already_dispatched'; readonly ewbNo: string | null }
  | { readonly result: 'ewb_required'; readonly reason: string }
  | { readonly result: 'refused'; readonly reason: string }
  | { readonly result: 'lost_link' };

/** OB-204 — the authenticated POST that a return's goods are leaving under their e-way bill (body `{ reason }`). */
export interface GrnLineDispatchPort {
  post(input: { readonly grnId: string; readonly lineId: string; readonly reason: string }): Promise<LineDispatchPostResult>;
}

export type LineReturnPostResult =
  | { readonly result: 'returned' | 'already_returned' | 'lost_link' }
  | { readonly result: 'refused'; readonly reason: string };

/** Batch 2 — the authenticated POST that a disposed line has physically gone back to the supplier (body `{ reason }`). */
export interface GrnLineReturnPort {
  post(input: { readonly grnId: string; readonly lineId: string; readonly reason: string }): Promise<LineReturnPostResult>;
}

/**
 * Everything the box last told this screen about receiving. `receipts` absent means the screen has not been
 * given the list yet (a different thing from an empty list, which means no deliveries have been recorded — only
 * one of those is a data gap).
 */
export interface GoodsReceiptData {
  readonly receipts?: readonly GrnRecordView[];
  /** When the list was read (ISO) — the overall "as of". */
  readonly asAt?: string;
}

export interface GoodsReceiptPorts {
  /** The GRN list the shell last read (live from the cloud, or the injected stand-in). */
  snapshot(): GoodsReceiptData;
  /** Whether this user may read receiving (`inventory.availability.read`). */
  mayRead(): boolean;
  /** Batch 2 · `inventory.movement.append` — recording a supplier return. Absent ⇒ not held. */
  mayRecordReturn?(): boolean;
  /** Batch 2 · the return write, or `null` / absent when this page cannot reach head office. */
  returnPort?(): GrnLineReturnPort | null;
  /** OB-204 · the dispatch write (the same `inventory.movement.append`), or `null` / absent when this page cannot reach head office. */
  dispatchPort?(): GrnLineDispatchPort | null;
  /** OB-534 · `purchase.invoice.match` — matching a supplier bill to a receipt. Absent ⇒ not held. */
  mayMatchBill?(): boolean;
  /** OB-534 · the bill-match write, or `null` / absent when this page cannot reach head office. */
  billMatchPort?(): GrnBillMatchPort | null;
}

export interface GoodsReceiptConfig {
  /** Who is looking. `null` means the box was not told who is at the screen (shown as a gentle note). */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen ────────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'listHeading' | 'asOfLabel' | 'refresh'
  | 'sigNeedsApproval' | 'sigDiscrepancies' | 'sigClean'
  | 'needsApprovalBadge' | 'noPo'
  | 'receivedByLabel' | 'warehouseLabel' | 'sellableLabel' | 'quarantinedLabel' | 'rejectedLabel'
  | 'discrepancyValueLabel' | 'summaryDeliveries' | 'summaryNeedApproval' | 'unitsWord'
  | 'dkShort' | 'dkExcess' | 'dkDamaged' | 'dkQcFailed' | 'dkExpired' | 'dkNearExpiry' | 'dkMrpMismatch' | 'dkTemperatureBreach' | 'dkTemperatureNotRecorded'
  | 'returnsHeading' | 'returnAwaiting' | 'returnGone' | 'returnNeedsCount' | 'returnChoiceLabel' | 'returnReasonLabel' | 'returnReasonPlaceholder' | 'returnBtn'
  | 'returnNoneWaiting' | 'returnRecorded' | 'returnAlready' | 'returnRefused' | 'returnLostLink' | 'returnNotPermitted' | 'returnNoLink' | 'returnLineUnknown'
  | 'returnNotAwaiting' | 'returnNeedsCountRefusal' | 'returnReasonMissing' | 'noReturn' | 'decidedByLabel' | 'returnedByLabel'
  | 'dispNoEwb' | 'dispWaiting' | 'dispNotUsable' | 'dispGenerated' | 'dispDispatched' | 'dispDispatchedNoEwb' | 'dispNotKnown'
  | 'dispatchBtn' | 'dispatchReasonLabel' | 'dispatchReasonPlaceholder' | 'dispatchDone' | 'dispatchDoneNoEwb' | 'dispatchAlready'
  | 'dispatchEwbRequired' | 'dispatchRefused' | 'dispatchLostLink' | 'dispatchNoLink' | 'dispatchNotPermitted' | 'dispatchLineUnknown'
  | 'dispatchNotNeeded' | 'dispatchReasonMissing' | 'returnNeedsDispatch' | 'returnWaitsForDispatch'
  | 'dkCostDifference' | 'dkAsnDifference' | 'ownerLabel' | 'ownerBuyer' | 'ownerStoreManager' | 'ownerNoPo' | 'ownerOrderNotHeld' | 'ownerNoStoreManager' | 'ownerNotDecided'
  | 'valueNotKnown' | 'valueIncomplete' | 'costNotKnownHeading' | 'costNotKnownNoOrder' | 'costNotKnownNotOnOrder'
  | 'scrReady' | 'scrEmpty' | 'scrNoReceipts' | 'stateNotPermitted'
  | 'billMatchHeading' | 'billMatchLabel' | 'billMatchPlaceholder' | 'billMatchBtn' | 'billMatchNotYou' | 'billMatchedLine' | 'billMatchedKnown'
  | 'billMatchDone' | 'billMatchAlready' | 'billMatchSelf' | 'billMatchUnknownBill' | 'billMatchRefused' | 'billMatchLostLink' | 'billMatchNoLink'
  | 'billMatchNotPermitted' | 'billMatchReceiptUnknown' | 'billMatchNothingWaiting' | 'billMatchInvoiceMissing'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const GOODS_RECEIPT_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Goods receipt review', langName: 'தமிழ்',
    lead: 'What came in the back door — read from the delivery records. Nothing is changed here. Deliveries needing a second person are at the top, then the ones with a valued difference from the order, then the clean ones, each with the time it was read.',
    listHeading: 'Deliveries', asOfLabel: 'As of', refresh: 'Refresh',
    sigNeedsApproval: 'Needs a second person to accept',
    sigDiscrepancies: 'Arrived differently from the order',
    sigClean: 'Received as ordered',
    needsApprovalBadge: 'Second person needed', noPo: 'No purchase order',
    receivedByLabel: 'Received by', warehouseLabel: 'Store/warehouse',
    sellableLabel: 'Became sellable', quarantinedLabel: 'Held back', rejectedLabel: 'Refused',
    discrepancyValueLabel: 'Value of the difference',
    summaryDeliveries: 'deliveries', summaryNeedApproval: 'need a second person', unitsWord: 'units',
    dkShort: 'Short — less arrived than ordered', dkExcess: 'Excess — more arrived than ordered',
    dkDamaged: 'Damaged', dkQcFailed: 'Failed quality check', dkExpired: 'Expired on arrival',
    dkNearExpiry: 'Close to its expiry date', dkMrpMismatch: 'Printed price differs from the master',
    dkTemperatureBreach: 'Cold chain broken (temperature)',
    dkTemperatureNotRecorded: 'Chilled or frozen — no temperature recorded (held for a check)',
    dkCostDifference: 'Cost typed at the door differs from the order (booked at the order’s cost)',
    dkAsnDifference: 'Differs from the supplier’s delivery note (ASN)',
    ownerLabel: 'Owner', ownerBuyer: 'the buyer who raised the order', ownerStoreManager: 'the store manager',
    ownerNoPo: 'No purchase order — no buyer named', ownerOrderNotHeld: 'The order is not on file — no buyer named',
    ownerNoStoreManager: 'No store manager named', ownerNotDecided: 'Owner not decided yet',
    valueNotKnown: 'Value not known — waiting for the supplier bill',
    valueIncomplete: 'Some differences have no value yet (cost not known)',
    costNotKnownHeading: 'Cost not known until the supplier bill is matched',
    costNotKnownNoOrder: 'no purchase order', costNotKnownNotOnOrder: 'not on the order',
    returnsHeading: 'Going back to the supplier', returnAwaiting: 'Waiting to go back to the supplier', returnGone: 'Gone back to the supplier',
    returnNeedsCount: 'Count it first — handheld scans may have put it on the shelf', returnChoiceLabel: 'Which held line went back',
    returnReasonLabel: 'How it went back', returnReasonPlaceholder: 'e.g. the supplier’s driver collected it, van KA-01', returnBtn: 'Record it as gone back',
    returnNoneWaiting: 'No held line is waiting to go back to a supplier.',
    returnRecorded: 'Recorded — the line has gone back to the supplier; its value is on the supplier’s debit note.', returnAlready: 'This line was already recorded as gone back.',
    returnRefused: 'Head office refused it:', returnLostLink: 'No connection — nothing was recorded. Try again.',
    returnNotPermitted: 'You do not have permission to record stock going back to a supplier.', returnNoLink: 'This page cannot reach head office, so nothing can be recorded from it.',
    returnLineUnknown: 'That line is not on the list.', returnNotAwaiting: 'That line is not waiting to go back (it was not disposed of as a return, or it already went).',
    returnNeedsCountRefusal: 'That receipt came from handheld scans that may have put the held stock on the shelf — count the line first (nothing was sent).',
    returnReasonMissing: 'Say how it went back (who collected it, or which van).',
    noReturn: 'You can see the deliveries, but recording a return to the supplier needs the stock-movement permission.',
    decidedByLabel: 'decided by', returnedByLabel: 'sent back by',
    dispNoEwb: 'Above the e-way-bill limit — no e-way bill yet, so it cannot leave',
    dispWaiting: 'E-way bill waiting — asked for, not generated yet',
    dispNotUsable: 'E-way bill rejected or cancelled — a new one is needed before it can leave',
    dispGenerated: 'E-way bill {no} generated — ready to dispatch',
    dispDispatched: 'Dispatched under e-way bill {no}', dispDispatchedNoEwb: 'Dispatched — no e-way bill was needed',
    dispNotKnown: 'E-way bill not known just now — head office could not say',
    dispatchBtn: 'Dispatch', dispatchReasonLabel: 'Who is taking it, which vehicle', dispatchReasonPlaceholder: 'e.g. supplier lorry TN-01-AB-1234',
    dispatchDone: 'Dispatched under e-way bill {no}. You can now record it as gone back.',
    dispatchDoneNoEwb: 'Dispatched — no e-way bill was needed. You can now record it as gone back.',
    dispatchAlready: 'This return was already dispatched. You can record it as gone back.',
    dispatchEwbRequired: 'Not dispatched — it needs a generated e-way bill first. Head office said:',
    dispatchRefused: 'Not dispatched — head office refused it:',
    dispatchLostLink: 'Needs connection — head office could not be reached, so nothing was dispatched. Try again when connected.',
    dispatchNoLink: 'Needs connection — this page cannot reach head office, so a dispatch cannot be recorded from it.',
    dispatchNotPermitted: 'You do not have permission to record goods leaving for a supplier.',
    dispatchLineUnknown: 'That return is not on the list.',
    dispatchNotNeeded: 'This return has no dispatch step to do (it is not above the e-way-bill limit, it already went, or it was already dispatched).',
    dispatchReasonMissing: 'Say who is taking it and which vehicle.',
    returnNeedsDispatch: 'Dispatch it first — it is above the e-way-bill limit, so it leaves only under a generated e-way bill.',
    returnWaitsForDispatch: 'Nothing can be recorded as gone back yet — a return above the e-way-bill limit is dispatched first (its Dispatch button is beside it above).',
    scrReady: 'Showing your deliveries', scrEmpty: 'This screen has not been given the delivery list yet.',
    scrNoReceipts: 'No deliveries have been recorded yet.',
    stateNotPermitted: 'You do not have permission to see goods receipts.',
    billMatchHeading: 'Supplier bill', billMatchLabel: 'Supplier bill number (as captured at head office)', billMatchPlaceholder: 'e.g. INV-2026-0412',
    billMatchBtn: 'Match the bill',
    billMatchNotYou: 'You received these goods, so someone else (the buyer or the accountant) matches their supplier bill.',
    billMatchedLine: 'Bill {bill} matched: {product} at {cost} each — by {who}', billMatchedKnown: '(cost already known from the order — matched to compare prices)',
    billMatchDone: 'Bill matched to this delivery. The lines it names now carry the bill’s cost.', billMatchAlready: 'This bill was already matched to this delivery.',
    billMatchSelf: 'Not matched — you received these goods, so someone else must match their bill. Head office said:',
    billMatchUnknownBill: 'Not matched — head office has no such supplier bill. Capture the bill first, then match it. Head office said:',
    billMatchRefused: 'Not matched — head office refused it:',
    billMatchLostLink: 'Needs connection — head office could not be reached, so nothing was matched. Try again when connected.',
    billMatchNoLink: 'Needs connection — this page cannot reach head office, so a bill cannot be matched from it.',
    billMatchNotPermitted: 'You do not have permission to match supplier bills.',
    billMatchReceiptUnknown: 'That delivery is not on the list.',
    billMatchNothingWaiting: 'Every line of this delivery already has its supplier bill matched.',
    billMatchInvoiceMissing: 'Write the supplier bill number.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'சரக்கு பெறுதல் மதிப்பாய்வு', langName: 'English',
    lead: 'பின் கதவு வழியாக வந்தவை — டெலிவரி பதிவுகளிலிருந்து வாசிக்கப்படுகிறது. இங்கே எதுவும் மாற்றப்படவில்லை. இரண்டாம் நபர் தேவைப்படும் டெலிவரிகள் மேலே, பிறகு ஆர்டரிலிருந்து மதிப்பு வேறுபாடு உள்ளவை, பிறகு சரியாக வந்தவை — ஒவ்வொன்றும் அது வாசிக்கப்பட்ட நேரத்துடன்.',
    listHeading: 'டெலிவரிகள்', asOfLabel: 'நிலவரம்', refresh: 'புதுப்பி',
    sigNeedsApproval: 'ஏற்க இரண்டாம் நபர் தேவை',
    sigDiscrepancies: 'ஆர்டரிலிருந்து வேறுபட்டு வந்தது',
    sigClean: 'ஆர்டர் செய்தபடி பெறப்பட்டது',
    needsApprovalBadge: 'இரண்டாம் நபர் தேவை', noPo: 'கொள்முதல் ஆர்டர் இல்லை',
    receivedByLabel: 'பெற்றவர்', warehouseLabel: 'கடை/கிடங்கு',
    sellableLabel: 'விற்பனைக்கு ஆனது', quarantinedLabel: 'தடுத்து வைக்கப்பட்டது', rejectedLabel: 'மறுக்கப்பட்டது',
    discrepancyValueLabel: 'வேறுபாட்டின் மதிப்பு',
    summaryDeliveries: 'டெலிவரிகள்', summaryNeedApproval: 'இரண்டாம் நபர் தேவை', unitsWord: 'அலகுகள்',
    dkShort: 'குறைவு — ஆர்டரை விட குறைவாக வந்தது', dkExcess: 'அதிகம் — ஆர்டரை விட அதிகமாக வந்தது',
    dkDamaged: 'சேதமடைந்தது', dkQcFailed: 'தர சோதனையில் தோல்வி', dkExpired: 'வந்தபோதே காலாவதி',
    dkNearExpiry: 'காலாவதி தேதி நெருங்கியது', dkMrpMismatch: 'அச்சிட்ட விலை மாஸ்டரிலிருந்து வேறுபடுகிறது',
    dkTemperatureBreach: 'குளிர்ச்சி சங்கிலி உடைந்தது (வெப்பநிலை)',
    dkTemperatureNotRecorded: 'குளிர்/உறைந்த பொருள் — வெப்பநிலை பதிவு செய்யப்படவில்லை (சரிபார்ப்புக்கு நிறுத்தப்பட்டது)',
    dkCostDifference: 'வாசலில் உள்ளிட்ட விலை ஆர்டரிலிருந்து வேறுபடுகிறது (ஆர்டர் விலையில் பதிவானது)',
    dkAsnDifference: 'சப்ளையரின் டெலிவரி அறிவிப்பிலிருந்து (ASN) வேறுபடுகிறது',
    ownerLabel: 'பொறுப்பாளர்', ownerBuyer: 'ஆர்டர் செய்த வாங்குநர்', ownerStoreManager: 'கடை மேலாளர்',
    ownerNoPo: 'கொள்முதல் ஆர்டர் இல்லை — வாங்குநர் பெயர் இல்லை', ownerOrderNotHeld: 'ஆர்டர் பதிவில் இல்லை — வாங்குநர் பெயர் இல்லை',
    ownerNoStoreManager: 'கடை மேலாளர் பெயரிடப்படவில்லை', ownerNotDecided: 'பொறுப்பாளர் இன்னும் முடிவாகவில்லை',
    valueNotKnown: 'மதிப்பு தெரியவில்லை — சப்ளையர் பில்லுக்காகக் காத்திருக்கிறது',
    valueIncomplete: 'சில வேறுபாடுகளுக்கு இன்னும் மதிப்பு இல்லை (விலை தெரியவில்லை)',
    costNotKnownHeading: 'சப்ளையர் பில் பொருத்தப்படும் வரை விலை தெரியாது',
    costNotKnownNoOrder: 'கொள்முதல் ஆர்டர் இல்லை', costNotKnownNotOnOrder: 'ஆர்டரில் இல்லை',
    returnsHeading: 'சப்ளையருக்குத் திரும்புபவை', returnAwaiting: 'சப்ளையருக்குத் திரும்பக் காத்திருக்கிறது', returnGone: 'சப்ளையருக்குத் திரும்பியது',
    returnNeedsCount: 'முதலில் எண்ணுங்கள் — கைக்கருவி ஸ்கேன்கள் அதை அடுக்கில் வைத்திருக்கலாம்', returnChoiceLabel: 'எந்தத் தடுத்த வரி திரும்பியது',
    returnReasonLabel: 'எப்படித் திரும்பியது', returnReasonPlaceholder: 'எ.கா. சப்ளையரின் ஓட்டுநர் எடுத்துச் சென்றார், வண்டி KA-01', returnBtn: 'திரும்பியதாகப் பதிவு செய்',
    returnNoneWaiting: 'சப்ளையருக்குத் திரும்ப எந்தத் தடுத்த வரியும் காத்திருக்கவில்லை.',
    returnRecorded: 'பதிவாகியது — வரி சப்ளையருக்குத் திரும்பியது; அதன் மதிப்பு சப்ளையரின் டெபிட் நோட்டில் உள்ளது.', returnAlready: 'இந்த வரி ஏற்கனவே திரும்பியதாகப் பதிவாகியுள்ளது.',
    returnRefused: 'தலைமை அலுவலகம் மறுத்தது:', returnLostLink: 'இணைப்பு இல்லை — எதுவும் பதிவாகவில்லை. மீண்டும் முயற்சிக்கவும்.',
    returnNotPermitted: 'சப்ளையருக்குச் சரக்கு திரும்புவதைப் பதிவு செய்ய உங்களுக்கு அனுமதி இல்லை.', returnNoLink: 'இந்தப் பக்கம் தலைமை அலுவலகத்தை அடைய முடியாது, அதனால் இங்கிருந்து பதிவு செய்ய முடியாது.',
    returnLineUnknown: 'அந்த வரி பட்டியலில் இல்லை.', returnNotAwaiting: 'அந்த வரி திரும்பக் காத்திருக்கவில்லை (திருப்பி அனுப்ப முடிவு செய்யப்படவில்லை, அல்லது ஏற்கனவே சென்றது).',
    returnNeedsCountRefusal: 'அந்தப் பெறுதல் கைக்கருவி ஸ்கேன்களிலிருந்து வந்தது; தடுத்த சரக்கு அடுக்கில் இருக்கலாம் — முதலில் வரியை எண்ணுங்கள் (எதுவும் அனுப்பப்படவில்லை).',
    returnReasonMissing: 'எப்படித் திரும்பியது என்று சொல்லுங்கள் (யார் எடுத்துச் சென்றார், அல்லது எந்த வண்டி).',
    noReturn: 'டெலிவரிகளைப் பார்க்கலாம், ஆனால் சப்ளையருக்குத் திரும்புவதைப் பதிவு செய்ய சரக்கு நகர்வு அனுமதி தேவை.',
    decidedByLabel: 'முடிவு செய்தவர்', returnedByLabel: 'திருப்பி அனுப்பியவர்',
    dispNoEwb: 'இ-வே பில் வரம்பை மீறுகிறது — இன்னும் இ-வே பில் இல்லை, அதனால் வெளியே செல்ல முடியாது',
    dispWaiting: 'இ-வே பில் காத்திருக்கிறது — கேட்கப்பட்டது, இன்னும் உருவாகவில்லை',
    dispNotUsable: 'இ-வே பில் நிராகரிக்கப்பட்டது அல்லது ரத்து — வெளியே செல்ல புதியது தேவை',
    dispGenerated: 'இ-வே பில் {no} உருவானது — அனுப்பத் தயார்',
    dispDispatched: 'இ-வே பில் {no} உடன் அனுப்பப்பட்டது', dispDispatchedNoEwb: 'அனுப்பப்பட்டது — இ-வே பில் தேவைப்படவில்லை',
    dispNotKnown: 'இ-வே பில் நிலை இப்போது தெரியவில்லை — தலைமை அலுவலகம் சொல்ல முடியவில்லை',
    dispatchBtn: 'அனுப்பு', dispatchReasonLabel: 'யார் எடுத்துச் செல்கிறார், எந்த வண்டி', dispatchReasonPlaceholder: 'எ.கா. சப்ளையர் லாரி TN-01-AB-1234',
    dispatchDone: 'இ-வே பில் {no} உடன் அனுப்பப்பட்டது. இப்போது திரும்பியதாகப் பதிவு செய்யலாம்.',
    dispatchDoneNoEwb: 'அனுப்பப்பட்டது — இ-வே பில் தேவைப்படவில்லை. இப்போது திரும்பியதாகப் பதிவு செய்யலாம்.',
    dispatchAlready: 'இந்தத் திருப்பம் ஏற்கனவே அனுப்பப்பட்டது. திரும்பியதாகப் பதிவு செய்யலாம்.',
    dispatchEwbRequired: 'அனுப்பப்படவில்லை — முதலில் உருவான இ-வே பில் தேவை. தலைமை அலுவலகம் சொன்னது:',
    dispatchRefused: 'அனுப்பப்படவில்லை — தலைமை அலுவலகம் மறுத்தது:',
    dispatchLostLink: 'இணைப்பு தேவை — தலைமை அலுவலகத்தை அடைய முடியவில்லை, அதனால் எதுவும் அனுப்பப்படவில்லை. இணைந்ததும் மீண்டும் முயற்சிக்கவும்.',
    dispatchNoLink: 'இணைப்பு தேவை — இந்தப் பக்கம் தலைமை அலுவலகத்தை அடைய முடியாது, அதனால் இங்கிருந்து அனுப்புதலைப் பதிவு செய்ய முடியாது.',
    dispatchNotPermitted: 'சப்ளையருக்குச் சரக்கு அனுப்புவதைப் பதிவு செய்ய உங்களுக்கு அனுமதி இல்லை.',
    dispatchLineUnknown: 'அந்தத் திருப்பம் பட்டியலில் இல்லை.',
    dispatchNotNeeded: 'இந்தத் திருப்பத்திற்கு அனுப்பும் படி எதுவும் இல்லை (இ-வே பில் வரம்பை மீறவில்லை, ஏற்கனவே சென்றது, அல்லது ஏற்கனவே அனுப்பப்பட்டது).',
    dispatchReasonMissing: 'யார் எடுத்துச் செல்கிறார், எந்த வண்டி என்று சொல்லுங்கள்.',
    returnNeedsDispatch: 'முதலில் அனுப்புங்கள் — இது இ-வே பில் வரம்பை மீறுகிறது, அதனால் உருவான இ-வே பில்லுடன் மட்டுமே செல்லும்.',
    returnWaitsForDispatch: 'இன்னும் எதையும் திரும்பியதாகப் பதிவு செய்ய முடியாது — இ-வே பில் வரம்பை மீறும் திருப்பம் முதலில் அனுப்பப்பட வேண்டும் (அதன் அனுப்பு பொத்தான் மேலே அதன் அருகில் உள்ளது).',
    scrReady: 'உங்கள் டெலிவரிகளைக் காட்டுகிறது', scrEmpty: 'இந்தத் திரைக்கு இன்னும் டெலிவரி பட்டியல் தரப்படவில்லை.',
    scrNoReceipts: 'இன்னும் டெலிவரிகள் எதுவும் பதிவு செய்யப்படவில்லை.',
    stateNotPermitted: 'சரக்கு பெறுதல்களைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    billMatchHeading: 'சப்ளையர் பில்', billMatchLabel: 'சப்ளையர் பில் எண் (தலைமை அலுவலகத்தில் பதிந்தபடி)', billMatchPlaceholder: 'எ.கா. INV-2026-0412',
    billMatchBtn: 'பில்லைப் பொருத்து',
    billMatchNotYou: 'இந்தச் சரக்கை நீங்கள் பெற்றீர்கள், எனவே அதன் சப்ளையர் பில்லை வேறொருவர் (வாங்குநர் அல்லது கணக்காளர்) பொருத்த வேண்டும்.',
    billMatchedLine: 'பில் {bill} பொருத்தப்பட்டது: {product} ஒன்றுக்கு {cost} — பொருத்தியவர் {who}', billMatchedKnown: '(விலை ஆர்டரிலிருந்தே தெரியும் — விலை ஒப்பிடப் பொருத்தப்பட்டது)',
    billMatchDone: 'இந்த டெலிவரிக்கு பில் பொருத்தப்பட்டது. பில்லில் உள்ள வரிகள் இப்போது பில்லின் விலையைக் கொண்டுள்ளன.', billMatchAlready: 'இந்த பில் ஏற்கனவே இந்த டெலிவரிக்குப் பொருத்தப்பட்டுள்ளது.',
    billMatchSelf: 'பொருத்தப்படவில்லை — இந்தச் சரக்கை நீங்கள் பெற்றீர்கள், எனவே வேறொருவர் பில்லைப் பொருத்த வேண்டும். தலைமை அலுவலகம் சொன்னது:',
    billMatchUnknownBill: 'பொருத்தப்படவில்லை — அப்படி ஒரு சப்ளையர் பில் தலைமை அலுவலகத்தில் இல்லை. முதலில் பில்லைப் பதிந்து, பிறகு பொருத்தவும். தலைமை அலுவலகம் சொன்னது:',
    billMatchRefused: 'பொருத்தப்படவில்லை — தலைமை அலுவலகம் மறுத்தது:',
    billMatchLostLink: 'இணைப்பு தேவை — தலைமை அலுவலகத்தை அடைய முடியவில்லை, அதனால் எதுவும் பொருத்தப்படவில்லை. இணைந்ததும் மீண்டும் முயற்சிக்கவும்.',
    billMatchNoLink: 'இணைப்பு தேவை — இந்தப் பக்கம் தலைமை அலுவலகத்தை அடைய முடியாது, அதனால் இங்கிருந்து பில்லைப் பொருத்த முடியாது.',
    billMatchNotPermitted: 'சப்ளையர் பில்களைப் பொருத்த உங்களுக்கு அனுமதி இல்லை.',
    billMatchReceiptUnknown: 'அந்த டெலிவரி பட்டியலில் இல்லை.',
    billMatchNothingWaiting: 'இந்த டெலிவரியின் ஒவ்வொரு வரிக்கும் ஏற்கனவே சப்ளையர் பில் பொருத்தப்பட்டுள்ளது.',
    billMatchInvoiceMissing: 'சப்ளையர் பில் எண்ணை எழுதுங்கள்.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(GOODS_RECEIPT_COPY.en) as CopyKey[]);

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

const DISCREPANCY_COPY: Readonly<Record<GrnDifferenceKind, CopyKey>> = Object.freeze({
  short: 'dkShort', excess: 'dkExcess', damaged: 'dkDamaged', qc_failed: 'dkQcFailed',
  expired: 'dkExpired', near_expiry: 'dkNearExpiry', mrp_mismatch: 'dkMrpMismatch', temperature_breach: 'dkTemperatureBreach', temperature_not_recorded: 'dkTemperatureNotRecorded',
  cost_difference: 'dkCostDifference', asn_difference: 'dkAsnDifference',
});

const OWNER_MISSING_COPY: Readonly<Record<NonNullable<GrnDiscrepancyOwnerView['missing']>, CopyKey>> = Object.freeze({
  no_purchase_order: 'ownerNoPo', order_not_held: 'ownerOrderNotHeld', no_store_manager_named: 'ownerNoStoreManager', owner_not_decided: 'ownerNotDecided',
});

/** OB-508: the owner in words — the named people and their role, or head office's reason nobody is named. Never invented. */
export function ownerWords(lang: Lang, owner: GrnDiscrepancyOwnerView | undefined): string | null {
  if (owner === undefined) return null;
  const t = translator(GOODS_RECEIPT_COPY, lang);
  if (owner.owners.length === 0) return `${t('ownerLabel')}: ${t(owner.missing === undefined ? 'ownerNotDecided' : OWNER_MISSING_COPY[owner.missing])}`;
  const role = owner.role === 'buyer' ? t('ownerBuyer') : owner.role === 'store_manager' ? t('ownerStoreManager') : '';
  return `${t('ownerLabel')}: ${owner.owners.join(', ')}${role === '' ? '' : ` (${role})`}`;
}

export interface PresentedDiscrepancy {
  readonly kind: GrnDifferenceKind;
  /** OB-508: the owner in words (or why nobody is named); null when head office did not say. */
  readonly ownerLabel: string | null;
  /** True when the line's cost is not known yet: the value is shown as "not known", never ₹0 (OB-509). */
  readonly valueNotKnown: boolean;
  readonly label: string;
  readonly productId: string;
  readonly quantityMinor: number;
  readonly valueMinor: number;
  readonly currency: string;
  readonly requiresApproval: boolean;
  readonly detail: string;
}

export interface PresentedReceipt {
  readonly status: StatusPresentation;
  readonly grnId: string;
  readonly number: string;
  readonly poId: string | null;
  readonly warehouseId: string;
  readonly receivedBy: string;
  readonly receivedAt: string;
  readonly needsApproval: boolean;
  readonly discrepancyValueMinor: number;
  readonly currency: string;
  readonly sellableMinor: number;
  readonly quarantinedMinor: number;
  readonly rejectedMinor: number;
  readonly discrepancies: readonly PresentedDiscrepancy[];
  /** Batch 2: the disposed-for-return lines, each with its state in words and its quantity in the line's unit. */
  readonly returnLines: readonly PresentedReturnLine[];
  /** OB-509: the lines whose cost waits for the supplier's bill, in words. */
  readonly costNotKnown: readonly { readonly productId: string; readonly label: string }[];
  /** OB-509: some difference has no value yet — the total is said to be incomplete. */
  readonly valueIncomplete: boolean;
  /** OB-534: the supplier bill(s) matched to this receipt, each line in words; and whether this reader may match one now. */
  readonly billMatch: {
    readonly matched: readonly { readonly invoiceId: string; readonly label: string }[];
    /** A line still waits for its bill and this reader may press "Match the bill" (holds the right, has a link, did not receive it). */
    readonly canMatch: boolean;
    /** A line still waits, this reader holds the right, but RECEIVED these goods — the screen says someone else matches it. */
    readonly receivedByYou: boolean;
  };
}

export interface PresentedReturnLine extends GrnReturnLineView {
  readonly stateLabel: string;
  /** The quantity for a person: whole items, or kg / litres with their decimals (OB-31). */
  readonly quantityLabel: string;
  /** OB-204: the dispatch state in words and a tone, or null when this return has no dispatch step. */
  readonly dispatchState: { readonly label: string; readonly tone: DispatchTone; readonly detail: string } | null;
  /** OB-204: it is above the threshold and has not been dispatched — "gone back" waits for the dispatch. */
  readonly needsDispatch: boolean;
  /** OB-204: this reader may press Dispatch for it from here, now. */
  readonly canDispatch: boolean;
}

/** The shared icon set's tones (sreIcon): a word always rides with it. */
export type DispatchTone = 'ok' | 'pending' | 'degraded' | 'error' | 'unknown';

export interface GoodsReceiptView {
  readonly screenState: StatusPresentation;
  readonly asOf: string | null;
  /** Worst-first deliveries — this is the primary list the shell renders. */
  readonly receipts: readonly PresentedReceipt[];
  readonly count: number;
  readonly needingApprovalCount: number;
  readonly nobodyNamed: boolean;
  /** Batch 2: this reader may record a line as gone back to the supplier from here. */
  readonly canRecordReturn: boolean;
  /** Batch 2: the lines waiting to go back that this reader may record (not those needing a count first). */
  readonly awaitingReturn: readonly { readonly grnId: string; readonly number: string; readonly line: PresentedReturnLine }[];
}

export type LineReturnOutcome =
  | { readonly outcome: 'returned' | 'already_returned' | 'lost_link' | 'not_permitted' | 'no_link' | 'line_unknown' | 'not_awaiting' | 'needs_count' | 'reason_missing' | 'needs_dispatch' }
  | { readonly outcome: 'refused'; readonly reason: string };

export type BillMatchOutcome =
  | { readonly outcome: 'matched' | 'already_matched'; readonly matched: readonly GrnBillCostView[] }
  | { readonly outcome: 'self_match' | 'bill_unknown' | 'refused'; readonly reason: string }
  | { readonly outcome: 'lost_link' | 'no_link' | 'not_permitted' | 'receipt_unknown' | 'nothing_waiting' | 'invoice_missing' | 'received_by_you' };

export type LineDispatchOutcome =
  | { readonly outcome: 'dispatched' | 'already_dispatched'; readonly ewbNo: string | null }
  | { readonly outcome: 'ewb_required' | 'refused'; readonly reason: string }
  | { readonly outcome: 'lost_link' | 'no_link' | 'not_permitted' | 'line_unknown' | 'not_needed' | 'needs_count' | 'reason_missing' };

export interface GoodsReceiptSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): GoodsReceiptView;
  /** Batch 2 — record that a disposed line has gone back to the supplier: an online write under the reader's session. */
  recordReturn(input: { readonly grnId: string; readonly lineId: string; readonly reason: string }): Promise<LineReturnOutcome>;
  presentReturnOutcome(lang: Lang, outcome: LineReturnOutcome): StatusPresentation;
  /** OB-204 — record that a return's goods are leaving under their e-way bill: an online write under the reader's session. */
  dispatchReturn(input: { readonly grnId: string; readonly lineId: string; readonly reason: string }): Promise<LineDispatchOutcome>;
  presentDispatchOutcome(lang: Lang, outcome: LineDispatchOutcome): StatusPresentation;
  /** OB-534 — match a supplier bill to one receipt: an online write under the reader's session; refused for the receiver. */
  matchBill(input: { readonly grnId: string; readonly invoiceId: string }): Promise<BillMatchOutcome>;
  presentBillMatchOutcome(lang: Lang, outcome: BillMatchOutcome): StatusPresentation;
}

/** OB-204: a return above the threshold that has not been dispatched (or whose state head office could not say). */
const PENDING_DISPATCH: ReadonlySet<GrnReturnDispatchView['state']> = new Set(['no_ewb', 'ewb_waiting', 'ewb_not_usable', 'ewb_generated', 'not_known']);
const DISPATCH_WORDS: Readonly<Record<Exclude<GrnReturnDispatchView['state'], 'not_required'>, { readonly key: CopyKey; readonly tone: DispatchTone }>> = Object.freeze({
  no_ewb: { key: 'dispNoEwb', tone: 'error' },
  ewb_waiting: { key: 'dispWaiting', tone: 'pending' },
  ewb_not_usable: { key: 'dispNotUsable', tone: 'error' },
  ewb_generated: { key: 'dispGenerated', tone: 'ok' },
  dispatched: { key: 'dispDispatched', tone: 'ok' },
  not_known: { key: 'dispNotKnown', tone: 'unknown' },
});

/** OB-31: a quantity in its smallest steps → what a person reads (12 items; 2.5 kg). */
export function quantityForPerson(quantityMinor: number, uom: string): string {
  const code = normaliseUom(uom) ?? uom;
  const per = minorPerUnitOf(code);
  if (per === 1) return `${quantityMinor} ${code}`;
  return `${(quantityMinor / per).toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${code}`;
}

export function createGoodsReceiptSession(config: GoodsReceiptConfig, ports: GoodsReceiptPorts): GoodsReceiptSession {
  const text = (lang: Lang, key: CopyKey): string => translator(GOODS_RECEIPT_COPY, lang)(key);
  const canRecordReturn = (): boolean => config.userId !== null && ports.mayRead() && (ports.mayRecordReturn?.() ?? false) && (ports.returnPort?.() ?? null) !== null;
  const mayDispatch = (): boolean => config.userId !== null && ports.mayRead() && (ports.mayRecordReturn?.() ?? false);
  const canDispatch = (): boolean => mayDispatch() && (ports.dispatchPort?.() ?? null) !== null;
  // OB-204: a dispatch head office accepted on this screen stands until the list is read again (which then carries it).
  const dispatchedHere = new Map<string, string | null>();
  const dispatchOf = (grnId: string, l: GrnReturnLineView): GrnReturnDispatchView | undefined => {
    const here = dispatchedHere.get(`${grnId}|${l.lineId}`);
    if (here === undefined || l.dispatch === undefined) return l.dispatch;
    return { ...l.dispatch, state: 'dispatched', ewbNo: here, detail: '' };
  };
  const needsDispatchOf = (d: GrnReturnDispatchView | undefined, l: GrnReturnLineView): boolean => l.state === 'awaiting_return' && d !== undefined && PENDING_DISPATCH.has(d.state);
  const presentReturnLine = (lang: Lang, grnId: string, raw: GrnReturnLineView): PresentedReturnLine => {
    const t = translator(GOODS_RECEIPT_COPY, lang);
    const d = dispatchOf(grnId, raw);
    const l: GrnReturnLineView = d === undefined ? raw : { ...raw, dispatch: d };
    const words = d === undefined || d.state === 'not_required' || (d.state !== 'dispatched' && l.state !== 'awaiting_return') ? null : DISPATCH_WORDS[d.state];
    const label = words === null || d === undefined ? '' : d.state === 'dispatched' && d.ewbNo === null ? t('dispDispatchedNoEwb') : t(words.key).replace('{no}', d.ewbNo ?? '');
    const needsDispatch = needsDispatchOf(d, l);
    return {
      ...l, stateLabel: t(l.state === 'returned' ? 'returnGone' : l.needsCount ? 'returnNeedsCount' : 'returnAwaiting'), quantityLabel: quantityForPerson(l.quantityMinor, l.uom),
      dispatchState: words === null || d === undefined ? null : { label, tone: words.tone, detail: d.detail },
      needsDispatch, canDispatch: needsDispatch && !l.needsCount && canDispatch(),
    };
  };
  const noWrites = { canRecordReturn: false, awaitingReturn: [] } as const;
  // OB-534: a bill head office matched on this screen shows at once (until the list is read again, which then carries it).
  const matchedHere = new Map<string, GrnBillCostView[]>();
  const mayMatchBill = (): boolean => config.userId !== null && ports.mayRead() && (ports.mayMatchBill?.() ?? false);
  const billCostsOf = (g: GrnRecordView): GrnBillCostView[] => {
    const here = matchedHere.get(g.grnId) ?? [];
    const all = [...(g.billCosts ?? [])];
    for (const m of here) if (!all.some((b) => b.lineId === m.lineId)) all.push(m);
    return all;
  };
  const unbilledOf = (g: GrnRecordView): number => {
    const extra = (matchedHere.get(g.grnId) ?? []).filter((m) => !(g.billCosts ?? []).some((b) => b.lineId === m.lineId)).length;
    return Math.max(0, (g.unbilledLineCount ?? 0) - extra);
  };
  const money = (minor: number, currency: string): string => `${currency === 'INR' ? '₹' : `${currency} `}${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return {
    text,

    recordReturn: async (input) => {
      if (!canRecordReturn()) return { outcome: (ports.returnPort?.() ?? null) === null && (ports.mayRecordReturn?.() ?? false) && config.userId !== null ? 'no_link' : 'not_permitted' };
      const grn = (ports.snapshot().receipts ?? []).find((g) => g.grnId === input.grnId.trim());
      const line = grn?.returnLines?.find((l) => l.lineId === input.lineId.trim());
      if (grn === undefined || line === undefined) return { outcome: 'line_unknown' };
      if (line.state !== 'awaiting_return') return { outcome: 'not_awaiting' };
      if (line.needsCount) return { outcome: 'needs_count' };
      if (needsDispatchOf(dispatchOf(grn.grnId, line), line)) return { outcome: 'needs_dispatch' };
      const reason = input.reason.trim();
      if (reason.length < 3) return { outcome: 'reason_missing' };
      const posted = await ports.returnPort!()!.post({ grnId: grn.grnId, lineId: line.lineId, reason });
      if (posted.result === 'refused') return { outcome: 'refused', reason: posted.reason };
      return { outcome: posted.result };
    },

    presentReturnOutcome: (lang, o) => {
      const t = translator(GOODS_RECEIPT_COPY, lang);
      const err = (key: CopyKey) => presentStatus({ tone: 'error', icon: '✕', label: t(key), needsAttention: true });
      switch (o.outcome) {
        case 'returned': return presentStatus({ tone: 'ok', icon: '✓', label: t('returnRecorded'), needsAttention: false });
        case 'already_returned': return presentStatus({ tone: 'ok', icon: '✓', label: t('returnAlready'), needsAttention: false });
        case 'lost_link': return presentStatus({ tone: 'degraded', icon: '⚠', label: t('returnLostLink'), needsAttention: true });
        case 'no_link': return presentStatus({ tone: 'degraded', icon: '⚠', label: t('returnNoLink'), needsAttention: true });
        case 'refused': return presentStatus({ tone: 'error', icon: '✕', label: `${t('returnRefused')} ${o.reason}`, needsAttention: true });
        case 'not_permitted': return err('returnNotPermitted');
        case 'line_unknown': return err('returnLineUnknown');
        case 'not_awaiting': return err('returnNotAwaiting');
        case 'needs_count': return err('returnNeedsCountRefusal');
        case 'reason_missing': return err('returnReasonMissing');
        case 'needs_dispatch': return err('returnNeedsDispatch');
      }
    },

    dispatchReturn: async (input) => {
      if (!mayDispatch()) return { outcome: 'not_permitted' };
      const port = ports.dispatchPort?.() ?? null;
      if (port === null) return { outcome: 'no_link' };
      const grn = (ports.snapshot().receipts ?? []).find((g) => g.grnId === input.grnId.trim());
      const line = grn?.returnLines?.find((l) => l.lineId === input.lineId.trim());
      if (grn === undefined || line === undefined) return { outcome: 'line_unknown' };
      if (!needsDispatchOf(dispatchOf(grn.grnId, line), line)) return { outcome: 'not_needed' };
      if (line.needsCount) return { outcome: 'needs_count' };
      const reason = input.reason.trim();
      if (reason.length < 3) return { outcome: 'reason_missing' };
      const posted = await port.post({ grnId: grn.grnId, lineId: line.lineId, reason });
      if ('ewbNo' in posted) {
        dispatchedHere.set(`${grn.grnId}|${line.lineId}`, posted.ewbNo);
        return { outcome: posted.result, ewbNo: posted.ewbNo };
      }
      if ('reason' in posted) return { outcome: posted.result, reason: posted.reason };
      return { outcome: 'lost_link' };
    },

    matchBill: async (input) => {
      if (!mayMatchBill()) return { outcome: 'not_permitted' };
      const port = ports.billMatchPort?.() ?? null;
      if (port === null) return { outcome: 'no_link' };
      const grn = (ports.snapshot().receipts ?? []).find((g) => g.grnId === input.grnId.trim());
      if (grn === undefined) return { outcome: 'receipt_unknown' };
      // §28: the person who received the goods never matches their bill — said here; head office refuses it too.
      if (grn.receivedBy === config.userId) return { outcome: 'received_by_you' };
      if (unbilledOf(grn) === 0) return { outcome: 'nothing_waiting' };
      const invoiceId = input.invoiceId.trim();
      if (invoiceId === '') return { outcome: 'invoice_missing' };
      const posted = await port.post({ grnId: grn.grnId, invoiceId });
      if ('matched' in posted) {
        const got = posted.matched;
        matchedHere.set(grn.grnId, [...(matchedHere.get(grn.grnId) ?? []).filter((m) => !got.some((p) => p.lineId === m.lineId)), ...got]);
        return { outcome: posted.result, matched: got };
      }
      if (!('reason' in posted)) return { outcome: 'lost_link' };
      if (posted.result === 'not_permitted') return { outcome: 'not_permitted' };
      return { outcome: posted.result, reason: posted.reason };
    },

    presentBillMatchOutcome: (lang, o) => {
      const t = translator(GOODS_RECEIPT_COPY, lang);
      const err = (key: CopyKey) => presentStatus({ tone: 'error', icon: '✕', label: t(key), needsAttention: true });
      switch (o.outcome) {
        case 'matched': return presentStatus({ tone: 'ok', icon: '✓', label: t('billMatchDone'), needsAttention: false });
        case 'already_matched': return presentStatus({ tone: 'ok', icon: '✓', label: t('billMatchAlready'), needsAttention: false });
        case 'self_match': return presentStatus({ tone: 'error', icon: '✕', label: `${t('billMatchSelf')} ${o.reason}`, needsAttention: true });
        case 'bill_unknown': return presentStatus({ tone: 'error', icon: '✕', label: `${t('billMatchUnknownBill')} ${o.reason}`, needsAttention: true });
        case 'refused': return presentStatus({ tone: 'error', icon: '✕', label: `${t('billMatchRefused')} ${o.reason}`, needsAttention: true });
        case 'lost_link': return presentStatus({ tone: 'degraded', icon: '⚠', label: t('billMatchLostLink'), needsAttention: true });
        case 'no_link': return presentStatus({ tone: 'degraded', icon: '⚠', label: t('billMatchNoLink'), needsAttention: true });
        case 'not_permitted': return err('billMatchNotPermitted');
        case 'receipt_unknown': return err('billMatchReceiptUnknown');
        case 'nothing_waiting': return err('billMatchNothingWaiting');
        case 'invoice_missing': return err('billMatchInvoiceMissing');
        case 'received_by_you': return err('billMatchNotYou');
      }
    },

    presentDispatchOutcome: (lang, o) => {
      const t = translator(GOODS_RECEIPT_COPY, lang);
      const err = (key: CopyKey) => presentStatus({ tone: 'error', icon: '✕', label: t(key), needsAttention: true });
      switch (o.outcome) {
        case 'dispatched': return presentStatus({ tone: 'ok', icon: '✓', label: o.ewbNo === null ? t('dispatchDoneNoEwb') : t('dispatchDone').replace('{no}', o.ewbNo), needsAttention: false });
        case 'already_dispatched': return presentStatus({ tone: 'ok', icon: '✓', label: t('dispatchAlready'), needsAttention: false });
        case 'ewb_required': return presentStatus({ tone: 'error', icon: '✕', label: `${t('dispatchEwbRequired')} ${o.reason}`, needsAttention: true });
        case 'refused': return presentStatus({ tone: 'error', icon: '✕', label: `${t('dispatchRefused')} ${o.reason}`, needsAttention: true });
        case 'lost_link': return presentStatus({ tone: 'degraded', icon: '⚠', label: t('dispatchLostLink'), needsAttention: true });
        case 'no_link': return presentStatus({ tone: 'degraded', icon: '⚠', label: t('dispatchNoLink'), needsAttention: true });
        case 'not_permitted': return err('dispatchNotPermitted');
        case 'line_unknown': return err('dispatchLineUnknown');
        case 'not_needed': return err('dispatchNotNeeded');
        case 'needs_count': return err('returnNeedsCountRefusal');
        case 'reason_missing': return err('dispatchReasonMissing');
      }
    },

    view: (lang) => {
      const t = translator(GOODS_RECEIPT_COPY, lang);
      const nobodyNamed = config.userId === null;

      if (!ports.mayRead()) {
        return {
          screenState: presentScreenState({ state: 'error', label: t('stateNotPermitted') }),
          asOf: null, receipts: [], count: 0, needingApprovalCount: 0, nobodyNamed, ...noWrites,
        };
      }

      const data = ports.snapshot();
      if (data.receipts === undefined) {
        return {
          screenState: presentScreenState({ state: 'empty', label: t('scrEmpty') }),
          asOf: null, receipts: [], count: 0, needingApprovalCount: 0, nobodyNamed, canRecordReturn: canRecordReturn(), awaitingReturn: [],
        };
      }
      if (data.receipts.length === 0) {
        return {
          screenState: presentScreenState({ state: 'empty', label: t('scrNoReceipts') }),
          asOf: data.asAt ?? null, receipts: [], count: 0, needingApprovalCount: 0, nobodyNamed, canRecordReturn: canRecordReturn(), awaitingReturn: [],
        };
      }

      // Worst-first: needs-a-second-person before everything (§28, P-03), then by the value of the difference,
      // then most recently received. A deterministic order this screen owns — never trusting the wire's order.
      const ordered = data.receipts.slice().sort((a, b) =>
        (a.requiresApproval === b.requiresApproval ? 0 : a.requiresApproval ? -1 : 1)
        || (b.discrepancyValueMinor - a.discrepancyValueMinor)
        || b.receivedAt.localeCompare(a.receivedAt));

      const receipts: PresentedReceipt[] = ordered.map((g) => {
        const status = g.requiresApproval
          ? presentStatus({ tone: 'error', icon: '⚠', label: t('sigNeedsApproval'), announcement: `${t('sigNeedsApproval')}: ${g.number}`, needsAttention: true })
          : g.discrepancies.length > 0
            ? presentStatus({ tone: 'degraded', icon: '❗', label: t('sigDiscrepancies'), announcement: `${t('sigDiscrepancies')}: ${g.number}`, needsAttention: true })
            : presentStatus({ tone: 'ok', icon: '✓', label: t('sigClean'), announcement: `${t('sigClean')}: ${g.number}`, needsAttention: false });
        const discrepancies: PresentedDiscrepancy[] = g.discrepancies
          .slice()
          .sort((x, y) => y.valueMinor - x.valueMinor)
          .map((d) => ({
            kind: d.kind, label: t(DISCREPANCY_COPY[d.kind] ?? 'dkShort'),
            productId: d.productId, quantityMinor: d.quantityMinor, valueMinor: d.valueMinor, currency: d.currency,
            requiresApproval: d.requiresApproval, detail: d.detail,
            ownerLabel: ownerWords(lang, d.owner), valueNotKnown: d.valueNotKnown === true,
          }));
        return {
          status, grnId: g.grnId, number: g.number, poId: g.poId, warehouseId: g.warehouseId,
          receivedBy: g.receivedBy, receivedAt: g.receivedAt, needsApproval: g.requiresApproval,
          discrepancyValueMinor: g.discrepancyValueMinor, currency: g.currency,
          sellableMinor: g.sellableMinor, quarantinedMinor: g.quarantinedMinor, rejectedMinor: g.rejectedMinor,
          discrepancies,
          returnLines: (g.returnLines ?? []).map((l) => presentReturnLine(lang, g.grnId, l)),
          costNotKnown: (g.costNotKnown ?? []).map((c) => ({ productId: c.productId, label: `${c.productId} — ${t('costNotKnownHeading')} (${t(c.because === 'no_issued_order' ? 'costNotKnownNoOrder' : 'costNotKnownNotOnOrder')})` })),
          valueIncomplete: g.discrepancyValueIncomplete === true,
          // OB-534: the bills matched to this receipt, line by line, and whether this reader may match one now.
          billMatch: ((): PresentedReceipt['billMatch'] => {
            const waiting = unbilledOf(g) > 0;
            const mine = g.receivedBy === config.userId;
            return {
              matched: billCostsOf(g).map((b) => ({
                invoiceId: b.invoiceId,
                label: `${t('billMatchedLine').replace('{bill}', b.invoiceId).replace('{product}', b.productId).replace('{cost}', money(b.unitCostMinor, b.currency)).replace('{who}', b.matchedBy)}${b.costWasKnown === true ? ` ${t('billMatchedKnown')}` : ''}`,
              })),
              canMatch: waiting && !mine && mayMatchBill() && (ports.billMatchPort?.() ?? null) !== null,
              receivedByYou: waiting && mine && mayMatchBill(),
            };
          })(),
        };
      });

      return {
        screenState: presentScreenState({ state: 'ready', label: t('scrReady') }),
        asOf: data.asAt ?? null,
        receipts,
        count: receipts.length,
        needingApprovalCount: receipts.filter((r) => r.needsApproval).length,
        nobodyNamed,
        canRecordReturn: canRecordReturn(),
        awaitingReturn: canRecordReturn()
          ? receipts.flatMap((r) => r.returnLines.filter((l) => l.state === 'awaiting_return' && !l.needsCount && !l.needsDispatch).map((line) => ({ grnId: r.grnId, number: r.number, line })))
          : [],
      };
    },
  };
}
