// The Data Quality suggestions inbox — the steward's review screen (A08 · API-13 · §7.1 · P-05 · P-03
// control-by-exception · M03-FR-02/04). The A08 agent scans the product master for the data-quality gaps
// that can genuinely occur — a sellable item with no barcode, two records that look like the same item, an
// item with no printed MRP — and the cloud folds those live findings together with the stewards' dismissals
// into a worklist (`GET /v1/ai/data-quality/worklist`, built by the tested `buildDataQualityWorklist`). This
// is the screen that shows it: the OPEN suggestions to act on, and the DISMISSED ones a steward has judged
// not-a-problem (with who set each aside and why).
//
// Two truths the screen must carry, both already true in the engine and re-stated here so the surface cannot
// weaken them:
//   • **It self-heals.** The findings are RE-DERIVED from the live master, so fixing a gap the ordinary way
//     (assign the barcode, merge the pair, add the MRP — through the catalogue screens) removes its suggestion
//     on its own. This screen therefore points at what to fix and where; it never carries a "done" flag that
//     could go stale against reality.
//   • **The AI commits nothing.** The worklist is a read; nothing here changes a product. (Dismissing a
//     false positive is a HUMAN write on the dismissals route — a later slice adds that button; this screen
//     shows the dismissed ones a steward has already set aside.)
//
// Like every ERP screen the rules live here in a tested, DOM-free session model on the shared packages/ui
// primitives (colour is never the only signal — an icon and a word ride with every tone); the shell only
// renders what this hands over. Read-only.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation, type Tone } from '../../../packages/a11y/src/signals';
import type { DataQualityFinding, DataQualityIssueKind } from '../../../packages/product/src/index';

/** One suggestion as the worklist route hands it over — the finding plus, when set aside, who/why. */
export interface DataQualityWorklistEntry {
  readonly finding: DataQualityFinding;
  readonly status: 'open' | 'dismissed';
  readonly dismissal?: { readonly by: string; readonly at: string; readonly reason: string };
}

/** The worklist body (`GET /v1/ai/data-quality/worklist`). `agentActive` false → A08 is off or killed. */
export interface DataQualityWorklistData {
  readonly agentActive: boolean;
  readonly open: readonly DataQualityWorklistEntry[];
  readonly dismissed: readonly DataQualityWorklistEntry[];
  /** Plain-English reason there is nothing to show when the agent is not active. */
  readonly note?: string;
}

export interface DataQualityInboxPorts {
  /** The worklist the shell last read (live from the cloud, or the injected stand-in). */
  worklist(): DataQualityWorklistData;
  /** Whether this user may read the inbox (`ai.proposal.read`). */
  mayRead(): boolean;
}

export interface DataQualityInboxConfig {
  /** Who is looking. `null` means the store computer was not told. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen (a guardrail binds to it) ────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'kindMissingBarcode' | 'kindDuplicate' | 'kindMissingMrp' | 'kindDismissed'
  | 'openHeading' | 'dismissedHeading'
  | 'openCount' | 'dismissedCount' | 'allClear'
  | 'affectsLabel' | 'dismissedByLabel' | 'reasonLabel'
  | 'scrReady' | 'scrEmpty' | 'scrOff' | 'stateNotPermitted'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const DATA_QUALITY_INBOX_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Data quality', langName: 'தமிழ்',
    lead: 'Problems the Data Quality helper found in your product list. Fix one the normal way — add the barcode, merge the duplicate, set the price — and it drops off this list on its own. Nothing here changes a product; it points you at what to check.',
    kindMissingBarcode: 'No barcode — cannot be scanned', kindDuplicate: 'Looks like a duplicate', kindMissingMrp: 'No printed price (MRP)',
    kindDismissed: 'Set aside — not a problem',
    openHeading: 'To look at', dismissedHeading: 'Set aside',
    openCount: 'to look at', dismissedCount: 'set aside', allClear: 'Nothing to look at — your product list is clean.',
    affectsLabel: 'Affects', dismissedByLabel: 'Set aside by', reasonLabel: 'Reason',
    scrReady: 'Showing the suggestions', scrEmpty: 'Nothing to look at — your product list is clean.',
    scrOff: 'The Data Quality helper is switched off, so there are no suggestions to show.',
    stateNotPermitted: 'You do not have permission to see the data quality suggestions.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'தரக் கட்டுப்பாடு', langName: 'English',
    lead: 'தரக் கட்டுப்பாட்டு உதவியாளர் உங்கள் பொருள் பட்டியலில் கண்டறிந்த சிக்கல்கள். ஒன்றை வழக்கம் போல் சரிசெய்யுங்கள் — பார்கோடு சேர்க்க, நகலை இணைக்க, விலை அமைக்க — அது தானாகவே இந்தப் பட்டியலில் இருந்து நீங்கும். இங்கு எதுவும் பொருளை மாற்றாது; என்ன சரிபார்க்க வேண்டும் என்பதைக் காட்டுகிறது.',
    kindMissingBarcode: 'பார்கோடு இல்லை — ஸ்கேன் செய்ய முடியாது', kindDuplicate: 'நகல் போல் தெரிகிறது', kindMissingMrp: 'அச்சிட்ட விலை (MRP) இல்லை',
    kindDismissed: 'ஒதுக்கப்பட்டது — சிக்கல் இல்லை',
    openHeading: 'பார்க்க வேண்டியவை', dismissedHeading: 'ஒதுக்கப்பட்டவை',
    openCount: 'பார்க்க வேண்டியவை', dismissedCount: 'ஒதுக்கப்பட்டவை', allClear: 'பார்க்க எதுவும் இல்லை — உங்கள் பொருள் பட்டியல் சுத்தமாக உள்ளது.',
    affectsLabel: 'பாதிக்கிறது', dismissedByLabel: 'ஒதுக்கியவர்', reasonLabel: 'காரணம்',
    scrReady: 'பரிந்துரைகளைக் காட்டுகிறது', scrEmpty: 'பார்க்க எதுவும் இல்லை — உங்கள் பொருள் பட்டியல் சுத்தமாக உள்ளது.',
    scrOff: 'தரக் கட்டுப்பாட்டு உதவியாளர் அணைக்கப்பட்டுள்ளது, எனவே காட்ட பரிந்துரைகள் இல்லை.',
    stateNotPermitted: 'தரக் கட்டுப்பாட்டு பரிந்துரைகளைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(DATA_QUALITY_INBOX_COPY.en) as CopyKey[]);

/** Each finding kind → its label copy key. */
export const KIND_LABEL: Readonly<Record<DataQualityIssueKind, CopyKey>> = {
  missing_barcode: 'kindMissingBarcode',
  suspected_duplicate: 'kindDuplicate',
  missing_mrp: 'kindMissingMrp',
};

/** The icon each kind wears — a shape that survives greyscale, glare and colour blindness. */
const KIND_ICON: Readonly<Record<DataQualityIssueKind, string>> = {
  missing_barcode: '▦',
  suspected_duplicate: '❏',
  missing_mrp: '₹',
};

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────

export interface PresentedSuggestion {
  readonly findingId: string;
  readonly kind: DataQualityIssueKind;
  readonly status: StatusPresentation;   // kind as tone + word + icon + announcement
  readonly needsAttention: boolean;       // open suggestions need a look; dismissed ones do not
  readonly headline: string;              // the finding's plain-English one-liner
  readonly detail: string;                // why it matters and what to check
  /** The real product(s) this concerns — "Name (SKU)" each, so the steward can find them. */
  readonly affects: readonly string[];
  /** Present only on a dismissed suggestion. */
  readonly dismissedBy?: string;
  readonly dismissedReason?: string;
}

export interface DataQualityInboxView {
  readonly screenState: StatusPresentation;
  readonly agentActive: boolean;
  readonly open: readonly PresentedSuggestion[];
  readonly dismissed: readonly PresentedSuggestion[];
  readonly openCount: number;
  readonly dismissedCount: number;
  readonly nobodyNamed: boolean;
}

export interface DataQualityInboxSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): DataQualityInboxView;
}

const EMPTY_VIEW = (screenState: StatusPresentation, nobodyNamed: boolean): DataQualityInboxView => ({
  screenState, agentActive: false, open: [], dismissed: [], openCount: 0, dismissedCount: 0, nobodyNamed,
});

export function createDataQualityInboxSession(
  config: DataQualityInboxConfig,
  ports: DataQualityInboxPorts,
): DataQualityInboxSession {
  const text = (lang: Lang, key: CopyKey): string => translator(DATA_QUALITY_INBOX_COPY, lang)(key);

  const present = (lang: Lang, entry: DataQualityWorklistEntry): PresentedSuggestion => {
    const t = translator(DATA_QUALITY_INBOX_COPY, lang);
    const f = entry.finding;
    const open = entry.status === 'open';
    const label = open ? t(KIND_LABEL[f.kind]) : t('kindDismissed');
    // Open suggestions are the work — a degraded tone that asks for a glance (P-03). A dismissed one is idle.
    const tone: Tone = open ? 'degraded' : 'idle';
    const affects = f.evidence.map((e) => (e.sku.trim() === '' ? e.name : `${e.name} (${e.sku})`));
    return {
      findingId: f.findingId,
      kind: f.kind,
      status: presentStatus({ tone, icon: open ? KIND_ICON[f.kind] : '✓', label, announcement: `${f.headline}`, needsAttention: open }),
      needsAttention: open,
      headline: f.headline,
      detail: f.detail,
      affects,
      ...(entry.dismissal !== undefined ? { dismissedBy: entry.dismissal.by, dismissedReason: entry.dismissal.reason } : {}),
    };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(DATA_QUALITY_INBOX_COPY, lang);
      const nobodyNamed = config.userId === null;

      if (!ports.mayRead()) {
        return EMPTY_VIEW(presentScreenState({ state: 'error', label: t('stateNotPermitted') }), nobodyNamed);
      }

      const worklist = ports.worklist();
      if (!worklist.agentActive) {
        // Governance honoured: the agent is off or killed, so there is nothing to show — say so plainly,
        // not an empty screen a person reads as "all clear". `locked` is the deliberate, non-fault state (its
        // tone is idle, never the red of an error — the helper being off is a choice, not a breakage).
        return EMPTY_VIEW(presentScreenState({ state: 'locked', label: worklist.note ?? t('scrOff') }), nobodyNamed);
      }

      const open = worklist.open.map((e) => present(lang, e));
      const dismissed = worklist.dismissed.map((e) => present(lang, e));
      const state = open.length === 0 && dismissed.length === 0 ? 'empty' : 'ready';
      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'scrEmpty' : 'scrReady') }),
        agentActive: true,
        open,
        dismissed,
        openCount: open.length,
        dismissedCount: dismissed.length,
        nobodyNamed,
      };
    },
  };
}
