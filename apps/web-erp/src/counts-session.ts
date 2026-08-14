// Stock-count review — the blind-count variance triage view (M09-FR-04; §19 · §27 · §28 · P-03 control by
// exception). M09-FR-04 built the tested `reconcileCount` engine (`packages/counts/src/counts.ts`): a counter
// enters a BLIND physical count (they never see the system-expected quantity); the server derives the expected
// on-hand, VALUES the variance, and — when there is one — commits a reason-coded COMPENSATING adjustment, with
// a SEPARATE approver required when the value is material (§28: the counter can never approve their own
// variance). This is the screen a manager uses to REVIEW the day's counts — what matched, what came up short
// or over, and by how much in money — with the ones that mattered (the material variances that needed a second
// person's approval) surfaced first, so shrinkage is investigated by exception rather than buried in a total.
//
// Like every ERP screen, the rules live here in a tested, DOM-free session model on the shared packages/ui
// primitives (colour is never the only signal — an icon and a word ride with every tone); the shell only
// renders what this hands over. It is READ-ONLY: reconciling a count is the audited write path (the blind
// count is captured elsewhere and the expected quantity is computed server-side, never on this surface), never
// done from this review screen. Blind-count integrity is structural and cannot be weakened by what is shown.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';

/** Whether a count came up short, over, or matched the ledger. Derived from the signed variance. */
export type VarianceKind = 'matched' | 'shortage' | 'overage';
export const VARIANCE_KINDS: readonly VarianceKind[] = ['matched', 'shortage', 'overage'];

/** counted − expected: 0 matches, < 0 is shrinkage (short), > 0 is found stock (over). */
export function varianceKind(varianceMinor: number): VarianceKind {
  if (varianceMinor === 0) return 'matched';
  return varianceMinor < 0 ? 'shortage' : 'overage';
}

/** One reconciled blind count, as the box hands it over (a fold of the count-reconciliation records). */
export interface CountRow {
  readonly id: string;
  readonly productId: string;
  readonly locationId?: string;
  /** System-expected on-hand, computed server-side (hidden from the counter; shown here for review). */
  readonly expectedMinor: number;
  /** The blind physical count. */
  readonly countedMinor: number;
  /** counted − expected: the sign carries the direction (short/over). */
  readonly varianceMinor: number;
  /** The money value of the variance, magnitude (>= 0), in the smallest currency unit (paise). */
  readonly valueMinor: number;
  readonly currency?: string;
  readonly uom?: string;
  /** True when the variance was material enough to need a separate approver (§28). */
  readonly requiredApproval: boolean;
  /** True when a compensating adjustment was applied (a variance was found). */
  readonly adjusted: boolean;
  readonly reasonCode?: string;
  /** Who counted. */
  readonly counterId?: string;
  /** Who approved a material variance, when there was one. */
  readonly approvedBy?: string | null;
  readonly at?: string;
}

export interface CountsReviewPorts {
  /** The reconciled counts the box last synced. */
  rows(): readonly CountRow[];
  /** Whether this user may review counts (`count.view`). */
  mayRead(): boolean;
}

export interface CountsReviewConfig {
  /** Who is looking. `null` means the box was not told. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen (a guardrail binds to it) ────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'varianceMatched' | 'varianceShort' | 'varianceOver'
  | 'neededApproval' | 'approvedByLabel' | 'reasonLabel' | 'counterLabel'
  | 'countedLabel' | 'expectedLabel'
  | 'totalVariance' | 'attentionCount' | 'allClear'
  | 'stateReady' | 'stateEmpty' | 'stateNotPermitted'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const COUNTS_REVIEW_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Stock counts', langName: 'தமிழ்',
    lead: 'What the blind counts found against the system. The material variances — the ones big enough to need a second person’s approval — come first. Counting is captured elsewhere; the expected quantity is computed by the system, never here.',
    varianceMatched: 'Matched', varianceShort: 'Short', varianceOver: 'Over',
    neededApproval: 'Needed approval', approvedByLabel: 'Approved by', reasonLabel: 'Reason', counterLabel: 'Counted by',
    countedLabel: 'Counted', expectedLabel: 'System',
    totalVariance: 'Value at variance today',
    attentionCount: 'needed approval', allClear: 'No material variances — nothing needed a second approval.',
    stateReady: 'Showing the counts', stateEmpty: 'No counts have been reconciled yet.',
    stateNotPermitted: 'You do not have permission to review stock counts.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'சரக்கு எண்ணிக்கை', langName: 'English',
    lead: 'கண்மூடி எண்ணிக்கை கணினியுடன் ஒப்பிடும்போது என்ன கண்டறிந்தது. இரண்டாவது நபரின் ஒப்புதல் தேவைப்படும் அளவு பெரிய வேறுபாடுகள் முதலில். எண்ணுதல் வேறு இடத்தில் பதிவு செய்யப்படுகிறது; எதிர்பார்க்கப்படும் அளவை கணினி கணக்கிடுகிறது, இங்கு அல்ல.',
    varianceMatched: 'பொருந்தியது', varianceShort: 'குறைவு', varianceOver: 'அதிகம்',
    neededApproval: 'ஒப்புதல் தேவைப்பட்டது', approvedByLabel: 'ஒப்புதல் அளித்தவர்', reasonLabel: 'காரணம்', counterLabel: 'எண்ணியவர்',
    countedLabel: 'எண்ணப்பட்டது', expectedLabel: 'கணினி',
    totalVariance: 'இன்று வேறுபட்ட மதிப்பு',
    attentionCount: 'ஒப்புதல் தேவைப்பட்டது', allClear: 'பெரிய வேறுபாடுகள் இல்லை — எதற்கும் இரண்டாவது ஒப்புதல் தேவைப்படவில்லை.',
    stateReady: 'எண்ணிக்கைகளைக் காட்டுகிறது', stateEmpty: 'இன்னும் எண்ணிக்கைகள் எதுவும் சரிசெய்யப்படவில்லை.',
    stateNotPermitted: 'சரக்கு எண்ணிக்கைகளைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(COUNTS_REVIEW_COPY.en) as CopyKey[]);

/** Each variance kind → its label copy key. */
export const VARIANCE_LABEL: Readonly<Record<VarianceKind, CopyKey>> = {
  matched: 'varianceMatched', shortage: 'varianceShort', overage: 'varianceOver',
};

/** The face each variance kind wears. A match is ok; a short or an over is a degraded tone worth a glance.
 *  Materiality (needing a second approval) drives it to error/attention, over the direction colour. */
const VARIANCE_FACE: Readonly<Record<VarianceKind, { readonly tone: 'ok' | 'degraded' | 'error' | 'idle'; readonly icon: string }>> = {
  matched: { tone: 'ok', icon: '✓' },
  shortage: { tone: 'degraded', icon: '▼' },
  overage: { tone: 'degraded', icon: '▲' },
};

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────

export interface PresentedCount {
  readonly id: string;
  readonly productId: string;
  readonly status: StatusPresentation;   // variance direction as tone + word + icon + announcement
  readonly needsAttention: boolean;      // a material variance that needed approval
  readonly variance: string;             // signed magnitude, "-4 ea" / "+4 ea" / "0 ea"
  readonly value: string;                // formatted "₹1,234.00" (magnitude at variance)
  readonly counted: string;              // the blind count, "12 ea"
  readonly expected: string;             // the system-expected, "16 ea"
  readonly neededApproval: boolean;
  readonly reasonCode?: string;
  readonly counterId?: string;
  readonly approvedBy?: string;
}

export interface CountsReviewView {
  readonly screenState: StatusPresentation;
  readonly rows: readonly PresentedCount[];
  readonly attentionCount: number;
  readonly total: number;
  /** The day's total value at variance (sum of magnitudes), formatted — the one number a manager wants. */
  readonly totalValue: string;
  readonly nobodyNamed: boolean;
}

export interface CountsReviewSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): CountsReviewView;
}

/** ₹ from paise, with thousands separators. Deterministic (no Intl), so the model stays testable — the same
 *  self-contained formatter each ERP money screen carries (mirrors the waste-review screen). */
export function formatMoney(minor: number, currency = 'INR'): string {
  const symbol = currency === 'INR' ? '₹' : '';
  const negative = minor < 0;
  const whole = Math.floor(Math.abs(minor) / 100);
  const paise = String(Math.abs(minor) % 100).padStart(2, '0');
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${symbol}${grouped}.${paise}`;
}

/** A quantity with its unit, "12 ea". A signed one carries the direction for a variance. */
const qty = (n: number, uom?: string, signed = false): string =>
  `${signed && n > 0 ? '+' : ''}${n}${uom ? ` ${uom}` : ''}`;

export function createCountsReviewSession(config: CountsReviewConfig, ports: CountsReviewPorts): CountsReviewSession {
  const text = (lang: Lang, key: CopyKey): string => translator(COUNTS_REVIEW_COPY, lang)(key);

  const present = (lang: Lang, row: CountRow): PresentedCount => {
    const t = translator(COUNTS_REVIEW_COPY, lang);
    const kind = varianceKind(row.varianceMinor);
    const face = VARIANCE_FACE[kind];
    const label = t(VARIANCE_LABEL[kind]);
    const needsAttention = row.requiredApproval;
    // A material variance is bumped to the error tone so it reads as the one to look at, over its direction colour.
    const tone = needsAttention ? 'error' : face.tone;
    return {
      id: row.id,
      productId: row.productId,
      status: presentStatus({ tone, icon: face.icon, label, announcement: `${row.productId}: ${label}`, needsAttention }),
      needsAttention,
      variance: qty(row.varianceMinor, row.uom, true),
      value: formatMoney(row.valueMinor, row.currency ?? 'INR'),
      counted: qty(row.countedMinor, row.uom),
      expected: qty(row.expectedMinor, row.uom),
      neededApproval: row.requiredApproval,
      ...(row.reasonCode !== undefined ? { reasonCode: row.reasonCode } : {}),
      ...(row.counterId !== undefined ? { counterId: row.counterId } : {}),
      ...(typeof row.approvedBy === 'string' && row.approvedBy.trim() !== '' ? { approvedBy: row.approvedBy } : {}),
    };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(COUNTS_REVIEW_COPY, lang);
      if (!ports.mayRead()) {
        return {
          screenState: presentScreenState({ state: 'error', label: t('stateNotPermitted') }),
          rows: [], attentionCount: 0, total: 0, totalValue: formatMoney(0), nobodyNamed: config.userId === null,
        };
      }
      const raw = ports.rows();
      const rows = raw.map((r) => present(lang, r));
      // Material variances (needed approval) first; within each, the larger value first, then a stable id order.
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
