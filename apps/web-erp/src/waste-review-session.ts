// Waste & write-off review — the shrinkage triage view (M28-FR-01; §19 · §27 · P-03 control by exception).
// M28 built the tested write-off engine (`packages/waste/src/waste.ts`): a loss (wastage, damage, expiry,
// donation, destruction) is a reason-coded COMPENSATING stock movement, valued for finance, and a MATERIAL
// loss needs a separate approver (§28) and captured evidence. This is the screen a manager uses to REVIEW the
// day's losses — what left as loss, by type, valued — with the ones that mattered (the material losses that
// needed an approval) surfaced first, so shrinkage is seen by exception rather than buried in a total.
//
// Like every ERP screen, the rules live here in a tested, DOM-free session model on the shared packages/ui
// primitives (colour is never the only signal — an icon and a word ride with every tone); the shell only
// renders what this hands over. It is READ-ONLY: recording a write-off is the audited write path (a different
// person approves a material loss), never done from this review surface.

// Imported from the specific engine module, NOT the packages/waste barrel, which also re-exports scrap /
// packaging / sustainability — the review screen needs only the loss-type vocabulary.
import type { LossType } from '../../../packages/waste/src/waste';
import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';

export const LOSS_TYPES: readonly LossType[] = ['wastage', 'damage', 'expiry', 'donation', 'destruction'];

/** One recorded write-off, as the box hands it over (a fold of the reason-coded compensating movements). */
export interface WriteOffRow {
  readonly id: string;
  readonly productId: string;
  readonly lossType: LossType;
  /** Magnitude removed from stock (> 0). */
  readonly qtyRemoved: number;
  readonly uom?: string;
  /** The loss value in the smallest currency unit (paise). */
  readonly valueMinor: number;
  readonly currency?: string;
  /** True when the loss was material enough to need a separate approver (§28). */
  readonly requiredApproval: boolean;
  /** The captured evidence reference (photo/witness), when there is one. */
  readonly evidenceRef?: string;
  readonly raisedBy?: string;
  readonly at?: string;
}

export interface WasteReviewPorts {
  /** The recorded write-offs the box last synced. */
  rows(): readonly WriteOffRow[];
  /** Whether this user may review waste (`waste.view`). */
  mayRead(): boolean;
}

export interface WasteReviewConfig {
  /** Who is looking. `null` means the box was not told. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen (a guardrail binds to it) ────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'lossWastage' | 'lossDamage' | 'lossExpiry' | 'lossDonation' | 'lossDestruction'
  | 'neededApproval' | 'evidenceOnFile' | 'noEvidence' | 'raisedByLabel'
  | 'totalLoss' | 'attentionCount' | 'allClear'
  | 'stateReady' | 'stateEmpty' | 'stateNotPermitted'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const WASTE_REVIEW_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Waste & write-off', langName: 'தமிழ்',
    lead: 'What left as loss, by type and value. The material losses — the ones big enough to need a second person’s approval — come first. Recording a write-off is done where it is approved, never here.',
    lossWastage: 'Wastage', lossDamage: 'Damage', lossExpiry: 'Expired', lossDonation: 'Donation', lossDestruction: 'Destruction',
    neededApproval: 'Needed approval', evidenceOnFile: 'Evidence on file', noEvidence: 'No evidence',
    raisedByLabel: 'Raised by', totalLoss: 'Total loss today',
    attentionCount: 'needed approval', allClear: 'No material losses — nothing needed a second approval.',
    stateReady: 'Showing the losses', stateEmpty: 'No losses have been recorded yet.',
    stateNotPermitted: 'You do not have permission to review waste and write-offs.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'கழிவு & நீக்கம்', langName: 'English',
    lead: 'இழப்பாக என்ன வெளியேறியது, வகை மற்றும் மதிப்பின்படி. இரண்டாவது நபரின் ஒப்புதல் தேவைப்படும் அளவு பெரிய இழப்புகள் முதலில். நீக்கத்தைப் பதிவு செய்வது ஒப்புதல் அளிக்கும் இடத்தில் செய்யப்படும், இங்கு அல்ல.',
    lossWastage: 'கழிவு', lossDamage: 'சேதம்', lossExpiry: 'காலாவதி', lossDonation: 'நன்கொடை', lossDestruction: 'அழிப்பு',
    neededApproval: 'ஒப்புதல் தேவைப்பட்டது', evidenceOnFile: 'ஆதாரம் உள்ளது', noEvidence: 'ஆதாரம் இல்லை',
    raisedByLabel: 'பதிவு செய்தவர்', totalLoss: 'இன்றைய மொத்த இழப்பு',
    attentionCount: 'ஒப்புதல் தேவைப்பட்டது', allClear: 'பெரிய இழப்புகள் இல்லை — எதற்கும் இரண்டாவது ஒப்புதல் தேவைப்படவில்லை.',
    stateReady: 'இழப்புகளைக் காட்டுகிறது', stateEmpty: 'இன்னும் இழப்புகள் எதுவும் பதிவு செய்யப்படவில்லை.',
    stateNotPermitted: 'கழிவு மற்றும் நீக்கங்களைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(WASTE_REVIEW_COPY.en) as CopyKey[]);

/** Each loss type → its label copy key. */
export const LOSS_LABEL: Readonly<Record<LossType, CopyKey>> = {
  wastage: 'lossWastage', damage: 'lossDamage', expiry: 'lossExpiry', donation: 'lossDonation', destruction: 'lossDestruction',
};

/** The face each loss type wears. A deliberate disposal (donation/destruction) is idle, not an alarm; an
 *  unplanned loss (wastage/damage/expiry) is a degraded tone worth a glance. Materiality drives attention. */
const LOSS_FACE: Readonly<Record<LossType, { readonly tone: 'ok' | 'degraded' | 'error' | 'idle'; readonly icon: string }>> = {
  wastage: { tone: 'degraded', icon: '♻' },
  damage: { tone: 'degraded', icon: '✖' },
  expiry: { tone: 'degraded', icon: '⌛' },
  donation: { tone: 'idle', icon: '♥' },
  destruction: { tone: 'idle', icon: '⊘' },
};

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────

export interface PresentedWriteOff {
  readonly id: string;
  readonly productId: string;
  readonly status: StatusPresentation;   // loss type as tone + word + icon + announcement
  readonly needsAttention: boolean;      // a material loss that needed approval
  readonly quantity: string;             // "3 kg", "2 ea"
  readonly value: string;                // formatted "₹1,234.00"
  readonly neededApproval: boolean;
  readonly hasEvidence: boolean;
  readonly evidenceLabel: string;
  readonly raisedBy?: string;
}

export interface WasteReviewView {
  readonly screenState: StatusPresentation;
  readonly rows: readonly PresentedWriteOff[];
  readonly attentionCount: number;
  readonly total: number;
  /** The day's total loss value, formatted — the one number a manager wants at the top. */
  readonly totalValue: string;
  readonly nobodyNamed: boolean;
}

export interface WasteReviewSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): WasteReviewView;
}

/** ₹ from paise, with thousands separators. Deterministic (no Intl), so the model stays testable. */
export function formatMoney(minor: number, currency = 'INR'): string {
  const symbol = currency === 'INR' ? '₹' : '';
  const negative = minor < 0;
  const whole = Math.floor(Math.abs(minor) / 100);
  const paise = String(Math.abs(minor) % 100).padStart(2, '0');
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${symbol}${grouped}.${paise}`;
}

export function createWasteReviewSession(config: WasteReviewConfig, ports: WasteReviewPorts): WasteReviewSession {
  const text = (lang: Lang, key: CopyKey): string => translator(WASTE_REVIEW_COPY, lang)(key);

  const present = (lang: Lang, row: WriteOffRow): PresentedWriteOff => {
    const t = translator(WASTE_REVIEW_COPY, lang);
    const face = LOSS_FACE[row.lossType];
    const label = t(LOSS_LABEL[row.lossType]);
    const needsAttention = row.requiredApproval;
    // A material loss is bumped to the error tone so it reads as the one to look at, over its loss-type colour.
    const tone = needsAttention ? 'error' : face.tone;
    const hasEvidence = typeof row.evidenceRef === 'string' && row.evidenceRef.trim() !== '';
    return {
      id: row.id,
      productId: row.productId,
      status: presentStatus({ tone, icon: face.icon, label, announcement: `${row.productId}: ${label}`, needsAttention }),
      needsAttention,
      quantity: `${row.qtyRemoved}${row.uom ? ` ${row.uom}` : ''}`,
      value: formatMoney(row.valueMinor, row.currency ?? 'INR'),
      neededApproval: row.requiredApproval,
      hasEvidence,
      evidenceLabel: hasEvidence ? t('evidenceOnFile') : t('noEvidence'),
      ...(row.raisedBy !== undefined ? { raisedBy: row.raisedBy } : {}),
    };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(WASTE_REVIEW_COPY, lang);
      if (!ports.mayRead()) {
        return {
          screenState: presentScreenState({ state: 'error', label: t('stateNotPermitted') }),
          rows: [], attentionCount: 0, total: 0, totalValue: formatMoney(0), nobodyNamed: config.userId === null,
        };
      }
      const raw = ports.rows();
      const rows = raw.map((r) => present(lang, r));
      // Material losses (needed approval) first; within each, the larger loss first, then a stable id order.
      const valueOf = new Map(raw.map((r) => [r.id, Math.abs(r.valueMinor)] as const));
      const ordered = [...rows].sort((a, b) => {
        if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
        const va = valueOf.get(a.id) ?? 0;
        const vb = valueOf.get(b.id) ?? 0;
        if (va !== vb) return vb - va;
        return a.id.localeCompare(b.id);
      });
      const attentionCount = rows.filter((r) => r.needsAttention).length;
      const totalMinor = raw.reduce((sum, r) => sum + Math.abs(r.valueMinor), 0);
      const state = rows.length === 0 ? 'empty' : 'ready';
      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'stateEmpty' : 'stateReady') }),
        rows: ordered,
        attentionCount,
        total: rows.length,
        totalValue: formatMoney(totalMinor),
        nobodyNamed: config.userId === null,
      };
    },
  };
}
