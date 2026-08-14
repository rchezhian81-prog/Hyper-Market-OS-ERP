// GST returns — the filing-status operator view (owner directive item 3, the 4th UI domain; API-09; M23).
// WP4 (item 1) built the GSTR-1 SUBMISSION-SAFETY state machine (`packages/finance/src/gstr1-submission.ts`)
// and wired it durably (`services/finance/src/gstr1-submission-store.ts`): preview → approve (maker ≠ checker)
// → submit → filed, with failed/unknown/cancelled branches and reconciliation. This is the screen a finance
// person uses to SEE the state of every filing period — which returns are filed, which are waiting for a
// second person to approve, which are ready to file, and — the point of the screen — which are STUCK: a
// portal rejection (failed) or an unresolved outcome (unknown) that needs a person to reconcile with evidence.
//
// Like every ERP screen, the rules live here in a tested, DOM-free session model on the shared packages/ui
// primitives (colour is never the only signal — an icon and a word ride with every tone) over the tested
// `packages/finance` submission engine (`queueCategory`/`isSubmissionException`); the shell only renders what
// this hands over. This increment is a READ / TRIAGE surface: it shows what each period's return needs and,
// in plain language, what the next step is. It does not itself file anything — preview/approve/submit are the
// maker→checker API routes; wiring those actions is the following increment. So nothing is filed from here,
// and a stuck return is surfaced for a person, never resolved silently (hard rule #10).

// Imported from the specific engine module, NOT the packages/finance barrel: the barrel re-exports the
// GSTN sandbox, which uses `node:crypto` and would break the browser bundle. This screen needs only the pure
// submission lifecycle helpers.
import {
  queueCategory, isSubmissionException,
  type Gstr1SubmissionState, type Gstr1SubmissionQueueCategory,
} from '../../../packages/finance/src/gstr1-submission';
import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';

/** One filing period's submission, as the box hands it over (a fold of the durable submission stream). */
export interface ReturnRow {
  /** The filing period, MMYYYY. */
  readonly period: string;
  readonly state: Gstr1SubmissionState;
  /** The portal reference (ARN) once filed. */
  readonly arn?: string;
  readonly detail?: string;
  /** Who prepared / approved it, when the box knows (shown, never invented). */
  readonly previewedBy?: string;
  readonly approvedBy?: string;
}

/** What the operator should do next about a return. `none` = filed or withdrawn, nothing needed. */
export type ReturnAction = 'none' | 'approve' | 'file' | 'wait' | 'refile' | 'reconcile';
export const RETURN_ACTIONS: readonly ReturnAction[] = ['none', 'approve', 'file', 'wait', 'refile', 'reconcile'];

export interface GstReturnsPorts {
  /** The filing periods the box last synced, each folded to its current submission state. */
  rows(): readonly ReturnRow[];
  /** Whether the user may read the filing queue (`finance.gstr.read`). */
  mayRead(): boolean;
}

export interface GstReturnsConfig {
  /** Who is looking. `null` means the box was not told — the screen says so. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen (a guardrail binds to it) ────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'stPreviewed' | 'stApproved' | 'stSubmitting' | 'stFiled' | 'stFailed' | 'stUnknown' | 'stCancelled'
  | 'actNone' | 'actApprove' | 'actFile' | 'actWait' | 'actRefile' | 'actReconcile'
  | 'arnLabel' | 'periodLabel' | 'preparedBy' | 'approvedByLabel'
  | 'attentionCount' | 'allClear'
  | 'stateReady' | 'stateEmpty' | 'stateNotPermitted'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const GST_RETURNS_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'GST returns', langName: 'தமிழ்',
    lead: 'Every GSTR-1 filing period and what it needs next. The ones needing attention are first — a return the portal rejected, or one whose outcome is unknown and must be reconciled. Nothing is filed here; a stuck return is resolved by a person with evidence, never silently.',
    stPreviewed: 'Prepared — awaiting approval', stApproved: 'Approved — ready to file', stSubmitting: 'Being filed',
    stFiled: 'Filed', stFailed: 'Rejected by the portal', stUnknown: 'Outcome unknown — reconcile', stCancelled: 'Withdrawn before filing',
    actNone: 'Nothing — it is done', actApprove: 'A second person must approve it', actFile: 'File it to the portal',
    actWait: 'Wait — it is being filed', actRefile: 'Correct the figures and file again', actReconcile: 'A person must reconcile it with evidence — do NOT assume it is filed',
    arnLabel: 'Portal reference', periodLabel: 'Period', preparedBy: 'Prepared by', approvedByLabel: 'Approved by',
    attentionCount: 'need attention', allClear: 'Every return is settled — nothing needs attention.',
    stateReady: 'Showing the filing periods', stateEmpty: 'No filing period has been started yet.',
    stateNotPermitted: 'You do not have permission to see the GST returns queue.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'GST வருமானங்கள்', langName: 'English',
    lead: 'ஒவ்வொரு GSTR-1 தாக்கல் காலமும் அடுத்து என்ன தேவை என்பதும். கவனம் தேவைப்படுபவை முதலில் — போர்ட்டல் மறுத்த வருமானம், அல்லது முடிவு தெரியாத ஒன்று. இங்கு எதுவும் தாக்கல் செய்யப்படாது; சிக்கிய வருமானம் ஒருவரால் ஆதாரத்துடன் தீர்க்கப்படும், அமைதியாக அல்ல.',
    stPreviewed: 'தயாரிக்கப்பட்டது — ஒப்புதலுக்குக் காத்திருக்கிறது', stApproved: 'ஒப்புதல் — தாக்கல் செய்யத் தயார்', stSubmitting: 'தாக்கல் செய்யப்படுகிறது',
    stFiled: 'தாக்கல் செய்யப்பட்டது', stFailed: 'போர்ட்டல் மறுத்தது', stUnknown: 'முடிவு தெரியவில்லை — சரிபார்க்கவும்', stCancelled: 'தாக்கலுக்கு முன் திரும்பப்பெறப்பட்டது',
    actNone: 'எதுவும் இல்லை — முடிந்தது', actApprove: 'இரண்டாவது நபர் ஒப்புதல் அளிக்க வேண்டும்', actFile: 'போர்ட்டலில் தாக்கல் செய்யவும்',
    actWait: 'காத்திருங்கள் — தாக்கல் செய்யப்படுகிறது', actRefile: 'எண்களைச் சரிசெய்து மீண்டும் தாக்கல் செய்யவும்', actReconcile: 'ஒருவர் ஆதாரத்துடன் சரிபார்க்க வேண்டும் — தாக்கல் ஆனதாகக் கருத வேண்டாம்',
    arnLabel: 'போர்ட்டல் குறிப்பு', periodLabel: 'காலம்', preparedBy: 'தயாரித்தவர்', approvedByLabel: 'ஒப்புதல் அளித்தவர்',
    attentionCount: 'கவனம் தேவை', allClear: 'ஒவ்வொரு வருமானமும் தீர்க்கப்பட்டது — எதற்கும் கவனம் தேவையில்லை.',
    stateReady: 'தாக்கல் காலங்களைக் காட்டுகிறது', stateEmpty: 'இன்னும் எந்தத் தாக்கல் காலமும் தொடங்கப்படவில்லை.',
    stateNotPermitted: 'GST வருமானங்கள் வரிசையைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(GST_RETURNS_COPY.en) as CopyKey[]);

/** Each lifecycle state → its status label copy key. */
export const STATE_LABEL: Readonly<Record<Gstr1SubmissionState, CopyKey>> = {
  previewed: 'stPreviewed', approved: 'stApproved', submitting: 'stSubmitting',
  filed: 'stFiled', failed: 'stFailed', unknown: 'stUnknown', cancelled: 'stCancelled',
};

/** Each recommended action → its copy key. */
export const ACTION_LABEL: Readonly<Record<ReturnAction, CopyKey>> = {
  none: 'actNone', approve: 'actApprove', file: 'actFile', wait: 'actWait', refile: 'actRefile', reconcile: 'actReconcile',
};

/** The face (tone + icon) each lifecycle state wears — colour is never the only signal. */
const STATE_FACE: Readonly<Record<Gstr1SubmissionState, { readonly tone: 'ok' | 'degraded' | 'error' | 'idle'; readonly icon: string }>> = {
  previewed: { tone: 'degraded', icon: '◔' },   // in progress — awaiting approval
  approved: { tone: 'degraded', icon: '◑' },    // in progress — ready to file
  submitting: { tone: 'degraded', icon: '…' },  // in flight
  filed: { tone: 'ok', icon: '✓' },             // done
  failed: { tone: 'error', icon: '✕' },         // rejected — an exception
  unknown: { tone: 'degraded', icon: '?' },     // unresolved — an exception
  cancelled: { tone: 'idle', icon: '⊘' },       // withdrawn — deliberate, not an error
};

/** What the operator should do next about a return in this state. Pure, total. */
export function recommendedAction(state: Gstr1SubmissionState): ReturnAction {
  switch (state) {
    case 'previewed': return 'approve';   // a second, different person must approve (maker ≠ checker)
    case 'approved': return 'file';       // locked to the approved figures — ready to file
    case 'submitting': return 'wait';     // in flight
    case 'failed': return 'refile';       // the portal rejected it — correct and re-file
    case 'unknown': return 'reconcile';   // no clear answer — reconcile with evidence (hard rule #10)
    case 'filed': case 'cancelled': return 'none';
  }
}

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────

export interface PresentedReturn {
  readonly period: string;
  readonly category: Gstr1SubmissionQueueCategory;
  readonly status: StatusPresentation;
  readonly action: ReturnAction;
  readonly actionLabel: string;
  readonly needsAttention: boolean;
  /** The portal reference, present only once filed. */
  readonly arn?: string;
  readonly preparedBy?: string;
  readonly approvedByName?: string;
  readonly detail: string;
}

export interface GstReturnsView {
  readonly screenState: StatusPresentation;
  readonly rows: readonly PresentedReturn[];
  readonly attentionCount: number;
  readonly total: number;
  readonly nobodyNamed: boolean;
}

export interface GstReturnsSession {
  /** One bilingual string. */
  text(lang: Lang, key: CopyKey): string;
  /** The whole screen, in the chosen language, with the ones needing attention first. */
  view(lang: Lang): GstReturnsView;
}

export function createGstReturnsSession(config: GstReturnsConfig, ports: GstReturnsPorts): GstReturnsSession {
  const text = (lang: Lang, key: CopyKey): string => translator(GST_RETURNS_COPY, lang)(key);

  const present = (lang: Lang, row: ReturnRow): PresentedReturn => {
    const t = translator(GST_RETURNS_COPY, lang);
    const face = STATE_FACE[row.state];
    const label = t(STATE_LABEL[row.state]);
    const needsAttention = isSubmissionException(row.state);
    const action = recommendedAction(row.state);
    return {
      period: row.period,
      category: queueCategory(row.state),
      status: presentStatus({ tone: face.tone, icon: face.icon, label, announcement: `${row.period}: ${label}`, needsAttention }),
      action,
      actionLabel: t(ACTION_LABEL[action]),
      needsAttention,
      ...(row.arn !== undefined ? { arn: row.arn } : {}),
      ...(row.previewedBy !== undefined ? { preparedBy: row.previewedBy } : {}),
      ...(row.approvedBy !== undefined ? { approvedByName: row.approvedBy } : {}),
      detail: row.detail ?? '',
    };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(GST_RETURNS_COPY, lang);
      if (!ports.mayRead()) {
        return {
          screenState: presentScreenState({ state: 'error', label: t('stateNotPermitted') }),
          rows: [], attentionCount: 0, total: 0, nobodyNamed: config.userId === null,
        };
      }
      const raw = ports.rows();
      const rows = raw.map((r) => present(lang, r));
      // The ones needing attention first; within each, most recent filing period first (MMYYYY string order
      // is not chronological, so sort by the year then the month — a stable, sensible order for an operator).
      const ordered = [...rows].sort((a, b) => {
        if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
        return periodSortKey(b.period).localeCompare(periodSortKey(a.period));
      });
      const attentionCount = rows.filter((r) => r.needsAttention).length;
      const state = rows.length === 0 ? 'empty' : 'ready';
      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'stateEmpty' : 'stateReady') }),
        rows: ordered,
        attentionCount,
        total: rows.length,
        nobodyNamed: config.userId === null,
      };
    },
  };
}

/** MMYYYY → YYYYMM so string comparison sorts chronologically; a malformed period sorts last. */
function periodSortKey(period: string): string {
  return /^\d{6}$/.test(period) ? `${period.slice(2)}${period.slice(0, 2)}` : '000000';
}
