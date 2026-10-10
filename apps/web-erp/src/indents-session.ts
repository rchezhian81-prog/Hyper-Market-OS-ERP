// The FLOOR INDENTS screen — the sales floor's face for the indent chain (SP-8b · F08 · WF-06 · WF-07 · M09-FR-03 ·
// M04-FR-03 · M08-FR-02 · §28 · §31 · P-01 · P-03 · P-07 · P-08 · hard rules #1 #2). SP-8 made the floor's ask for stock one
// durable record at head office; this screen lets the people on the floor and the manager drive it:
//
//   • **RAISE an indent** (`inventory.indent.request`): products and quantities for the shelf, from the back store. It is
//     written to the DURABLE device queue BEFORE the screen says "saved" — the same mechanism as the manager's decisions,
//     receipts and counts and the buyer's invoices (SP-2 / SP-7a) — handed to the store computer, relayed to head office,
//     and listed here with the five shared state words until head office has it. A reload loses nothing.
//   • **APPROVE** (`inventory.indent.approve`): a DIFFERENT person allocates it, online, against head office's own
//     back-store stock; the requester is refused on this screen before anything is sent, and again by the cloud.
//   • **RECEIVE an issue independently** (`inventory.movement.append`): a person OTHER than the issuer counts in what the
//     back store sent — queued durably like the ask; head office puts what arrived on the shelf and values a shortfall.
//   • **RESOLVE a shortfall** (`inventory.adjustment.approve`, Batch 2): a person who neither issued nor counted an issue
//     that arrived short says what turned up and why the rest is gone — an online write under their session; head office
//     books the found units back and confirms the rest LOST at the cost it left with. Refused here for the issuer and the
//     counter before anything is sent, and again by the cloud (§28).
//   • **The register** (`inventory.indent.read`): every open indent, needing a person first — awaiting approval, owed by
//     the back store, on the trolley, arrived short — with requested / issued / received / in transit / outstanding per
//     line, read live from head office. The figures are head office's; nothing is recomputed here (P-02).
//
// Like every ERP screen the rules live here in a tested, DOM-free session model on the shared packages/ui primitives;
// the shell renders only what this hands over.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { deviceItemState, deviceItemReason, type BoxItemStatus, type DeviceItemState } from '../../../packages/sync/src/device-relay';
import { ADJUSTMENT_REASON_CODES } from '../../../packages/adjustment/src/adjustment';

// ── what the screen was last told (the register, one snapshot) ───────────────────────────────────────────────

export interface IndentLineView {
  readonly productId: string;
  readonly uom: string;
  readonly requestedMinor: number;
  readonly allocatedMinor: number;
  readonly issuedMinor: number;
  readonly receivedMinor: number;
  readonly inTransitMinor: number;
  readonly shortfallMinor: number;
  readonly outstandingMinor: number;
}

export interface IndentIssueView {
  readonly issueId: string;
  readonly issuedBy: string;
  readonly issuedAt: string;
  readonly state: 'in_transit' | 'received';
  readonly lines: readonly { readonly productId: string; readonly batchId: string | null; readonly quantityMinor: number }[];
  /** Who counted it in at the floor (absent / null while it is on the trolley). */
  readonly receivedBy?: string | null;
  /** What was dispatched and did not arrive — head office's valued shortfall (absent / empty when it arrived in full). */
  readonly shortfall?: readonly { readonly productId: string; readonly batchId: string | null; readonly quantityMinor: number; readonly valueMinor: number }[];
  /** Batch 2: who resolved that shortfall, and the value confirmed lost (absent / null while it is open). */
  readonly resolvedBy?: string | null;
  readonly lostValueMinor?: number | null;
}

/** One indent as head office lists it — its state, who asked and approved, the figures per line, the issues, the reasons. */
export interface IndentRowView {
  readonly indentId: string;
  readonly state: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly approvedBy: string | null;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly reason: string | null;
  readonly flags: readonly string[];
  readonly attention: readonly string[];
  readonly needsAttention: boolean;
  readonly lines: readonly IndentLineView[];
  readonly issues: readonly IndentIssueView[];
}

/** Everything the box last told this screen. `indents` absent = not yet given the register (a data gap, not "none"). */
export interface IndentsData {
  readonly indents?: readonly IndentRowView[];
  readonly asAt?: string;
  readonly inTransitMinor?: number;
  readonly outstandingMinor?: number;
}

/** A product the floor may ask for — the box's own catalogue, so the ask names a product head office knows. */
export interface IndentProductOption {
  readonly productId: string;
  readonly name: string;
  readonly uom: string;
}

export type ApprovePostResult =
  | { readonly result: 'approved' | 'already_approved' | 'lost_link' }
  | { readonly result: 'refused'; readonly reason: string };

/** The authenticated POST of an approval (`POST /v1/floor/indents/:id/approval`, body `{ reason }`). */
export interface IndentApprovePort {
  post(input: { readonly indentId: string; readonly reason: string }): Promise<ApprovePostResult>;
}

export type ResolvePostResult =
  | { readonly result: 'resolved' | 'already_resolved' | 'lost_link' }
  | { readonly result: 'refused'; readonly reason: string };

/** Batch 2 — the authenticated POST of a shortfall resolution
 *  (`POST /v1/floor/indents/:id/issues/:issueId/shortfall/resolution`, body `{ reasonCode, note, lines }`). */
export interface IndentResolvePort {
  post(input: {
    readonly indentId: string; readonly issueId: string; readonly reasonCode: string; readonly note: string;
    readonly lines: readonly { readonly productId: string; readonly batchId: string | null; readonly foundMinor: number }[];
  }): Promise<ResolvePostResult>;
}

/** The reason codes a shortfall is resolved under — the stock adjustment's own list (M08-FR-03), never a new one. */
export const SHORTFALL_REASON_CODES: readonly string[] = ADJUSTMENT_REASON_CODES;

export interface IndentsPorts {
  snapshot(): IndentsData;
  /** `inventory.indent.read` */
  mayRead(): boolean;
  /** `inventory.indent.request` */
  mayRequest(): boolean;
  /** `inventory.indent.approve` */
  mayApprove(): boolean;
  /** `inventory.movement.append` — the floor's independent receipt is a stock movement at the floor. */
  mayReceive(): boolean;
  /** The approval write, or `null` when this page has no way to reach head office. */
  approvePort(): IndentApprovePort | null;
  /** Batch 2 · `inventory.adjustment.approve` — resolving a shortfall confirms a loss. Absent ⇒ not held. */
  mayResolve?(): boolean;
  /** Batch 2 · the resolution write, or `null` / absent when this page has no way to reach head office. */
  resolvePort?(): IndentResolvePort | null;
}

export interface IndentsConfig {
  /** Who is looking. `null` means the box was not told — no write is offered, because every write carries a name. */
  readonly userId: string | null;
  /** The floor (the store's location — where the till sells from). `null` = the box did not say. */
  readonly storeId: string | null;
  /** The back store the floor asks. `null` = the box did not say. */
  readonly backStoreId: string | null;
  readonly products: readonly IndentProductOption[];
  readonly now: () => string;
}

// ── the two device events this screen queues (their payloads are what the synced routes read) ──────────────

export const FLOOR_INDENT_REQUESTED = 'FloorIndentRequested';
export const FLOOR_INDENT_RECEIVED = 'FloorIndentReceived';

export interface FloorIndentRequestedPayload {
  readonly indentId: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly lines: readonly { readonly productId: string; readonly quantityMinor: number; readonly uom: string }[];
  readonly reason: string | null;
  readonly requestedBy: string;
  readonly at: string;
  readonly storeId: string | null;
  readonly source: 'indents-screen';
}

export interface FloorIndentReceivedPayload {
  readonly indentId: string;
  readonly issueId: string;
  readonly counted: readonly { readonly productId: string; readonly batchId: string | null; readonly quantityMinor: number }[];
  readonly receivedBy: string;
  readonly at: string;
  readonly storeId: string | null;
  readonly source: 'indents-screen';
}

/** One identity for one ask / one receipt at every hop (device queue → box → cloud). */
export const indentKeyFor = (indentId: string): string => `indent:${indentId}`;
export const receiptKeyFor = (indentId: string, issueId: string): string => `indent-receipt:${indentId}:${issueId}`;

// ── the copy: ONE bilingual object for the whole screen ────────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'registerHeading' | 'asOfLabel' | 'refresh'
  | 'summaryIndents' | 'summaryNeedAttention' | 'summaryOnTrolley' | 'summaryOwed' | 'unitsWord'
  | 'sigAwaiting' | 'sigOwed' | 'sigOnTrolley' | 'sigShort' | 'sigDone' | 'sigClosed'
  | 'stRequested' | 'stApproved' | 'stIssuing' | 'stIssued' | 'stReceived' | 'stRejected' | 'stCancelled'
  | 'requestedByLabel' | 'approvedByLabel' | 'colRequested' | 'colAllocated' | 'colIssued' | 'colReceived' | 'colOnTrolley' | 'colShort' | 'colOwed'
  | 'issueLabel' | 'issuedByLabel' | 'issueInTransit' | 'issueReceived'
  | 'flagShortStock' | 'flagShortAllocated' | 'flagPartialIssue' | 'flagPartialReceipt' | 'flagCancelledRemainder'
  | 'raiseHeading' | 'raiseProductLabel' | 'raiseQtyLabel' | 'raiseUomLabel' | 'raiseAddLine' | 'raiseLinesHeading' | 'raiseRemove' | 'raiseReasonLabel' | 'raiseReasonPlaceholder' | 'raiseBtn'
  | 'raiseSaved' | 'raiseNotPermitted' | 'raiseNobodyNamed' | 'raiseNoPlaces' | 'raiseNoLines' | 'raiseBadLine' | 'raiseDuplicateProduct'
  | 'approveHeading' | 'approveChoiceLabel' | 'approveReasonLabel' | 'approveReasonPlaceholder' | 'approveBtn' | 'approveNoneWaiting' | 'approveOwnAsk'
  | 'approveRecorded' | 'approveAlready' | 'approveRefused' | 'approveLostLink' | 'approveSelf' | 'approveNotPermitted' | 'approveNotRequested' | 'approveNoLink'
  | 'receiveHeading' | 'receiveChoiceLabel' | 'receiveCountedLabel' | 'receiveBtn' | 'receiveNoneOnTrolley' | 'receiveOwnIssue'
  | 'receiveSaved' | 'receiveNotPermitted' | 'receiveNobodyNamed' | 'receiveIssueUnknown' | 'receiveNotInTransit' | 'receiveIssuerCannot' | 'receiveBadCount' | 'receiveAlreadySaved'
  | 'resolveHeading' | 'resolveChoiceLabel' | 'resolveFoundLabel' | 'resolveReasonLabel' | 'resolveNoteLabel' | 'resolveNotePlaceholder' | 'resolveBtn' | 'resolveNoneOpen'
  | 'resolveRecorded' | 'resolveAlready' | 'resolveRefused' | 'resolveLostLink' | 'resolveNotPermitted' | 'resolveNoLink' | 'resolveIssueUnknown' | 'resolveNotOpen'
  | 'resolveIssuerCannot' | 'resolveCounterCannot' | 'resolveBadReason' | 'resolveNoteTooShort' | 'resolveBadFound' | 'noResolve'
  | 'issueShortWord' | 'issueResolvedBy' | 'issueLostWord' | 'resolveMissingWord'
  | 'reason_damaged' | 'reason_expired' | 'reason_miscount' | 'reason_found' | 'reason_theft_suspected' | 'reason_other'
  | 'savedHeading' | 'savedLead' | 'savedKindRequest' | 'savedKindReceipt' | 'linesWord'
  | 'noRequest' | 'noApprove' | 'noReceive'
  | 'scrReady' | 'scrEmpty' | 'scrNoIndents' | 'stateNotPermitted'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const INDENTS_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Floor indents', langName: 'தமிழ்',
    lead: 'The floor asks the back store for stock, and the ask is one record until it is on the shelf. Raise an indent here — it is saved on this device first, then handed to the store computer and head office. A different person approves it; the back store issues it; a third person counts it in. Requested, issued, received and still owed are four figures, never one.',
    registerHeading: 'Indents', asOfLabel: 'As of', refresh: 'Refresh',
    summaryIndents: 'indents', summaryNeedAttention: 'need a person', summaryOnTrolley: 'on the trolley', summaryOwed: 'still owed', unitsWord: 'units',
    sigAwaiting: 'Waiting for approval', sigOwed: 'Owed by the back store', sigOnTrolley: 'On the trolley — not yet counted in', sigShort: 'Arrived short', sigDone: 'On the shelf', sigClosed: 'Closed',
    stRequested: 'Requested', stApproved: 'Approved', stIssuing: 'Being issued', stIssued: 'Issued', stReceived: 'Received', stRejected: 'Rejected', stCancelled: 'Cancelled',
    requestedByLabel: 'Asked by', approvedByLabel: 'Approved by',
    colRequested: 'Asked', colAllocated: 'Allocated', colIssued: 'Issued', colReceived: 'On the shelf', colOnTrolley: 'On the trolley', colShort: 'Short', colOwed: 'Still owed',
    issueLabel: 'Issue', issuedByLabel: 'issued by', issueInTransit: 'on the trolley', issueReceived: 'counted in',
    flagShortStock: 'The back store had less than asked', flagShortAllocated: 'Less was allocated than asked', flagPartialIssue: 'Issued in parts',
    flagPartialReceipt: 'Something did not arrive — a valued exception is on the exceptions list', flagCancelledRemainder: 'The remainder was cancelled',
    raiseHeading: 'Raise an indent', raiseProductLabel: 'Product', raiseQtyLabel: 'How many', raiseUomLabel: 'Unit', raiseAddLine: 'Add the line', raiseLinesHeading: 'Lines on this indent', raiseRemove: 'Remove',
    raiseReasonLabel: 'Why (optional)', raiseReasonPlaceholder: 'e.g. shelf 4 is empty', raiseBtn: 'Save the indent on this device',
    raiseSaved: 'Indent saved on this device — it will go to the store computer and head office, and a different person must approve it.',
    raiseNotPermitted: 'You do not have permission to raise an indent.', raiseNobodyNamed: 'This store computer has not been told who is using this screen — an indent carries a name.',
    raiseNoPlaces: 'This store computer has not been told its floor and back store, so nothing can be asked for.', raiseNoLines: 'Add at least one line before saving.',
    raiseBadLine: 'A line needs a product and a whole number of units above zero.', raiseDuplicateProduct: 'That product is already on this indent — change its quantity instead.',
    approveHeading: 'Approve an indent', approveChoiceLabel: 'Which indent', approveReasonLabel: 'Note for the record (optional)', approveReasonPlaceholder: 'e.g. allocated what the back store holds',
    approveBtn: 'Approve and allocate', approveNoneWaiting: 'No indent is waiting for your approval.', approveOwnAsk: 'asked by you — someone else must approve it',
    approveRecorded: 'Indent approved — the back store can issue it.', approveAlready: 'This indent was already approved.',
    approveRefused: 'Head office refused the approval:', approveLostLink: 'No connection — not approved. Try again.',
    approveSelf: 'You raised this indent, so you cannot approve it. A different person must (nothing was sent).',
    approveNotPermitted: 'You do not have permission to approve an indent.', approveNotRequested: 'This indent is not waiting for approval.',
    approveNoLink: 'This page cannot reach head office, so nothing can be approved from it.',
    receiveHeading: 'Count in an issue from the back store', receiveChoiceLabel: 'Which issue', receiveCountedLabel: 'Counted on the floor', receiveBtn: 'Save the count on this device',
    receiveNoneOnTrolley: 'Nothing is on the trolley for you to count in.', receiveOwnIssue: 'issued by you — someone else must count it in',
    receiveSaved: 'Count saved on this device — it will go to the store computer and head office, which puts what arrived on the shelf.',
    receiveNotPermitted: 'You do not have permission to receive stock on the floor.', receiveNobodyNamed: 'This store computer has not been told who is using this screen — a receipt carries a name.',
    receiveIssueUnknown: 'That issue is not on the register.', receiveNotInTransit: 'That issue has already been counted in.',
    receiveIssuerCannot: 'You issued this stock, so you cannot count it in on the floor — a different person must (nothing was saved).',
    receiveBadCount: 'Each line needs a whole number of units, zero or more.', receiveAlreadySaved: 'This count is already saved on this device.',
    resolveHeading: 'Resolve a shortfall', resolveChoiceLabel: 'Which issue arrived short', resolveFoundLabel: 'Found again', resolveReasonLabel: 'Why the rest is gone',
    resolveNoteLabel: 'What was done to look for it', resolveNotePlaceholder: 'e.g. searched the back store and the trolley bay',
    resolveBtn: 'Record the resolution', resolveNoneOpen: 'No shortfall is waiting for you to resolve.',
    resolveRecorded: 'Shortfall resolved — what turned up is back on the books; the rest is confirmed lost at the cost it left with.',
    resolveAlready: 'This shortfall was already resolved the same way.', resolveRefused: 'Head office refused the resolution:', resolveLostLink: 'No connection — nothing was resolved. Try again.',
    resolveNotPermitted: 'You do not have permission to resolve a shortfall (it confirms a stock loss).', resolveNoLink: 'This page cannot reach head office, so nothing can be resolved from it.',
    resolveIssueUnknown: 'That issue is not on the register.', resolveNotOpen: 'That issue has no open shortfall — it arrived in full or was already resolved.',
    resolveIssuerCannot: 'You issued this stock, so you cannot resolve its shortfall — a different person must (nothing was sent).',
    resolveCounterCannot: 'You counted this stock in, so you cannot resolve its shortfall — a different person must (nothing was sent).',
    resolveBadReason: 'Choose why the rest is gone.', resolveNoteTooShort: 'Say what was done to look for the stock (a few words at least).',
    resolveBadFound: 'Found again is a whole number, zero or more, and never more than went missing.',
    noResolve: 'You can see the indents, but resolving a shortfall needs the stock-adjustment approval permission.',
    issueShortWord: 'short', issueResolvedBy: 'shortfall resolved by', issueLostWord: 'lost', resolveMissingWord: 'missing',
    reason_damaged: 'Damaged', reason_expired: 'Expired', reason_miscount: 'Miscounted', reason_found: 'Found', reason_theft_suspected: 'Theft suspected', reason_other: 'Other',
    savedHeading: 'Saved on this screen', savedLead: 'Each ask and each count you saved here, and where it has got to. The list is the same after a reload.',
    savedKindRequest: 'Indent', savedKindReceipt: 'Count-in', linesWord: 'lines',
    noRequest: 'You can see the indents, but raising one needs the indent permission.', noApprove: 'You can see the indents, but approving one needs the approval permission.',
    noReceive: 'You can see the indents, but counting one in needs the stock-movement permission.',
    scrReady: 'Showing the floor indents', scrEmpty: 'This screen has not been given the indent register yet.', scrNoIndents: 'No indent is open.',
    stateNotPermitted: 'You do not have permission to see floor indents.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'தளக் கோரிக்கைகள்', langName: 'English',
    lead: 'விற்பனைத் தளம் பின் கடையிடம் சரக்கு கேட்கிறது; அது அடுக்கை அடையும் வரை ஒரே பதிவு. இங்கே கோரிக்கையை எழுப்புங்கள் — முதலில் இந்தக் கருவியில் சேமிக்கப்பட்டு, பிறகு கடை கணினிக்கும் தலைமை அலுவலகத்திற்கும் செல்லும். வேறு ஒருவர் ஒப்புதல் அளிக்கிறார்; பின் கடை வழங்குகிறது; மூன்றாம் நபர் எண்ணி வாங்குகிறார். கேட்டது, வழங்கியது, பெற்றது, இன்னும் தர வேண்டியது — நான்கு எண்கள், ஒன்று அல்ல.',
    registerHeading: 'கோரிக்கைகள்', asOfLabel: 'நிலவரம்', refresh: 'புதுப்பி',
    summaryIndents: 'கோரிக்கைகள்', summaryNeedAttention: 'ஒருவரின் கவனம் தேவை', summaryOnTrolley: 'தள்ளுவண்டியில்', summaryOwed: 'இன்னும் தர வேண்டியது', unitsWord: 'அலகுகள்',
    sigAwaiting: 'ஒப்புதலுக்குக் காத்திருக்கிறது', sigOwed: 'பின் கடை தர வேண்டியது', sigOnTrolley: 'தள்ளுவண்டியில் — இன்னும் எண்ணி வாங்கப்படவில்லை', sigShort: 'குறைவாக வந்தது', sigDone: 'அடுக்கில் உள்ளது', sigClosed: 'மூடப்பட்டது',
    stRequested: 'கோரப்பட்டது', stApproved: 'ஒப்புதல் பெற்றது', stIssuing: 'வழங்கப்படுகிறது', stIssued: 'வழங்கப்பட்டது', stReceived: 'பெறப்பட்டது', stRejected: 'மறுக்கப்பட்டது', stCancelled: 'ரத்து செய்யப்பட்டது',
    requestedByLabel: 'கேட்டவர்', approvedByLabel: 'ஒப்புதல் அளித்தவர்',
    colRequested: 'கேட்டது', colAllocated: 'ஒதுக்கியது', colIssued: 'வழங்கியது', colReceived: 'அடுக்கில்', colOnTrolley: 'தள்ளுவண்டியில்', colShort: 'குறைவு', colOwed: 'இன்னும் தர வேண்டியது',
    issueLabel: 'வழங்கல்', issuedByLabel: 'வழங்கியவர்', issueInTransit: 'தள்ளுவண்டியில்', issueReceived: 'எண்ணி வாங்கப்பட்டது',
    flagShortStock: 'கேட்டதை விட பின் கடையில் குறைவாக இருந்தது', flagShortAllocated: 'கேட்டதை விட குறைவாக ஒதுக்கப்பட்டது', flagPartialIssue: 'பகுதிகளாக வழங்கப்பட்டது',
    flagPartialReceipt: 'ஏதோ வந்து சேரவில்லை — மதிப்பிடப்பட்ட விதிவிலக்கு விதிவிலக்குப் பட்டியலில் உள்ளது', flagCancelledRemainder: 'மீதி ரத்து செய்யப்பட்டது',
    raiseHeading: 'கோரிக்கையை எழுப்பு', raiseProductLabel: 'பொருள்', raiseQtyLabel: 'எத்தனை', raiseUomLabel: 'அலகு', raiseAddLine: 'வரியைச் சேர்', raiseLinesHeading: 'இந்தக் கோரிக்கையின் வரிகள்', raiseRemove: 'நீக்கு',
    raiseReasonLabel: 'ஏன் (விருப்பம்)', raiseReasonPlaceholder: 'எ.கா. அடுக்கு 4 காலியாக உள்ளது', raiseBtn: 'கோரிக்கையை இந்தக் கருவியில் சேமி',
    raiseSaved: 'கோரிக்கை இந்தக் கருவியில் சேமிக்கப்பட்டது — கடை கணினிக்கும் தலைமை அலுவலகத்திற்கும் செல்லும்; வேறு ஒருவர் ஒப்புதல் அளிக்க வேண்டும்.',
    raiseNotPermitted: 'கோரிக்கையை எழுப்ப உங்களுக்கு அனுமதி இல்லை.', raiseNobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை — கோரிக்கையில் பெயர் இருக்கும்.',
    raiseNoPlaces: 'இந்தக் கடை கணினிக்கு அதன் தளமும் பின் கடையும் சொல்லப்படவில்லை, அதனால் எதுவும் கேட்க முடியாது.', raiseNoLines: 'சேமிக்கும் முன் குறைந்தது ஒரு வரியைச் சேர்க்கவும்.',
    raiseBadLine: 'ஒரு வரிக்கு பொருளும் பூஜ்ஜியத்திற்கு மேல் முழு எண் அலகுகளும் தேவை.', raiseDuplicateProduct: 'அந்தப் பொருள் இந்தக் கோரிக்கையில் ஏற்கனவே உள்ளது — அதன் அளவை மாற்றுங்கள்.',
    approveHeading: 'கோரிக்கைக்கு ஒப்புதல்', approveChoiceLabel: 'எந்தக் கோரிக்கை', approveReasonLabel: 'பதிவுக்கான குறிப்பு (விருப்பம்)', approveReasonPlaceholder: 'எ.கா. பின் கடையில் உள்ளதை ஒதுக்கினேன்',
    approveBtn: 'ஒப்புதல் அளித்து ஒதுக்கு', approveNoneWaiting: 'உங்கள் ஒப்புதலுக்கு எந்தக் கோரிக்கையும் காத்திருக்கவில்லை.', approveOwnAsk: 'நீங்கள் கேட்டது — வேறு ஒருவர் ஒப்புதல் அளிக்க வேண்டும்',
    approveRecorded: 'கோரிக்கை ஒப்புதல் பெற்றது — பின் கடை வழங்கலாம்.', approveAlready: 'இந்தக் கோரிக்கை ஏற்கனவே ஒப்புதல் பெற்றது.',
    approveRefused: 'தலைமை அலுவலகம் ஒப்புதலை மறுத்தது:', approveLostLink: 'இணைப்பு இல்லை — ஒப்புதல் அளிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    approveSelf: 'இந்தக் கோரிக்கையை நீங்களே எழுப்பினீர்கள், அதனால் ஒப்புதல் அளிக்க முடியாது. வேறு ஒருவர் அளிக்க வேண்டும் (எதுவும் அனுப்பப்படவில்லை).',
    approveNotPermitted: 'கோரிக்கைக்கு ஒப்புதல் அளிக்க உங்களுக்கு அனுமதி இல்லை.', approveNotRequested: 'இந்தக் கோரிக்கை ஒப்புதலுக்குக் காத்திருக்கவில்லை.',
    approveNoLink: 'இந்தப் பக்கம் தலைமை அலுவலகத்தை அடைய முடியாது, அதனால் இங்கிருந்து ஒப்புதல் அளிக்க முடியாது.',
    receiveHeading: 'பின் கடையிலிருந்து வந்ததை எண்ணி வாங்கு', receiveChoiceLabel: 'எந்த வழங்கல்', receiveCountedLabel: 'தளத்தில் எண்ணியது', receiveBtn: 'எண்ணிக்கையை இந்தக் கருவியில் சேமி',
    receiveNoneOnTrolley: 'நீங்கள் எண்ணி வாங்க தள்ளுவண்டியில் எதுவும் இல்லை.', receiveOwnIssue: 'நீங்கள் வழங்கியது — வேறு ஒருவர் எண்ணி வாங்க வேண்டும்',
    receiveSaved: 'எண்ணிக்கை இந்தக் கருவியில் சேமிக்கப்பட்டது — கடை கணினிக்கும் தலைமை அலுவலகத்திற்கும் செல்லும்; வந்ததை அது அடுக்கில் வைக்கும்.',
    receiveNotPermitted: 'தளத்தில் சரக்கு பெற உங்களுக்கு அனுமதி இல்லை.', receiveNobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை — பெறுதலில் பெயர் இருக்கும்.',
    receiveIssueUnknown: 'அந்த வழங்கல் பதிவேட்டில் இல்லை.', receiveNotInTransit: 'அந்த வழங்கல் ஏற்கனவே எண்ணி வாங்கப்பட்டது.',
    receiveIssuerCannot: 'இந்தச் சரக்கை நீங்கள் வழங்கினீர்கள், அதனால் தளத்தில் எண்ணி வாங்க முடியாது — வேறு ஒருவர் வாங்க வேண்டும் (எதுவும் சேமிக்கப்படவில்லை).',
    receiveBadCount: 'ஒவ்வொரு வரிக்கும் பூஜ்ஜியம் அல்லது அதற்கு மேல் முழு எண் அலகுகள் தேவை.', receiveAlreadySaved: 'இந்த எண்ணிக்கை ஏற்கனவே இந்தக் கருவியில் சேமிக்கப்பட்டது.',
    resolveHeading: 'குறைவைத் தீர்', resolveChoiceLabel: 'எந்த வழங்கல் குறைவாக வந்தது', resolveFoundLabel: 'மீண்டும் கிடைத்தது', resolveReasonLabel: 'மீதி ஏன் இல்லை',
    resolveNoteLabel: 'தேட என்ன செய்யப்பட்டது', resolveNotePlaceholder: 'எ.கா. பின் கடையிலும் தள்ளுவண்டி இடத்திலும் தேடினோம்',
    resolveBtn: 'தீர்வைப் பதிவு செய்', resolveNoneOpen: 'நீங்கள் தீர்க்க எந்தக் குறைவும் காத்திருக்கவில்லை.',
    resolveRecorded: 'குறைவு தீர்க்கப்பட்டது — கிடைத்தது மீண்டும் கணக்கில் உள்ளது; மீதி அது புறப்பட்ட விலையில் இழப்பாக உறுதி செய்யப்பட்டது.',
    resolveAlready: 'இந்தக் குறைவு ஏற்கனவே இதே போல் தீர்க்கப்பட்டது.', resolveRefused: 'தலைமை அலுவலகம் தீர்வை மறுத்தது:', resolveLostLink: 'இணைப்பு இல்லை — எதுவும் தீர்க்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    resolveNotPermitted: 'குறைவைத் தீர்க்க உங்களுக்கு அனுமதி இல்லை (அது சரக்கு இழப்பை உறுதி செய்கிறது).', resolveNoLink: 'இந்தப் பக்கம் தலைமை அலுவலகத்தை அடைய முடியாது, அதனால் இங்கிருந்து தீர்க்க முடியாது.',
    resolveIssueUnknown: 'அந்த வழங்கல் பதிவேட்டில் இல்லை.', resolveNotOpen: 'அந்த வழங்கலுக்குத் திறந்த குறைவு இல்லை — முழுமையாக வந்தது அல்லது ஏற்கனவே தீர்க்கப்பட்டது.',
    resolveIssuerCannot: 'இந்தச் சரக்கை நீங்கள் வழங்கினீர்கள், அதனால் அதன் குறைவைத் தீர்க்க முடியாது — வேறு ஒருவர் தீர்க்க வேண்டும் (எதுவும் அனுப்பப்படவில்லை).',
    resolveCounterCannot: 'இந்தச் சரக்கை நீங்கள் எண்ணி வாங்கினீர்கள், அதனால் அதன் குறைவைத் தீர்க்க முடியாது — வேறு ஒருவர் தீர்க்க வேண்டும் (எதுவும் அனுப்பப்படவில்லை).',
    resolveBadReason: 'மீதி ஏன் இல்லை என்பதைத் தேர்ந்தெடுக்கவும்.', resolveNoteTooShort: 'சரக்கைத் தேட என்ன செய்யப்பட்டது என்று சொல்லுங்கள் (குறைந்தது சில சொற்கள்).',
    resolveBadFound: 'மீண்டும் கிடைத்தது பூஜ்ஜியம் அல்லது அதற்கு மேல் முழு எண்; காணாமல் போனதை விட அதிகமாக இருக்கக் கூடாது.',
    noResolve: 'கோரிக்கைகளைப் பார்க்கலாம், ஆனால் குறைவைத் தீர்க்க சரக்குச் சரிசெய்தல் ஒப்புதல் அனுமதி தேவை.',
    issueShortWord: 'குறைவு', issueResolvedBy: 'குறைவைத் தீர்த்தவர்', issueLostWord: 'இழப்பு', resolveMissingWord: 'காணவில்லை',
    reason_damaged: 'சேதமடைந்தது', reason_expired: 'காலாவதியானது', reason_miscount: 'தவறாக எண்ணப்பட்டது', reason_found: 'கிடைத்தது', reason_theft_suspected: 'திருட்டு சந்தேகம்', reason_other: 'மற்றவை',
    savedHeading: 'இந்தத் திரையில் சேமிக்கப்பட்டவை', savedLead: 'நீங்கள் இங்கே சேமித்த ஒவ்வொரு கோரிக்கையும் எண்ணிக்கையும், அது எங்கே சென்றது என்பதும். மீண்டும் ஏற்றிய பின்னும் பட்டியல் அதேதான்.',
    savedKindRequest: 'கோரிக்கை', savedKindReceipt: 'எண்ணி வாங்கல்', linesWord: 'வரிகள்',
    noRequest: 'கோரிக்கைகளைப் பார்க்கலாம், ஆனால் எழுப்ப கோரிக்கை அனுமதி தேவை.', noApprove: 'கோரிக்கைகளைப் பார்க்கலாம், ஆனால் ஒப்புதல் அளிக்க ஒப்புதல் அனுமதி தேவை.',
    noReceive: 'கோரிக்கைகளைப் பார்க்கலாம், ஆனால் எண்ணி வாங்க சரக்கு நகர்வு அனுமதி தேவை.',
    scrReady: 'தளக் கோரிக்கைகளைக் காட்டுகிறது', scrEmpty: 'இந்தத் திரைக்கு இன்னும் கோரிக்கைப் பதிவேடு தரப்படவில்லை.', scrNoIndents: 'திறந்த கோரிக்கை எதுவும் இல்லை.',
    stateNotPermitted: 'தளக் கோரிக்கைகளைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(INDENTS_COPY.en) as CopyKey[]);

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

const STATE_COPY: Readonly<Record<string, CopyKey>> = Object.freeze({
  requested: 'stRequested', approved: 'stApproved', issuing: 'stIssuing', issued: 'stIssued', received: 'stReceived', rejected: 'stRejected', cancelled: 'stCancelled',
});
const FLAG_COPY: Readonly<Record<string, CopyKey>> = Object.freeze({
  short_stock: 'flagShortStock', short_allocated: 'flagShortAllocated', partial_issue: 'flagPartialIssue', partial_receipt: 'flagPartialReceipt', cancelled_remainder: 'flagCancelledRemainder',
});

export interface PresentedIndent {
  readonly status: StatusPresentation;
  readonly indentId: string;
  readonly state: string;
  readonly stateLabel: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly approvedBy: string | null;
  readonly reason: string | null;
  readonly needsAttention: boolean;
  readonly flags: readonly { readonly flag: string; readonly label: string }[];
  readonly lines: readonly IndentLineView[];
  readonly issues: readonly IndentIssueView[];
  /** This reader may approve it from here: they hold the right, it is requested, and they did not ask. */
  readonly canApproveHere: boolean;
  readonly ownAsk: boolean;
  /** The issues THIS reader may count in: on the trolley, and not issued by them (§28). */
  readonly receivableIssues: readonly IndentIssueView[];
  /** Batch 2: the issues THIS reader may resolve the shortfall of: counted in short, still open, neither issued nor counted by them (§28). */
  readonly resolvableIssues: readonly IndentIssueView[];
}

export interface IndentsView {
  readonly screenState: StatusPresentation;
  readonly asOf: string | null;
  readonly indents: readonly PresentedIndent[];
  readonly count: number;
  readonly needingAttentionCount: number;
  readonly inTransitMinor: number;
  readonly outstandingMinor: number;
  readonly canRequest: boolean;
  readonly canApprove: boolean;
  readonly canReceive: boolean;
  readonly approvable: readonly PresentedIndent[];
  readonly receivable: readonly { readonly indentId: string; readonly issue: IndentIssueView }[];
  readonly canResolve: boolean;
  readonly resolvable: readonly { readonly indentId: string; readonly issue: IndentIssueView }[];
  /** The reason codes a resolution may name, in the reader's language. */
  readonly resolveReasons: readonly { readonly code: string; readonly label: string }[];
  readonly products: readonly IndentProductOption[];
  readonly nobodyNamed: boolean;
}

export interface RaiseLineInput { readonly productId: string; readonly quantityMinor: string; readonly uom: string }
export interface RaiseInput { readonly lines: readonly RaiseLineInput[]; readonly reason: string; readonly indentId?: string }
export type RaiseRefusal = 'not_permitted' | 'nobody_named' | 'no_places' | 'no_lines' | 'bad_line' | 'duplicate_product';
export type RaiseOutcome = { readonly ok: true; readonly indentId: string } | { readonly ok: false; readonly refusal: RaiseRefusal };

export interface ReceiveInput { readonly indentId: string; readonly issueId: string; readonly counted: readonly { readonly productId: string; readonly batchId: string | null; readonly quantityMinor: string }[] }
export type ReceiveRefusal = 'not_permitted' | 'nobody_named' | 'issue_unknown' | 'not_in_transit' | 'issuer_cannot_receive' | 'bad_count' | 'already_saved';
export type ReceiveOutcome = { readonly ok: true; readonly indentId: string; readonly issueId: string } | { readonly ok: false; readonly refusal: ReceiveRefusal };

export interface ResolveInput {
  readonly indentId: string;
  readonly issueId: string;
  readonly reasonCode: string;
  readonly note: string;
  /** What turned up per shortfall line, as typed; a line not named was not found. */
  readonly found: readonly { readonly productId: string; readonly batchId: string | null; readonly foundMinor: string }[];
}
export type ResolveOutcome =
  | { readonly outcome: 'resolved' | 'already_resolved' | 'lost_link' | 'not_permitted' | 'no_link' | 'issue_unknown' | 'not_open' | 'issuer_cannot_resolve' | 'counter_cannot_resolve' | 'bad_reason' | 'note_too_short' | 'bad_found' }
  | { readonly outcome: 'refused'; readonly reason: string };

export type ApproveOutcome =
  | { readonly outcome: 'approved' | 'already_approved' | 'lost_link' | 'self_approval' | 'not_permitted' | 'not_requested' | 'no_link' }
  | { readonly outcome: 'refused'; readonly reason: string };

/** One piece of work this screen saved on its device — an ask or a count-in — and where it has got to. */
export interface SavedIndentWork {
  readonly kind: 'request' | 'receipt';
  readonly id: string;
  readonly what: string;
  readonly detail: string;
  readonly at: string;
  readonly state: DeviceItemState;
  readonly attempts: number;
  readonly reason?: string;
}

export interface IndentsSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): IndentsView;
  /** Raise an indent — QUEUED on the durable device queue before this returns ok; nothing sent from here. */
  raise(input: RaiseInput): RaiseOutcome;
  /** Count in an issue — QUEUED likewise; refused here for the issuer, before anything is saved (§28). */
  receive(input: ReceiveInput): ReceiveOutcome;
  /** Approve — an online write under the reader's session; refused here for the requester (§28). */
  approve(indentId: string, reason: string): Promise<ApproveOutcome>;
  presentApproveOutcome(lang: Lang, outcome: ApproveOutcome): StatusPresentation;
  /** Batch 2 — resolve a shortfall: an online write under the reader's session; refused here for the issuer and the counter (§28). */
  resolve(input: ResolveInput): Promise<ResolveOutcome>;
  presentResolveOutcome(lang: Lang, outcome: ResolveOutcome): StatusPresentation;
  raiseRefusalWords(lang: Lang, refusal: RaiseRefusal): string;
  receiveRefusalWords(lang: Lang, refusal: ReceiveRefusal): string;
  /** Everything this screen saved, newest first, from the durable queue — the same after a reload. */
  savedWork(): readonly SavedIndentWork[];
  /** The queue keys the store computer has taken, to ask it where they have got to. */
  handedKeys(): readonly string[];
  /** Fold in the store computer's word — "posted" is only ever its say-so (P-08). */
  noteBoxStatus(statuses: readonly BoxItemStatus[]): void;
}

const isPosInt = (n: number): boolean => Number.isInteger(n) && n > 0;
const isNonNegInt = (n: number): boolean => Number.isInteger(n) && n >= 0;
const wholeNumber = (raw: string): number | undefined => (/^\d+$/.test(raw.trim()) ? Number(raw.trim()) : undefined);

/** A fresh indent / receipt id on this device: the browser's own random id, or a time-and-counter fallback. */
let counter = 0;
const freshId = (prefix: string, now: string): string => {
  const uuid = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.();
  if (uuid !== undefined) return `${prefix}-${uuid.slice(0, 8)}`;
  counter += 1;
  return `${prefix}-${now.replace(/[^0-9]/g, '').slice(0, 14)}-${counter}`;
};

/** The store computer's word on each handed item, keyed by queue key. Shared by every session built over the SAME queue
 *  (the boot session and each live re-present), so "posted" learned by one is shown by the next — never lost in a re-read. */
export type IndentBoxWords = Map<string, BoxItemStatus>;

export function createIndentsSession(config: IndentsConfig, ports: IndentsPorts, outbox: SyncOutbox, boxWords?: IndentBoxWords): IndentsSession {
  const text = (lang: Lang, key: CopyKey): string => translator(INDENTS_COPY, lang)(key);
  const nobodyNamed = config.userId === null;
  const boxWord: IndentBoxWords = boxWords ?? new Map<string, BoxItemStatus>();
  const canRequest = (): boolean => !nobodyNamed && ports.mayRequest() && config.storeId !== null && config.backStoreId !== null;
  const canApprove = (): boolean => !nobodyNamed && ports.mayApprove() && ports.approvePort() !== null;
  const canReceive = (): boolean => !nobodyNamed && ports.mayReceive();
  const canResolve = (): boolean => !nobodyNamed && (ports.mayResolve?.() ?? false) && (ports.resolvePort?.() ?? null) !== null;
  /** An issue whose shortfall is open: counted in, something missing, nobody has resolved it yet. */
  const shortfallOpen = (i: IndentIssueView): boolean => i.state === 'received' && (i.shortfall ?? []).some((s) => s.quantityMinor > 0) && (i.resolvedBy ?? null) === null;
  /** Receipts already saved on this device for an issue — offered no second time. */
  const receiptSavedHere = (indentId: string, issueId: string): boolean => outbox.find(receiptKeyFor(indentId, issueId)) !== undefined;

  const present = (lang: Lang, row: IndentRowView): PresentedIndent => {
    const t = translator(INDENTS_COPY, lang);
    const inTransit = row.lines.reduce((s, l) => s + l.inTransitMinor, 0);
    const short = row.lines.reduce((s, l) => s + l.shortfallMinor, 0);
    const owed = row.lines.reduce((s, l) => s + l.outstandingMinor, 0);
    const status = row.state === 'requested'
      ? presentStatus({ tone: 'degraded', icon: '❗', label: t('sigAwaiting'), announcement: `${t('sigAwaiting')}: ${row.indentId}`, needsAttention: true })
      : short > 0 && row.attention.includes('arrived_short')
        ? presentStatus({ tone: 'error', icon: '⚠', label: t('sigShort'), announcement: `${t('sigShort')}: ${row.indentId}`, needsAttention: true })
        : inTransit > 0
          ? presentStatus({ tone: 'degraded', icon: '⇢', label: t('sigOnTrolley'), announcement: `${t('sigOnTrolley')}: ${row.indentId}`, needsAttention: true })
          : owed > 0
            ? presentStatus({ tone: 'degraded', icon: '…', label: t('sigOwed'), announcement: `${t('sigOwed')}: ${row.indentId}`, needsAttention: true })
            : row.state === 'received'
              ? presentStatus({ tone: 'ok', icon: '✓', label: t('sigDone'), announcement: `${t('sigDone')}: ${row.indentId}`, needsAttention: false })
              : presentStatus({ tone: 'idle', icon: '—', label: t('sigClosed'), announcement: `${t('sigClosed')}: ${row.indentId}`, needsAttention: false });
    const ownAsk = row.requestedBy === config.userId;
    const receivableIssues = canReceive()
      ? row.issues.filter((i) => i.state === 'in_transit' && i.issuedBy !== config.userId && !receiptSavedHere(row.indentId, i.issueId))
      : [];
    // §28 on the screen: neither the issuer nor the counter resolves the shortfall of what they sent / counted.
    const resolvableIssues = canResolve()
      ? row.issues.filter((i) => shortfallOpen(i) && i.issuedBy !== config.userId && (i.receivedBy ?? null) !== config.userId)
      : [];
    return {
      status, indentId: row.indentId, state: row.state, stateLabel: t(STATE_COPY[row.state] ?? 'stRequested'),
      requestedBy: row.requestedBy, requestedAt: row.requestedAt, approvedBy: row.approvedBy, reason: row.reason,
      needsAttention: row.needsAttention,
      flags: row.flags.filter((f) => FLAG_COPY[f] !== undefined).map((flag) => ({ flag, label: t(FLAG_COPY[flag]!) })),
      lines: row.lines, issues: row.issues,
      canApproveHere: canApprove() && row.state === 'requested' && !ownAsk,
      ownAsk: row.state === 'requested' && ownAsk,
      receivableIssues,
      resolvableIssues,
    };
  };
  const reasonsIn = (lang: Lang): { code: string; label: string }[] => SHORTFALL_REASON_CODES.map((code) => ({ code, label: text(lang, `reason_${code}` as CopyKey) }));

  const empty = (screenState: StatusPresentation, asOf: string | null, writes: boolean): IndentsView => ({
    screenState, asOf, indents: [], count: 0, needingAttentionCount: 0, inTransitMinor: 0, outstandingMinor: 0,
    canRequest: writes && canRequest(), canApprove: writes && canApprove(), canReceive: writes && canReceive(),
    approvable: [], receivable: [], canResolve: writes && canResolve(), resolvable: [], resolveReasons: [], products: config.products, nobodyNamed,
  });

  return {
    text,

    view: (lang) => {
      const t = translator(INDENTS_COPY, lang);
      if (!ports.mayRead()) return empty(presentScreenState({ state: 'error', label: t('stateNotPermitted') }), null, false);
      const data = ports.snapshot();
      if (data.indents === undefined) return empty(presentScreenState({ state: 'empty', label: t('scrEmpty') }), null, true);
      if (data.indents.length === 0) return empty(presentScreenState({ state: 'empty', label: t('scrNoIndents') }), data.asAt ?? null, true);
      // Needing a person first — the undecided ask before everything, then the oldest first; the closed ones last, newest first.
      const rank = (r: IndentRowView): number => (r.state === 'requested' ? 0 : r.needsAttention ? 1 : 2);
      const ordered = data.indents.slice().sort((a, b) => rank(a) - rank(b)
        || (rank(a) === 2 ? b.requestedAt.localeCompare(a.requestedAt) : a.requestedAt.localeCompare(b.requestedAt))
        || a.indentId.localeCompare(b.indentId));
      const indents = ordered.map((r) => present(lang, r));
      return {
        screenState: presentScreenState({ state: 'ready', label: t('scrReady') }),
        asOf: data.asAt ?? null,
        indents,
        count: indents.length,
        needingAttentionCount: indents.filter((i) => i.needsAttention).length,
        inTransitMinor: data.inTransitMinor ?? indents.reduce((s, i) => s + i.lines.reduce((x, l) => x + l.inTransitMinor, 0), 0),
        outstandingMinor: data.outstandingMinor ?? indents.reduce((s, i) => s + i.lines.reduce((x, l) => x + l.outstandingMinor, 0), 0),
        canRequest: canRequest(), canApprove: canApprove(), canReceive: canReceive(),
        approvable: indents.filter((i) => i.canApproveHere),
        receivable: indents.flatMap((i) => i.receivableIssues.map((issue) => ({ indentId: i.indentId, issue }))),
        canResolve: canResolve(),
        resolvable: indents.flatMap((i) => i.resolvableIssues.map((issue) => ({ indentId: i.indentId, issue }))),
        resolveReasons: reasonsIn(lang),
        products: config.products, nobodyNamed,
      };
    },

    raise: (input) => {
      if (!ports.mayRead() || !ports.mayRequest()) return { ok: false, refusal: 'not_permitted' };
      if (nobodyNamed) return { ok: false, refusal: 'nobody_named' };
      if (config.storeId === null || config.backStoreId === null) return { ok: false, refusal: 'no_places' };
      if (input.lines.length === 0) return { ok: false, refusal: 'no_lines' };
      const lines: { productId: string; quantityMinor: number; uom: string }[] = [];
      for (const l of input.lines) {
        const productId = l.productId.trim();
        const qty = wholeNumber(l.quantityMinor);
        const uom = (l.uom.trim() === '' ? config.products.find((p) => p.productId === productId)?.uom ?? 'EA' : l.uom.trim()).toUpperCase();
        if (productId === '' || qty === undefined || !isPosInt(qty)) return { ok: false, refusal: 'bad_line' };
        if (lines.some((x) => x.productId === productId)) return { ok: false, refusal: 'duplicate_product' };
        lines.push({ productId, quantityMinor: qty, uom });
      }
      const at = config.now();
      const indentId = (input.indentId ?? '').trim() === '' ? freshId('ind', at) : input.indentId!.trim();
      // QUEUED before it is called saved: the outbox is the durable device queue `bootIndents` opens; enqueue writes it to
      // the device before returning, and the shared device → box → cloud path carries it from there (SP-2 / SP-7a).
      const payload: FloorIndentRequestedPayload = {
        indentId, fromLocationId: config.backStoreId, toLocationId: config.storeId, lines,
        reason: input.reason.trim() === '' ? null : input.reason.trim(), requestedBy: config.userId!, at, storeId: config.storeId, source: 'indents-screen',
      };
      outbox.enqueue(makeEvent({ id: indentKeyFor(indentId), type: FLOOR_INDENT_REQUESTED, occurredAt: at, idempotencyKey: indentKeyFor(indentId), source: 'web-erp/indents', payload }));
      return { ok: true, indentId };
    },

    receive: (input) => {
      if (!ports.mayRead() || !ports.mayReceive()) return { ok: false, refusal: 'not_permitted' };
      if (nobodyNamed) return { ok: false, refusal: 'nobody_named' };
      const row = (ports.snapshot().indents ?? []).find((r) => r.indentId === input.indentId);
      const issue = row?.issues.find((i) => i.issueId === input.issueId);
      if (row === undefined || issue === undefined) return { ok: false, refusal: 'issue_unknown' };
      if (issue.state !== 'in_transit') return { ok: false, refusal: 'not_in_transit' };
      // §28 on the screen: the issuer never counts in their own issue — refused before anything is saved. The cloud refuses again.
      if (issue.issuedBy === config.userId) return { ok: false, refusal: 'issuer_cannot_receive' };
      if (receiptSavedHere(input.indentId, input.issueId)) return { ok: false, refusal: 'already_saved' };
      const counted: { productId: string; batchId: string | null; quantityMinor: number }[] = [];
      for (const c of input.counted) {
        const qty = wholeNumber(c.quantityMinor);
        if (c.productId.trim() === '' || qty === undefined || !isNonNegInt(qty)) return { ok: false, refusal: 'bad_count' };
        counted.push({ productId: c.productId.trim(), batchId: c.batchId, quantityMinor: qty });
      }
      const at = config.now();
      const payload: FloorIndentReceivedPayload = { indentId: input.indentId, issueId: input.issueId, counted, receivedBy: config.userId!, at, storeId: config.storeId, source: 'indents-screen' };
      const key = receiptKeyFor(input.indentId, input.issueId);
      outbox.enqueue(makeEvent({ id: key, type: FLOOR_INDENT_RECEIVED, occurredAt: at, idempotencyKey: key, source: 'web-erp/indents', payload }));
      return { ok: true, indentId: input.indentId, issueId: input.issueId };
    },

    approve: async (indentId, reason) => {
      if (!ports.mayRead() || !ports.mayApprove() || nobodyNamed) return { outcome: 'not_permitted' };
      const port = ports.approvePort();
      if (port === null) return { outcome: 'no_link' };
      const row = (ports.snapshot().indents ?? []).find((r) => r.indentId === indentId.trim());
      if (row === undefined || row.state !== 'requested') return { outcome: 'not_requested' };
      if (row.requestedBy === config.userId) return { outcome: 'self_approval' };
      const posted = await port.post({ indentId: indentId.trim(), reason: reason.trim() });
      if (posted.result === 'refused') return { outcome: 'refused', reason: posted.reason };
      return { outcome: posted.result };
    },

    resolve: async (input) => {
      if (!ports.mayRead() || !(ports.mayResolve?.() ?? false) || nobodyNamed) return { outcome: 'not_permitted' };
      const port = ports.resolvePort?.() ?? null;
      if (port === null) return { outcome: 'no_link' };
      const row = (ports.snapshot().indents ?? []).find((r) => r.indentId === input.indentId.trim());
      const issue = row?.issues.find((i) => i.issueId === input.issueId.trim());
      if (row === undefined || issue === undefined) return { outcome: 'issue_unknown' };
      if (!shortfallOpen(issue)) return { outcome: 'not_open' };
      // §28 on the screen — refused before anything is sent; the cloud refuses again.
      if (issue.issuedBy === config.userId) return { outcome: 'issuer_cannot_resolve' };
      if ((issue.receivedBy ?? null) === config.userId) return { outcome: 'counter_cannot_resolve' };
      if (!SHORTFALL_REASON_CODES.includes(input.reasonCode)) return { outcome: 'bad_reason' };
      const note = input.note.trim();
      if (note.length < 4) return { outcome: 'note_too_short' };
      const lines: { productId: string; batchId: string | null; foundMinor: number }[] = [];
      for (const f of input.found) {
        const raw = f.foundMinor.trim() === '' ? '0' : f.foundMinor;
        const qty = wholeNumber(raw);
        const missing = (issue.shortfall ?? []).find((s) => s.productId === f.productId && s.batchId === f.batchId);
        if (qty === undefined || !isNonNegInt(qty) || missing === undefined || qty > missing.quantityMinor) return { outcome: 'bad_found' };
        if (qty > 0) lines.push({ productId: f.productId, batchId: f.batchId, foundMinor: qty });
      }
      const posted = await port.post({ indentId: row.indentId, issueId: issue.issueId, reasonCode: input.reasonCode, note, lines });
      if (posted.result === 'refused') return { outcome: 'refused', reason: posted.reason };
      return { outcome: posted.result };
    },

    presentResolveOutcome: (lang, o) => {
      const t = translator(INDENTS_COPY, lang);
      const err = (key: CopyKey) => presentStatus({ tone: 'error', icon: '✕', label: t(key), needsAttention: true });
      switch (o.outcome) {
        case 'resolved': return presentStatus({ tone: 'ok', icon: '✓', label: t('resolveRecorded'), needsAttention: false });
        case 'already_resolved': return presentStatus({ tone: 'ok', icon: '✓', label: t('resolveAlready'), needsAttention: false });
        case 'lost_link': return presentStatus({ tone: 'degraded', icon: '⚠', label: t('resolveLostLink'), needsAttention: true });
        case 'no_link': return presentStatus({ tone: 'degraded', icon: '⚠', label: t('resolveNoLink'), needsAttention: true });
        case 'refused': return presentStatus({ tone: 'error', icon: '✕', label: `${t('resolveRefused')} ${o.reason}`, needsAttention: true });
        case 'not_permitted': return err('resolveNotPermitted');
        case 'issue_unknown': return err('resolveIssueUnknown');
        case 'not_open': return err('resolveNotOpen');
        case 'issuer_cannot_resolve': return err('resolveIssuerCannot');
        case 'counter_cannot_resolve': return err('resolveCounterCannot');
        case 'bad_reason': return err('resolveBadReason');
        case 'note_too_short': return err('resolveNoteTooShort');
        case 'bad_found': return err('resolveBadFound');
      }
    },

    presentApproveOutcome: (lang, o) => {
      const t = translator(INDENTS_COPY, lang);
      switch (o.outcome) {
        case 'approved': return presentStatus({ tone: 'ok', icon: '✓', label: t('approveRecorded'), needsAttention: false });
        case 'already_approved': return presentStatus({ tone: 'ok', icon: '✓', label: t('approveAlready'), needsAttention: false });
        case 'lost_link': return presentStatus({ tone: 'degraded', icon: '⚠', label: t('approveLostLink'), needsAttention: true });
        case 'refused': return presentStatus({ tone: 'error', icon: '✕', label: `${t('approveRefused')} ${o.reason}`, needsAttention: true });
        case 'self_approval': return presentStatus({ tone: 'error', icon: '✕', label: t('approveSelf'), needsAttention: true });
        case 'not_permitted': return presentStatus({ tone: 'error', icon: '✕', label: t('approveNotPermitted'), needsAttention: true });
        case 'not_requested': return presentStatus({ tone: 'error', icon: '✕', label: t('approveNotRequested'), needsAttention: true });
        case 'no_link': return presentStatus({ tone: 'degraded', icon: '⚠', label: t('approveNoLink'), needsAttention: true });
      }
    },

    raiseRefusalWords: (lang, refusal) => {
      const t = translator(INDENTS_COPY, lang);
      const key: Record<RaiseRefusal, CopyKey> = { not_permitted: 'raiseNotPermitted', nobody_named: 'raiseNobodyNamed', no_places: 'raiseNoPlaces', no_lines: 'raiseNoLines', bad_line: 'raiseBadLine', duplicate_product: 'raiseDuplicateProduct' };
      return t(key[refusal]);
    },

    receiveRefusalWords: (lang, refusal) => {
      const t = translator(INDENTS_COPY, lang);
      const key: Record<ReceiveRefusal, CopyKey> = { not_permitted: 'receiveNotPermitted', nobody_named: 'receiveNobodyNamed', issue_unknown: 'receiveIssueUnknown', not_in_transit: 'receiveNotInTransit', issuer_cannot_receive: 'receiveIssuerCannot', bad_count: 'receiveBadCount', already_saved: 'receiveAlreadySaved' };
      return t(key[refusal]);
    },

    savedWork: () => outbox.all()
      .filter((item) => item.event.type === FLOOR_INDENT_REQUESTED || item.event.type === FLOOR_INDENT_RECEIVED)
      .map((item): SavedIndentWork => {
        const box = boxWord.get(item.key);
        const reason = deviceItemReason(item, box);
        const common = { at: item.event.occurredAt, state: deviceItemState(item, box), attempts: item.attempts, ...(reason === undefined ? {} : { reason }) };
        if (item.event.type === FLOOR_INDENT_REQUESTED) {
          const p = item.event.payload as FloorIndentRequestedPayload;
          return { kind: 'request', id: p.indentId, what: p.indentId, detail: p.lines.map((l) => `${l.productId} × ${l.quantityMinor}`).join(' · '), ...common };
        }
        const p = item.event.payload as FloorIndentReceivedPayload;
        return { kind: 'receipt', id: `${p.indentId}:${p.issueId}`, what: `${p.indentId} · ${p.issueId}`, detail: p.counted.map((c) => `${c.productId} × ${c.quantityMinor}`).join(' · '), ...common };
      })
      .reverse(),

    handedKeys: () => outbox.all().filter((item) => item.state === 'acknowledged').map((item) => item.key),

    noteBoxStatus: (statuses) => { for (const st of statuses) boxWord.set(st.key, st); },
  };
}
