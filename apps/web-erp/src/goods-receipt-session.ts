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

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';
import type { DiscrepancyKind } from '../../../packages/receiving/src/index';
import { minorPerUnitOf, normaliseUom } from '../../../packages/contracts/src/quantity';

// ── what the screen was last told (the GRN list, one snapshot) ──────────────────────────────────────────────

/** One valued discrepancy on a delivery line — data, shown as-is. */
export interface GrnDiscrepancyView {
  readonly kind: DiscrepancyKind;
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
  | 'scrReady' | 'scrEmpty' | 'scrNoReceipts' | 'stateNotPermitted'
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
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(GOODS_RECEIPT_COPY.en) as CopyKey[]);

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

const DISCREPANCY_COPY: Readonly<Record<DiscrepancyKind, CopyKey>> = Object.freeze({
  short: 'dkShort', excess: 'dkExcess', damaged: 'dkDamaged', qc_failed: 'dkQcFailed',
  expired: 'dkExpired', near_expiry: 'dkNearExpiry', mrp_mismatch: 'dkMrpMismatch', temperature_breach: 'dkTemperatureBreach', temperature_not_recorded: 'dkTemperatureNotRecorded',
});

export interface PresentedDiscrepancy {
  readonly kind: DiscrepancyKind;
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
            kind: d.kind, label: t(DISCREPANCY_COPY[d.kind]),
            productId: d.productId, quantityMinor: d.quantityMinor, valueMinor: d.valueMinor, currency: d.currency,
            requiresApproval: d.requiresApproval, detail: d.detail,
          }));
        return {
          status, grnId: g.grnId, number: g.number, poId: g.poId, warehouseId: g.warehouseId,
          receivedBy: g.receivedBy, receivedAt: g.receivedAt, needsApproval: g.requiresApproval,
          discrepancyValueMinor: g.discrepancyValueMinor, currency: g.currency,
          sellableMinor: g.sellableMinor, quarantinedMinor: g.quarantinedMinor, rejectedMinor: g.rejectedMinor,
          discrepancies,
          returnLines: (g.returnLines ?? []).map((l) => presentReturnLine(lang, g.grnId, l)),
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
