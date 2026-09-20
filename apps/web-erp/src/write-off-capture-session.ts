// The write-off CAPTURE screen — the shop-floor "record a loss" desk (M28-FR-01 · API-04 · §28 · P-02
// one truth · P-03 control-by-exception · hard rules #2/#5). The read-only /waste review screen shows losses
// already recorded; THIS is the write-capable sibling that records one, in the raiser's own name, posting to
// the governed write-off route (`POST /v1/inventory/write-off/:id`) — the SINGLE door for a stock loss, which
// reduces on-hand AND values the loss for finance.
//
// Every money/stock rule lives server-side in the tested engine + route (the material-loss threshold is the
// tenant's policy, not the body; a material loss needs captured evidence AND a separate approver who genuinely
// holds Manager/Owner authority; the raiser is the authenticated caller). This DOM-free session model holds NO
// such rule of its own — it shapes the operator's choices into the request, and, as defence-in-depth that
// mirrors the server, refuses BEFORE any POST the cases the operator can see are wrong: no permission, an
// incomplete form, or a MATERIAL loss with no evidence / no separate approver / the raiser approving their own
// loss (§28). The server re-checks all of it; the screen never fabricates an approver or an evidence reference,
// and no AI records a loss (hard rule #5).
//
// Like every ERP screen the rules are here on the shared packages/ui + packages/a11y primitives (colour is
// never the only signal — an icon and a word ride with every tone), English and Tamil from ONE copy object,
// and the shell only renders what this hands over.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';
import type { LossType } from '../../../packages/waste/src/waste';

/** The five kinds of loss the tested engine knows — the chosen categorisation, never free text (M15). */
export const LOSS_TYPES: readonly LossType[] = ['wastage', 'damage', 'expiry', 'donation', 'destruction'];

/** ₹ from paise — a small local presenter (the shell shows the threshold and the loss value). */
export function formatRupees(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}₹${Math.floor(abs / 100).toLocaleString('en-IN')}.${String(abs % 100).padStart(2, '0')}`;
}

/** What the operator has assembled before recording a loss. The raiser is NOT here — it is the authenticated
 *  caller server-side, so a loss can never be recorded in someone else's name. */
export interface WriteOffDraft {
  /** The loss's operation identity (idempotency key — a re-send under the same id records once). */
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
  /** A separate approver for a material loss (§28) — never the raiser. */
  readonly approval?: { readonly by: string };
}

/** The outcome of recording a loss — mirrors the write-off route's answers, mapped to screen states. */
export type CaptureResult =
  | 'recorded'
  | 'needs_evidence'
  | 'needs_approval'
  | 'approver_not_authorised'
  | 'conflict'
  | 'refused'
  | 'lost_link';

/** The authenticated POST of a write-off. Injected, so the model never opens a socket itself; the server
 *  records the loss in the caller's own name and enforces the threshold/evidence/approver rules. */
export interface WriteOffCapturePort {
  post(input: {
    readonly writeOffId: string;
    readonly productId: string;
    readonly locationId: string;
    readonly qty: number;
    readonly uom: string;
    readonly lossType: LossType;
    readonly reasonCode: string;
    readonly valueMinor: number;
    readonly evidenceRef?: string;
    readonly approvedBy?: string;
  }): Promise<CaptureResult>;
}

export interface WriteOffCapturePorts {
  /** Whether this user may record a loss (`inventory.movement.append`). */
  mayCapture(): boolean;
  /** Records a loss. Only reached from the explicit action, never on render. */
  capturePort(): WriteOffCapturePort;
}

export interface WriteOffCaptureConfig {
  /** Who is at the screen. `null` means the store computer was not told; a loss carries the raiser's name,
   *  so the screen surfaces when nobody is named. */
  readonly userId: string | null;
  /** The tenant's material-loss threshold in paise (the value at/above which evidence + a §28 approver are
   *  needed). Injected policy, sourced from the pack — never invented here (the server is the authority). */
  readonly materialThresholdMinor: number;
}

// ── the copy: ONE bilingual object for the whole screen ───────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'lossWastage' | 'lossDamage' | 'lossExpiry' | 'lossDonation' | 'lossDestruction'
  | 'productLabel' | 'qtyLabel' | 'valueLabel' | 'lossTypeLabel' | 'evidenceLabel' | 'approverLabel'
  | 'recordBtn'
  | 'materialHint' | 'immaterialHint' | 'thresholdLabel'
  | 'recorded' | 'needsEvidence' | 'needsApproval' | 'approverNotAuthorised' | 'conflict' | 'refused' | 'lostLink'
  | 'scrReady' | 'stateNotPermitted' | 'nobodyNamed';

export const WRITE_OFF_CAPTURE_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Record a loss', langName: 'தமிழ்',
    lead: 'Record stock that is leaving as a loss — wastage, damage, expiry, a donation or a destruction. It reduces the shelf figure and values the loss. A big loss (at or above the store limit) needs a photo or witness AND a different person to approve it — you cannot approve your own loss.',
    lossWastage: 'Wastage', lossDamage: 'Damage', lossExpiry: 'Expired', lossDonation: 'Donation', lossDestruction: 'Destruction',
    productLabel: 'Which item', qtyLabel: 'How many', valueLabel: 'What it is worth', lossTypeLabel: 'What kind of loss',
    evidenceLabel: 'Photo or witness (for a big loss)', approverLabel: 'Manager approving (a different person)',
    recordBtn: 'Record the loss',
    materialHint: 'This is a big loss — it needs a photo or witness and a manager to approve it.',
    immaterialHint: 'This loss is small enough to record on your own.',
    thresholdLabel: 'A loss is "big" at or above',
    recorded: 'Loss recorded. The shelf figure has come down.',
    needsEvidence: 'This is a big loss — capture a photo or witness before recording it.',
    needsApproval: 'This is a big loss — a different person (a manager) must approve it. You cannot approve your own.',
    approverNotAuthorised: 'That person cannot approve a loss. Ask a manager or the owner.',
    conflict: 'This loss was already recorded. Nothing was recorded again.',
    refused: 'Could not record the loss — check the item, quantity and value, and your permission.',
    lostLink: 'No connection — not saved. Try again.',
    scrReady: 'Ready to record a loss',
    stateNotPermitted: 'You do not have permission to record a loss.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
  },
  ta: {
    title: 'இழப்பைப் பதிவு செய்', langName: 'English',
    lead: 'இழப்பாக வெளியேறும் பொருளைப் பதிவு செய்யவும் — கழிவு, சேதம், காலாவதி, நன்கொடை அல்லது அழிப்பு. இது அலமாரி எண்ணிக்கையைக் குறைத்து இழப்பை மதிப்பிடும். பெரிய இழப்புக்கு (கடை வரம்பிற்குச் சமமாக அல்லது அதற்கு மேல்) புகைப்படம் அல்லது சாட்சி மற்றும் அதை அனுமதிக்க வேறு ஒருவர் தேவை — உங்கள் சொந்த இழப்பை நீங்கள் அனுமதிக்க முடியாது.',
    lossWastage: 'கழிவு', lossDamage: 'சேதம்', lossExpiry: 'காலாவதி', lossDonation: 'நன்கொடை', lossDestruction: 'அழிப்பு',
    productLabel: 'எந்தப் பொருள்', qtyLabel: 'எத்தனை', valueLabel: 'மதிப்பு', lossTypeLabel: 'எந்த வகை இழப்பு',
    evidenceLabel: 'புகைப்படம் அல்லது சாட்சி (பெரிய இழப்புக்கு)', approverLabel: 'அனுமதிக்கும் மேலாளர் (வேறு ஒருவர்)',
    recordBtn: 'இழப்பைப் பதிவு செய்',
    materialHint: 'இது ஒரு பெரிய இழப்பு — புகைப்படம் அல்லது சாட்சி மற்றும் அதை அனுமதிக்க ஒரு மேலாளர் தேவை.',
    immaterialHint: 'இந்த இழப்பு நீங்களே பதிவு செய்யும் அளவுக்குச் சிறியது.',
    thresholdLabel: 'இதற்குச் சமமாக அல்லது அதற்கு மேல் ஒரு இழப்பு "பெரியது"',
    recorded: 'இழப்பு பதிவு செய்யப்பட்டது. அலமாரி எண்ணிக்கை குறைந்தது.',
    needsEvidence: 'இது ஒரு பெரிய இழப்பு — பதிவு செய்வதற்கு முன் புகைப்படம் அல்லது சாட்சியைப் பிடிக்கவும்.',
    needsApproval: 'இது ஒரு பெரிய இழப்பு — வேறு ஒருவர் (ஒரு மேலாளர்) அனுமதிக்க வேண்டும். உங்கள் சொந்ததை நீங்கள் அனுமதிக்க முடியாது.',
    approverNotAuthorised: 'அந்த நபர் ஒரு இழப்பை அனுமதிக்க முடியாது. ஒரு மேலாளர் அல்லது உரிமையாளரிடம் கேளுங்கள்.',
    conflict: 'இந்த இழப்பு ஏற்கனவே பதிவு செய்யப்பட்டது. மீண்டும் எதுவும் பதிவு செய்யப்படவில்லை.',
    refused: 'இழப்பைப் பதிவு செய்ய முடியவில்லை — பொருள், எண்ணிக்கை, மதிப்பு மற்றும் உங்கள் அனுமதியைச் சரிபார்க்கவும்.',
    lostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
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
  /** Whether a loss of this value is MATERIAL (needs evidence + a §28 approver). Judged on the injected
   *  tenant threshold — the same line the server enforces. */
  isMaterial(valueMinor: number): boolean;
  /** Record a loss, in the raiser's own name — a HUMAN write (§28, append-only). Runs only from an explicit
   *  action, never on render. Refuses BEFORE any POST: no permission, an incomplete form, or a material loss
   *  with no evidence / no separate approver / the raiser approving their own (the server re-checks all of it). */
  record(draft: WriteOffDraft): Promise<CaptureResult>;
  /** Present a record outcome as one glanceable status the shell shows after the action. */
  presentResult(lang: Lang, result: CaptureResult): StatusPresentation;
}

const isNonEmpty = (v: string | undefined | null): v is string => typeof v === 'string' && v.trim() !== '';
const isPosInt = (v: number): boolean => Number.isInteger(v) && v > 0;
const isNonNegInt = (v: number): boolean => Number.isInteger(v) && v >= 0;

/** A draft that is complete enough to POST at all (before the §28/materiality checks). */
function isWellFormed(d: WriteOffDraft): boolean {
  return isNonEmpty(d.writeOffId) && isNonEmpty(d.productId) && isNonEmpty(d.locationId)
    && isNonEmpty(d.uom) && isPosInt(d.qty) && isNonNegInt(d.valueMinor)
    && LOSS_TYPES.includes(d.lossType);
}

export function createWriteOffCaptureSession(config: WriteOffCaptureConfig, ports: WriteOffCapturePorts): WriteOffCaptureSession {
  const text = (lang: Lang, key: CopyKey): string => translator(WRITE_OFF_CAPTURE_COPY, lang)(key);
  const isMaterial = (valueMinor: number): boolean => valueMinor >= config.materialThresholdMinor;

  return {
    text,
    isMaterial,

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

    // Record a loss. Refuse BEFORE any POST — no permission, an incomplete form, or a material loss missing
    // its evidence / separate approver is a local refusal, not a round trip. The server re-checks everything;
    // the screen never fabricates an approver or an evidence reference.
    record: async (draft) => {
      if (!ports.mayCapture() || !isWellFormed(draft)) return 'refused';
      if (isMaterial(draft.valueMinor)) {
        if (!isNonEmpty(draft.evidenceRef)) return 'needs_evidence';
        const approver = draft.approval?.by;
        // §28: a material loss needs a SEPARATE approver — absent, or the raiser approving their own, is refused
        // here (the server re-verifies the approver genuinely holds Manager/Owner authority).
        if (!isNonEmpty(approver) || approver.trim() === (config.userId ?? '').trim()) return 'needs_approval';
      }
      return ports.capturePort().post({
        writeOffId: draft.writeOffId.trim(), productId: draft.productId.trim(), locationId: draft.locationId.trim(),
        qty: draft.qty, uom: draft.uom.trim(), lossType: draft.lossType,
        // The loss type IS the chosen reason categorisation; a finer reasonCode overrides it when supplied.
        reasonCode: isNonEmpty(draft.reasonCode) ? draft.reasonCode.trim() : draft.lossType,
        valueMinor: draft.valueMinor,
        ...(isNonEmpty(draft.evidenceRef) ? { evidenceRef: draft.evidenceRef.trim() } : {}),
        ...(isNonEmpty(draft.approval?.by) ? { approvedBy: draft.approval!.by.trim() } : {}),
      });
    },

    presentResult: (lang, result) => {
      const t = translator(WRITE_OFF_CAPTURE_COPY, lang);
      switch (result) {
        case 'recorded':
          return presentStatus({ tone: 'ok', icon: '✓', label: t('recorded'), needsAttention: false });
        case 'lost_link':
          return presentStatus({ tone: 'degraded', icon: '⚠', label: t('lostLink'), needsAttention: true });
        case 'needs_evidence':
          return presentStatus({ tone: 'degraded', icon: '📷', label: t('needsEvidence'), needsAttention: true });
        case 'needs_approval':
          return presentStatus({ tone: 'degraded', icon: '⚠', label: t('needsApproval'), needsAttention: true });
        case 'approver_not_authorised':
          return presentStatus({ tone: 'error', icon: '✕', label: t('approverNotAuthorised'), needsAttention: true });
        case 'conflict':
          return presentStatus({ tone: 'degraded', icon: 'ℹ', label: t('conflict'), needsAttention: false });
        default:
          return presentStatus({ tone: 'error', icon: '✕', label: t('refused'), needsAttention: true });
      }
    },
  };
}
