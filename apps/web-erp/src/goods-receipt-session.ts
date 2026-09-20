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
// what this hands over. It is READ-ONLY: no capture, no approval, no write path (capture is the handheld's, and
// the §28 approval is a downstream action) — hard rule #5 does not arise, nothing here commits anything.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';
import type { DiscrepancyKind } from '../../../packages/receiving/src/index';

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
  | 'dkShort' | 'dkExcess' | 'dkDamaged' | 'dkQcFailed' | 'dkExpired' | 'dkNearExpiry' | 'dkMrpMismatch' | 'dkTemperatureBreach'
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
  expired: 'dkExpired', near_expiry: 'dkNearExpiry', mrp_mismatch: 'dkMrpMismatch', temperature_breach: 'dkTemperatureBreach',
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
}

export interface GoodsReceiptView {
  readonly screenState: StatusPresentation;
  readonly asOf: string | null;
  /** Worst-first deliveries — this is the primary list the shell renders. */
  readonly receipts: readonly PresentedReceipt[];
  readonly count: number;
  readonly needingApprovalCount: number;
  readonly nobodyNamed: boolean;
}

export interface GoodsReceiptSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): GoodsReceiptView;
}

export function createGoodsReceiptSession(config: GoodsReceiptConfig, ports: GoodsReceiptPorts): GoodsReceiptSession {
  const text = (lang: Lang, key: CopyKey): string => translator(GOODS_RECEIPT_COPY, lang)(key);

  return {
    text,
    view: (lang) => {
      const t = translator(GOODS_RECEIPT_COPY, lang);
      const nobodyNamed = config.userId === null;

      if (!ports.mayRead()) {
        return {
          screenState: presentScreenState({ state: 'error', label: t('stateNotPermitted') }),
          asOf: null, receipts: [], count: 0, needingApprovalCount: 0, nobodyNamed,
        };
      }

      const data = ports.snapshot();
      if (data.receipts === undefined) {
        return {
          screenState: presentScreenState({ state: 'empty', label: t('scrEmpty') }),
          asOf: null, receipts: [], count: 0, needingApprovalCount: 0, nobodyNamed,
        };
      }
      if (data.receipts.length === 0) {
        return {
          screenState: presentScreenState({ state: 'empty', label: t('scrNoReceipts') }),
          asOf: data.asAt ?? null, receipts: [], count: 0, needingApprovalCount: 0, nobodyNamed,
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
        };
      });

      return {
        screenState: presentScreenState({ state: 'ready', label: t('scrReady') }),
        asOf: data.asAt ?? null,
        receipts,
        count: receipts.length,
        needingApprovalCount: receipts.filter((r) => r.needsApproval).length,
        nobodyNamed,
      };
    },
  };
}
