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
}

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
  | { readonly outcome: 'returned' | 'already_returned' | 'lost_link' | 'not_permitted' | 'no_link' | 'line_unknown' | 'not_awaiting' | 'needs_count' | 'reason_missing' }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface GoodsReceiptSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): GoodsReceiptView;
  /** Batch 2 — record that a disposed line has gone back to the supplier: an online write under the reader's session. */
  recordReturn(input: { readonly grnId: string; readonly lineId: string; readonly reason: string }): Promise<LineReturnOutcome>;
  presentReturnOutcome(lang: Lang, outcome: LineReturnOutcome): StatusPresentation;
}

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
  const presentReturnLine = (lang: Lang, l: GrnReturnLineView): PresentedReturnLine => {
    const t = translator(GOODS_RECEIPT_COPY, lang);
    return { ...l, stateLabel: t(l.state === 'returned' ? 'returnGone' : l.needsCount ? 'returnNeedsCount' : 'returnAwaiting'), quantityLabel: quantityForPerson(l.quantityMinor, l.uom) };
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
          returnLines: (g.returnLines ?? []).map((l) => presentReturnLine(lang, l)),
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
          ? receipts.flatMap((r) => r.returnLines.filter((l) => l.state === 'awaiting_return' && !l.needsCount).map((line) => ({ grnId: r.grnId, number: r.number, line })))
          : [],
      };
    },
  };
}
