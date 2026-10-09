// The write-off CAPTURE screen — the shop-floor "record a loss" desk (M28-FR-01 · API-04 · §28 · ADR-0024 · audit
// PA-03 · P-02 one truth · P-03 control-by-exception · hard rules #2/#5). The read-only /waste review screen shows
// losses already recorded; THIS is the write-capable sibling that records one, in the raiser's own name, posting to
// the governed write-off route (`POST /v1/inventory/write-off/:writeOffId`) — the SINGLE door for a stock loss, which
// reduces on-hand AND values the loss for finance.
//
// ── A big loss is two people's act, never a typed name ──────────────────────
//
// A MATERIAL loss (value at or above the tenant's limit) needs captured evidence AND a second person who handles stock
// (the store manager approving the owner's loss, or the other way round) — never the raiser (§28). That second person
// used to be a name TYPED into this screen and sent as `approvedBy`; a name in a box is not anybody's approval. Now it
// goes through head office's maker-checker engine (ADR-0024, kind `stock_write_off`):
//
//   1. the raiser fills the loss (with its photo or witness), writes why, and presses **Ask for approval** — the
//      engine records a request for EXACTLY the body the record will send, plus the write-off's id (`writeOffDetails`,
//      the same function the port's body comes from, so the two cannot drift), for exactly the loss's value;
//   2. ANOTHER person who handles stock approves or rejects it on their own Approvals page, in their own session;
//   3. **Record the loss** finds the raiser's OWN approved request for this write-off whose details are exactly the form
//      as it now stands, and sends the loss naming it (`approvalId`). Not asked, waiting, rejected (by whom and why),
//      expired, used or changed since asking — each is said in plain words and nothing is sent.
//
// A loss below the limit is recorded on the raiser's own, exactly as before. With no head office behind the page, a
// big loss is not recorded at all — and the screen says so. Head office re-checks everything (the limit is ITS policy,
// the evidence, the approval, who owns the stock); this DOM-free model only refuses BEFORE any POST what the operator
// can see is wrong, and says head office's own refusals in plain words. No AI records a loss (hard rule #5).
//
// Like every ERP screen the rules are here on the shared packages/ui + packages/a11y primitives (colour is never the
// only signal — an icon and a word ride with every tone), English and Tamil from ONE copy object, and the shell only
// renders what this hands over.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';
import type { LossType } from '../../../packages/waste/src/waste';
import {
  presentRequestStatus, shopTime,
  type ApprovalAsk, type ApprovalRequestView, type ApprovalStatus, type AskResult, type InboxRead, type LostLink, type Refused,
} from './approvals-session';
import { detailsOfBody, findOwnApproval, useOutcomeOfRefusal, MIN_REASON_LENGTH, type ApprovalUseOutcome } from './catalogue-session';

/** The five kinds of loss the tested engine knows — the chosen categorisation, never free text (M15). */
export const LOSS_TYPES: readonly LossType[] = ['wastage', 'damage', 'expiry', 'donation', 'destruction'];

/** The approval kind a material loss is asked under (head office's maker-checker engine, ADR-0024). */
export const WRITE_OFF_APPROVAL_KIND = 'stock_write_off';

/** ₹ from paise — a small local presenter (the shell shows the threshold and the loss value). */
export function formatRupees(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}₹${Math.floor(abs / 100).toLocaleString('en-IN')}.${String(abs % 100).padStart(2, '0')}`;
}

/** What the operator has assembled before recording a loss. The raiser is NOT here — it is the authenticated
 *  caller server-side, so a loss can never be recorded in someone else's name — and neither is any approver: the
 *  second person approves in their own session, on their own Approvals page. */
export interface WriteOffDraft {
  /** The loss's operation identity (idempotency key — a re-send under the same id records once). It is also what an
   *  approval is asked ABOUT (`subjectRef`), so it is kept from the ask to the record. */
  readonly writeOffId: string;
  readonly productId: string;
  readonly locationId: string;
  /** Whole units removed, > 0. */
  readonly qty: number;
  readonly uom: string;
  readonly lossType: LossType;
  /** The loss's value in paise, ≥ 0 — what finance carries. Materiality is judged on this. */
  readonly valueMinor: number;
  /** A finer reason; defaults to the loss type (which is itself the chosen categorisation). */
  readonly reasonCode?: string;
  /** A photo/witness reference — REQUIRED for a material loss (the server also enforces it). */
  readonly evidenceRef?: string;
}

// ── What an approval is FOR — the engine's one rule (ADR-0024 `actionDetails`) ──────────────────────────────
//
// Head office fingerprints the details the raiser asks for, and the write-off route recomputes them from the body it
// receives: the body without its control fields (`approvalId` …) plus the route's path id (`writeOffId`). The body the
// port SENDS and the details the screen ASKS for come from the same functions below, so they cannot drift apart —
// tests/unit/erp-write-off-capture-session.test.ts proves them equal to the engine's own `actionDetails`.

/** EXACTLY the JSON body `POST /v1/inventory/write-off/:writeOffId` receives (less the `approvalId`). */
export interface WriteOffBody {
  readonly productId: string;
  readonly locationId: string;
  readonly qty: number;
  readonly uom: string;
  readonly lossType: LossType;
  readonly reasonCode: string;
  readonly valueMinor: number;
  readonly evidenceRef?: string;
}

const isNonEmpty = (v: string | undefined | null): v is string => typeof v === 'string' && v.trim() !== '';
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** The ONE place a draft becomes the body — for the loss sent with no approval, the loss sent naming one, and the
 *  details an approval is asked for. Trimmed; the reason code defaults to the loss type. */
export function writeOffBodyOf(d: WriteOffDraft): WriteOffBody {
  return {
    productId: d.productId.trim(), locationId: d.locationId.trim(), qty: d.qty, uom: d.uom.trim(), lossType: d.lossType,
    // The loss type IS the chosen reason categorisation; a finer reasonCode overrides it when supplied.
    reasonCode: isNonEmpty(d.reasonCode) ? d.reasonCode.trim() : d.lossType,
    valueMinor: d.valueMinor,
    ...(isNonEmpty(d.evidenceRef) ? { evidenceRef: d.evidenceRef.trim() } : {}),
  };
}

/** The JSON body of `POST /v1/inventory/write-off/:writeOffId`: the loss, and the approval it names when it needs one.
 *  Never an approver's name. */
export function writeOffRequestBody(body: WriteOffBody, approvalId?: string): Record<string, unknown> {
  return {
    productId: body.productId, locationId: body.locationId, qty: body.qty, uom: body.uom, lossType: body.lossType,
    reasonCode: body.reasonCode, valueMinor: body.valueMinor,
    ...(body.evidenceRef === undefined ? {} : { evidenceRef: body.evidenceRef }),
    ...(approvalId === undefined ? {} : { approvalId }),
  };
}

/** What a `stock_write_off` approval is for: exactly the write-off body plus the write-off's id from the route's path. */
export function writeOffDetails(writeOffId: string, body: WriteOffBody): Record<string, unknown> {
  return detailsOfBody(writeOffRequestBody(body), { writeOffId: writeOffId.trim() });
}

/** What head office said when the loss was sent: recorded, its own refusal (code + words), or no answer at all. */
export type WriteOffPostResult = { readonly result: 'recorded' } | Refused | LostLink;

/** The authenticated POST of a write-off. Injected, so the model never opens a socket itself; the server records the
 *  loss in the caller's own name and enforces the limit, the evidence and the approval it names. The port sends
 *  exactly `writeOffRequestBody(body, approvalId)`. */
export interface WriteOffCapturePort {
  post(input: { readonly writeOffId: string; readonly body: WriteOffBody; readonly approvalId?: string }): Promise<WriteOffPostResult>;
}

export interface WriteOffCapturePorts {
  /** Whether this user may record a loss (`inventory.movement.append`). */
  mayCapture(): boolean;
  /** Records a loss. Only reached from the explicit action, never on render. */
  capturePort(): WriteOffCapturePort;
  /** Ask a second person to approve (POST /v1/approvals/requests) — the caller's own session is the maker. Only from an
   *  explicit click. Absent when the screen is not connected to head office: then no big loss is recorded at all. */
  askApproval?(ask: ApprovalAsk): Promise<AskResult>;
  /** The caller's approvals inbox (GET /v1/approvals/requests) — read only. Absent when not connected. */
  approvalInbox?(): Promise<InboxRead>;
  /** SF-05 — head office's value of a loss (GET /v1/inventory/write-off-value) — read only. Absent when not connected:
   *  the value is then typed, and head office still values the loss itself when it is sent. */
  readLossValue?(q: LossToValue): Promise<LossValueRead>;
}

/** SF-05 — the loss head office is asked to value. */
export interface LossToValue { readonly productId: string; readonly locationId: string; readonly qty: number }

/** SF-05 — head office's answer: its own value of the loss (and whether that is a big loss), or that it holds no cost. */
export type LossValueRead =
  | { readonly result: 'valued'; readonly known: true; readonly unitCostMinor: number; readonly valueMinor: number; readonly material: boolean }
  | { readonly result: 'valued'; readonly known: false }
  | Refused | LostLink;

/** SF-05 — what the screen does with head office's value. */
export type LossValueOutcome =
  | { readonly kind: 'valued'; readonly qty: number; readonly unitCostMinor: number; readonly valueMinor: number; readonly material: boolean }
  | { readonly kind: 'cost_unknown' }
  | { readonly kind: 'incomplete' } | { readonly kind: 'not_connected' } | { readonly kind: 'lost_link' }
  | { readonly kind: 'refused'; readonly whatHappened: string };

export interface WriteOffCaptureConfig {
  /** Who is at the screen. `null` means the store computer was not told; a loss carries the raiser's name,
   *  so the screen surfaces when nobody is named. */
  readonly userId: string | null;
  /** The tenant's material-loss threshold in paise (the value at/above which evidence + a second person's approval are
   *  needed). Injected policy, sourced from the pack — never invented here (the server is the authority). */
  readonly materialThresholdMinor: number;
}

// ── The outcomes ───────────────────────────────────────────────────────────────────────────────────────────

/** The screen refused before anything was sent. */
export type WriteOffLocalRefusal =
  | { readonly kind: 'not_permitted' }
  | { readonly kind: 'incomplete' }
  | { readonly kind: 'needs_evidence' };

/** The outcome of pressing "Ask for approval". Nothing is recorded by asking. */
export type WriteOffAskOutcome =
  | { readonly kind: 'asked'; readonly request: ApprovalRequestView }
  | WriteOffLocalRefusal
  /** Below the limit: no approval is needed — record it. */
  | { readonly kind: 'not_material' }
  | { readonly kind: 'needs_why' }
  | { readonly kind: 'not_connected' }
  | { readonly kind: 'refused'; readonly code: string; readonly whatHappened: string }
  | { readonly kind: 'lost_link' };

/** Head office's own refusals of a write-off — each said in plain words. */
export const WRITE_OFF_REFUSAL_CODES = Object.freeze([
  'write_off_needs_approval', 'write_off_needs_evidence', 'invalid_write_off', 'stock_not_owned_by_the_store',
  'write_off_already_recorded',
  // SF-05 — head office values a loss from the stock's own cost: a different figure, or none where it holds no cost.
  'write_off_value_is_the_stock_cost', 'write_off_cost_unknown',
] as const);
export type WriteOffRefusalCode = (typeof WRITE_OFF_REFUSAL_CODES)[number];

/** The outcome of pressing "Record the loss". */
export type WriteOffRecordOutcome =
  | { readonly kind: 'recorded'; readonly approvedBy: string | null }
  | WriteOffLocalRefusal
  | { readonly kind: 'head_office_refused'; readonly code: WriteOffRefusalCode; readonly whatHappened: string }
  | Exclude<ApprovalUseOutcome, { readonly kind: 'done' } | { readonly kind: 'cannot_check' }>;

/** One of the raiser's own write-off requests, as "Losses you asked approval for" lists it. */
export interface LossRequestRow {
  readonly requestId: string;
  readonly writeOffId: string;
  readonly summary: string;
  readonly why: string;
  readonly askedAt: string;
  /** Where it stands — tone + icon + words (approved by whom, until when; rejected by whom and why…). */
  readonly status: StatusPresentation;
  readonly approvalStatus: ApprovalStatus;
  /** The loss exactly as asked — "Carry on with this loss" puts it back in the form; null when it cannot be read. */
  readonly draft: WriteOffDraft | null;
}

export interface LossRequestsView {
  readonly state: 'read' | 'refused' | 'lost_link' | 'not_connected' | 'not_permitted';
  /** Newest first, one per write-off; a loss already recorded (its approval used) is history and not listed. */
  readonly rows: readonly LossRequestRow[];
}

// ── the copy: ONE bilingual object for the whole screen ───────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'lossWastage' | 'lossDamage' | 'lossExpiry' | 'lossDonation' | 'lossDestruction'
  | 'productLabel' | 'locationLabel' | 'qtyLabel' | 'uomLabel' | 'valueLabel' | 'lossTypeLabel' | 'evidenceLabel'
  | 'recordBtn'
  | 'materialHint' | 'immaterialHint' | 'thresholdLabel'
  | 'approvalLead' | 'whyLabel' | 'askBtn' | 'summaryLoss'
  | 'asked' | 'askIncomplete' | 'askNotMaterial' | 'askNeedsEvidence' | 'askNeedsWhy' | 'askNotConnected'
  | 'askRefused' | 'askRefusedNoWords' | 'askLostLink'
  | 'notRecorded' | 'someone' | 'recorded' | 'recordedApproved'
  | 'notPermitted' | 'incomplete' | 'needsEvidence' | 'notConnected'
  | 'notAsked' | 'waiting' | 'rejected' | 'rejectedNoName' | 'expired' | 'used' | 'changed'
  | 'checkerMayNot' | 'namedNotApproved' | 'refused' | 'refusedNoWords' | 'lostLink'
  | 'hoNeedsApproval' | 'hoNeedsEvidence' | 'hoInvalid' | 'hoNotOwned' | 'hoAlready' | 'hoValueIsStockCost' | 'hoCostUnknown'
  | 'valueFromStock' | 'valueCostUnknown' | 'valueLostLink' | 'valueRefused'
  | 'yourLossesTitle' | 'yourLossesLead' | 'carryOnBtn' | 'carriedOn' | 'whyWord'
  | 'scrReady' | 'stateNotPermitted' | 'nobodyNamed';

/** Every word the screen says, in English and Tamil. `{not}` is "Not recorded". */
export const WRITE_OFF_CAPTURE_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Record a loss', langName: 'தமிழ்',
    lead: 'Record stock that is leaving as a loss — wastage, damage, expiry, a donation or a destruction. It reduces the shelf figure and values the loss. A big loss (at or above the store limit) needs a photo or witness, and a different person who handles stock must approve it on their Approvals page — you cannot approve your own loss.',
    lossWastage: 'Wastage', lossDamage: 'Damage', lossExpiry: 'Expired', lossDonation: 'Donation', lossDestruction: 'Destruction',
    productLabel: 'Which item', locationLabel: 'Where in the store', qtyLabel: 'How many', uomLabel: 'Unit',
    valueLabel: 'What it is worth (₹)', lossTypeLabel: 'What kind of loss', evidenceLabel: 'Photo or witness (for a big loss)',
    recordBtn: 'Record the loss',
    materialHint: 'This is a big loss — it needs a photo or witness, and a second person who handles stock must approve it.',
    immaterialHint: 'This loss is small enough to record on your own.',
    thresholdLabel: 'A loss is "big" at or above',
    approvalLead: 'A big loss needs the approval of a second person who handles stock — the store manager or the owner, never you. Write why and press “Ask for approval”. Once they approve it on their Approvals page, press “Record the loss”.',
    whyLabel: 'Why is this a loss? (the person approving reads it)',
    askBtn: 'Ask for approval',
    summaryLoss: 'Write off {qty} × {product} — {loss}, {value}',
    asked: 'Asked. Waiting for a second person who handles stock (not you) to approve it on their Approvals page. Nothing is recorded yet.',
    askIncomplete: 'Nothing was asked — fill in the item, where it is, how many (a whole number), what it is worth and the kind of loss.',
    askNotMaterial: 'No approval is needed — this loss is small enough to record on your own. Press “Record the loss”.',
    askNeedsEvidence: 'Nothing was asked — a big loss needs a photo or witness first. Add it, then ask.',
    askNeedsWhy: 'Write why this is a loss, in a sentence — the person approving reads it. Nothing was asked.',
    askNotConnected: 'Nothing was asked — a big loss needs a second person’s approval at head office, and this screen is not connected to head office. Nothing was recorded.',
    askRefused: 'Not asked:', askRefusedNoWords: 'Not asked — head office refused the request.',
    askLostLink: 'No connection to head office — nothing was asked. Try again.',
    notRecorded: 'Not recorded', someone: 'the second person',
    recorded: 'Loss recorded. The shelf figure has come down.',
    recordedApproved: 'Loss recorded. {who} approved it, and that approval has now been used. The shelf figure has come down.',
    notPermitted: '{not} — you do not have permission to record a loss.',
    incomplete: '{not} — fill in the item, where it is, how many (a whole number), what it is worth and the kind of loss.',
    needsEvidence: '{not} — this is a big loss: add a photo or witness first.',
    notConnected: '{not} — a big loss needs a second person’s approval at head office, and this screen is not connected to head office. A name typed on a page is not an approval, so nothing was recorded.',
    notAsked: '{not} — nobody has been asked to approve this loss yet. Write why and press “Ask for approval” first.',
    waiting: '{not} — still waiting for a second person who handles stock (not you) to approve it on their Approvals page.',
    rejected: '{not} — {who} rejected it: “{reason}”. Change what they said and ask again.',
    rejectedNoName: '{not} — it was rejected: {reason} Change what they said and ask again.',
    expired: '{not} — the approval ran out of time before it was used. Ask again.',
    used: '{not} — that approval was already used once. One approval allows one loss; ask again.',
    changed: '{not} — this is not exactly the loss that was approved (something changed after you asked). Ask for approval again for exactly this.',
    checkerMayNot: '{not} — the person who approved it no longer handles stock, so their approval does not count. Ask again.',
    namedNotApproved: '{not} — naming a person is not their approval. Ask for approval, and wait for a second person to approve it on their Approvals page.',
    refused: '{not}: {words}', refusedNoWords: '{not} — head office refused it.',
    lostLink: '{not} — no connection to head office. Nothing was saved. Try again.',
    hoNeedsApproval: '{not} — head office counts this as a big loss, so a second person who handles stock must approve it. Write why and press “Ask for approval”.',
    hoNeedsEvidence: '{not} — head office counts this as a big loss: it needs a photo or witness, and a second person who handles stock must approve it. Add the photo or witness, write why and press “Ask for approval”.',
    hoInvalid: '{not} — head office could not accept this loss as written. Check how many (a whole number above zero) and the kind of loss.',
    hoNotOwned: '{not} — some of this item at that place belongs to someone else (a concession or consignment supplier, or a customer). Store staff cannot write off stock the store does not own; its owner records that loss.',
    hoAlready: 'This loss was already recorded. Nothing was recorded again.',
    hoValueIsStockCost: '{not} — the value is not head office\'s figure for this stock. Re-enter the product, place and quantity so the screen shows head office\'s value, then record again.',
    hoCostUnknown: '{not} — head office holds no cost for this stock. Type the value you believe it has — a photo or witness and a second person\'s approval will be needed.',
    valueFromStock: 'Head office\'s value: {qty} × {unit} = {value}.',
    valueCostUnknown: 'Head office holds no cost for this stock. Type the value you believe it has — this loss needs a photo or witness and a second person\'s approval, whatever its value.',
    valueLostLink: 'Head office did not answer, so the value could not be read. Try again in a moment.',
    valueRefused: 'Head office could not value this loss: {words}',
    yourLossesTitle: 'Losses you asked approval for',
    yourLossesLead: 'Once one is approved, press “Carry on with this loss” to put exactly that loss back in the form, then press “Record the loss”.',
    carryOnBtn: 'Carry on with this loss',
    carriedOn: 'The form now holds exactly the loss you asked about.',
    whyWord: 'Why:',
    scrReady: 'Ready to record a loss',
    stateNotPermitted: 'You do not have permission to record a loss.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
  },
  ta: {
    title: 'இழப்பைப் பதிவு செய்', langName: 'English',
    lead: 'இழப்பாக வெளியேறும் பொருளைப் பதிவு செய்யவும் — கழிவு, சேதம், காலாவதி, நன்கொடை அல்லது அழிப்பு. இது அலமாரி எண்ணிக்கையைக் குறைத்து இழப்பை மதிப்பிடும். பெரிய இழப்புக்கு (கடை வரம்பிற்குச் சமமாக அல்லது அதற்கு மேல்) புகைப்படம் அல்லது சாட்சி தேவை; மேலும் சரக்கைக் கையாளும் வேறு ஒருவர் அதைத் தனது அனுமதிகள் பக்கத்தில் அனுமதிக்க வேண்டும் — உங்கள் சொந்த இழப்பை நீங்கள் அனுமதிக்க முடியாது.',
    lossWastage: 'கழிவு', lossDamage: 'சேதம்', lossExpiry: 'காலாவதி', lossDonation: 'நன்கொடை', lossDestruction: 'அழிப்பு',
    productLabel: 'எந்தப் பொருள்', locationLabel: 'கடையில் எங்கே', qtyLabel: 'எத்தனை', uomLabel: 'அலகு',
    valueLabel: 'மதிப்பு (₹)', lossTypeLabel: 'எந்த வகை இழப்பு', evidenceLabel: 'புகைப்படம் அல்லது சாட்சி (பெரிய இழப்புக்கு)',
    recordBtn: 'இழப்பைப் பதிவு செய்',
    materialHint: 'இது ஒரு பெரிய இழப்பு — புகைப்படம் அல்லது சாட்சி தேவை; சரக்கைக் கையாளும் இரண்டாம் நபர் அதை அனுமதிக்க வேண்டும்.',
    immaterialHint: 'இந்த இழப்பு நீங்களே பதிவு செய்யும் அளவுக்குச் சிறியது.',
    thresholdLabel: 'இதற்குச் சமமாக அல்லது அதற்கு மேல் ஒரு இழப்பு "பெரியது"',
    approvalLead: 'பெரிய இழப்புக்குச் சரக்கைக் கையாளும் இரண்டாம் நபரின் அனுமதி தேவை — கடை மேலாளர் அல்லது உரிமையாளர், நீங்கள் அல்ல. ஏன் என்று எழுதி “அனுமதி கேள்” அழுத்தவும். அவர் தனது அனுமதிகள் பக்கத்தில் அனுமதித்த பிறகு “இழப்பைப் பதிவு செய்” அழுத்தவும்.',
    whyLabel: 'இது ஏன் இழப்பு? (அனுமதிப்பவர் இதைப் படிப்பார்)',
    askBtn: 'அனுமதி கேள்',
    summaryLoss: '{qty} × {product} இழப்பாகக் கழித்தல் — {loss}, {value}',
    asked: 'கேட்கப்பட்டது. சரக்கைக் கையாளும் இரண்டாம் நபர் (நீங்கள் அல்ல) தனது அனுமதிகள் பக்கத்தில் அனுமதிக்கக் காத்திருக்கிறது. இன்னும் எதுவும் பதிவு செய்யப்படவில்லை.',
    askIncomplete: 'எதுவும் கேட்கப்படவில்லை — பொருள், அது எங்கே உள்ளது, எத்தனை (முழு எண்), அதன் மதிப்பு, இழப்பின் வகை ஆகியவற்றை நிரப்பவும்.',
    askNotMaterial: 'அனுமதி தேவையில்லை — இந்த இழப்பு நீங்களே பதிவு செய்யும் அளவுக்குச் சிறியது. “இழப்பைப் பதிவு செய்” அழுத்தவும்.',
    askNeedsEvidence: 'எதுவும் கேட்கப்படவில்லை — பெரிய இழப்புக்கு முதலில் புகைப்படம் அல்லது சாட்சி தேவை. அதைச் சேர்த்து, பிறகு கேளுங்கள்.',
    askNeedsWhy: 'இது ஏன் இழப்பு என்று ஒரு வாக்கியத்தில் எழுதுங்கள் — அனுமதிப்பவர் அதைப் படிப்பார். எதுவும் கேட்கப்படவில்லை.',
    askNotConnected: 'எதுவும் கேட்கப்படவில்லை — பெரிய இழப்புக்குத் தலைமை அலுவலகத்தில் இரண்டாம் நபரின் அனுமதி தேவை, இந்தத் திரை தலைமை அலுவலகத்துடன் இணைக்கப்படவில்லை. எதுவும் பதிவு செய்யப்படவில்லை.',
    askRefused: 'கேட்கப்படவில்லை:', askRefusedNoWords: 'கேட்கப்படவில்லை — தலைமை அலுவலகம் கோரிக்கையை ஏற்கவில்லை.',
    askLostLink: 'தலைமை அலுவலகத்துடன் இணைப்பு இல்லை — எதுவும் கேட்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    notRecorded: 'பதிவு செய்யப்படவில்லை', someone: 'இரண்டாம் நபர்',
    recorded: 'இழப்பு பதிவு செய்யப்பட்டது. அலமாரி எண்ணிக்கை குறைந்தது.',
    recordedApproved: 'இழப்பு பதிவு செய்யப்பட்டது. {who} அனுமதித்தார்; அந்த அனுமதி இப்போது பயன்படுத்தப்பட்டுவிட்டது. அலமாரி எண்ணிக்கை குறைந்தது.',
    notPermitted: '{not} — இழப்பைப் பதிவு செய்ய உங்களுக்கு அனுமதி இல்லை.',
    incomplete: '{not} — பொருள், அது எங்கே உள்ளது, எத்தனை (முழு எண்), அதன் மதிப்பு, இழப்பின் வகை ஆகியவற்றை நிரப்பவும்.',
    needsEvidence: '{not} — இது ஒரு பெரிய இழப்பு: முதலில் புகைப்படம் அல்லது சாட்சியைச் சேர்க்கவும்.',
    notConnected: '{not} — பெரிய இழப்புக்குத் தலைமை அலுவலகத்தில் இரண்டாம் நபரின் அனுமதி தேவை, இந்தத் திரை தலைமை அலுவலகத்துடன் இணைக்கப்படவில்லை. பக்கத்தில் தட்டச்சு செய்த பெயர் அனுமதி ஆகாது, எனவே எதுவும் பதிவு செய்யப்படவில்லை.',
    notAsked: '{not} — இந்த இழப்புக்கு இன்னும் யாரிடமும் அனுமதி கேட்கப்படவில்லை. ஏன் என்று எழுதி, முதலில் “அனுமதி கேள்” அழுத்தவும்.',
    waiting: '{not} — சரக்கைக் கையாளும் இரண்டாம் நபர் (நீங்கள் அல்ல) தனது அனுமதிகள் பக்கத்தில் அனுமதிக்க இன்னும் காத்திருக்கிறது.',
    rejected: '{not} — {who} மறுத்தார்: “{reason}”. அவர் சொன்னதை மாற்றி மீண்டும் கேளுங்கள்.',
    rejectedNoName: '{not} — மறுக்கப்பட்டது: {reason} அவர் சொன்னதை மாற்றி மீண்டும் கேளுங்கள்.',
    expired: '{not} — பயன்படுத்தும் முன்பே அனுமதியின் நேரம் முடிந்துவிட்டது. மீண்டும் கேளுங்கள்.',
    used: '{not} — அந்த அனுமதி ஏற்கனவே ஒருமுறை பயன்படுத்தப்பட்டது. ஒரு அனுமதி ஒரு இழப்புக்கு மட்டுமே; மீண்டும் கேளுங்கள்.',
    changed: '{not} — அனுமதிக்கப்பட்ட இழப்பு சரியாக இது அல்ல (நீங்கள் கேட்ட பிறகு ஏதோ மாறிவிட்டது). இதற்கே மீண்டும் அனுமதி கேளுங்கள்.',
    checkerMayNot: '{not} — அனுமதித்தவர் இப்போது சரக்கைக் கையாளுபவர் அல்ல, எனவே அவரது அனுமதி செல்லாது. மீண்டும் கேளுங்கள்.',
    namedNotApproved: '{not} — ஒருவரின் பெயரைக் குறிப்பிடுவது அவரது அனுமதி ஆகாது. அனுமதி கேட்டு, இரண்டாம் நபர் தனது அனுமதிகள் பக்கத்தில் அனுமதிக்கும் வரை காத்திருங்கள்.',
    refused: '{not}: {words}', refusedNoWords: '{not} — தலைமை அலுவலகம் ஏற்கவில்லை.',
    lostLink: '{not} — தலைமை அலுவலகத்துடன் இணைப்பு இல்லை. எதுவும் சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    hoNeedsApproval: '{not} — தலைமை அலுவலகம் இதைப் பெரிய இழப்பாகக் கருதுகிறது, எனவே சரக்கைக் கையாளும் இரண்டாம் நபர் அதை அனுமதிக்க வேண்டும். ஏன் என்று எழுதி “அனுமதி கேள்” அழுத்தவும்.',
    hoNeedsEvidence: '{not} — தலைமை அலுவலகம் இதைப் பெரிய இழப்பாகக் கருதுகிறது: புகைப்படம் அல்லது சாட்சி தேவை, சரக்கைக் கையாளும் இரண்டாம் நபர் அதை அனுமதிக்கவும் வேண்டும். புகைப்படம் அல்லது சாட்சியைச் சேர்த்து, ஏன் என்று எழுதி “அனுமதி கேள்” அழுத்தவும்.',
    hoInvalid: '{not} — எழுதியபடி இந்த இழப்பைத் தலைமை அலுவலகம் ஏற்க முடியவில்லை. எத்தனை (பூஜ்ஜியத்திற்கு மேல் ஒரு முழு எண்) மற்றும் இழப்பின் வகையைச் சரிபார்க்கவும்.',
    hoNotOwned: '{not} — அந்த இடத்தில் உள்ள இந்தப் பொருளில் சில வேறொருவருக்குச் சொந்தமானவை (கூட்டாளர் கவுண்டர், சரக்கு-விற்பனை விநியோகஸ்தர் அல்லது வாடிக்கையாளர்). கடைக்குச் சொந்தமில்லாத சரக்கைக் கடை ஊழியர்கள் இழப்பாகக் கழிக்க முடியாது; அதன் உரிமையாளரே அந்த இழப்பைப் பதிவு செய்வார்.',
    hoAlready: 'இந்த இழப்பு ஏற்கனவே பதிவு செய்யப்பட்டது. மீண்டும் எதுவும் பதிவு செய்யப்படவில்லை.',
    hoValueIsStockCost: '{not} — இந்த மதிப்பு இந்தச் சரக்குக்கான தலைமை அலுவலகத்தின் தொகை அல்ல. பொருள், இடம், அளவை மீண்டும் உள்ளிட்டு தலைமை அலுவலகத்தின் மதிப்பைக் காட்டச் செய்து மீண்டும் பதிவு செய்யவும்.',
    hoCostUnknown: '{not} — இந்தச் சரக்குக்குத் தலைமை அலுவலகத்திடம் விலை இல்லை. நீங்கள் கருதும் மதிப்பை உள்ளிடவும் — புகைப்படம் அல்லது சாட்சியும் இரண்டாம் நபரின் அனுமதியும் தேவைப்படும்.',
    valueFromStock: 'தலைமை அலுவலகத்தின் மதிப்பு: {qty} × {unit} = {value}.',
    valueCostUnknown: 'இந்தச் சரக்குக்குத் தலைமை அலுவலகத்திடம் விலை இல்லை. நீங்கள் கருதும் மதிப்பை உள்ளிடவும் — மதிப்பு எதுவாக இருந்தாலும் இந்த இழப்புக்குப் புகைப்படம் அல்லது சாட்சியும் இரண்டாம் நபரின் அனுமதியும் தேவை.',
    valueLostLink: 'தலைமை அலுவலகம் பதிலளிக்கவில்லை, அதனால் மதிப்பைப் படிக்க முடியவில்லை. சிறிது நேரத்தில் மீண்டும் முயற்சிக்கவும்.',
    valueRefused: 'தலைமை அலுவலகம் இந்த இழப்பை மதிப்பிட முடியவில்லை: {words}',
    yourLossesTitle: 'நீங்கள் அனுமதி கேட்ட இழப்புகள்',
    yourLossesLead: 'ஒன்று அனுமதிக்கப்பட்டதும், “இந்த இழப்பைத் தொடரவும்” அழுத்தி அதே இழப்பைப் படிவத்தில் மீண்டும் கொண்டு வந்து, பிறகு “இழப்பைப் பதிவு செய்” அழுத்தவும்.',
    carryOnBtn: 'இந்த இழப்பைத் தொடரவும்',
    carriedOn: 'நீங்கள் கேட்ட அதே இழப்பு இப்போது படிவத்தில் உள்ளது.',
    whyWord: 'ஏன்:',
    scrReady: 'இழப்பைப் பதிவு செய்யத் தயார்',
    stateNotPermitted: 'இழப்பைப் பதிவு செய்ய உங்களுக்கு அனுமதி இல்லை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(WRITE_OFF_CAPTURE_COPY.en) as CopyKey[]);

/** The bilingual label each loss type wears (the chosen chip). */
export const LOSS_LABEL: Readonly<Record<LossType, CopyKey>> = {
  wastage: 'lossWastage', damage: 'lossDamage', expiry: 'lossExpiry', donation: 'lossDonation', destruction: 'lossDestruction',
};

/** Head office's write-off refusals, each with its words. */
const REFUSAL_COPY: Readonly<Record<WriteOffRefusalCode, CopyKey>> = Object.freeze({
  write_off_needs_approval: 'hoNeedsApproval',
  write_off_needs_evidence: 'hoNeedsEvidence',
  invalid_write_off: 'hoInvalid',
  stock_not_owned_by_the_store: 'hoNotOwned',
  write_off_already_recorded: 'hoAlready',
  write_off_value_is_the_stock_cost: 'hoValueIsStockCost',
  write_off_cost_unknown: 'hoCostUnknown',
});

const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);

/** A refusal from the write-off route: head office's write-off codes in plain words, the engine's approval codes the
 *  same way every screen reads them (`useOutcomeOfRefusal`), anything else in head office's own words. */
export function writeOffOutcomeOfRefusal(code: string, whatHappened: string): WriteOffRecordOutcome {
  if ((WRITE_OFF_REFUSAL_CODES as readonly string[]).includes(code)) {
    return { kind: 'head_office_refused', code: code as WriteOffRefusalCode, whatHappened };
  }
  const o = useOutcomeOfRefusal(code, whatHappened);
  // `useOutcomeOfRefusal` never answers "done" or "cannot check"; a refusal is never read as success.
  if (o.kind === 'done' || o.kind === 'cannot_check') return { kind: 'refused', code, whatHappened };
  return o;
}

/** Where an ask stands, in words — tone + icon + words, never colour alone. */
export function presentWriteOffAsk(lang: Lang, o: WriteOffAskOutcome): StatusPresentation {
  const t = translator(WRITE_OFF_CAPTURE_COPY, lang);
  const err = (label: string): StatusPresentation => presentStatus({ tone: 'error', icon: '✕', label, needsAttention: true });
  switch (o.kind) {
    // Waiting is a pending state — a person has to come back to it — with its own icon and words.
    case 'asked': return presentScreenState({ state: 'pending', label: `${t('asked')} ${o.request.summary}` });
    case 'not_permitted': return err(t('stateNotPermitted'));
    case 'incomplete': return err(t('askIncomplete'));
    case 'not_material': return presentStatus({ tone: 'idle', icon: 'ℹ', label: t('askNotMaterial'), needsAttention: false });
    case 'needs_evidence': return presentStatus({ tone: 'degraded', icon: '📷', label: t('askNeedsEvidence'), needsAttention: true });
    case 'needs_why': return err(t('askNeedsWhy'));
    case 'not_connected': return err(t('askNotConnected'));
    case 'refused': return err(o.whatHappened.trim() === '' ? t('askRefusedNoWords') : `${t('askRefused')} ${o.whatHappened.trim()}`);
    case 'lost_link': return presentStatus({ tone: 'degraded', icon: '⚠', label: t('askLostLink'), needsAttention: true });
  }
}

/** Where recording stands, in words. */
export function presentWriteOffRecord(lang: Lang, o: WriteOffRecordOutcome): StatusPresentation {
  const t = translator(WRITE_OFF_CAPTURE_COPY, lang);
  const not = t('notRecorded');
  const say = (key: CopyKey, values: Readonly<Record<string, string>> = {}): string => fill(t(key), { not, ...values });
  const err = (label: string): StatusPresentation => presentStatus({ tone: 'error', icon: '✕', label, needsAttention: true });
  const warn = (label: string): StatusPresentation => presentStatus({ tone: 'degraded', icon: '⚠', label, needsAttention: true });
  switch (o.kind) {
    case 'recorded':
      return presentStatus({ tone: 'ok', icon: '✓', needsAttention: false,
        label: o.approvedBy === null ? t('recorded') : say('recordedApproved', { who: o.approvedBy.trim() === '' ? t('someone') : o.approvedBy }) });
    case 'not_permitted': return err(say('notPermitted'));
    case 'incomplete': return err(say('incomplete'));
    case 'needs_evidence': return presentStatus({ tone: 'degraded', icon: '📷', label: say('needsEvidence'), needsAttention: true });
    case 'not_connected': return err(say('notConnected'));
    case 'not_asked': return warn(say('notAsked'));
    case 'waiting': return presentScreenState({ state: 'pending', label: say('waiting') });
    case 'rejected': {
      const reason = o.reason.trim() === '' ? '—' : o.reason.trim();
      return err(o.decidedBy === null || o.decidedBy.trim() === ''
        ? say('rejectedNoName', { reason })
        : say('rejected', { who: o.decidedBy, reason }));
    }
    case 'expired': return warn(say('expired'));
    case 'used': return warn(say('used'));
    case 'changed': return warn(say('changed'));
    case 'checker_may_not_approve': return err(say('checkerMayNot'));
    case 'named_not_approved': return err(say('namedNotApproved'));
    case 'head_office_refused':
      // Already recorded is not a failure — the loss is in the books once; nothing was recorded twice.
      if (o.code === 'write_off_already_recorded') return presentStatus({ tone: 'degraded', icon: 'ℹ', label: t('hoAlready'), needsAttention: false });
      if (o.code === 'write_off_needs_approval') return warn(say('hoNeedsApproval'));
      if (o.code === 'write_off_needs_evidence') return presentStatus({ tone: 'degraded', icon: '📷', label: say('hoNeedsEvidence'), needsAttention: true });
      return err(say(REFUSAL_COPY[o.code]));
    case 'refused': return err(o.whatHappened.trim() === '' ? say('refusedNoWords') : say('refused', { words: o.whatHappened.trim() }));
    case 'lost_link': return warn(say('lostLink'));
  }
}

/** The loss a request was asked for, read back from its details — or null when they cannot be read as one. */
export function draftOfDetails(writeOffId: string, details: Readonly<Record<string, unknown>>): WriteOffDraft | null {
  const s = (k: string): string | undefined => (typeof details[k] === 'string' && (details[k] as string).trim() !== '' ? details[k] as string : undefined);
  const productId = s('productId');
  const locationId = s('locationId');
  const uom = s('uom');
  const reasonCode = s('reasonCode');
  const lossType = LOSS_TYPES.find((lt) => lt === details['lossType']);
  const qty = details['qty'];
  const valueMinor = details['valueMinor'];
  if (writeOffId.trim() === '' || productId === undefined || locationId === undefined || uom === undefined || reasonCode === undefined
    || lossType === undefined || !isPosInt(qty) || !isNonNegInt(valueMinor)) return null;
  const evidenceRef = s('evidenceRef');
  return {
    writeOffId, productId, locationId, qty, uom, lossType, valueMinor, reasonCode,
    ...(evidenceRef === undefined ? {} : { evidenceRef }),
  };
}

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

/** One loss-type choice for the chips — a value the operator picks, never typed. */
export interface LossTypeChoice {
  readonly lossType: LossType;
  readonly label: string;
}

export interface WriteOffCaptureView {
  readonly screenState: StatusPresentation;
  /** The loss-type chips, in the tested engine's order. */
  readonly lossTypes: readonly LossTypeChoice[];
  /** The material-loss threshold, formatted for the "big loss" hint. */
  readonly thresholdMinor: number;
  readonly thresholdText: string;
  readonly nobodyNamed: boolean;
  /** Whether to offer the record action — this user holds `inventory.movement.append`. */
  readonly mayCapture: boolean;
}

export interface WriteOffCaptureSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): WriteOffCaptureView;
  /** Whether a loss of this value is MATERIAL (needs evidence + a second person's approval). Judged on the injected
   *  tenant threshold — the same line the server enforces. */
  isMaterial(valueMinor: number): boolean;
  /** Whether THIS loss needs a second person's approval: material by the store limit — or head office already said
   *  so for this write-off (its limit is the authority, and may differ from the one this page was told). */
  needsApproval(loss: { readonly writeOffId: string; readonly valueMinor: number; readonly productId?: string; readonly locationId?: string; readonly qty?: number }): boolean;
  /** SF-05 — ask head office what this loss is worth (quantity × its own cost of the stock). Read only. The screen shows the
   *  figure and sends it; where head office holds no cost the value is typed and the loss always needs a second person. */
  valueLoss(q: LossToValue): Promise<LossValueOutcome>;
  /** Head office's value in words — `null` when there is nothing to say yet (an incomplete form, no head office). */
  presentValue(lang: Lang, outcome: LossValueOutcome): StatusPresentation | null;
  /** True when this screen is wired to head office's approval engine. Without it a big loss is never recorded. */
  readonly connected: boolean;
  /** The raiser asks a second person who handles stock to approve exactly this loss (`stock_write_off`, details
   *  `writeOffDetails`) in their own session. Refused locally — nothing asked — without permission, with an
   *  incomplete form, for a loss below the limit, without evidence, without a written reason, or with no head office. */
  askApproval(lang: Lang, draft: WriteOffDraft, why: string): Promise<WriteOffAskOutcome>;
  /** Record a loss, in the raiser's own name — a HUMAN write (§28, append-only). Runs only from an explicit action,
   *  never on render. Below the limit it is sent as it is; a big loss is sent only naming the raiser's own APPROVED
   *  request for exactly this loss — otherwise it says why not, and nothing is sent. */
  record(draft: WriteOffDraft): Promise<WriteOffRecordOutcome>;
  /** The raiser's own write-off requests still in play — so a loss asked about earlier (another visit, another day)
   *  can be carried on with exactly as it was asked. A GET — read only. */
  yourLosses(lang: Lang): Promise<LossRequestsView>;
  presentAskOutcome(lang: Lang, outcome: WriteOffAskOutcome): StatusPresentation;
  presentRecordOutcome(lang: Lang, outcome: WriteOffRecordOutcome): StatusPresentation;
}

/** A draft that is complete enough to send at all (before the materiality and approval checks). */
function isWellFormed(d: WriteOffDraft): boolean {
  return isNonEmpty(d.writeOffId) && isNonEmpty(d.productId) && isNonEmpty(d.locationId)
    && isNonEmpty(d.uom) && isPosInt(d.qty) && isNonNegInt(d.valueMinor)
    && LOSS_TYPES.includes(d.lossType);
}

/** How many of the raiser's own requests "Losses you asked approval for" shows — the newest. */
const MAX_LISTED = 10;

export function createWriteOffCaptureSession(config: WriteOffCaptureConfig, ports: WriteOffCapturePorts): WriteOffCaptureSession {
  const text = (lang: Lang, key: CopyKey): string => translator(WRITE_OFF_CAPTURE_COPY, lang)(key);
  const isMaterial = (valueMinor: number): boolean => valueMinor >= config.materialThresholdMinor;
  const connected = ports.askApproval !== undefined && ports.approvalInbox !== undefined;
  /** Write-offs head office called big although this page's limit did not (its limit is the one that counts). */
  const bigAtHeadOffice = new Set<string>();
  /** SF-05 — losses head office valued as big, and stock it holds no cost for (always big), by product|place[|qty]. */
  const bigByValue = new Set<string>();
  const costUnknown = new Set<string>();
  const placeKey = (productId: string, locationId: string): string => `${productId.trim()}\u001f${locationId.trim()}`;
  const needsApproval = (loss: { readonly writeOffId: string; readonly valueMinor: number; readonly productId?: string; readonly locationId?: string; readonly qty?: number }): boolean => {
    if (isMaterial(loss.valueMinor) || bigAtHeadOffice.has(loss.writeOffId.trim())) return true;
    if (loss.productId === undefined || loss.locationId === undefined) return false;
    const at = placeKey(loss.productId, loss.locationId);
    return costUnknown.has(at) || (loss.qty !== undefined && bigByValue.has(`${at}\u001f${loss.qty}`));
  };
  const draftNeedsApproval = (d: WriteOffDraft): boolean => needsApproval({ writeOffId: d.writeOffId, valueMinor: d.valueMinor, productId: d.productId, locationId: d.locationId, qty: d.qty });

  /** Send the loss (naming an approval when it has one) and read head office's answer. */
  const send = async (writeOffId: string, body: WriteOffBody, approval?: { readonly requestId: string; readonly decidedBy: string | null }): Promise<WriteOffRecordOutcome> => {
    const r = await ports.capturePort().post({ writeOffId, body, ...(approval === undefined ? {} : { approvalId: approval.requestId }) });
    if (r.result === 'recorded') return { kind: 'recorded', approvedBy: approval === undefined ? null : approval.decidedBy ?? '' };
    if (r.result === 'lost_link') return { kind: 'lost_link' };
    // Head office's limit is the authority: once it calls this loss big, this page asks for approval for it too.
    if (r.code === 'write_off_needs_approval' || r.code === 'write_off_needs_evidence') bigAtHeadOffice.add(writeOffId);
    return writeOffOutcomeOfRefusal(r.code, r.whatHappened);
  };

  return {
    text,
    isMaterial,
    needsApproval,
    connected,

    view: (lang) => {
      const t = translator(WRITE_OFF_CAPTURE_COPY, lang);
      const mayCapture = ports.mayCapture();
      const nobodyNamed = config.userId === null;
      if (!mayCapture) {
        return {
          screenState: presentScreenState({ state: 'error', label: t('stateNotPermitted') }),
          lossTypes: [], thresholdMinor: config.materialThresholdMinor, thresholdText: formatRupees(config.materialThresholdMinor),
          nobodyNamed, mayCapture,
        };
      }
      return {
        screenState: presentScreenState({ state: 'ready', label: t('scrReady') }),
        lossTypes: LOSS_TYPES.map((lt) => ({ lossType: lt, label: t(LOSS_LABEL[lt]) })),
        thresholdMinor: config.materialThresholdMinor,
        thresholdText: formatRupees(config.materialThresholdMinor),
        nobodyNamed,
        mayCapture,
      };
    },

    // The RAISER's step for a big loss: ask for exactly the loss that will be sent. Nothing is recorded by asking.
    askApproval: async (lang, draft, why) => {
      if (!ports.mayCapture()) return { kind: 'not_permitted' };
      if (!isWellFormed(draft)) return { kind: 'incomplete' };
      if (!draftNeedsApproval(draft)) return { kind: 'not_material' };
      const port = ports.askApproval;
      if (!connected || port === undefined) return { kind: 'not_connected' };
      const body = writeOffBodyOf(draft);
      if (body.evidenceRef === undefined) return { kind: 'needs_evidence' };
      if (why.trim().length < MIN_REASON_LENGTH) return { kind: 'needs_why' };
      const writeOffId = draft.writeOffId.trim();
      const t = translator(WRITE_OFF_CAPTURE_COPY, lang);
      const lossWord = t(LOSS_LABEL[body.lossType]);
      const summary = fill(t('summaryLoss'), {
        qty: body.uom === 'ea' ? String(body.qty) : `${body.qty} ${body.uom}`,
        product: body.productId,
        loss: lang === 'en' ? lossWord.toLowerCase() : lossWord,
        value: formatRupees(body.valueMinor),
      });
      const asked = await port({
        kind: WRITE_OFF_APPROVAL_KIND, subjectRef: writeOffId,
        // EXACTLY the body the record will send plus the write-off's id — what the route fingerprints.
        details: writeOffDetails(writeOffId, body), valueMinor: body.valueMinor,
        summary, reason: why.trim(),
      });
      if (asked.result === 'asked') return { kind: 'asked', request: asked.request };
      if (asked.result === 'lost_link') return { kind: 'lost_link' };
      return { kind: 'refused', code: asked.code, whatHappened: asked.whatHappened };
    },

    // Record a loss. Below the limit it goes as it is (head office re-checks the limit). A big loss goes only naming
    // the raiser's own APPROVED request for exactly this loss — never a typed approver, and never without head office.
    record: async (draft) => {
      if (!ports.mayCapture()) return { kind: 'not_permitted' };
      if (!isWellFormed(draft)) return { kind: 'incomplete' };
      const writeOffId = draft.writeOffId.trim();
      const body = writeOffBodyOf(draft);
      if (!draftNeedsApproval(draft)) return send(writeOffId, body);
      if (!connected) return { kind: 'not_connected' };
      if (body.evidenceRef === undefined) return { kind: 'needs_evidence' };
      const found = await findOwnApproval(ports.approvalInbox, WRITE_OFF_APPROVAL_KIND, writeOffId, writeOffDetails(writeOffId, body), body.valueMinor);
      if (!('requestId' in found)) return found.kind === 'done' || found.kind === 'cannot_check' ? { kind: 'not_asked' } : found;
      return send(writeOffId, body, found);
    },

    yourLosses: async (lang) => {
      if (!ports.mayCapture()) return { state: 'not_permitted', rows: [] };
      if (!connected || ports.approvalInbox === undefined) return { state: 'not_connected', rows: [] };
      const read = await ports.approvalInbox();
      if (read.result !== 'read') return { state: read.result, rows: [] };
      // One row per write-off: its newest request. A loss whose approval was used is recorded — history, not listed.
      const newest = new Map<string, ApprovalRequestView>();
      for (const r of read.inbox.mine) {
        if (r.kind !== WRITE_OFF_APPROVAL_KIND || r.subjectRef.trim() === '') continue;
        const seen = newest.get(r.subjectRef);
        if (seen === undefined || r.requestedAt.localeCompare(seen.requestedAt) > 0) newest.set(r.subjectRef, r);
      }
      const rows = [...newest.values()]
        .filter((r) => r.status !== 'used')
        .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
        .slice(0, MAX_LISTED)
        .map((r): LossRequestRow => ({
          requestId: r.requestId, writeOffId: r.subjectRef, summary: r.summary, why: r.reason, askedAt: shopTime(r.requestedAt),
          status: presentRequestStatus(lang, r), approvalStatus: r.status, draft: draftOfDetails(r.subjectRef, r.details),
        }));
      return { state: 'read', rows };
    },

    valueLoss: async (q) => {
      if (!isNonEmpty(q.productId) || !isNonEmpty(q.locationId) || !isPosInt(q.qty)) return { kind: 'incomplete' };
      if (ports.readLossValue === undefined) return { kind: 'not_connected' };
      const read = await ports.readLossValue({ productId: q.productId.trim(), locationId: q.locationId.trim(), qty: q.qty });
      if (read.result === 'lost_link') return { kind: 'lost_link' };
      if (read.result === 'refused') return { kind: 'refused', whatHappened: read.whatHappened };
      const at = placeKey(q.productId, q.locationId);
      if (!read.known) { costUnknown.add(at); return { kind: 'cost_unknown' }; }
      costUnknown.delete(at);
      if (read.material) bigByValue.add(`${at}\u001f${q.qty}`);
      return { kind: 'valued', qty: q.qty, unitCostMinor: read.unitCostMinor, valueMinor: read.valueMinor, material: read.material };
    },
    presentValue: (lang, o) => {
      const t = translator(WRITE_OFF_CAPTURE_COPY, lang);
      switch (o.kind) {
        case 'valued':
          return presentStatus({ tone: 'ok', icon: '₹', needsAttention: false,
            label: fill(t('valueFromStock'), { qty: String(o.qty), unit: formatRupees(o.unitCostMinor), value: formatRupees(o.valueMinor) }) });
        case 'cost_unknown': return presentStatus({ tone: 'degraded', icon: '⚠', label: t('valueCostUnknown'), needsAttention: true });
        case 'lost_link': return presentStatus({ tone: 'degraded', icon: '⚠', label: t('valueLostLink'), needsAttention: true });
        case 'refused': return presentStatus({ tone: 'error', icon: '✕', label: fill(t('valueRefused'), { words: o.whatHappened.trim() }), needsAttention: true });
        case 'incomplete': case 'not_connected': return null;
      }
    },
    presentAskOutcome: (lang, outcome) => presentWriteOffAsk(lang, outcome),
    presentRecordOutcome: (lang, outcome) => presentWriteOffRecord(lang, outcome),
  };
}
