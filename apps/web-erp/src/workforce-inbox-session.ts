// The Workforce/SOP guidance inbox — the manager's review screen (A10 · API-13 · §7.1 · M25-FR-02 ·
// P-05 · P-03 control-by-exception). The A10 agent reads the tenant's live daily tasks (the append-only
// roster stream, folded by the tested assessDailyTasks) and surfaces the ones that need a person NOW — a
// CRITICAL task past its due time ESCALATES to the manager on duty, a non-critical overdue one is flagged to
// assign — and the cloud folds those live findings together with the managers' set-aside decisions into a
// worklist (`GET /v1/ai/workforce/worklist`, built by the tested `buildDataQualityWorklist`). This is the
// screen that shows it: the OPEN guidance to act on, and the SET-ASIDE ones a manager has judged already-handled.
//
// Two truths the screen must carry, both already true in the engine and re-stated here so the surface cannot
// weaken them:
//   • **It self-heals.** The guidance is RE-DERIVED from the live tasks, so completing or assigning a task the
//     ordinary way removes its guidance on its own. This screen points at what needs a person; it never carries
//     a "done" flag that could go stale against the real task board.
//   • **The AI commits nothing.** The worklist is a read; nothing here completes or assigns a task or touches
//     anyone's pay. A10 flags; a MANAGER acts (assign or complete the task the ordinary way). Setting one aside
//     is a HUMAN write on the dismissals route, in the manager's own name.
//
// Like every ERP screen the rules live here in a tested, DOM-free session model on the shared packages/ui
// primitives (colour is never the only signal — an icon and a word ride with every tone); the shell only
// renders what this hands over.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation, type Tone } from '../../../packages/a11y/src/signals';

/** One A10 guidance item as the worklist route hands it over. The session reads only these fields; the finding's
 *  own detail already carries the plain-English explanation and `guidance` is the recommended action. `kind` is
 *  the severity (escalated is graver than overdue), used to pick the tone. */
export interface WorkforceFindingView {
  readonly findingId: string;
  readonly taskId: string;
  /** 'escalated' (critical + overdue → the manager on duty) is graver than 'overdue' (assign someone). */
  readonly kind: 'escalated' | 'overdue';
  /** The role the task is routed to. */
  readonly forRole: string;
  readonly branchId?: string;
  readonly headline: string;
  readonly detail: string;
  /** The recommended action a person takes — never an autonomous act. */
  readonly guidance: string;
  readonly overdueByMinutes: number;
}

/** One guidance item as the worklist hands it over, carrying (when set aside) who/why. */
export interface WorkforceWorklistEntry {
  readonly finding: WorkforceFindingView;
  readonly status: 'open' | 'dismissed';
  readonly dismissal?: { readonly by: string; readonly at: string; readonly reason: string };
}

/** The worklist body (`GET /v1/ai/workforce/worklist`). `agentActive` false → A10 is off or killed. */
export interface WorkforceWorklistData {
  readonly agentActive: boolean;
  readonly open: readonly WorkforceWorklistEntry[];
  readonly dismissed: readonly WorkforceWorklistEntry[];
  /** Plain-English reason there is nothing to show when the agent is not active. */
  readonly note?: string;
}

/** The outcome of a set-aside/reopen — recorded, refused by the server, or a lost link (retryable). */
export type DismissOutcome = 'recorded' | 'refused' | 'lost_link';

/** The authenticated POST of a manager's decision. Injected, so the model never opens a socket itself.
 *  `dismissed:false` reopens. The AI never writes this — it is a HUMAN decision in the human's name. */
export interface WorkforceDismissPort {
  post(input: { readonly findingId: string; readonly dismissed: boolean; readonly reason: string }): Promise<DismissOutcome>;
}

export interface WorkforceInboxPorts {
  /** The worklist the shell last read (live from the cloud, or the injected stand-in). */
  worklist(): WorkforceWorklistData;
  /** Whether this user may read the inbox (`ai.proposal.read`). */
  mayRead(): boolean;
  /** Whether this user may set guidance aside / bring it back (`ai.suggestion.dismiss`). */
  mayDismiss(): boolean;
  /** Records a manager's decision. Only reached from the explicit set-aside/reopen action, never on render. */
  dismissPort(): WorkforceDismissPort;
}

export interface WorkforceInboxConfig {
  /** Who is looking. `null` means the store computer was not told. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen ───────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'kindEscalated' | 'kindOverdue' | 'kindDismissed'
  | 'openHeading' | 'dismissedHeading'
  | 'openCount' | 'dismissedCount' | 'allClear'
  | 'roleLabel' | 'guidanceLabel' | 'dismissedByLabel' | 'reasonLabel'
  | 'dismissBtn' | 'reopenBtn' | 'reasonPlaceholder'
  | 'dismissRecorded' | 'dismissRefused' | 'dismissLostLink'
  | 'scrReady' | 'scrEmpty' | 'scrOff' | 'stateNotPermitted'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const WORKFORCE_INBOX_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Today’s tasks needing attention', langName: 'தமிழ்',
    lead: 'Staff tasks the Workforce helper found running late — a critical one past its time escalates to the manager on duty, a non-critical one is flagged to assign. Complete or assign the task the ordinary way and it drops off this list on its own. Nothing here changes anyone’s pay or roster; it points you at what needs a person now.',
    kindEscalated: 'Escalate now', kindOverdue: 'Overdue', kindDismissed: 'Set aside',
    openHeading: 'Needs attention', dismissedHeading: 'Set aside',
    openCount: 'needing attention', dismissedCount: 'set aside', allClear: 'Nothing late — the day’s tasks are on track.',
    roleLabel: 'Routed to', guidanceLabel: 'What to do', dismissedByLabel: 'Set aside by', reasonLabel: 'Reason',
    dismissBtn: 'Set aside', reopenBtn: 'Bring back', reasonPlaceholder: 'Why is this not being acted on now?',
    dismissRecorded: 'Set aside.', dismissRefused: 'Could not save — a short reason is needed, or you do not have permission.', dismissLostLink: 'No connection — not saved. Try again.',
    scrReady: 'Showing the tasks that need attention', scrEmpty: 'Nothing late — the day’s tasks are on track.',
    scrOff: 'The Workforce helper is switched off, so there are no tasks to show.',
    stateNotPermitted: 'You do not have permission to see the workforce guidance.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'கவனம் தேவைப்படும் இன்றைய பணிகள்', langName: 'English',
    lead: 'பணியாளர் பணிகளில் தாமதமானவற்றை பணியாளர் உதவியாளர் கண்டறிந்தது — நேரம் கடந்த முக்கியப் பணி கடமையிலுள்ள மேலாளருக்கு அனுப்பப்படும், முக்கியமல்லாதது ஒருவருக்கு ஒதுக்க அறிவிக்கப்படும். வழக்கம்போல் பணியை முடித்தால் அல்லது ஒதுக்கினால் அது தானாகவே இந்தப் பட்டியலில் இருந்து நீங்கும். இங்கு யாருடைய ஊதியமோ பணிப்பட்டியலோ மாறாது; யாருக்கு இப்போது தேவை என்பதைக் காட்டுகிறது.',
    kindEscalated: 'இப்போது அனுப்பு', kindOverdue: 'தாமதம்', kindDismissed: 'ஒதுக்கப்பட்டது',
    openHeading: 'கவனம் தேவை', dismissedHeading: 'ஒதுக்கப்பட்டவை',
    openCount: 'கவனம் தேவை', dismissedCount: 'ஒதுக்கப்பட்டவை', allClear: 'தாமதம் எதுவும் இல்லை — இன்றைய பணிகள் சரியாக நடக்கின்றன.',
    roleLabel: 'அனுப்பப்பட்டது', guidanceLabel: 'என்ன செய்ய வேண்டும்', dismissedByLabel: 'ஒதுக்கியவர்', reasonLabel: 'காரணம்',
    dismissBtn: 'ஒதுக்கிவை', reopenBtn: 'மீண்டும் கொண்டுவா', reasonPlaceholder: 'இது ஏன் இப்போது செயல்படுத்தப்படவில்லை?',
    dismissRecorded: 'ஒதுக்கப்பட்டது.', dismissRefused: 'சேமிக்க முடியவில்லை — ஒரு சிறு காரணம் தேவை, அல்லது உங்களுக்கு அனுமதி இல்லை.', dismissLostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    scrReady: 'கவனம் தேவைப்படும் பணிகளைக் காட்டுகிறது', scrEmpty: 'தாமதம் எதுவும் இல்லை — இன்றைய பணிகள் சரியாக நடக்கின்றன.',
    scrOff: 'பணியாளர் உதவியாளர் அணைக்கப்பட்டுள்ளது, எனவே காட்ட பணிகள் இல்லை.',
    stateNotPermitted: 'பணியாளர் வழிகாட்டுதலைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(WORKFORCE_INBOX_COPY.en) as CopyKey[]);

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

export interface PresentedGuidance {
  readonly findingId: string;
  readonly taskId: string;
  readonly forRole: string;
  readonly branchId?: string;
  readonly status: StatusPresentation;   // severity as tone + word + icon + announcement
  readonly needsAttention: boolean;       // open guidance needs action; set-aside does not
  readonly headline: string;              // the task's plain-English one-liner
  readonly detail: string;                // why it needs attention
  readonly guidance: string;              // the recommended action a person takes
  /** Present only on a set-aside item. */
  readonly dismissedBy?: string;
  readonly dismissedReason?: string;
}

export interface WorkforceInboxView {
  readonly screenState: StatusPresentation;
  readonly agentActive: boolean;
  readonly open: readonly PresentedGuidance[];
  readonly dismissed: readonly PresentedGuidance[];
  readonly openCount: number;
  readonly dismissedCount: number;
  readonly nobodyNamed: boolean;
  /** Whether to offer the "set aside" / "bring back" actions — this user holds `ai.suggestion.dismiss`. */
  readonly mayDismiss: boolean;
}

export interface WorkforceInboxSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): WorkforceInboxView;
  /** Set guidance aside, in the manager's name — a HUMAN write (hard rule #5). Runs only from an explicit
   *  action, never on render; refuses without permission or a reason before it ever POSTs. */
  dismiss(findingId: string, reason: string): Promise<DismissOutcome>;
  /** Bring a set-aside item back onto the open list. */
  reopen(findingId: string): Promise<DismissOutcome>;
  /** Present a set-aside/reopen outcome as one glanceable status the shell shows after the action. */
  presentDismissResult(lang: Lang, outcome: DismissOutcome): StatusPresentation;
}

const EMPTY_VIEW = (screenState: StatusPresentation, nobodyNamed: boolean, mayDismiss: boolean): WorkforceInboxView => ({
  screenState, agentActive: false, open: [], dismissed: [], openCount: 0, dismissedCount: 0, nobodyNamed, mayDismiss,
});

export function createWorkforceInboxSession(
  config: WorkforceInboxConfig,
  ports: WorkforceInboxPorts,
): WorkforceInboxSession {
  const text = (lang: Lang, key: CopyKey): string => translator(WORKFORCE_INBOX_COPY, lang)(key);

  const present = (lang: Lang, entry: WorkforceWorklistEntry): PresentedGuidance => {
    const t = translator(WORKFORCE_INBOX_COPY, lang);
    const open = entry.status === 'open';
    const f = entry.finding;
    // Open guidance is the work — an escalated (critical + overdue) item is the graver, an 'error' tone; a
    // plain overdue one asks for a glance (P-03). A set-aside one is idle. Colour is never the only signal — an
    // icon rides too.
    const tone: Tone = !open ? 'idle' : f.kind === 'escalated' ? 'error' : 'degraded';
    const icon = !open ? '✓' : f.kind === 'escalated' ? '✕' : '⚠';
    const label = open ? (f.kind === 'escalated' ? t('kindEscalated') : t('kindOverdue')) : t('kindDismissed');
    return {
      findingId: f.findingId,
      taskId: f.taskId,
      forRole: f.forRole,
      ...(f.branchId === undefined ? {} : { branchId: f.branchId }),
      status: presentStatus({ tone, icon, label, announcement: f.headline, needsAttention: open }),
      needsAttention: open,
      headline: f.headline,
      detail: f.detail,
      guidance: f.guidance,
      ...(entry.dismissal !== undefined ? { dismissedBy: entry.dismissal.by, dismissedReason: entry.dismissal.reason } : {}),
    };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(WORKFORCE_INBOX_COPY, lang);
      const nobodyNamed = config.userId === null;
      const mayDismiss = ports.mayDismiss();

      if (!ports.mayRead()) {
        return EMPTY_VIEW(presentScreenState({ state: 'error', label: t('stateNotPermitted') }), nobodyNamed, mayDismiss);
      }

      const worklist = ports.worklist();
      if (!worklist.agentActive) {
        // Governance honoured: the agent is off or killed, so there is nothing to show — say so plainly, not an
        // empty screen a person reads as "all on track". `locked` is the deliberate, non-fault state (idle tone,
        // never the red of an error — the helper being off is a choice, not a breakage).
        return EMPTY_VIEW(presentScreenState({ state: 'locked', label: worklist.note ?? t('scrOff') }), nobodyNamed, mayDismiss);
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
        mayDismiss,
      };
    },

    // Set guidance aside / bring it back. Refuse BEFORE any POST — no permission, or an empty reason on a
    // set-aside, is a local refusal, not a round trip (the server also refuses, but the screen should not send a
    // request it knows will fail). The AI never writes this; the caller is the authenticated manager, and the
    // server records the decision in their name. Completing/assigning the task is done the ordinary way.
    dismiss: async (findingId, reason) => {
      if (!ports.mayDismiss() || reason.trim() === '') return 'refused';
      return ports.dismissPort().post({ findingId, dismissed: true, reason: reason.trim() });
    },
    reopen: async (findingId) => {
      if (!ports.mayDismiss()) return 'refused';
      return ports.dismissPort().post({ findingId, dismissed: false, reason: '' });
    },
    presentDismissResult: (lang, outcome) => {
      const t = translator(WORKFORCE_INBOX_COPY, lang);
      if (outcome === 'recorded') return presentStatus({ tone: 'ok', icon: '✓', label: t('dismissRecorded'), needsAttention: false });
      if (outcome === 'lost_link') return presentStatus({ tone: 'degraded', icon: '⚠', label: t('dismissLostLink'), needsAttention: true });
      return presentStatus({ tone: 'error', icon: '✕', label: t('dismissRefused'), needsAttention: true });
    },
  };
}
