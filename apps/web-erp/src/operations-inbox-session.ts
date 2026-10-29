// The Operations recommendations inbox — the operator's review screen (A06 · API-13 · §7.1 · M35-FR-04 ·
// P-05 · P-03 control-by-exception). The A06 agent reads the tenant's live operational alerts (a stuck sync
// outbox, a growing dead-letter queue, an unwell integration) and recommends the reviewed RUNBOOK for each,
// and the cloud folds those live recommendations together with the operators' dismissals into a worklist
// (`GET /v1/ai/operations/worklist`, built by the tested `buildDataQualityWorklist`). This is the screen that
// shows it: the OPEN recommendations to act on, and the SET-ASIDE ones an operator has judged not-worth-acting
// -on-now (with who set each aside and why).
//
// Two truths the screen must carry, both already true in the engine and re-stated here so the surface cannot
// weaken them:
//   • **It self-heals.** The recommendations are RE-DERIVED from the live alerts, so acknowledging an alert
//     (taking ownership) or clearing the incident the ordinary way removes its recommendation on its own. This
//     screen points at what to do and where; it never carries a "done" flag that could go stale against reality.
//   • **The AI commits nothing.** The worklist is a read; nothing here runs a runbook or touches the shop. A06
//     recommends; an OPERATOR acts (acknowledge the alert, then run the runbook). Setting one aside is a HUMAN
//     write on the dismissals route, in the operator's own name.
//
// Like every ERP screen the rules live here in a tested, DOM-free session model on the shared packages/ui
// primitives (colour is never the only signal — an icon and a word ride with every tone); the shell only
// renders what this hands over.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation, type Tone } from '../../../packages/a11y/src/signals';

/** An A06 recommendation as the worklist route hands it over. The session reads only these fields; the
 *  finding's own detail already carries the plain-English explanation and the runbook is the steps a person
 *  takes. `status` is the incident's health (down is graver than degraded), used only to pick the tone. */
export interface OperationsFindingView {
  readonly findingId: string;
  readonly alertId: string;
  /** The health component that is unwell (sync / queue / dead_letter / catalogue / database / … ). */
  readonly component: string;
  /** The incident health: 'down' | 'degraded' | 'unknown' | 'ok' (worst first is already the list order). */
  readonly status: string;
  readonly headline: string;
  readonly detail: string;
  /** The recommended runbook — the reviewed steps an operator takes. */
  readonly runbook: string;
}

/** One recommendation as the worklist hands it over, carrying (when set aside) who/why. */
export interface OperationsWorklistEntry {
  readonly finding: OperationsFindingView;
  readonly status: 'open' | 'dismissed';
  readonly dismissal?: { readonly by: string; readonly at: string; readonly reason: string };
}

/** The worklist body (`GET /v1/ai/operations/worklist`). `agentActive` false → A06 is off or killed. */
export interface OperationsWorklistData {
  readonly agentActive: boolean;
  readonly open: readonly OperationsWorklistEntry[];
  readonly dismissed: readonly OperationsWorklistEntry[];
  /** Plain-English reason there is nothing to show when the agent is not active. */
  readonly note?: string;
}

/** The outcome of a dismiss/reopen — recorded, refused by the server, or a lost link (retryable). */
export type DismissOutcome = 'recorded' | 'refused' | 'lost_link';

/** The authenticated POST of an operator's decision. Injected, so the model never opens a socket itself.
 *  `dismissed:false` reopens. The AI never writes this — it is a HUMAN decision in the human's name. */
export interface OperationsDismissPort {
  post(input: { readonly findingId: string; readonly dismissed: boolean; readonly reason: string }): Promise<DismissOutcome>;
}

export interface OperationsInboxPorts {
  /** The worklist the shell last read (live from the cloud, or the injected stand-in). */
  worklist(): OperationsWorklistData;
  /** Whether this user may read the inbox (`ai.proposal.read`). */
  mayRead(): boolean;
  /** Whether this user may set a recommendation aside / bring it back (`ai.suggestion.dismiss`). */
  mayDismiss(): boolean;
  /** Records an operator's decision. Only reached from the explicit dismiss/reopen action, never on render. */
  dismissPort(): OperationsDismissPort;
}

export interface OperationsInboxConfig {
  /** Who is looking. `null` means the store computer was not told. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen ───────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'kindIncident' | 'kindDismissed'
  | 'openHeading' | 'dismissedHeading'
  | 'openCount' | 'dismissedCount' | 'allClear'
  | 'componentLabel' | 'runbookLabel' | 'dismissedByLabel' | 'reasonLabel'
  | 'dismissBtn' | 'reopenBtn' | 'reasonPlaceholder'
  | 'dismissRecorded' | 'dismissRefused' | 'dismissLostLink'
  | 'scrReady' | 'scrEmpty' | 'scrOff' | 'stateNotPermitted'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const OPERATIONS_INBOX_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Operations', langName: 'தமிழ்',
    lead: 'Problems the Operations helper found running the shop — a stuck sync queue, a growing dead-letter pile, an unwell connection — each with the recommended fix-it steps. Acknowledge the alert to take ownership, then run the steps; once the problem clears it drops off this list on its own. Nothing here runs anything; it points you at what to do.',
    kindIncident: 'Needs attention', kindDismissed: 'Set aside',
    openHeading: 'To act on', dismissedHeading: 'Set aside',
    openCount: 'to act on', dismissedCount: 'set aside', allClear: 'Nothing to act on — the shop is running cleanly.',
    componentLabel: 'Part', runbookLabel: 'Recommended steps', dismissedByLabel: 'Set aside by', reasonLabel: 'Reason',
    dismissBtn: 'Set aside', reopenBtn: 'Bring back', reasonPlaceholder: 'Why is this not being acted on?',
    dismissRecorded: 'Set aside.', dismissRefused: 'Could not save — a short reason is needed, or you do not have permission.', dismissLostLink: 'No connection — not saved. Try again.',
    scrReady: 'Showing the recommendations', scrEmpty: 'Nothing to act on — the shop is running cleanly.',
    scrOff: 'The Operations helper is switched off, so there are no recommendations to show.',
    stateNotPermitted: 'You do not have permission to see the operations recommendations.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'செயல்பாடுகள்', langName: 'English',
    lead: 'கடையை நடத்தும்போது செயல்பாட்டு உதவியாளர் கண்டறிந்த சிக்கல்கள் — நின்றுபோன ஒத்திசைவு வரிசை, பெருகும் டெட்-லெட்டர் குவியல், நலமில்லாத இணைப்பு — ஒவ்வொன்றுக்கும் பரிந்துரைக்கப்பட்ட சரிசெய்தல் படிகளுடன். எச்சரிக்கையை ஏற்று உரிமை எடுத்துக்கொண்டு படிகளைச் செய்யுங்கள்; சிக்கல் தீர்ந்ததும் அது தானாகவே இந்தப் பட்டியலில் இருந்து நீங்கும். இங்கு எதுவும் இயக்கப்படாது; என்ன செய்ய வேண்டும் என்பதைக் காட்டுகிறது.',
    kindIncident: 'கவனம் தேவை', kindDismissed: 'ஒதுக்கப்பட்டது',
    openHeading: 'செயல்பட வேண்டியவை', dismissedHeading: 'ஒதுக்கப்பட்டவை',
    openCount: 'செயல்பட வேண்டியவை', dismissedCount: 'ஒதுக்கப்பட்டவை', allClear: 'செயல்பட எதுவும் இல்லை — கடை சுத்தமாக இயங்குகிறது.',
    componentLabel: 'பகுதி', runbookLabel: 'பரிந்துரைக்கப்பட்ட படிகள்', dismissedByLabel: 'ஒதுக்கியவர்', reasonLabel: 'காரணம்',
    dismissBtn: 'ஒதுக்கிவை', reopenBtn: 'மீண்டும் கொண்டுவா', reasonPlaceholder: 'இது ஏன் செயல்படுத்தப்படவில்லை?',
    dismissRecorded: 'ஒதுக்கப்பட்டது.', dismissRefused: 'சேமிக்க முடியவில்லை — ஒரு சிறு காரணம் தேவை, அல்லது உங்களுக்கு அனுமதி இல்லை.', dismissLostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    scrReady: 'பரிந்துரைகளைக் காட்டுகிறது', scrEmpty: 'செயல்பட எதுவும் இல்லை — கடை சுத்தமாக இயங்குகிறது.',
    scrOff: 'செயல்பாட்டு உதவியாளர் அணைக்கப்பட்டுள்ளது, எனவே காட்ட பரிந்துரைகள் இல்லை.',
    stateNotPermitted: 'செயல்பாட்டு பரிந்துரைகளைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(OPERATIONS_INBOX_COPY.en) as CopyKey[]);

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

export interface PresentedRecommendation {
  readonly findingId: string;
  readonly component: string;
  readonly status: StatusPresentation;   // incident health as tone + word + icon + announcement
  readonly needsAttention: boolean;       // open recommendations need action; set-aside ones do not
  readonly headline: string;              // the incident's plain-English one-liner
  readonly detail: string;                // what is wrong and why it matters
  readonly runbook: string;               // the recommended steps a person takes
  /** Present only on a set-aside recommendation. */
  readonly dismissedBy?: string;
  readonly dismissedReason?: string;
}

export interface OperationsInboxView {
  readonly screenState: StatusPresentation;
  readonly agentActive: boolean;
  readonly open: readonly PresentedRecommendation[];
  readonly dismissed: readonly PresentedRecommendation[];
  readonly openCount: number;
  readonly dismissedCount: number;
  readonly nobodyNamed: boolean;
  /** Whether to offer the "set aside" / "bring back" actions — this user holds `ai.suggestion.dismiss`. */
  readonly mayDismiss: boolean;
}

export interface OperationsInboxSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): OperationsInboxView;
  /** Set a recommendation aside, in the operator's name — a HUMAN write (hard rule #5). Runs only from an
   *  explicit action, never on render; refuses without permission or a reason before it ever POSTs. */
  dismiss(findingId: string, reason: string): Promise<DismissOutcome>;
  /** Bring a set-aside recommendation back onto the open list. */
  reopen(findingId: string): Promise<DismissOutcome>;
  /** Present a dismiss/reopen outcome as one glanceable status the shell shows after the action. */
  presentDismissResult(lang: Lang, outcome: DismissOutcome): StatusPresentation;
}

const EMPTY_VIEW = (screenState: StatusPresentation, nobodyNamed: boolean, mayDismiss: boolean): OperationsInboxView => ({
  screenState, agentActive: false, open: [], dismissed: [], openCount: 0, dismissedCount: 0, nobodyNamed, mayDismiss,
});

export function createOperationsInboxSession(
  config: OperationsInboxConfig,
  ports: OperationsInboxPorts,
): OperationsInboxSession {
  const text = (lang: Lang, key: CopyKey): string => translator(OPERATIONS_INBOX_COPY, lang)(key);

  const present = (lang: Lang, entry: OperationsWorklistEntry): PresentedRecommendation => {
    const t = translator(OPERATIONS_INBOX_COPY, lang);
    const open = entry.status === 'open';
    const f = entry.finding;
    // Open recommendations are the work — a 'down' incident is the graver, an 'error' tone; a degraded/unknown
    // one asks for a glance (P-03). A set-aside one is idle. Colour is never the only signal — an icon rides too.
    const tone: Tone = !open ? 'idle' : f.status === 'down' ? 'error' : 'degraded';
    const icon = !open ? '✓' : f.status === 'down' ? '✕' : '⚠';
    const label = open ? t('kindIncident') : t('kindDismissed');
    return {
      findingId: f.findingId,
      component: f.component,
      status: presentStatus({ tone, icon, label, announcement: f.headline, needsAttention: open }),
      needsAttention: open,
      headline: f.headline,
      detail: f.detail,
      runbook: f.runbook,
      ...(entry.dismissal !== undefined ? { dismissedBy: entry.dismissal.by, dismissedReason: entry.dismissal.reason } : {}),
    };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(OPERATIONS_INBOX_COPY, lang);
      const nobodyNamed = config.userId === null;
      const mayDismiss = ports.mayDismiss();

      if (!ports.mayRead()) {
        return EMPTY_VIEW(presentScreenState({ state: 'error', label: t('stateNotPermitted') }), nobodyNamed, mayDismiss);
      }

      const worklist = ports.worklist();
      if (!worklist.agentActive) {
        // Governance honoured: the agent is off or killed, so there is nothing to show — say so plainly, not an
        // empty screen a person reads as "all clear". `locked` is the deliberate, non-fault state (idle tone,
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

    // Set a recommendation aside / bring it back. Refuse BEFORE any POST — no permission, or an empty reason on
    // a dismiss, is a local refusal, not a round trip (the server also refuses, but the screen should not send a
    // request it knows will fail). The AI never writes this; the caller is the authenticated operator, and the
    // server records the decision in their name.
    dismiss: async (findingId, reason) => {
      if (!ports.mayDismiss() || reason.trim() === '') return 'refused';
      return ports.dismissPort().post({ findingId, dismissed: true, reason: reason.trim() });
    },
    reopen: async (findingId) => {
      if (!ports.mayDismiss()) return 'refused';
      return ports.dismissPort().post({ findingId, dismissed: false, reason: '' });
    },
    presentDismissResult: (lang, outcome) => {
      const t = translator(OPERATIONS_INBOX_COPY, lang);
      if (outcome === 'recorded') return presentStatus({ tone: 'ok', icon: '✓', label: t('dismissRecorded'), needsAttention: false });
      if (outcome === 'lost_link') return presentStatus({ tone: 'degraded', icon: '⚠', label: t('dismissLostLink'), needsAttention: true });
      return presentStatus({ tone: 'error', icon: '✕', label: t('dismissRefused'), needsAttention: true });
    },
  };
}
